// depositRequestHash v2 in the atum-escrow MPP method: the challenge lists the versions a payer may
// sign (extra.depositRequestHashVersions, absent = [1]), the client signs v2 only when listed, and
// the server accepts v1 or v2, reading v2 in audit mode unless configured to enforce.

import { describe, it, expect } from 'vitest';
import { readDepositRequest, type CommitmentResult } from '@atum-labs/payment-request-sender-auth';
import {
  registerServer,
  buildChargeRequest,
  validateCorridor,
  corridorFromDefaults,
  type AtumEscrowCorridor,
} from './server.js';
import { ChargeRequestSchema, type AtumEscrowChallenge } from './internal.js';
import {
  now,
  corridor,
  EVM_SOURCE,
  challenge,
  okSubmitter,
  buildCredential,
  type TestCredential,
} from './test-helpers.js';

/** The fixture corridor with its one source listing `versions`. */
function corridorListing(versions: number[]): AtumEscrowCorridor {
  return {
    ...corridor,
    sources: [{ ...corridor.sources[0]!, depositRequestHashVersions: versions }],
  };
}

/** The deposit's committed depositRequestHash and the strict reading of the body it signs. */
function committedAndRead(credential: TestCredential) {
  const { sender_auth: senderAuth, ...body } = credential.payload.paymentRequest;
  const prehash = JSON.parse(senderAuth.signed_messages[0].message_prehash);
  return {
    committed: prehash.message.witness.depositRequestHash as string,
    read: readDepositRequest(JSON.stringify(body)),
  };
}

describe('ChargeRequestSchema depositRequestHashVersions', () => {
  it('keeps the list, so the client sees it', () => {
    const request = buildChargeRequest(corridorListing([1, 2]), EVM_SOURCE, '10000000');
    const parsed = ChargeRequestSchema.parse(request);
    expect(parsed.extra.depositRequestHashVersions).toEqual([1, 2]);
  });

  it.each([[[]], [[0]], [[1.5]]])('refuses %j on the wire', (versions) => {
    const request = buildChargeRequest(corridor, EVM_SOURCE, '10000000');
    const bad = { ...request, extra: { ...request.extra, depositRequestHashVersions: versions } };
    expect(ChargeRequestSchema.safeParse(bad).success).toBe(false);
  });
});

describe('buildChargeRequest depositRequestHashVersions', () => {
  it('publishes the versions a source lists', () => {
    const request = buildChargeRequest(corridorListing([1, 2]), EVM_SOURCE, '10000000');
    expect(request.extra.depositRequestHashVersions).toEqual([1, 2]);
  });

  it('publishes nothing for a source that lists none', () => {
    const request = buildChargeRequest(corridor, EVM_SOURCE, '10000000');
    expect(request.extra).not.toHaveProperty('depositRequestHashVersions');
  });

  it.each([[[]], [[0]], [[1, 1]], [[1.5]]])('validateCorridor refuses %j', (versions) => {
    expect(() => validateCorridor(corridorListing(versions))).toThrow(/depositRequestHashVersions/);
  });
});

