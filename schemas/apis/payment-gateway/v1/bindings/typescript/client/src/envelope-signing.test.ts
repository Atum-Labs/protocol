import { ethers } from 'ethers';
import {
  buildEnvelope,
  buildEnvelopeForAccount,
  didForAccount,
  verificationMethodForAccount,
  signerFromEthersWallet,
  PAYMENT_REQUEST_ENVELOPE_TYPE,
  PAYMENT_REQUEST_ENVELOPE_CONTEXT_URL,
} from './signing';
import type { EnvelopeSigner } from './signing';
import { PAYMENT_REQUEST_ENVELOPE_CONTEXT } from './pre-context.generated';

// The verifier the gateway runs. Asserting against it is what makes these tests
// about the envelope rather than about this file's own expectations.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { verifyVP } = require('@atum-labs/ld-signing');

const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 'eip155:1';
// proof.created is inside the signed payload, so it is pinned rather than left to the clock.
const CREATED = '2026-04-01T00:00:00.000Z';

const wallet = new ethers.Wallet(PRIVATE_KEY);
const account = wallet.address.toLowerCase();
const holder = didForAccount(CHAIN_ID, account);
// No cast: a DeclarationSigner satisfies EnvelopeSigner structurally, which is the property
// that lets one signer serve all three surfaces. If this ever needs a cast, the signer types
// have diverged and an integrator has to hold two.
const signer = signerFromEthersWallet(wallet);

// A KnownToAtum credential shaped the way the verifier expects. Its proof is structural: the VP
// path does not verify embedded VC signatures unless the caller opts in, but the block must
// exist and its type must match the OUTER cryptosuite or URDNA2015 cannot resolve the alias.
function credential() {
  return {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://schemas.atum.xyz/credentials/known-to-atum/v1',
    ],
    id: 'urn:uuid:1f1c1b3a-0000-4000-8000-00000000acce',
    type: ['VerifiableCredential', 'KnownToAtumVerifiableCredential'],
    issuer: 'did:web:devnet.atum.network',
    issuanceDate: CREATED,
    credentialSubject: { id: holder, role: 'originator' },
    proof: {
      type: 'EcdsaSecp256k1RecoverySignature2020',
      created: CREATED,
      verificationMethod: `${holder}#blockchainAccountId`,
      proofPurpose: 'assertionMethod',
    },
  };
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    holderVCs: [credential()],
    signer,
    holder,
    verificationMethod: verificationMethodForAccount(CHAIN_ID, account),
    challenge: 'req-envelope-1',
    domain: 'did:web:devnet.atum.network',
    created: CREATED,
    ...overrides,
  } as Parameters<typeof buildEnvelope>[0];
}

function verifyOptions(overrides: Record<string, unknown> = {}) {
  return {
    expectedChallenge: 'req-envelope-1',
    expectedDomain: 'did:web:devnet.atum.network',
    expectedHolder: holder,
    expectedDeclarationType: PAYMENT_REQUEST_ENVELOPE_TYPE,
    now: new Date(Date.parse(CREATED) + 30_000),
    maxProofAgeMs: 5 * 60 * 1000,
    maxFutureSkewMs: 30 * 1000,
    requiredVCTypes: ['KnownToAtumVerifiableCredential'],
    // Both are required, not optional. The PRE context is deliberately absent from the shared
    // loader, so a verifier that omits it cannot canonicalize a PRE at all — and without the
    // URL the type term is dropped and the envelope stops being type-bound, which the verifier
    // refuses rather than silently allowing.
    envelopeContextUrl: PAYMENT_REQUEST_ENVELOPE_CONTEXT_URL,
    extraEnvelopeContexts: {
      [PAYMENT_REQUEST_ENVELOPE_CONTEXT_URL]: PAYMENT_REQUEST_ENVELOPE_CONTEXT,
    },
    ...overrides,
  };
}

