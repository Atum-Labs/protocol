/**
 * The payer refuses to sign a deposit toward roles it does not trust.
 *
 * Every role address in a 402 — the escrow that will hold the funds, the `payTo`, the reserver
 * that selects the quote, the releaser that releases the escrow, and the destination's fulfillment
 * proxy — comes from the merchant, unauthenticated. A payer that signed whatever the 402 named
 * would authorize a Permit2 pull into any contract a malicious or compromised merchant chose. So
 * before signing, the client compares each role with what its trust source says the trusted
 * operator runs on that chain, and refuses on any mismatch.
 *
 * The property that matters most is that a refusal happens BEFORE the signer is touched: a
 * signature is the irreversible step, so every refusal below also asserts that `signTypedData`
 * was never called.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ethers } from 'ethers';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type { Network, PaymentRequirements } from '@x402/core/types';
import { deterministicFullRequestId } from '@atum-labs/payment-request-sender-auth';
import {
  AtumEscrowClientScheme,
  AtumEscrowTrustError,
  atumGatewayTrust,
  type EscrowSigner,
  type SolanaSigner,
  type TrustResolver,
  type TrustedRoles,
} from './index';
import { PAYMENT_IDENTIFIER } from '../payment-identifier';

// The page every fixture requirement is published for, hashed as the request_id anchor folds it in.
const PAID_PAGE_HASH = ethers.keccak256(ethers.toUtf8Bytes('GET /paid')).slice(2);

// Well-known anvil account #0 — a throwaway dev key, safe to commit.
const wallet = new ethers.Wallet(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const NOW = () => Date.parse('2026-07-08T12:00:00Z');
const ANCHOR = 'pay_order_test_0001';
const named = { extensions: { [PAYMENT_IDENTIFIER]: { info: { required: true, id: ANCHOR } } } };

const SOURCE: Network = 'eip155:8453';
const DEST: Network = 'eip155:42161';
const SOURCE_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ESCROW = '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33';
const RESERVER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const RELEASER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const DEST_FULFILLMENT_PROXY = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
// The source chain runs its own fulfillment proxy, deliberately different from the destination's,
// so a client that checked the 402's proxy against the SOURCE chain would refuse the happy path.
const SOURCE_FULFILLMENT_PROXY = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
// An address no trust table below vouches for.
const ATTACKER = '0xBcd4042DE499D14e55001CcbB24a551F3b954096';

function requirementWith(
  overrides: { payTo?: string; atum?: Record<string, unknown>; network?: Network } = {},
): PaymentRequirements {
  return {
    scheme: 'atum-escrow',
    network: overrides.network ?? SOURCE,
    asset: SOURCE_ASSET,
    amount: '10300000',
    payTo: overrides.payTo ?? ESCROW,
    maxTimeoutSeconds: 60,
    extra: {
      atumResource: 'GET /paid',
      atum: {
        destination: {
          network: DEST,
          asset: '0x52e52f345139e57b87d288c9ea794bb3fbe591c3',
          address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        },
        fulfillmentAmount: '10000000',
        escrow: ESCROW,
        fulfillmentProxy: DEST_FULFILLMENT_PROXY,
        reserver: RESERVER,
        releaser: RELEASER,
        fulfillmentVerifierEndpoint: 'http://veri-fill:8088',
        quoteDeadlineSeconds: 20,
        fulfillmentDeadlineSeconds: 300,
        ...overrides.atum,
      },
    },
  };
}

// The tokens each chain's trust source vouches for: the ones this file's corridors move.
const SOURCE_USDC = { symbol: 'USDC', address: SOURCE_ASSET, decimals: 6 };
const DEST_USDC = {
  symbol: 'USDC',
  address: '0x52e52f345139e57b87d288c9ea794bb3fbe591c3',
  decimals: 6,
};

const sourceRoles: TrustedRoles = {
  escrowContract: ESCROW,
  quoteSelector: RESERVER,
  fulfillmentVerifierAccount: RELEASER,
  fulfillmentProxy: SOURCE_FULFILLMENT_PROXY,
  tokens: [SOURCE_USDC],
};
const destRoles: TrustedRoles = {
  escrowContract: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  quoteSelector: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  fulfillmentVerifierAccount: '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955',
  fulfillmentProxy: DEST_FULFILLMENT_PROXY,
  tokens: [DEST_USDC],
};

/** A trust source answering from a fixed per-network table; an unknown network is a test bug. */
function trustTable(table: Record<string, TrustedRoles>) {
  return vi.fn<TrustResolver>(async (network: string) => {
    const roles = table[network];
    if (roles === undefined) throw new Error(`test trust table has no entry for ${network}`);
    return roles;
  });
}

