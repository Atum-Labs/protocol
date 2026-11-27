package ldverification

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	fq "github.com/atum-labs/protocol/schemas/declarations/FulfillmentQuote/v1/bindings/go/generated"
	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/mr-tron/base58"
)

// Supported proof types. The verifier dispatches on proof.type and runs
// the matching cryptosuite path; anything else is rejected with
// "unsupported proof type" so a misconfigured signer fails closed
// instead of silently bypassing verification.
const (
	ProofTypeSecp256k1Recovery2020 = "EcdsaSecp256k1RecoverySignature2020"
	ProofTypeEd25519Signature2020  = "Ed25519Signature2020"
)

// expectedProofPurpose is the only purpose the verifier accepts. W3C
// Data Integrity 1.0 §4.2 requires verifiers to validate that
// proof.proofPurpose matches the verifier's expected purpose; without
// the check a key intended for e.g. encryption (keyAgreement) could be
// used to sign assertions and the by-purpose authorization model is
// silently bypassed. FulfillmentQuotes are assertions about settlement
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
// quote was issued for: the namespace and the network reference must both equal the
// chain's (`solana:devnet`, `stellar:pubnet`). Without the namespace half, a quote
// signed as did:pkh:stellar:devnet:G... would pass a Solana devnet check on the
// reference alone. The compare is case-insensitive on both parts, as for the DID.
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
// chain-canonical identity (0x-hex for EVM, Tron base58check, Solana base58
// pubkey) before running whitelist or settler_requirements checks.
type Result struct {
	// Signer is the sealed identity the proof verified against.
	Signer Signer
	// Created is the proof.created timestamp; callers should reject
	// proofs older than their freshness tolerance.
	Created time.Time
	// QuoteHash is the content-addressed quote_hash ("0x"+hex(keccak256(
	// SigningInput))) — identical to ComputeQuoteHash's output, but computed
	// here for free from the SigningInput the recovery already produced (no
	// second canonicalization). Callers binding the FQE holder-VP
	// challenge to quote_hash (the bid perimeter) read this instead of
	// re-parsing + re-canonicalizing the quote per bid.
	QuoteHash string
}

// Verify cryptographically verifies a signed FulfillmentQuote and
// returns a Result describing the recovered signer plus proof.created.
// Dispatches on proof.type:
//   - EcdsaSecp256k1RecoverySignature2020: detached JWS, keccak256,
//     secp256k1 recovery (EVM + Tron — same primitive, chain-canonical
//     address derivation is the caller's responsibility).
//   - Ed25519Signature2020: multibase-encoded proofValue (z-base58btc),
//     SHA-256 hashes, ed25519 verification against the pubkey embedded
//     in the verificationMethod DID (Solana).
//
// Any freshness, whitelist, or per-request authorization checks remain
// the caller's responsibility.
func Verify(signedQuoteJSON []byte) (Result, error) {
	var quote fq.SchemaJson
	if err := json.Unmarshal(signedQuoteJSON, &quote); err != nil {
		return Result{}, fmt.Errorf("failed to parse FulfillmentQuote: %w", errors.Join(ErrMalformedQuote, err))
	}
	if quote.Proof == nil {
		return Result{}, ErrMissingProof
	}

	// Validate proofPurpose BEFORE cryptosuite dispatch so every chain
	// corridor (eip155 / tron / solana, and any future did:pkh:NETWORK
	// or new cryptosuite added below) inherits the rejection. Doing it
	// here also fails fast — the check runs before canonicalization +
	// signature recovery, the most expensive work in this function.
	if quote.Proof.ProofPurpose != expectedProofPurpose {
		return Result{}, fmt.Errorf("unsupported proofPurpose %q: only %q is accepted: %w",
			quote.Proof.ProofPurpose, expectedProofPurpose, ErrUnsupportedProofType)
	}

	switch quote.Proof.Type {
	case ProofTypeSecp256k1Recovery2020:
		return verifySecp256k1(signedQuoteJSON, &quote)
	case ProofTypeEd25519Signature2020:
		return verifyEd25519(signedQuoteJSON, &quote)
	default:
		return Result{}, fmt.Errorf("unsupported proof type: %s: %w", quote.Proof.Type, ErrUnsupportedProofType)
	}
}

