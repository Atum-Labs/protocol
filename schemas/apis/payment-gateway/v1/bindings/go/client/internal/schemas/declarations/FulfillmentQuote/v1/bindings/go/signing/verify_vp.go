// Package-level SECURITY NOTE (VerifyVP):
//
// VerifyVP cryptographically verifies the OUTER VP holder signature,
// applies POLICY checks on each embedded VerifiableCredential (date
// window, issuer-in-trust-anchors, required VC types, the
// subject-holder binding), AND — when the caller
// supplies a `VerifyVCProofs` resolver — cryptographically
// verifies each VC's own `proof.jws` against the issuer's published
// `verificationMethod` key, resolved via the `did:web` document at
// `https://<issuer-host>/.well-known/did.json`.
//
// Residual threat-model that operators MUST understand:
//
//   - The trust gate combines TWO checks: (a) STRING MATCH on
//     `vc.issuer` against the caller-supplied trust-anchor predicate
//     AND (b) cryptographic verification of `proof.jws` under the
//     resolved issuer key. Both must pass for a VC to be considered
//     attested. Operators running `vc_signature_verification.mode` ∈
//     {permissive, strict} get the combined gate; `audit` runs the
//     verifier counterfactually for observability without rejecting;
//     `disabled` falls back to the string-match-only
//     model and SHOULD only be used during rollback drills.
//   - The remaining attacker capability is bounded by the issuer's
//     KMS-key security: an attacker who compromises a holder key can
//     still re-present VCs the issuer ALREADY signed for that holder,
//     but they can no longer mint new VCs claiming any trusted issuer
//     DID. Cross-holder VC theft was already closed; new
//     forging requires direct issuer-key compromise, which is the
//     issuer-side trust contract Atum-ID inherently rests on.
//   - did:web resolution trusts DNS + TLS + the issuer's web origin.
//     A compromise of any of those (cert mis-issuance, BGP hijack,
//     issuer web-host takeover) lets an attacker substitute a key
//     they control. Operators SHOULD pin issuer DIDs they care about
//     via the environment-variable override mechanism documented for
//     the did:web resolver for the highest-trust issuers, and rely
//     on per-environment cert + DNS controls otherwise.
//   - Audit mode (`mode=audit`) is the canonical pre-rollout safety
//     valve: it runs the full verifier path counterfactually and
//     emits `vp.verify.vc_sig.observation` log entries WITHOUT
//     failing the bid. Operators MUST sit in audit for the dwell
//     window before flipping to permissive/strict.
package ldverification

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	fqe "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/FulfillmentQuoteEnvelope/v1/bindings/go/generated"
	jsonmembers "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/PaymentRequest/v1/bindings/go/jsonmembers"
	lddataintegrity "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/common/ld-data-integrity/go"

	"github.com/ethereum/go-ethereum/common"
	"github.com/mr-tron/base58"
)

// defaultMaxVerifiableCredentials is the safe upper bound applied when
// VerifyVPOptions.MaxVerifiableCredentials is zero. 16 is high enough
// to admit any realistic multi-VC envelope (`KnownToAtumVerifiableCredential`
// + a handful of capability / KYC / corridor-scoped VCs) and low enough
// that the per-VC canonicalization + signature-recovery loop stays
// bounded against an unauthenticated DoS amplifier at the bid
// perimeter. Operators that genuinely need more can raise the option
// explicitly; the previous "zero = unlimited" behavior was a fail-open
// foot-gun every caller had to remember to opt out of.
const defaultMaxVerifiableCredentials = 16

// expectedVPProofPurpose is the only proof.proofPurpose VerifyVP accepts.
// W3C VC Data Model v1.1 §5.6 mandates "authentication" for
// VerifiablePresentation proofs — the holder is authenticating themselves
// as the presenter of the enclosed credentials, distinct from the
// "assertionMethod" purpose the FulfillmentQuote proof uses.
const expectedVPProofPurpose = "authentication"

// IsIssuerTrustedFunc is the trust-anchor probe VerifyVP calls for each
// embedded VC's issuer DID. Returns (allowed, enforced) — VerifyVP rejects
// the VC when allowed=false AND enforced=true (strict mode); other
// combinations are pass-through (mirroring the trusted-issuers
// registry's IsTrusted probe).
//
// Function-callback shape — not a typed service field — so
// ld-verification stays decoupled from the trusted-issuers registry.
// Callers pass service.IsTrusted directly.
type IsIssuerTrustedFunc func(issuerDID string) (allowed, enforced bool)

