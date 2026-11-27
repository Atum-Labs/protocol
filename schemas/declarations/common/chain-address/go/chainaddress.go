// Package chainaddress decides whether an account string is usable on the chain it names.
//
// It answers the chain-agnostic half of that question only: the account is present, carries no
// surrounding whitespace, parses under its chain's own address rules, and is not that chain's
// zero address. Those four are properties of the address itself, so every participant that reads
// a PaymentRequest can agree on them.
//
// It deliberately does NOT decide whether a particular settler can pay the account. Rules such as
// "this builder derives the associated token account with an on-curve authority" are one
// implementation's payout form, not a property of the address, and belong with the service that
// enforces them.
//
// The Go and TypeScript halves are kept equal by vectors.json, which pins the canonical bytes, the
// account kind and the rejection reason for every case. Changing either half without the other breaks that test.
package chainaddress

import (
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"unicode"

	"github.com/ethereum/go-ethereum/common"
	"github.com/mr-tron/base58"

	stellarencoding "github.com/atum-labs/protocol/contracts/stellar/bindings/go/escrow-encoding/encoding"
	tvmencoding "github.com/atum-labs/protocol/contracts/tvm/bindings/go/escrow-encoding/encoding"
)

// CAIP-2 namespaces this package knows address rules for.
const (
	NamespaceEip155  = "eip155"
	NamespaceTron    = "tron"
	NamespaceSolana  = "solana"
	NamespaceStellar = "stellar"
)

// Reason is the frozen rejection taxonomy. The string values are part of the cross-language
// contract: both halves must reject the same input with the same reason.
type Reason string

const (
	ReasonEmpty                 Reason = "EMPTY"
	ReasonSurroundingWhitespace Reason = "SURROUNDING_WHITESPACE"
	ReasonUnsupportedNamespace  Reason = "UNSUPPORTED_NAMESPACE"
	ReasonUnparseable           Reason = "UNPARSEABLE"
	ReasonZero                  Reason = "ZERO"
)

// ErrInvalidAccount is the sentinel every rejection matches, so a caller that does not care why
// can write errors.Is(err, ErrInvalidAccount).
var ErrInvalidAccount = errors.New("chain-address: account is not usable on its chain")

// Error carries why an account was rejected. Detail holds the parser's own words and is not part
// of the cross-language contract, since the two languages' address libraries word things
// differently; Reason is what the vectors pin.
type Error struct {
	Reason  Reason
	Network string
	Account string
	Detail  string
}

func (e *Error) Error() string {
	switch e.Reason {
	case ReasonEmpty:
		return "account is required and cannot be empty"
	case ReasonSurroundingWhitespace:
		return "account must not contain leading or trailing whitespace"
	case ReasonUnsupportedNamespace:
		return fmt.Sprintf("no address rules are known for chain %s", e.Network)
	case ReasonZero:
		return fmt.Sprintf("account is the zero address on %s, which cannot receive a payout", e.Network)
	default:
		// Detail is deliberately not rendered: it comes from whichever address library each
		// language uses, and those word the same failure differently, so including it would make
		// the message impossible to hold equal across the two halves.
		return fmt.Sprintf("account is not a valid address for %s", e.Network)
	}
}

func (e *Error) Is(target error) bool { return target == ErrInvalidAccount }

// ReasonOf returns the Reason carried by err, or "" when err did not come from this package.
func ReasonOf(err error) Reason {
	var invalid *Error
	if errors.As(err, &invalid) {
		return invalid.Reason
	}
	return ""
}

// Account is a parsed account in its canonical byte form: 20 bytes for eip155 and tron (the tron
// 0x41 prefix stripped, so the zero test means the same thing on both), 32 for solana and stellar
// (the ed25519 key of a G account or the contract id of a C account, version byte and checksum
// stripped).
//
// For stellar the bytes alone are not an identity: a G account and a C contract with the same 32
// bytes are different accounts that parse to equal Bytes(). Compare Kind() as well.
type Account struct {
	namespace string
	kind      Kind
	bytes     []byte
}

