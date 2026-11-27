// Public library entry point. Consumers of @atum-labs/ld-signing import
// from here; the CLI binary at index.ts wraps these exports.
export { signQuote } from "./sign.js";
export type { SignedFulfillmentQuote, SignOptions } from "./sign.js";
export { signQuoteEd25519 } from "./sign-ed25519.js";
export type { SignedFulfillmentQuoteEd25519, SignEd25519Options } from "./sign-ed25519.js";
export { signVP, signVPWithSigner, signVPWithTypedDataSigner } from "./sign-vp.js";
export type { TypedDataSigner } from "@atum-labs/ld-data-integrity";
export type { VPDigestSigner } from "./sign-vp.js";
export type { SignedFulfillmentQuoteEnvelope, SignVPOptions } from "./sign-vp.js";
// Re-export signVP's input credential type so envelope producers (e.g. the PRE
// builder in tests/e2e) can type their VC arrays without reaching into the
// FulfillmentQuoteEnvelope binding directly.
export type { VerifiableCredential } from "@atum-labs/schema-declarations/FulfillmentQuoteEnvelope/v1/bindings/typescript";
export { signVPEd25519 } from "./sign-vp-ed25519.js";
export type {
  SignedFulfillmentQuoteEnvelopeEd25519,
  SignVPEd25519Options,
} from "./sign-vp-ed25519.js";
export { signVCProofSecp256k1, signVCProofEd25519 } from "./sign-vc.js";
export type {
  SignVCProofSecp256k1Options,
  SignVCProofEd25519Options,
} from "./sign-vc.js";
export { verifyQuote } from "./verify.js";
export type { VerifyResult } from "./verify.js";
export { recoverSigner } from "./recover.js";
export { verifyVP, recoverHolder, matchesSecp256k1DID } from "./verify-vp.js";
export type {
  VerifyVPOptions,
  VPResult,
  IsIssuerTrustedFunc,
} from "./verify-vp.js";
export { verifyVCProof, VPVCProofError } from "./verify-vc.js";
export type {
  IssuerKeyResolver,
  VerificationMethod,
  VerificationMethodSet,
  VerifyVCProofOptions,
  VPVCProofErrorReason,
} from "./verify-vc.js";
export {
  DIDWebResolver,
  DIDWebResolverError,
  loadOverridesFromEnv,
} from "./did-web-resolver.js";
export type {
  DIDWebResolverOptions,
  DIDWebResolverErrorReason,
} from "./did-web-resolver.js";
export { hashQuote } from "./hash.js";
export { computeQuoteHash } from "./quote-hash.js";
export type {
  Cryptosuite,
  HashableProofOptions,
  HashQuoteOptions,
  HashResult,
} from "./hash.js";
export {
  canonicalize,
  FULFILLMENT_QUOTE_CONTEXT_URL,
  FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL,
  W3C_VC_V1_CONTEXT_URL,
  SECP256K1_RECOVERY_CONTEXT_URL,
  ED25519_2020_CONTEXT_URL,
} from "./canonicalize.js";
export { createDetachedJws, parseDetachedJws } from "./jws.js";