// VerifyVPOptions configure the holder-signature recovery, replay-binding
// checks, freshness window, and VC-policy gate.
//
// The composition pattern at the gRPC perimeter is:
//  1. Caller calls Verify() on the inner FulfillmentQuote → Result.Signer.
//  2. Caller derives the expected holder DID from the recovered signer.
//  3. Caller calls VerifyVP() with that DID as ExpectedHolder.
//
// Doing the holder-equality assertion inside VerifyVP (rather than at the
// caller) keeps the consistency check load-bearing on the verification
// path: a caller that forgets step (3) gets a hard failure here rather
// than silently accepting a VP whose holder disagrees with the FQ signer.
type VerifyVPOptions struct {
	// ExpectedChallenge MUST equal proof.challenge. Cross-auction replay
	// binding: the bid's request_id propagated by the requester
	// perimeter → downstream verifier → settler. Required (empty is rejected).
	ExpectedChallenge string

	// ExpectedDomain MUST equal proof.domain. Cross-environment replay
	// binding: the verifier's configured service identifier (e.g.
	// did:web:settler.atum.network). Required.
	ExpectedDomain string

	// ExpectedHolder MUST equal the parsed envelope.holder. The caller
	// derives this from the inner FQ verifier's recovered signer
	// (chain-canonical did:pkh form). Required.
	ExpectedHolder string

	// ExpectedDeclarationType, when non-empty, MUST be present in the
	// signed envelope's `type` array (e.g. "PaymentRequestEnvelope").
	// The declaration term is bound into the holder signature
	// (it emits an rdf:type n-quad — see SignVPOptions.DeclarationType), so
	// this asserts the envelope KIND the verifier expects against a
	// signature-covered discriminator, closing the PRE↔FQE interchangeability
	// gap. Empty disables the check — back-compat for envelopes signed
	// before the producer adopted DeclarationType (the FQE producer until
	// its own repo ships the change). When set, the matching declaration
	// context MUST be overlaid (ExtraEnvelopeContexts) so the type term
	// canonicalizes; the holder-signature recovery already enforces that.
	ExpectedDeclarationType string

	// Now is the freshness anchor — REQUIRED. Tests pin a fixed instant;
	// production passes time.Now(). VerifyVP returns ErrMalformedProof
	// when Now is the zero time.Time. The previous "zero disables the
	// check" semantic was a fail-open hazard: a caller forgetting Now
	// silently disabled freshness validation with no signal.
	Now time.Time

	// MaxProofAge is the upper bound on (Now - proof.created). Zero
	// disables the past-freshness check (audit-only callers may
	// legitimately accept arbitrarily old proofs).
	MaxProofAge time.Duration

	// MaxFutureSkew is the upper bound on (proof.created - Now). Default
	// 0 means "reject any future-dated proof" — the safe posture for a
	// forgery indicator. Widening requires an explicit clock-skew budget.
	// Asymmetric with MaxProofAge by design (see field doc).
	MaxFutureSkew time.Duration

	// RequiredVCTypes lists VC types at least one verified VC must
	// declare. MVP enforces a single required type (e.g.
	// "KnownToAtumVerifiableCredential"); multi-VC policies land in a
	// follow-up per the design's out-of-scope list. Empty disables the type
	// check — the verifier still runs date + issuer checks.
	RequiredVCTypes []string

	// HolderIssuedVCTypes lists VC types the verifier accepts as
	// HOLDER-ISSUED: credentials the VP's holder mints under its own
	// did:pkh key about a THIRD PARTY (e.g. the originator's
	// SenderComplianceCredential attesting the funding wallet). A VC whose
	// `type` array intersects this list gets a carve-out from two of the
	// standard per-VC policies:
	//
	//   - subject-holder binding: SKIPPED — the credential's subject is
	//     deliberately NOT the holder (it's the sender). The subject id
	//     must still be present and did:pkh-shaped.
	//   - issuer trust (IsIssuerTrusted): SKIPPED entirely — the did:pkh
	//     issuer is neither rejected under strict trust mode nor recorded
	//     as an audit-mode IssuerTrustObservation. Trust chains through
	//     the holder's OWN trusted-issuer VCs riding in the same envelope.
	//
	// In exchange, a NON-negotiable gate applies in ALL modes: the VC's
	// issuer MUST equal ExpectedHolder (ErrVPVCIssuerNotHolder otherwise).
	// Date-window checks and the per-VC cryptographic proof pass (when
	// VerifyVCProofs is wired) still apply unchanged — the proof verifies
	// by secp256k1 recovery against the holder's did:pkh address instead
	// of a resolver-published key (see VerifyVCProof / VerifyVCProofOptions
	// .HolderDID). Empty disables the carve-out — every VC follows the
	// standard policy path.
	HolderIssuedVCTypes []string

	// MaxVerifiableCredentials caps the envelope's VC array size. The
	// envelope schema enforces minItems: 1 but no maxItems; an
	// unauthenticated attacker submitting a bid with 10k VCs would
	// blow out URDNA2015 canonicalization cost. Zero or unset applies
	// `defaultMaxVerifiableCredentials` (16) — fail-closed default so
	// the bound is on by construction. Operators that genuinely need
	// more raise this explicitly; the previous "zero = unlimited"
	// posture was a foot-gun every caller had to remember to opt out
	// of. To raise the cap: set a larger value here AND raise the
	// envelope schema's `verifiableCredential.maxItems`.
	MaxVerifiableCredentials int

	// IsIssuerTrusted gates each VC by its declared issuer DID. Nil
	// disables the check (matches trustedissuers.ModeDisabled at the
	// caller). When non-nil, the callback's enforced=true return rejects
	// the VC; enforced=false is a permissive/audit pass-through.
	IsIssuerTrusted IsIssuerTrustedFunc

	// VerifyVCProofs, when non-nil, runs cryptographic VC-proof
	// verification on every embedded VC via VerifyVCProof. Each VC's
	// proof block is verified against the issuer's published key
	// resolved through this IssuerKeyResolver — the load-bearing
	// VC-signature gate. Nil opts the check out (matches the
	// earlier contract + the disabled-mode pass-through at the
	// caller, mirroring how IsIssuerTrusted treats nil).
	//
	// Errors from VerifyVCProof are returned verbatim — they wrap the
	// per-reason sentinels (ErrVPVCSignatureInvalid /
	// ErrVPVCIssuerUnresolvable / ErrVPVCIssuerKeyMismatch /
	// ErrVPVCUnsupportedProofType) so the caller's reason-tag mapping
	// dispatches cleanly. Per-VC iteration accumulates issuer-trust
	// observations across the full slice before surfacing any sig
	// failure, so a sig-failing VC at index N doesn't lose the
	// audit-mode observations from VCs at index 0..N-1.
	VerifyVCProofs IssuerKeyResolver

	// Context propagates a request-scoped deadline / cancellation
	// through to the IssuerKeyResolver. The resolver's transport
	// (the did:web resolver uses an HTTPS GET) MUST
	// honour this context — without a caller-supplied deadline, a
	// crafted VC pointing at a slow-responding `did:web` host would
	// hang the verifier goroutine for the resolver's full internal
	// timeout (DoS surface on the pre-auth bid path).
	//
	// Nil is allowed and silently upgraded to context.Background().
	// Production callers MUST supply a real context with a deadline
	// tighter than the bid-path SLA — the perimeter wiring is
	// responsible for this.
	Context context.Context

	// RequestID is an optional correlation identifier echoed in error
	// messages so an operator triaging "VP verification failed" at 3am
	// can tie the failure back to a specific bid without log diving.
	// Sourced by the perimeter from the bid's payment_id.
	// Not used in any cryptographic computation — pure log-correlation.
	RequestID string

	// ExtraEnvelopeContexts overlays additional JSON-LD context URL →
	// parsed-content pairs onto the canonicalization loader for THIS call
	// only. Keys are context URLs; values are the parsed context content
	// (json.Unmarshal of the .jsonld file). Nil / empty uses the
	// process-global fqLoader unchanged (FQ + FQE + generic contexts).
	//
	// The OUTER envelope's top-level
	// @context is declaration-specific. FQE envelopes resolve under
	// fqLoader's built-in FQE entry, so the downstream verifier leaves this nil.
	// PaymentRequestEnvelope (PRE) envelopes carry the PRE context URL at
	// top level, which fqLoader does not (and per the layering boundary
	// MUST not) know; the requester perimeter passes
	// {PREContextURL: parsedPREContext} here so the per-call loader can
	// resolve it WITHOUT registering PRE on FQ's global loader. The proof
	// block still canonicalizes under the FQE context URL (PRE's proof
	// block carries no @context, so vpProofContext falls back to the FQE
	// URL — byte-identical term definitions, see the two context.jsonld
	// files).
	ExtraEnvelopeContexts map[string]any

	// AcceptPaymentRequestEnvelopeTypedProof also accepts a secp256k1 holder
	// proof in the typed form a payer's wallet signs: a signature over the
	// EIP-712 digest of PaymentRequestEnvelopeProof{proofHash, docHash}
	// (lddataintegrity.PaymentRequestEnvelopeProofTypedDigest), the same two
	// hashes the raw form signs as keccak256(proofHash || docHash), so it binds
	// the same challenge, domain, holder and credentials. Taken only for an
	// envelope whose signed `type` declares PaymentRequestEnvelope, and only
	// when it recovers the holder. Off, a PaymentRequestEnvelope's holder
	// proof verifies only in the raw form. An envelope that doesn't declare
	// it takes the raw form or `SettlerProof`, as before. A verifier of
	// originator envelopes sets it; nothing else should.
	AcceptPaymentRequestEnvelopeTypedProof bool
}

// VPResult is the outcome of a successful envelope verification. The
// holder identity fields are populated identically to Result (FQ verifier)
// for the matching cryptosuite — callers reuse the same chain-canonical
// derivation code.
//
// When `VerifyVPOptions.VerifyVCProofs` is supplied,
// cryptographic verification of each embedded VC's own proof block is
// performed inline; the threat-model framing is in the top-of-file
// SECURITY NOTE.
type VPResult struct {
	// Holder is the bare did:pkh URI parsed from envelope.holder, with
	// any fragment stripped.
	Holder string

	// Cryptosuite is the verified proof type.
	Cryptosuite string

	// SignerAddress is the 20-byte EVM-style hash recovered from the JWS
	// signature when Cryptosuite == EcdsaSecp256k1RecoverySignature2020.
	// Zero value for ed25519.
	SignerAddress common.Address

	// Ed25519PublicKey is the 32-byte ed25519 public key parsed from the
	// verificationMethod DID when Cryptosuite == Ed25519Signature2020.
	// nil for secp256k1.
	Ed25519PublicKey ed25519.PublicKey

	// DIDNetwork is the network segment of the holder DID (e.g.
	// "eip155:1", "tron:mainnet", "solana:devnet"). Caller-side chain-
	// canonical comparison reads this off Result, not the raw holder
	// string.
	DIDNetwork string

	// Created is the proof.created timestamp the verifier validated
	// against (Now - MaxProofAge, Now + MaxFutureSkew).
	Created time.Time

	// AttestedClaims holds the verbatim wire JSON of each VC that passed
	// VerifyVP's policy checks — byte-identical to what the issuer
	// signed (no re-marshal). Callers re-parse if they need typed access.
	// See the top-of-file SECURITY NOTE for what "passed" does and does
	// NOT include (the VC-signature gate closes the VC-signature gap).
	AttestedClaims []json.RawMessage

	// IssuerTrustObservations records each VC whose issuer DID was
	// outside the trust allow-list AND whose IsIssuerTrusted callback
	// returned enforced=false (the audit / permissive postures at the
	// caller). These observations are the audit-mode signal the library
	// previously swallowed: in those modes checkVCIssuerTrust returns
	// nil, so without an explicit hand-off the operator had no way to
	// see "this bid was accepted, but would have been rejected under
	// strict." The slice is nil when (a) IsIssuerTrusted is nil
	// (mode=disabled at the caller), (b) every VC's issuer was in the
	// allow-list, or (c) the callback returned enforced=true and
	// VerifyVP bailed with ErrVPIssuerNotTrusted before constructing
	// the result. Callers convert observations into the perimeter's
	// `accepted_would_reject` counterfactual metric.
	IssuerTrustObservations []IssuerTrustObservation
}