// Kind says which kind of account a namespace with more than one parsed. Only stellar has two: a
// G account and a C contract. Every other namespace has a single kind and reports the empty Kind.
type Kind string

const (
	KindAccount  Kind = "account"  // a G... ed25519 account
	KindContract Kind = "contract" // a C... contract
)

func (a Account) Namespace() string { return a.namespace }

// Kind is KindAccount or KindContract for stellar and the empty Kind for every other namespace.
func (a Account) Kind() Kind { return a.kind }

// Bytes returns a copy, so a caller cannot mutate the parsed account.
func (a Account) Bytes() []byte {
	out := make([]byte, len(a.bytes))
	copy(out, a.bytes)
	return out
}

// Reasons lists every rejection reason, so the coverage test can demand a vector for each rather
// than restating the list in the test and only checking the reasons it was already told about.
//
// Honest about what this does not do: Go cannot check a const group for exhaustiveness, so a new
// reason added to the block above without a line here is still possible. It removes the duplicate
// list, not the need to remember. The TypeScript half derives its union from its array, which does
// make the omission impossible there.
func Reasons() []Reason {
	return []Reason{
		ReasonEmpty,
		ReasonSurroundingWhitespace,
		ReasonUnsupportedNamespace,
		ReasonUnparseable,
		ReasonZero,
	}
}

// SupportedNamespaces lists the CAIP-2 namespaces with address rules here.
func SupportedNamespaces() []string {
	return []string{NamespaceEip155, NamespaceSolana, NamespaceStellar, NamespaceTron}
}

// Parse applies the form rules: present, no surrounding whitespace, and parseable under the
// chain's own rules. It does not apply the zero-address rule; use Validate for that.
//
// trimSurrounding removes the whitespace both languages agree to treat as surrounding, which is the
// union of the two platform functions rather than either one.
//
// The sets differ in exactly two characters, and the reason returned is the cross language contract,
// so leaving each side on its own function made that contract diverge. Go's unicode.White_Space has
// U+0085 and lacks the byte order mark, while JavaScript's trim is the reverse. Taking the union
// keeps every character either side already trimmed, so no input changes from accepted to rejected
// or back, and a receiver pasted out of a UTF-8 file with a byte order mark gets told about the
// whitespace rather than that its address is unreadable.
func trimSurrounding(value string) string {
	return strings.TrimFunc(value, func(r rune) bool {
		return unicode.IsSpace(r) || r == '\ufeff'
	})
}

// Only the CAIP-2 namespace is read. The reference is ignored because address form does not
// depend on it, and because the reference is spelled inconsistently across our own surfaces
// (a Solana genesis hash in one place, "mainnet" in another).
func Parse(network, account string) (Account, error) {
	reject := func(reason Reason, detail string) (Account, error) {
		return Account{}, &Error{Reason: reason, Network: network, Account: account, Detail: detail}
	}

	if trimSurrounding(account) == "" {
		return reject(ReasonEmpty, "")
	}
	// Refused rather than trimmed: the account travels onward as the caller wrote it, so a value
	// this had to alter is one the caller should correct.
	if account != trimSurrounding(account) {
		return reject(ReasonSurroundingWhitespace, "")
	}

	namespace, _, found := strings.Cut(network, ":")
	if !found || namespace == "" {
		return reject(ReasonUnsupportedNamespace, "")
	}

	var (
		bytes []byte
		kind  Kind
		err   error
	)
	switch namespace {
	case NamespaceEip155:
		bytes, err = parseEVM(account)
	case NamespaceTron:
		bytes, err = parseTron(account)
	case NamespaceSolana:
		bytes, err = parseSolana(account)
	case NamespaceStellar:
		bytes, kind, err = parseStellar(account)
	default:
		return reject(ReasonUnsupportedNamespace, "")
	}
	if err != nil {
		return reject(ReasonUnparseable, err.Error())
	}

	return Account{namespace: namespace, kind: kind, bytes: bytes}, nil
}