/** A signer that signs with the anvil wallet but records whether it was ever asked to. */
function spyingSigner(base: ethers.Wallet = wallet) {
  const signTypedData = vi.fn<EscrowSigner['signTypedData']>((domain, types, message) =>
    base.signTypedData(domain, types, message),
  );
  const signer: EscrowSigner = { getAddress: async () => base.address, signTypedData };
  return { signer, signTypedData };
}

/** Await a rejection and hand back the error, failing the test if the promise resolved. */
async function trustFailure(p: Promise<unknown>): Promise<AtumEscrowTrustError> {
  const err = await p.then(
    () => {
      throw new Error('expected the payment to be refused, but it was built');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AtumEscrowTrustError);
  return err as AtumEscrowTrustError;
}

const prOf = (r: { payload: unknown }) =>
  (r.payload as { paymentRequest: Record<string, any> }).paymentRequest;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AtumEscrowClientScheme — trusted roles (EVM source)', () => {
  it('consults the trust source for both the source and the destination chain, once each', async () => {
    const trust = trustTable({ [SOURCE]: sourceRoles, [DEST]: destRoles });
    const { signer } = spyingSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust });

    await scheme.createPaymentPayload(2, requirementWith(), named);

    expect(trust).toHaveBeenCalledTimes(2);
    expect(trust.mock.calls.map(([n]) => n).sort()).toEqual([SOURCE, DEST].sort());
  });

  it('consults it for the one chain when source and destination are the same', async () => {
    const trust = trustTable({
      [SOURCE]: {
        ...sourceRoles,
        fulfillmentProxy: DEST_FULFILLMENT_PROXY,
        tokens: [
          SOURCE_USDC,
          { symbol: 'USDC', address: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', decimals: 6 },
        ],
      },
    });
    const { signer } = spyingSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust });
    const sameChain = requirementWith({
      atum: {
        destination: {
          network: SOURCE,
          asset: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb',
          address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        },
      },
    });

    await scheme.createPaymentPayload(2, sameChain, named);

    expect(trust.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(trust.mock.calls.every(([n]) => n === SOURCE)).toBe(true);
  });

  it('signs on a non Solana source even when its roles carry a text message scheme', async () => {
    const trust = trustTable({
      [SOURCE]: { ...sourceRoles, svmMessageScheme: 'escrow-text-v1' },
      [DEST]: destRoles,
    });
    const { signer, signTypedData } = spyingSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust });

    await scheme.createPaymentPayload(2, requirementWith(), named);

    expect(signTypedData).toHaveBeenCalledTimes(1);
  });

  it('builds and signs the payment unchanged when every role matches', async () => {
    const trust = trustTable({ [SOURCE]: sourceRoles, [DEST]: destRoles });
    const { signer, signTypedData } = spyingSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust });

    const result = await scheme.createPaymentPayload(2, requirementWith(), named);
    const pr = prOf(result);

    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(result.x402Version).toBe(2);
    expect(pr.request_id).toBe(
      deterministicFullRequestId({
        anchor: `${ANCHOR}:${PAID_PAGE_HASH}`,
        account: wallet.address,
        prefix: 'req_x402_',
      }),
    );
    expect(pr.source.account).toBe(wallet.address);
    expect(pr.source.asset_identifier).toBe(`eip155:8453/erc20:${SOURCE_ASSET}`);
    expect(pr.destination[0].asset_identifier).toBe(
      'eip155:42161/erc20:0x52e52f345139e57b87d288c9ea794bb3fbe591c3',
    );
    expect(pr.destination[0].account).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    expect(pr.fulfillment_amount).toBe('10000000');
    expect(pr.max_source_amount).toBe('10300000');
    expect(pr.escrow_contract_address).toBe(ESCROW);
    expect(pr.quote_selector).toBe(RESERVER);
    expect(pr.fulfillment_verifier.account).toBe(RELEASER);
    expect(pr.sender_auth.message_scheme).toBe('EVM_PERMIT2');

    const signed = pr.sender_auth.signed_messages[0];
    const { domain, types, message } = JSON.parse(signed.message_prehash);
    expect(ethers.verifyTypedData(domain, types, message, signed.signature)).toBe(wallet.address);
  });

  it('refuses an escrow the payer does not trust, without signing', async () => {
    const trust = trustTable({ [SOURCE]: sourceRoles, [DEST]: destRoles });
    const { signer, signTypedData } = spyingSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust });

    const err = await trustFailure(
      scheme.createPaymentPayload(2, requirementWith({ atum: { escrow: ATTACKER } }), named),
    );

    expect(err.code).toBe('UNTRUSTED_ESCROW');
    expect(err.network).toBe(SOURCE);
    expect(err.field).toMatch(/escrow/i);
    expect(err.expected).toBe(ESCROW);
    expect(err.actual).toBe(ATTACKER);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('refuses a payTo that is not the trusted escrow, even when extra.atum.escrow is trusted', async () => {
    // payTo is what an x402 wallet UI shows as the recipient; a 402 that names the trusted escrow
    // inside extra.atum while pointing payTo elsewhere is a mismatch, not a cosmetic detail.
    const trust = trustTable({ [SOURCE]: sourceRoles, [DEST]: destRoles });
    const { signer, signTypedData } = spyingSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust });

    const err = await trustFailure(
      scheme.createPaymentPayload(2, requirementWith({ payTo: ATTACKER }), named),
    );

    expect(err.code).toBe('UNTRUSTED_PAY_TO');
    expect(err.network).toBe(SOURCE);
    expect(err.field).toMatch(/payTo/i);
    expect(err.expected).toBe(ESCROW);
    expect(err.actual).toBe(ATTACKER);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('refuses a reserver that is not the trusted quote selector, without signing', async () => {
    const trust = trustTable({ [SOURCE]: sourceRoles, [DEST]: destRoles });
    const { signer, signTypedData } = spyingSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust });

    const err = await trustFailure(
      scheme.createPaymentPayload(2, requirementWith({ atum: { reserver: ATTACKER } }), named),
    );

    expect(err.code).toBe('UNTRUSTED_RESERVER');
    expect(err.network).toBe(SOURCE);
    expect(err.field).toMatch(/reserver/i);
    expect(err.expected).toBe(RESERVER);
    expect(err.actual).toBe(ATTACKER);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('refuses a releaser that is not the trusted fulfillment verifier, without signing', async () => {
    const trust = trustTable({ [SOURCE]: sourceRoles, [DEST]: destRoles });
    const { signer, signTypedData } = spyingSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust });

    const err = await trustFailure(
      scheme.createPaymentPayload(2, requirementWith({ atum: { releaser: ATTACKER } }), named),
    );

    expect(err.code).toBe('UNTRUSTED_RELEASER');
    expect(err.network).toBe(SOURCE);
    expect(err.field).toMatch(/releaser/i);
    expect(err.expected).toBe(RELEASER);
    expect(err.actual).toBe(ATTACKER);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it("checks the fulfillment proxy against the DESTINATION chain's, without signing", async () => {
    const trust = trustTable({ [SOURCE]: sourceRoles, [DEST]: destRoles });
    const { signer, signTypedData } = spyingSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust });

    // The source chain's own proxy is a trusted contract, just on the wrong chain for this role.
    const err = await trustFailure(
      scheme.createPaymentPayload(
        2,
        requirementWith({ atum: { fulfillmentProxy: SOURCE_FULFILLMENT_PROXY } }),
        named,
      ),
    );

    expect(err.code).toBe('UNTRUSTED_FULFILLMENT_PROXY');
    expect(err.network).toBe(DEST);
    expect(err.field).toMatch(/fulfillmentProxy/i);
    expect(err.expected).toBe(DEST_FULFILLMENT_PROXY);
    expect(err.actual).toBe(SOURCE_FULFILLMENT_PROXY);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('refuses when the trust source does not serve the chain, without signing', async () => {
    // A CHAIN_NOT_TRUSTED produced by the real gateway resolver (every gateway answering 404),
    // so the client is exercised against the error a gateway-backed trust source actually raises.
    const notFound = vi.fn(async () => new Response('not found', { status: 404 }));
    const trust = atumGatewayTrust({ fetch: notFound as unknown as typeof fetch, now: NOW });
    const { signer, signTypedData } = spyingSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust });

    const err = await trustFailure(scheme.createPaymentPayload(2, requirementWith(), named));

    expect(err.code).toBe('CHAIN_NOT_TRUSTED');
    expect([SOURCE, DEST]).toContain(err.network);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('wraps an arbitrary trust-source failure as TRUST_SOURCE_UNAVAILABLE, keeping the cause', async () => {
    // A third-party resolver may fail with any error; the payer still needs one typed refusal
    // to branch on, and the original error for diagnosis.
    const boom = new Error('resolver exploded');
    const trust = vi.fn<TrustResolver>(async (network: string) => {
      if (network === SOURCE) throw boom;
      return destRoles;
    });
    const { signer, signTypedData } = spyingSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust });

    const err = await trustFailure(scheme.createPaymentPayload(2, requirementWith(), named));

    expect(err.code).toBe('TRUST_SOURCE_UNAVAILABLE');
    expect(err.network).toBe(SOURCE);
    expect(err.cause).toBe(boom);
    expect(signTypedData).not.toHaveBeenCalled();
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
    const trust = trustTable({ [SOURCE]: lower(sourceRoles), [DEST]: lower(destRoles) });
    const { signer, signTypedData } = spyingSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust });

    await expect(scheme.createPaymentPayload(2, requirementWith(), named)).resolves.toBeDefined();
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });

  it('passes a typed trust-source refusal through unchanged, without signing', async () => {
    // A resolver that already speaks the typed vocabulary has said exactly what went wrong;
    // re-wrapping it would bury that verdict under a generic one.
    const refusal = new AtumEscrowTrustError({
      code: 'TRUST_SOURCE_UNAVAILABLE',
      network: SOURCE,
      message: 'custom trust source is offline',
    });
    const trust = vi.fn<TrustResolver>(async (network: string) => {
      if (network === SOURCE) throw refusal;
      return destRoles;
    });
    const { signer, signTypedData } = spyingSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust });

    const err = await trustFailure(scheme.createPaymentPayload(2, requirementWith(), named));

    expect(err).toBe(refusal);
    expect(err.code).toBe('TRUST_SOURCE_UNAVAILABLE');
    expect(signTypedData).not.toHaveBeenCalled();
  });
});

