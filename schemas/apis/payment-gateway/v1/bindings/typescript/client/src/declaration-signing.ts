// The PaymentRequest document signature: a W3C Data Integrity proof over the
// URDNA2015-canonicalized request, attesting that the document came from its signer.
//
// This is NOT the transfer authorization. `signPaymentRequest` fills sender_auth and is what
// lets funds move; this attests to the document. An originator generally needs both, and a
// request carrying one without the other is not equivalent to carrying both.
//
// WHY THIS FILE EXISTS RATHER THAN A DIRECT RE-EXPORT. The upstream signing package declares
// its public types against @atum-labs/schema-declarations, which exports raw .ts sources with
// no build step. Any consumer that sets a tsconfig `rootDir` — this package does, deliberately
// — fails with TS6059 the moment those sources enter the program. That boundary is why this
// package inlines schema constants instead of depending on that workspace. So the surface is
// declared here in terms of this package's own generated types, and the upstream module is
// loaded for its behaviour only.

import type { PaymentRequest } from './generated/types.gen';

// Loaded through require rather than a static import so no type edge to the upstream package
// is created; see the note above. tsup bundles the call because @atum-labs/* is noExternal, so
// the implementation still ships inside dist.
/* eslint-disable @typescript-eslint/no-require-imports -- the require is deliberate: a
   static import would create a type edge into @atum-labs/schema-declarations, whose raw .ts
   entry points fail the DTS build with TS6059. See the comment above. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ldSigning: any = require('@atum-labs/payment-request-ld-signing');

/** Options for {@link signDeclaration}. */
export interface SignDeclarationOptions {
  /** EVM chain id used in the verificationMethod DID. Defaults to 1. */
  chainId?: number;
  /**
   * Override for proof.created, as an ISO-8601 UTC string. Defaults to now.
   *
   * The value is inside the signed payload, so pass it explicitly wherever a signature has to
   * be reproducible — conformance fixtures and tests — and leave it unset in production.
   */
  created?: string;
}

/** A W3C Data Integrity proof as it appears on a signed PaymentRequest. */
export interface DeclarationProof {
  type: string;
  created: string;
  verificationMethod: string;
  proofPurpose: string;
  jws?: string;
  proofValue?: string;
}

/** A PaymentRequest with its `@context` and `proof` attached. */
export type SignedDeclaration = PaymentRequest & {
  '@context': string[];
  proof: DeclarationProof;
};

/**
 * The identity a verified document proof yields.
 *
 * Discriminated, and deliberately so. The two cases carry different weight, and flattening
 * them into one shape is how a self-asserted key gets read as a proven one:
 *
 * - `recovered-secp256k1`: the address is recovered FROM the signature, so it is self-evident
 *   proof of which key signed.
 * - `self-asserted-ed25519`: the public key is taken from the document's own
 *   verificationMethod. A successful verify proves the signature matches that key — NOT that
 *   the key belongs to anyone in particular. Bind it to a trusted source before relying on it.
 *
 * This mirrors the sealed Signer interface in the Go verifier, which exists for the same
 * reason.
 */
export type VerifiedDeclarationSigner =
  | { kind: 'recovered-secp256k1'; address: string; did: string }
  | { kind: 'self-asserted-ed25519'; publicKey: Uint8Array; did: string };

/** What {@link verifyDeclaration} reports about a valid proof. */
export interface VerifyDeclarationResult {
  /** The verified identity. Discriminate on `kind` before reading it. */
  signer: VerifiedDeclarationSigner;
  /** The cryptosuite that produced the proof. */
  cryptosuite: string;
}

// Defence in depth. The upstream verifier now performs this binding itself — it used to
// return the recovered address and the document's CLAIMED DID side by side without comparing
// them, so a tampered document verified "successfully" while the DID still named the honest
// signer. The check is kept here because this is the published surface: it costs a string
// comparison, and it means the SDK fails closed even against an older bundled copy of the
// library. Whichever runs first, the outcome is the same.
function assertRecoveredMatchesClaim(recovered: string, did: string): void {
  const claimed = did.slice(did.lastIndexOf(':') + 1).toLowerCase();
  if (!claimed || claimed !== recovered.toLowerCase()) {
    throw new Error(
      `verifyDeclaration: the signature recovers ${recovered}, but the document claims ` +
        `${claimed || '(no address)'}. The document has been altered since it was signed.`,
    );
  }
}