func verifySecp256k1(signedQuoteJSON []byte, quote *fq.SchemaJson) (Result, error) {
	if quote.Proof.Jws == nil || *quote.Proof.Jws == "" {
		return Result{}, fmt.Errorf("proof.jws is required for EcdsaSecp256k1RecoverySignature2020: %w", ErrMissingSignatureMaterial)
	}

	_, signature, err := ParseDetachedJWS(*quote.Proof.Jws)
	if err != nil {
		return Result{}, err
	}

	hash, err := canonicalSigningInput(signedQuoteJSON, quote, ProofTypeSecp256k1Recovery2020)
	if err != nil {
		return Result{}, err
	}

	// The caller still compares the signer; the verificationMethod only picks which digest recovered it.
	addr, err := recoverProofSigner(hash, signature, func(a common.Address) bool {
		return signerMatchesHolderSecp256k1(a, quote.Proof.VerificationMethod) == nil
	})
	if err != nil {
		return Result{}, err
	}

	return Result{
		Signer:    RecoveredSecp256k1Signer{Address: addr},
		Created:   quote.Proof.Created,
		QuoteHash: "0x" + common.Bytes2Hex(crypto.Keccak256(hash.SigningInput)),
	}, nil
}

func verifyEd25519(signedQuoteJSON []byte, quote *fq.SchemaJson) (Result, error) {
	if quote.Proof.ProofValue == nil || *quote.Proof.ProofValue == "" {
		return Result{}, fmt.Errorf("proof.proofValue is required for Ed25519Signature2020: %w", ErrMissingSignatureMaterial)
	}

	signature, err := lddataintegrity.DecodeEd25519ProofValue(*quote.Proof.ProofValue)
	if err != nil {
		// Translate lib's ErrMalformedProof to FQ's
		// ErrMalformedSignatureMaterial so callers using
		// errors.Is(err, ldverification.ErrMalformedSignatureMaterial)
		// stay behavior-equivalent. The lib message (prefix mismatch /
		// base58 decode failure / wrong-length) is preserved in the
		// chain via %v.
		return Result{}, fmt.Errorf("failed to decode proof.proofValue: %w: %v", ErrMalformedSignatureMaterial, err)
	}

	pubKey, didNamespace, didNetwork, err := publicKeyFromVerificationMethod(quote.Proof.VerificationMethod)
	if err != nil {
		return Result{}, fmt.Errorf("failed to resolve verificationMethod: %w", errors.Join(ErrMalformedQuote, err))
	}

	hash, err := canonicalSigningInput(signedQuoteJSON, quote, ProofTypeEd25519Signature2020)
	if err != nil {
		return Result{}, err
	}

	// The proof signs the raw SigningInput or its Ed25519ProofMessage text.
	if err := lddataintegrity.VerifyEd25519Proof(pubKey, hash.SigningInput, signature); err != nil {
		return Result{}, errors.New("ed25519 signature verification failed")
	}

	return Result{
		Signer:    SelfAssertedEd25519Signer{PublicKey: pubKey, DIDNamespace: didNamespace, DIDNetwork: didNetwork},
		Created:   quote.Proof.Created,
		QuoteHash: "0x" + common.Bytes2Hex(crypto.Keccak256(hash.SigningInput)),
	}, nil
}

// canonicalSigningInput reconstructs the exact bytes the signer committed
// to for a signed quote: it strips the proof, reads created/@context
// verbatim from the wire, and calls HashQuote with the matching cryptosuite.
//
// It is the single source of the signing input shared by Verify (which
// recovers the signer from it) and ComputeQuoteHash (which content-addresses
// it). Routing both through here is what makes the content-addressed
// quote_hash parity-correct by construction: it can never disagree with the
// bytes the verifier — and therefore the signer — actually committed to.
//
// The caller supplies the cryptosuite (already dispatched on proof.type) so
// callers with extra per-suite work (signature-material checks, proofPurpose
// validation) keep that logic at their own layer rather than here.
func canonicalSigningInput(signedQuoteJSON []byte, quote *fq.SchemaJson, cryptosuite string) (HashResult, error) {
	doc, rawProof, err := documentForCanonicalization(signedQuoteJSON)
	if err != nil {
		return HashResult{}, err
	}

	return HashQuote(doc, HashQuoteOptions{
		Cryptosuite: cryptosuite,
		ProofOptions: HashableProofOptions{
			Type:               quote.Proof.Type,
			Created:            rawString(rawProof, "created"),
			VerificationMethod: quote.Proof.VerificationMethod,
			ProofPurpose:       quote.Proof.ProofPurpose,
			// Pass the wire @context verbatim. A signer that emits a
			// non-canonical-but-equivalent shape (string vs single-
			// element array, etc.) MUST canonicalize to the same n-quads
			// on the verifier side, and the only safe way to guarantee
			// that is to feed the same @context bytes into URDNA2015.
			// HashQuote falls back to the canonical IRI when this is nil,
			// which is the right behavior if the wire dropped @context
			// (recovery then fails for a real reason rather than a
			// verifier/signer wire-shape disagreement).
			Context: rawProof["@context"],
		},
	})
}