// IssuerTrustObservation is a single audit-mode issuer-trust signal:
// the VC's declared issuer DID was outside the trust anchor allow-list,
// but the IsIssuerTrusted callback returned enforced=false so VerifyVP
// did not reject. Carries the VC's index in envelope.verifiableCredential
// plus the offending DID so callers can surface a per-bid breadcrumb at
// the perimeter without re-deriving them from the attested-claims slice.
type IssuerTrustObservation struct {
	// VCIndex is the position of the VC within envelope.verifiableCredential
	// that produced this observation. 0-based; matches the index in
	// AttestedClaims for the same VC.
	VCIndex int
	// IssuerDID is the bare DID string extracted from the VC's `issuer`
	// field (string or {id: ...} object form per W3C VC spec).
	IssuerDID string
}

// VerifyVP cryptographically verifies a FulfillmentQuoteEnvelope's
// holder signature and applies replay-binding, freshness, and VC-policy
// checks. Returns a VPResult on full pass; rejects with a wrapped
// ErrMalformedProof / ErrUnsupportedProofType / ErrMissing... sentinel
// for shape errors, or a bare auth-class error for signature / consistency
// failures (mirroring Verify's error-class discipline).
//
// Dispatches on proof.type. The signing-input reconstruction goes through
// HashQuote with KeepVerifiableCredential=true and a multi-context proof
// block (envelope + cryptosuite); both knobs are load-bearing.
func VerifyVP(envelopeJSON []byte, opts VerifyVPOptions) (result VPResult, err error) {
	// Correlation-ID rewrap. When RequestID is set, prefix every returned
	// error with `[request_id=<X>]` so a 3am-paged operator can tie
	// failures back to a specific bid without log diving. The format of
	// RequestID is the CALLER's responsibility — this library doesn't own
	// the caller's id schema, and a malformed-format failure here would
	// surface as a misleading "proof malformed" reason at the operator
	// dashboard. Callers MUST validate the charset/length at their
	// perimeter before invoking VerifyVP (the gRPC bid perimeter does
	// this at the caller before the request reaches here).
	//
	// Wraps via defer so we don't touch every fmt.Errorf site, and so
	// the wrap preserves whichever sentinel was wrapped (errors.Is still
	// works from the caller).
	if opts.RequestID != "" {
		defer func() {
			if err != nil {
				err = fmt.Errorf("[request_id=%s] %w", opts.RequestID, err)
			}
		}()
	}

	if opts.ExpectedChallenge == "" {
		return VPResult{}, fmt.Errorf("VerifyVPOptions.ExpectedChallenge is required: %w", ErrMalformedProof)
	}
	if opts.ExpectedDomain == "" {
		return VPResult{}, fmt.Errorf("VerifyVPOptions.ExpectedDomain is required: %w", ErrMalformedProof)
	}
	if opts.ExpectedHolder == "" {
		return VPResult{}, fmt.Errorf("VerifyVPOptions.ExpectedHolder is required: %w", ErrMalformedProof)
	}

	// Refused before any typed read. encoding/json matches a member name to a
	// struct field under case folding and keeps the last match, while the
	// canonical form the proofs cover keeps only the exact names a context
	// defines, so with a member named twice the checks below could read one
	// that no signature covers. The embedded credentials are part of the
	// envelope, so this covers them too.
	if err := refuseAmbiguousMembers("FulfillmentQuoteEnvelope", envelopeJSON); err != nil {
		return VPResult{}, err
	}

	var envelope fqe.SchemaJson
	if err := json.Unmarshal(envelopeJSON, &envelope); err != nil {
		return VPResult{}, fmt.Errorf("failed to parse FulfillmentQuoteEnvelope: %w", errors.Join(ErrMalformedQuote, err))
	}

	// Sidecar parse: extract verifiableCredential as []json.RawMessage so
	// AttestedClaims can return verbatim wire bytes per VC. json.Marshal
	// of the typed binding re-orders map keys non-deterministically (Go
	// map iteration is randomized); without this, AttestedClaims would
	// diverge from what the issuer signed and break downstream consumers
	// that need byte-identity (audit logging, signature-chain anchoring).
	var sidecar struct {
		VerifiableCredential []json.RawMessage `json:"verifiableCredential"`
	}
	if err := json.Unmarshal(envelopeJSON, &sidecar); err != nil {
		return VPResult{}, fmt.Errorf("failed to extract raw verifiableCredential slice: %w", errors.Join(ErrMalformedQuote, err))
	}
	rawVCs := sidecar.VerifiableCredential

	// VC array cap — gated BEFORE canonicalization. An unauthenticated
	// attacker hitting the gRPC bid perimeter with a 10k-VC envelope
	// would amplify URDNA2015 cost into a queue-saturation DoS on
	// the downstream verifier. Reject early.
	maxVCs := opts.MaxVerifiableCredentials
	if maxVCs <= 0 {
		maxVCs = defaultMaxVerifiableCredentials
	}
	if len(rawVCs) > maxVCs {
		return VPResult{}, fmt.Errorf("envelope.verifiableCredential length %d exceeds MaxVerifiableCredentials %d: %w",
			len(rawVCs), maxVCs, ErrVPTooManyVCs)
	}

	if envelope.Proof.ProofPurpose != expectedVPProofPurpose {
		return VPResult{}, fmt.Errorf("unsupported VP proofPurpose %q: only %q is accepted: %w",
			envelope.Proof.ProofPurpose, expectedVPProofPurpose, ErrUnsupportedProofType)
	}

	// Declaration-type binding. When the caller pins an
	// ExpectedDeclarationType, assert the signed `type` array carries it.
	// The term is covered by the holder signature (rdf:type n-quad), so a
	// mismatch means the envelope was minted as a different declaration kind
	// than this verifier accepts (e.g. an FQE presented to a PRE perimeter).
	// Empty ExpectedDeclarationType keeps the earlier behavior.
	if opts.ExpectedDeclarationType != "" && !slices.Contains(envelope.Type, opts.ExpectedDeclarationType) {
		return VPResult{}, fmt.Errorf("envelope.type %v does not contain ExpectedDeclarationType %q (declaration-type binding): %w",
			envelope.Type, opts.ExpectedDeclarationType, ErrVPDeclarationTypeMismatch)
	}

	// Holder equality — split-aware compare. case-insensitive on the
	// `did:pkh:<namespace>:<reference>` prefix (DID method + namespace
	// + chain reference are case-insensitive per W3C); EXACT compare on
	// the address segment because Solana base58 and Tron base58check
	// ARE case-sensitive — a flat EqualFold would let
	// `did:pkh:solana:devnet:Abc...` and `did:pkh:solana:devnet:abc...`
	// (different pubkeys → different accounts) match.
	if !holderEquals(envelope.Holder, opts.ExpectedHolder) {
		return VPResult{}, fmt.Errorf("envelope.holder %q does not match ExpectedHolder %q: %w", envelope.Holder, opts.ExpectedHolder, ErrVPHolderMismatch)
	}

	if envelope.Proof.Challenge != opts.ExpectedChallenge {
		return VPResult{}, fmt.Errorf("proof.challenge %q does not match ExpectedChallenge %q (cross-auction replay binding): %w", envelope.Proof.Challenge, opts.ExpectedChallenge, ErrVPChallengeMismatch)
	}
	if envelope.Proof.Domain != opts.ExpectedDomain {
		return VPResult{}, fmt.Errorf("proof.domain %q does not match ExpectedDomain %q (cross-environment replay binding): %w", envelope.Proof.Domain, opts.ExpectedDomain, ErrVPDomainMismatch)
	}

	// The freshness window reads the same proof.created the signing input
	// below is rebuilt from (rawString(rawProof, "created")): the exact
	// `proof` member's exact `created` string, never the typed binding's.
	created, err := rawProofCreated(envelopeJSON)
	if err != nil {
		return VPResult{}, err
	}
	// Now is REQUIRED. The pre-fix behavior silently skipped all freshness
	// checks when Now was zero, turning any production caller who forgot
	// to set it into a no-freshness verifier with no signal. Now-zero is
	// now a startup error; callers that genuinely don't want freshness
	// must still pass a non-zero anchor (e.g. time.Now()) and set
	// MaxProofAge=0 + MaxFutureSkew=large to widen both bounds explicitly.
	if opts.Now.IsZero() {
		return VPResult{}, fmt.Errorf("VerifyVPOptions.Now is required (fail-closed freshness): %w", ErrVPFreshnessFailure)
	}
	// MaxProofAge zero-disables the past-bound (audit-only callers may
	// legitimately accept arbitrarily old proofs). MaxFutureSkew always
	// fires — default 0 means "reject any future-dated proof", the safe
	// posture; widening it requires an explicit clock-skew budget.
	if opts.MaxProofAge > 0 && opts.Now.Sub(created) > opts.MaxProofAge {
		return VPResult{}, fmt.Errorf("proof.created %s older than MaxProofAge %s (now=%s): %w", created, opts.MaxProofAge, opts.Now, ErrVPFreshnessFailure)
	}
	if created.Sub(opts.Now) > opts.MaxFutureSkew {
		return VPResult{}, fmt.Errorf("proof.created %s exceeds MaxFutureSkew %s (now=%s): %w", created, opts.MaxFutureSkew, opts.Now, ErrVPFreshnessFailure)
	}

	switch envelope.Proof.Type {
	case ProofTypeSecp256k1Recovery2020:
		return verifyVPSecp256k1(envelopeJSON, &envelope, rawVCs, opts, created)
	case ProofTypeEd25519Signature2020:
		return verifyVPEd25519(envelopeJSON, &envelope, rawVCs, opts, created)
	default:
		return VPResult{}, fmt.Errorf("unsupported VP proof type %q: %w", envelope.Proof.Type, ErrUnsupportedProofType)
	}
}