describe('AtumEscrowClientScheme — unsupported networks are refused before any trust lookup', () => {
  // A network the package cannot pay on is refused on its own terms: asking the trust source
  // first would spend a gateway round trip on a payment that can never be built, and could
  // surface a misleading trust verdict in place of the real reason.
  const UNSUPPORTED: Network[] = ['bip122:000000000019d6689c085ae165831e93', 'cosmos:cosmoshub-4'];

  for (const network of UNSUPPORTED) {
    it(`refuses a ${network} source as unsupported, without consulting trust or signing`, async () => {
      const trust = trustTable({ [SOURCE]: sourceRoles, [DEST]: destRoles });
      const { signer, signTypedData } = spyingSigner();
      const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust });

      await expect(
        scheme.createPaymentPayload(2, requirementWith({ network }), named),
      ).rejects.toThrow(/unsupported/);

      expect(trust).not.toHaveBeenCalled();
      expect(signTypedData).not.toHaveBeenCalled();
    });

    it(`refuses a ${network} destination as unsupported, without consulting trust or signing`, async () => {
      const trust = trustTable({ [SOURCE]: sourceRoles, [DEST]: destRoles });
      const { signer, signTypedData } = spyingSigner();
      const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust });
      const toUnsupported = requirementWith({
        atum: {
          destination: {
            network,
            asset: '0x52e52f345139e57b87d288c9ea794bb3fbe591c3',
            address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          },
        },
      });

      await expect(scheme.createPaymentPayload(2, toUnsupported, named)).rejects.toThrow(
        /unsupported/,
      );

      expect(trust).not.toHaveBeenCalled();
      expect(signTypedData).not.toHaveBeenCalled();
    });
  }
});

