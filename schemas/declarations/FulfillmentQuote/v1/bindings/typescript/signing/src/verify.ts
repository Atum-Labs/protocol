// Public verifier for W3C Data Integrity-signed FulfillmentQuotes.
// Mirror of schemas/declarations/FulfillmentQuote/v1/signing/go/verify.go;
// any divergence in the dispatch order, error-fail-closed posture, or
// per-cryptosuite rules would let one verifier on the network accept a
// quote the other rejects.
//
// The signing-input reconstruction goes through hashQuote so the verifier
// and signer share a single implementation per cryptosuite.

import bs58 from "bs58";
import nacl from "tweetnacl";

import { recoverSecp256k1ProofSigner } from "@atum-labs/ld-data-integrity";

import { hashQuote, type Cryptosuite, type HashResult } from "./hash.js";
import { parseDetachedJws } from "./jws.js";
import {
  SECP256K1_RECOVERY_CONTEXT_URL,
  ED25519_2020_CONTEXT_URL,
} from "./canonicalize.js";
import { decodeStellarAccount } from "./strkey.js";
import { matchesSecp256k1DID } from "./verify-vp.js";

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
  // Cryptosuite that produced the verified proof. Discriminator for
  // which signer-key field to read.
  cryptosuite: Cryptosuite;
  // signerDID is the canonical did:pkh URI derived from the recovered
  // signer (secp256k1) or extracted from the verificationMethod (ed25519).
  // Excludes the "#blockchainAccountId" fragment.
  signerDID: string;
  // signerAddress is the lowercase 0x-prefixed EVM-style address recovered
  // from the JWS signature when cryptosuite is EcdsaSecp256k1RecoverySignature2020.
  // Empty string for ed25519.
  signerAddress: string;
  // ed25519PublicKey is the 32-byte ed25519 public key extracted from
  // the verificationMethod DID when cryptosuite is Ed25519Signature2020.
  // null for secp256k1.
  ed25519PublicKey: Uint8Array | null;
  // didNetwork is the network segment parsed from a did:pkh
  // verificationMethod (the `<network>` in did:pkh:solana:<network>:<pk>).
  // Populated for ed25519 cryptosuites; empty for secp256k1, where the
  // verificationMethod's network field isn't required to encode a chain
  // reference. Callers MUST compare this against the CAIP-2 reference
  // of the source asset and reject mismatches.
  didNetwork: string;
  // created is the proof.created timestamp as parsed by the JS Date
  // constructor. Callers should reject proofs older than their
  // freshness tolerance.
  created: Date;
}

// verifyQuote cryptographically verifies a signed FulfillmentQuote and
// returns a VerifyResult describing the recovered signer plus proof.created.
//
// Dispatches on proof.type:
//   - EcdsaSecp256k1RecoverySignature2020: detached JWS, keccak256,
//     secp256k1 recovery (EVM + Tron — same primitive, chain-canonical
//     address derivation is the caller's responsibility).
//   - Ed25519Signature2020: multibase-encoded proofValue (z-base58btc),
//     SHA-256 hashes, ed25519 verification against the pubkey embedded
//     in the verificationMethod DID (Solana).
//
// Freshness, whitelist, and per-request authorization checks remain the
// caller's responsibility.
export async function verifyQuote(
  signedQuote: string | Record<string, unknown>
): Promise<VerifyResult> {
  const doc =
    typeof signedQuote === "string"
      ? (JSON.parse(signedQuote) as Record<string, unknown>)
      : signedQuote;

  const proof = doc.proof as Record<string, unknown> | undefined;
  if (!proof) {
    throw new Error("verify: missing proof block");
  }
  const proofType = String(proof.type ?? "");
  if (proofType === "EcdsaSecp256k1RecoverySignature2020") {
    return await verifySecp256k1(doc, proof);
  }
  if (proofType === "Ed25519Signature2020") {
    return await verifyEd25519(doc, proof);
  }
  throw new Error(`verify: unsupported proof.type ${JSON.stringify(proofType)}`);
}

