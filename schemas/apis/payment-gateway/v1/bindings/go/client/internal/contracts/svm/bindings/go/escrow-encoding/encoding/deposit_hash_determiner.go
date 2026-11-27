package svm_escrow_encoding

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	paymentrequest "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/PaymentRequest/v1/bindings/go/generated"
)

// SolanaDepositPrehash represents the JSON structure of the message_prehash
// field for Solana escrow deposits. This structure contains all parameters
// needed to compute the deposit_hash.
//
// Example JSON:
//
//	{
//	  "payment_id": "0x0102030405...",
//	  "depositor": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
//	  "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
//	  "amount": "1000000",
//	  "reserver": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
//	  "releaser": "So11111111111111111111111111111111111111112",
//	  "nonce": "12345",
//	  "issued_at": "1700000000",
//	  "deadline": "1700000128"
//	}
type SolanaDepositPrehash struct {
	// DepositRequestHash is a hex-encoded 32-byte value (with 0x prefix).
	//
	// The JSON key stays "payment_id" deliberately. This struct is the FROZEN v1..=v3 prehash wire
	// shape, and the wire shape is frozen for the same reason the hash layout is: producers already
	// emit this key and the gateway already reads it, so renaming it would break every unupgraded
	// producer/consumer pair for no change in what is signed. The Go field carries the accurate name;
	// SolanaDepositPrehashV2 uses "deposit_request_hash" for the v4 shape.
	// In the new architecture, this can be any value (e.g., keccak256(request_id)).
	DepositRequestHash string `json:"payment_id"`

	// Depositor is the Base58-encoded Solana public key of the user depositing funds.
	Depositor string `json:"depositor"`

	// Mint is the Base58-encoded Solana public key of the SPL token mint.
	Mint string `json:"mint"`

	// Amount is the number of tokens being deposited (uint64 as string).
	Amount string `json:"amount"`

	// Reserver is the Base58-encoded Solana public key authorized to reserve funds.
	Reserver string `json:"reserver"`

	// Releaser is the Base58-encoded Solana public key authorized to release/refund funds.
	Releaser string `json:"releaser"`

	// Nonce is a unique value for replay protection (uint64 as string).
	Nonce string `json:"nonce"`

	// IssuedAt is the Unix timestamp (seconds) when the authorization was created (uint64 as string).
	// This marks the start of the 128-second validity window (REPLAY_HORIZON_SECS).
	IssuedAt string `json:"issued_at"`

	// Deadline is the Unix timestamp (seconds) after which the deposit expires (uint64 as string).
	// Must satisfy: issued_at <= deadline <= issued_at + 128.
	Deadline string `json:"deadline"`
}

// extractSolanaPrehashJSON pulls the first signed message's message_prehash JSON out of a request's
// sender_auth, applying the Solana-scheme guards every determiner needs.
//
// Shared by DetermineDepositHash and DetermineDepositHashV2 so the two cannot drift on which requests they
// accept. Only the envelope handling is shared — each determiner still parses its own prehash shape and
// calls its own frozen hash function.
func extractSolanaPrehashJSON(req paymentrequest.SchemaJson) (string, error) {
	// sender_auth is optional on the unified PaymentRequest schema; guard the
	// pointer before dereferencing its fields below.
	if req.SenderAuth == nil {
		return "", ErrMissingSenderAuth
	}

	if req.SenderAuth.MessageScheme != paymentrequest.SenderAuthMessageSchemeSOLANA {
		return "", ErrNotSolanaRequest
	}

	if len(req.SenderAuth.SignedMessages) == 0 {
		return "", ErrMissingSignedMessages
	}

	firstMsg := req.SenderAuth.SignedMessages[0]
	if firstMsg.MessagePrehash == "" {
		return "", ErrMissingMessagePrehash
	}

	return firstMsg.MessagePrehash, nil
}

