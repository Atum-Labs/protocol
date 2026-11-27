package verifill

import (
	"encoding/hex"
	"fmt"
	"math/big"
	"regexp"
	"strings"
)

// eip155 verdicts are signed as EIP-712 typed data rather than as the length-framed preimage,
// because the signing backend admits the escrow key's typed data by primary type and domain and
// refuses raw digests. The domain carries no verifyingContract, so a verdict digest can never
// equal an escrow witness digest, whose domain names the escrow.

const (
	verdictTypedDataName    = "Atum Verdict"
	verdictTypedDataVersion = "1"

	fulfillmentVerdictPrimaryType = "FulfillmentVerdict"
	depositVerdictPrimaryType     = "DepositVerdict"
)

// TypedDataField is one member of an EIP-712 struct type.
type TypedDataField struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// TypedDataDomain is the verdict domain. ChainId is the decimal eip155 reference.
type TypedDataDomain struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	ChainId string `json:"chainId"`
}

// TypedData is the EIP-712 payload a producer hands to a typed-data signer. Message values are
// strings, hex for bytes32 and address and decimal for uint256, in the JSON form signers accept.
type TypedData struct {
	Domain      TypedDataDomain             `json:"domain"`
	PrimaryType string                      `json:"primaryType"`
	Types       map[string][]TypedDataField `json:"types"`
	Message     map[string]any              `json:"message"`
}

var eip712DomainFields = []TypedDataField{
	{"name", "string"},
	{"version", "string"},
	{"chainId", "uint256"},
}

// typedMember is one field of a verdict struct with its wire value. The type string, the message
// and the struct hash are all derived from one list of these, so they cannot disagree.
type typedMember struct {
	name, typ, value string
	// emptyIsZero marks the outcome-conditional members, whose empty value encodes as zero.
	emptyIsZero bool
}

func fulfillmentTypedMembers(v *FulfillmentVerdict) []typedMember {
	return []typedMember{
		{name: "domain", typ: "string", value: v.Domain},
		{name: "paymentId", typ: "bytes32", value: v.PaymentId},
		{name: "chainId", typ: "string", value: v.ChainId},
		{name: "outcome", typ: "string", value: string(v.Outcome)},
		{name: "blockNumber", typ: "uint256", value: v.BlockNumber},
		{name: "blockHash", typ: "bytes32", value: v.BlockHash},
		{name: "finalityPolicy", typ: "string", value: v.FinalityPolicy},
		{name: "transactionHash", typ: "bytes32", value: v.TransactionHash, emptyIsZero: true},
		{name: "fulfiller", typ: "address", value: v.Fulfiller, emptyIsZero: true},
	}
}

func depositTypedMembers(v *DepositVerdict) []typedMember {
	return []typedMember{
		{name: "domain", typ: "string", value: v.Domain},
		{name: "paymentId", typ: "bytes32", value: v.PaymentId},
		{name: "chainId", typ: "string", value: v.ChainId},
		{name: "escrowAddress", typ: "address", value: v.EscrowAddress},
		{name: "outcome", typ: "string", value: string(v.Outcome)},
		{name: "blockNumber", typ: "uint256", value: v.BlockNumber},
		{name: "blockHash", typ: "bytes32", value: v.BlockHash},
		{name: "finalityPolicy", typ: "string", value: v.FinalityPolicy},
		{name: "transactionHash", typ: "bytes32", value: v.TransactionHash, emptyIsZero: true},
	}
}

func typedFields(members []typedMember) []TypedDataField {
	out := make([]TypedDataField, len(members))
	for i, m := range members {
		out[i] = TypedDataField{Name: m.name, Type: m.typ}
	}
	return out
}

// encodeType renders the EIP-712 type string, e.g. `EIP712Domain(string name,...)`.
func encodeType(primary string, fields []TypedDataField) string {
	parts := make([]string, len(fields))
	for i, f := range fields {
		parts[i] = f.Type + " " + f.Name
	}
	return primary + "(" + strings.Join(parts, ",") + ")"
}

var canonicalUintRe = regexp.MustCompile(`^(0|[1-9][0-9]{0,77})$`)

// encodeUint256 accepts only the canonical decimal spelling, so one value has one digest.
func encodeUint256(name, value string) ([]byte, error) {
	if !canonicalUintRe.MatchString(value) {
		return nil, fmt.Errorf("typed member %s = %q is not a canonical decimal uint256", name, value)
	}
	n, _ := new(big.Int).SetString(value, 10)
	if n.BitLen() > 256 {
		return nil, fmt.Errorf("typed member %s = %q overflows uint256", name, value)
	}
	return n.FillBytes(make([]byte, 32)), nil
}