// ── Tron source ──────────────────────────────────────────────────────────────
// The same base58 fixture as the client's Tron corridor tests. A Tron address is 0x41 followed by
// the 20 key-derived bytes, base58check-encoded; the client signs roles in the 0x-prefixed 20-byte
// hex form, so one role can legitimately arrive in either encoding.
const TRON: Network = 'tron:mainnet';
const TRON_TOKEN = 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs';
const TRON_ESCROW = 'TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m';
const TRON_RESERVER = 'TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp';
const TRON_RELEASER = 'TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N';
const TRON_STRANGER = 'TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4py';
const TRON_USDT = { symbol: 'USDT', address: TRON_TOKEN, decimals: 6 };

/** The 0x-prefixed 20-byte hex form of a base58check Tron address. */
function tronHex(base58: string): string {
  const raw = bs58.decode(base58);
  expect(raw.length).toBe(25);
  expect(raw[0]).toBe(0x41);
  return ethers.hexlify(raw.slice(1, 21));
}

function tronRequirement(atum: Record<string, unknown> = {}): PaymentRequirements {
  return {
    scheme: 'atum-escrow',
    network: TRON,
    asset: TRON_TOKEN,
    amount: '10300000',
    payTo: TRON_ESCROW,
    maxTimeoutSeconds: 60,
    extra: {
      atumResource: 'GET /paid',
      atum: {
        destination: {
          network: DEST,
          asset: '0x52e52f345139e57b87d288c9ea794bb3fbe591c3',
          address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        },
        fulfillmentAmount: '10000000',
        escrow: TRON_ESCROW,
        fulfillmentProxy: DEST_FULFILLMENT_PROXY,
        reserver: TRON_RESERVER,
        releaser: TRON_RELEASER,
        fulfillmentVerifierEndpoint: 'http://veri-fill:8088',
        quoteDeadlineSeconds: 20,
        fulfillmentDeadlineSeconds: 300,
        ...atum,
      },
    },
  };
}

