package ldverification

// Cryptographic verification of each embedded VC's own proof
// block. Pairs with verify_vp.go's per-VC POLICY checks (date window,
// issuer-trust string match, subject-holder binding, required types)
// to close the residual threat-model gap the SECURITY NOTE called out:
// a compromised holder forging new VPs whose embedded VCs claim any
// trusted issuer DID. After this check, a holder-key compromise
// downgrades to a stolen-key incident contained to the holder's own
// DID — the attacker cannot synthesise new VCs without the issuer's
// signing key.
//
// Scope:
//
//   - EcdsaSecp256k1RecoverySignature2020 — the MVP issuer shape.
//     Mirrors the issuer-side signing protocol byte-for-byte.
//   - Ed25519Signature2020 — same canonical
//     hash composition (HashQuote with the ed25519 suite context)
//     followed by ed25519.Verify against the issuer's published JWK
//     (kty=OKP, crv=Ed25519, x=base64url(32-byte pubkey)). Pairs with
//     verify_vp.go's verifyVPEd25519 path — same JWK shape, same
//     multibase-base58btc decoding for the proof value.
//
// Unsupported proof types route to ErrVPVCUnsupportedProofType so the
// compliance-class signal stays accurate at the perimeter taxonomy.
//
// What this file is NOT:
//   - DID resolution. The IssuerKeyResolver interface declares the
//     contract; the did:web resolver provides the production
//     implementation. Tests pass an in-process mock.
//   - Mode dispatch. The caller decides whether to invoke VerifyVCProof
//     at all and how to map its errors onto the
//     audit/permissive/strict ladder.

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	fqe "github.com/atum-labs/protocol/schemas/declarations/FulfillmentQuoteEnvelope/v1/bindings/go/generated"
	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// IssuerKeyResolver resolves a VC issuer DID to the set of
// verificationMethods that DID publishes. Implementations are expected
// to cache; VerifyVCProof calls Resolve once per VC verified and
// surfaces any returned error as ErrVPVCIssuerUnresolvable to the
// caller (the perimeter dispatches on the wrapped sentinel for the
// per-reason metric tag).
//
// The contract is intentionally narrow — a single Resolve call per
// issuer DID, returning the full verificationMethod set the document
// publishes. Key selection (by proof.verificationMethod URL fragment)
// happens inside VerifyVCProof, not at the resolver, so test mocks
// can be written without re-implementing fragment lookup.
type IssuerKeyResolver interface {
	// Resolve fetches the verificationMethod set for an issuer DID.
	// Implementations MUST be safe for concurrent use — the perimeter
	// calls VerifyVCProof on per-bid goroutines.
	//
	// The returned VerificationMethodSet MUST contain at least one
	// entry on success; an empty set is treated as
	// ErrVPVCIssuerUnresolvable.
	Resolve(ctx context.Context, issuerDID string) (VerificationMethodSet, error)
}

// VerificationMethodSet is the parsed verificationMethod[] array from
// a DID document. Order-preserved so the first lookup hits the most-
// recently-published key under standard issuer key-rotation discipline
// (new key prepended, old key kept for the overlap window).
//
// The set carries only the fields VerifyVCProof needs to verify a
// proof — `id` (the DID URL the proof's verificationMethod field
// references), `type` (currently only JsonWebKey2020 is recognised),
// and the public-key material (`publicKeyJwk` for JsonWebKey2020).
// Additional fields the DID document publishes (controller,
// keyAgreement relationships, etc.) are intentionally dropped — they
// are not part of the proof-verification contract and surfacing them
// would invite callers to grow dependencies on transport details.
type VerificationMethodSet []VerificationMethod

// FindByID returns the first verificationMethod whose id matches
// the supplied DID URL (e.g. "did:web:atumlabs.xyz#issuer-key-1").
// The bool reports whether a match was found — VerifyVCProof routes
// a false return to ErrVPVCIssuerKeyMismatch.
func (s VerificationMethodSet) FindByID(id string) (VerificationMethod, bool) {
	for _, vm := range s {
		if vm.ID == id {
			return vm, true
		}
	}
	return VerificationMethod{}, false
}

// VerificationMethod is a single parsed entry from a DID document's
// verificationMethod array. Carries the minimum fields the
// VerifyVCProof dispatch needs; resolvers are expected to populate
// these from whatever shape the source DID document uses
// (publicKeyJwk for JsonWebKey2020, publicKeyMultibase for ed25519
// suites, etc.).
type VerificationMethod struct {
	// ID is the DID URL identifying this key — exactly the string
	// VerifyVCProof matches against the VC proof's verificationMethod
	// field (e.g. "did:web:atumlabs.xyz#issuer-key-1").
	ID string

	// Type is the verificationMethod's JSON-LD type. MVP recognises
	// "JsonWebKey2020" only; resolvers returning an unrecognised type
	// surface as ErrVPVCUnsupportedProofType when VerifyVCProof
	// dispatches.
	Type string

	// PublicKeyJWK is the JWK form of the public key when Type is
	// JsonWebKey2020. For secp256k1 issuer keys (the only MVP shape):
	// {kty: "EC", crv: "secp256k1", x: <base64url>, y: <base64url>}.
	// VerifyVCProof reconstructs the 65-byte uncompressed pubkey
	// (0x04 || X || Y) and derives the EVM address via Keccak256
	// per the issuer-side derivation.
	PublicKeyJWK map[string]interface{}
}

