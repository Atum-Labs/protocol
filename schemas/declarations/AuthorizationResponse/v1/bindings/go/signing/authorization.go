package authorizationresponse

import (
	"encoding/json"
	"fmt"
	"maps"
	"time"

	. "github.com/atum-labs/protocol/schemas/declarations/AuthorizationResponse/v1/bindings/go/generated"
	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"

	"github.com/ethereum/go-ethereum/crypto"
)

// ProofSigner abstracts the signing backend used by [BuildAuthorizationResponse].
//
// Sign returns the encoded signature in the form expected by the
// AuthorizationResponse proof field for the signer's suite:
//
//   - EcdsaSecp256k1RecoverySignature2020 → detached JWS string (proof.jws)
//   - Ed25519Signature2020 → multibase base58btc string (proof.proofValue)
//
// VerificationMethod returns the full DID URL identifying the signer's key
// (DID + fragment, e.g. "did:pkh:eip155:1:0xabc...#blockchainAccountId").
//
// SuiteType returns a value matching one of the DataIntegrityProofType
// constants. Implementations sign the digest with ld-data-integrity
// primitives (e.g. a secp256k1 signer) and supply the DID URL + suite
// identifier.
type ProofSigner interface {
	Sign(digest []byte) (string, error)
	VerificationMethod() string
	SuiteType() string
}

// suiteContextURL returns the W3C Data Integrity suite context URL the
// proof is signed under, dispatched by the signer's suite identifier.
// The returned URL must resolve through docLoader (ld-data-integrity
// vendors the secp256k1recovery-2020-v2 context as a generic suite context);
// Ed25519 lands in a follow-up commit once its suite context is wired.
func suiteContextURL(suiteType string) (string, error) {
	switch suiteType {
	case string(DataIntegrityProofTypeEcdsaSecp256K1RecoverySignature2020):
		return lddataintegrity.Secp256k1Recovery2020V2CtxURL, nil
	case string(DataIntegrityProofTypeEd25519Signature2020):
		return "", fmt.Errorf("Ed25519Signature2020 not yet supported (follow-up commit registers the suite context)")
	default:
		return "", fmt.Errorf("unsupported suite type: %q", suiteType)
	}
}

// BuildAuthorizationResponse constructs a fully-signed [SchemaJson] per the
// W3C Data Integrity 1.0 profile:
//
//  1. doc (response with proof.jws/proof.proofValue stripped) canonicalized via URDNA2015.
//  2. proofOptions (proof.jws/proof.proofValue stripped, @context = [suiteContextURL])
//     canonicalized via URDNA2015.
//  3. combinedHash = keccak256( keccak256(proofOptions_nq) || keccak256(doc_nq) ).
//  4. combinedHash signed via signer.Sign(...).
//  5. signature attached at proof.jws (ECDSA) or proof.proofValue (Ed25519).
//
// Callers pass `now` explicitly so tests can pin a deterministic timestamp;
// production wires time.Now(). The timestamp is truncated to second
// precision so json.Marshal produces a "Z"-suffixed RFC 3339 string with
// no nanoseconds — keeping byte-for-byte canonicalization stable across
// the sign/verify pair.
func BuildAuthorizationResponse(
	decision SchemaJsonStatus,
	paymentID, counterpartyDID string,
	reason *string,
	signer ProofSigner,
	now time.Time,
) (*SchemaJson, error) {
	if signer == nil {
		return nil, fmt.Errorf("BuildAuthorizationResponse: signer is required")
	}
	if paymentID == "" {
		return nil, fmt.Errorf("BuildAuthorizationResponse: paymentID is required")
	}
	if counterpartyDID == "" {
		return nil, fmt.Errorf("BuildAuthorizationResponse: counterpartyDID is required")
	}
	if decision == SchemaJsonStatusDeclined && reason == nil {
		return nil, fmt.Errorf("BuildAuthorizationResponse: reason required when status=declined")
	}
	suiteCtx, err := suiteContextURL(signer.SuiteType())
	if err != nil {
		return nil, err
	}

	resp := &SchemaJson{
		Context:         []string{AuthorizationResponseContextURL, suiteCtx},
		Status:          decision,
		PaymentId:       paymentID,
		CounterpartyDid: counterpartyDID,
		Reason:          reason,
		Proof: &DataIntegrityProof{
			Type:               DataIntegrityProofType(signer.SuiteType()),
			Created:            now.UTC().Truncate(time.Second),
			VerificationMethod: signer.VerificationMethod(),
			ProofPurpose:       DataIntegrityProofProofPurposeAssertionMethod,
		},
	}

	docMap, err := responseToMap(resp)
	if err != nil {
		return nil, fmt.Errorf("BuildAuthorizationResponse: %w", err)
	}
	digest, err := combinedHashFromMap(docMap, suiteCtx)
	if err != nil {
		return nil, fmt.Errorf("BuildAuthorizationResponse: %w", err)
	}
	sig, err := signer.Sign(digest)
	if err != nil {
		return nil, fmt.Errorf("BuildAuthorizationResponse: sign failed: %w", err)
	}

	switch signer.SuiteType() {
	case string(DataIntegrityProofTypeEcdsaSecp256K1RecoverySignature2020):
		resp.Proof.Jws = &sig
	case string(DataIntegrityProofTypeEd25519Signature2020):
		resp.Proof.ProofValue = &sig
	}
	return resp, nil
}

