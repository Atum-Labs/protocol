import { describe, it, expect, vi } from 'vitest';
import { Challenge, Credential } from 'mppx';
import { registerClient } from './client.js';
import {
  deterministicPermitNonce,
  deterministicRequestId,
  deterministicSolanaNonce,
} from '@atum-labs/payment-request-sender-auth';
import { buildChargeRequest } from './server.js';
import { INTENT_ID_META_KEY } from './internal.js';
import type { AtumEscrowChallenge } from './index.js';
import {
  PRIVATE_KEY,
  PAYER,
  NOW,
  now,
  corridor,
  EVM_SOURCE,
  request,
  challenge,
  buildCredential,
  buildTronCredential,
  TRON_PAYER,
  fixtureTrust,
  buildSolanaCredential,
  SOL_PAYER,
  seedHex,
  solanaCorridor,
  solanaChallenge,
} from './test-helpers.js';

// Route `provider: "turnkey"` to a fake signer instead of a real Turnkey network call. Turnkey's
// own construction/signing correctness is payment-gateway-client's concern and is already
// covered there (signers/turnkey.test.ts, with its own injected fake loader); this mock exists
// only so the routing regression test below runs fast and offline, proving buildSenderSigner
// reaches createSenderSigner for `turnkey` rather than throwing before it. Every other provider
// (and every other test in this file) goes through the real implementation unchanged.
vi.mock('@atum-labs/payment-gateway-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@atum-labs/payment-gateway-client')>();
  return {
    ...actual,
    createSenderSigner: (
      network: string,
      opts: Parameters<typeof actual.createSenderSigner>[1],
    ) => {
      if (opts.provider === 'turnkey') {
        // The default that stops a misconfigured Turnkey wallet from signing as the wrong
        // payer — buildSenderSigner's job, not createSenderSigner's, so it belongs in this
        // routing test rather than in PGC's own turnkey.test.ts.
        expect(opts.pinnedAddress).toBe(PAYER);
        return { sign: async () => ({ signature: '0xfaketurnkeysignature' }) };
      }
      return actual.createSenderSigner(network, opts);
    },
  };
});