// VerifyVCProofOptions carries the per-call inputs VerifyVCProof
// needs that aren't already on the VerificationMethod itself.
// Currently only the resolver context propagates here; the struct
// shape exists so future per-call options (e.g. clock for proof
// freshness if we ever check it here) can be added without an
// API break.
type VerifyVCProofOptions struct {
	// Context is propagated to the resolver. Required — pass
	// context.Background() if the caller has no timeout to enforce
	// (the resolver MAY enforce its own).
	Context context.Context

	// HolderDID is the VP envelope's verified holder (chain-canonical
	// did:pkh form) — REQUIRED to verify a HOLDER-ISSUED VC. When the
	// VC's issuer DID is did:pkh:* the resolver is NOT consulted: the
	// issuer MUST equal HolderDID (ErrVPVCIssuerNotHolder otherwise) and
	// the proof verifies by secp256k1 recovery against the holder's
	// did:pkh address — the same recovery machinery the outer VP
	// signature uses. Empty HolderDID fails any did:pkh-issued VC closed
	// with ErrVPVCIssuerNotHolder (a caller that didn't thread the holder
	// cannot vouch for a holder-issued credential). did:web issuers
	// ignore this field entirely (resolver path unchanged).
	HolderDID string
}

// VerifyVCProof cryptographically verifies a VC's proof block against
// the issuer's published key, resolved via the supplied
// IssuerKeyResolver. Dispatches on proof.type; reuses the existing
// recovery primitives for the supported cryptosuites.
//
// `vc` is the typed binding (used for the issuer-DID lookup only).
// `rawVC` is the verbatim wire JSON of the VC — the marshal source
// of truth for canonicalization. Passing the raw bytes instead of
// round-tripping the typed binding eliminates a
// silent-canonicalization-drift surface where the binding's marshal
// output may differ from the wire form (e.g. typed nil pointers vs
// absent fields, RFC3339 vs alternative time encodings). The same
// pattern verify_vp.go's AttestedClaims uses for the OUTER VP signal.
//
// Returns:
//   - nil on a passing signature.
//   - ErrVPVCIssuerUnresolvable when the resolver returns an error
//     OR an empty VerificationMethodSet (resolver implementations
//     MUST treat "issuer DID document not fetchable" as an error;
//     this fallback catches a buggy resolver returning empty + nil).
//   - ErrVPVCIssuerKeyMismatch when the resolver returned a non-empty
//     set but no entry matches the proof's verificationMethod URL.
//   - ErrVPVCUnsupportedProofType when proof.type isn't in the
//     dispatch table OR the matched VerificationMethod.Type isn't
//     JsonWebKey2020 (the only MVP recognised type) OR proof.@context
//     doesn't match the cryptosuite (canonicalization-confusion
//     attack surface).
//   - ErrVPVCSignatureInvalid when the signature verifies-but-doesn't
//     (recovered key ≠ resolver-published key for secp256k1; ed25519
//     verify returns false).
//   - ErrMalformedQuote for VC structural shape errors that prevent
//     the dispatch from running (missing proof block, missing
//     verificationMethod, malformed jws).
//
// All errors wrap ErrMalformedProof so the umbrella check the FQ /
// VP verifiers already use stays behavior-preserving.
//
// CONTRACT WITH ISSUER SIGNING: this is the verifier mirror of the
// issuer-side proof Apply step. The canonicalization, hash
// composition, and signature recovery MUST stay in lockstep — any
// divergence here corrupts every signature.
//
// SCOPE — what this function does and does NOT verify:
//
// VerifyVCProof verifies cryptographic integrity over the canonical
// n-quads produced by URDNA2015. It does NOT verify claim-binding
// completeness — whether every JSON field in the VC actually appears
// in the signed n-quads. That's a separate property owned by the
// VC's @context array + the issuer's contract on which terms are
// bound.
//
// The asymmetry between the document-loader's strictness
// (canonicalize.go rejects unknown CONTEXT URLs — strict-fail-closed)
// and JSON-LD expansion's silent-drop of unknown TERMS inside a known
// context is load-bearing: a producer can attach a claim field under
// a context that doesn't bind it; URDNA2015 silently elides the
// field; the signed n-quads cover the BOUND terms only. The signature
// mathematically verifies; an attacker flipping an unbound field
// produces a still-mathematically-valid VC. The verifier cannot
// detect that — it has no way to know which JSON fields were dropped
// during canonicalization vs which were absent in the first place.
//
// The context binding closes this gap for the terms atum-issued
// credentials actually use:
//
//   - `KnownToAtumVerifiableCredential` @type alias — bound to a
//     stable IRI in the known-to-atum v1 context. The earlier
//     behavior diverged cross-language (json-gold vs jsonld.js handled
//     the unbound alias differently); now it appears in the
//     canonical n-quads on both sides identically.
//   - `role` term + role values (`settler`, `psp`,
//     `atumOperatedService`) — the actual claim the production
//     issuer emits on credentialSubject. Bound under `kta:` so a
//     role-flip is signature-detectable. The known-to-atum v2
//     context also binds `quoteAwarder` and `merchant`, which v1
//     does not: under v1 those two roles are outside the signed
//     bytes, so a caller should trust either only from a v2
//     credential. VerifyVCProof does not check this.
//   - `knownToAtum` boolean field — defensively bound
//     (xsd:boolean). Production credentials don't emit this field
//     today; the binding is future-proofing so an issuer code
//     change that does start emitting it won't silently un-attest
//     the claim.
//
// Residual: a future producer that introduces a NEW claim field
// under a context that doesn't bind it (e.g. a brand-new attribute
// not yet vendored into known-to-atum v1) is still subject to the
// silent-drop semantic. The mitigation is the same as for any
// schema-evolution event: extend the context binding alongside the
// issuer-code change. The `TestKnownToAtumFieldBinding` test
// (Go + TS twin) and the conformance tests' load-bearing-predicate-
// presence assertions catch any binding regression at CI time
// before it ships to production.
func VerifyVCProof(vc fqe.VerifiableCredential, rawVC json.RawMessage, resolver IssuerKeyResolver, opts VerifyVCProofOptions) error {
	if resolver == nil {
		// Defensive — callers wiring this through VerifyVPOptions
		// pass nil to mean "skip the check" per the upstream
		// contract. VerifyVCProof itself rejects nil so an
		// accidental direct call doesn't silently accept.
		return fmt.Errorf("VerifyVCProof: resolver is required: %w", ErrMalformedQuote)
	}
	if opts.Context == nil {
		return fmt.Errorf("VerifyVCProof: opts.Context is required: %w", ErrMalformedQuote)
	}
	if len(rawVC) == 0 {
		return fmt.Errorf("VerifyVCProof: rawVC is empty: %w", ErrMalformedQuote)
	}
	// Refused before any read, as VerifyVP refuses an envelope: vc is the
	// caller's typed decode of these bytes, and that decode matches member
	// names under case folding.
	if err := refuseAmbiguousMembers("VerifyVCProof: the credential", rawVC); err != nil {
		return err
	}

	// Parse the wire bytes directly — never marshal back from the
	// typed binding.
	rawVCMap, proof, err := extractVCProofFromRaw(rawVC)
	if err != nil {
		return err
	}

	issuerDID, err := vcIssuerDID(vc)
	if err != nil {
		return err
	}

	// HOLDER-ISSUED VC path. A did:pkh issuer is a wallet, not a did:web
	// document host — there is nothing to resolve. The only did:pkh
	// issuer the trust model admits is the VP's own holder (the
	// originator attesting its client under the same custodied key that
	// signs the envelope), so the branch never touches the resolver: it
	// requires issuer == opts.HolderDID and verifies the proof by
	// secp256k1 recovery against the issuer's did:pkh address.
	if isDIDPKH(issuerDID) {
		return verifyVCProofHolderIssued(rawVCMap, proof, issuerDID, opts.HolderDID)
	}

	vmSet, err := resolver.Resolve(opts.Context, issuerDID)
	if err != nil {
		return fmt.Errorf("VerifyVCProof: resolver: %w", errors.Join(ErrVPVCIssuerUnresolvable, err))
	}
	if len(vmSet) == 0 {
		return fmt.Errorf("VerifyVCProof: resolver returned empty verificationMethod set for %q: %w",
			issuerDID, ErrVPVCIssuerUnresolvable)
	}

	proofType, _ := proof["type"].(string)
	verificationMethodURL, _ := proof["verificationMethod"].(string)
	if verificationMethodURL == "" {
		return fmt.Errorf("VerifyVCProof: proof.verificationMethod is missing or not a string: %w",
			ErrMalformedQuote)
	}

	// Validate proof.proofPurpose against the package constant before
	// dispatch, mirroring the FQ and VP verifiers. Defense-in-depth
	// against future cross-purpose key reuse: today the value is
	// inside the signed hash and the issuer only signs with
	// `assertionMethod`, but the moment the issuer's KMS key signs
	// any non-`assertionMethod` proof (auth challenge, status
	// attestation), that signature would be replayable as a VC
	// assertion. Enforcing the purpose at dispatch makes the W3C
	// Data Integrity §4.2 requirement explicit and grep-able. Type
	// asserts via the two-return form so a non-string `proofPurpose`
	// (e.g. a number) classifies as ErrVPVCUnsupportedProofType
	// rather than being silently coerced to "" and then mis-routed
	// to a signature-invalid metric label.
	proofPurpose, _ := proof["proofPurpose"].(string)
	if proofPurpose != expectedProofPurpose {
		return fmt.Errorf("VerifyVCProof: proof.proofPurpose %q, want %q: %w",
			proofPurpose, expectedProofPurpose, ErrVPVCUnsupportedProofType)
	}

	vm, ok := vmSet.FindByID(verificationMethodURL)
	if !ok {
		return fmt.Errorf("VerifyVCProof: proof.verificationMethod %q not in issuer %q's published key set: %w",
			verificationMethodURL, issuerDID, ErrVPVCIssuerKeyMismatch)
	}

	// Validate proof.@context matches the proof.type cryptosuite
	// before invoking the canonicalizer. The proof.@context value
	// comes verbatim off the
	// attacker-controlled wire VC; URDNA2015 only validates that the
	// URL resolves to a registered context, NOT that the context is
	// the *right* one for the proof type. An attacker could pair a
	// secp256k1 proof.type with the ed25519 cryptosuite @context to
	// canonicalize under different term bindings — defeated today by
	// the verificationMethod URL → resolver-key gate, but no test
	// pinned that defence and a future refactor that swaps the
	// address-check order could silently re-open the gap. Requiring
	// the suite/context coherence at dispatch makes the contract
	// explicit and grep-able.
	if err := requireProofContextMatchesSuite(proofType, proof); err != nil {
		return err
	}

	switch proofType {
	case ProofTypeSecp256k1Recovery2020:
		return verifyVCProofSecp256k1(rawVCMap, proof, vm)
	case ProofTypeEd25519Signature2020:
		return verifyVCProofEd25519(rawVCMap, proof, vm)
	default:
		return fmt.Errorf("VerifyVCProof: proof.type %q not supported: %w",
			proofType, ErrVPVCUnsupportedProofType)
	}
}

