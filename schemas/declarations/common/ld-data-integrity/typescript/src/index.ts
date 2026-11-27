// Public surface of @atum-labs/ld-data-integrity. The TypeScript mirror
// of the Go data-integrity library — both halves expose the same primitive
// list and MUST stay byte-equal on canonical n-quads + hash composition
// + JWS framing + multibase proofValue encoding or the cross-language
// signing round trip silently breaks.

export {
  DocumentLoader,
  newDocumentLoader,
  w3cVCv1FullVendoredSnapshot,
  W3C_VC_V1_CONTEXT_URL,
  SECP256K1_RECOVERY_2020_V2_CTX_URL,
  ED25519_SIGNATURE_2020_V1_CTX_URL,
  KNOWN_TO_ATUM_V1_CONTEXT_URL,
  KNOWN_TO_ATUM_V2_CONTEXT_URL,
} from "./documentLoader.js";

export { canonicalize } from "./canonicalize.js";

export {
  AdmissionError,
  checkCanonicalizable,
  MAX_ADMITTED_VALUES,
  MAX_ADMITTED_BYTES,
  MAX_ADMITTED_BLANK_NODES,
} from "./admission.js";
export type { AdmissionRule } from "./admission.js";

export {
  hashDocument,
  CRYPTOSUITE_SECP256K1_RECOVERY_2020,
  CRYPTOSUITE_ED25519_SIGNATURE_2020,
} from "./hash.js";
export type {
  Cryptosuite,
  ProofOptions,
  HashOptions,
  HashResult,
} from "./hash.js";

export { computeContentHash } from "./content-hash.js";

export { buildSecp256k1JWS, parseSecp256k1JWS } from "./jws.js";
export type { JWSHeader } from "./jws.js";

export { recoverSecp256k1Signer, secp256k1ESRecoveryFromDER } from "./recovery.js";

export {
  SETTLER_IDENTITY_DOMAIN,
  SETTLER_PROOF_TYPES,
  WALLET_PROOF_TYPES,
  settlerProofTypedDigest,
  walletProofTypedDigest,
  recoverSecp256k1ProofSigner,
} from "./settler-identity.js";
export type { Secp256k1ProofHashes } from "./settler-identity.js";

export {
  PAYMENT_REQUEST_DOMAIN,
  PAYMENT_REQUEST_PROOF_TYPES,
  PAYMENT_REQUEST_ENVELOPE_PROOF_TYPES,
  PAYMENT_REQUEST_ENVELOPE_TYPE,
  paymentRequestProofTypedData,
  paymentRequestEnvelopeProofTypedData,
  paymentRequestProofTypedDigest,
  paymentRequestEnvelopeProofTypedDigest,
  recoverSecp256k1ProofSignerFrom,
  signTypedProof,
} from "./payment-request-proof.js";
export type {
  TypedDataSigner,
  TypedProofDigest,
  TypedProofRequest,
} from "./payment-request-proof.js";

export {
  encodeEd25519ProofValue,
  decodeEd25519ProofValue,
  signEd25519,
  verifyEd25519,
  ed25519ProofMessage,
  verifyEd25519Proof,
  ED25519_PROOF_MESSAGE_PREFIX,
} from "./ed25519.js";

export {
  UnknownContextError,
  MalformedProofError,
  SignatureRecoveryError,
  Ed25519VerifyError,
  UnsupportedProofTypeError,
} from "./errors.js";
