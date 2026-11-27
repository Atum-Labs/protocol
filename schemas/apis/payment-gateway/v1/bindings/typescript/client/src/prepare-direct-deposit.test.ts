// prepareDirectDepositRequest builds an originator-executed (direct) deposit request: the payer
// funds the escrow itself with approve + directDeposit, so the request carries no sender_auth, and
// the method returns the deposit the payer must fund alongside it. It never signs and never builds
// funding transactions. Exercises the REAL shared derivation and validator.
import { randomUUID } from 'crypto';
import {
  deriveDirectDeposit as deriveFromStoredRequest,
  DirectDepositError,
  DirectDepositRuleError,
  encodeDirectDepositCalldata,
  InvalidAccountError,
  PaymentGatewayClient,
  PaymentRequestError,
  UnsupportedDestinationAssetError,
} from './index';
import type { ChainDefaults } from './chain-adapters';
import type { ApiRequestOptions } from './generated/core/ApiRequestOptions';
import { BaseHttpRequest } from './generated/core/BaseHttpRequest';
import { CancelablePromise } from './generated/core/CancelablePromise';
import { deriveDirectDeposit } from '@atum-labs/payment-request-sender-auth';
import { __resetDirectDepositDeprecationsForTests } from './direct-deposit-request';
import { encodeDirectDepositCalldata as escrowEncodeDirectDeposit } from '@atum-labs/evm-escrow-encoding';
import derivationVectors from '../../../../../../../declarations/PaymentRequest/v1/conformance/direct-deposit-derivation-vectors.json';

const evmDefaults: ChainDefaults = {
  escrowContract: '0x0000000000000000000000000000000000000001',
  fulfillmentProxy: '0x0000000000000000000000000000000000000002',
  quoteSelector: '0x0000000000000000000000000000000000000003',
  fulfillmentVerifierAccount: '0x0000000000000000000000000000000000000004',
  fulfillmentVerifierEndpoint: 'https://verifier.example',
};

const NOW_MS = Date.parse('2035-01-01T00:00:00.000Z');

/** A client whose fetch throws: proves the offline path makes NO gateway call. */
class NoFetchClient extends PaymentGatewayClient {
  async fetchChainDefaults(): Promise<ChainDefaults> {
    throw new Error('fetchChainDefaults must not be called on the offline path');
  }
}

function directParams() {
  return {
    depositor: '0x0000000000000000000000000000000000000005',
    fulfillmentAmount: '100000',
    sourceAsset: 'eip155:1/erc20:0x0000000000000000000000000000000000000006',
    destinationAccount: '0x0000000000000000000000000000000000000007',
    destinationAsset: 'eip155:2/erc20:0x0000000000000000000000000000000000000008',
    maxSourceAmount: '103000',
    // A version 4 UUID, which version 1 requires; version 2 admits any id.
    requestId: '3f0c7a52-9d1e-4b8a-a6f2-5c9e1d7b4a03',
    depositNonce: '7',
    depositRequestHashVersion: 2 as const,
    fulfill: 'settler' as const,
    quoteDeadlineSeconds: 60,
    fulfillmentDeadlineSeconds: 3600,
    now: () => NOW_MS,
    resolvedDefaults: {
      source: evmDefaults,
      destination: { fulfillmentProxy: evmDefaults.fulfillmentProxy },
    },
  };
}

/** {@link directParams} without `resolvedDefaults`, so the client would fetch the corridor. */
function fetchingParams() {
  const { resolvedDefaults: _offline, ...params } = directParams();
  return params;
}

/** Offline defaults with some source-chain members replaced. */
function withSourceDefaults(source: Partial<ChainDefaults>) {
  return {
    resolvedDefaults: {
      source: { ...evmDefaults, ...source },
      destination: { fulfillmentProxy: evmDefaults.fulfillmentProxy },
    },
  };
}

// A deposit at a passed version 1 reports a DeprecationWarning, once per process. Each test starts
// as a fresh process would and gets a fresh spy, so the warning is kept off the test output and can
// be asserted on where it is the subject.
let emitWarning: jest.SpyInstance;
beforeEach(() => {
  __resetDirectDepositDeprecationsForTests();
  emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
});
afterEach(() => {
  emitWarning.mockRestore();
});