// verifyVCProofSecp256k1 mirrors the issuer-side signing protocol:
//
//  1. Build a proof template from the proof block minus its jws field.
//  2. URDNA2015-canonicalize the credential body (proof stripped) and
//     the proof template separately.
//  3. Compute combinedHash = Keccak256(Keccak256(canonicalProof) ||
//     Keccak256(canonicalCredential)).
//  4. RecoverAddress on the JWS signature → EVM address.
//  5. Compare recovered to the address derived from the resolver's
//     JWK (Keccak256 of uncompressed-pubkey[1:]).
//
// Reuses HashQuote for the canonicalization + hash composition — the
// same primitive verify_vp.go's verifyVPSecp256k1 uses for the OUTER
// VP signature. Same protocol = no new crypto path on the verifier
// side; the only delta is the input shape (a VC instead of a VP).
func verifyVCProofSecp256k1(rawVC map[string]any, proof map[string]any, vm VerificationMethod) error {
	if vm.Type != "JsonWebKey2020" {
		return fmt.Errorf("verifyVCProofSecp256k1: verificationMethod.type %q not supported (want JsonWebKey2020): %w",
			vm.Type, ErrVPVCUnsupportedProofType)
	}

	jwsRaw, _ := proof["jws"].(string)
	if jwsRaw == "" {
		return fmt.Errorf("verifyVCProofSecp256k1: proof.jws is missing or empty: %w",
			ErrMissingSignatureMaterial)
	}
	_, signature, err := ParseDetachedJWS(jwsRaw)
	if err != nil {
		return fmt.Errorf("verifyVCProofSecp256k1: %w", err)
	}

	// The proof block on the wire carries @context, type, created,
	// verificationMethod, proofPurpose, jws. HashQuote takes the proof
	// options (everything except jws) and the canonicalization
	// recipe is: VC body sans proof + proof options block. The
	// proofContext is the proof's @context (which the issuer sets to
	// the secp256k1recovery suite URL).
	//
	// `created` and `verificationMethod`
	// MUST be present + string-typed. The earlier `_, _ :=
	// proof[k].(string)` idiom silently coerced a missing / non-string
	// value to "" and fed it into HashQuote, which then mismatched
	// the issuer-side input and surfaced as ErrVPVCSignatureInvalid.
	// That mis-routed a malformed-input bug to the crypto-failure
	// metric label, blinding ops dashboards to a producer-side
	// regression. Fail-fast with ErrMalformedQuote so the
	// compliance taxonomy carries the right signal.
	proofContext, _ := proof["@context"]
	created, ok := proof["created"].(string)
	if !ok || created == "" {
		return fmt.Errorf("verifyVCProofSecp256k1: proof.created is missing or not a string: %w",
			ErrMalformedQuote)
	}
	verificationMethodURL, ok := proof["verificationMethod"].(string)
	if !ok || verificationMethodURL == "" {
		// Defense-in-depth — the dispatch caller (VerifyVCProof) also
		// gates this, but the leaf path validating its own inputs
		// keeps the contract local and survives a future direct
		// caller that bypasses the dispatch wrapper.
		return fmt.Errorf("verifyVCProofSecp256k1: proof.verificationMethod is missing or not a string: %w",
			ErrMalformedQuote)
	}
	// proofPurpose: validated at the VerifyVCProof dispatch site
	// against expectedProofPurpose ("assertionMethod"). Pinning it
	// here in the HashQuote input means a future refactor that
	// loosens dispatch-side validation can't silently re-open the
	// cross-purpose-reuse gap.

	hash, err := HashQuote(rawVC, HashQuoteOptions{
		Cryptosuite: ProofTypeSecp256k1Recovery2020,
		ProofOptions: HashableProofOptions{
			Type:               ProofTypeSecp256k1Recovery2020,
			Created:            created,
			VerificationMethod: verificationMethodURL,
			ProofPurpose:       expectedProofPurpose,
			Context:            proofContext,
		},
		// KeepVerifiableCredential is FQ-envelope-specific; a VC body
		// doesn't carry a nested verifiableCredential array, so this
		// knob is irrelevant here. The HashQuote default (strip) is
		// the safe choice — even if a future VC shape somehow nests
		// a VC, that's a producer bug, not a verifier asymmetry.
		KeepVerifiableCredential: false,
	})
	if err != nil {
		return fmt.Errorf("verifyVCProofSecp256k1: HashQuote: %w", err)
	}

	expected, err := jwkSecp256k1ToAddress(vm.PublicKeyJWK)
	if err != nil {
		return fmt.Errorf("verifyVCProofSecp256k1: parse issuer key: %w", err)
	}

	recovered, err := recoverProofSigner(hash, signature, func(a common.Address) bool { return a == expected })
	if err != nil {
		// A recovery failure is a signature-invalid outcome (the bytes
		// are JWS-shaped, parseable, and the right length — they just
		// don't recover to any public key). Wrap as
		// ErrVPVCSignatureInvalid so the compliance taxonomy routes
		// this to the same per-reason metric tag as a successful
		// recovery-with-mismatched-address. The underlying
		// RecoverAddress error is preserved via errors.Join for
		// debug-log diving.
		return fmt.Errorf("verifyVCProofSecp256k1: RecoverAddress: %w",
			errors.Join(ErrVPVCSignatureInvalid, err))
	}

	if recovered != expected {
		return fmt.Errorf("verifyVCProofSecp256k1: recovered signer %s != issuer key %s: %w",
			recovered.Hex(), expected.Hex(), ErrVPVCSignatureInvalid)
	}
	return nil
}

