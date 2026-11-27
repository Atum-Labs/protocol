// Public verifier for W3C Data Integrity-signed PaymentRequests. Mirror
// of schemas/declarations/PaymentRequest/v1/signing/go/verify.go;
// any divergence in the dispatch order, error-fail-closed posture, or
// per-cryptosuite rules would let one verifier on the network accept a
// request the other rejects.
//
// The signing-input reconstruction goes through hashPaymentRequest so the
// verifier and signer share a single implementation per cryptosuite.

import {
  paymentRequestProofTypedDigest,
  recoverSecp256k1ProofSignerFrom,
} from "@atum-labs/ld-data-integrity";
import bs58 from "bs58";
import { verifyEd25519Proof } from "@atum-labs/ld-data-integrity";

import { hashPaymentRequest, type Cryptosuite, type HashResult } from "./hash.js";
import { parseDetachedJws } from "./jws.js";
import { decodeStellarAccount } from "./strkey.js";
import {
  SECP256K1_RECOVERY_CONTEXT_URL,
  ED25519_2020_CONTEXT_URL,
} from "./canonicalize.js";

// expectedProofPurpose is the only proof.proofPurpose the verifier
// accepts (mirror of verify.go). W3C DI 1.0 §4.2 requires verifiers to
// validate this; without it, a key intended for e.g. keyAgreement could
// be used for assertionMethod and the by-purpose authorization model is
// silently bypassed.
const expectedProofPurpose = "assertionMethod";

// multibaseBase58btcPrefix is the multibase indicator Ed25519Signature2020
// mandates on proof.proofValue. Any other prefix is a wire-format error.
const multibaseBase58btcPrefix = "z";

export interface VerifyResult {
  // Cryptosuite that produced the verified proof. Discriminator for which
  // signer-key field to read.
  cryptosuite: Cryptosuite;
  // signerDID is the canonical did:pkh URI derived from the
  // verificationMethod, excluding the "#blockchainAccountId" fragment.
  signerDID: string;
  // signerAddress is the lowercase 0x-prefixed EVM-style address recovered
  // from the JWS signature when cryptosuite is
  // EcdsaSecp256k1RecoverySignature2020. Empty string for ed25519.
  signerAddress: string;
  // ed25519PublicKey is the 32-byte ed25519 public key extracted from the
  // verificationMethod DID when cryptosuite is Ed25519Signature2020. null
  // for secp256k1.
  ed25519PublicKey: Uint8Array | null;
  // didNamespace is the lower-case did:pkh namespace the verificationMethod
  // names ("solana" or "stellar" for ed25519; the namespace segment for
  // secp256k1). A network reference such as "testnet" is not unique to one
  // namespace, so didNetwork alone cannot tell a Stellar DID from a Solana
  // one. Mirror of SelfAssertedEd25519Signer.DIDNamespace in verify.go.
  didNamespace: string;
  // didNetwork is the network segment parsed from a did:pkh
  // verificationMethod (the `<network>` in did:pkh:solana:<network>:<pk>).
  // Populated for ed25519; empty for secp256k1. Callers MUST bind it
  // together with didNamespace to the CAIP-2 chain of the source asset and
  // reject mismatches; matchesChain does that for an ed25519 result.
  didNetwork: string;
  // created is the proof.created timestamp as parsed by the JS Date
  // constructor. Callers should reject proofs older than their freshness
  // tolerance.
  created: Date;
}

export interface VerifyOptions {
  // Also accept a secp256k1 proof in the typed form a payer's wallet signs: a signature over the
  // EIP-712 digest of PaymentRequestProof{proofHash, docHash}, taken only when it recovers the
  // signer the document names. Off by default: a wallet shows that typed data as two opaque
  // hashes, so a page that asks for it obtains a valid proof over whatever it hashed. Only a
  // verifier of an originator's own payment request sets it. Mirror of Go
  // VerifyOptions.AcceptPaymentRequestTypedProof.
  acceptPaymentRequestTypedProof?: boolean;
}

