package ldverification

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	paymentrequest "github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go/generated"
	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"

	"github.com/ethereum/go-ethereum/common"
	"github.com/mr-tron/base58"
)

// Supported proof types. VerifyPaymentRequest dispatches on proof.type
// and runs the matching cryptosuite path; anything else is rejected with
// "unsupported proof type" so a misconfigured signer fails closed instead
// of silently bypassing verification.
const (
	ProofTypeSecp256k1Recovery2020 = "EcdsaSecp256k1RecoverySignature2020"
	ProofTypeEd25519Signature2020  = "Ed25519Signature2020"
)

// expectedProofPurpose is the only purpose the verifier accepts. W3C
// Data Integrity 1.0 §4.2 requires verifiers to validate that
// proof.proofPurpose matches the verifier's expected purpose; without
// the check a key intended for e.g. encryption (keyAgreement) could be
// used to sign assertions and the by-purpose authorization model is
// silently bypassed. A PaymentRequest is an assertion about a payment's
// terms, so assertionMethod is the only legitimate value here.
const expectedProofPurpose = "assertionMethod"

// Signer is the sealed identity a verified proof yields. It is one of
// RecoveredSecp256k1Signer or SelfAssertedEd25519Signer. Callers must
// type-switch, so a self-asserted ed25519 key can never be read as a
// recovered signer address.
type Signer interface{ isSigner() }

// RecoveredSecp256k1Signer is the address recovered from the signature,
// self-evident proof of the signing key.
type RecoveredSecp256k1Signer struct{ Address common.Address }

// SelfAssertedEd25519Signer is the public key taken from the caller-supplied
// verificationMethod. A successful verify proves the signature matches this
// key, not that the key belongs to any authorized party. The caller must
// bind PublicKey, DIDNamespace and DIDNetwork to a trusted source before
// relying on it; MatchesChain does that binding for a CAIP-2 source chain.
type SelfAssertedEd25519Signer struct {
	PublicKey ed25519.PublicKey
	// DIDNamespace is the did:pkh namespace the key was named under, lower-case:
	// "solana" or "stellar". A network reference such as "testnet" is not unique to
	// one namespace, so DIDNetwork alone cannot tell a Stellar DID from a Solana one.
	DIDNamespace string
	// DIDNetwork is the reference segment after the namespace ("devnet", "pubnet").
	DIDNetwork string
}

// MatchesChain reports whether the verificationMethod names the CAIP-2 chain the
// request was issued for: the namespace and the network reference must both equal
// the chain's (`solana:devnet`, `stellar:pubnet`). The compare is case-insensitive
// on both parts, as for the DID. Mirror of the FulfillmentQuote method.
func (s SelfAssertedEd25519Signer) MatchesChain(caip2 string) error {
	namespace, reference, ok := strings.Cut(caip2, ":")
	if !ok || namespace == "" || reference == "" {
		return fmt.Errorf("source chain %q is not a CAIP-2 identifier: %w", caip2, ErrSignerChainMismatch)
	}
	if !strings.EqualFold(s.DIDNamespace, namespace) {
		return fmt.Errorf("verificationMethod namespace %q does not match source chain %q: %w", s.DIDNamespace, caip2, ErrSignerChainMismatch)
	}
	if !strings.EqualFold(s.DIDNetwork, reference) {
		return fmt.Errorf("verificationMethod network %q does not match source chain %q: %w", s.DIDNetwork, caip2, ErrSignerChainMismatch)
	}
	return nil
}

func (RecoveredSecp256k1Signer) isSigner()  {}
func (SelfAssertedEd25519Signer) isSigner() {}

// Result is the outcome of a successful proof verification. Callers
// type-switch on Signer to read the recovered identity, then map it into a
// chain-canonical identity (0x-hex for EVM, Solana base58 pubkey) before
// running whitelist or authorization checks.
//
// Mirror of the FulfillmentQuote Result so a service that already maps
// the FQ verifier's output can reuse the same handling for PaymentRequest.
type Result struct {
	// Signer is the sealed identity the proof verified against.
	Signer Signer
	// Created is the proof.created timestamp; callers should reject
	// proofs older than their freshness tolerance.
	Created time.Time
}