// verifyVCProofEd25519 mirrors verify_vp.go's verifyVPEd25519 path
// applied to a VC body instead of a VP envelope:
//
//  1. Reconstruct the ed25519 public key from the resolver's JWK
//     (kty=OKP, crv=Ed25519, x=base64url(32-byte pubkey)).
//  2. Decode proof.proofValue from multibase-base58btc → 64-byte
//     signature.
//  3. Canonicalize the VC body (proof stripped) + proof template via
//     HashQuote with the ed25519-2020 cryptosuite — the same primitive
//     verifyVPEd25519 uses, only the input shape differs (VC vs VP).
//  4. ed25519.Verify(pubKey, signingInput, signature).
//
// Asymmetry with the secp256k1 path: ed25519 doesn't recover a key
// from the signature, so there's no recovered-vs-published address
// compare. The issuer-key gate is the resolver returning the right
// pubkey for the proof's verificationMethod URL; if that's right and
// the signature verifies, the VC is attested.
//
// CONTRACT WITH ISSUER SIGNING: mirrors the issuer-side flow. The
// hash composition is HashQuote's ed25519 branch — any divergence
// corrupts every ed25519-signed VC. The cross-language conformance
// fixtures pin the canonical n-quads byte-for-byte across Go and TS
// verifiers.
//
// proofPurpose: validated at the VerifyVCProof dispatch site against
// expectedProofPurpose ("assertionMethod"); pinning it here in the
// HashQuote input via the constant means a future refactor that
// loosens dispatch-side validation can't silently re-open the
// cross-purpose-reuse gap.
func verifyVCProofEd25519(rawVC map[string]any, proof map[string]any, vm VerificationMethod) error {
	if vm.Type != "JsonWebKey2020" {
		return fmt.Errorf("verifyVCProofEd25519: verificationMethod.type %q not supported (want JsonWebKey2020): %w",
			vm.Type, ErrVPVCUnsupportedProofType)
	}

	pubKey, err := jwkEd25519ToPublicKey(vm.PublicKeyJWK)
	if err != nil {
		return fmt.Errorf("verifyVCProofEd25519: parse issuer key: %w", err)
	}

	proofValue, _ := proof["proofValue"].(string)
	if proofValue == "" {
		return fmt.Errorf("verifyVCProofEd25519: proof.proofValue is missing or empty: %w",
			ErrMissingSignatureMaterial)
	}
	signature, err := lddataintegrity.DecodeEd25519ProofValue(proofValue)
	if err != nil {
		// Lib's DecodeEd25519ProofValue folds the prefix check, base58
		// decode, and length check into one call; translate its
		// ErrMalformedProof chain to FQ's ErrMalformedSignatureMaterial
		// for caller back-compat (errors.Is dispatch).
		return fmt.Errorf("verifyVCProofEd25519: decode proof.proofValue: %w: %v",
			ErrMalformedSignatureMaterial, err)
	}

	// Parity with the secp256k1 path —
	// `created` and `verificationMethod` MUST be present + string-
	// typed; missing / non-string values fail-fast with
	// ErrMalformedQuote rather than coercing to "" and surfacing
	// as ErrVPVCSignatureInvalid via a mismatched HashQuote input.
	proofContext := proof["@context"]
	created, ok := proof["created"].(string)
	if !ok || created == "" {
		return fmt.Errorf("verifyVCProofEd25519: proof.created is missing or not a string: %w",
			ErrMalformedQuote)
	}
	verificationMethodURL, ok := proof["verificationMethod"].(string)
	if !ok || verificationMethodURL == "" {
		return fmt.Errorf("verifyVCProofEd25519: proof.verificationMethod is missing or not a string: %w",
			ErrMalformedQuote)
	}

	hash, err := HashQuote(rawVC, HashQuoteOptions{
		Cryptosuite: ProofTypeEd25519Signature2020,
		ProofOptions: HashableProofOptions{
			Type:               ProofTypeEd25519Signature2020,
			Created:            created,
			VerificationMethod: verificationMethodURL,
			ProofPurpose:       expectedProofPurpose,
			Context:            proofContext,
		},
		KeepVerifiableCredential: false,
	})
	if err != nil {
		return fmt.Errorf("verifyVCProofEd25519: HashQuote: %w", err)
	}

	if err := lddataintegrity.VerifyEd25519(pubKey, hash.SigningInput, signature); err != nil {
		// Lib's VerifyEd25519 returns ErrEd25519Verify on a boolean-
		// false outcome (no recoverable underlying error to wrap).
		// The signature was well-formed (64 bytes, multibase-decoded
		// cleanly) but didn't verify under the issuer's published key.
		// Same compliance-class outcome as secp256k1's recovered-vs-
		// expected mismatch.
		return fmt.Errorf("verifyVCProofEd25519: ed25519 verify rejected signature for verificationMethod %q: %w",
			verificationMethodURL, ErrVPVCSignatureInvalid)
	}
	return nil
}