describe('AtumEscrowClientScheme — trusted roles (Tron source)', () => {
  it('accepts a trusted reserver/releaser given in hex when the 402 uses base58', async () => {
    const trust = trustTable({
      [TRON]: {
        escrowContract: TRON_ESCROW,
        quoteSelector: tronHex(TRON_RESERVER),
        fulfillmentVerifierAccount: tronHex(TRON_RELEASER),
        fulfillmentProxy: tronHex(TRON_STRANGER),
        tokens: [TRON_USDT],
      },
      [DEST]: destRoles,
    });
    const { signer, signTypedData } = spyingSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust });

    await expect(scheme.createPaymentPayload(2, tronRequirement(), named)).resolves.toBeDefined();
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });

  it('accepts a trusted reserver/releaser given in base58 when the 402 uses hex', async () => {
    const trust = trustTable({
      [TRON]: {
        escrowContract: TRON_ESCROW,
        quoteSelector: TRON_RESERVER,
        fulfillmentVerifierAccount: TRON_RELEASER,
        fulfillmentProxy: TRON_STRANGER,
        tokens: [TRON_USDT],
      },
      [DEST]: destRoles,
    });
    const { signer, signTypedData } = spyingSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust });

    await expect(
      scheme.createPaymentPayload(
        2,
        tronRequirement({ reserver: tronHex(TRON_RESERVER), releaser: tronHex(TRON_RELEASER) }),
        named,
      ),
    ).resolves.toBeDefined();
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });

  it('still refuses a genuinely different Tron reserver, without signing', async () => {
    // Discriminator for the two encoding-tolerance cases above: without it, a client that skipped
    // the Tron comparison entirely would pass them.
    const trust = trustTable({
      [TRON]: {
        escrowContract: TRON_ESCROW,
        quoteSelector: tronHex(TRON_STRANGER),
        fulfillmentVerifierAccount: TRON_RELEASER,
        fulfillmentProxy: TRON_STRANGER,
        tokens: [TRON_USDT],
      },
      [DEST]: destRoles,
    });
    const { signer, signTypedData } = spyingSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust });

    const err = await trustFailure(scheme.createPaymentPayload(2, tronRequirement(), named));
    expect(err.code).toBe('UNTRUSTED_RESERVER');
    expect(err.network).toBe(TRON);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it('accepts a trusted escrow given in hex when the 402 names it in base58', async () => {
    const trust = trustTable({
      [TRON]: {
        escrowContract: tronHex(TRON_ESCROW),
        quoteSelector: TRON_RESERVER,
        fulfillmentVerifierAccount: TRON_RELEASER,
        fulfillmentProxy: TRON_STRANGER,
        tokens: [TRON_USDT],
      },
      [DEST]: destRoles,
    });
    const { signer, signTypedData } = spyingSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust });

    await expect(scheme.createPaymentPayload(2, tronRequirement(), named)).resolves.toBeDefined();
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });

  it('accepts a trusted escrow given in base58 when the 402 names it (and payTo) in hex', async () => {
    const trust = trustTable({
      [TRON]: {
        escrowContract: TRON_ESCROW,
        quoteSelector: TRON_RESERVER,
        fulfillmentVerifierAccount: TRON_RELEASER,
        fulfillmentProxy: TRON_STRANGER,
        tokens: [TRON_USDT],
      },
      [DEST]: destRoles,
    });
    const { signer, signTypedData } = spyingSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust });
    const hexEscrow = {
      ...tronRequirement({ escrow: tronHex(TRON_ESCROW) }),
      payTo: tronHex(TRON_ESCROW),
    };

    await expect(scheme.createPaymentPayload(2, hexEscrow, named)).resolves.toBeDefined();
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });

  it('still refuses a genuinely different Tron escrow, without signing', async () => {
    // Discriminator for the escrow encoding-tolerance cases above.
    const trust = trustTable({
      [TRON]: {
        escrowContract: tronHex(TRON_STRANGER),
        quoteSelector: TRON_RESERVER,
        fulfillmentVerifierAccount: TRON_RELEASER,
        fulfillmentProxy: TRON_STRANGER,
        tokens: [TRON_USDT],
      },
      [DEST]: destRoles,
    });
    const { signer, signTypedData } = spyingSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust });

    const err = await trustFailure(scheme.createPaymentPayload(2, tronRequirement(), named));
    expect(err.code).toBe('UNTRUSTED_ESCROW');
    expect(err.network).toBe(TRON);
    expect(signTypedData).not.toHaveBeenCalled();
  });
});