// DetermineDepositHash computes the V3 Solana deposit_hash from a PaymentRequest.
//
// The deposit_hash is computed by:
// 1. Validating the request is a Solana request (message_scheme == SOLANA)
// 2. Extracting and parsing the message_prehash JSON from the first signed message
// 3. Converting all fields to their native types
// 4. Computing the deposit hash using ComputeDepositHash with the supplied EscrowDomain
//
// The caller must supply an EscrowDomain sourced from the on-chain ProtocolConfig PDA
// (or a trusted config snapshot). See domain.go for layout details.
//
// Returns the deposit_hash which serves as the unique payment identifier
// and PDA seed for the escrow account on Solana.
func DetermineDepositHash(req paymentrequest.SchemaJson, domain EscrowDomain) ([32]byte, error) {
	var zero32 [32]byte

	// sender_auth is optional on the unified PaymentRequest schema; guard the
	// pointer before dereferencing its fields below.
	prehashJSON, err := extractSolanaPrehashJSON(req)
	if err != nil {
		return zero32, err
	}

	prehash, err := ParseSolanaDepositPrehash(prehashJSON)
	if err != nil {
		return zero32, fmt.Errorf("failed to parse message_prehash: %w", err)
	}

	params, err := prehash.toDepositParams()
	if err != nil {
		return zero32, fmt.Errorf("failed to convert prehash to params: %w", err)
	}

	return ComputeDepositHash(params, domain)
}

// ParseSolanaDepositPrehash parses a JSON string into a SolanaDepositPrehash struct.
func ParseSolanaDepositPrehash(jsonStr string) (*SolanaDepositPrehash, error) {
	var prehash SolanaDepositPrehash
	if err := json.Unmarshal([]byte(jsonStr), &prehash); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}

	if err := validateSolanaDepositPrehashFields(&prehash); err != nil {
		return nil, err
	}

	return &prehash, nil
}

// validateSolanaDepositPrehashFields checks that every field the deposit hash needs is present.
//
// Shared by ParseSolanaDepositPrehash and ParseSolanaDepositPrehashV2 so the two revisions cannot
// disagree on which fields are mandatory. The deposit_request_hash message names the V1 wire key; V2
// checks that one field itself before delegating, because its key differs.
func validateSolanaDepositPrehashFields(prehash *SolanaDepositPrehash) error {
	if prehash.DepositRequestHash == "" {
		return fmt.Errorf("payment_id is required")
	}
	if prehash.Depositor == "" {
		return fmt.Errorf("depositor is required")
	}
	if prehash.Mint == "" {
		return fmt.Errorf("mint is required")
	}
	if prehash.Amount == "" {
		return fmt.Errorf("amount is required")
	}
	if prehash.Reserver == "" {
		return fmt.Errorf("reserver is required")
	}
	if prehash.Releaser == "" {
		return fmt.Errorf("releaser is required")
	}
	if prehash.Nonce == "" {
		return fmt.Errorf("nonce is required")
	}
	if prehash.IssuedAt == "" {
		return fmt.Errorf("issued_at is required")
	}
	if prehash.Deadline == "" {
		return fmt.Errorf("deadline is required")
	}
	return nil
}

// toDepositParams converts a SolanaDepositPrehash to EscrowDepositParams.
func (p *SolanaDepositPrehash) toDepositParams() (EscrowDepositParams, error) {
	var params EscrowDepositParams

	// Parse payment_id (hex with 0x prefix)
	paymentID, err := parseHexBytes32(p.DepositRequestHash)
	if err != nil {
		return params, fmt.Errorf("invalid payment_id: %w", err)
	}
	params.DepositRequestHash = paymentID

	// Parse depositor (Base58)
	depositor, err := PubkeyFromBase58(p.Depositor)
	if err != nil {
		return params, fmt.Errorf("invalid depositor: %w", err)
	}
	params.Depositor = depositor

	// Parse mint (Base58)
	mint, err := PubkeyFromBase58(p.Mint)
	if err != nil {
		return params, fmt.Errorf("invalid mint: %w", err)
	}
	params.Mint = mint

	// Parse amount (uint64 string)
	amount, err := strconv.ParseUint(p.Amount, 10, 64)
	if err != nil {
		return params, fmt.Errorf("invalid amount: %w", err)
	}
	params.Amount = amount

	// Parse reserver (Base58)
	reserver, err := PubkeyFromBase58(p.Reserver)
	if err != nil {
		return params, fmt.Errorf("invalid reserver: %w", err)
	}
	params.Reserver = reserver

	// Parse releaser (Base58)
	releaser, err := PubkeyFromBase58(p.Releaser)
	if err != nil {
		return params, fmt.Errorf("invalid releaser: %w", err)
	}
	params.Releaser = releaser

	// Parse nonce (uint64 string)
	nonce, err := strconv.ParseUint(p.Nonce, 10, 64)
	if err != nil {
		return params, fmt.Errorf("invalid nonce: %w", err)
	}
	params.Nonce = nonce

	// Parse issued_at (uint64 string)
	issuedAt, err := strconv.ParseUint(p.IssuedAt, 10, 64)
	if err != nil {
		return params, fmt.Errorf("invalid issued_at: %w", err)
	}
	params.IssuedAt = issuedAt

	// Parse deadline (uint64 string)
	deadline, err := strconv.ParseUint(p.Deadline, 10, 64)
	if err != nil {
		return params, fmt.Errorf("invalid deadline: %w", err)
	}
	params.Deadline = deadline

	return params, nil
}

