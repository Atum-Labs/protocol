package ldverification

import (
	"errors"
	"fmt"
)

// ErrMalformedProof is the umbrella sentinel for every "the caller's
// quote is the wrong shape" error returned by Verify. Callers that need
// to dispatch malformed-request (HTTP 400) vs auth-failure (HTTP 401)
// can use a single errors.Is(err, ErrMalformedProof) check; the more
// specific sentinels below are wrap targets for finer-grained logging
// or client-facing error codes.
//
// Errors that mean "the bytes don't authenticate" (recovery failures,
// canonicalization-then-mismatch failures, ed25519.Verify returning
// false) deliberately do NOT wrap any of these — they're auth-class and
// must stay 401.
var ErrMalformedProof = errors.New("malformed proof")

var (
	// ErrMissingProof: the FulfillmentQuote has no proof block at all.
	ErrMissingProof = fmt.Errorf("%w: missing proof", ErrMalformedProof)

	// ErrUnsupportedProofType: proof.type is not a cryptosuite this
	// verifier accepts, or proof.proofPurpose is not assertionMethod.
	ErrUnsupportedProofType = fmt.Errorf("%w: unsupported proof type", ErrMalformedProof)

	// ErrMissingSignatureMaterial: the proof carries no signature bytes
	// — proof.jws empty (secp256k1 path) or proof.proofValue empty
	// (ed25519 path).
	ErrMissingSignatureMaterial = fmt.Errorf("%w: missing signature material", ErrMalformedProof)

	// ErrMalformedSignatureMaterial: the signature bytes were present
	// but structurally invalid — JWS envelope unparseable, multibase
	// prefix wrong, ed25519 signature length wrong, base58 decode
	// failure, etc. Distinct from ErrMissingSignatureMaterial because
	// the caller intended to provide a signature but mangled the
	// encoding.
	ErrMalformedSignatureMaterial = fmt.Errorf("%w: malformed signature material", ErrMalformedProof)

	// ErrMalformedQuote: top-level document parse failure, or
	// verificationMethod / @context shape errors that prevent
	// canonicalization from running. These are document-level, not
	// signature-level.
	ErrMalformedQuote = fmt.Errorf("%w: malformed quote", ErrMalformedProof)

	// ErrAmbiguousMember: an object in the document names a member twice,
	// exactly or under the case folding encoding/json applies to member
	// names. The typed reads would see one of the two and the proofs cover
	// only the exact names a context defines, so the document is refused
	// before anything reads it. It is a malformed document: errors.Is
	// matches ErrMalformedQuote too.
	ErrAmbiguousMember = fmt.Errorf("%w: ambiguous member", ErrMalformedQuote)
)

// ErrSignerChainMismatch: a verified ed25519 signer's did:pkh namespace or
// network reference does not match the CAIP-2 chain the caller expected
// (SelfAssertedEd25519Signer.MatchesChain). It is an authorization refusal,
// not a malformed document, so it does not wrap ErrMalformedProof.
var ErrSignerChainMismatch = errors.New("signer chain mismatch")

