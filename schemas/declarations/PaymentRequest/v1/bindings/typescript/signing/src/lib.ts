// Public library entry point. Consumers of
// @atum-labs/payment-request-ld-signing import from here.
export {
  signPaymentRequest,
  signPaymentRequestWithSigner,
  signPaymentRequestWithTypedDataSigner,
} from "./sign.js";
export type { TypedDataSigner } from "@atum-labs/ld-data-integrity";
export { signerFromEthersWallet } from "./signer.js";
export type { DeclarationSigner, EthersWalletLike } from "./signer.js";
export type { SignedPaymentRequest, SignOptions } from "./sign.js";
export { signPaymentRequestEd25519 } from "./sign-ed25519.js";
export type {
  SignedPaymentRequestEd25519,
  SignEd25519Options,
} from "./sign-ed25519.js";
export { verifyPaymentRequest, matchesChain } from "./verify.js";
export type { VerifyOptions, VerifyResult } from "./verify.js";
export { hashPaymentRequest } from "./hash.js";
export type {
  Cryptosuite,
  HashableProofOptions,
  HashPaymentRequestOptions,
  HashResult,
} from "./hash.js";
export { computeRequestHash } from "./request-hash.js";
export {
  canonicalize,
  PAYMENT_REQUEST_CONTEXT_URL,
  SECP256K1_RECOVERY_CONTEXT_URL,
  ED25519_2020_CONTEXT_URL,
} from "./canonicalize.js";
export { createDetachedJws, parseDetachedJws } from "./jws.js";