describe('createCredential (EVM)', () => {
  it('builds a signed PaymentRequest matching the challenge', async () => {
    const cred = await buildCredential();
    const pr = cred.payload.paymentRequest;
    expect(pr.source.account).toBe(PAYER);
    expect(pr.source.asset_identifier).toBe(
      'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    );
    expect(pr.destination[0].account).toBe(corridor.destination.account);
    expect(pr.destination[0].asset_identifier).toBe(
      'eip155:42161/erc20:0x52e52f345139e57b87d288c9ea794bb3fbe591c3',
    );
    expect(pr.fulfillment_amount).toBe('10000000');
    expect(pr.max_source_amount).toBe('10300000');
    expect(pr.quote_deadline).toBe(new Date(NOW + 20_000).toISOString());
    expect(pr.fulfillment_deadline).toBe(new Date(NOW + 300_000).toISOString());
    expect(pr.sender_auth.message_scheme).toBe('EVM_PERMIT2');
    expect(pr.sender_auth.signed_messages[0].signature).toMatch(/^0x[0-9a-f]+$/i);
    expect(cred.source).toBe(`did:pkh:eip155:8453:${PAYER.toLowerCase()}`);
  });

  // Bidding closes at quote_deadline, so a slow trust lookup (a cold cache can take seconds)
  // must not come out of the window: the clock is read after the corridor is vouched for.
  it('stamps the deadlines after the trust lookup', async () => {
    let clock = NOW;
    const client = registerClient({
      signer: { privateKey: PRIVATE_KEY },
      account: PAYER,
      now: () => clock,
      trust: async (network: string) => {
        clock += 3_000;
        return fixtureTrust(network);
      },
    });

    const cred = Credential.deserialize<{ paymentRequest: any }>(
      await client.createCredential({ challenge }),
    );

    expect(cred.payload.paymentRequest.quote_deadline).toBe(
      new Date(clock + corridor.quoteDeadlineSeconds * 1000).toISOString(),
    );
    expect(cred.payload.paymentRequest.fulfillment_deadline).toBe(
      new Date(clock + corridor.fulfillmentDeadlineSeconds * 1000).toISOString(),
    );
  });

  it('signs the cap as the Permit2 amount (gateway pins permit == max_source_amount)', async () => {
    const cred = await buildCredential();
    const permit = JSON.parse(
      cred.payload.paymentRequest.sender_auth.signed_messages[0].message_prehash,
    ).message;
    expect(permit.permitted.amount).toBe('10300000');
    expect(cred.payload.paymentRequest.max_source_amount).toBe('10300000');
  });

  it('refuses a challenge whose deadline budgets cannot settle, and blames the merchant', async () => {
    const bad = buildChargeRequest(
      { ...corridor, quoteDeadlineSeconds: 250, fulfillmentDeadlineSeconds: 300 },
      EVM_SOURCE,
      '10000000',
    );
    // Failure comes from the BUDGETS being inverted (300 > 20), not from the clock: both are
    // relative seconds added to the same `now`, so this check cannot be about staleness.
    const client = registerClient({
      signer: { privateKey: PRIVATE_KEY },
      account: PAYER,
      now: () => NOW,
      trust: fixtureTrust,
    });
    const badChallenge = {
      ...challenge,
      request: {
        ...bad,
        extra: { ...bad.extra, quoteDeadlineSeconds: 300, fulfillmentDeadlineSeconds: 20 },
      },
    } as AtumEscrowChallenge;
    const err = await client.createCredential({ challenge: badChallenge }).catch((e: unknown) => e);
    // Names the offending values, so a merchant can see which budget is wrong…
    expect((err as Error).message).toMatch(/quoteDeadlineSeconds=300/);
    expect((err as Error).message).toMatch(/fulfillmentDeadlineSeconds=20/);
    // …and says whose problem it is. A payer cannot correct a corridor it was handed, so a message
    // that reads like a payer-recoverable staleness error sends them chasing the wrong fix.
    expect((err as Error).message).toMatch(/merchant-side/);
  });

  it('accepts Turnkey provider options instead of refusing them', async () => {
    // Regression test: buildSenderSigner used to throw for `provider: "turnkey"` before ever
    // reaching createSenderSigner, even though createSenderSigner already constructs a working
    // TurnkeySenderSigner for it. With the module-level mock above standing in for the real
    // Turnkey network call, this proves the ROUTING end to end: turnkey options reach
    // createSenderSigner instead of the old throw, and createCredential completes normally
    // with the (fake) signature threaded through.
    const client = registerClient({
      signer: {
        provider: 'turnkey',
        organizationId: 'org_fake',
        walletId: 'wallet_fake',
        apiPublicKey: 'pub_fake',
        apiPrivateKey: 'priv_fake',
      },
      account: PAYER,
      now: () => NOW,
      trust: fixtureTrust,
    });
    const cred = await client.createCredential({ challenge });
    const pr = Credential.deserialize<{ paymentRequest: any }>(cred).payload.paymentRequest;
    expect(pr.sender_auth.signed_messages[0].signature).toBe('0xfaketurnkeysignature');
  });

  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a trailing newline', '\n'],
  ])('defaults a blank pinnedAddress (%s) to the payer account', async (_label, pinnedAddress) => {
    // Blank means unpinned here, so it falls back. Forwarding it instead reaches pgc's guard,
    // which refuses the value, and this call throws.
    const client = registerClient({
      signer: { privateKey: PRIVATE_KEY, pinnedAddress },
      account: PAYER,
      now: () => NOW,
      trust: fixtureTrust,
    });
    const cred = await client.createCredential({ challenge });
    const pr = Credential.deserialize<{ paymentRequest: any }>(cred).payload.paymentRequest;
    expect(pr.source.account).toBe(PAYER);
  });

  it('forwards a non-string pinnedAddress so the guard names the field', async () => {
    // Only a blank string falls back. Anything else goes through untouched, so pgc names
    // pinnedAddress rather than failing on trim with a message that points nowhere.
    const client = registerClient({
      signer: { privateKey: PRIVATE_KEY, pinnedAddress: 123 as unknown as string },
      account: PAYER,
      now: () => NOW,
      trust: fixtureTrust,
    });
    const err = await client.createCredential({ challenge }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/pinnedAddress/);
  });
});