func verifyVPSecp256k1(envelopeJSON []byte, envelope *fqe.SchemaJson, rawVCs []json.RawMessage, opts VerifyVPOptions, created time.Time) (VPResult, error) {
	if envelope.Proof.Jws == nil || *envelope.Proof.Jws == "" {
		return VPResult{}, fmt.Errorf("proof.jws is required for EcdsaSecp256k1RecoverySignature2020 VP: %w", ErrMissingSignatureMaterial)
	}
	_, signature, err := ParseDetachedJWS(*envelope.Proof.Jws)
	if err != nil {
		return VPResult{}, err
	}

	doc, rawProof, err := documentForCanonicalization(envelopeJSON)
	if err != nil {
		return VPResult{}, err
	}

	// VP-mode requires (a) keeping the verifiableCredential
	// array in the canonical doc (it IS the signed payload), and (b)
	// passing the envelope + cryptosuite contexts together for the proof
	// block so challenge/domain canonicalize. See sign-vp.ts for the
	// signer side of the same contract.
	hash, err := HashQuote(doc, HashQuoteOptions{
		Cryptosuite: ProofTypeSecp256k1Recovery2020,
		ProofOptions: HashableProofOptions{
			Type:               envelope.Proof.Type,
			Created:            rawString(rawProof, "created"),
			VerificationMethod: envelope.Proof.VerificationMethod,
			ProofPurpose:       envelope.Proof.ProofPurpose,
			Challenge:          envelope.Proof.Challenge,
			Domain:             envelope.Proof.Domain,
			Context:            vpProofContext(rawProof, secp256k1Recovery2020V2CtxURL),
		},
		KeepVerifiableCredential: true,
		// Overlay any caller-supplied envelope context (PRE)
		// onto fqLoader for this canonicalization only — see
		// VerifyVPOptions.ExtraEnvelopeContexts.
		Loader: loaderWithExtraEnvelopeContexts(opts.ExtraEnvelopeContexts),
	})
	if err != nil {
		return VPResult{}, err
	}

	// The raw form, and one typed form at most, chosen by what the envelope
	// declares. A settler's envelope may be signed in the settler identity
	// form. An originator's, one declaring PaymentRequestEnvelope, never is: it
	// takes only the payer's PaymentRequestEnvelopeProof form, and only where
	// the caller accepts it, so neither typed form vouches for the other's
	// envelopes.
	//
	// The PRE rule covers the holder proof only. Holder-issued credentials
	// inside it are verified by `VerifyVCProof`, raw or `SettlerProof`, as
	// before.
	var typed []lddataintegrity.TypedProofDigest
	switch {
	case !slices.Contains(envelope.Type, lddataintegrity.PaymentRequestEnvelopeType):
		typed = append(typed, lddataintegrity.SettlerProofTypedDigest)
	case opts.AcceptPaymentRequestEnvelopeTypedProof:
		typed = append(typed, lddataintegrity.PaymentRequestEnvelopeProofTypedDigest)
	}
	addr, err := lddataintegrity.RecoverSecp256k1ProofSignerFrom(hash, signature, func(a common.Address) bool {
		return signerMatchesHolderSecp256k1(a, envelope.Holder) == nil
	}, typed...)
	if err != nil {
		return VPResult{}, err
	}

	// Bind the recovered signer to envelope.Holder. The earlier code
	// stored `addr` in the result and never compared it back to the
	// holder's address segment — only the holder-vs-ExpectedHolder
	// LABEL compare ran, which is two caller-supplied strings. With
	// this check the verifier is self-validating regardless of what
	// ExpectedHolder is. Chain-aware compare: case-insensitive for
	// eip155 (EIP-55), exact byte-compare on tron (base58check is
	// case-sensitive).
	if err := signerMatchesHolderSecp256k1(addr, envelope.Holder); err != nil {
		return VPResult{}, err
	}

	var issuerTrustObservations []IssuerTrustObservation
	attested, err := verifyVCPolicies(envelope.VerifiableCredential, rawVCs, opts, &issuerTrustObservations)
	if err != nil {
		return VPResult{}, err
	}

	return VPResult{
		Holder:                  stripDIDFragment(envelope.Holder),
		Cryptosuite:             ProofTypeSecp256k1Recovery2020,
		SignerAddress:           addr,
		DIDNetwork:              didNetwork(envelope.Holder),
		Created:                 created,
		AttestedClaims:          attested,
		IssuerTrustObservations: issuerTrustObservations,
	}, nil
}