// jwkEd25519ToPublicKey reconstructs an ed25519.PublicKey from a JWK
// of shape {kty: "OKP", crv: "Ed25519", x: <base64url 32-byte pubkey>}.
// Mirrors the issuer-side derivation for ed25519 keys when the issuer
// adds an ed25519 signing path; the JWK shape is the canonical wire
// form per RFC 8037 §2.
func jwkEd25519ToPublicKey(jwk map[string]interface{}) (ed25519.PublicKey, error) {
	if jwk == nil {
		return nil, fmt.Errorf("publicKeyJwk is nil: %w", ErrMalformedQuote)
	}
	if kty, _ := jwk["kty"].(string); kty != "OKP" {
		return nil, fmt.Errorf("publicKeyJwk.kty = %q, want OKP: %w", kty, ErrMalformedQuote)
	}
	if crv, _ := jwk["crv"].(string); crv != "Ed25519" {
		return nil, fmt.Errorf("publicKeyJwk.crv = %q, want Ed25519: %w", crv, ErrMalformedQuote)
	}
	xStr, _ := jwk["x"].(string)
	if xStr == "" {
		return nil, fmt.Errorf("publicKeyJwk missing x coordinate: %w", ErrMalformedQuote)
	}
	x, err := base64.RawURLEncoding.DecodeString(xStr)
	if err != nil {
		return nil, fmt.Errorf("publicKeyJwk.x base64url decode: %w", errors.Join(ErrMalformedQuote, err))
	}
	if len(x) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("publicKeyJwk.x must be %d bytes, got %d: %w",
			ed25519.PublicKeySize, len(x), ErrMalformedQuote)
	}
	return ed25519.PublicKey(x), nil
}