// ── Solana source ────────────────────────────────────────────────────────────
// The same base58 fixture and deterministic Ed25519 payer as the client's Solana corridor tests.
const SOLANA: Network = 'solana:localnet';
const SOLANA_MINT = 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8';
const SOLANA_ESCROW = '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR';
const SOLANA_RESERVER = 'GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq';
const SOLANA_RELEASER = 'LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY';
const solKeypair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));

/** An Ed25519 payer that records whether it was ever asked to sign. */
function spyingSolanaSigner() {
  const sign = vi.fn<SolanaSigner['sign']>(async (message: Uint8Array) =>
    nacl.sign.detached(message, solKeypair.secretKey),
  );
  const signer: SolanaSigner = { publicKey: bs58.encode(solKeypair.publicKey), sign };
  return { signer, sign };
}

const solanaRequirement: PaymentRequirements = {
  scheme: 'atum-escrow',
  network: SOLANA,
  asset: SOLANA_MINT,
  amount: '10300000',
  payTo: SOLANA_ESCROW,
  maxTimeoutSeconds: 60,
  extra: {
    atumResource: 'GET /paid',
    atum: {
      destination: {
        network: DEST,
        asset: '0x52e52f345139e57b87d288c9ea794bb3fbe591c3',
        address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      },
      fulfillmentAmount: '10000000',
      escrow: SOLANA_ESCROW,
      fulfillmentProxy: DEST_FULFILLMENT_PROXY,
      reserver: SOLANA_RESERVER,
      releaser: SOLANA_RELEASER,
      fulfillmentVerifierEndpoint: 'http://veri-fill:8088',
      quoteDeadlineSeconds: 20,
      fulfillmentDeadlineSeconds: 300,
      svmSignatureClusterId: 'localnet',
      svmSignatureDomainVersion: 5,
    },
  },
};

const solanaRoles: TrustedRoles = {
  escrowContract: SOLANA_ESCROW,
  quoteSelector: SOLANA_RESERVER,
  fulfillmentVerifierAccount: SOLANA_RELEASER,
  fulfillmentProxy: DEST_FULFILLMENT_PROXY,
  tokens: [{ symbol: 'USDC', address: SOLANA_MINT, decimals: 6 }],
};

describe('AtumEscrowClientScheme — trusted roles (Solana source)', () => {
  // Pinned cluster clock so the build never depends on the local wall clock.
  const solanaClockReader = async () => 1_899_999_999n;

  it('builds and signs the payment when every role matches', async () => {
    const trust = trustTable({ [SOLANA]: solanaRoles, [DEST]: destRoles });
    const { signer, sign } = spyingSolanaSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust, solanaClockReader });

    const pr = prOf(await scheme.createPaymentPayload(2, solanaRequirement, named));

    expect(pr.sender_auth.message_scheme).toBe('SOLANA');
    expect(pr.escrow_contract_address).toBe(SOLANA_ESCROW);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('refuses a reserver that is not the trusted quote selector, without signing', async () => {
    const trust = trustTable({
      [SOLANA]: { ...solanaRoles, quoteSelector: SOLANA_RELEASER },
      [DEST]: destRoles,
    });
    const { signer, sign } = spyingSolanaSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust, solanaClockReader });

    const err = await trustFailure(scheme.createPaymentPayload(2, solanaRequirement, named));

    expect(err.code).toBe('UNTRUSTED_RESERVER');
    expect(err.network).toBe(SOLANA);
    expect(err.expected).toBe(SOLANA_RELEASER);
    expect(err.actual).toBe(SOLANA_RESERVER);
    expect(sign).not.toHaveBeenCalled();
  });

  it('refuses a trusted escrow that signs text (escrow-text-v1), without signing', async () => {
    const trust = trustTable({
      [SOLANA]: { ...solanaRoles, svmMessageScheme: 'escrow-text-v1' },
      [DEST]: destRoles,
    });
    const { signer, sign } = spyingSolanaSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust, solanaClockReader });

    const err = await trustFailure(scheme.createPaymentPayload(2, solanaRequirement, named));

    expect(err.code).toBe('UNSUPPORTED_ESCROW_SCHEME');
    expect(err.network).toBe(SOLANA);
    expect(err.actual).toBe('escrow-text-v1');
    expect(sign).not.toHaveBeenCalled();
  });

  it('signs for a trusted escrow whose scheme is the raw hash', async () => {
    const trust = trustTable({
      [SOLANA]: { ...solanaRoles, svmMessageScheme: '' },
      [DEST]: destRoles,
    });
    const { signer, sign } = spyingSolanaSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust, solanaClockReader });

    const pr = prOf(await scheme.createPaymentPayload(2, solanaRequirement, named));

    expect(pr.escrow_contract_address).toBe(SOLANA_ESCROW);
    expect(sign).toHaveBeenCalledTimes(1);
  });
});