func verifyVPEd25519(envelopeJSON []byte, envelope *fqe.SchemaJson, rawVCs []json.RawMessage, opts VerifyVPOptions, created time.Time) (VPResult, error) {
	if envelope.Proof.ProofValue == nil || *envelope.Proof.ProofValue == "" {
		return VPResult{}, fmt.Errorf("proof.proofValue is required for Ed25519Signature2020 VP: %w", ErrMissingSignatureMaterial)
	}

	signature, err := lddataintegrity.DecodeEd25519ProofValue(*envelope.Proof.ProofValue)
	if err != nil {
		return VPResult{}, fmt.Errorf("failed to decode proof.proofValue: %w: %v", ErrMalformedSignatureMaterial, err)
	}

	pubKey, vmNamespace, vmNetwork, err := publicKeyFromVerificationMethod(envelope.Proof.VerificationMethod)
	if err != nil {
		return VPResult{}, fmt.Errorf("failed to resolve verificationMethod: %w", errors.Join(ErrMalformedQuote, err))
	}
	// Tie the verificationMethod's namespace and network to the holder's.
	// signerMatchesHolderEd25519 below binds the key bytes to the holder under
	// the HOLDER's namespace; nothing else compares the method's own, so
	// without this a did:pkh:solana:... holder could carry a stellar or
	// other-network verificationMethod over the same key and verify. Refused
	// before canonicalization, which is the expensive step.
	if err := verificationMethodMatchesHolder(vmNamespace, vmNetwork, envelope.Holder); err != nil {
		return VPResult{}, err
	}
	// Use the shared didNetwork() helper for the DIDNetwork field
	// rather than the legacy "solana:" + segment from
	// publicKeyFromVerificationMethod — single source of truth keeps
	// the secp256k1 + ed25519 paths returning the same shape and
	// avoids the inconsistency where ed25519 hardcoded "solana:" and
	// secp256k1 read the namespace from the holder.

	doc, rawProof, err := documentForCanonicalization(envelopeJSON)
	if err != nil {
		return VPResult{}, err
	}

	hash, err := HashQuote(doc, HashQuoteOptions{
		Cryptosuite: ProofTypeEd25519Signature2020,
		ProofOptions: HashableProofOptions{
			Type:               envelope.Proof.Type,
			Created:            rawString(rawProof, "created"),
			VerificationMethod: envelope.Proof.VerificationMethod,
			ProofPurpose:       envelope.Proof.ProofPurpose,
			Challenge:          envelope.Proof.Challenge,
			Domain:             envelope.Proof.Domain,
			Context:            vpProofContext(rawProof, ed25519Signature2020V1CtxURL),
		},
		KeepVerifiableCredential: true,
		// Overlay any caller-supplied envelope context (PRE)
		// onto fqLoader for this canonicalization only — see
		// VerifyVPOptions.ExtraEnvelopeContexts.
		Loader: loaderWithExtraEnvelopeContexts(opts.ExtraEnvelopeContexts),
	})
	if err != nil {
		return VPResult{}, err
	}

	if err := lddataintegrity.VerifyEd25519(pubKey, hash.SigningInput, signature); err != nil {
		return VPResult{}, fmt.Errorf("ed25519 VP signature verification failed")
	}

	// Bind the recovered pubkey to envelope.Holder.
	// publicKeyFromVerificationMethod extracted the pubkey from a wire
	// field — without this check it authenticates the
	// verificationMethod field, not the holder.
	if err := signerMatchesHolderEd25519(pubKey, envelope.Holder); err != nil {
		return VPResult{}, err
	}

	var issuerTrustObservations []IssuerTrustObservation
	attested, err := verifyVCPolicies(envelope.VerifiableCredential, rawVCs, opts, &issuerTrustObservations)
	if err != nil {
		return VPResult{}, err
	}

	return VPResult{
		Holder:                  stripDIDFragment(envelope.Holder),
		Cryptosuite:             ProofTypeEd25519Signature2020,
		Ed25519PublicKey:        pubKey,
		DIDNetwork:              didNetwork(envelope.Holder),
		Created:                 created,
		AttestedClaims:          attested,
		IssuerTrustObservations: issuerTrustObservations,
	}, nil
}

// vpProofContext returns the multi-context array (envelope + cryptosuite)
// the VP signer uses for proof canonicalization, OR the verbatim wire
// proof['@context'] when the signer emitted one. Mirrors sign-vp.ts's
// proofContext computation — see the comment there for why the envelope
// context MUST be loaded alongside the cryptosuite context (challenge /
// domain are defined in the envelope context; cryptosuite alone silently
// drops them from canonical n-quads).
func vpProofContext(rawProof map[string]any, suiteCtxURL string) any {
	if wireCtx, ok := rawProof["@context"]; ok && wireCtx != nil {
		return wireCtx
	}
	return []any{fulfillmentQuoteEnvelopeContextURL, suiteCtxURL}
}

// verifyVCPolicies applies the per-VC checks: date window, trust
// anchors, and RequiredVCTypes. Returns
// the raw wire JSON of each VC that passed all checks (NOT a re-marshal
// — see rawVCs param doc) and a non-nil error when no VC satisfies a
// non-empty RequiredVCTypes (the bid was supposed to carry a credential
// of a particular type and didn't).
//
// rawVCs MUST be the verbatim wire JSON of each VC, parallel-indexed to
// vcs. The verifier returns these bytes to callers via AttestedClaims;
// a re-marshal would re-order map keys non-deterministically and break
// "the attested bytes match the wire bytes" — a contract callers can
// rely on for audit logging or signature-chain anchoring downstream.
//
// TWO-TIER POLICY MODEL:
//
// The asymmetry between the date-window / issuer-trust checks (which
// reject the whole envelope on any single-VC failure) and the
// required-type check (which passes when at least one VC matches) is
// intentional and load-bearing. They answer different questions:
//
//   - per-VC VALIDITY tier (date window, issuer trust): every VC the
//     producer chose to include in the envelope MUST be individually
//     valid. Including a VC is a producer's explicit assertion of
//     intent to present it — the verifier doesn't get to drop VCs it
//     finds inconvenient. The legitimate-bid-with-an-expired-unrelated-
//     VC scenario is a producer bug, not a verifier asymmetry.
//
//   - per-policy POLICY tier (required-type): the verifier's operator
//     declares "at least one VC of type X must be present." That's a
//     coverage check, not a per-VC predicate.
//
// AttestedClaims returns every VC that was examined (i.e. the full
// input set when all VALIDITY checks pass), NOT just the required-type
// matches. Callers that need the required-type-matching subset filter
// downstream — the contract here is "the set of VCs this verifier
// examined and accepted as valid."
//
// SCOPE NOTE: this does NOT verify each VC's own cryptographic proof
// block. The MVP threat model accepts trusted-issuer-DID string match
// as the gate; cryptographic VC verification runs in a separate pass
// (see VerifyVCProof).
//
// `observations` is an append-only accumulator the caller owns; it
// receives an entry for each VC whose IsIssuerTrusted callback returned
// allowed=false AND enforced=false (audit / permissive at the caller).
// The accumulator is populated even when verifyVCPolicies succeeds, so
// VerifyVP can surface the signal via VPResult.IssuerTrustObservations
// on a passing envelope.
func verifyVCPolicies(vcs []fqe.VerifiableCredential, rawVCs []json.RawMessage, opts VerifyVPOptions, observations *[]IssuerTrustObservation) ([]json.RawMessage, error) {
	if len(vcs) == 0 {
		// envelope schema enforces minItems: 1, so this is defense in
		// depth — keeps the rejection path local rather than relying on
		// the upstream unmarshal having caught it.
		return nil, fmt.Errorf("envelope.verifiableCredential is empty: %w", ErrMalformedQuote)
	}
	if len(rawVCs) != len(vcs) {
		// Sentinel: VerifyVP MUST pass the parallel raw slice. This is
		// a programmer error, not a malformed-input error.
		return nil, fmt.Errorf("internal: rawVCs len %d does not match typed VCs len %d", len(rawVCs), len(vcs))
	}

	attested := make([]json.RawMessage, 0, len(vcs))
	matchedRequiredType := len(opts.RequiredVCTypes) == 0

	// Two-pass loop so issuer-trust observations from earlier VCs
	// aren't lost when a LATER VC's cryptographic proof check fails.
	// Single-pass would have: VC[0] accumulates an audit-mode
	// observation, VC[1] fails sig verification, function returns the
	// error, observations slice never reaches the caller. The caller's
	// audit-mode counterfactual dashboard silently undercounts.
	//
	// Pass 1: every VC's date-window + issuer-trust observation, plus
	// the required-type tally. Errors short-circuit here because a
	// failing date-window means the VC is structurally invalid; no
	// useful observations to accumulate beyond that point.
	//
	// Pass 2: every VC's cryptographic proof check. Runs only when
	// VerifyVCProofs is wired. Errors short-circuit; the observations
	// from pass 1 stay populated.
	for i, vc := range vcs {
		// Holder-issued carve-out. A VC whose type intersects
		// HolderIssuedVCTypes swaps the subject-holder binding + issuer-
		// trust gates for the (strictly harder) issuer==holder gate — see
		// VerifyVPOptions.HolderIssuedVCTypes for the trust model. The
		// carve-out is type-driven so a holder-issued VC masquerading
		// under a non-carved type (e.g. a self-signed KYCCredential)
		// still walks the standard policy path and gets rejected there.
		holderIssued := vcTypeIntersects(vc, opts.HolderIssuedVCTypes)

		if holderIssued {
			// Issuer MUST be the holder — forgery-shaped violation,
			// rejected in ALL modes (never mode-gated). checkHolderIssuedVC
			// ALSO confines the type set to VerifiableCredential + carved
			// types: a carved VC that also declared a trust-gated type
			// (KYCCredential / KnownToAtum) would otherwise ride the
			// skipped issuer-trust gate and self-satisfy RequiredVCTypes /
			// the KYC-status read.
			if err := checkHolderIssuedVC(vc, opts.ExpectedHolder, opts.HolderIssuedVCTypes); err != nil {
				return nil, fmt.Errorf("verifiableCredential[%d]: %w", i, err)
			}
		} else {
			// Subject-holder is the cheapest check (single did:pkh segment
			// compare, no allocations, no callback) AND the most diagnostic
			// when an attacker is trying to attach a captured VC, so it
			// fires first to keep the rejection reason informative under
			// multi-violation attacks.
			if err := checkVCSubjectMatchesHolder(vc, opts.ExpectedHolder); err != nil {
				return nil, fmt.Errorf("verifiableCredential[%d]: %w", i, err)
			}
		}
		if err := checkVCDateWindow(vc, opts.Now); err != nil {
			return nil, fmt.Errorf("verifiableCredential[%d]: %w", i, err)
		}
		if !holderIssued {
			// Issuer trust is a did:web trust-anchor concept; the holder-
			// issued VC's did:pkh issuer is neither rejected under strict
			// nor counted as an audit observation — the issuer==holder
			// gate above already ran in all modes.
			observation, err := checkVCIssuerTrust(vc, opts.IsIssuerTrusted)
			if err != nil {
				return nil, fmt.Errorf("verifiableCredential[%d]: %w", i, err)
			}
			if observation != nil {
				observation.VCIndex = i
				*observations = append(*observations, *observation)
			}
			// RequiredVCTypes is a COVERAGE gate: "a TRUSTED-issuer VC of
			// type X is present." Only non-holder-issued VCs can satisfy it
			// — a holder-issued (did:pkh self-attested) VC skips the
			// issuer-trust gate, so counting it here would let an operator
			// who lists a carved type in required_vc_types self-satisfy the
			// coverage gate with a self-signed credential.
			if !matchedRequiredType && vcSatisfiesRequiredTypes(vc, opts.RequiredVCTypes) {
				matchedRequiredType = true
			}
		}

		// Preserve verbatim wire bytes — see the rawVCs param doc.
		attested = append(attested, rawVCs[i])
	}

	if opts.VerifyVCProofs != nil {
		ctx := opts.Context
		if ctx == nil {
			ctx = context.Background()
		}
		for i, vc := range vcs {
			// Pass the raw wire bytes alongside
			// the typed VC. extractVCProof reads the wire form so a
			// binding-vs-wire shape drift (e.g. the typed
			// VerifiableCredential adds "expirationDate": null on a VC
			// that didn't carry the field) can't change canonical
			// n-quads vs what the issuer actually signed.
			// Thread the envelope's expected holder so a did:pkh-issued
			// (holder-issued) VC verifies by secp256k1 recovery against
			// the holder's address instead of hitting the did:web
			// resolver — see VerifyVCProofOptions.HolderDID.
			if err := VerifyVCProof(vc, rawVCs[i], opts.VerifyVCProofs, VerifyVCProofOptions{
				Context:   ctx,
				HolderDID: opts.ExpectedHolder,
			}); err != nil {
				return nil, fmt.Errorf("verifiableCredential[%d]: %w", i, err)
			}
		}
	}

	if !matchedRequiredType {
		return nil, fmt.Errorf("no VC declared all RequiredVCTypes %v: %w", opts.RequiredVCTypes, ErrVPMissingRequiredVCType)
	}
	return attested, nil
}