async function verifySecp256k1(
  doc: Record<string, unknown>,
  proof: Record<string, unknown>
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
  // Accepts the legacy signingInput digest or a SettlerProof typed signature
  // over the same hashes; the caller still compares the returned signer.
  const recovered = recoverSecp256k1ProofSigner(hashes, signature, (a) =>
    matchesSecp256k1DID(a, verificationMethod)
  ).toLowerCase();

  // Mirror Go's verifySecp256k1 (verify.go) "caller validates" posture:
  // return the recovered EVM-style address and the DID network; let the
  // caller compare against the verificationMethod's address segment using
  // chain-canonical derivation. The previous internal lowercase-equality
  // check was strictly stricter than Go AND wrong for non-EVM secp256k1:
  // Tron uses did:pkh:tron:mainnet:T<base58check>, so the recovered 0x...
  // hex was never lowercase-equal to the verificationMethod's address
  // segment and every valid Tron signature was rejected.
  const { network } = parseDIDPKH(verificationMethod);

  return {
    cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
    signerDID: stripDIDFragment(verificationMethod),
    signerAddress: recovered,
    ed25519PublicKey: null,
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
  // Loosening this (e.g. accepting 'm' base64 or any prefix) would
  // silently widen the trust surface.
  if (!proofValue.startsWith(multibaseBase58btcPrefix)) {
    throw new Error(
      `verify: proof.proofValue prefix = ${JSON.stringify(proofValue.slice(0, 1))}, want ${JSON.stringify(multibaseBase58btcPrefix)}`
    );
  }
  const sig = bs58.decode(proofValue.slice(1));
  if (sig.length !== 64) {
    throw new Error(`verify: ed25519 signature length = ${sig.length}, want 64`);
  }

  const { pubkey, network } = parseEd25519DIDPKH(verificationMethod);

  const signingInput = await canonicalSigningInput(
    doc,
    proof,
    "Ed25519Signature2020"
  );

  if (!nacl.sign.detached.verify(signingInput, sig, pubkey)) {
    throw new Error("verify: ed25519 signature verification failed");
  }

  return {
    cryptosuite: "Ed25519Signature2020",
    signerDID: stripDIDFragment(verificationMethod),
    signerAddress: "",
    ed25519PublicKey: pubkey,
    didNetwork: network,
    created: new Date(created),
  };
}

// canonicalSigningInput reconstructs the exact bytes the signer committed
// to for a signed quote: it reads created/verificationMethod/proofPurpose
// and the @context verbatim from the wire proof, then runs hashQuote for the
// matching cryptosuite.
//
// It is the single source of the signing input shared by verifyQuote (which
// recovers the signer from it) and computeQuoteHash (which content-addresses
// it). Routing both through here is what makes the content-addressed
// quote_hash parity-correct by construction: it can never disagree with the
// bytes the verifier — and therefore the signer — actually committed to.
//
// Exported for computeQuoteHash; intentionally NOT re-exported from lib.ts,
// so it stays internal to the package. Mirror of the Go canonicalSigningInput
// (verify.go).
export async function canonicalSigningInput(
  doc: Record<string, unknown>,
  proof: Record<string, unknown>,
  cryptosuite: Cryptosuite
): Promise<Uint8Array> {
  return (await canonicalHashes(doc, proof, cryptosuite)).signingInput;
}

// canonicalHashes is canonicalSigningInput plus the proofHash and docHash it was composed from.
async function canonicalHashes(
  doc: Record<string, unknown>,
  proof: Record<string, unknown>,
  cryptosuite: Cryptosuite
): Promise<HashResult> {
  const created = parseRequiredString(proof, "created");
  const verificationMethod = parseRequiredString(proof, "verificationMethod");
  const proofPurpose = parseRequiredString(proof, "proofPurpose");

  return hashQuote(doc, {
    cryptosuite,
    proofOptions: {
      type: cryptosuite,
      created,
      verificationMethod,
      proofPurpose,
    },
    // Pass the wire @context verbatim. A signer that emits a non-canonical-
    // but-equivalent shape (string vs single-element array, a future extra
    // context, etc.) MUST canonicalize to the same n-quads here, and the
    // only safe way to guarantee that is to feed the same @context bytes
    // into URDNA2015. Falls back to the canonical suite IRI when the wire
    // dropped @context (a verifier then fails for a real reason rather than
    // a verifier/signer wire-shape disagreement).
    proofContext: proof["@context"] ?? suiteContextUrl(cryptosuite),
  });
}

// suiteContextUrl maps a cryptosuite to its canonical proof @context IRI,
// used as the fallback when the wire proof omits @context.
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
// account portion plus the namespace (e.g. "eip155"). Used for the
// secp256k1 path where the namespace can be eip155 or other EVM-aligned
// chains.
function parseDIDPKH(vm: string): { address: string; network: string } {
  // Drop the fragment.
  const hashIdx = vm.indexOf("#");
  const base = hashIdx === -1 ? vm : vm.slice(0, hashIdx);
  if (!base.toLowerCase().startsWith("did:pkh:")) {
    throw new Error(`verify: verificationMethod not did:pkh: ${vm}`);
  }
  const parts = base.slice("did:pkh:".length).split(":");
  if (parts.length < 3) {
    throw new Error(`verify: malformed did:pkh: ${vm}`);
  }
  // did:pkh:<namespace>:<reference>:<account>
  // For eip155 this gives namespace=eip155, reference=<chainId>, account=<addr>.
  const namespace = parts[0] ?? "";
  const account = parts[parts.length - 1] ?? "";
  return { address: account, network: namespace };
}

// parseEd25519DIDPKH extracts the ed25519 public key from a
// did:pkh:solana:<network>:<base58-pubkey>#<fragment>-shaped DID, or a
// did:pkh:stellar:<network>:<G-account>#<fragment> one. The pubkey is
// decoded and asserted to be 32 bytes; anything else is a wire-format
// error. Mirror of publicKeyFromVerificationMethod in verify.go.
function parseEd25519DIDPKH(vm: string): { pubkey: Uint8Array; network: string } {
  const hashIdx = vm.indexOf("#");
  const base = hashIdx === -1 ? vm : vm.slice(0, hashIdx);
  if (!base.toLowerCase().startsWith("did:pkh:")) {
    throw new Error(`verify: verificationMethod not did:pkh: ${vm}`);
  }
  const parts = base.slice("did:pkh:".length).split(":");
  // After stripping "did:pkh:", the form is <ns>:<network>:<pk> — three
  // colon-separated segments. The earlier off-by-one (length !== 4) treated
  // "did:pkh:solana:devnet:<pk>" as malformed even though it's the canonical
  // shape on the Go side; tests caught it.
  if (parts.length !== 3) {
    throw new Error(`verify: ed25519 verificationMethod must be did:pkh:<ns>:<network>:<pk>, got ${vm}`);
  }
  // Namespace is intentionally case-insensitive in the W3C spec; the Go
  // verifier normalizes via strings.EqualFold. We lowercase here and
  // rely on the test suite to pin the case-insensitivity invariant.
  const namespace = parts[0]?.toLowerCase();
  if (namespace !== "solana" && namespace !== "stellar") {
    throw new Error(`verify: ed25519 namespace must be solana or stellar, got ${parts[0]}`);
  }
  const network = parts[1] ?? "";
  if (network === "") {
    throw new Error("verify: ed25519 did:pkh network segment empty");
  }
  const address = parts[2] ?? "";
  const pubkey = namespace === "stellar" ? decodeStellarAccount(address) : bs58.decode(address);
  if (pubkey.length !== 32) {
    throw new Error(`verify: ed25519 pubkey length = ${pubkey.length}, want 32`);
  }
  return { pubkey, network };
}

// stripDIDFragment removes the "#<fragment>" suffix from a DID so the
// returned signerDID is a bare did:pkh URI suitable for trust-anchor
// list lookups (e.g. against a trusted-issuers registry).
function stripDIDFragment(did: string): string {
  const hashIdx = did.indexOf("#");
  return hashIdx === -1 ? did : did.slice(0, hashIdx);
}