// parseHexBytes32 parses a hex-encoded string (with or without 0x prefix)
// into a 32-byte array.
func parseHexBytes32(hexStr string) ([32]byte, error) {
	var result [32]byte

	// Remove 0x prefix if present
	hexStr = strings.TrimPrefix(hexStr, "0x")
	hexStr = strings.TrimPrefix(hexStr, "0X")

	// Decode hex
	bytes, err := hex.DecodeString(hexStr)
	if err != nil {
		return result, fmt.Errorf("invalid hex: %w", err)
	}

	// Validate length
	if len(bytes) != 32 {
		return result, fmt.Errorf("expected 32 bytes, got %d", len(bytes))
	}

	copy(result[:], bytes)
	return result, nil
}

// SolanaDepositPrehashV2 is the message_prehash for the signature_domain_version 4 deposit, which adds
// the destination commitment. It is additive — the V1 SolanaDepositPrehash above is
// unchanged and still describes what domain v1..=v3 deposits signed.
//
// destination rides the prehash because the deposit hash commits to keccak256(destination), not the
// string: without the plaintext a verifier cannot reconstruct the hash at all.
//
// Unlike SolanaReservePrehashV2, which copies its two fields, this embeds V1. encoding/json promotes
// embedded fields, so the wire shape is exactly V1's keys plus "destination" — and the "V2 is V1 plus
// destination" relationship stays structural instead of a nine-field copy that can drift. Sharing is
// safe here in a way it is not for the hash construction: this is a field list, not preimage bytes.
type SolanaDepositPrehashV2 struct {
	// DepositRequestHash is a hex-encoded 32-byte value (with 0x prefix). Unlike V1 this uses the
	// aligned key, matching EVM, TVM and the program's instruction argument.
	DepositRequestHash string `json:"deposit_request_hash"`

	// Destination is the plaintext destination the payer commits to, as `<CAIP-19 asset>@<account>`.
	// It rides the prehash because the deposit hash commits to keccak256(destination), so a verifier
	// cannot reconstruct the hash without it.
	Destination string `json:"destination"`

	// Depositor is the Base58-encoded Solana public key of the user depositing funds.
	Depositor string `json:"depositor"`

	// Mint is the Base58-encoded Solana public key of the SPL token mint.
	Mint string `json:"mint"`

	// Amount is the number of tokens being deposited (uint64 as string).
	Amount string `json:"amount"`

	// Reserver is the Base58-encoded Solana public key authorized to reserve funds.
	Reserver string `json:"reserver"`

	// Releaser is the Base58-encoded Solana public key authorized to release funds.
	Releaser string `json:"releaser"`

	// Nonce is the replay-protection nonce (uint64 as string).
	Nonce string `json:"nonce"`

	// IssuedAt is the issuance unix timestamp (uint64 as string).
	IssuedAt string `json:"issued_at"`

	// Deadline is the expiry unix timestamp (uint64 as string).
	Deadline string `json:"deadline"`
}

// toV1 projects the V2 prehash onto the V1 shape so the shared field parsing and required-field
// validation are reused rather than duplicated. Only the JSON keys differ between the two; the parsed
// values are identical, so this cannot drift in what it accepts.
func (p *SolanaDepositPrehashV2) toV1() SolanaDepositPrehash {
	return SolanaDepositPrehash{
		DepositRequestHash: p.DepositRequestHash,
		Depositor:          p.Depositor,
		Mint:               p.Mint,
		Amount:             p.Amount,
		Reserver:           p.Reserver,
		Releaser:           p.Releaser,
		Nonce:              p.Nonce,
		IssuedAt:           p.IssuedAt,
		Deadline:           p.Deadline,
	}
}

