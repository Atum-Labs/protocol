// The payment request EIP-712 domain, for the two proofs a payment request carries about its
// originator: the inner PaymentRequest proof and the PaymentRequestEnvelope holder proof. Mirror
// of the Go lib's payment_request_proof.go.
//
// An EcdsaSecp256k1RecoverySignature2020 proof signs keccak256(proofHash || docHash), a raw 32-byte
// digest, and a browser wallet signs no raw digest: it signs typed data (eth_signTypedData_v4) or a
// prefixed message (personal_sign). So a payer whose key is in a wallet signs the typed form: the
// same proof, whose signature is over the EIP-712 digest of {proofHash, docHash}, the two hashes
// the raw form combines. proof.type, the proof options and the detached JWS are the raw form's,
// and a verifier tells the two apart by which digest recovers the signer the proof names.
//
// Like the settler identity domain it carries no chainId (the digest is the same on every chain,
// and a wallet signs it whatever chain it is on), and its verifying contract is a sentinel with no
// code: the last 20 bytes of keccak256("atum.payment-request.v1").

import {
  getAddress,
  getBytes,
  hexlify,
  Signature,
  TypedDataEncoder,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";

import { MalformedProofError, SignatureRecoveryError } from "./errors.js";
import { recoverSecp256k1Signer } from "./recovery.js";
import type { Secp256k1ProofHashes } from "./settler-identity.js";

export const PAYMENT_REQUEST_DOMAIN = Object.freeze({
  name: "Atum Payment Request",
  version: "1",
  verifyingContract: "0x520A20100F01165e806D6d239d9D287a109Ce456",
});

const proofHashFields: TypedDataField[] = [
  { name: "proofHash", type: "bytes32" },
  { name: "docHash", type: "bytes32" },
];

/** The inner PaymentRequest proof's typed struct. */
export const PAYMENT_REQUEST_PROOF_TYPES: Record<string, TypedDataField[]> = Object.freeze({
  PaymentRequestProof: proofHashFields,
}) as Record<string, TypedDataField[]>;

/** The PaymentRequestEnvelope holder proof's typed struct. */
export const PAYMENT_REQUEST_ENVELOPE_PROOF_TYPES: Record<string, TypedDataField[]> = Object.freeze({
  PaymentRequestEnvelopeProof: proofHashFields,
}) as Record<string, TypedDataField[]>;

/**
 * The declaration type a PaymentRequestEnvelope's signed `type` carries. The typed holder proof is
 * only ever accepted for an envelope that declares it.
 */
export const PAYMENT_REQUEST_ENVELOPE_TYPE = "PaymentRequestEnvelope";

/** Computes a typed digest from the two hashes hashDocument returns. */
export type TypedProofDigest = (proofHash: Uint8Array, docHash: Uint8Array) => Uint8Array;

/** What a wallet is asked to sign: eth_signTypedData_v4's domain, types and message. */
export interface TypedProofRequest {
  domain: TypedDataDomain;
  types: Record<string, TypedDataField[]>;
  primaryType: string;
  message: { proofHash: string; docHash: string };
}

function bytes32(value: Uint8Array, field: string): string {
  if (value.length !== 32) {
    throw new MalformedProofError(`${field} must be 32 bytes, got ${value.length}`);
  }
  return hexlify(value);
}

function typedRequest(
  types: Record<string, TypedDataField[]>,
  proofHash: Uint8Array,
  docHash: Uint8Array
): TypedProofRequest {
  return {
    domain: { ...PAYMENT_REQUEST_DOMAIN },
    types: Object.fromEntries(Object.entries(types).map(([k, v]) => [k, v.map((f) => ({ ...f }))])),
    primaryType: Object.keys(types)[0],
    message: { proofHash: bytes32(proofHash, "proofHash"), docHash: bytes32(docHash, "docHash") },
  };
}

/** The typed data a wallet signs for the inner PaymentRequest proof. */
export function paymentRequestProofTypedData(proofHash: Uint8Array, docHash: Uint8Array): TypedProofRequest {
  return typedRequest(PAYMENT_REQUEST_PROOF_TYPES, proofHash, docHash);
}

/** The typed data a wallet signs for the PaymentRequestEnvelope holder proof. */
export function paymentRequestEnvelopeProofTypedData(
  proofHash: Uint8Array,
  docHash: Uint8Array
): TypedProofRequest {
  return typedRequest(PAYMENT_REQUEST_ENVELOPE_PROOF_TYPES, proofHash, docHash);
}

function digestOf(request: TypedProofRequest): Uint8Array {
  return getBytes(TypedDataEncoder.hash(request.domain, request.types, request.message));
}

/** The EIP-712 digest of PaymentRequestProof{proofHash, docHash}. */
export const paymentRequestProofTypedDigest: TypedProofDigest = (proofHash, docHash) =>
  digestOf(paymentRequestProofTypedData(proofHash, docHash));

/** The EIP-712 digest of PaymentRequestEnvelopeProof{proofHash, docHash}. */
export const paymentRequestEnvelopeProofTypedDigest: TypedProofDigest = (proofHash, docHash) =>
  digestOf(paymentRequestEnvelopeProofTypedData(proofHash, docHash));

/**
 * recoverSecp256k1ProofSignerFrom recovers an EcdsaSecp256k1RecoverySignature2020 signer, accepting
 * the raw signing input or any of the typed forms the caller names. Each typed digest is tried, in
 * order, only when every form before it recovered a signer `matches` refuses; if none matches, the
 * raw signer is returned, so the caller's mismatch handling is unchanged. An error from the raw
 * recovery is thrown as it is, before any typed form is tried.
 */
export function recoverSecp256k1ProofSignerFrom(
  hashes: Secp256k1ProofHashes,
  signature: Uint8Array,
  matches: (address: string) => boolean,
  typed: TypedProofDigest[]
): string {
  const raw = recoverSecp256k1Signer(hashes.signingInput, signature);
  if (matches(raw)) {
    return raw;
  }
  for (const typedDigest of typed) {
    try {
      const signer = recoverSecp256k1Signer(typedDigest(hashes.proofHash, hashes.docHash), signature);
      if (matches(signer)) {
        return signer;
      }
    } catch {
      // Try the next form; the raw result stands if none matches.
    }
  }
  return raw;
}

/**
 * Signs typed data with a key the library never sees: a browser wallet (an ethers
 * `JsonRpcSigner` over `window.ethereum`, whose signTypedData is eth_signTypedData_v4), an ethers
 * `Wallet`, or anything with the same two methods.
 */
export interface TypedDataSigner {
  /** The 0x address the signer's key derives to; the proof names it, and verifiers recover it. */
  getAddress(): Promise<string> | string;
  /** EIP-712 signature over (domain, types, message), types without EIP712Domain, as ethers takes them. */
  signTypedData(
    domain: TypedDataDomain,
    types: Record<string, TypedDataField[]>,
    message: Record<string, unknown>
  ): Promise<string>;
}

/**
 * Asks `signer` to sign `request` and returns the 65-byte r || s || v signature, v ∈ {27, 28} as
 * the detached JWS carries it. A wallet may answer v as 0/1 or 27/28; either is accepted. A
 * signature that does not recover the signer's own address is refused here, rather than emitted
 * as a proof that verifies as somebody else.
 */
export async function signTypedProof(
  signer: TypedDataSigner,
  request: TypedProofRequest
): Promise<{ address: string; signature: Uint8Array }> {
  if (!signer || typeof signer.signTypedData !== "function" || typeof signer.getAddress !== "function") {
    throw new Error("signTypedProof: signer must implement getAddress and signTypedData");
  }
  const address = getAddress(await signer.getAddress());
  const answer = await signer.signTypedData(request.domain, request.types, request.message);
  let sig: Signature;
  try {
    sig = Signature.from(answer);
  } catch (err) {
    throw new SignatureRecoveryError(`signTypedProof: the signer answered an unreadable signature: ${String(err)}`);
  }
  const out = new Uint8Array(65);
  out.set(getBytes(sig.r), 0);
  out.set(getBytes(sig.s), 32);
  out[64] = sig.v;
  const recovered = recoverSecp256k1Signer(digestOf(request), out);
  if (recovered !== address) {
    throw new SignatureRecoveryError(
      `signTypedProof: the signature recovers ${recovered}, not the signer's ${address}`
    );
  }
  return { address, signature: out };
}