// ── Solana: base58 letter case is identity ───────────────────────────────────
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * The same Solana address with the case of one letter flipped. Base58 is case-sensitive, so this
 * is a different, well-formed 32-byte account that a case-folding comparison would wrongly accept.
 * The last flippable letter is used, and the result is checked to still decode to 32 bytes, so a
 * refusal of it can only be due to case, never to a malformed key.
 */
function caseFlipped(address: string): string {
  for (let i = address.length - 1; i >= 0; i--) {
    const c = address[i]!;
    const f = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
    if (f === c || !BASE58_ALPHABET.includes(f)) continue;
    const flipped = address.slice(0, i) + f + address.slice(i + 1);
    expect(flipped).not.toBe(address);
    expect(flipped.toLowerCase()).toBe(address.toLowerCase());
    expect(bs58.decode(flipped).length).toBe(32);
    return flipped;
  }
  throw new Error(`no case-flippable base58 letter in ${address}`);
}

function solanaRequirementWith(
  overrides: { payTo?: string; atum?: Record<string, unknown> } = {},
): PaymentRequirements {
  const atum = (solanaRequirement.extra as { atum: Record<string, unknown> }).atum;
  return {
    ...solanaRequirement,
    payTo: overrides.payTo ?? solanaRequirement.payTo,
    extra: { atumResource: 'GET /paid', atum: { ...atum, ...overrides.atum } },
  };
}

describe('AtumEscrowClientScheme — Solana roles are compared case-sensitively', () => {
  const solanaClockReader = async () => 1_899_999_999n;

  async function refusedSolana(requirement: PaymentRequirements): Promise<AtumEscrowTrustError> {
    const trust = trustTable({ [SOLANA]: solanaRoles, [DEST]: destRoles });
    const { signer, sign } = spyingSolanaSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust, solanaClockReader });
    const err = await trustFailure(scheme.createPaymentPayload(2, requirement, named));
    expect(sign).toHaveBeenCalledTimes(0);
    return err;
  }

  it('refuses an escrow differing from the trusted one only in letter case, without signing', async () => {
    // payTo keeps naming the genuine escrow, so the escrow is the only mismatching field.
    const nearMiss = caseFlipped(SOLANA_ESCROW);
    const err = await refusedSolana(solanaRequirementWith({ atum: { escrow: nearMiss } }));

    expect(err.code).toBe('UNTRUSTED_ESCROW');
    expect(err.network).toBe(SOLANA);
    expect(err.expected).toBe(SOLANA_ESCROW);
    expect(err.actual).toBe(nearMiss);
  });

  it('refuses a payTo differing from the trusted escrow only in letter case, without signing', async () => {
    const nearMiss = caseFlipped(SOLANA_ESCROW);
    const err = await refusedSolana(solanaRequirementWith({ payTo: nearMiss }));

    expect(err.code).toBe('UNTRUSTED_PAY_TO');
    expect(err.network).toBe(SOLANA);
    expect(err.expected).toBe(SOLANA_ESCROW);
    expect(err.actual).toBe(nearMiss);
  });

  it('refuses a reserver differing from the trusted one only in letter case, without signing', async () => {
    const nearMiss = caseFlipped(SOLANA_RESERVER);
    const err = await refusedSolana(solanaRequirementWith({ atum: { reserver: nearMiss } }));

    expect(err.code).toBe('UNTRUSTED_RESERVER');
    expect(err.network).toBe(SOLANA);
    expect(err.expected).toBe(SOLANA_RESERVER);
    expect(err.actual).toBe(nearMiss);
  });

  it('refuses a releaser differing from the trusted one only in letter case, without signing', async () => {
    const nearMiss = caseFlipped(SOLANA_RELEASER);
    const err = await refusedSolana(solanaRequirementWith({ atum: { releaser: nearMiss } }));

    expect(err.code).toBe('UNTRUSTED_RELEASER');
    expect(err.network).toBe(SOLANA);
    expect(err.expected).toBe(SOLANA_RELEASER);
    expect(err.actual).toBe(nearMiss);
  });
});

