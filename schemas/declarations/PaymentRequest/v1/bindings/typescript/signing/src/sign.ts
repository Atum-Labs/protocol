import { Wallet } from "ethers";
import {
  paymentRequestProofTypedData,
  signTypedProof,
  type TypedDataSigner,
} from "@atum-labs/ld-data-integrity";

import { signerFromEthersWallet, type DeclarationSigner } from "./signer.js";
import {
  PAYMENT_REQUEST_CONTEXT_URL,
  SECP256K1_RECOVERY_CONTEXT_URL,
} from "./canonicalize.js";
import { hashPaymentRequest, type HashResult } from "./hash.js";
import { createDetachedJws } from "./jws.js";
import type { PaymentRequest } from "@atum-labs/schema-declarations/PaymentRequest/v1/bindings/typescript";

interface ProofOptions {
  type: "EcdsaSecp256k1RecoverySignature2020";
  created: string;
  verificationMethod: string;
  proofPurpose: string;
}

interface DataIntegrityProofWithJws extends ProofOptions {
  jws: string;
}

export interface SignedPaymentRequest
  extends Omit<PaymentRequest, "proof"> {
  "@context": string[];
  proof: DataIntegrityProofWithJws;
}

export interface SignOptions {
  // EVM chain id used in the verificationMethod DID. Defaults to 1.
  chainId?: number;
  // Optional override for proof.created. Defaults to new Date().toISOString().
  // Conformance fixtures and any other caller that needs a deterministic
  // timestamp pass an explicit ISO-8601 UTC string here; production
  // callers leave it undefined.
  created?: string;
}

// signPaymentRequest returns a copy of `request` with @context and proof
// attached. The proof is an EcdsaSecp256k1RecoverySignature2020 detached
// ES256K-R JWS over the URDNA2015-canonicalized document and proof
// options.
//
// The signing-input construction is delegated to hashPaymentRequest so
// signer + verifier (and the Go twin) share a single implementation.
//
// Unlike the FulfillmentQuote signer, NO empty verifiableCredential[] is
// injected: PaymentRequest is an assertion document, not a VP.
export async function signPaymentRequest(
  request: PaymentRequest,
  privateKey: string,
  options: SignOptions = {}
): Promise<SignedPaymentRequest> {
  // Retained for callers that already hold a local key, and implemented over the signer path
  // so both produce identical bytes. PREFER signPaymentRequestWithSigner: passing a hex key
  // means holding raw key material in a string that cannot be zeroized, and it locks out every
  // custodian. See signer.ts.
  return signPaymentRequestWithSigner(
    request,
    signerFromEthersWallet(new Wallet(privateKey)),
    options
  );
}

/**
 * Signs a PaymentRequest with an injected {@link DeclarationSigner}, so the key never reaches
 * this library. Mirrors the Go half's SignPaymentRequestWithSigner.
 */
export async function signPaymentRequestWithSigner(
  request: PaymentRequest,
  signer: DeclarationSigner,
  options: SignOptions = {}
): Promise<SignedPaymentRequest> {
  if (!signer || typeof signer.signDigest !== "function" || typeof signer.getAddress !== "function") {
    throw new Error("signPaymentRequestWithSigner: signer must implement getAddress and signDigest");
  }
  return signWith(request, await signer.getAddress(), options, async (hashes) =>
    normalizeRecoveryByte(await signer.signDigest(hashes.signingInput))
  );
}

/**
 * Signs a PaymentRequest in the typed form a wallet produces: the signer is asked for an EIP-712
 * signature over PaymentRequestProof{proofHash, docHash}
 * (`paymentRequestProofTypedData`), the two hashes whose keccak256(proofHash || docHash) the raw
 * form signs, so it binds exactly what the raw form binds. The proof options and the wire shape
 * are the raw form's. `verifyPaymentRequest` accepts it only under
 * `acceptPaymentRequestTypedProof`, and refuses it by default.
 *
 * Pass a browser wallet as an ethers `JsonRpcSigner` (its signTypedData is eth_signTypedData_v4),
 * or anything with the same `getAddress` and `signTypedData`. Mirrors the Go half's
 * SignPaymentRequestTypedWithSigner.
 */