// VP-specific sentinels. Callers use errors.Is for metric
// dimensions / structured log fields without grepping error strings.
// All wrap ErrMalformedProof so the umbrella `errors.Is(err,
// ErrMalformedProof)` check the FQ verifier callers already use stays
// behavior-preserving for VP failures too.
var (
	// ErrVPSignerHolderMismatch: the recovered signer of the VP proof
	// did NOT resolve to the address segment of envelope.Holder. This
	// is the load-bearing holder-binding check — without it, an
	// attacker can write the victim's DID in envelope.Holder, sign
	// with their own key, and the verifier would accept as long as the
	// caller-supplied ExpectedHolder also says victim. The check is
	// chain-aware: case-insensitive on the eip155 hex address (EIP-55
	// checksumming is optional and the same address can appear in
	// mixed or all-lowercase form), exact byte-compare on solana
	// base58 and tron base58check (those encodings ARE case-sensitive
	// — case-fold there would collapse two distinct accounts).
	ErrVPSignerHolderMismatch = fmt.Errorf("%w: VP signer/holder mismatch", ErrMalformedProof)

	// ErrVPVerificationMethodMismatch: the ed25519 proof's verificationMethod
	// names a different did:pkh namespace or network reference than
	// envelope.Holder (solana:devnet holder, stellar:devnet or solana:mainnet
	// method). The key bytes may be the same, so this is a mislabelled signer
	// rather than impersonation, but a reference such as "devnet" is not unique
	// to one namespace and a consumer reading the proof's signer label must not
	// see a chain the holder is not on. The document is well formed, so it
	// does not wrap ErrMalformedQuote; like its siblings it wraps
	// ErrMalformedProof, which keeps the umbrella check callers use for VP
	// refusals unchanged.
	ErrVPVerificationMethodMismatch = fmt.Errorf("%w: VP verificationMethod/holder mismatch", ErrMalformedProof)

	// ErrVPHolderMismatch: envelope.holder did not match
	// VerifyVPOptions.ExpectedHolder. Most common cause: the caller
	// forgot to compose Verify(FQ).signerDID → VerifyVP(ExpectedHolder=…),
	// or the holder/FQ-signer consistency check is genuinely failing
	// (potential cross-account replay).
	ErrVPHolderMismatch = fmt.Errorf("%w: VP holder mismatch", ErrMalformedProof)

	// ErrVPChallengeMismatch: proof.challenge != ExpectedChallenge.
	// Cross-auction replay binding tripped — the VP is signed for a
	// different request_id than the bid this verifier is processing.
	ErrVPChallengeMismatch = fmt.Errorf("%w: VP challenge mismatch", ErrMalformedProof)

	// ErrVPDomainMismatch: proof.domain != ExpectedDomain.
	// Cross-environment replay binding tripped — the VP was minted for
	// a different verifier service identifier (e.g. staging credentials
	// presented to production).
	ErrVPDomainMismatch = fmt.Errorf("%w: VP domain mismatch", ErrMalformedProof)

	// ErrVPDeclarationTypeMismatch: the signed envelope's `type` array did
	// not contain ExpectedDeclarationType. Cross-declaration confusion
	// tripped — e.g. a FulfillmentQuoteEnvelope presented where a
	// PaymentRequestEnvelope was expected. The declaration term is covered
	// by the holder signature (it emits an rdf:type n-quad), so this is a
	// signature-bound discriminator, not a wire-label check.
	ErrVPDeclarationTypeMismatch = fmt.Errorf("%w: VP declaration type mismatch", ErrMalformedProof)

	// ErrVPFreshnessFailure: proof.created is outside the configured
	// [Now - MaxProofAge, Now + MaxFutureSkew] window, OR Now itself
	// was unset while a freshness bound was requested.
	ErrVPFreshnessFailure = fmt.Errorf("%w: VP freshness failure", ErrMalformedProof)

	// ErrVPIssuerNotTrusted: a VC's issuer DID was not in the
	// IsIssuerTrusted callback's trust anchors (strict mode).
	ErrVPIssuerNotTrusted = fmt.Errorf("%w: VP issuer not trusted", ErrMalformedProof)

	// ErrVPMissingRequiredVCType: no embedded VC declared all the
	// VC types listed in RequiredVCTypes.
	ErrVPMissingRequiredVCType = fmt.Errorf("%w: VP missing required VC type", ErrMalformedProof)

	// ErrVPVCDateWindow: a VC's issuanceDate is in the future OR its
	// expirationDate is past Now.
	ErrVPVCDateWindow = fmt.Errorf("%w: VP VC date window failure", ErrMalformedProof)

	// ErrVPVCMissingIssuanceDate: a VC's issuanceDate is JSON null. The
	// binding decodes null to the zero time.Time, which no date-window
	// comparison refuses, so the verifier checks for it explicitly. The
	// zero instant 0001-01-01T00:00:00Z decodes to the same value, so
	// every spelling of that instant is refused with it; TypeScript
	// refuses the same. A VC whose issuanceDate is absent or an empty
	// string already fails to decode with ErrMalformedQuote; null is the
	// same malformed document, so this wraps ErrMalformedQuote too and
	// all three are classified alike.
	ErrVPVCMissingIssuanceDate = fmt.Errorf("%w: VP VC missing issuanceDate", ErrMalformedQuote)

	// ErrVPTooManyVCs: envelope.verifiableCredential length exceeds
	// MaxVerifiableCredentials. Pre-canonicalization rejection guards
	// the bid perimeter against an unauthenticated DoS amplification.
	ErrVPTooManyVCs = fmt.Errorf("%w: VP too many VCs", ErrMalformedProof)

	// ErrVPSubjectHolderMismatch: a VC's credentialSubject.id does not
	// equal the VP's holder DID. Binds the credential subject to the
	// presenter so a holder cannot attach someone else's valid
	// KnownToAtumCredential to their own bid. Discrete
	// cheap slice of the broader VC-content-attacker-controlled gap
	// documented in the package SECURITY NOTE; cryptographic VC-proof
	// verification remains the larger follow-up.
	ErrVPSubjectHolderMismatch = fmt.Errorf("%w: VP subject holder mismatch", ErrMalformedProof)
)