// documentForCanonicalization re-parses the raw JSON as a generic map
// so callers can (1) strip the proof block before canonicalizing the
// document, and (2) read proof fields verbatim.
//
// Field-read policy when reconstructing proofOptions for canonicalization:
// fields whose typed→string round trip is lossy (notably `created`, where
// time.Time discards the signer's choice between `Z` and `+00:00`) MUST be
// read from rawProof to keep canonical bytes byte-identical with the signer;
// fields whose typed value is already the wire form (string fields like
// `verificationMethod`, `proofPurpose`, `type`) can come from the typed
// struct safely. Both verifySecp256k1 and verifyEd25519 follow this rule.
func documentForCanonicalization(signedQuoteJSON []byte) (doc map[string]any, rawProof map[string]any, err error) {
	if err := json.Unmarshal(signedQuoteJSON, &doc); err != nil {
		return nil, nil, fmt.Errorf("failed to parse document as map: %w", errors.Join(ErrMalformedQuote, err))
	}
	rawProof, _ = doc["proof"].(map[string]any)
	delete(doc, "proof")
	return doc, rawProof, nil
}

// publicKeyFromVerificationMethod extracts the 32-byte ed25519 public
// key AND the parsed namespace and network segments from a
// `did:pkh:solana:NETWORK:base58pubkey#fragment` or
// `did:pkh:stellar:NETWORK:G...#fragment` DID. The caller is
// expected to compare the returned namespace and network against the
// CAIP-2 chain of the source asset (SelfAssertedEd25519Signer.MatchesChain)
// and reject mismatches — without that binding, `did:pkh:solana:devnet:PK`
// verifies against a mainnet source as long as the pubkey is whitelisted,
// and a `did:pkh:stellar:devnet:G...` quote satisfies a Solana devnet
// check, masking misconfiguration and polluting audit trails.
//
// Why did:pkh and not did:key: Solana and Stellar wallets ARE their
// public key, so the on-chain identity (what the whitelist already keys
// on) and the signing key are the same value. did:key would force a
// separate multicodec parse for no functional gain. Add a did:key branch
// only when a producer that doesn't already have a wallet identity needs
// to sign — none today.
//
// Per W3C the DID scheme + method are case-insensitive, so we lowercase
// only the prefix portion before the address. The address payload is
// preserved verbatim — Solana base58 IS case-sensitive and a single
// case fold there would change which wallet we authorize. A Stellar
// strkey is uppercase base32 and refuses any other spelling.
//
// Adding another ed25519 chain (Aptos / Sui / NEAR — all use ed25519)
// requires lockstep edits in TWO places: a new namespace branch here AND
// a new `is<Chain>` arm in the downstream verifier's chain switch. No
// compile-time signal links the two; if you touch one, search the other.
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
		return nil, "", "", fmt.Errorf("expected did:pkh:solana:... or did:pkh:stellar:... verification method, got %q: %w", method, ErrMalformedQuote)
	}
	rest := method[len(prefix):]
	// `rest` is `NETWORK:address`. Split on the LAST colon so a
	// network reference containing colons (none today, but the CAIP-2
	// reference allows generality) can't fool the parse.
	idx := strings.LastIndex(rest, ":")
	if idx < 0 {
		return nil, "", "", fmt.Errorf("missing address segment in verificationMethod %q: %w", method, ErrMalformedQuote)
	}
	if idx == 0 {
		return nil, "", "", fmt.Errorf("empty network segment in verificationMethod %q: %w", method, ErrMalformedQuote)
	}
	network := rest[:idx]
	addr := rest[idx+1:]
	if addr == "" {
		return nil, "", "", fmt.Errorf("empty address segment in verificationMethod %q: %w", method, ErrMalformedQuote)
	}
	if prefix == stellarPrefix {
		pub, err := decodeStellarAccount(addr)
		if err != nil {
			return nil, "", "", fmt.Errorf("failed to decode stellar account from verificationMethod: %w", errors.Join(ErrMalformedQuote, err))
		}
		if len(pub) != ed25519.PublicKeySize {
			return nil, "", "", fmt.Errorf("decoded pubkey is %d bytes, want %d: %w", len(pub), ed25519.PublicKeySize, ErrMalformedQuote)
		}
		return pub, "stellar", network, nil
	}
	pub, err := base58.Decode(addr)
	if err != nil {
		return nil, "", "", fmt.Errorf("failed to base58-decode pubkey from verificationMethod: %w", errors.Join(ErrMalformedQuote, err))
	}
	if len(pub) != ed25519.PublicKeySize {
		return nil, "", "", fmt.Errorf("decoded pubkey is %d bytes, want %d: %w", len(pub), ed25519.PublicKeySize, ErrMalformedQuote)
	}
	return ed25519.PublicKey(pub), "solana", network, nil
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
// 20-byte EVM-form address). Prefer Verify in library callers.
func RecoverSigner(signedQuoteJSON []byte) (string, error) {
	res, err := Verify(signedQuoteJSON)
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