export async function signPaymentRequestWithTypedDataSigner(
  request: PaymentRequest,
  signer: TypedDataSigner,
  options: SignOptions = {}
): Promise<SignedPaymentRequest> {
  if (!signer || typeof signer.signTypedData !== "function" || typeof signer.getAddress !== "function") {
    throw new Error("signPaymentRequestWithTypedDataSigner: signer must implement getAddress and signTypedData");
  }
  return signWith(request, await signer.getAddress(), options, async (hashes) => {
    const { signature } = await signTypedProof(
      signer,
      paymentRequestProofTypedData(hashes.proofHash, hashes.docHash)
    );
    return signature;
  });
}

// signWith is the core both forms share: `signature` returns the 65-byte r || s || v, v ∈ {27, 28},
// over whichever digest of the document's hashes its form signs.
async function signWith(
  request: PaymentRequest,
  address: string,
  options: SignOptions,
  signature: (hashes: HashResult) => Promise<Uint8Array>
): Promise<SignedPaymentRequest> {
  const chainId = options.chainId ?? 1;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(
      `signPaymentRequest: signer returned a malformed address ${JSON.stringify(address)}`
    );
  }

  const proofOptions: ProofOptions = {
    type: "EcdsaSecp256k1RecoverySignature2020",
    created: options.created ?? new Date().toISOString(),
    verificationMethod: `did:pkh:eip155:${chainId}:${address.toLowerCase()}#blockchainAccountId`,
    proofPurpose: "assertionMethod",
  };

  const hashes = await hashPaymentRequest(
    // Strip the signing artifacts BEFORE hashing so the canonical @context always applies.
    // hashPaymentRequest treats its context as a DEFAULT, injected only when the document has
    // none — so without this strip a caller-supplied @context would participate in the hash,
    // while the emitted document declares the canonical one, and the proof would not verify.
    // The Go half replaces @context deterministically for exactly this reason, so the two
    // halves disagreed on any input whose @context changed how the document's own terms
    // expand. The conformance fixtures did not catch it because they sign bare documents.
    stripSigningArtifacts(request as Record<string, unknown>),
    {
      cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
      proofOptions,
    }
  );

  const jws = createDetachedJws(await signature(hashes));

  // Strip any pre-existing @context / proof from the input so a re-sign of
  // an already-signed request produces a fresh proof rather than a
  // doubly-wrapped envelope (hashPaymentRequest strips defensively too,
  // but the OUTPUT shape must drop them as well).
  const { proof: _staleProof, "@context": _staleCtx, ...bareRequest } =
    request as PaymentRequest & { "@context"?: unknown };
  void _staleProof;
  void _staleCtx;

  return {
    "@context": [PAYMENT_REQUEST_CONTEXT_URL, SECP256K1_RECOVERY_CONTEXT_URL],
    ...(bareRequest as Omit<PaymentRequest, "proof">),
    proof: { ...proofOptions, jws },
  };
}

// normalizeRecoveryByte enforces the DeclarationSigner contract and applies the W3C
// secp256k1recovery alignment exactly once.
//
// Fails closed on a v that is already 27 or 28: a signer that pre-applied the alignment would
// otherwise have it applied twice, and the resulting proof recovers a DIFFERENT address — a
// signature that looks well-formed and verifies as somebody else. The Go half rejects the same
// condition with the same reasoning.
function normalizeRecoveryByte(raw: Uint8Array): Uint8Array {
  if (!(raw instanceof Uint8Array)) {
    throw new Error("sign: signer returned a non-Uint8Array signature");
  }
  if (raw.length !== 65) {
    throw new Error(`sign: signer returned ${raw.length} bytes, want 65 (r || s || v)`);
  }
  const v = raw[64];
  if (v > 1) {
    throw new Error(
      `sign: signer returned v=${v}, want 0 or 1 (must not pre-apply the +27 alignment)`
    );
  }
  const out = Uint8Array.from(raw);
  out[64] = v + 27;
  return out;
}

// stripSigningArtifacts removes the fields that are products of signing rather than inputs to
// it, so re-signing an already-signed document hashes the same bytes as signing the bare one.
// Mirrors the Go half's stripDocForHash for these two keys; the credential carriers it also
// drops are handled inside hashPaymentRequest.
function stripSigningArtifacts(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === "@context" || k === "proof") continue;
    out[k] = v;
  }
  return out;
}