// VerifyPaymentRequest cryptographically verifies a signed
// PaymentRequest and returns a Result describing the recovered signer
// plus proof.created. Dispatches on proof.type:
//   - EcdsaSecp256k1RecoverySignature2020: detached JWS, keccak256,
//     secp256k1 recovery (EVM — chain-canonical address derivation is
//     the caller's responsibility).
//   - Ed25519Signature2020: multibase-encoded proofValue (z-base58btc),
//     SHA-256 hashes, ed25519 verification against the pubkey embedded
//     in the verificationMethod DID (Solana).
//
// Any freshness, whitelist, or per-request authorization checks remain
// the caller's responsibility.
//
// Mirror of the FulfillmentQuote Verify (the inner-document path).
func VerifyPaymentRequest(signedJSON []byte) (Result, error) {
	return VerifyPaymentRequestWithOptions(signedJSON, VerifyOptions{})
}

// VerifyOptions widens what VerifyPaymentRequestWithOptions accepts. The zero value is
// VerifyPaymentRequest.
type VerifyOptions struct {
	// AcceptPaymentRequestTypedProof also accepts a secp256k1 proof in the typed form a payer's
	// wallet signs: a signature over the EIP-712 digest of PaymentRequestProof{proofHash, docHash}
	// (lddataintegrity.PaymentRequestProofTypedDigest), taken only when it recovers the signer the
	// proof's verificationMethod names. Off, a typed proof recovers an address other than the
	// signer, with no error, so the caller's signer check is what refuses it.
	//
	// Off by default because a wallet shows that typed data as two opaque hashes: a page that
	// asks for it obtains a valid originator proof over whatever document it hashed, so only a
	// verifier of an originator's own payment request should accept it (the gateway's check of
	// the request it is sent, and the services that re-verify that same request), and the
	// published SDKs accept it only where their caller asks.
	AcceptPaymentRequestTypedProof bool
}

// VerifyPaymentRequestWithOptions is VerifyPaymentRequest with the forms opts accepts.
func VerifyPaymentRequestWithOptions(signedJSON []byte, opts VerifyOptions) (Result, error) {
	var req paymentrequest.SchemaJson
	if err := json.Unmarshal(signedJSON, &req); err != nil {
		return Result{}, fmt.Errorf("failed to parse PaymentRequest: %w", errors.Join(ErrMalformedRequest, err))
	}
	if req.Proof == nil {
		return Result{}, ErrMissingProof
	}

	// Validate proofPurpose BEFORE cryptosuite dispatch so every chain
	// corridor (eip155 / solana, and any future did:pkh:NETWORK or new
	// cryptosuite added below) inherits the rejection. Doing it here also
	// fails fast — the check runs before canonicalization + signature
	// recovery, the most expensive work in this function.
	if req.Proof.ProofPurpose != expectedProofPurpose {
		return Result{}, fmt.Errorf("unsupported proofPurpose %q: only %q is accepted: %w",
			req.Proof.ProofPurpose, expectedProofPurpose, ErrUnsupportedProofType)
	}

	switch req.Proof.Type {
	case ProofTypeSecp256k1Recovery2020:
		return verifySecp256k1(signedJSON, &req, opts)
	case ProofTypeEd25519Signature2020:
		return verifyEd25519(signedJSON, &req)
	default:
		return Result{}, fmt.Errorf("unsupported proof type: %s: %w", req.Proof.Type, ErrUnsupportedProofType)
	}
}

func verifySecp256k1(signedJSON []byte, req *paymentrequest.SchemaJson, opts VerifyOptions) (Result, error) {
	if req.Proof.Jws == nil || *req.Proof.Jws == "" {
		return Result{}, fmt.Errorf("proof.jws is required for EcdsaSecp256k1RecoverySignature2020: %w", ErrMissingSignatureMaterial)
	}

	_, signature, err := ParseDetachedJWS(*req.Proof.Jws)
	if err != nil {
		return Result{}, err
	}

	hash, err := canonicalSigningInput(signedJSON, req, ProofTypeSecp256k1Recovery2020)
	if err != nil {
		return Result{}, err
	}

	// The raw form or, where the caller accepts it, the PaymentRequestProof typed form a wallet
	// signs: the same two hashes, so the same binding. The typed form is taken only when it recovers
	// the signer the proof names in its verificationMethod; otherwise the raw signer is returned as
	// it always was.
	var typed []lddataintegrity.TypedProofDigest
	if opts.AcceptPaymentRequestTypedProof {
		typed = append(typed, lddataintegrity.PaymentRequestProofTypedDigest)
	}
	addr, err := lddataintegrity.RecoverSecp256k1ProofSignerFrom(hash, signature, func(a common.Address) bool {
		return verificationMethodNamesSecp256k1Signer(req.Proof.VerificationMethod, a)
	}, typed...)
	if err != nil {
		return Result{}, err
	}

	return Result{
		Signer:  RecoveredSecp256k1Signer{Address: addr},
		Created: req.Proof.Created,
	}, nil
}

