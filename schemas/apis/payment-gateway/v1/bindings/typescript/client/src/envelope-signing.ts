// The originator's identity envelope: a holder-signed PaymentRequestEnvelope (PRE).
//
// This is the third of the three signatures a PaymentRequest carries, and the only one that
// says WHO the originator is. `signPaymentRequest` authorizes the transfer and
// `signDeclaration` attests the document; neither identifies anyone. A request carrying a valid
// sender_auth and no envelope authorizes a transfer by an unidentified originator.
//
// The counterpart of BuildEnvelope in the Go client, and it produces the same envelope: the
// outer holder proof comes from the shared VP signer with the PRE declaration context
// overlaid, so a PRE is distinguishable from a FulfillmentQuoteEnvelope by the declaration term bound
// into the signature rather than by a field a document can simply claim.

import type { PaymentRequest } from './generated/types.gen';
import { PAYMENT_REQUEST_ENVELOPE_CONTEXT } from './pre-context.generated';

// Loaded through require rather than a static import so no type edge to the upstream package
// is created — it declares its public types against @atum-labs/schema-declarations, whose raw
// .ts entry points break any consumer that sets a tsconfig rootDir. See declaration-signing.ts.
/* eslint-disable @typescript-eslint/no-require-imports -- the require is deliberate: a
   static import would create a type edge into @atum-labs/schema-declarations, whose raw .ts
   entry points fail the DTS build with TS6059. See the comment above. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const vpSigning: any = require('@atum-labs/ld-signing');

// Re-exported from the generated module rather than retyped here. Both values are bound into the
// holder signature, and the canonical definitions live in the PaymentRequestEnvelope binding's
// version module, which the Go half also reads. Retyping them meant that if the URL ever moved,
// Go would follow and this client would keep signing under the old terms with nothing failing.
// gen-pre-context.mjs copies them at build time and `check:pre-context` fails on drift.
import {
  PAYMENT_REQUEST_ENVELOPE_CONTEXT_URL,
  PAYMENT_REQUEST_ENVELOPE_TYPE,
} from './pre-context.generated';

export {
  /** The PRE declaration context IRI. Bound into the envelope and re-resolved by the verifier. */
  PAYMENT_REQUEST_ENVELOPE_CONTEXT_URL,
  /** The declaration term bound into the holder signature. */
  PAYMENT_REQUEST_ENVELOPE_TYPE,
};

/**
 * Signs a 32-byte digest with the holder's secp256k1 key.
 *
 * Takes a signer, never a private key, so a holder whose key sits in a KMS, an HSM, or a
 * custodial provider can sign without it entering this process. `signerFromEthersWallet` covers
 * a local key.
 *
 * Returns 65 bytes of `r || s || v` with **v ∈ {0, 1}**. A signature whose v is already 27 or
 * 28 is refused: applying the alignment twice recovers a different holder.
 */
export interface EnvelopeSigner {
  signDigest(digest: Uint8Array): Promise<Uint8Array> | Uint8Array;
}

/**
 * A holder-signed PaymentRequestEnvelope.
 *
 * Typed rather than returned as `unknown`: a caller that has to cast cannot be told by the
 * compiler when a field it reads stops existing, and the fields below are the ones the gateway
 * checks — so getting them wrong is a rejected payment, not a type error at the call site.
 */
export interface SignedPaymentRequestEnvelope {
  '@context': string[];
  type: string[];
  holder: string;
  verifiableCredential: unknown[];
  proof: {
    type: string;
    created: string;
    verificationMethod: string;
    proofPurpose: string;
    /** Binds the envelope to one request; the gateway recomputes it. */
    challenge: string;
    /** Binds the envelope to one environment. */
    domain: string;
    /** Present for secp256k1 proofs. */
    jws?: string;
    /** Present for ed25519 proofs. */
    proofValue?: string;
  };
}

/** Inputs to {@link buildEnvelope}. Every field is required unless noted. */
export interface BuildEnvelopeOptions {
  /**
   * The originator's issuer-signed credentials, each a fully-formed W3C VC with its own
   * `@context` and `proof`.
   *
   * MUST be non-empty: the envelope schema requires at least one and the verifier rejects an
   * empty bag. An originator that holds no credential about itself cannot build one yet.
   */
  holderVCs: unknown[];

  /** Signs the holder proof. See {@link EnvelopeSigner}. */
  signer: EnvelopeSigner;

  /** The holder's did:pkh identifier, e.g. `did:pkh:eip155:1:0xabc…`. */
  holder: string;