// encodeTypedValue returns the 32-byte EIP-712 encoding of one member and its message value.
// Hex is accepted only in its lowercase 0x form, the one spelling the schema admits, so the
// digest never verifies a verdict whose member is spelled some other way.
func encodeTypedValue(m typedMember) ([]byte, string, error) {
	if m.emptyIsZero && m.value == "" {
		switch m.typ {
		case "bytes32":
			return make([]byte, 32), "0x" + strings.Repeat("00", 32), nil
		case "address":
			return make([]byte, 32), "0x" + strings.Repeat("00", 20), nil
		}
	}
	switch m.typ {
	case "string":
		if err := verdictMemberIsRenderable(m.name, m.value); err != nil {
			return nil, "", err
		}
		return keccak256([]byte(m.value)), m.value, nil
	case "uint256":
		b, err := encodeUint256(m.name, m.value)
		return b, m.value, err
	case "bytes32", "address":
		re, size := hexHashRe, 32
		if m.typ == "address" {
			re, size = evmAccountRe, 20
		}
		if !re.MatchString(m.value) {
			return nil, "", fmt.Errorf("typed member %s = %q is not lowercase 0x-prefixed %d-byte hex", m.name, m.value, size)
		}
		raw, _ := hex.DecodeString(m.value[2:])
		// Empty is the only spelling of zero, so the empty-to-zero mapping stays injective.
		if m.emptyIsZero && strings.Trim(m.value[2:], "0") == "" {
			return nil, "", fmt.Errorf("typed member %s spells zero explicitly; zero is written as the empty string", m.name)
		}
		return append(make([]byte, 32-size), raw...), m.value, nil
	default:
		return nil, "", fmt.Errorf("typed member %s has unsupported type %q", m.name, m.typ)
	}
}

// eip712Encode builds the typed data and its signing digest from one member list:
// keccak256(0x19 || 0x01 || domainSeparator || hashStruct(message)).
func eip712Encode(chainID, primary string, members []typedMember) (TypedData, []byte, error) {
	if scheme, ok := VerdictSchemeForChain(chainID); !ok || scheme != VerdictSignatureSchemeEip712Secp256k1 {
		return TypedData{}, nil, fmt.Errorf("chain %q does not sign verdicts as EIP-712 typed data", chainID)
	}
	ref := chainID[strings.IndexByte(chainID, ':')+1:]
	chainWord, err := encodeUint256("chainId", ref)
	if err != nil {
		return TypedData{}, nil, fmt.Errorf("chain %q: %w", chainID, err)
	}
	domainSeparator := keccak256(
		keccak256([]byte(encodeType("EIP712Domain", eip712DomainFields))),
		keccak256([]byte(verdictTypedDataName)),
		keccak256([]byte(verdictTypedDataVersion)),
		chainWord,
	)

	fields := typedFields(members)
	encoded := [][]byte{keccak256([]byte(encodeType(primary, fields)))}
	message := make(map[string]any, len(members))
	for _, m := range members {
		word, value, err := encodeTypedValue(m)
		if err != nil {
			return TypedData{}, nil, err
		}
		encoded = append(encoded, word)
		message[m.name] = value
	}
	hashStruct := keccak256(encoded...)

	td := TypedData{
		Domain:      TypedDataDomain{Name: verdictTypedDataName, Version: verdictTypedDataVersion, ChainId: ref},
		PrimaryType: primary,
		Types:       map[string][]TypedDataField{"EIP712Domain": eip712DomainFields, primary: fields},
		Message:     message,
	}
	return td, keccak256([]byte{0x19, 0x01}, domainSeparator, hashStruct), nil
}

// VerdictTypedData returns the EIP-712 typed data an eip155 fulfillment verdict is signed as,
// for a producer whose signer takes typed data rather than a digest. The digest
// VerdictSigningDigest returns for the same verdict is the hash of exactly this payload. It
// fails for a verdict on any other chain family, and for a member with a non-canonical spelling.
//
// It is built for any verdict, so a producer MUST validate the signed verdict with
// ValidateVerdictMembers before emitting it.
// The typed data is signer input only: its message spells an empty member as an explicit zero,
// and the verdict object, not this payload, is what goes on the wire.
func VerdictTypedData(v *FulfillmentVerdict) (TypedData, error) {
	if v == nil {
		return TypedData{}, fmt.Errorf("verdict is nil")
	}
	td, _, err := eip712Encode(v.ChainId, fulfillmentVerdictPrimaryType, fulfillmentTypedMembers(v))
	return td, err
}

// DepositVerdictTypedData is the same for an eip155 deposit verdict, under the same caveats with
// the signed verdict validated by ValidateDepositVerdictMembers before it is emitted.
func DepositVerdictTypedData(v *DepositVerdict) (TypedData, error) {
	if v == nil {
		return TypedData{}, fmt.Errorf("deposit verdict is nil")
	}
	td, _, err := eip712Encode(v.ChainId, depositVerdictPrimaryType, depositTypedMembers(v))
	return td, err
}