// Validate is Parse plus the zero-address rule. This is what an ingress check calls.
func Validate(network, account string) (Account, error) {
	parsed, err := Parse(network, account)
	if err != nil {
		return Account{}, err
	}
	if isZero(parsed.bytes) {
		return Account{}, &Error{Reason: ReasonZero, Network: network, Account: account}
	}
	return parsed, nil
}

// isZero requires at least one byte, so an empty slice is never mistaken for the zero address.
func isZero(b []byte) bool {
	if len(b) == 0 {
		return false
	}
	for _, one := range b {
		if one != 0 {
			return false
		}
	}
	return true
}

// parseEVM accepts hex with an optional 0x or 0X prefix, and enforces EIP-55 only when the body
// is mixed case. A mixed-case body therefore has to carry the lowercase 0x prefix, since the
// checksum form is compared against the canonical rendering.
func parseEVM(account string) ([]byte, error) {
	if !common.IsHexAddress(account) {
		return nil, errors.New("expected 40 hex characters, optionally 0x-prefixed")
	}
	body := strings.TrimPrefix(strings.TrimPrefix(account, "0x"), "0X")
	if body != strings.ToLower(body) && body != strings.ToUpper(body) {
		if common.HexToAddress(account).Hex() != account {
			return nil, errors.New("mixed-case address fails its EIP-55 checksum")
		}
	}
	return common.HexToAddress(account).Bytes(), nil
}

// parseTron takes the base58check form, the 0x41-prefixed hex form, or the EVM hex forms, and
// returns the 20 bytes with the 0x41 prefix removed.
func parseTron(account string) ([]byte, error) {
	const (
		base58Length = 34
		prefixedHex  = 44
		bareHex      = 40
	)

	var hexBody string
	switch {
	case strings.HasPrefix(account, "T") && len(account) == base58Length:
		converted, err := tvmencoding.ConvertBase58ToHex(account)
		if err != nil {
			return nil, fmt.Errorf("base58 address failed its checksum: %w", err)
		}
		hexBody = converted
	case strings.HasPrefix(strings.ToLower(account), "0x41") && len(account) == prefixedHex:
		hexBody = account[2:]
	case common.IsHexAddress(account):
		// The EVM hex form, checksum rules and all.
		return parseEVM(account)
	case len(account) == bareHex:
		hexBody = account
	default:
		return nil, errors.New("expected a T-prefixed base58 address or 40 hex characters")
	}

	hexBody = strings.TrimPrefix(hexBody, "41")
	if len(hexBody) != bareHex {
		return nil, fmt.Errorf("expected %d hex characters after conversion, got %d", bareHex, len(hexBody))
	}
	decoded, err := hex.DecodeString(hexBody)
	if err != nil {
		return nil, errors.New("expected hex characters")
	}
	return decoded, nil
}

// parseSolana takes base58 only. The hex and base64 spellings some parsers allow are refused
// here, because the account travels to the settler as written and the payout path reads base58.
func parseSolana(account string) ([]byte, error) {
	decoded, err := base58.Decode(account)
	if err != nil {
		return nil, errors.New("expected a 32-byte base58 public key")
	}
	if len(decoded) != 32 {
		return nil, fmt.Errorf("expected a 32-byte base58 public key, got %d bytes", len(decoded))
	}
	return decoded, nil
}

// parseStellar takes a G account (ed25519 public key) or a C contract strkey. Every other strkey type
// is refused, including muxed accounts (M) and muxed contracts (W, CAP-84, Protocol 30): the payout
// path has no way to carry the mux id, so accepting one would silently pay the base account or contract.
func parseStellar(account string) ([]byte, Kind, error) {
	// The strkey rules (alphabet first, canonical base32, checksum, payload size) live in one place,
	// the Stellar escrow-encoding package. This adds only what a payout can name.
	addr, err := stellarencoding.ParseAddress(account)
	if err != nil {
		return nil, "", err
	}
	kind := KindAccount
	if addr.Type == stellarencoding.ContractAddress {
		kind = KindContract
	}
	key := addr.Key
	return key[:], kind, nil
}