// jwkSecp256k1ToAddress derives the EVM-style 20-byte address from a
// secp256k1 JWK (kty=EC, crv=secp256k1, x, y in base64url). Mirrors
// the issuer-side derivation which encodes
// the uncompressed pubkey's X+Y halves into the JWK; here we reverse
// that to recover the 65-byte uncompressed key, then Keccak256 the
// trailing 64 bytes and take the last 20 — the canonical Ethereum
// address derivation.
//
// Returns the address as a common.Address; canonical (case-folded)
// comparison is the caller's responsibility (RecoverAddress already
// returns common.Address; equality compare works directly).
func jwkSecp256k1ToAddress(jwk map[string]interface{}) (common.Address, error) {
	var zero common.Address
	if jwk == nil {
		return zero, fmt.Errorf("publicKeyJwk is nil: %w", ErrMalformedQuote)
	}
	if kty, _ := jwk["kty"].(string); kty != "EC" {
		return zero, fmt.Errorf("publicKeyJwk.kty = %q, want EC: %w", kty, ErrMalformedQuote)
	}
	if crv, _ := jwk["crv"].(string); crv != "secp256k1" {
		return zero, fmt.Errorf("publicKeyJwk.crv = %q, want secp256k1: %w", crv, ErrMalformedQuote)
	}
	xStr, _ := jwk["x"].(string)
	yStr, _ := jwk["y"].(string)
	if xStr == "" || yStr == "" {
		return zero, fmt.Errorf("publicKeyJwk missing x or y coordinate: %w", ErrMalformedQuote)
	}
	x, err := base64.RawURLEncoding.DecodeString(xStr)
	if err != nil {
		return zero, fmt.Errorf("publicKeyJwk.x base64url decode: %w", errors.Join(ErrMalformedQuote, err))
	}
	y, err := base64.RawURLEncoding.DecodeString(yStr)
	if err != nil {
		return zero, fmt.Errorf("publicKeyJwk.y base64url decode: %w", errors.Join(ErrMalformedQuote, err))
	}
	if len(x) != 32 || len(y) != 32 {
		return zero, fmt.Errorf("publicKeyJwk x/y must be 32 bytes each, got x=%d y=%d: %w",
			len(x), len(y), ErrMalformedQuote)
	}
	// Uncompressed secp256k1 pubkey shape per SEC 1 §2.3.3:
	// 0x04 || X || Y. The canonical Ethereum address is
	// Keccak256(uncompressed[1:])[12:] — drop the 0x04 prefix, hash
	// the 64-byte X||Y concatenation, take the last 20 bytes.
	uncompressed := make([]byte, 0, 65)
	uncompressed = append(uncompressed, 0x04)
	uncompressed = append(uncompressed, x...)
	uncompressed = append(uncompressed, y...)
	digest := crypto.Keccak256(uncompressed[1:])
	return common.BytesToAddress(digest[12:]), nil
}