describe('createCredential (Tron)', () => {
  it('reproduces the same deposit nonce on rebuild (charge-safety)', async () => {
    const nonceOf = (c: any) =>
      JSON.parse(c.payload.paymentRequest.sender_auth.signed_messages[0].message_prehash).message
        .nonce;
    expect(nonceOf(await buildTronCredential())).toBe(nonceOf(await buildTronCredential()));
  });
});

describe('createCredential (Solana)', () => {
  it('builds a signed request with an SVM scheme and a delegate signer', async () => {
    const cred = await buildSolanaCredential();
    const pr = cred.payload.paymentRequest;
    expect(pr.sender_auth.message_scheme).toBe('SOLANA');
    expect(pr.source.asset_identifier).toBe(
      `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/spl:${solanaCorridor.sources[0]!.assets[0]!.address}`,
    );
    expect(pr.sender_auth.signed_messages[0].payload.delegate_signer).toBe(SOL_PAYER);
  });

  it("anchors the deposit's issued_at on extra.issuedAt (not the client clock) when present", async () => {
    const readIssuedAt = (cred: { payload: { paymentRequest: any } }) =>
      Number(
        JSON.parse(cred.payload.paymentRequest.sender_auth.signed_messages[0].message_prehash)
          .issued_at,
      );

    // Merchant stamps issuedAt 3s before the client clock (NOW). No solanaClockReader is
    // configured, so the ONLY source for issued_at is extra.issuedAt.
    const solSelect = {
      network: solanaCorridor.sources[0]!.network,
      asset: solanaCorridor.sources[0]!.assets[0]!.address,
    };
    const merchantIssuedAt = String(Math.floor(NOW / 1000) - 3);
    const stampedReq = buildChargeRequest(solanaCorridor, solSelect, '10000000', {
      issuedAt: merchantIssuedAt,
    });
    const stampedClient = registerClient({
      signer: { privateKey: seedHex },
      account: SOL_PAYER,
      now,
      trust: fixtureTrust,
    });
    const stamped = Credential.deserialize<{ paymentRequest: any }>(
      await stampedClient.createCredential({
        challenge: { ...challenge, request: stampedReq } as AtumEscrowChallenge,
      }),
    );

    // Fallback path: no extra.issuedAt → the injected client clock (NOW) is used.
    const fromClock = await buildSolanaCredential();

    // Both deposits go through the same adapter (which applies a fixed issued-at backdate),
    // so the DIFFERENCE between them equals the difference in their sources: the merchant
    // value was 3s earlier than the client clock. This proves extra.issuedAt is what anchors
    // the stamped issued_at verbatim when present, and the client clock is the fallback.
    expect(readIssuedAt(stamped) - readIssuedAt(fromClock)).toBe(-3);
  });

  // Bidding closes at quote_deadline, so a configured clock reader that takes time (an RPC call,
  // say) must not come out of the window: the deadlines are stamped after it answers.
  it('stamps the deadlines after the configured clock reader answers', async () => {
    let clock = NOW;
    const client = registerClient({
      signer: { privateKey: seedHex },
      account: SOL_PAYER,
      now: () => clock,
      solanaClockReader: async () => {
        clock += 1_500;
        return BigInt(Math.floor(NOW / 1000));
      },
      trust: fixtureTrust,
    });

    const cred = Credential.deserialize<{ paymentRequest: any }>(
      await client.createCredential({ challenge: solanaChallenge }),
    );

    expect(cred.payload.paymentRequest.quote_deadline).toBe(
      new Date(clock + solanaCorridor.quoteDeadlineSeconds * 1000).toISOString(),
    );
  });
});

/**
 * The payment's identity — its `request_id`, which the gateway de-duplicates on, and the deposit
 * nonce derived from it — comes from the merchant's per-purchase identifier. These tests build
 * challenges through the real mppx machinery (HMAC-bound ids, real metadata serialization) rather
 * than hand-set fixtures, so they exercise the identifier the way it actually travels.
 *
 * The properties that have to hold, and the way each one fails if it doesn't:
 *   - stable across retries of one purchase, or every retry becomes a second charge;
 *   - distinct across purchases, or a second purchase silently resolves onto the first and goes
 *     unpaid;
 *   - independent of the terms and the expiry, since neither tracks the purchase;
 *   - absent ⇒ refuse, because there is no safe value to invent.
 */
