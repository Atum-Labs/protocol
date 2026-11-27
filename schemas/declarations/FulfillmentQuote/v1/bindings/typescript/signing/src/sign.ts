import { Wallet, SigningKey } from "ethers";
import {
  FULFILLMENT_QUOTE_CONTEXT_URL,
  SECP256K1_RECOVERY_CONTEXT_URL,
} from "./canonicalize.js";
import { hashQuote } from "./hash.js";
import { createDetachedJws } from "./jws.js";
import { rejectCallerSuppliedVC } from "./sign-guards.js";
import type {
  FulfillmentQuote,
  VerifiableCredential,
} from "@atum-labs/schema-declarations/FulfillmentQuote/v1/bindings/typescript";

interface ProofOptions {
  type: "EcdsaSecp256k1RecoverySignature2020";
  created: string;
  verificationMethod: string;
  proofPurpose: string;
}

interface DataIntegrityProofWithJws extends ProofOptions {
  jws: string;
}

export interface SignedFulfillmentQuote
  extends Omit<FulfillmentQuote, "proof" | "verifiableCredential"> {
  "@context": string[];
  verifiableCredential: VerifiableCredential[];
  proof: DataIntegrityProofWithJws;
}

export interface SignOptions {
  // EVM chain id used in the verificationMethod DID. Defaults to 1.
  chainId?: number;
  // Optional override for proof.created. Defaults to new Date().toISOString().
  // Conformance fixtures and any other caller that needs a
  // deterministic timestamp pass an explicit ISO-8601 UTC string here;
  // production callers leave it undefined.
  created?: string;
}

// signQuote returns a copy of `quote` with @context, proof, and an empty
// verifiableCredential[] attached. The proof is an
// EcdsaSecp256k1RecoverySignature2020 detached ES256K-R JWS over the
// URDNA2015-canonicalized document and proof options.
//
// The signing-input construction is delegated to hashQuote so signer +
// verifier (and the Go twin) share a single implementation.
export async function signQuote(
  quote: FulfillmentQuote,
  privateKey: string,
  options: SignOptions = {}
): Promise<SignedFulfillmentQuote> {
  rejectCallerSuppliedVC(quote);
  const wallet = new Wallet(privateKey);
  const chainId = options.chainId ?? 1;

  const proofOptions: ProofOptions = {
    type: "EcdsaSecp256k1RecoverySignature2020",
    created: options.created ?? new Date().toISOString(),
    verificationMethod: `did:pkh:eip155:${chainId}:${wallet.address.toLowerCase()}#blockchainAccountId`,
    proofPurpose: "assertionMethod",
  };

  const { signingInput } = await hashQuote(quote as Record<string, unknown>, {
    cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
    proofOptions,
  });

  const signingKey = new SigningKey(privateKey);
  const sig = signingKey.sign(signingInput);
  const sigBytes = Buffer.from(sig.serialized.slice(2), "hex");

  const jws = createDetachedJws(sigBytes);

  return {
    "@context": [FULFILLMENT_QUOTE_CONTEXT_URL, SECP256K1_RECOVERY_CONTEXT_URL],
    ...quote,
    verifiableCredential: [],
    proof: { ...proofOptions, jws },
  };
}