func checkVCDateWindow(vc fqe.VerifiableCredential, now time.Time) error {
	// VerifyVP enforces opts.Now != zero before reaching here, so the
	// previous Now.IsZero() escape hatch is redundant. Date fields are
	// typed time.Time by the binding (parsed at unmarshal time).
	//
	// IssuanceDate is required, and the binding refuses a VC that leaves
	// the member out or sets it to an empty string. It decodes JSON null
	// to the zero time.Time, though, and the zero time is before every
	// Now, so the comparison below would let it through. Refuse it here.
	// No credential is issued at the zero instant
	// (0001-01-01T00:00:00Z), so every spelling of that instant is
	// refused too; TypeScript refuses the same.
	if vc.IssuanceDate.IsZero() {
		return fmt.Errorf("VC issuanceDate is null or the zero time: %w", ErrVPVCMissingIssuanceDate)
	}
	if now.Before(vc.IssuanceDate) {
		return fmt.Errorf("VC issuanceDate %s is in the future (now=%s): %w", vc.IssuanceDate, now, ErrVPVCDateWindow)
	}
	// ExpirationDate is optional and a pointer: absent and JSON null
	// both decode to nil and mean no expiry. Any value that decodes is
	// compared, so the zero instant, in any spelling, is a past expiry,
	// as it is in TypeScript.
	if vc.ExpirationDate != nil {
		if now.After(*vc.ExpirationDate) {
			return fmt.Errorf("VC expired at %s (now=%s): %w", *vc.ExpirationDate, now, ErrVPVCDateWindow)
		}
	}
	return nil
}

// checkVCIssuerTrust runs the per-VC trust-anchor probe and reports
// three outcomes:
//
//   - nil callback (mode=disabled at the caller) → (nil, nil): no
//     enforcement, no observation.
//   - allowed=true, any enforced → (nil, nil): trust anchor matched,
//     nothing to record.
//   - allowed=false, enforced=true (strict) → (nil, ErrVPIssuerNotTrusted):
//     reject the envelope, observation is irrelevant.
//   - allowed=false, enforced=false (audit / permissive) → (observation, nil):
//     the envelope passes through, but the caller is handed a structured
//     breadcrumb of which issuer DID would have been rejected under
//     strict. VCIndex is unset here; the iterator owns the index and
//     stamps it on append.
//
// Returning the observation (rather than logging in the library) keeps
// ld-verification side-effect-free — callers route to logs/metrics under
// their own observability stack.
func checkVCIssuerTrust(vc fqe.VerifiableCredential, isTrusted IsIssuerTrustedFunc) (*IssuerTrustObservation, error) {
	if isTrusted == nil {
		return nil, nil
	}
	issuerDID, err := vcIssuerDID(vc)
	if err != nil {
		return nil, err
	}
	allowed, enforced := isTrusted(issuerDID)
	if allowed {
		return nil, nil
	}
	if enforced {
		return nil, fmt.Errorf("VC issuer %q not in trust anchors: %w", issuerDID, ErrVPIssuerNotTrusted)
	}
	return &IssuerTrustObservation{IssuerDID: issuerDID}, nil
}

// checkVCSubjectMatchesHolder enforces the subject-holder binding: a VC's
// credentialSubject.id MUST equal the VP's holder DID. Prevents the
// "presenter grabs someone else's valid VC and attaches it" attack — the
// VC is still well-formed and issuer-signed, but it is not *theirs*.
//
// Compares stripped-of-fragment forms on both sides so a holder DID
// carrying a #blockchainAccountId suffix still matches a bare did:pkh
// subject. holderDID is the verifier-supplied ExpectedHolder (already
// asserted equal to envelope.Holder upstream — see VerifyVP).
//
// SCOPE NOTE: this pairs with the cryptographic VC-proof
// verification — the subject-holder binding rejects "stolen
// valid VC re-presented by a different holder" without needing to
// touch issuer-key material; the VC-signature gate rejects "synthesise a
// new VC under a trusted issuer's name." Both run; neither replaces
// the other.
//
// V1 ASSUMPTION — DELEGATED PRESENTATION FUTURE: this check hard-codes
// the v1 semantic that the settler IS the subject of the VCs they
// present. The design leaves
// room for a v2 flow where "one party makes the quote and another
// presents it", which also implies "one party holds the credential and
// another presents it" — e.g. a delegated agent presenting a customer's
// VC on their behalf. When v2 ships, this check MUST become operator-
// configurable (per-tenant policy or a presenter-trust callback) or it
// will silently reject every delegated VP. Leaving the constraint
// hard-coded here keeps v1's threat-model tight; the v2 follow-up
// ticket should land alongside the delegated-presentation enablement,
// not in advance.
func checkVCSubjectMatchesHolder(vc fqe.VerifiableCredential, holderDID string) error {
	subjectID, _ := vc.CredentialSubject["id"].(string)
	if subjectID == "" {
		return fmt.Errorf("VC credentialSubject.id missing or not a string: %w", ErrMalformedQuote)
	}
	if !holderEquals(subjectID, holderDID) {
		return fmt.Errorf("VC credentialSubject.id %q does not equal VP holder %q: %w", subjectID, holderDID, ErrVPSubjectHolderMismatch)
	}
	return nil
}

