/**
 * The payer refuses to sign a deposit toward roles it does not trust.
 *
 * Every role address in an atum-escrow challenge — the escrow that will hold the funds, the
 * reserver that selects the quote, the releaser that releases the escrow, and the destination's
 * fulfillment proxy — comes from the merchant, unauthenticated. A payer that signed whatever the
 * challenge named would authorize a Permit2 pull into any contract a malicious or compromised
 * merchant chose. So before signing, the client compares each role with what its trust source
 * says the trusted operator runs on that chain, and refuses on any mismatch.
 *
 * The property that matters most is that a refusal happens BEFORE the signer is touched: a
 * signature is the irreversible step, so every refusal below also asserts that the injected
 * signer's `sign` was never called.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import bs58 from 'bs58';
import { hexlify } from 'ethers';
import { Credential } from 'mppx';
import { createSenderSigner } from '@atum-labs/payment-gateway-client';
import {
  registerClient,
  AtumEscrowTrustError,
  atumGatewayTrust,
  ATUM_DEFAULT_TRUST_GATEWAYS,
  type SenderSigner,
  type TrustResolver,
  type TrustedRoles,
} from './client.js';
import { registerServer } from './server.js';
import {
  PRIVATE_KEY,
  PAYER,
  now,
  corridor,
  challenge,
  request,
  tronChallenge,
  tronRequest,
  tronCorridor,
  solanaChallenge,
  solanaRequest,
  solanaCorridor,
  SOL_PAYER,
  b58,
  okSubmitter,
  evmToTronAddress,
  fixtureTrustTable,
  attemptAgainst,
  trustFailure,
  trustTable,
  withExtra,
} from './test-helpers.js';

const BASE = corridor.sources[0]!.network;
const ARBITRUM = corridor.destination.network;
const TRON = tronCorridor.sources[0]!.network;
const SOLANA = solanaCorridor.sources[0]!.network;

const ESCROW = corridor.sources[0]!.escrow;
const RESERVER = corridor.sources[0]!.reserver;
const RELEASER = corridor.sources[0]!.releaser;
const DEST_FULFILLMENT_PROXY = corridor.fulfillmentProxy;
const SOURCE_FULFILLMENT_PROXY = fixtureTrustTable[BASE]!.fulfillmentProxy;
// An address no trust table below vouches for.
const ATTACKER = '0xBcd4042DE499D14e55001CcbB24a551F3b954096';

const attempt = attemptAgainst(fixtureTrustTable);

const paymentRequestOf = (credStr: string) =>
  Credential.deserialize<{ paymentRequest: any }>(credStr).payload.paymentRequest;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createCredential — trusted roles (EVM source)', () => {
  it('consults the trust source for both the source and the destination chain', async () => {
    const trust = trustTable(fixtureTrustTable);
    const { result } = attempt(challenge, { trust });
    await result;

    expect([...new Set(trust.mock.calls.map(([n]) => n))].sort()).toEqual([BASE, ARBITRUM].sort());
  });

  it('builds and signs the credential unchanged when every role matches', async () => {
    const { result, sign } = attempt(challenge);
    const pr = paymentRequestOf(await result);

    expect(sign).toHaveBeenCalledTimes(1);
    expect(pr.source.account).toBe(PAYER);
    expect(pr.source.asset_identifier).toBe(
      'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    );
    expect(pr.fulfillment_amount).toBe('10000000');
    expect(pr.max_source_amount).toBe('10300000');
    expect(pr.escrow_contract_address).toBe(ESCROW);
    expect(pr.quote_selector).toBe(RESERVER);
    expect(pr.fulfillment_verifier.account).toBe(RELEASER);
    expect(pr.sender_auth.message_scheme).toBe('EVM_PERMIT2');
  });

  it.each([
    ['an escrow the payer does not trust', 'escrow', 'UNTRUSTED_ESCROW', ESCROW],
    [
      'a reserver that is not the trusted quote selector',
      'reserver',
      'UNTRUSTED_RESERVER',
      RESERVER,
    ],
    [
      'a releaser that is not the trusted fulfillment verifier',
      'releaser',
      'UNTRUSTED_RELEASER',
      RELEASER,
    ],
  ] as const)('refuses %s, without signing', async (_, field, code, trusted) => {
    const { result, sign } = attempt(withExtra(challenge, { [field]: ATTACKER }));
    const err = await trustFailure(result);

    expect(err.code).toBe(code);
    expect(err.field).toBe(`extra.${field}`);
    expect(err.network).toBe(BASE);
    expect(err.expected).toBe(trusted);
    expect(err.actual).toBe(ATTACKER);
    expect(sign).not.toHaveBeenCalled();
  });

  it("checks the fulfillment proxy against the DESTINATION chain's, without signing", async () => {
    // The source chain's own proxy is a trusted contract, just on the wrong chain for this role.
    const { result, sign } = attempt(
      withExtra(challenge, { fulfillmentProxy: SOURCE_FULFILLMENT_PROXY }),
    );
    const err = await trustFailure(result);

    expect(err.code).toBe('UNTRUSTED_FULFILLMENT_PROXY');
    expect(err.field).toBe('extra.fulfillmentProxy');
    expect(err.network).toBe(ARBITRUM);
    expect(err.expected).toBe(DEST_FULFILLMENT_PROXY);
    expect(err.actual).toBe(SOURCE_FULFILLMENT_PROXY);
    expect(sign).not.toHaveBeenCalled();
  });

  it('compares EVM addresses case-insensitively: checksum casing alone never refuses', async () => {
    // EIP-55 checksum casing is presentation, not identity; the gateway and the merchant may
    // render the same address differently.
    const lower = (r: TrustedRoles): TrustedRoles => ({
      escrowContract: r.escrowContract.toLowerCase(),
      quoteSelector: r.quoteSelector.toLowerCase(),
      fulfillmentVerifierAccount: r.fulfillmentVerifierAccount.toLowerCase(),
      fulfillmentProxy: r.fulfillmentProxy.toLowerCase(),
      tokens: r.tokens.map((t) => ({ ...t, address: t.address.toLowerCase() })),
    });
    const trust = trustTable({
      [BASE]: lower(fixtureTrustTable[BASE]!),
      [ARBITRUM]: lower(fixtureTrustTable[ARBITRUM]!),
    });
    const { result, sign } = attempt(challenge, { trust });

    await expect(result).resolves.toBeTypeOf('string');
    expect(sign).toHaveBeenCalledTimes(1);
  });
});

describe('createCredential — same-chain corridor', () => {
  // When both legs are on one chain there is no second chain to ask: that chain's roles serve as
  // both the source roles and the destination's fulfillment proxy, and its one token list prices
  // both assets.
  const SAME_CHAIN_USDC = {
    symbol: 'USDC',
    address: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb',
    decimals: 6,
  };
  const sameChainTrust = () =>
    trustTable({
      [BASE]: {
        ...fixtureTrustTable[BASE]!,
        tokens: [...fixtureTrustTable[BASE]!.tokens, SAME_CHAIN_USDC],
      },
    });
  const sameChain = (fulfillmentProxy: string) =>
    withExtra(challenge, {
      destination: {
        network: BASE,
        asset: SAME_CHAIN_USDC.address,
        address: corridor.destination.account,
      },
      fulfillmentProxy,
    });

  it("builds and signs once, consulting only that chain's trust", async () => {
    const trust = sameChainTrust();
    const { result, sign } = attempt(sameChain(SOURCE_FULFILLMENT_PROXY), { trust });

    await expect(result).resolves.toBeTypeOf('string');
    expect(sign).toHaveBeenCalledTimes(1);
    expect(trust).toHaveBeenCalled();
    expect(trust.mock.calls.every(([n]) => n === BASE)).toBe(true);
  });

  it("refuses a fulfillment proxy other than that chain's trusted one, without signing", async () => {
    // The destination chain's proxy from the cross-chain fixture is trusted, but on another chain.
    const { result, sign } = attempt(sameChain(DEST_FULFILLMENT_PROXY), {
      trust: sameChainTrust(),
    });
    const err = await trustFailure(result);

    expect(err.code).toBe('UNTRUSTED_FULFILLMENT_PROXY');
    expect(err.field).toBe('extra.fulfillmentProxy');
    expect(err.network).toBe(BASE);
    expect(err.expected).toBe(SOURCE_FULFILLMENT_PROXY);
    expect(err.actual).toBe(DEST_FULFILLMENT_PROXY);
    expect(sign).not.toHaveBeenCalled();
  });
});

describe('createCredential — trust-source failures', () => {
  it('refuses CHAIN_NOT_TRUSTED, without signing, when the source chain is not served', async () => {
    // Produced by the real gateway resolver (every gateway answering 404), so the client is
    // exercised against the error a gateway-backed trust source actually raises.
    const notFound = vi.fn(async () => new Response('not found', { status: 404 }));
    const trust = atumGatewayTrust({ fetch: notFound as unknown as typeof fetch, now });
    const { result, sign } = attempt(challenge, { trust });
    const err = await trustFailure(result);

    expect(err.code).toBe('CHAIN_NOT_TRUSTED');
    expect([BASE, ARBITRUM]).toContain(err.network);
    expect(sign).not.toHaveBeenCalled();
  });

  it('refuses CHAIN_NOT_TRUSTED, without signing, when only the destination chain is not served', async () => {
    const refusal = new AtumEscrowTrustError({
      code: 'CHAIN_NOT_TRUSTED',
      network: ARBITRUM,
      message: 'operator does not serve the destination chain',
    });
    const trust = vi.fn<TrustResolver>(async (network: string) => {
      if (network === ARBITRUM) throw refusal;
      return fixtureTrustTable[network]!;
    });
    const { result, sign } = attempt(challenge, { trust });
    const err = await trustFailure(result);

    expect(err.code).toBe('CHAIN_NOT_TRUSTED');
    expect(err.network).toBe(ARBITRUM);
    expect(sign).not.toHaveBeenCalled();
  });

  it('wraps an arbitrary trust-source failure as TRUST_SOURCE_UNAVAILABLE, keeping the cause', async () => {
    // A third-party resolver may fail with any error; the payer still needs one typed refusal
    // to branch on, and the original error for diagnosis.
    const boom = new Error('resolver exploded');
    const trust = vi.fn<TrustResolver>(async (network: string) => {
      if (network === BASE) throw boom;
      return fixtureTrustTable[network]!;
    });
    const { result, sign } = attempt(challenge, { trust });
    const err = await trustFailure(result);

    expect(err.code).toBe('TRUST_SOURCE_UNAVAILABLE');
    expect(err.network).toBe(BASE);
    expect(err.cause).toBe(boom);
    expect(sign).not.toHaveBeenCalled();
  });

  it('wraps a non-Error rejection from the destination lookup as TRUST_SOURCE_UNAVAILABLE', async () => {
    const thrown = 'not an Error';
    const trust = vi.fn<TrustResolver>(async (network: string) => {
      if (network === ARBITRUM) throw thrown;
      return fixtureTrustTable[network]!;
    });
    const { result, sign } = attempt(challenge, { trust });
    const err = await trustFailure(result);

    expect(err.code).toBe('TRUST_SOURCE_UNAVAILABLE');
    expect(err.network).toBe(ARBITRUM);
    expect(err.cause).toBe(thrown);
    expect(sign).not.toHaveBeenCalled();
  });

  it('passes a typed trust-source refusal through unchanged, without signing', async () => {
    // A resolver that already speaks the typed vocabulary has said exactly what went wrong;
    // re-wrapping it would bury that verdict under a generic one.
    const refusal = new AtumEscrowTrustError({
      code: 'TRUST_SOURCE_UNAVAILABLE',
      network: BASE,
      message: 'custom trust source is offline',
    });
    const trust = vi.fn<TrustResolver>(async (network: string) => {
      if (network === BASE) throw refusal;
      return fixtureTrustTable[network]!;
    });
    const { result, sign } = attempt(challenge, { trust });
    const err = await trustFailure(result);

    expect(err).toBe(refusal);
    expect(sign).not.toHaveBeenCalled();
  });
});

// ── Tron source ──────────────────────────────────────────────────────────────
// A Tron address is 0x41 followed by 20 key-derived bytes, base58check-encoded. The same address
// can legitimately arrive base58 (`T…`), 0x-prefixed 20-byte hex, or 41-prefixed 21-byte hex, so
// the comparison must decode before comparing.

/** The 0x-prefixed 20-byte hex form of a base58check Tron address. */
function tronHex(base58: string): string {
  const raw = bs58.decode(base58);
  expect(raw.length).toBe(25);
  expect(raw[0]).toBe(0x41);
  const hex = hexlify(raw.slice(1, 21));
  // Pins that the pair really is one address, by the fixture's own encoder.
  expect(evmToTronAddress(hex)).toBe(base58);
  return hex;
}