describe('corridorFromDefaults depositRequestHashVersions', () => {
  const fromDefaults = (
    depositRequestHashVersion?: number,
    depositRequestHashVersions?: number[],
  ) =>
    corridorFromDefaults(
      {
        fetchChainDefaults: async (chainId: string) => ({
          escrowContract: `escrow-${chainId}`,
          quoteSelector: `reserver-${chainId}`,
          fulfillmentVerifierAccount: `releaser-${chainId}`,
          fulfillmentVerifierEndpoint: `https://verifier/${chainId}`,
          fulfillmentProxy: `proxy-${chainId}`,
          ...(depositRequestHashVersion !== undefined && { depositRequestHashVersion }),
          ...(depositRequestHashVersions !== undefined && { depositRequestHashVersions }),
        }),
      },
      {
        destination: corridor.destination,
        sources: [
          {
            network: EVM_SOURCE.network,
            assets: [{ address: EVM_SOURCE.asset, symbol: 'USDC', decimals: 6 }],
          },
        ],
        markupBps: 300,
        quoteDeadlineSeconds: 20,
        fulfillmentDeadlineSeconds: 300,
      },
    );

  it('lists [1, 2] when the gateway publishes version 2 for the source chain', async () => {
    expect((await fromDefaults(2)).sources[0]!.depositRequestHashVersions).toEqual([1, 2]);
  });

  it.each([
    [undefined, undefined],
    [1, undefined],
    [2, [1]],
  ])(
    'lists nothing when the gateway publishes version %j and list %j',
    async (version, versions) => {
      expect((await fromDefaults(version, versions)).sources[0]).not.toHaveProperty(
        'depositRequestHashVersions',
      );
    },
  );

  // deposit_request_hash_versions decides when the gateway publishes it.
  it.each([
    [
      [1, 2],
      [1, 2],
    ],
    [[2], [2]],
    [[2, 3], [2]],
  ])('lists %j as %j', async (published, listed) => {
    const corridor = await fromDefaults(2, published);
    expect(corridor.sources[0]!.depositRequestHashVersions).toEqual(listed);
  });

  // Both refusals come out as INVALID_CONFIG, so a caller handles a bad gateway answer one way.
  it.each([
    ['names no version this build signs', [3], /accepts none this build signs/],
    ['is not a list of versions', [], /must be a non-empty array of positive integers/],
  ])('refuses a source chain whose list %s', async (_name, list, message) => {
    await expect(fromDefaults(undefined, list)).rejects.toMatchObject({
      name: 'AtumEscrowConfigError',
      code: 'INVALID_CONFIG',
      message: expect.stringMatching(message),
    });
  });
});

describe('server submits the depositRequestHash shadow', () => {
  it('hands the submitter the producer and the v2 of the request it submits', async () => {
    const contexts: unknown[] = [];
    const submitted: string[] = [];
    const server = registerServer({
      submitter: {
        submit: async (request, context) => {
          submitted.push(JSON.stringify(request));
          contexts.push(context);
          return okSubmitter.submit();
        },
      },
      now,
    });
    await server.verify({
      credential: (await buildCredential()) as any,
      request: challenge.request,
    });
    expect(contexts).toEqual([
      {
        shadow: {
          producer: 'mppx',
          depositRequestHashV2: readDepositRequest(submitted[0]!).depositRequestHashV2,
        },
      },
    ]);
  });
});

describe('client depositRequestHashVersions', () => {
  it('signs v1 when the challenge lists no versions', async () => {
    const { committed, read } = committedAndRead(await buildCredential());
    expect(committed).toBe(read.depositRequestHashV1);
  });

  it('signs v2, the hash of the body it posts, when the challenge lists 2', async () => {
    const listing = {
      ...challenge,
      request: buildChargeRequest(corridorListing([1, 2]), EVM_SOURCE, '10000000'),
    } as AtumEscrowChallenge;
    const { committed, read } = committedAndRead(await buildCredential(listing));
    expect(committed).toBe(read.depositRequestHashV2);
  });
});