// Cryptographic VC proof verification sentinels. These wrap
// ErrMalformedProof so the umbrella check stays behavior-preserving
// alongside the existing VC-policy sentinels above. Reasons split
// compliance vs ops per the design doc's failure-mode taxonomy.
var (
	// ErrVPVCSignatureInvalid: the VC's own proof signature didn't
	// recover / verify against the issuer's published key. Compliance-
	// class: the attacker either forged the VC payload or tampered with
	// it post-issuance. Distinct from the OUTER VP signature failure
	// (ErrVPSignerHolderMismatch / VerifyVP recovery) which fires on
	// the holder's signature, not the issuer's.
	ErrVPVCSignatureInvalid = fmt.Errorf("%w: VP VC signature invalid", ErrMalformedProof)

	// ErrVPVCIssuerUnresolvable: the issuer's DID document couldn't be
	// fetched / parsed by the supplied IssuerKeyResolver. Ops-class
	// (DNS / network / issuer outage); the same failure mode the
	// existing trust-anchor allow-list would experience if we couldn't
	// reach the issuer.
	ErrVPVCIssuerUnresolvable = fmt.Errorf("%w: VP VC issuer unresolvable", ErrMalformedProof)

	// ErrVPVCIssuerKeyMismatch: the resolver returned the issuer's DID
	// document, but the proof's verificationMethod doesn't refer to a
	// key the resolver knows about for that issuer. Compliance-class:
	// an attacker claiming a trusted issuer DID but signing with a key
	// not in the document.
	ErrVPVCIssuerKeyMismatch = fmt.Errorf("%w: VP VC issuer key mismatch", ErrMalformedProof)

	// ErrVPVCUnsupportedProofType: the VC's proof.type isn't in the
	// VerifyVCProof dispatch table. Compliance-class because an
	// attacker minting a VC under an unsupported cryptosuite is
	// trying to slip a proof-type the verifier can't check.
	ErrVPVCUnsupportedProofType = fmt.Errorf("%w: VP VC unsupported proof type", ErrMalformedProof)
)

// Holder-issued VC carve-out sentinel. Wraps ErrMalformedProof like every
// other VP sentinel so the umbrella errors.Is check stays
// behavior-preserving.
var (
	// ErrVPVCIssuerNotHolder: a VC whose type is in
	// VerifyVPOptions.HolderIssuedVCTypes (e.g. SenderComplianceCredential)
	// declared an issuer that is NOT the VP's holder, OR a did:pkh-issued
	// VC reached VerifyVCProof with an issuer that doesn't equal the
	// supplied HolderDID. Compliance-class and forgery-shaped: the
	// holder-issued trust model rests entirely on issuer == holder (the
	// originator attests its own client under its own key). A different
	// did:pkh issuer means someone is trying to smuggle a self-signed
	// credential under an identity the envelope's holder signature does
	// not cover — rejected in ALL modes, never mode-gated.
	ErrVPVCIssuerNotHolder = fmt.Errorf("%w: VP VC issuer not holder", ErrMalformedProof)
)
