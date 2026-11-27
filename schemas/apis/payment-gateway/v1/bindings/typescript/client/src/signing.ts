// The three signatures a PaymentRequest carries, as one opt-in entry point.
//
// Separate from the package root so the JSON-LD stack these depend on -- jsonld, rdf-canonize, an
// http-client and canonicalize -- is only pulled in by a consumer that actually signs. Importing
// the root should not cost a caller an Apache-2.0 NOTICE obligation for code it never calls.
//
// Which one you want depends on WHAT you are signing, and choosing wrong is the mistake this
// naming exists to prevent:
//
//   sender_auth.signed_messages[]  ->  signPaymentRequest (from the package root)  moves funds
//   the document's proof           ->  signDeclaration                             attests it
//   the presentation               ->  buildEnvelope                               identifies you
//   a session nonce                ->  signSessionPresentation                     earns a token
//
// None substitutes for another. See docs/signing.md.

// The PaymentRequest DOCUMENT signature (W3C Data Integrity over the URDNA2015-canonicalized
// request), distinct from signPaymentRequest above, which fills sender_auth and authorizes the
// on-chain transfer. Named signDeclaration because the upstream package also calls its function
// signPaymentRequest: that collision is the conflation this naming avoids, and it matches
// SignDeclaration in the Go client.
export {
  signDeclaration,
  verifyDeclaration,
  computeRequestHash,
  signerFromEthersWallet,
} from './declaration-signing';

// The originator's IDENTITY envelope — the third signature. Neither signPaymentRequest (which
// authorizes the transfer) nor signDeclaration (which attests the document) identifies anyone.
export {
  buildEnvelope,
  buildEnvelopeForAccount,
  didForAccount,
  verificationMethodForAccount,
  PAYMENT_REQUEST_ENVELOPE_CONTEXT_URL,
  PAYMENT_REQUEST_ENVELOPE_TYPE,
} from './envelope-signing';
export type {
  BuildEnvelopeOptions,
  EnvelopeSigner,
  SignedPaymentRequestEnvelope,
} from './envelope-signing';
export type {
  SignedDeclaration,
  SignDeclarationOptions,
  VerifyDeclarationResult,
  VerifiedDeclarationSigner,
  DeclarationSigner,
} from './declaration-signing';

// The session presentation: answers one nonce from the authorization service, in exchange for a
// short-lived token that identifies the holder to the Payment Gateway. It signs no request and
// moves no funds. requestSessionToken does the whole exchange; createSessionTokenSource keeps a
// token current for a long-running client, bound by default to a key it holds (DPoP).
export {
  signSessionPresentation,
  requestSessionToken,
  createSessionTokenSource,
  createDPoPKey,
  createDPoPProof,
  SessionTokenError,
  DEFAULT_SESSION_TIMEOUT_MS,
  DEFAULT_RENEW_BEFORE_MS,
  DEFAULT_RETRY_AFTER_MS,
  DEFAULT_MAX_WAIT_MS,
} from './session-token';
export type {
  SessionNonce,
  SignedSessionPresentation,
  SignSessionPresentationOptions,
  RequestSessionTokenOptions,
  SessionToken,
  SessionFetch,
  SessionTokenSource,
  SessionTokenSourceOptions,
  DPoPKey,
  DPoPProofClaims,
} from './session-token';

// Checking a collected quote before awarding it: the settler's signature, and that quote_id is
// the quote's hash. Here rather than at the root because it canonicalizes the quote with JSON-LD.
export { verifyFulfillmentQuote } from './quote-verify';
export type { FulfillmentQuoteVerification } from './quote-verify';

// Checking what a sender_auth signature actually commits to, BEFORE signing it. The signing
// path is deliberately blind — signPaymentRequest signs every signed_messages[] entry exactly
// as given — so the check that makes blind signing safe has to be reachable from this package.
// The workspace sibling implementing it is INLINED into this bundle (tsup noExternal) and is
// not separately installable, so without this re-export the mitigation documented in
// docs/signing.md cannot be performed by any consumer at all.
export {
  verifyPaymentRequest,
  verifyPaymentRequestJSON,
  verifyRequestCommitment,
  commitmentResultOf,
} from './sender-auth-verify';
// The types travel with the function. Exporting one without the others forces a consumer who
// stores the result, or builds `expectations` as a named value, to import from two paths for
// one call — and import paths are the hardest thing to change once the API is public.
export type {
  VerifyResult,
  VerifyPaymentRequestExpectations,
  VerifiedSenderAuth,
  ParsedPermit,
  AuthTerms,
  CommitmentOutcome,
  CommitmentResult,
  SolanaDomain,
} from './sender-auth-verify';