func verifyEd25519(signedJSON []byte, req *paymentrequest.SchemaJson) (Result, error) {
	if req.Proof.ProofValue == nil || *req.Proof.ProofValue == "" {
		return Result{}, fmt.Errorf("proof.proofValue is required for Ed25519Signature2020: %w", ErrMissingSignatureMaterial)
	}

	signature, err := lddataintegrity.DecodeEd25519ProofValue(*req.Proof.ProofValue)
	if err != nil {
		// Translate lib's ErrMalformedProof to PR's
		// ErrMalformedSignatureMaterial so callers using
		// errors.Is(err, ldverification.ErrMalformedSignatureMaterial)
		// stay behavior-equivalent with the FQ taxonomy. The lib message
		// (prefix mismatch / base58 decode failure / wrong-length) is
		// preserved in the chain via %v.
		return Result{}, fmt.Errorf("failed to decode proof.proofValue: %w: %v", ErrMalformedSignatureMaterial, err)
	}

	pubKey, didNamespace, didNetwork, err := publicKeyFromVerificationMethod(req.Proof.VerificationMethod)
	if err != nil {
		return Result{}, fmt.Errorf("failed to resolve verificationMethod: %w", errors.Join(ErrMalformedRequest, err))
	}

	hash, err := canonicalSigningInput(signedJSON, req, ProofTypeEd25519Signature2020)
	if err != nil {
		return Result{}, err
	}

	if err := lddataintegrity.VerifyEd25519(pubKey, hash.SigningInput, signature); err != nil {
		return Result{}, errors.New("ed25519 signature verification failed")
	}

	return Result{
		Signer:  SelfAssertedEd25519Signer{PublicKey: pubKey, DIDNamespace: didNamespace, DIDNetwork: didNetwork},
		Created: req.Proof.Created,
	}, nil
}

// canonicalSigningInput reconstructs the exact bytes the signer committed
// to for a signed PaymentRequest: it strips the proof, reads
// created/@context verbatim from the wire, and calls HashPaymentRequest
// with the matching cryptosuite.
//
// The caller supplies the cryptosuite (already dispatched on proof.type)
// so callers with extra per-suite work (signature-material checks,
// proofPurpose validation) keep that logic at their own layer rather than
// here.
func canonicalSigningInput(signedJSON []byte, req *paymentrequest.SchemaJson, cryptosuite string) (HashResult, error) {
	doc, rawProof, err := documentForCanonicalization(signedJSON)
	if err != nil {
		return HashResult{}, err
	}

	return HashPaymentRequest(doc, HashPaymentRequestOptions{
		Cryptosuite: cryptosuite,
		ProofOptions: HashableProofOptions{
			Type:               req.Proof.Type,
			Created:            rawString(rawProof, "created"),
			VerificationMethod: req.Proof.VerificationMethod,
			ProofPurpose:       req.Proof.ProofPurpose,
			// Pass the wire @context verbatim. A signer that emits a
			// non-canonical-but-equivalent shape (string vs single-
			// element array, etc.) MUST canonicalize to the same n-quads
			// on the verifier side, and the only safe way to guarantee
			// that is to feed the same @context bytes into URDNA2015.
			// HashPaymentRequest falls back to the canonical IRI when this
			// is nil, which is the right behavior if the wire dropped
			// @context (recovery then fails for a real reason rather than
			// a verifier/signer wire-shape disagreement).
			Context: rawProof["@context"],
		},
	})
}

