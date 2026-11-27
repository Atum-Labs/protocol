package pgclient

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	signing "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/PaymentRequest/v1/bindings/go/signing"
	lddataintegrity "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/common/ld-data-integrity/go"
)

// assertionMethod is the only proofPurpose the inner PaymentRequest proof may carry. The
// signer validates it and rejects anything else, so DeclarationOptions does not expose the
// field: asking a caller to supply a value that has exactly one legal setting is ceremony,
// not configuration. A test pins this string against that validation, so a change upstream
// surfaces as a failure here rather than as a rejected proof in production.
const assertionMethod = "assertionMethod"

// didPKHPrefix builds the did:pkh identifier for a wallet account, per CAIP-10 wrapped as
// a W3C DID: did:pkh:<caip2>:<account>.
//
// Built here rather than imported because this package has no shared DID helper for the
// construct direction; the existing did:pkh helpers elsewhere in this repo parse rather than
// build, and keep their prefix unexported.
const didPKHPrefix = "did:pkh:"

// blockchainAccountIDFragment is the verificationMethod fragment for a did:pkh wallet key.
// The verifier recovers the signer from the signature and binds it back to the account in
// the DID, so this fragment names which key of the DID document signed.
const blockchainAccountIDFragment = "#blockchainAccountId"

// DeclarationOptions configures the inner PaymentRequest proof.
type DeclarationOptions struct {
	// VerificationMethod identifies the signing key as a DID URL. For a wallet key this is
	// DIDForAccount(chainID, account) + "#blockchainAccountId"; see
	// VerificationMethodForAccount, which builds it in one call.
	VerificationMethod string

	// Created anchors proof.created. DEFAULTS TO NOW when left zero, matching the
	// TypeScript signDeclaration, so a caller that omits it gets a usable proof rather than
	// one dated year 1 -- that proof is cryptographically valid and fails only later, at the
	// gateway's freshness window, with an error that never mentions created.
	//
	// Set it to pin an instant: the value is inside the signed payload, so two signatures
	// over the same request differ unless it is fixed.
	Created time.Time
}

// DIDForAccount returns the did:pkh identifier for a wallet account on a CAIP-2 chain, e.g.
// DIDForAccount("eip155:1", "0xabc…") -> "did:pkh:eip155:1:0xabc…".
func DIDForAccount(chainID, account string) string {
	return didPKHPrefix + chainID + ":" + account
}

// VerificationMethodForAccount returns the DID URL naming a wallet account's signing key,
// ready to use as DeclarationOptions.VerificationMethod.
func VerificationMethodForAccount(chainID, account string) string {
	return DIDForAccount(chainID, account) + blockchainAccountIDFragment
}

// SignDeclaration attaches the inner W3C Data Integrity proof to a PaymentRequest, attesting
// that the document came from the signer. It returns the signed document as JSON.
//
// This is the DOCUMENT signature, not the transfer authorization: see SignSenderAuth for the
// latter. A caller generally needs both.
//
// The signer canonicalizes with URDNA2015 and hashes the result, so the proof covers the
// document's meaning rather than its byte layout — reordering keys does not change it.
// Signing artifacts and deprecated credential carriers (proof, originator_auth,
// sender_auth.verifiable_credential) are excluded from that hash by the signing module, and
// the verifier strips the identical set.
//
// Note what a typed request cannot carry: marshalling a *PaymentRequest emits only fields the
// generated bindings know. If the request arrived as JSON containing a field these bindings
// predate, that field is silently dropped from the document. Sign bytes you received with
// SignDeclarationJSON, which keeps them — but see the caveat there: keeping a field is not the
// same as signing it.
func SignDeclaration(req *PaymentRequest, signer lddataintegrity.Secp256k1Signer, opts DeclarationOptions) ([]byte, error) {
	if req == nil {
		return nil, errors.New("pgclient: req must not be nil")
	}
	raw, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("pgclient: marshalling the request to sign: %w", err)
	}
	return SignDeclarationJSON(raw, signer, opts)
}

// SignDeclarationJSON is SignDeclaration over raw JSON, for a caller holding a request it did
// not construct. Every field present in doc is carried into the signed document, including
// fields the generated bindings do not model.
//
// Carried is not the same as covered. The proof is computed over the URDNA2015-canonicalized
// document, and canonicalization DROPS terms the @context does not define — so an unmodelled
// field travels inside the signed document without being protected by the signature, and can
// be altered without invalidating the proof. Making a new field tamper-evident means adding it
// to the declaration context, not just to the payload. A test in this package pins that
// behaviour.
//
// Any @context or proof already on doc is replaced, so re-signing produces a fresh proof
// rather than nesting one envelope inside another.
func SignDeclarationJSON(doc []byte, signer lddataintegrity.Secp256k1Signer, opts DeclarationOptions) ([]byte, error) {
	if signer == nil {
		return nil, errors.New("pgclient: signer must not be nil")
	}
	var payload map[string]any
	if err := json.Unmarshal(doc, &payload); err != nil {
		return nil, fmt.Errorf("pgclient: the document to sign is not a JSON object: %w", err)
	}
	// A zero Created would be formatted verbatim as "0001-01-01T00:00:00.000Z". Nothing local
	// rejects that -- the proof signs and verifies -- so it surfaces only when a gateway
	// applies its freshness window. Default it here, where the omission is visible.
	created := opts.Created
	if created.IsZero() {
		created = time.Now().UTC()
	}
	return signing.SignPaymentRequestWithSigner(payload, signer, signing.SignOptions{
		VerificationMethod: opts.VerificationMethod,
		ProofPurpose:       assertionMethod,
		Created:            created,
	})
}