// ToJSON serializes the V2 prehash to JSON bytes.
func (p *SolanaDepositPrehashV2) ToJSON() ([]byte, error) {
	return json.Marshal(p)
}

// DetermineDepositHashV2 is DetermineDepositHash for signature_domain_version 4 requests: it parses a
// SolanaDepositPrehashV2 out of sender_auth and returns ComputeDepositHashV2's deposit hash.
//
// The destination is passed through to the hash exactly as it arrived. It is deliberately NOT
// normalised: the commitment is over the bytes the payer signed, so re-casing or trimming here would
// produce a hash the on-chain program rejects. Callers that want to police the canonical casing rule
// must do so as a separate validation step, before or after this call, never by mutating the value.
func DetermineDepositHashV2(req paymentrequest.SchemaJson, domain EscrowDomain) ([32]byte, error) {
	var zero32 [32]byte

	prehashJSON, err := extractSolanaPrehashJSON(req)
	if err != nil {
		return zero32, err
	}

	prehash, err := ParseSolanaDepositPrehashV2(prehashJSON)
	if err != nil {
		return zero32, fmt.Errorf("failed to parse message_prehash: %w", err)
	}

	v1 := prehash.toV1()
	params, err := v1.toDepositParams()
	if err != nil {
		return zero32, err
	}

	return ComputeDepositHashV2(params, prehash.Destination, domain)
}

// ParseSolanaDepositPrehashV2 parses a JSON string into a SolanaDepositPrehashV2 struct.
//
// Reuses ParseSolanaDepositPrehash for every V1 field so the two cannot disagree on required-field
// validation, then adds the destination check V2 introduces.
func ParseSolanaDepositPrehashV2(jsonStr string) (*SolanaDepositPrehashV2, error) {
	var prehash SolanaDepositPrehashV2
	if err := json.Unmarshal([]byte(jsonStr), &prehash); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}

	// Reuse V1's required-field validation via the projection so the two cannot disagree on which
	// fields are mandatory. Its error text names the V1 wire key, so restate the one key that differs.
	if prehash.DepositRequestHash == "" {
		return nil, fmt.Errorf("deposit_request_hash is required")
	}
	v1 := prehash.toV1()
	if err := validateSolanaDepositPrehashFields(&v1); err != nil {
		return nil, err
	}

	if prehash.Destination == "" {
		return nil, fmt.Errorf("destination is required")
	}

	return &prehash, nil
}

// ─── Deprecated aliases ──────────────────────────────────────────────────────
//
// These were the original names. They are wrong in a way worth correcting on an SDK surface: the
// value returned is a deposit HASH, not a payment id -- the two are distinct concepts in this
// protocol, and the struct field this hash is built from was itself renamed payment_id ->
// deposit_request_hash for parity with the EVM and TVM encoders. A function called
// DeterminePaymentID that returns neither a payment id nor the deposit_request_hash is a trap in a
// library whose whole purpose is keeping those values apart.
//
// Kept as thin forwarders rather than deleted because they are imported from outside this repo
// (atum-core's payment-gw processor tests call DeterminePaymentID). Remove them once those callers
// have moved.
//
// NOTE the JSON wire keys are deliberately NOT renamed with these: SolanaDepositPrehash still
// marshals `payment_id`, because producers emit it and consumers parse it. Identifier names are
// ours to fix; the wire shape is not.

// Deprecated: use DetermineDepositHash. This returns the Solana deposit_hash, not a payment id.
func DeterminePaymentID(req paymentrequest.SchemaJson, domain EscrowDomain) ([32]byte, error) {
	return DetermineDepositHash(req, domain)
}

// Deprecated: use DetermineDepositHashV2. This returns the Solana deposit_hash, not a payment id.
func DeterminePaymentIDV2(req paymentrequest.SchemaJson, domain EscrowDomain) ([32]byte, error) {
	return DetermineDepositHashV2(req, domain)
}