// documentForCanonicalization re-parses the raw JSON as a generic map
// so callers can (1) strip the proof block before canonicalizing the
// document, and (2) read proof fields verbatim.
//
// It strips the SAME set the signer's stripDocForHash strips —
// proof + verifiableCredential + presentation — so the verify-side
// canonical n-quads are byte-identical to what the signer hashed.
// verifiableCredential is also stripped by HashDocument
// (StripVerifiableCredential), but mirroring it here keeps the two prep
// functions symmetric instead of relying on a downstream option. presentation
// (the spliced PaymentRequestEnvelope, a bound @type:@id term) is NOT
// stripped by HashDocument, so it MUST be removed here — otherwise the
// envelope spliced in after signing would canonicalize into the signing input
// and recovery would return the wrong signer.
//
// Field-read policy when reconstructing proofOptions for canonicalization:
// fields whose typed→string round trip is lossy (notably `created`, where
// time.Time discards the signer's choice between `Z` and `+00:00`) MUST be
// read from rawProof to keep canonical bytes byte-identical with the
// signer; fields whose typed value is already the wire form (string
// fields like `verificationMethod`, `proofPurpose`, `type`) can come from
// the typed struct safely. Both verifySecp256k1 and verifyEd25519 follow
// this rule.
func documentForCanonicalization(signedJSON []byte) (doc map[string]any, rawProof map[string]any, err error) {
	if err := json.Unmarshal(signedJSON, &doc); err != nil {
		return nil, nil, fmt.Errorf("failed to parse document as map: %w", errors.Join(ErrMalformedRequest, err))
	}
	rawProof, _ = doc["proof"].(map[string]any)
	delete(doc, "proof")
	// Strip the SAME credential carriers as the signer's
	// stripDocForHash — verifiableCredential, presentation, originator_auth,
	// and the nested sender_auth.verifiable_credential — so the inner
	// PaymentRequest proof covers the payment, never a credential (which lives
	// only in the PRE), and producer↔verifier canonicalization stays symmetric.
	delete(doc, "verifiableCredential")
	delete(doc, "presentation")
	delete(doc, "originator_auth")
	if sa, ok := doc["sender_auth"]; ok {
		doc["sender_auth"] = stripNestedVerifiableCredential(sa)
	}
	return doc, rawProof, nil
}