describe('buildEnvelope — positive', () => {
  it('produces a holder-signed presentation', async () => {
    const envelope = await buildEnvelope(options());

    expect(envelope.proof.proofPurpose).toBe('authentication');
    expect(envelope.proof.challenge).toBe('req-envelope-1');
    expect(envelope.proof.domain).toBe('did:web:devnet.atum.network');
    expect(envelope.proof.verificationMethod).toBe(`${holder}#blockchainAccountId`);
  });

  it('carries the PRE declaration context, not the FulfillmentQuoteEnvelope one', async () => {
    const envelope = await buildEnvelope(options());
    const context = JSON.stringify(envelope['@context']);

    expect(context).toContain('PaymentRequestEnvelope/v1/context.jsonld');
    expect(context).not.toContain('FulfillmentQuoteEnvelope');
    expect(JSON.stringify(envelope.type)).toContain(PAYMENT_REQUEST_ENVELOPE_TYPE);
  });

  it('is accepted by the verifier the gateway runs', async () => {
    const envelope = await buildEnvelope(options());
    await expect(verifyVP(envelope, verifyOptions())).resolves.toBeDefined();
  });

  it('is reproducible for the same inputs', async () => {
    const a = await buildEnvelope(options());
    const b = await buildEnvelope(options());
    expect(a.proof.jws).toBe(b.proof.jws);
  });

  it('accepts a custodial-style async signer', async () => {
    const remote: EnvelopeSigner = {
      signDigest: async (digest) => {
        await new Promise((r) => setTimeout(r, 1));
        const sig = wallet.signingKey.sign(digest);
        const out = new Uint8Array(65);
        out.set(ethers.getBytes(sig.r), 0);
        out.set(ethers.getBytes(sig.s), 32);
        out[64] = sig.yParity;
        return out;
      },
    };
    const envelope = await buildEnvelope(options({ signer: remote }));
    await expect(verifyVP(envelope, verifyOptions())).resolves.toBeDefined();
  });

  it('derives the holder identity from a chain and address', async () => {
    const envelope = await buildEnvelopeForAccount(CHAIN_ID, account, {
      holderVCs: [credential()],
      signer,
      challenge: 'req-envelope-1',
      domain: 'did:web:devnet.atum.network',
      created: CREATED,
    });

    expect(envelope.holder).toBe(holder);
    expect(envelope.proof.verificationMethod).toBe(`${holder}#blockchainAccountId`);
  });
});

describe('buildEnvelope — adversarial', () => {
  it.each([
    ['no credentials', { holderVCs: [] }, /at least one credential/],
    ['credentials not an array', { holderVCs: null }, /at least one credential/],
    ['no signer', { signer: null }, /must implement signDigest/],
    ['a key where a signer belongs', { signer: PRIVATE_KEY }, /must implement signDigest/],
    ['no holder', { holder: '' }, /holder is required/],
    ['no verification method', { verificationMethod: '' }, /verificationMethod is required/],
    ['no challenge', { challenge: '' }, /challenge is required/],
    ['no domain', { domain: '' }, /domain is required/],
  ])('refuses %s', async (_label, override, match) => {
    await expect(buildEnvelope(options(override as Record<string, unknown>))).rejects.toThrow(
      match as RegExp,
    );
  });

  it('refuses a signer that pre-applied the recovery alignment', async () => {
    const preApplied: EnvelopeSigner = {
      signDigest: (digest) => {
        const sig = wallet.signingKey.sign(digest);
        const out = new Uint8Array(65);
        out.set(ethers.getBytes(sig.r), 0);
        out.set(ethers.getBytes(sig.s), 32);
        out[64] = sig.yParity + 27;
        return out;
      },
    };
    await expect(buildEnvelope(options({ signer: preApplied }))).rejects.toThrow(
      /must not pre-apply/,
    );
  });

  it.each([
    ['too short', 64],
    ['too long', 66],
  ])('refuses a %s signature', async (_label, length) => {
    const bad: EnvelopeSigner = { signDigest: () => new Uint8Array(length) };
    await expect(buildEnvelope(options({ signer: bad }))).rejects.toThrow(/want 65/);
  });

  it('propagates a signer refusal without emitting an envelope', async () => {
    const refuses: EnvelopeSigner = {
      signDigest: () => {
        throw new Error('policy: signing denied for this payload');
      },
    };
    await expect(buildEnvelope(options({ signer: refuses }))).rejects.toThrow(
      /policy: signing denied/,
    );
  });

  it('produces an envelope a tampered copy of which does not verify', async () => {
    const envelope = await buildEnvelope(options());
    const tampered = {
      ...envelope,
      holder: 'did:pkh:eip155:1:0x000000000000000000000000000000000000dead',
    };
    await expect(verifyVP(tampered, verifyOptions())).rejects.toThrow();
  });

  it.each([
    ['a challenge from another request', { expectedChallenge: 'req-some-other-payment' }],
    ['a domain from another environment', { expectedDomain: 'did:web:production.atum.network' }],
    [
      'a holder other than the signer',
      { expectedHolder: 'did:pkh:eip155:1:0x000000000000000000000000000000000000dead' },
    ],
    [
      'acceptance as a FulfillmentQuoteEnvelope',
      { expectedDeclarationType: 'FulfillmentQuoteEnvelope' },
    ],
  ])('the verifier refuses %s', async (_label, override) => {
    const envelope = await buildEnvelope(options());
    await expect(verifyVP(envelope, verifyOptions(override))).rejects.toThrow();
  });

  // The PRE context is not on the shared loader, so a verifier that omits the overlay cannot
  // canonicalize the envelope. It must say so rather than verifying something else.
  it('cannot be verified without the PRE context overlay', async () => {
    const envelope = await buildEnvelope(options());
    await expect(
      verifyVP(envelope, verifyOptions({ extraEnvelopeContexts: undefined })),
    ).rejects.toThrow();
  });
});