describe('AtumEscrowClientScheme — Solana destination fulfillment proxy is compared case-sensitively', () => {
  const SOLANA_FULFILLMENT_PROXY = bs58.encode(
    nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).publicKey,
  );
  const solanaDestRoles: TrustedRoles = {
    escrowContract: SOLANA_ESCROW,
    quoteSelector: SOLANA_RESERVER,
    fulfillmentVerifierAccount: SOLANA_RELEASER,
    fulfillmentProxy: SOLANA_FULFILLMENT_PROXY,
    tokens: [{ symbol: 'USDC', address: SOLANA_MINT, decimals: 6 }],
  };
  const toSolana = (fulfillmentProxy: string) =>
    requirementWith({
      atum: {
        destination: { network: SOLANA, asset: SOLANA_MINT, address: SOLANA_RELEASER },
        fulfillmentProxy,
      },
    });

  it('builds and signs an EVM-to-Solana payment naming the trusted proxy', async () => {
    // Discriminator for the refusal below: the corridor itself is payable.
    const trust = trustTable({ [SOURCE]: sourceRoles, [SOLANA]: solanaDestRoles });
    const { signer, signTypedData } = spyingSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust });

    await expect(
      scheme.createPaymentPayload(2, toSolana(SOLANA_FULFILLMENT_PROXY), named),
    ).resolves.toBeDefined();
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });

  it('refuses a proxy differing from the trusted one only in letter case, without signing', async () => {
    const trust = trustTable({ [SOURCE]: sourceRoles, [SOLANA]: solanaDestRoles });
    const { signer, signTypedData } = spyingSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW, trust });
    const nearMiss = caseFlipped(SOLANA_FULFILLMENT_PROXY);

    const err = await trustFailure(scheme.createPaymentPayload(2, toSolana(nearMiss), named));

    expect(err.code).toBe('UNTRUSTED_FULFILLMENT_PROXY');
    expect(err.network).toBe(SOLANA);
    expect(err.expected).toBe(SOLANA_FULFILLMENT_PROXY);
    expect(err.actual).toBe(nearMiss);
    expect(signTypedData).toHaveBeenCalledTimes(0);
  });
});

// ── No trust option: the Atum gateways are the default trust source ──────────
describe('AtumEscrowClientScheme — default trust source', () => {
  const MAINNET_GW = 'https://payment-gw.production-mainnet.atum.xyz';

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

  function stubGateways(answer: (url: URL) => Response) {
    const requested: string[] = [];
    const fake = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const href =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requested.push(href);
      return answer(new URL(href));
    });
    vi.stubGlobal('fetch', fake);
    return requested;
  }

  it('asks the production mainnet gateway and pays when it vouches for the roles', async () => {
    const requested = stubGateways((url) => {
      if (url.origin !== MAINNET_GW) return new Response('not found', { status: 404 });
      const chain = url.searchParams.get('chain_id');
      if (chain === SOURCE) return Response.json(defaultsBody(SOURCE, sourceRoles));
      if (chain === DEST) return Response.json(defaultsBody(DEST, destRoles));
      return new Response('not found', { status: 404 });
    });
    const { signer, signTypedData } = spyingSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW });

    await expect(scheme.createPaymentPayload(2, requirementWith(), named)).resolves.toBeDefined();

    expect(requested).toContain(`${MAINNET_GW}/v1/defaults?chain_id=${encodeURIComponent(SOURCE)}`);
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });

  it('refuses CHAIN_NOT_TRUSTED, without signing, when both gateways answer 404', async () => {
    // A source chain no other test in this file resolves, so a default resolver whose cache
    // outlives one client instance cannot answer from an earlier test.
    const unknownSource: Network = 'eip155:10';
    stubGateways(() => new Response('not found', { status: 404 }));
    const { signer, signTypedData } = spyingSigner();
    const scheme = new AtumEscrowClientScheme({ signer, now: NOW });

    const err = await trustFailure(
      scheme.createPaymentPayload(2, requirementWith({ network: unknownSource }), named),
    );

    expect(err.code).toBe('CHAIN_NOT_TRUSTED');
    expect(signTypedData).not.toHaveBeenCalled();
  });
});