// responseToMap is the typed-to-untyped bridge used by both the sign and
// verify sides. Marshaling through JSON normalizes time.Time to its RFC
// 3339 string form; unmarshaling into map[string]any then gives us a doc
// shape lddataintegrity.Canonicalize can ingest. Doing the round-trip once at
// the boundary means the rest of the algorithm operates on the same byte
// representation the verifier will see on the wire.
func responseToMap(resp *SchemaJson) (map[string]any, error) {
	raw, err := json.Marshal(resp)
	if err != nil {
		return nil, fmt.Errorf("marshal response: %w", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("unmarshal response into map: %w", err)
	}
	return m, nil
}

// combinedHashFromMap implements step 3 of the Data Integrity hash
// composition. It operates on a raw map (not the typed *SchemaJson) so
// the verify side can read proof.created as a string verbatim from the
// wire — round-tripping through time.Time on the verify side would
// silently change the canonical bytes (SI-6).
//
// The proof object's signature fields (jws / proofValue) are stripped
// before canonicalization on both sides.
func combinedHashFromMap(docMap map[string]any, suiteCtxURL string) ([]byte, error) {
	proofRaw, ok := docMap["proof"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("combinedHash: doc.proof missing or not an object")
	}
	createdStr, ok := proofRaw["created"].(string)
	if !ok || createdStr == "" {
		return nil, fmt.Errorf("combinedHash: proof.created missing or not a string")
	}
	proofType, ok := proofRaw["type"].(string)
	if !ok || proofType == "" {
		return nil, fmt.Errorf("combinedHash: proof.type missing or not a string")
	}
	verificationMethod, ok := proofRaw["verificationMethod"].(string)
	if !ok || verificationMethod == "" {
		return nil, fmt.Errorf("combinedHash: proof.verificationMethod missing or not a string")
	}
	proofPurpose, ok := proofRaw["proofPurpose"].(string)
	if !ok || proofPurpose == "" {
		return nil, fmt.Errorf("combinedHash: proof.proofPurpose missing or not a string")
	}

	docForCanon := shallowCopyMap(docMap)
	proofForCanon := shallowCopyMap(proofRaw)
	delete(proofForCanon, "jws")
	delete(proofForCanon, "proofValue")
	docForCanon["proof"] = proofForCanon

	docNQ, err := lddataintegrity.Canonicalize(docForCanon, docLoader)
	if err != nil {
		return nil, fmt.Errorf("canonicalize doc: %w", err)
	}

	optsMap := map[string]any{
		"@context":           []any{suiteCtxURL},
		"type":               proofType,
		"created":            createdStr,
		"verificationMethod": verificationMethod,
		"proofPurpose":       proofPurpose,
	}
	optsNQ, err := lddataintegrity.Canonicalize(optsMap, docLoader)
	if err != nil {
		return nil, fmt.Errorf("canonicalize proof options: %w", err)
	}

	return crypto.Keccak256(
		crypto.Keccak256([]byte(optsNQ)),
		crypto.Keccak256([]byte(docNQ)),
	), nil
}

// shallowCopyMap returns a one-level copy of m. Sufficient for our use:
// canonicalize only inspects nested values it doesn't mutate, so the
// nested objects can stay shared.
func shallowCopyMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	maps.Copy(out, m)
	return out
}