// requireProofContextMatchesSuite asserts the wire VC's
// proof.@context resolves to the cryptosuite expected for the
// declared proof.type. The proof.@context value is attacker-
// controlled (off the wire); URDNA2015 only validates URL-vs-
// registered-contexts, not semantic coherence. A mismatched pair
// (e.g. proof.type=secp256k1, proof.@context=ed25519-2020 URL)
// canonicalizes under different term bindings — the
// verificationMethod URL gate still defends today, but this gate
// makes the contract explicit and test-pinnable.
//
// Accepted shapes for proof.@context:
//   - string equal to the cryptosuite's canonical URL.
//   - array containing the cryptosuite's URL anywhere.
//   - absent (nil) — HashQuote falls back to the suite default; that
//     branch is a producer-side oversight but not exploitable since
//     the verifier-side default matches what the issuer would have
//     used anyway.
//
// Anything else routes to ErrVPVCUnsupportedProofType so the
// per-reason metric tag stays accurate.
func requireProofContextMatchesSuite(proofType string, proof map[string]any) error {
	wanted := suiteContextURL(proofType)
	if wanted == "" {
		// proof.type dispatch will catch this; defensive duplicate.
		return fmt.Errorf("VerifyVCProof: cannot derive cryptosuite context for proof.type %q: %w",
			proofType, ErrVPVCUnsupportedProofType)
	}
	ctx, hasCtx := proof["@context"]
	if !hasCtx || ctx == nil {
		return nil // HashQuote's suite-default applies; safe.
	}
	switch v := ctx.(type) {
	case string:
		if v != wanted {
			return fmt.Errorf("VerifyVCProof: proof.@context %q does not match cryptosuite %q (expected %q): %w",
				v, proofType, wanted, ErrVPVCUnsupportedProofType)
		}
		return nil
	case []any:
		for _, entry := range v {
			if s, ok := entry.(string); ok && s == wanted {
				return nil
			}
		}
		return fmt.Errorf("VerifyVCProof: proof.@context array does not include cryptosuite %q (expected %q in %v): %w",
			proofType, wanted, v, ErrVPVCUnsupportedProofType)
	default:
		return fmt.Errorf("VerifyVCProof: proof.@context has unexpected JSON-LD shape %T: %w",
			ctx, ErrVPVCUnsupportedProofType)
	}
}

// isDIDPKH reports whether a DID uses the did:pkh method. The method
// segment is case-insensitive per the W3C DID spec — fold before the
// prefix compare (mirrors didNetwork's handling in verify_vp.go).
func isDIDPKH(did string) bool {
	return strings.HasPrefix(strings.ToLower(did), "did:pkh:")
}