// vcTypeIntersects reports whether the VC's `type` array shares at
// least one entry with `types`. Distinct from vcSatisfiesRequiredTypes
// (which requires ALL of `required` to be present): the holder-issued
// carve-out fires on ANY declared carved type, so a producer can't
// dodge the issuer==holder gate by declaring extra types alongside the
// carved one.
func vcTypeIntersects(vc fqe.VerifiableCredential, types []string) bool {
	if len(types) == 0 {
		return false
	}
	for _, t := range vc.Type {
		if slices.Contains(types, t) {
			return true
		}
	}
	return false
}

// checkHolderIssuedVC enforces the holder-issued VC gates:
//
//  1. vc.issuer MUST equal the VP's holder (DID-equality via the same
//     chain-aware holderEquals compare the envelope's holder binding
//     uses). Violation is forgery-shaped — the holder-issued trust
//     model rests on the holder attesting under its OWN key — and
//     returns ErrVPVCIssuerNotHolder in ALL modes.
//  2. credentialSubject.id MUST be present and did:pkh-shaped. The
//     subject is deliberately NOT the holder (it's the third party the
//     holder attests, e.g. the sender wallet), so the standard
//     subject-holder binding is skipped — but a missing or malformed
//     subject still fails closed (ErrMalformedQuote) so downstream
//     consumers (CheckSenderVC-style claim extraction) never see a
//     subject-less attested credential.
func checkHolderIssuedVC(vc fqe.VerifiableCredential, holderDID string, carvedTypes []string) error {
	issuerDID, err := vcIssuerDID(vc)
	if err != nil {
		return err
	}
	if !holderEquals(issuerDID, holderDID) {
		return fmt.Errorf("holder-issued VC issuer %q does not equal VP holder %q: %w",
			issuerDID, holderDID, ErrVPVCIssuerNotHolder)
	}
	// TYPE CONFINEMENT. The carve-out skips the issuer-trust +
	// subject-holder gates for this VC. If a holder could ALSO stamp a
	// trust-gated type on it (e.g. types = [VerifiableCredential,
	// KYCCredential, SenderComplianceCredential]), that self-signed VC would
	// (a) satisfy RequiredVCTypes with no trusted issuer and (b) be read as an
	// approved KYCCredential by claim extraction — a total trust bypass. So a
	// carved (did:pkh-issuer) VC may carry ONLY VerifiableCredential + the
	// carved types; anything else is rejected in ALL modes. A holder that
	// wants to assert a trust-gated claim must obtain a real Atum-issued
	// (did:web) credential, which walks the standard trusted-issuer path.
	for _, t := range vc.Type {
		if t == "VerifiableCredential" || slices.Contains(carvedTypes, t) {
			continue
		}
		return fmt.Errorf("holder-issued VC declares non-carved type %q (only VerifiableCredential + %v allowed for a did:pkh self-issued VC): %w",
			t, carvedTypes, ErrVPVCIssuerNotHolder)
	}
	subjectID, _ := vc.CredentialSubject["id"].(string)
	if subjectID == "" {
		return fmt.Errorf("holder-issued VC credentialSubject.id missing or not a string: %w", ErrMalformedQuote)
	}
	seg, ok := splitDIDPKH(subjectID)
	if !ok || !strings.EqualFold(seg[0], "did") || !strings.EqualFold(seg[1], "pkh") {
		return fmt.Errorf("holder-issued VC credentialSubject.id %q is not did:pkh-shaped: %w",
			subjectID, ErrMalformedQuote)
	}
	return nil
}

// vcIssuerDID extracts the issuer DID from a VC. The W3C VC spec allows
// either a string (the DID) or an object (with "id" being the DID + extra
// metadata); the schema's VerifiableCredential.Issuer is interface{} per
// the binding so callers handle both shapes.
func vcIssuerDID(vc fqe.VerifiableCredential) (string, error) {
	switch v := vc.Issuer.(type) {
	case string:
		return v, nil
	case map[string]any:
		id, _ := v["id"].(string)
		if id == "" {
			return "", fmt.Errorf("VC issuer object missing 'id' string: %w", ErrMalformedQuote)
		}
		return id, nil
	default:
		return "", fmt.Errorf("VC issuer field is %T, want string or object: %w", v, ErrMalformedQuote)
	}
}

func vcSatisfiesRequiredTypes(vc fqe.VerifiableCredential, required []string) bool {
	have := make(map[string]struct{}, len(vc.Type))
	for _, t := range vc.Type {
		have[t] = struct{}{}
	}
	for _, t := range required {
		if _, ok := have[t]; !ok {
			return false
		}
	}
	return true
}

// stripDIDFragment removes the "#<fragment>" suffix from a DID so the
// returned identity is a bare did:pkh URI suitable for trust-anchor
// lookups (mirror of TS verify.ts's helper).
func stripDIDFragment(did string) string {
	if i := strings.Index(did, "#"); i >= 0 {
		return did[:i]
	}
	return did
}

// signerMatchesHolderSecp256k1 ties the recovered EVM-style 20-byte
// address to envelope.Holder under the holder's chain namespace. This
// closes the "two text labels" gap: without this check, an attacker
// writes the victim's DID in envelope.Holder, signs with their own
// key, and the verifier accepts because only the caller-supplied
// ExpectedHolder label is checked.
//
// Chain-aware compare:
//
//   - eip155 — case-insensitive hex compare. EIP-55 mixed-case is a
//     checksum, not a different address; `0xAbC...` and `0xabc...`
//     refer to the same wallet.
//
//   - tron — exact compare on base58check. The recovered EVM hash is
//     re-encoded as the canonical Tron base58check (0x41 prefix +
//     double-SHA256 4-byte checksum) before compare. Both inputs are
//     case-sensitive — base58check encodes case-distinct payload bits,
//     so EqualFold would collapse distinct accounts.
//
// Any other namespace fails closed (rejects with the same sentinel)
// rather than silently accepting an unbound signature. New chains add
// a branch here AND a parallel branch in signerMatchesHolderEd25519
// for the ed25519 path.
func signerMatchesHolderSecp256k1(addr common.Address, holderDID string) error {
	seg, ok := splitDIDPKH(holderDID)
	if !ok {
		return fmt.Errorf("malformed holder DID %q (expected did:pkh:...): %w", holderDID, ErrMalformedQuote)
	}
	namespace := strings.ToLower(seg[2])
	holderAddr := seg[4]
	switch namespace {
	case "eip155":
		if !strings.EqualFold(addr.Hex(), holderAddr) {
			return fmt.Errorf("recovered secp256k1 signer %s does not match eip155 holder address %s: %w",
				addr.Hex(), holderAddr, ErrVPSignerHolderMismatch)
		}
	case "tron":
		wantTron := evmHashToTronBase58(addr)
		if wantTron != holderAddr {
			return fmt.Errorf("recovered signer (tron: %s) does not match holder address %s: %w",
				wantTron, holderAddr, ErrVPSignerHolderMismatch)
		}
	default:
		return fmt.Errorf("namespace %q is not supported for secp256k1 VP holder binding (only eip155 and tron — add a branch in signerMatchesHolderSecp256k1): %w",
			namespace, ErrUnsupportedProofType)
	}
	return nil
}