/** The 41-prefixed 21-byte hex form (no 0x) of a base58check Tron address. */
const tron41 = (base58: string): string => `41${tronHex(base58).slice(2)}`;

const TRON_ESCROW = tronCorridor.sources[0]!.escrow;
const TRON_RESERVER = tronCorridor.sources[0]!.reserver;
const TRON_RELEASER = tronCorridor.sources[0]!.releaser;
// A well-formed Tron address no trust table below vouches for, derived from an EVM-form address.
const TRON_STRANGER = evmToTronAddress('0x000000000000000000000000000000000000bEEF');

const tronRoles = fixtureTrustTable[TRON]!;
const tronTrust = (roles: Partial<TrustedRoles>) =>
  trustTable({ [TRON]: { ...tronRoles, ...roles }, [ARBITRUM]: fixtureTrustTable[ARBITRUM]! });

describe('createCredential — trusted roles (Tron source)', () => {
  it('builds and signs the fixture Tron credential under the fixture trust', async () => {
    const { result, sign } = attempt(tronChallenge);
    await expect(result).resolves.toBeTypeOf('string');
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('accepts trusted roles given in 0x hex when the challenge uses base58', async () => {
    const trust = tronTrust({
      escrowContract: tronHex(TRON_ESCROW),
      quoteSelector: tronHex(TRON_RESERVER),
      fulfillmentVerifierAccount: tronHex(TRON_RELEASER),
    });
    const { result, sign } = attempt(tronChallenge, { trust });

    await expect(result).resolves.toBeTypeOf('string');
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('accepts trusted roles given in 41-prefixed hex when the challenge uses base58', async () => {
    const trust = tronTrust({
      escrowContract: tron41(TRON_ESCROW),
      quoteSelector: tron41(TRON_RESERVER),
      fulfillmentVerifierAccount: tron41(TRON_RELEASER),
    });
    const { result, sign } = attempt(tronChallenge, { trust });

    await expect(result).resolves.toBeTypeOf('string');
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('accepts trusted roles given in base58 when the challenge uses hex', async () => {
    const hexChallenge = withExtra(tronChallenge, {
      escrow: tronHex(TRON_ESCROW),
      reserver: tronHex(TRON_RESERVER),
      releaser: tron41(TRON_RELEASER),
    });
    const { result, sign } = attempt(hexChallenge);

    await expect(result).resolves.toBeTypeOf('string');
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('still refuses a genuinely different Tron escrow given in hex, without signing', async () => {
    // Discriminator for the encoding-tolerance cases above: without it, a client that skipped
    // the Tron comparison entirely would pass them.
    const trust = tronTrust({ escrowContract: tronHex(TRON_STRANGER) });
    const { result, sign } = attempt(tronChallenge, { trust });
    const err = await trustFailure(result);

    expect(err.code).toBe('UNTRUSTED_ESCROW');
    expect(err.field).toBe('extra.escrow');
    expect(err.network).toBe(TRON);
    expect(err.expected).toBe(tronHex(TRON_STRANGER));
    expect(err.actual).toBe(TRON_ESCROW);
    expect(sign).not.toHaveBeenCalled();
  });

  it('still refuses a genuinely different Tron reserver, without signing', async () => {
    const { result, sign } = attempt(withExtra(tronChallenge, { reserver: TRON_STRANGER }));
    const err = await trustFailure(result);

    expect(err.code).toBe('UNTRUSTED_RESERVER');
    expect(err.field).toBe('extra.reserver');
    expect(err.network).toBe(TRON);
    expect(err.expected).toBe(TRON_RESERVER);
    expect(err.actual).toBe(TRON_STRANGER);
    expect(sign).not.toHaveBeenCalled();
  });

  it('still refuses a genuinely different Tron releaser given in hex, without signing', async () => {
    const stranger = tronHex(TRON_STRANGER);
    const { result, sign } = attempt(withExtra(tronChallenge, { releaser: stranger }));
    const err = await trustFailure(result);

    expect(err.code).toBe('UNTRUSTED_RELEASER');
    expect(err.field).toBe('extra.releaser');
    expect(err.network).toBe(TRON);
    expect(err.expected).toBe(TRON_RELEASER);
    expect(err.actual).toBe(stranger);
    expect(sign).not.toHaveBeenCalled();
  });
});

// ── Solana source ────────────────────────────────────────────────────────────
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * The same Solana address with the case of one letter flipped. Base58 is case-sensitive, so this
 * is a different, well-formed 32-byte account that a case-folding comparison would wrongly accept.
 * The result is checked to still decode to 32 bytes, so a refusal of it can only be due to case,
 * never to a malformed key.
 */
function caseFlipped(address: string): string {
  for (let i = address.length - 1; i >= 0; i--) {
    const c = address[i]!;
    const f = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
    if (f === c || !BASE58_ALPHABET.includes(f)) continue;
    const flipped = address.slice(0, i) + f + address.slice(i + 1);
    if (bs58.decode(flipped).length !== 32) continue;
    expect(flipped).not.toBe(address);
    expect(flipped.toLowerCase()).toBe(address.toLowerCase());
    return flipped;
  }
  throw new Error(`no case-flippable base58 letter in ${address}`);
}

const SOLANA_ESCROW = solanaCorridor.sources[0]!.escrow;
const SOLANA_RESERVER = solanaCorridor.sources[0]!.reserver;
const SOLANA_RELEASER = solanaCorridor.sources[0]!.releaser;

describe('createCredential — trusted roles (Solana source)', () => {
  it('builds and signs the payment when every role matches', async () => {
    const { result, sign } = attempt(solanaChallenge);
    const pr = paymentRequestOf(await result);

    expect(pr.sender_auth.message_scheme).toBe('SOLANA');
    expect(pr.escrow_contract_address).toBe(SOLANA_ESCROW);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['escrow', 'UNTRUSTED_ESCROW', SOLANA_ESCROW],
    ['reserver', 'UNTRUSTED_RESERVER', SOLANA_RESERVER],
    ['releaser', 'UNTRUSTED_RELEASER', SOLANA_RELEASER],
  ] as const)(
    'refuses a %s differing from the trusted one only in letter case, without signing',
    async (field, code, trusted) => {
      const nearMiss = caseFlipped(trusted);
      const { result, sign } = attempt(withExtra(solanaChallenge, { [field]: nearMiss }));
      const err = await trustFailure(result);

      expect(err.code).toBe(code);
      expect(err.field).toBe(`extra.${field}`);
      expect(err.network).toBe(SOLANA);
      expect(err.expected).toBe(trusted);
      expect(err.actual).toBe(nearMiss);
      expect(sign).not.toHaveBeenCalled();
    },
  );
});

describe('createCredential — Solana destination fulfillment proxy is compared case-sensitively', () => {
  const SOLANA_FULFILLMENT_PROXY = b58(11);
  const SOLANA_MINT = solanaCorridor.sources[0]!.assets[0]!.address;
  const trust = () =>
    trustTable({
      [BASE]: fixtureTrustTable[BASE]!,
      [SOLANA]: { ...fixtureTrustTable[SOLANA]!, fulfillmentProxy: SOLANA_FULFILLMENT_PROXY },
    });
  const toSolana = (fulfillmentProxy: string) =>
    withExtra(challenge, {
      destination: { network: SOLANA, asset: SOLANA_MINT, address: SOL_PAYER },
      fulfillmentProxy,
    });

  it('builds and signs an EVM-to-Solana payment naming the trusted proxy', async () => {
    // Discriminator for the refusal below: the corridor itself is payable.
    const { result, sign } = attempt(toSolana(SOLANA_FULFILLMENT_PROXY), { trust: trust() });
    await expect(result).resolves.toBeTypeOf('string');
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('refuses a proxy differing from the trusted one only in letter case, without signing', async () => {
    const nearMiss = caseFlipped(SOLANA_FULFILLMENT_PROXY);
    const { result, sign } = attempt(toSolana(nearMiss), { trust: trust() });
    const err = await trustFailure(result);

    expect(err.code).toBe('UNTRUSTED_FULFILLMENT_PROXY');
    expect(err.field).toBe('extra.fulfillmentProxy');
    expect(err.network).toBe(SOLANA);
    expect(err.expected).toBe(SOLANA_FULFILLMENT_PROXY);
    expect(err.actual).toBe(nearMiss);
    expect(sign).not.toHaveBeenCalled();
  });
});

// ── No trust option: the Atum gateways are the default trust source ──────────
describe('createCredential — default trust source', () => {
  function defaultsBody(network: string, roles: TrustedRoles) {
    return {
      chain_id: network,
      quote_selector: roles.quoteSelector,
      escrow_contract: roles.escrowContract,
      fulfillment_proxy: roles.fulfillmentProxy,
      fulfillment_verifier: {
        account: roles.fulfillmentVerifierAccount,
        endpoint: 'https://v.example',
      },
      tokens: roles.tokens,
    };
  }

  it('asks every default gateway for /v1/defaults and refuses an escrow its answer does not vouch for', async () => {
    // The last default gateway serves the chains (with a different escrow) and every other one
    // answers 404, so every gateway must be asked before a usable answer exists — whatever order
    // the resolver asks them in.
    const lastGateway = ATUM_DEFAULT_TRUST_GATEWAYS[ATUM_DEFAULT_TRUST_GATEWAYS.length - 1]!;
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request): Promise<Response> => {
        const href =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        requested.push(href);
        const url = new URL(href);
        if (url.origin !== lastGateway) return new Response('not found', { status: 404 });
        const chain = url.searchParams.get('chain_id');
        if (chain === BASE) {
          return Response.json(
            defaultsBody(BASE, { ...fixtureTrustTable[BASE]!, escrowContract: ATTACKER }),
          );
        }
        if (chain === ARBITRUM)
          return Response.json(defaultsBody(ARBITRUM, fixtureTrustTable[ARBITRUM]!));
        return new Response('not found', { status: 404 });
      }),
    );
    const real = createSenderSigner(BASE, { privateKey: PRIVATE_KEY, pinnedAddress: PAYER });
    const sign = vi.fn<SenderSigner['sign']>((message) => real.sign(message));
    const client = registerClient({ signer: { sign }, account: PAYER, now });

    const err = await trustFailure(client.createCredential({ challenge }));

    expect(ATUM_DEFAULT_TRUST_GATEWAYS.length).toBeGreaterThan(0);
    for (const gateway of ATUM_DEFAULT_TRUST_GATEWAYS) {
      expect(requested).toContain(`${gateway}/v1/defaults?chain_id=${encodeURIComponent(BASE)}`);
    }
    expect(err.code).toBe('UNTRUSTED_ESCROW');
    expect(err.network).toBe(BASE);
    expect(err.expected).toBe(ATTACKER);
    expect(err.actual).toBe(ESCROW);
    expect(sign).not.toHaveBeenCalled();
  });
});

// ── A trusted credential still verifies end to end ───────────────────────────
describe('createCredential — a trusted credential verifies through the server', () => {
  it.each([
    ['EVM', challenge, request],
    ['Tron', tronChallenge, tronRequest],
    ['Solana', solanaChallenge, solanaRequest],
  ] as const)('%s', async (_chain, chg, merchantRequest) => {
    const trust = trustTable(fixtureTrustTable);
    const { result, sign } = attempt(chg, { trust });
    const cred = Credential.deserialize<{ paymentRequest: any }>(await result);

    expect(trust).toHaveBeenCalled();
    expect(sign).toHaveBeenCalledTimes(1);
    const server = registerServer({ submitter: okSubmitter, now });
    const receipt = await server.verify({ credential: cred as any, request: merchantRequest });
    expect(receipt.status).toBe('success');
    expect(receipt.method).toBe('atum-escrow');
    expect(receipt.reference).toBe('0xdestination');
  });
});