// verifyVCProofHolderIssued verifies a HOLDER-ISSUED VC's proof block.
// did:pkh issuers have no DID document to resolve — the issuer IS a
// wallet — so instead of the resolver/JWK path:
//
//  1. REQUIRE issuer == holderDID (chain-aware holderEquals). The only
//     did:pkh issuer the trust model admits is the VP's own holder;
//     any other wallet claiming issuer-ship is forgery-shaped →
//     ErrVPVCIssuerNotHolder in ALL modes. An empty holderDID fails
//     closed the same way — a caller that didn't thread the verified
//     holder cannot vouch for a holder-issued credential.
//  2. Verify the proof by secp256k1 RECOVERY: the same canonicalize +
//     HashQuote composition the resolver path's secp256k1 leaf uses,
//     then RecoverAddress and bind the recovered signer to the
//     issuer's did:pkh address via signerMatchesHolderSecp256k1 — the
//     exact machinery the OUTER VP holder signature already trusts.
//
// proofPurpose / proof-context-suite gates mirror the VerifyVCProof
// dispatch (this branch forks BEFORE those shared checks run, so it
// owns its own copies). Non-secp256k1 proof types (e.g. an ed25519
// solana issuer) fail closed with ErrVPVCUnsupportedProofType — the
// recovery-based holder binding only exists for secp256k1 chains.
func verifyVCProofHolderIssued(rawVC map[string]any, proof map[string]any, issuerDID, holderDID string) error {
	if holderDID == "" {
		return fmt.Errorf("verifyVCProofHolderIssued: VC issuer %q is did:pkh but no HolderDID was supplied (holder-issued VC verification requires the envelope's verified holder): %w",
			issuerDID, ErrVPVCIssuerNotHolder)
	}
	if !holderEquals(issuerDID, holderDID) {
		return fmt.Errorf("verifyVCProofHolderIssued: VC issuer %q does not equal VP holder %q: %w",
			issuerDID, holderDID, ErrVPVCIssuerNotHolder)
	}

	proofType, _ := proof["type"].(string)
	proofPurpose, _ := proof["proofPurpose"].(string)
	if proofPurpose != expectedProofPurpose {
		return fmt.Errorf("verifyVCProofHolderIssued: proof.proofPurpose %q, want %q: %w",
			proofPurpose, expectedProofPurpose, ErrVPVCUnsupportedProofType)
	}
	if err := requireProofContextMatchesSuite(proofType, proof); err != nil {
		return err
	}
	if proofType != ProofTypeSecp256k1Recovery2020 {
		return fmt.Errorf("verifyVCProofHolderIssued: proof.type %q not supported for did:pkh issuers (only %s — recovery-based holder binding): %w",
			proofType, ProofTypeSecp256k1Recovery2020, ErrVPVCUnsupportedProofType)
	}

	jwsRaw, _ := proof["jws"].(string)
	if jwsRaw == "" {
		return fmt.Errorf("verifyVCProofHolderIssued: proof.jws is missing or empty: %w",
			ErrMissingSignatureMaterial)
	}
	_, signature, err := ParseDetachedJWS(jwsRaw)
	if err != nil {
		return fmt.Errorf("verifyVCProofHolderIssued: %w", err)
	}

	// Same fail-fast input validation as the resolver-path secp256k1
	// leaf — a missing/non-string created or verificationMethod is a
	// malformed-input bug, not a crypto failure.
	proofContext := proof["@context"]
	created, ok := proof["created"].(string)
	if !ok || created == "" {
		return fmt.Errorf("verifyVCProofHolderIssued: proof.created is missing or not a string: %w",
			ErrMalformedQuote)
	}
	verificationMethodURL, ok := proof["verificationMethod"].(string)
	if !ok || verificationMethodURL == "" {
		return fmt.Errorf("verifyVCProofHolderIssued: proof.verificationMethod is missing or not a string: %w",
			ErrMalformedQuote)
	}

	hash, err := HashQuote(rawVC, HashQuoteOptions{
		Cryptosuite: ProofTypeSecp256k1Recovery2020,
		ProofOptions: HashableProofOptions{
			Type:               ProofTypeSecp256k1Recovery2020,
			Created:            created,
			VerificationMethod: verificationMethodURL,
			ProofPurpose:       expectedProofPurpose,
			Context:            proofContext,
		},
		KeepVerifiableCredential: false,
	})
	if err != nil {
		return fmt.Errorf("verifyVCProofHolderIssued: HashQuote: %w", err)
	}

	recovered, err := recoverProofSigner(hash, signature, func(a common.Address) bool {
		return signerMatchesHolderSecp256k1(a, issuerDID) == nil
	})
	if err != nil {
		return fmt.Errorf("verifyVCProofHolderIssued: RecoverAddress: %w",
			errors.Join(ErrVPVCSignatureInvalid, err))
	}

	// Bind the recovered signer to the issuer's did:pkh address — the
	// chain-aware compare the outer VP holder binding uses (case-fold
	// eip155 hex, exact base58check tron, unknown namespaces fail
	// closed). A mismatch means the signature bytes don't authenticate
	// under the claimed issuer key → signature-invalid class.
	if err := signerMatchesHolderSecp256k1(recovered, issuerDID); err != nil {
		return fmt.Errorf("verifyVCProofHolderIssued: recovered signer does not match did:pkh issuer %q: %w",
			issuerDID, errors.Join(ErrVPVCSignatureInvalid, err))
	}
	return nil
}

// extractVCProofFromRaw parses the wire VC bytes into a map view,
// then separates the proof block. Never round-trip through the typed
// binding, since that introduces a shape-drift surface where
// canonical n-quads diverge
// from what the issuer signed (binding adds typed-zero-value fields,
// normalises RFC3339 time encodings, etc.). The wire bytes are the
// canonical marshal source-of-truth.
//
// Returns ErrMalformedQuote when the bytes fail to parse or the
// proof block is missing — by the time VerifyVCProof is invoked,
// the proof block MUST be present (or there's nothing to verify).
func extractVCProofFromRaw(rawVC json.RawMessage) (vcMap map[string]any, proof map[string]any, err error) {
	var asMap map[string]any
	if err := json.Unmarshal(rawVC, &asMap); err != nil {
		return nil, nil, fmt.Errorf("extractVCProofFromRaw: unmarshal VC: %w", errors.Join(ErrMalformedQuote, err))
	}
	proofRaw, hasProof := asMap["proof"]
	if !hasProof {
		return nil, nil, fmt.Errorf("extractVCProofFromRaw: VC has no proof block: %w", ErrMissingProof)
	}
	proof, ok := proofRaw.(map[string]any)
	if !ok {
		return nil, nil, fmt.Errorf("extractVCProofFromRaw: VC proof is not an object: %w", ErrMalformedQuote)
	}
	vcMap = make(map[string]any, len(asMap)-1)
	for k, v := range asMap {
		if k == "proof" {
			continue
		}
		vcMap[k] = v
	}
	return vcMap, proof, nil
}