// publicKeyFromVerificationMethod extracts the 32-byte ed25519 public
// key AND the parsed namespace and network segments from a
// `did:pkh:solana:NETWORK:base58pubkey#fragment` or
// `did:pkh:stellar:NETWORK:G...#fragment` DID. The caller is expected to
// compare the returned namespace and network against the CAIP-2 chain of
// the source asset (SelfAssertedEd25519Signer.MatchesChain) and reject
// mismatches — without that binding, `did:pkh:solana:devnet:PK` verifies
// against a mainnet source as long as the pubkey is whitelisted, and a
// `did:pkh:stellar:devnet:G...` request satisfies a Solana devnet check.
//
// Why did:pkh and not did:key: Solana and Stellar wallets ARE their
// public key, so the on-chain identity (what the whitelist already keys
// on) and the signing key are the same value.
//
// Per W3C the DID scheme + method are case-insensitive, so we lowercase
// only the prefix portion before the address. The address payload is
// preserved verbatim — Solana base58 IS case-sensitive and a single
// case fold there would change which wallet we authorize. A Stellar
// strkey is uppercase base32 and refuses any other spelling.
//
// Behavioral mirror of the FulfillmentQuote
// publicKeyFromVerificationMethod (verify.go), differing only in the
// module-specific error sentinel, so the two declarations' DID-parsing
// can never silently diverge.
func publicKeyFromVerificationMethod(method string) (ed25519.PublicKey, string, string, error) {
	// Strip the optional fragment (e.g. #blockchainAccountId).
	if i := strings.Index(method, "#"); i >= 0 {
		method = method[:i]
	}
	const (
		solanaPrefix  = "did:pkh:solana:"
		stellarPrefix = "did:pkh:stellar:"
	)
	// Bound the case-fold to the prefix length so the address payload
	// (which follows) keeps its original casing.
	var prefix string
	switch {
	case len(method) >= len(solanaPrefix) && strings.EqualFold(method[:len(solanaPrefix)], solanaPrefix):
		prefix = solanaPrefix
	case len(method) >= len(stellarPrefix) && strings.EqualFold(method[:len(stellarPrefix)], stellarPrefix):
		prefix = stellarPrefix
	default:
		return nil, "", "", fmt.Errorf("expected did:pkh:solana:... or did:pkh:stellar:... verification method, got %q: %w", method, ErrMalformedRequest)
	}
	rest := method[len(prefix):]
	// `rest` is `NETWORK:address`. Split on the LAST colon so a
	// network reference containing colons (none today, but the CAIP-2
	// reference allows generality) can't fool the parse.
	idx := strings.LastIndex(rest, ":")
	if idx < 0 {
		return nil, "", "", fmt.Errorf("missing address segment in verificationMethod %q: %w", method, ErrMalformedRequest)
	}
	if idx == 0 {
		return nil, "", "", fmt.Errorf("empty network segment in verificationMethod %q: %w", method, ErrMalformedRequest)
	}
	network := rest[:idx]
	addr := rest[idx+1:]
	if addr == "" {
		return nil, "", "", fmt.Errorf("empty address segment in verificationMethod %q: %w", method, ErrMalformedRequest)
	}
	if prefix == stellarPrefix {
		pub, err := decodeStellarAccount(addr)
		if err != nil {
			return nil, "", "", fmt.Errorf("failed to decode stellar account from verificationMethod: %w", errors.Join(ErrMalformedRequest, err))
		}
		if len(pub) != ed25519.PublicKeySize {
			return nil, "", "", fmt.Errorf("decoded pubkey is %d bytes, want %d: %w", len(pub), ed25519.PublicKeySize, ErrMalformedRequest)
		}
		return pub, "stellar", network, nil
	}
	pub, err := base58.Decode(addr)
	if err != nil {
		return nil, "", "", fmt.Errorf("failed to base58-decode pubkey from verificationMethod: %w", errors.Join(ErrMalformedRequest, err))
	}
	if len(pub) != ed25519.PublicKeySize {
		return nil, "", "", fmt.Errorf("decoded pubkey is %d bytes, want %d: %w", len(pub), ed25519.PublicKeySize, ErrMalformedRequest)
	}
	return ed25519.PublicKey(pub), "solana", network, nil
}

// verificationMethodNamesSecp256k1Signer reports whether a did:pkh verificationMethod names the
// account addr derives to: case-insensitive hex on eip155, the exact base58check spelling on tron.
// Any other method, or a malformed one, names no recovered signer.
func verificationMethodNamesSecp256k1Signer(method string, addr common.Address) bool {
	if i := strings.Index(method, "#"); i >= 0 {
		method = method[:i]
	}
	const prefix = "did:pkh:"
	if len(method) < len(prefix) || !strings.EqualFold(method[:len(prefix)], prefix) {
		return false
	}
	namespace, rest, ok := strings.Cut(method[len(prefix):], ":")
	if !ok {
		return false
	}
	idx := strings.LastIndex(rest, ":")
	if idx <= 0 || idx == len(rest)-1 {
		return false
	}
	account := rest[idx+1:]
	switch strings.ToLower(namespace) {
	case "eip155":
		return strings.EqualFold(account, addr.Hex())
	case "tron":
		return account == evmHashToTronBase58(addr)
	default:
		return false
	}
}

// rawString reads a string field from a map without reformatting. Returns
// "" if the field is absent or not a string — the caller has already
// validated the field via the typed struct, so absence here means a
// malformed JSON shape that the typed parse should have caught.
func rawString(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

// RecoverSigner is a CLI-friendly shim that returns the recovered EVM
// address as a 0x-prefixed lowercase hex string. Only meaningful for
// secp256k1 proofs; returns an error for ed25519 (where there's no
// 20-byte EVM-form address). Prefer VerifyPaymentRequest in library
// callers.
func RecoverSigner(signedJSON []byte) (string, error) {
	res, err := VerifyPaymentRequest(signedJSON)
	if err != nil {
		return "", err
	}
	sig, ok := res.Signer.(RecoveredSecp256k1Signer)
	if !ok {
		return "", fmt.Errorf("RecoverSigner only supports %s proofs (got %T)",
			ProofTypeSecp256k1Recovery2020, res.Signer)
	}
	return "0x" + common.Bytes2Hex(sig.Address.Bytes()), nil
}