// verifyPaymentRequest cryptographically verifies a signed PaymentRequest
// and returns a VerifyResult describing the recovered signer plus
// proof.created.
//
// Dispatches on proof.type:
//   - EcdsaSecp256k1RecoverySignature2020: detached JWS, keccak256,
//     secp256k1 recovery (EVM — chain-canonical address derivation is the
//     caller's responsibility). The wallet-signed typed form is accepted
//     only under options.acceptPaymentRequestTypedProof.
//   - Ed25519Signature2020: multibase-encoded proofValue (z-base58btc),
//     SHA-256 hashes, ed25519 verification against the pubkey embedded in
//     the verificationMethod DID (Solana).
//
// Freshness, whitelist, and per-request authorization checks remain the
// caller's responsibility.
export async function verifyPaymentRequest(
  signedRequest: string | Record<string, unknown>,
  options: VerifyOptions = {}
): Promise<VerifyResult> {
  const doc =
    typeof signedRequest === "string"
      ? (JSON.parse(signedRequest) as Record<string, unknown>)
      : signedRequest;

  const proof = doc.proof as Record<string, unknown> | undefined;
  if (!proof) {
    throw new Error("verify: missing proof block");
  }
  const proofType = String(proof.type ?? "");
  if (proofType === "EcdsaSecp256k1RecoverySignature2020") {
    return await verifySecp256k1(doc, proof, options);
  }
  if (proofType === "Ed25519Signature2020") {
    return await verifyEd25519(doc, proof);
  }
  throw new Error(`verify: unsupported proof.type ${JSON.stringify(proofType)}`);
}

// matchesChain throws unless an ed25519 verification result names the CAIP-2
// chain the request was issued for: the namespace and the network reference
// must both equal the chain's (`solana:devnet`, `stellar:pubnet`). The compare
// is case-insensitive on both parts, as for the DID. A self-asserted key is
// only meaningful bound to the source chain, so a secp256k1 result is refused
// here rather than compared against a recovered address. Mirror of
// SelfAssertedEd25519Signer.MatchesChain in verify.go.
export function matchesChain(
  result: Pick<VerifyResult, "cryptosuite" | "didNamespace" | "didNetwork">,
  caip2: string
): void {
  if (result.cryptosuite !== "Ed25519Signature2020") {
    throw new Error(`verify: matchesChain applies to ed25519 results, got ${result.cryptosuite}`);
  }
  const cut = caip2.indexOf(":");
  const namespace = cut === -1 ? "" : caip2.slice(0, cut);
  const reference = cut === -1 ? "" : caip2.slice(cut + 1);
  if (namespace === "" || reference === "") {
    throw new Error(`verify: source chain ${JSON.stringify(caip2)} is not a CAIP-2 identifier`);
  }
  if (result.didNamespace.toLowerCase() !== namespace.toLowerCase()) {
    throw new Error(
      `verify: verificationMethod namespace ${JSON.stringify(result.didNamespace)} does not match source chain ${JSON.stringify(caip2)}`
    );
  }
  if (result.didNetwork.toLowerCase() !== reference.toLowerCase()) {
    throw new Error(
      `verify: verificationMethod network ${JSON.stringify(result.didNetwork)} does not match source chain ${JSON.stringify(caip2)}`
    );
  }
}