describe('idempotency anchor (merchant-stamped per-purchase identifier)', () => {
  const SECRET_KEY = 'test-secret-key';
  const REALM = 'api.example.com';

  /** Issue a challenge the way a merchant's mppx server does (HMAC-bound id + metadata). */
  function issue(
    intentId: string | undefined,
    options: { expires?: string; request?: unknown } = {},
  ): AtumEscrowChallenge {
    return Challenge.from({
      realm: REALM,
      method: 'atum-escrow',
      intent: 'charge',
      request: options.request ?? request,
      ...(intentId !== undefined ? { meta: { [INTENT_ID_META_KEY]: intentId } } : {}),
      ...(options.expires ? { expires: options.expires } : {}),
      secretKey: SECRET_KEY,
    } as any) as unknown as AtumEscrowChallenge;
  }

  async function credentialFor(chg: AtumEscrowChallenge) {
    const client = registerClient({
      signer: { privateKey: PRIVATE_KEY },
      account: PAYER,
      now,
      trust: fixtureTrust,
    });
    return Credential.deserialize<{ paymentRequest: any }>(
      await client.createCredential({ challenge: chg }),
    );
  }

  const requestIdOf = async (chg: AtumEscrowChallenge): Promise<string> =>
    (await credentialFor(chg)).payload.paymentRequest.request_id;

  const nonceOf = async (chg: AtumEscrowChallenge): Promise<string> =>
    JSON.parse(
      (await credentialFor(chg)).payload.paymentRequest.sender_auth.signed_messages[0]
        .message_prehash,
    ).message.nonce;

  it("retry of one purchase reproduces the same request_id (the gateway's dedup key)", async () => {
    expect(await requestIdOf(issue('order-1'))).toBe(await requestIdOf(issue('order-1')));
  });

  it('distinct purchases with identical terms get different request_ids — repeat orders never collide', async () => {
    expect(await requestIdOf(issue('order-1'))).not.toBe(await requestIdOf(issue('order-2')));
  });

  it('retry of one purchase reproduces the same deposit nonce (the on-chain backstop)', async () => {
    expect(await nonceOf(issue('order-1'))).toBe(await nonceOf(issue('order-1')));
  });

  it('distinct purchases get different deposit nonces', async () => {
    expect(await nonceOf(issue('order-1'))).not.toBe(await nonceOf(issue('order-2')));
  });

  it('a rolling expires does NOT change the payment identity', async () => {
    // The regression this whole change exists to prevent. The challenge id is an HMAC over the
    // expiry, so a merchant that stamps a fresh `expires` on each 402 — which the framework does
    // by default — used to hand the payer a different anchor every attempt, making every retry a
    // second charge. Anchoring on the purchase identifier instead makes the expiry irrelevant.
    const a = issue('order-1', { expires: '2026-07-08T12:00:00Z' });
    const b = issue('order-1', { expires: '2026-07-08T12:05:00Z' });

    expect(a.id).not.toBe(b.id); // the challenge id still moves …
    expect(await requestIdOf(a)).toBe(await requestIdOf(b)); // … the payment identity does not
    expect(await nonceOf(a)).toBe(await nonceOf(b));
  });

  it('re-quoted terms under one purchase keep the payment identity', async () => {
    // The mirror case: a merchant re-offering the same order with a different cap (a fresh quote)
    // must still be paying for ONE purchase. The identifier is independent of the terms, so the
    // gateway resolves the retry onto the original payment rather than charging again.
    const reQuoted = { ...request, source: { ...request.source, amount: '10400000' } };
    const a = issue('order-1');
    const b = issue('order-1', { request: reQuoted });

    expect(a.id).not.toBe(b.id);
    expect(await requestIdOf(a)).toBe(await requestIdOf(b));
  });

  it('reads the identifier from the wire form, where only serialized metadata survives', async () => {
    // The payer receives the challenge as a WWW-Authenticate header. The framework serializes
    // metadata into `opaque` and does NOT re-parse it into `meta` on the payer side, so reading
    // `meta` alone would find nothing here and every payment would be refused.
    const overWire = Challenge.deserialize(
      Challenge.serialize(issue('order-1') as any),
    ) as unknown as AtumEscrowChallenge;

    expect(overWire.meta).toBeUndefined();
    expect(overWire.opaque).toBeTypeOf('string');
    expect(await requestIdOf(overWire)).toBe(await requestIdOf(issue('order-1')));
  });

  it('refuses a challenge with no identifier instead of inventing one', async () => {
    // There is no safe fallback: a per-build value looks like an idempotency key while letting
    // every retry be charged again. Refusing puts the error on the merchant, who can fix it.
    await expect(requestIdOf(issue(undefined))).rejects.toThrow(
      /carries no 'atumIntentId' metadata/,
    );
  });

  it('refuses metadata that carries other keys but not the identifier', async () => {
    const chg = Challenge.from({
      realm: REALM,
      method: 'atum-escrow',
      intent: 'charge',
      request,
      meta: { orderRef: 'order-1' },
      secretKey: SECRET_KEY,
    } as any) as unknown as AtumEscrowChallenge;

    await expect(requestIdOf(chg)).rejects.toThrow(/carries no 'atumIntentId' metadata/);
  });

  it('refuses an opaque value that is not a metadata map', async () => {
    // `opaque` is merchant-defined and need not be metadata at all. A merchant using it for
    // something else must not accidentally read as having stamped an identifier.
    const chg = Challenge.from({
      realm: REALM,
      method: 'atum-escrow',
      intent: 'charge',
      request,
      opaque: 'not-base64url-metadata',
      secretKey: SECRET_KEY,
    } as any) as unknown as AtumEscrowChallenge;

    await expect(requestIdOf(chg)).rejects.toThrow(/carries no 'atumIntentId' metadata/);
  });

  it('derives the request_id through the shared SDK helper, not a local copy', async () => {
    // Pins that mppx and x402 share ONE recipe. If mppx ever re-grows its own derivation, this
    // fails even though the stability assertions above would still pass.
    expect(await requestIdOf(issue('order-1'))).toBe(
      deterministicRequestId({ anchor: 'order-1', account: PAYER, prefix: 'req_mpp_' }),
    );
  });
});