describe('server depositRequestHashV2Mode', () => {
  const v2Request = buildChargeRequest(corridorListing([1, 2]), EVM_SOURCE, '10000000');
  const v2Challenge = { ...challenge, request: v2Request } as AtumEscrowChallenge;

  function recording(mode?: 'audit' | 'enforce') {
    const seen: CommitmentResult[] = [];
    const server = registerServer({
      submitter: okSubmitter,
      now,
      onCommitmentResult: (result) => seen.push(result),
      ...(mode !== undefined && { depositRequestHashV2Mode: mode }),
    });
    return { server, seen };
  }

  /** A v1-signed credential with a member v1 does not hash and the strict reader refuses. */
  async function strictRefused(): Promise<TestCredential> {
    const credential = await buildCredential();
    credential.payload.paymentRequest.unknown_member = 1;
    return credential;
  }

  it('accepts a v2-signed payment by default and reports v2', async () => {
    const { server, seen } = recording();
    const credential = await buildCredential(v2Challenge);
    await server.verify({ credential: credential as any, request: v2Request });
    expect(seen.map((r) => r.depositRequestHashVersion)).toEqual(['v2']);
  });

  it('reports a v1-signed payment as v1', async () => {
    const { server, seen } = recording();
    await server.verify({
      credential: (await buildCredential()) as any,
      request: challenge.request,
    });
    expect(seen.map((r) => r.depositRequestHashVersion)).toEqual(['v1']);
  });

  it('admits a request the strict reader refuses by default, and reports why', async () => {
    const { server, seen } = recording();
    await server.verify({ credential: (await strictRefused()) as any, request: challenge.request });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.strictDetail).toMatch(/unknown_member is not a PaymentRequest member/);
  });

  // A v2 deposit over a body the strict reader refuses cannot match v1 either, so it is refused;
  // audit still reports why the strict reader refused it.
  it('reports why the strict reader refused a v2-signed payment it refuses', async () => {
    const { server, seen } = recording();
    const credential = await buildCredential(v2Challenge);
    credential.payload.paymentRequest.unknown_member = 1;
    await expect(
      server.verify({ credential: credential as any, request: v2Request }),
    ).rejects.toThrow();
    expect(seen.map((r) => r.outcome)).toEqual(['request_hash_mismatch']);
    expect(seen[0]!.strictDetail).toMatch(/unknown_member is not a PaymentRequest member/);
  });

  it('refuses a request the strict reader refuses in enforce mode', async () => {
    const { server, seen } = recording('enforce');
    await expect(
      server.verify({ credential: (await strictRefused()) as any, request: challenge.request }),
    ).rejects.toThrow();
    expect(seen.map((r) => r.outcome)).toEqual(['request_malformed']);
  });

  it.each(['Enforce', 'Retire'])(
    'refuses the unknown mode %s when the server is registered',
    (mode) => {
      expect(() =>
        registerServer({
          submitter: okSubmitter,
          depositRequestHashV2Mode: mode as 'enforce',
        }),
      ).toThrow(/depositRequestHashV2Mode must be 'audit', 'enforce' or 'retire'/);
    },
  );
});

describe("server depositRequestHashV2Mode 'retire'", () => {
  const v2Request = buildChargeRequest(corridorListing([1, 2]), EVM_SOURCE, '10000000');
  const v2Challenge = { ...challenge, request: v2Request } as AtumEscrowChallenge;

  function retiring() {
    const seen: CommitmentResult[] = [];
    let submitted = 0;
    const server = registerServer({
      submitter: {
        submit: async (...args: Parameters<typeof okSubmitter.submit>) => {
          submitted++;
          return okSubmitter.submit(...args);
        },
      },
      now,
      onCommitmentResult: (result) => seen.push(result),
      depositRequestHashV2Mode: 'retire',
    });
    return { server, seen, submitted: () => submitted };
  }

  it('admits a v2-signed payment', async () => {
    const { server, seen, submitted } = retiring();
    const credential = await buildCredential(v2Challenge);
    await server.verify({ credential: credential as any, request: v2Request });
    expect(seen.map((r) => [r.outcome, r.depositRequestHashVersion])).toEqual([['verified', 'v2']]);
    expect(submitted()).toBe(1);
  });

  it('refuses a v1-signed payment before it is submitted', async () => {
    const { server, seen, submitted } = retiring();
    await expect(
      server.verify({ credential: (await buildCredential()) as any, request: challenge.request }),
    ).rejects.toThrow();
    expect(seen.map((r) => r.outcome)).toEqual(['request_hash_mismatch']);
    expect(seen[0]!.detail).toMatch(/no longer accepts: sign depositRequestHash v2/);
    expect(submitted()).toBe(0);
  });

  it('refuses a request the strict reader refuses, as enforce does', async () => {
    const { server, seen, submitted } = retiring();
    const credential = await buildCredential();
    credential.payload.paymentRequest.unknown_member = 1;
    await expect(
      server.verify({ credential: credential as any, request: challenge.request }),
    ).rejects.toThrow();
    expect(seen.map((r) => r.outcome)).toEqual(['request_malformed']);
    expect(submitted()).toBe(0);
  });
});