// verificationMethodMatchesHolder requires the did:pkh namespace and network
// reference named by the proof's verificationMethod (as returned by
// publicKeyFromVerificationMethod) to equal the holder's. Both parts are
// case-insensitive, as in holderEquals: the DID method, namespace and
// reference are case-insensitive per W3C. The address segment is not compared
// here; signerMatchesHolderEd25519 binds the key to the holder's address.
func verificationMethodMatchesHolder(vmNamespace, vmNetwork, holderDID string) error {
	seg, ok := splitDIDPKH(holderDID)
	if !ok {
		return fmt.Errorf("malformed holder DID %q (expected did:pkh:...): %w", holderDID, ErrMalformedQuote)
	}
	if !strings.EqualFold(vmNamespace, seg[2]) {
		return fmt.Errorf("verificationMethod namespace %q does not match holder namespace %q: %w",
			vmNamespace, seg[2], ErrVPVerificationMethodMismatch)
	}
	if !strings.EqualFold(vmNetwork, seg[3]) {
		return fmt.Errorf("verificationMethod network %q does not match holder network %q: %w",
			vmNetwork, seg[3], ErrVPVerificationMethodMismatch)
	}
	return nil
}

// signerMatchesHolderEd25519 ties the recovered ed25519 public key
// (extracted from proof.verificationMethod) to envelope.Holder. Mirror
// of signerMatchesHolderSecp256k1; see that helper's comment for the
// threat model.
//
// solana and stellar are the ed25519 chains we accept today. The compare
// is exact byte-for-byte on the address spelling — base58 IS case-
// sensitive, so EqualFold would collapse distinct keys, and a Stellar
// strkey has one canonical spelling.
func signerMatchesHolderEd25519(pubKey ed25519.PublicKey, holderDID string) error {
	seg, ok := splitDIDPKH(holderDID)
	if !ok {
		return fmt.Errorf("malformed holder DID %q (expected did:pkh:...): %w", holderDID, ErrMalformedQuote)
	}
	namespace := strings.ToLower(seg[2])
	holderAddr := seg[4]
	switch namespace {
	case "solana":
		wantSol := base58.Encode(pubKey)
		if wantSol != holderAddr {
			return fmt.Errorf("recovered ed25519 pubkey %s does not match solana holder address %s: %w",
				wantSol, holderAddr, ErrVPSignerHolderMismatch)
		}
	case "stellar":
		wantStellar := encodeStellarAccount(pubKey)
		if wantStellar != holderAddr {
			return fmt.Errorf("recovered ed25519 pubkey %s does not match stellar holder address %s: %w",
				wantStellar, holderAddr, ErrVPSignerHolderMismatch)
		}
	default:
		return fmt.Errorf("namespace %q is not supported for ed25519 VP holder binding (only solana and stellar): %w",
			namespace, ErrUnsupportedProofType)
	}
	return nil
}

// evmHashToTronBase58 mirrors the shared EvmHashToTronBase58 helper
// inline so ld-verification doesn't have to pull the blockchain
// module into its go.mod. Tron base58check encoding: prepend 0x41
// (mainnet prefix) to the 20-byte EVM hash, append the first 4 bytes
// of SHA256(SHA256(0x41||hash)) as the checksum, base58-encode the
// resulting 25 bytes. EVM and Tron derive their addresses from the
// same secp256k1 pubkey hash; this is purely a format change.
func evmHashToTronBase58(addr common.Address) string {
	payload := make([]byte, 21)
	payload[0] = 0x41
	copy(payload[1:], addr.Bytes())
	h1 := sha256.Sum256(payload)
	h2 := sha256.Sum256(h1[:])
	out := make([]byte, 25)
	copy(out[:21], payload)
	copy(out[21:], h2[:4])
	return base58.Encode(out)
}

// holderEquals returns true when two did:pkh URIs identify the same
// chain account. Splits both into 5 segments:
//
//	did : pkh : <namespace> : <reference> : <address>
//
// The first four segments are W3C case-insensitive per the DID spec;
// the address segment is per-namespace case-sensitive (Solana base58
// pubkey and Tron base58check addresses MUST byte-compare). A flat
// EqualFold would silently match `did:pkh:solana:devnet:Abc...` against
// `did:pkh:solana:devnet:abc...`, two different Solana accounts.
//
// Returns false for any input that doesn't have at least 5 colon-
// separated segments — that's a malformed did:pkh and a fail-closed
// rejection is safer than guessing.
func holderEquals(a, b string) bool {
	aSeg, ok := splitDIDPKH(a)
	if !ok {
		return false
	}
	bSeg, ok := splitDIDPKH(b)
	if !ok {
		return false
	}
	// did + pkh + namespace + reference — case-insensitive.
	for i := 0; i < 4; i++ {
		if !strings.EqualFold(aSeg[i], bSeg[i]) {
			return false
		}
	}
	// Address segment — chain-aware. eip155 is
	// hex; EIP-55 mixed-case is a checksum, not a different address,
	// so case-fold. solana / tron use base58 / base58check which ARE
	// case-sensitive — case-fold there would collapse two distinct
	// accounts. Default to exact compare on unknown namespaces so a
	// new chain doesn't silently widen the equality.
	switch strings.ToLower(aSeg[2]) {
	case "eip155":
		return strings.EqualFold(aSeg[4], bSeg[4])
	default:
		return aSeg[4] == bSeg[4]
	}
}

// splitDIDPKH parses `did:pkh:<namespace>:<reference>:<address>` (with
// an optional `#fragment` already stripped or still attached) into its
// five segments. Returns ok=false when the input doesn't have at least
// five segments — callers fail closed.
func splitDIDPKH(did string) ([5]string, bool) {
	bare := stripDIDFragment(did)
	parts := strings.SplitN(bare, ":", 5)
	var out [5]string
	if len(parts) < 5 {
		return out, false
	}
	copy(out[:], parts)
	return out, true
}

// didNetwork returns the "<namespace>:<reference>" prefix of a did:pkh
// URI for callers that want to dispatch on chain (e.g. eip155:1 vs
// solana:devnet). Returns "" for malformed input — the verifier already
// rejected those upstream via the holder-equality check.
//
// The output is always lowercased: W3C says the DID method + namespace
// + reference are case-insensitive, but the verifier's wire input may
// arrive in any case. Lowercasing here keeps consumer compares
// (`if r.DIDNetwork == "eip155:1"`) reliable regardless of the wire
// shape. The address segment (which IS per-namespace case-sensitive
// for Solana / Tron) is dropped before lowercasing — see splitDIDPKH
// / holderEquals for the address-segment compare.
func didNetwork(did string) string {
	const prefix = "did:pkh:"
	bare := stripDIDFragment(did)
	if !strings.HasPrefix(strings.ToLower(bare), prefix) {
		return ""
	}
	rest := bare[len(prefix):]
	parts := strings.SplitN(rest, ":", 3)
	if len(parts) < 2 {
		return ""
	}
	return strings.ToLower(parts[0]) + ":" + strings.ToLower(parts[1])
}

// refuseAmbiguousMembers refuses a document in which any object names a
// member twice, exactly or under encoding/json's case folding. The value of
// an "@context" member is not inspected: JSON-LD contexts legitimately define
// terms that differ only in case.
func refuseAmbiguousMembers(what string, document []byte) error {
	path, err := jsonmembers.FirstAmbiguousMember(document)
	if err != nil {
		return fmt.Errorf("%s is not a single JSON document: %w", what, errors.Join(ErrMalformedQuote, err))
	}
	if path != "" {
		return fmt.Errorf("%s names a member twice, exactly or differing only in letter case, at %s: %w", what, path, ErrAmbiguousMember)
	}
	return nil
}

// rawProofCreated returns proof.created as the signing input reads it: the
// exact `proof` member's exact `created` string, parsed as RFC 3339.
func rawProofCreated(envelopeJSON []byte) (time.Time, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(envelopeJSON, &top); err != nil {
		return time.Time{}, fmt.Errorf("failed to parse FulfillmentQuoteEnvelope: %w", errors.Join(ErrMalformedQuote, err))
	}
	var proof map[string]json.RawMessage
	if err := json.Unmarshal(top["proof"], &proof); err != nil {
		return time.Time{}, fmt.Errorf("proof is not an object: %w", errors.Join(ErrMalformedProof, err))
	}
	var raw string
	if err := json.Unmarshal(proof["created"], &raw); err != nil {
		return time.Time{}, fmt.Errorf("proof.created is not a string: %w", errors.Join(ErrMalformedProof, err))
	}
	created, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return time.Time{}, fmt.Errorf("proof.created %q is not an RFC 3339 time: %w", raw, errors.Join(ErrMalformedProof, err))
	}
	return created, nil
}