/**
 * Per-chain deposit idempotency.
 *
 * The credential carries no explicit nonce: `preparePaymentRequest` derives it from
 * (request_id, depositor) through the shared sender_auth SDK, and request_id is itself derived
 * from the purchase's `intentId`. These tests pin BOTH ends of that chain on every source chain,
 * and pin that the two are actually linked — stability alone would still hold if the nonce were
 * derived from something else entirely, so the linkage assertions are what prove the single
 * shared recipe is in use.
 */
describe('deposit idempotency across source chains', () => {
  const prehashOf = (cred: { payload: { paymentRequest: any } }) =>
    JSON.parse(cred.payload.paymentRequest.sender_auth.signed_messages[0].message_prehash);
  const requestIdOfCred = (cred: { payload: { paymentRequest: any } }) =>
    cred.payload.paymentRequest.request_id;

  it('EVM: request_id and Permit2 nonce are both reproduced on rebuild, and the nonce derives from the request_id', async () => {
    const a = await buildCredential();
    const b = await buildCredential();

    expect(requestIdOfCred(a)).toBe(requestIdOfCred(b));
    expect(prehashOf(a).message.nonce).toBe(prehashOf(b).message.nonce);
    // Linkage: the nonce is the shared derivation applied to this credential's own request_id.
    expect(prehashOf(a).message.nonce).toBe(
      deterministicPermitNonce({ requestId: requestIdOfCred(a), depositor: PAYER }).toString(),
    );
  });

  it('Tron: request_id and Permit2 nonce are both reproduced on rebuild, and the nonce derives from the request_id', async () => {
    const a = await buildTronCredential();
    const b = await buildTronCredential();

    expect(requestIdOfCred(a)).toBe(requestIdOfCred(b));
    expect(prehashOf(a).message.nonce).toBe(prehashOf(b).message.nonce);
    expect(prehashOf(a).message.nonce).toBe(
      deterministicPermitNonce({ requestId: requestIdOfCred(a), depositor: TRON_PAYER }).toString(),
    );
  });

  it('Solana: request_id and replay nonce are both reproduced on rebuild, and the nonce derives from the request_id', async () => {
    // Solana matters most here. Its on-chain replay nonce is only remembered for 256-512s (the
    // authorization is valid for 128s), so the gateway's request_id dedup is the ONLY durable
    // protection against a late retry being
    // charged twice — and nothing asserted it on this chain before.
    const a = await buildSolanaCredential();
    const b = await buildSolanaCredential();

    expect(requestIdOfCred(a)).toBe(requestIdOfCred(b));
    expect(prehashOf(a).nonce).toBe(prehashOf(b).nonce);
    expect(prehashOf(a).nonce).toBe(
      deterministicSolanaNonce({ requestId: requestIdOfCred(a), depositor: SOL_PAYER }).toString(),
    );
  });

  /**
   * What a REBUILD of a Solana credential produces, pinned so a change to it is deliberate.
   *
   * The deposit nonce is stable per (request_id, depositor), but the on-chain replay window only
   * remembers it for a few minutes, so whether a rebuild is safe depends on whether it reproduces
   * the same signed authorization. Ed25519 signing is deterministic, so it does exactly when every
   * signed input is the same, and `issued_at` is the one that can differ: a merchant-stamped
   * `extra.issuedAt` pins it, the payer's own clock does not.
   */
  describe('Solana: what a rebuild signs', () => {
    const signedOf = (cred: { payload: { paymentRequest: any } }) =>
      cred.payload.paymentRequest.sender_auth.signed_messages[0];
    const solSelect = {
      network: solanaCorridor.sources[0]!.network,
      asset: solanaCorridor.sources[0]!.assets[0]!.address,
    };
    // A client whose clock reader answers `clockSeconds`, with everything else held fixed.
    const solanaCredentialAt = async (clockSeconds: number, forChallenge = solanaChallenge) => {
      const client = registerClient({
        signer: { privateKey: seedHex },
        account: SOL_PAYER,
        now,
        solanaClockReader: async () => BigInt(clockSeconds),
        trust: fixtureTrust,
      });
      return Credential.deserialize<{ paymentRequest: any }>(
        await client.createCredential({ challenge: forChallenge }),
      );
    };

    it('reproduces the identical signed authorization when the merchant stamps issuedAt', async () => {
      const stamped = {
        ...challenge,
        request: buildChargeRequest(solanaCorridor, solSelect, '10000000', {
          issuedAt: String(Math.floor(NOW / 1000) - 3),
        }),
      } as AtumEscrowChallenge;

      // Two builds with payer clocks five minutes apart: the stamped value wins over both, so the
      // signed message, and therefore the signature and the deposit it names, cannot differ. That
      // holds under the default v1 deposit request hash and with `now` held fixed; a challenge that
      // opts into a hash covering `now`-derived deadlines would need `now` pinned too.
      const a = await solanaCredentialAt(Math.floor(NOW / 1000), stamped);
      const b = await solanaCredentialAt(Math.floor(NOW / 1000) + 300, stamped);

      expect(signedOf(a).message).toBe(signedOf(b).message);
      expect(signedOf(a).signature).toBe(signedOf(b).signature);
      expect(signedOf(a).signature).toBeTruthy();
    });

    it('signs a DIFFERENT authorization on a rebuild that reads a later payer clock', async () => {
      // No merchant stamp, so issued_at comes from the payer's clock. The request_id and the nonce
      // are the same, but the program only remembers a nonce for the 256s slice it was issued in
      // and the next one, so 256 to 512s. The second build is 600s later, past the longest it can
      // remember, so it is a new authorization that could create a second deposit whatever the
      // slice alignment. The gateway's request_id dedup is what resolves it to the original payment.
      const a = await solanaCredentialAt(Math.floor(NOW / 1000));
      const b = await solanaCredentialAt(Math.floor(NOW / 1000) + 600);

      expect(requestIdOfCred(a)).toBe(requestIdOfCred(b));
      expect(prehashOf(a).nonce).toBe(prehashOf(b).nonce);
      expect(prehashOf(a).issued_at).not.toBe(prehashOf(b).issued_at);
      expect(signedOf(a).message).not.toBe(signedOf(b).message);
      expect(signedOf(a).signature).not.toBe(signedOf(b).signature);
    });
  });

  it('the three chains derive distinct request_ids for their distinct payers', async () => {
    // The account is folded into the derivation, so the same challenge id paid from different
    // source accounts must not collapse onto one payment.
    const ids = new Set([
      requestIdOfCred(await buildCredential()),
      requestIdOfCred(await buildTronCredential()),
      requestIdOfCred(await buildSolanaCredential()),
    ]);
    expect(ids.size).toBe(3);
  });
});