  /** The DID URL naming the holder's signing key, usually `holder + '#blockchainAccountId'`. */
  verificationMethod: string;

  /**
   * The cross-request replay binding: the payment's `request_hash`, which the gateway recomputes over the inner request. Use `computeRequestHash` to derive it.
   */
  challenge: string;

  /**
   * The cross-environment replay binding: the network-wide, env-suffixed did:web identifier
   * (e.g. `did:web:devnet.atum.network`). NOT service-bound — the envelope has several
   * consumers.
   */
  domain: string;

  /**
   * Anchors `proof.created`, as an ISO-8601 UTC string. Defaults to now.
   *
   * It is inside the signed payload, so pass it explicitly wherever a signature must be
   * reproducible.
   */
  created?: string;
}

/** Builds the did:pkh identifier for a wallet account on a CAIP-2 chain. */
export function didForAccount(chainId: string, account: string): string {
  return `did:pkh:${chainId}:${account}`;
}

/** Builds the DID URL naming a wallet account's signing key. */
export function verificationMethodForAccount(chainId: string, account: string): string {
  return `${didForAccount(chainId, account)}#blockchainAccountId`;
}

/**
 * Wraps the originator's credentials in a holder-signed PaymentRequestEnvelope and returns the
 * envelope JSON.
 *
 * It does NOT sign the inner PaymentRequest. That is a separate artifact — see
 * `signDeclaration` — and the verifier checks the two independently, asserting the inner signer
 * is this envelope's holder. Sign both with the same key, or the gateway rejects the pair.
 */
export async function buildEnvelope(
  options: BuildEnvelopeOptions,
): Promise<SignedPaymentRequestEnvelope> {
  const { holderVCs, signer, holder, verificationMethod, challenge, domain, created } = options;

  if (!Array.isArray(holderVCs) || holderVCs.length === 0) {
    throw new Error(
      'buildEnvelope: holderVCs must contain at least one credential; the envelope schema ' +
        'requires one and the verifier rejects an empty bag',
    );
  }
  if (!signer || typeof signer.signDigest !== 'function') {
    throw new Error('buildEnvelope: signer must implement signDigest');
  }
  if (!holder) throw new Error('buildEnvelope: holder is required');
  if (!verificationMethod) throw new Error('buildEnvelope: verificationMethod is required');
  if (!challenge) {
    throw new Error('buildEnvelope: challenge is required (the request_hash replay binding)');
  }
  if (!domain) {
    throw new Error('buildEnvelope: domain is required (the environment replay binding)');
  }

  return vpSigning.signVPWithSigner(holderVCs, signer, {
    holder,
    verificationMethod,
    challenge,
    domain,
    created,
    // These three are what make the result a PRE rather than a FulfillmentQuoteEnvelope. The
    // declaration type is bound into the holder signature, and the overlay is what lets the
    // signer resolve the PRE context offline — it is deliberately absent from the shared
    // loader, so omitting it fails rather than silently signing under the wrong terms.
    declarationType: PAYMENT_REQUEST_ENVELOPE_TYPE,
    envelopeContextUrl: PAYMENT_REQUEST_ENVELOPE_CONTEXT_URL,
    extraEnvelopeContexts: {
      // Cloned, not passed by reference. The generated context is module state shared by
      // every call, so handing the live object to the signer means anything that mutates it
      // — a caller, or a library reaching into it — changes what this package signs for the
      // rest of the process. That failure is silent: the document still looks right and only
      // the signature differs, so it surfaces as envelopes rejected by a gateway that did
      // not see the mutation. The Go half returns a copy from ParsedContext for the same
      // reason, and a test pins both.
      [PAYMENT_REQUEST_ENVELOPE_CONTEXT_URL]: structuredClone(PAYMENT_REQUEST_ENVELOPE_CONTEXT),
    },
  });
}

/**
 * Convenience over {@link buildEnvelope} for the common case: derive the holder DID and
 * verification method from the wallet's chain and address.
 */
export async function buildEnvelopeForAccount(
  chainId: string,
  account: string,
  options: Omit<BuildEnvelopeOptions, 'holder' | 'verificationMethod'>,
): Promise<SignedPaymentRequestEnvelope> {
  return buildEnvelope({
    ...options,
    holder: didForAccount(chainId, account),
    verificationMethod: verificationMethodForAccount(chainId, account),
  });
}

// Re-exported so a caller can type the request it is building an envelope for.
export type { PaymentRequest };