describe('prepareDirectDepositRequest', () => {
  it('builds an originator-executed request offline, with deposit_nonce and no sender_auth', async () => {
    const { request } = await new NoFetchClient().prepareDirectDepositRequest(directParams());

    expect(request.executor).toEqual({
      deposit: 'originator',
      reserve: 'settler',
      fulfill: 'settler',
    });
    expect(request.deposit_nonce).toBe('7');
    expect('sender_auth' in request).toBe(false);
    expect(request.quote_selector).toBe(evmDefaults.quoteSelector);
    expect(request.fulfillment_verifier).toEqual({
      account: evmDefaults.fulfillmentVerifierAccount,
      endpoint: evmDefaults.fulfillmentVerifierEndpoint,
    });
    expect(request.escrow_contract_address).toBe(evmDefaults.escrowContract);
    expect(request.quote_deadline).toBe('2035-01-01T00:01:00.000Z');
    expect(request.fulfillment_deadline).toBe('2035-01-01T01:00:00.000Z');
  });

  it('prepares a Solana destination from an EVM source', async () => {
    const destinationAsset =
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const destinationAccount = 'So11111111111111111111111111111111111111112';
    const { request } = await new NoFetchClient().prepareDirectDepositRequest({
      ...directParams(),
      destinationAsset,
      destinationAccount,
      resolvedDefaults: {
        source: evmDefaults,
        destination: { fulfillmentProxy: destinationAccount },
      },
    });

    expect(request.destination).toEqual([
      { asset_identifier: destinationAsset, account: destinationAccount },
    ]);
  });

  it.each([1, 2] as const)(
    'returns the deposit the shared derivation names for the request, at v%d',
    async (version) => {
      const { request, deposit } = await new NoFetchClient().prepareDirectDepositRequest({
        ...directParams(),
        depositRequestHashVersion: version,
      });

      expect(deposit).toEqual(
        deriveDirectDeposit(JSON.stringify(request), 1n, request.escrow_contract_address!, version),
      );
      expect(deposit.depositId).toMatch(/^0x[0-9a-f]{64}$/);
    },
  );

  it.each([
    ['a Solana source', 'solana:mainnet/spl:cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN'],
    ['a Tron source', 'tron:mainnet/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'],
    ['a native EVM asset', 'eip155:1/slip44:60'],
  ])('refuses %s as the source before any network call', async (_label, sourceAsset) => {
    const fetching = fetchingParams();

    await expect(
      new NoFetchClient().prepareDirectDepositRequest({ ...fetching, sourceAsset }),
    ).rejects.toThrow(/sourceAsset .* must be an ERC-20 on an EVM chain/);
  });

  it.each([0, 3, '2', null, 1.5, 2n])(
    'refuses depositRequestHashVersion %p with a typed error, before any network call',
    async (version) => {
      const attempt = new NoFetchClient().prepareDirectDepositRequest({
        ...fetchingParams(),
        depositRequestHashVersion: version as unknown as 1 | 2,
      });

      await expect(attempt).rejects.toBeInstanceOf(DirectDepositError);
      await expect(attempt).rejects.toMatchObject({ reason: 'version' });
      await expect(attempt).rejects.toThrow(/depositRequestHashVersion must be 1 or 2, got /);
    },
  );

  it.each([undefined, '', '0x10', '-1', '1.5', ' 7', -1n, (1n << 256n).toString(), 1n << 256n])(
    'refuses depositNonce %p before any network call',
    async (depositNonce) => {
      const fetching = fetchingParams();

      await expect(
        new NoFetchClient().prepareDirectDepositRequest({
          ...fetching,
          depositNonce: depositNonce as string | bigint,
        }),
      ).rejects.toThrow(/depositNonce must be a decimal uint256/);
    },
  );

  it.each(['007', 7n])('writes depositNonce %p as the canonical decimal', async (depositNonce) => {
    const client = new NoFetchClient();
    const canonical = await client.prepareDirectDepositRequest({
      ...directParams(),
      depositNonce: '7',
    });
    const prepared = await client.prepareDirectDepositRequest({ ...directParams(), depositNonce });

    expect(JSON.stringify(prepared.request)).toBe(JSON.stringify(canonical.request));
    expect(prepared.deposit.depositId).toBe(canonical.deposit.depositId);
  });

  it.each([((1n << 256n) - 1n).toString(), (1n << 256n) - 1n])(
    'accepts the uint256 maximum depositNonce %p',
    async (depositNonce) => {
      const { deposit } = await new NoFetchClient().prepareDirectDepositRequest({
        ...directParams(),
        depositNonce,
      });

      expect(deposit.input.nonce).toBe((1n << 256n) - 1n);
    },
  );

  it.each(['quoteDeadlineSeconds', 'fulfillmentDeadlineSeconds'] as const)(
    'requires %s, before any network call',
    async (window) => {
      const fetching = fetchingParams();
      const params = { ...fetching, [window]: undefined } as unknown as ReturnType<
        typeof directParams
      >;

      await expect(new NoFetchClient().prepareDirectDepositRequest(params)).rejects.toThrow(
        new RegExp(`${window} is required for a direct deposit`),
      );
    },
  );

  it.each([
    [60, 60.0005],
    // The window comparison alone passes this pair; the stamped deadlines are still equal.
    [59.99999999, 60.0005],
  ])(
    'refuses windows %p and %p, which stamp the same deadline',
    async (quoteDeadlineSeconds, fulfillmentDeadlineSeconds) => {
      await expect(
        new NoFetchClient().prepareDirectDepositRequest({
          ...directParams(),
          now: () => Date.parse('2026-11-06T00:00:00.000Z'),
          quoteDeadlineSeconds,
          fulfillmentDeadlineSeconds,
        }),
      ).rejects.toThrow(/fulfillment deadline must be later than the quote deadline/);
    },
  );

  it.each(['', '0', '0100', '1.5', ' 1', '-1', (10n ** 30n + 1n).toString(), 100000])(
    'refuses fulfillmentAmount %p before any network call',
    async (fulfillmentAmount) => {
      const fetching = fetchingParams();

      await expect(
        new NoFetchClient().prepareDirectDepositRequest({
          ...fetching,
          fulfillmentAmount: fulfillmentAmount as string,
        }),
      ).rejects.toThrow(/fulfillmentAmount must be a positive base-10 integer of at most 10\^30/);
    },
  );

  it.each([
    [undefined, /maxSourceAmount is required/],
    ['0', /maxSourceAmount must be a positive base-10 integer/],
    ['0103000', /maxSourceAmount must be a positive base-10 integer/],
    [(1n << 256n).toString(), /maxSourceAmount must fit in uint256/],
  ])('refuses maxSourceAmount %p before any network call', async (maxSourceAmount, message) => {
    const fetching = fetchingParams();

    await expect(
      new NoFetchClient().prepareDirectDepositRequest({
        ...fetching,
        maxSourceAmount: maxSourceAmount as string,
      }),
    ).rejects.toThrow(message);
  });

  it('accepts the uint256 maximum maxSourceAmount', async () => {
    const maximum = (1n << 256n) - 1n;
    const { deposit } = await new NoFetchClient().prepareDirectDepositRequest({
      ...directParams(),
      maxSourceAmount: maximum.toString(),
    });

    expect(deposit.input.amount).toBe(maximum);
  });

  it.each([
    ['a missing requestId', { requestId: '' }, /requestId is required/],
    ['a requestId outside the pattern', { requestId: 'has space' }, /does not match/],
    ['an unpayable destination account', { destinationAccount: 'not-an-address' }, /.+/],
  ])('refuses %s before any network call', async (_label, override, message) => {
    const fetching = fetchingParams();

    const attempt = new NoFetchClient().prepareDirectDepositRequest({ ...fetching, ...override });

    await expect(attempt).rejects.toThrow(message);
    await expect(attempt).rejects.not.toThrow(/fetchChainDefaults must not be called/);
  });

  // At version 1 the deposit commits only the hash of request_id, so a guessable id leaves the
  // request's other terms unprotected. Order numbers, long composite keys and time-based UUIDs
  // are all guessable; only the random UUID randomUUID() returns is admitted.
  it.each([
    ['an order number', 'order-42'],
    ['a composite key longer than a UUID', 'acme-order-4711-2026-11-10T12-00-00'],
    ['a time-ordered v7 UUID', '01932c07-a9b0-7c3e-9f4a-1b2c3d4e5f60'],
    ['a time-based v1 UUID', 'c232ab00-9414-11ec-b3c8-9f6bdeced846'],
  ])('refuses %s as the requestId at version 1, before any network call', async (_label, id) => {
    const attempt = new NoFetchClient().prepareDirectDepositRequest({
      ...fetchingParams(),
      requestId: id,
      depositRequestHashVersion: 1,
    });

    await expect(attempt).rejects.toBeInstanceOf(DirectDepositError);
    await expect(attempt).rejects.toMatchObject({ reason: 'request' });
    await expect(attempt).rejects.toThrow(
      /at depositRequestHashVersion 1 the requestId must be a random UUID from randomUUID\(\)/,
    );
    await expect(attempt).rejects.not.toThrow(/fetchChainDefaults must not be called/);
  });

  it('accepts a randomUUID() requestId at version 1', async () => {
    const requestId = randomUUID();

    const { request } = await new NoFetchClient().prepareDirectDepositRequest({
      ...directParams(),
      requestId,
      depositRequestHashVersion: 1,
    });

    expect(request.request_id).toBe(requestId);
  });

  it('accepts an order number as the requestId at version 2', async () => {
    const { request } = await new NoFetchClient().prepareDirectDepositRequest({
      ...directParams(),
      requestId: 'order-42',
      depositRequestHashVersion: 2,
    });

    expect(request.request_id).toBe('order-42');
  });

  // EIP-55 test vector, and the same address with one letter's case flipped.
  const CHECKSUMMED = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  const BAD_CHECKSUM = '0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

  it('refuses a wrong EIP-55 checksum on the source token, before any network call', async () => {
    const fetching = fetchingParams();

    await expect(
      new NoFetchClient().prepareDirectDepositRequest({
        ...fetching,
        sourceAsset: `eip155:1/erc20:${BAD_CHECKSUM}`,
      }),
    ).rejects.toThrow(/has an invalid checksum/);
  });

  it.each([
    ['depositor', { depositor: BAD_CHECKSUM }],
    ['the escrow', withSourceDefaults({ escrowContract: BAD_CHECKSUM })],
    ['the quote selector', withSourceDefaults({ quoteSelector: BAD_CHECKSUM })],
    ['the verifier account', withSourceDefaults({ fulfillmentVerifierAccount: BAD_CHECKSUM })],
  ])(
    'refuses a wrong EIP-55 checksum on %s, with the typed account error as cause',
    async (name, override) => {
      const attempt = new NoFetchClient().prepareDirectDepositRequest({
        ...directParams(),
        ...override,
      });

      await expect(attempt).rejects.toThrow(
        new RegExp(`${name} .*: account is not a valid address`),
      );
      await expect(attempt).rejects.toHaveProperty('cause', expect.any(InvalidAccountError));
    },
  );

  it.each(['not-an-address', ' 0x0000000000000000000000000000000000000005', ZERO_ADDRESS])(
    'refuses depositor %p before any network call',
    async (depositor) => {
      await expect(
        new NoFetchClient().prepareDirectDepositRequest({ ...fetchingParams(), depositor }),
      ).rejects.toThrow(/depositor .*: account/);
    },
  );

  it.each([CHECKSUMMED, CHECKSUMMED.toLowerCase()])(
    'accepts a correctly checksummed or all-lowercase depositor %s',
    async (depositor) => {
      const { request } = await new NoFetchClient().prepareDirectDepositRequest({
        ...directParams(),
        depositor,
      });

      expect(request.source.account).toBe(depositor);
    },
  );

  it('accepts a correctly checksummed escrow', async () => {
    const { request } = await new NoFetchClient().prepareDirectDepositRequest({
      ...directParams(),
      ...withSourceDefaults({ escrowContract: CHECKSUMMED }),
    });

    expect(request.escrow_contract_address).toBe(CHECKSUMMED);
  });

  it('refuses originator fulfill to a destination without EIP-3009, with the shared typed error', async () => {
    const attempt = new NoFetchClient().prepareDirectDepositRequest({
      ...directParams(),
      fulfill: 'originator',
    });

    await expect(attempt).rejects.toBeInstanceOf(UnsupportedDestinationAssetError);
    await expect(attempt).rejects.toBeInstanceOf(PaymentRequestError);
  });

  const ZERO = '0x0000000000000000000000000000000000000000';

  it.each([
    ['a zero quote selector', { quoteSelector: ZERO }, DirectDepositRuleError, 'quote_selector'],
    [
      'a zero verifier account',
      { fulfillmentVerifierAccount: ZERO },
      DirectDepositRuleError,
      'fulfillment_verifier',
    ],
    ['a zero escrow', { escrowContract: ZERO }, DirectDepositError, 'escrow'],
  ])(
    'refuses %s from the defaults with the shared typed error',
    async (_label, defaultsOverride, errorClass, reason) => {
      const attempt = new NoFetchClient().prepareDirectDepositRequest({
        ...directParams(),
        ...withSourceDefaults(defaultsOverride),
      });

      await expect(attempt).rejects.toBeInstanceOf(errorClass);
      await expect(attempt).rejects.toMatchObject(
        errorClass === DirectDepositError ? { reason } : { rule: reason },
      );
    },
  );

  it.each([
    '',
    'verifier.example',
    'ftp://verifier.example',
    'https://',
    'https:verifier.example',
    'https:/verifier.example',
    'https:\\\\verifier.example',
    ' https://verifier.example',
    'https://verifier.example\n',
    'https://veri\tfier.example',
    'https://verifier%2Eexample',
    'https://verifier%41example',
    'https://ver{ifier.example',
    'https://verifier.example/%zz',
  ])(
    'refuses fulfillment verifier endpoint %p from the defaults',
    async (fulfillmentVerifierEndpoint) => {
      await expect(
        new NoFetchClient().prepareDirectDepositRequest({
          ...directParams(),
          ...withSourceDefaults({ fulfillmentVerifierEndpoint }),
        }),
      ).rejects.toThrow(/fulfillment verifier endpoint .* must be an absolute http\(s\) URL/);
    },
  );

  const SETTLER_DID = 'did:pkh:eip155:1:0x0000000000000000000000000000000000000009';

  it('writes settlerRequirements into the request', async () => {
    const settlerRequirements = { whitelist: [SETTLER_DID] };
    const { request } = await new NoFetchClient().prepareDirectDepositRequest({
      ...directParams(),
      settlerRequirements,
    });

    expect(request.settler_requirements).toEqual(settlerRequirements);
  });

  it.each([
    ['an empty whitelist', { whitelist: [] }],
    ['a duplicate entry', { blacklist: [SETTLER_DID, SETTLER_DID] }],
    ['a non-DID entry', { whitelist: ['0x0000000000000000000000000000000000000009'] }],
    [
      'more than 100 entries',
      { whitelist: Array.from({ length: 101 }, (_, i) => `did:web:settler-${i}.example`) },
    ],
  ])(
    'refuses settlerRequirements with %s before any network call',
    async (_label, settlerRequirements) => {
      const fetching = fetchingParams();

      await expect(
        new NoFetchClient().prepareDirectDepositRequest({ ...fetching, settlerRequirements }),
      ).rejects.toThrow(/settlerRequirements\.(whitelist|blacklist)/);
    },
  );

  /**
   * A client whose `/v1/defaults` answers with `evmDefaults` on the wire, advertising the Permit2
   * path's depositRequestHash v2 signal, so a test covers the real wire mapping. `wire` adds
   * members to every chain's answer.
   */
  function fetchingClient(wire: Record<string, unknown> = {}): PaymentGatewayClient {
    const client = new PaymentGatewayClient({ BASE: 'http://gateway.invalid' });
    jest.spyOn(client.chainDefaults, 'getDefaults').mockImplementation(
      (data) =>
        Promise.resolve({
          chain_id: data?.chainId,
          escrow_contract: evmDefaults.escrowContract,
          fulfillment_proxy: evmDefaults.fulfillmentProxy,
          quote_selector: evmDefaults.quoteSelector,
          fulfillment_verifier: {
            account: evmDefaults.fulfillmentVerifierAccount,
            endpoint: evmDefaults.fulfillmentVerifierEndpoint,
          },
          deposit_request_hash_version: 2,
          deposit_request_hash_versions: [2],
          ...wire,
        }) as never,
    );
    return client;
  }

  it('fetches the corridor from /v1/defaults and builds what the offline path builds', async () => {
    const fetching = fetchingParams();

    const fetched = await fetchingClient().prepareDirectDepositRequest(fetching);
    const offline = await new NoFetchClient().prepareDirectDepositRequest(directParams());

    expect(JSON.stringify(fetched.request)).toBe(JSON.stringify(offline.request));
    expect(fetched.deposit).toEqual(offline.deposit);
  });

  it('fetches only destination defaults when source defaults are supplied', async () => {
    const client = fetchingClient();
    const prepared = await client.prepareDirectDepositRequest({
      ...fetchingParams(),
      resolvedDefaults: { source: evmDefaults },
    });
    const offline = await new NoFetchClient().prepareDirectDepositRequest(directParams());

    expect(client.chainDefaults.getDefaults).toHaveBeenCalledTimes(1);
    expect(client.chainDefaults.getDefaults).toHaveBeenCalledWith({ chainId: 'eip155:2' });
    expect(prepared).toEqual(offline);
  });

  it('derives at the version passed, not the Permit2 version /v1/defaults advertises', async () => {
    const fetching = fetchingParams();

    const { request, deposit } = await fetchingClient().prepareDirectDepositRequest({
      ...fetching,
      depositRequestHashVersion: 1,
    });

    expect(deposit).toEqual(
      deriveDirectDeposit(JSON.stringify(request), 1n, evmDefaults.escrowContract, 1),
    );
    expect(deposit).not.toEqual(
      deriveDirectDeposit(JSON.stringify(request), 1n, evmDefaults.escrowContract, 2),
    );
  });

  describe('the version the gateway publishes', () => {
    /** {@link fetchingParams} with no version passed, so the gateway's published one decides. */
    function unversionedParams() {
      const { depositRequestHashVersion: _passed, ...params } = fetchingParams();
      return params;
    }

    /** {@link directParams} with no version passed, offline. */
    function unversionedOfflineParams() {
      const { depositRequestHashVersion: _passed, ...params } = directParams();
      return params;
    }

    /** A client whose /v1/defaults publishes `version` as the direct-deposit version. */
    function publishing(version: unknown): PaymentGatewayClient {
      return fetchingClient({ direct_deposit_request_hash_version: version });
    }

    const derivedAt = (request: object, version: 1 | 2) =>
      deriveDirectDeposit(JSON.stringify(request), 1n, evmDefaults.escrowContract, version);

    const PASSED_V1 =
      /you passed depositRequestHashVersion 1, which is deprecated for direct deposits and will be retired: leave it unset to follow the gateway where it publishes its version, or pass 2 once your gateway derives at 2/;

    it('follows a gateway that publishes 2 when no version is passed, with no notice', async () => {
      const prepared = await publishing(2).prepareDirectDepositRequest(unversionedParams());

      expect(prepared.depositRequestHashVersion).toBe(2);
      expect(prepared.deposit).toEqual(derivedAt(prepared.request, 2));
      expect(prepared.deposit.depositId).not.toBe(derivedAt(prepared.request, 1).depositId);
      expect(prepared).not.toHaveProperty('deprecation');
      expect(emitWarning).not.toHaveBeenCalled();
    });

    // A caller following the gateway moves to version 2 when the gateway does, so it has nothing to
    // act on: the result says so, and nothing is reported.
    it('follows a gateway that publishes 1, flags the deposit, and reports nothing', async () => {
      const prepared = await publishing(1).prepareDirectDepositRequest(unversionedParams());

      expect(prepared.depositRequestHashVersion).toBe(1);
      expect(prepared.deposit).toEqual(derivedAt(prepared.request, 1));
      expect(prepared.deposit.depositId).not.toBe(derivedAt(prepared.request, 2).depositId);
      expect(prepared.deprecation).toEqual({
        code: 'ATUM_DIRECT_DEPOSIT_V1',
        message: expect.stringMatching(
          /commits depositRequestHash version 1 because the gateway derives direct deposits from eip155:1 at version 1, which is deprecated for direct deposits.*nothing to change on your side/,
        ),
      });
      expect(prepared.deprecation!.message).not.toMatch(/you passed/);
      expect(emitWarning).not.toHaveBeenCalled();
    });

    it.each([
      ['publishes 1', () => publishing(1)],
      ['publishes none', () => fetchingClient()],
    ])(
      'reports a passed version 1, to a gateway that %s, as a DeprecationWarning',
      async (_label, client) => {
        const prepared = await client().prepareDirectDepositRequest({
          ...fetchingParams(),
          depositRequestHashVersion: 1,
        });

        expect(prepared.depositRequestHashVersion).toBe(1);
        expect(prepared.deprecation).toEqual({
          code: 'ATUM_DIRECT_DEPOSIT_V1',
          message: expect.stringMatching(PASSED_V1),
        });
        expect(emitWarning).toHaveBeenCalledTimes(1);
        expect(emitWarning).toHaveBeenCalledWith(prepared.deprecation!.message, {
          type: 'DeprecationWarning',
          code: 'ATUM_DIRECT_DEPOSIT_V1',
        });
      },
    );

    // As Node's util.deprecate: one warning per process for the code, however many clients.
    it('reports a passed version 1 once per process, while every v1 result carries it', async () => {
      const passedV1 = { ...fetchingParams(), depositRequestHashVersion: 1 as const };

      const first = await publishing(1).prepareDirectDepositRequest(passedV1);
      const second = await publishing(1).prepareDirectDepositRequest({
        ...passedV1,
        depositNonce: '8',
      });
      const offline = await new NoFetchClient().prepareDirectDepositRequest({
        ...directParams(),
        depositRequestHashVersion: 1,
      });

      expect(emitWarning).toHaveBeenCalledTimes(1);
      expect(first.deprecation?.code).toBe('ATUM_DIRECT_DEPOSIT_V1');
      expect(second.deprecation?.code).toBe('ATUM_DIRECT_DEPOSIT_V1');
      expect(offline.deprecation?.code).toBe('ATUM_DIRECT_DEPOSIT_V1');
    });

    // Fully offline, the method reads nothing from its client, so a detached call works; the
    // notice must not be what breaks it.
    it('flags a version 1 deposit prepared by a detached call, offline', async () => {
      const prepared = await NoFetchClient.prototype.prepareDirectDepositRequest.call(
        undefined as unknown as NoFetchClient,
        { ...directParams(), depositRequestHashVersion: 1 },
      );

      expect(prepared.deprecation?.code).toBe('ATUM_DIRECT_DEPOSIT_V1');
      expect(emitWarning).toHaveBeenCalledTimes(1);
    });

    describe('under --throw-deprecation', () => {
      afterEach(() => {
        delete (process as { throwDeprecation?: boolean }).throwDeprecation;
        delete (process as { noDeprecation?: boolean }).noDeprecation;
      });

      // Node would throw on a later tick, after the deposit was returned and out of the caller's
      // reach; the method rejects with the warning instead, so the caller can catch it.
      it('rejects a passed version 1 with the warning, every time, before returning a deposit', async () => {
        process.throwDeprecation = true;
        const client = new NoFetchClient();
        const passedV1 = { ...directParams(), depositRequestHashVersion: 1 as const };

        const thrown = {
          name: 'DeprecationWarning',
          code: 'ATUM_DIRECT_DEPOSIT_V1',
          message: expect.stringMatching(PASSED_V1),
        };

        const first = client.prepareDirectDepositRequest(passedV1);
        await expect(first).rejects.toBeInstanceOf(Error);
        await expect(first).rejects.toMatchObject(thrown);
        await expect(client.prepareDirectDepositRequest(passedV1)).rejects.toMatchObject(thrown);
        expect(emitWarning).not.toHaveBeenCalled();
      });

      it('still returns a deposit that follows a gateway publishing 1', async () => {
        process.throwDeprecation = true;

        const prepared = await publishing(1).prepareDirectDepositRequest(unversionedParams());

        expect(prepared.deprecation?.code).toBe('ATUM_DIRECT_DEPOSIT_V1');
      });

      it('gives way to --no-deprecation, as Node does', async () => {
        process.throwDeprecation = true;
        process.noDeprecation = true;

        const prepared = await new NoFetchClient().prepareDirectDepositRequest({
          ...directParams(),
          depositRequestHashVersion: 1,
        });

        expect(prepared.deprecation?.code).toBe('ATUM_DIRECT_DEPOSIT_V1');
        expect(emitWarning).not.toHaveBeenCalled();
      });
    });

    it.each([
      [2, 1],
      [1, 2],
    ] as const)(
      'refuses version %d passed to a gateway that publishes %d, before returning anything',
      async (passed, published) => {
        const attempt = publishing(published).prepareDirectDepositRequest({
          ...fetchingParams(),
          depositRequestHashVersion: passed,
        });

        await expect(attempt).rejects.toBeInstanceOf(DirectDepositError);
        await expect(attempt).rejects.toMatchObject({ reason: 'gateway_version' });
        await expect(attempt).rejects.toThrow(
          new RegExp(
            `depositRequestHashVersion is ${passed}, but the gateway derives direct deposits from ` +
              `eip155:1 at version ${published}.*omit depositRequestHashVersion to follow the gateway`,
          ),
        );
        expect(emitWarning).not.toHaveBeenCalled();
      },
    );

    it.each([1, 2] as const)(
      'builds at the version passed, %d, when the gateway publishes the same',
      async (version) => {
        const prepared = await publishing(version).prepareDirectDepositRequest({
          ...fetchingParams(),
          depositRequestHashVersion: version,
        });

        expect(prepared.depositRequestHashVersion).toBe(version);
        expect(prepared.deposit).toEqual(derivedAt(prepared.request, version));
      },
    );

    it.each([1, 2] as const)(
      'builds at the version passed, %d, when the gateway publishes none',
      async (version) => {
        const prepared = await fetchingClient().prepareDirectDepositRequest({
          ...fetchingParams(),
          depositRequestHashVersion: version,
        });

        expect(prepared.depositRequestHashVersion).toBe(version);
        expect(prepared.deposit).toEqual(derivedAt(prepared.request, version));
      },
    );

    it('refuses to guess a version when none is passed and the gateway publishes none', async () => {
      const attempt = fetchingClient().prepareDirectDepositRequest(unversionedParams());

      await expect(attempt).rejects.toBeInstanceOf(DirectDepositError);
      await expect(attempt).rejects.toMatchObject({ reason: 'version_unpublished' });
      await expect(attempt).rejects.toThrow(
        /the gateway does not publish the depositRequestHash version it derives direct deposits from eip155:1 at: pass depositRequestHashVersion/,
      );
    });

    // A published version that is not 1 or 2 is one this build cannot commit, whether a later
    // version or a malformed value. A deposit at 1 or 2 would name no payment there, so it is
    // refused even when a version is passed, rather than read as absent.
    describe.each([3, 0, '2', 1.5])('a published %p', (published) => {
      it.each([undefined, 1, 2] as const)(
        'is refused with depositRequestHashVersion %p',
        async (passed) => {
          const attempt = publishing(published).prepareDirectDepositRequest({
            ...unversionedParams(),
            ...(passed === undefined ? {} : { depositRequestHashVersion: passed }),
          });

          await expect(attempt).rejects.toBeInstanceOf(DirectDepositError);
          await expect(attempt).rejects.toMatchObject({ reason: 'version_unknown' });
          await expect(attempt).rejects.toThrow(
            /the gateway derives direct deposits from eip155:1 at version .+, which this build cannot commit: upgrade @atumlabs\/payment-gateway-client/,
          );
          expect(emitWarning).not.toHaveBeenCalled();
        },
      );
    });

    it('refuses offline defaults that carry a version it does not know, even with one passed', async () => {
      const attempt = new NoFetchClient().prepareDirectDepositRequest({
        ...directParams(),
        ...withSourceDefaults({ directDepositRequestHashVersion: 3 }),
        depositRequestHashVersion: 2,
      });

      await expect(attempt).rejects.toMatchObject({ reason: 'version_unknown' });
      await expect(attempt).rejects.toThrow(/at version 3, which this build cannot commit/);
    });

    // JSON null publishes nothing, online or offline: the version passed decides, and none is
    // refused as unpublished.
    it('reads a null in offline defaults as not published', async () => {
      const nulled = withSourceDefaults({
        directDepositRequestHashVersion: null as unknown as number,
      });

      const prepared = await new NoFetchClient().prepareDirectDepositRequest({
        ...directParams(),
        ...nulled,
      });
      const unversioned = new NoFetchClient().prepareDirectDepositRequest({
        ...unversionedOfflineParams(),
        ...nulled,
      });

      expect(prepared.depositRequestHashVersion).toBe(2);
      await expect(unversioned).rejects.toMatchObject({ reason: 'version_unpublished' });
    });

    it('reads a published null as not published', async () => {
      const attempt = publishing(null).prepareDirectDepositRequest(unversionedParams());

      await expect(attempt).rejects.toMatchObject({ reason: 'version_unpublished' });
    });

    it.each([1, 2] as const)(
      'follows the version %d in offline defaults, with no gateway call',
      async (version) => {
        const prepared = await new NoFetchClient().prepareDirectDepositRequest({
          ...unversionedOfflineParams(),
          ...withSourceDefaults({ directDepositRequestHashVersion: version }),
        });

        expect(prepared.depositRequestHashVersion).toBe(version);
        expect(prepared.deposit).toEqual(derivedAt(prepared.request, version));
      },
    );

    // The version is read last, so a gateway with a malformed corridor gets that refusal, not one
    // about a version it does not publish.
    it('refuses a quote selector with a wrong checksum before asking for a version', async () => {
      const attempt = fetchingClient({
        quote_selector: '0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      }).prepareDirectDepositRequest(unversionedParams());

      await expect(attempt).rejects.toThrow(
        /the quote selector .*: account is not a valid address/,
      );
    });

    it('refuses a zero quote selector before asking for a version', async () => {
      const attempt = fetchingClient({
        quote_selector: '0x0000000000000000000000000000000000000000',
      }).prepareDirectDepositRequest(unversionedParams());

      await expect(attempt).rejects.toBeInstanceOf(DirectDepositRuleError);
      await expect(attempt).rejects.toMatchObject({ rule: 'quote_selector' });
    });

    it('refuses a requestId that is not a random UUID once the gateway names version 1', async () => {
      const attempt = publishing(1).prepareDirectDepositRequest({
        ...unversionedParams(),
        requestId: 'order-42',
      });

      await expect(attempt).rejects.toBeInstanceOf(DirectDepositError);
      await expect(attempt).rejects.toMatchObject({ reason: 'request' });
      await expect(attempt).rejects.toThrow(
        /at depositRequestHashVersion 1 the requestId must be a random UUID from randomUUID\(\)/,
      );
      expect(emitWarning).not.toHaveBeenCalled();
    });

    it('accepts an order number as the requestId once the gateway names version 2', async () => {
      const { request } = await publishing(2).prepareDirectDepositRequest({
        ...unversionedParams(),
        requestId: 'order-42',
      });

      expect(request.request_id).toBe('order-42');
    });

    it('returns the deprecation with the request, the deposit and the version', async () => {
      const prepared = await publishing(1).prepareDirectDepositRequest(unversionedParams());

      expect(Object.keys(prepared).sort()).toEqual([
        'deposit',
        'depositRequestHashVersion',
        'deprecation',
        'request',
      ]);
    });

    describe('where process.emitWarning is unavailable', () => {
      const original = process.emitWarning;
      let consoleWarn: jest.SpyInstance;
      beforeEach(() => {
        (process as { emitWarning?: unknown }).emitWarning = undefined;
        consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      });
      afterEach(() => {
        process.emitWarning = original;
        consoleWarn.mockRestore();
        delete (process as { noDeprecation?: boolean }).noDeprecation;
      });

      const passedV1 = () => ({ ...directParams(), depositRequestHashVersion: 1 as const });

      it('writes a passed version 1 with console.warn, once per process', async () => {
        const prepared = await new NoFetchClient().prepareDirectDepositRequest(passedV1());
        await new NoFetchClient().prepareDirectDepositRequest(passedV1());

        expect(consoleWarn).toHaveBeenCalledTimes(1);
        expect(consoleWarn).toHaveBeenCalledWith(
          `DeprecationWarning [ATUM_DIRECT_DEPOSIT_V1]: ${prepared.deprecation!.message}`,
        );
      });

      it('stays silent under process.noDeprecation, and still flags the result', async () => {
        process.noDeprecation = true;

        const prepared = await new NoFetchClient().prepareDirectDepositRequest(passedV1());

        expect(consoleWarn).not.toHaveBeenCalled();
        expect(prepared.deprecation?.code).toBe('ATUM_DIRECT_DEPOSIT_V1');
      });

      it('does not need process at all', async () => {
        const client = new NoFetchClient();
        const globals = globalThis as { process?: unknown };
        const saved = globals.process;
        globals.process = undefined;
        let prepared;
        try {
          prepared = await client.prepareDirectDepositRequest(passedV1());
        } finally {
          globals.process = saved;
        }

        expect(prepared.deprecation?.code).toBe('ATUM_DIRECT_DEPOSIT_V1');
        expect(consoleWarn).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('retry identity', () => {
    const later = () => NOW_MS + 30_000;

    it.each([1, 2] as const)('rebuilds byte-identical at the same now, at v%d', async (version) => {
      const client = new NoFetchClient();
      const params = { ...directParams(), depositRequestHashVersion: version };

      const first = await client.prepareDirectDepositRequest(params);
      const again = await client.prepareDirectDepositRequest(params);

      expect(JSON.stringify(again.request)).toBe(JSON.stringify(first.request));
      expect(again.deposit.depositId).toBe(first.deposit.depositId);
    });

    it('keeps the v1 id when only the deadlines move', async () => {
      const client = new NoFetchClient();
      const params = { ...directParams(), depositRequestHashVersion: 1 as const };

      const first = await client.prepareDirectDepositRequest(params);
      const rebuilt = await client.prepareDirectDepositRequest({ ...params, now: later });

      expect(rebuilt.request.quote_deadline).not.toBe(first.request.quote_deadline);
      expect(rebuilt.deposit.depositId).toBe(first.deposit.depositId);
    });

    it('changes the v2 id when only the deadlines move, so a rebuild is a different deposit', async () => {
      const client = new NoFetchClient();
      const params = directParams();

      const first = await client.prepareDirectDepositRequest(params);
      const rebuilt = await client.prepareDirectDepositRequest({ ...params, now: later });

      expect(rebuilt.deposit.depositId).not.toBe(first.deposit.depositId);
    });
  });

  describe.each([1, 2] as const)('the id commits each deposit term, at v%d', (version) => {
    const other = '0x00000000000000000000000000000000000000aa';
    it.each([
      ['the depositor', { depositor: other }],
      ['max_source_amount', { maxSourceAmount: '103001' }],
      ['the nonce', { depositNonce: '8' }],
      ['the destination account', { destinationAccount: other }],
      ['the destination asset', { destinationAsset: `eip155:2/erc20:${other}` }],
      ['the quote selector', withSourceDefaults({ quoteSelector: other })],
      ['the verifier account', withSourceDefaults({ fulfillmentVerifierAccount: other })],
    ])('changes with %s', async (_label, override) => {
      const client = new NoFetchClient();
      const params = { ...directParams(), depositRequestHashVersion: version };

      const base = await client.prepareDirectDepositRequest(params);
      const changed = await client.prepareDirectDepositRequest({ ...params, ...override });

      expect(changed.deposit.depositId).not.toBe(base.deposit.depositId);
    });
  });

  it('returns the request, the deposit and the version it commits', async () => {
    const prepared = await new NoFetchClient().prepareDirectDepositRequest(directParams());

    expect(Object.keys(prepared).sort()).toEqual([
      'deposit',
      'depositRequestHashVersion',
      'request',
    ]);
    expect(prepared.depositRequestHashVersion).toBe(2);
  });

  it('accepts a fulfillmentAmount of exactly 10^30', async () => {
    const fulfillmentAmount = (10n ** 30n).toString();
    const { request } = await new NoFetchClient().prepareDirectDepositRequest({
      ...directParams(),
      fulfillmentAmount,
    });

    expect(request.fulfillment_amount).toBe(fulfillmentAmount);
  });

  it('submits through payments.submitPayment as built, with no cast', async () => {
    const sent: ApiRequestOptions[] = [];
    class RecordingRequest extends BaseHttpRequest {
      request<T>(options: ApiRequestOptions): CancelablePromise<T> {
        sent.push(options);
        return new CancelablePromise<T>((resolve) => resolve({} as T));
      }
    }
    const { request, deposit } = await new NoFetchClient().prepareDirectDepositRequest(
      directParams(),
    );

    await new PaymentGatewayClient(
      { BASE: 'https://gateway.invalid' },
      RecordingRequest,
    ).payments.submitPayment({ requestBody: request });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe(request);
    // The diagnostic shadow names the v2 hash the deposit witness commits at version 2.
    expect(sent[0]!.headers).toEqual({
      'X-Atum-Producer': 'sdk-ts',
      'X-Atum-Deposit-Request-Hash-V2': deposit.input.depositWitness.depositRequestHash,
    });
  });
});

// Rows the Go derivation generated (senderauth direct_deposit_vectors_test.go) for a request
// shaped exactly as this method builds it. Reproducing them here is what shows the SDK, the
// gateway, the settler and the fulfillment verifier name the same deposit for the same inputs.
describe.each([1, 2] as const)('the Go-generated SDK-shaped derivation row at v%d', (version) => {
  it('is what prepareDirectDepositRequest builds and derives', async () => {
    const row = derivationVectors.golden.find(
      (r) => r.name.startsWith('sdk-shaped') && r.version === version,
    );
    expect(row).toBeDefined();

    const { request, deposit } = await new NoFetchClient().prepareDirectDepositRequest({
      depositor: '0x00000000000000000000000000000000000A11cE',
      fulfillmentAmount: '750000',
      sourceAsset: 'eip155:31337/erc20:0x00000000000000000000000000000000000070Ce',
      destinationAccount: '0x000000000000000000000000000000000000b0b0',
      destinationAsset: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      maxSourceAmount: '1000000000000000000000',
      requestId: '6b1e4d2a-8c3f-4e5b-9a7d-2f0c8e1b3d54',
      depositNonce: '7',
      depositRequestHashVersion: version,
      fulfill: 'originator',
      quoteDeadlineSeconds: 60,
      fulfillmentDeadlineSeconds: 660,
      now: () => Date.parse('2029-12-31T23:59:00.000Z'),
      resolvedDefaults: {
        source: {
          escrowContract: '0x000000000000000000000000000000000000e5c0',
          fulfillmentProxy: '0x000000000000000000000000000000000000f0f0',
          quoteSelector: '0x9139213bE0cF31C8B1bD609f1d953605e20bD2Cb',
          fulfillmentVerifierAccount: '0x83743f550bcdb5bE905766E2E3CB9a86c6823cC9',
          fulfillmentVerifierEndpoint: 'https://veri-fill.example.com',
        },
        destination: { fulfillmentProxy: '0x000000000000000000000000000000000000f0f0' },
      },
    });

    expect(request).toEqual(JSON.parse(row!.request));
    expect(row!.chainId).toBe('31337');
    expect(row!.escrow.toLowerCase()).toBe(request.escrow_contract_address.toLowerCase());
    expect(deposit.depositId).toBe(row!.depositId);
    expect(deposit.input.token).toBe(row!.token);
    expect(deposit.input.amount.toString()).toBe(row!.amount);
    expect(deposit.input.nonce.toString()).toBe(row!.nonce);
    expect(deposit.input.depositWitness).toEqual({
      depositRequestHash: row!.depositRequestHash,
      destination: row!.destination,
      reserver: row!.reserver,
      releaser: row!.releaser,
    });
    expect(deposit.unreservedHash).toBe(row!.unreservedHash);
  });
});

describe('encodeDirectDepositCalldata', () => {
  it('encodes escrow.directDeposit for the prepared deposit input as returned', async () => {
    const { deposit } = await new NoFetchClient().prepareDirectDepositRequest(directParams());

    expect(encodeDirectDepositCalldata(deposit.input)).toBe(
      escrowEncodeDirectDeposit(deposit.input),
    );
  });
});

describe('deriveDirectDeposit from the package root', () => {
  it('re-derives the prepared deposit from the request as stored', async () => {
    const { request, deposit } = await new NoFetchClient().prepareDirectDepositRequest(
      directParams(),
    );
    const stored = JSON.stringify(request);

    expect(deriveFromStoredRequest(stored, 1n, request.escrow_contract_address!, 2)).toEqual(
      deposit,
    );
  });
});