async function verifySecp256k1(
  doc: Record<string, unknown>,
  proof: Record<string, unknown>,
  options: VerifyOptions
): Promise<VerifyResult> {
  const created = parseRequiredString(proof, "created");
  const verificationMethod = parseRequiredString(proof, "verificationMethod");
  const proofPurpose = parseRequiredString(proof, "proofPurpose");
  validateProofPurpose(proofPurpose);
  const jws = parseRequiredString(proof, "jws");

  const hashes = await canonicalHashes(
    doc,
    proof,
    "EcdsaSecp256k1RecoverySignature2020"
  );

  const { signature } = parseDetachedJws(jws);
  if (signature.length !== 65) {
    throw new Error(`verify: JWS signature length = ${signature.length}, want 65`);
  }
  const { network, address: claimedAddress } = parseDIDPKH(verificationMethod);

  // The raw form signs signingInput, the 32-byte keccak256(proofHash || docHash). Where the
  // caller accepts it, a wallet's typed form, PaymentRequestProof{proofHash, docHash} under the
  // payment request domain, over the same two hashes. The typed form is taken only when it
  // recovers the signer the document names; otherwise the raw signer stands, and the binding below
  // refuses it as before. The recovery takes v ∈ {0, 1, 27, 28} (W3C/ethers alignment) and
  // refuses any other v, as Go does.
  const recovered = recoverSecp256k1ProofSignerFrom(
    hashes,
    signature,
    (a) => a.toLowerCase() === claimedAddress.toLowerCase(),
    options.acceptPaymentRequestTypedProof === true ? [paymentRequestProofTypedDigest] : []
  ).toLowerCase();

  // Bind the recovered signer to the one the document CLAIMS.
  //
  // Recovery cannot fail: altering the payload does not invalidate the signature, it recovers a
  // different address. Returning both values unbound meant a tampered document verified
  // "successfully" while signerDID still named the honest signer — and signerDID is the field a
  // caller naturally trusts, because it is a DID. Anyone reading it saw the original signer
  // while holding altered bytes.
  //
  // Checking here makes the two fields incapable of disagreeing, so the flat shape is safe to
  // read. The Go half reaches the same place differently, by exposing ONLY the recovered
  // address in a sealed type. Note this binding is meaningful for recovery suites alone: an
  // Ed25519Signature2020 proof is verified against a key taken from the document itself, so it
  // stays self-asserted and the caller must still bind it to a trusted source.
  const claimed = claimedAddress.toLowerCase();
  if (claimed !== recovered) {
    throw new Error(
      `verify: signature recovers ${recovered} but the document claims ${claimed} — ` +
        `the document has been altered since it was signed`
    );
  }

  return {
    cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
    signerDID: stripDIDFragment(verificationMethod),
    signerAddress: recovered,
    ed25519PublicKey: null,
    didNamespace: network.toLowerCase(),
    didNetwork: network,
    created: new Date(created),
  };
}

async function verifyEd25519(
  doc: Record<string, unknown>,
  proof: Record<string, unknown>
): Promise<VerifyResult> {
  const created = parseRequiredString(proof, "created");
  const verificationMethod = parseRequiredString(proof, "verificationMethod");
  const proofPurpose = parseRequiredString(proof, "proofPurpose");
  validateProofPurpose(proofPurpose);
  const proofValue = parseRequiredString(proof, "proofValue");

  // Strict 'z' (base58btc) prefix — Ed25519Signature2020 mandates it.
  if (!proofValue.startsWith(multibaseBase58btcPrefix)) {
    throw new Error(
      `verify: proof.proofValue prefix = ${JSON.stringify(proofValue.slice(0, 1))}, want ${JSON.stringify(multibaseBase58btcPrefix)}`
    );
  }
  const sig = bs58.decode(proofValue.slice(1));
  if (sig.length !== 64) {
    throw new Error(`verify: ed25519 signature length = ${sig.length}, want 64`);
  }

  const { pubkey, namespace, network } = parseEd25519DIDPKH(verificationMethod);

  const signingInput = await canonicalSigningInput(
    doc,
    proof,
    "Ed25519Signature2020"
  );

  // The proof signs the raw signingInput or its ed25519ProofMessage text.
  if (!verifyEd25519Proof(pubkey, signingInput, sig)) {
    throw new Error("verify: ed25519 signature verification failed");
  }

  return {
    cryptosuite: "Ed25519Signature2020",
    signerDID: stripDIDFragment(verificationMethod),
    signerAddress: "",
    ed25519PublicKey: pubkey,
    didNamespace: namespace,
    didNetwork: network,
    created: new Date(created),
  };
}

// canonicalSigningInput reconstructs the exact bytes the signer committed
// to: it reads created/verificationMethod/proofPurpose and the @context
// verbatim from the wire proof, then runs hashPaymentRequest for the
// matching cryptosuite. Mirror of the Go canonicalSigningInput (verify.go).
export async function canonicalSigningInput(
  doc: Record<string, unknown>,
  proof: Record<string, unknown>,
  cryptosuite: Cryptosuite
): Promise<Uint8Array> {
  return (await canonicalHashes(doc, proof, cryptosuite)).signingInput;
}