/**
 * Signs a 32-byte digest with the holder's secp256k1 key.
 *
 * This surface takes a signer rather than a private key, deliberately. A hex key forces raw key
 * material into a JavaScript string that cannot be zeroized, is copied on assignment, and lands
 * in heap snapshots and any log line that stringifies the surrounding object — and it locks out
 * every custodian, since a holder whose key sits in a KMS, an HSM, or a provider like Turnkey
 * has no key to hand over. Implement this over the provider's own digest-signing call, or use
 * {@link signerFromEthersWallet} for a local key.
 *
 * Same shape as the SenderSigner seam this package already uses for the transfer authorization,
 * and as the Go client's Secp256k1Signer.
 */
export interface DeclarationSigner {
  /** The 0x address this signer's key derives to; it becomes the did:pkh verificationMethod. */
  getAddress(): Promise<string> | string;
  /**
   * Signs a 32-byte digest, returning 65 bytes of `r || s || v` with **v ∈ {0, 1}**.
   *
   * v is the raw recovery id. The alignment the W3C suite expects is applied once downstream,
   * and a signature whose v is already 27 or 28 is REFUSED — applying it twice recovers a
   * different address, i.e. a proof that verifies as somebody else.
   */
  signDigest(digest: Uint8Array): Promise<Uint8Array> | Uint8Array;
}

/**
 * Adapts an ethers `Wallet` to {@link DeclarationSigner}, for the local-key case.
 *
 * ethers owns the key material; this borrows only the digest-signing capability. It signs a RAW
 * digest, not `signMessage`: the proof is over a canonicalized document hash, so the EIP-191
 * prefix would produce a signature that does not verify as a Data Integrity proof.
 */
export const signerFromEthersWallet: (wallet: unknown) => DeclarationSigner =
  ldSigning.signerFromEthersWallet;

/**
 * Signs a PaymentRequest document, returning a copy with `@context` and `proof` attached.
 *
 * The proof covers the URDNA2015-canonicalized document, so it is stable across key reordering
 * and whitespace. Signing artifacts and the deprecated credential carriers are excluded from
 * that hash by the signing library, and the verifier strips the identical set.
 *
 * One consequence worth knowing: canonicalization drops terms the declaration `@context` does
 * not define, so a field this package's types do not model travels inside the signed document
 * without being covered by the proof. Making a new field tamper-evident means adding it to the
 * context, not just to the payload.

 */
export async function signDeclaration(
  request: PaymentRequest,
  signer: DeclarationSigner,
  options: SignDeclarationOptions = {},
): Promise<SignedDeclaration> {
  return ldSigning.signPaymentRequestWithSigner(
    request,
    signer,
    options,
  ) as Promise<SignedDeclaration>;
}

/**
 * Verifies a signed PaymentRequest document and recovers its signer.
 *
 * THROWS if the proof is missing, malformed, does not verify, or — for a recovery-based
 * suite — recovers a signer other than the one the document claims. Callers branch on the
 * exception, not on a return value.
 *
 * This checks the document proof only. It says nothing about whether sender_auth authorizes a
 * transfer, nor whether the originator's identity is established.
 */
export async function verifyDeclaration(
  signed: SignedDeclaration,
): Promise<VerifyDeclarationResult> {
  const raw = (await ldSigning.verifyPaymentRequest(signed)) as {
    cryptosuite: string;
    signerDID: string;
    signerAddress: string;
    ed25519PublicKey: Uint8Array | null;
  };

  if (raw.ed25519PublicKey) {
    return {
      cryptosuite: raw.cryptosuite,
      signer: {
        kind: 'self-asserted-ed25519',
        publicKey: raw.ed25519PublicKey,
        did: raw.signerDID,
      },
    };
  }

  assertRecoveredMatchesClaim(raw.signerAddress, raw.signerDID);
  return {
    cryptosuite: raw.cryptosuite,
    signer: {
      kind: 'recovered-secp256k1',
      address: raw.signerAddress,
      did: raw.signerDID,
    },
  };
}

/**
 * Computes the canonical content hash of a PaymentRequest.
 *
 * This is the value an identity envelope binds as its `challenge`, so a caller assembling one
 * needs the same hash the gateway will recompute.
 */
export async function computeRequestHash(request: PaymentRequest): Promise<string> {
  return ldSigning.computeRequestHash(request) as Promise<string>;
}