// canonicalHashes is canonicalSigningInput with the proof and document hashes it is made of,
// which the typed form signs.
async function canonicalHashes(
  doc: Record<string, unknown>,
  proof: Record<string, unknown>,
  cryptosuite: Cryptosuite
): Promise<HashResult> {
  const created = parseRequiredString(proof, "created");
  const verificationMethod = parseRequiredString(proof, "verificationMethod");
  const proofPurpose = parseRequiredString(proof, "proofPurpose");

  return await hashPaymentRequest(doc, {
    cryptosuite,
    proofOptions: {
      type: cryptosuite,
      created,
      verificationMethod,
      proofPurpose,
    },
    // Pass the wire @context verbatim. A signer that emits a non-canonical-
    // but-equivalent shape MUST canonicalize to the same n-quads here, and
    // the only safe way to guarantee that is to feed the same @context
    // bytes into URDNA2015. Falls back to the canonical suite IRI when the
    // wire dropped @context.
    proofContext: proof["@context"] ?? suiteContextUrl(cryptosuite),
  });
}

function suiteContextUrl(cryptosuite: Cryptosuite): string {
  return cryptosuite === "Ed25519Signature2020"
    ? ED25519_2020_CONTEXT_URL
    : SECP256K1_RECOVERY_CONTEXT_URL;
}

function parseRequiredString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v === "") {
    throw new Error(`verify: missing or non-string proof.${key}`);
  }
  return v;
}

function validateProofPurpose(p: string): void {
  if (p !== expectedProofPurpose) {
    throw new Error(
      `verify: proof.proofPurpose = ${JSON.stringify(p)}, want ${JSON.stringify(expectedProofPurpose)}`
    );
  }
}

// parseDIDPKH parses a did:pkh-shaped verificationMethod of the form
// did:pkh:<namespace>:<reference>:<account>#<fragment> and returns the
// account portion plus the namespace (e.g. "eip155").
function parseDIDPKH(vm: string): { address: string; network: string } {
  const hashIdx = vm.indexOf("#");
  const base = hashIdx === -1 ? vm : vm.slice(0, hashIdx);
  if (!base.toLowerCase().startsWith("did:pkh:")) {
    throw new Error(`verify: verificationMethod not did:pkh: ${vm}`);
  }
  const parts = base.slice("did:pkh:".length).split(":");
  if (parts.length < 3) {
    throw new Error(`verify: malformed did:pkh: ${vm}`);
  }
  const namespace = parts[0];
  const account = parts[parts.length - 1];
  return { address: account, network: namespace };
}

// parseEd25519DIDPKH extracts the ed25519 public key from a
// did:pkh:solana:<network>:<base58-pubkey>#<fragment>-shaped DID, or a
// did:pkh:stellar:<network>:<G-account>#<fragment> one. Mirror of
// publicKeyFromVerificationMethod in verify.go.
function parseEd25519DIDPKH(vm: string): { pubkey: Uint8Array; namespace: string; network: string } {
  const hashIdx = vm.indexOf("#");
  const base = hashIdx === -1 ? vm : vm.slice(0, hashIdx);
  if (!base.toLowerCase().startsWith("did:pkh:")) {
    throw new Error(`verify: verificationMethod not did:pkh: ${vm}`);
  }
  const parts = base.slice("did:pkh:".length).split(":");
  // After stripping "did:pkh:", the form is <ns>:<network>:<pk> — three
  // colon-separated segments.
  if (parts.length !== 3) {
    throw new Error(`verify: ed25519 verificationMethod must be did:pkh:<ns>:<network>:<pk>, got ${vm}`);
  }
  // Namespace is case-insensitive in the W3C spec; the Go verifier
  // normalizes via strings.EqualFold.
  const namespace = parts[0].toLowerCase();
  if (namespace !== "solana" && namespace !== "stellar") {
    throw new Error(`verify: ed25519 namespace must be solana or stellar, got ${parts[0]}`);
  }
  const network = parts[1];
  if (network === "") {
    throw new Error("verify: ed25519 did:pkh network segment empty");
  }
  const address = parts[2];
  const pubkey = namespace === "stellar" ? decodeStellarAccount(address) : bs58.decode(address);
  if (pubkey.length !== 32) {
    throw new Error(`verify: ed25519 pubkey length = ${pubkey.length}, want 32`);
  }
  return { pubkey, namespace, network };
}

// stripDIDFragment removes the "#<fragment>" suffix from a DID so the
// returned signerDID is a bare did:pkh URI suitable for trust-anchor
// list lookups.
function stripDIDFragment(did: string): string {
  const hashIdx = did.indexOf("#");
  return hashIdx === -1 ? did : did.slice(0, hashIdx);
}
