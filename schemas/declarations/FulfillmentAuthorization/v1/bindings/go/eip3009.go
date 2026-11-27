package fulfillmentauthorization

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/big"
	"reflect"
	"regexp"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	generated "github.com/atum-labs/protocol/schemas/declarations/FulfillmentAuthorization/v1/bindings/go/generated"
	"github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go/jsonmembers"
)

const schemeEIP3009 = "EIP-3009"

// eip3009AuthorizationMembers are the only members an EIP-3009 authorization may carry. An
// allowlist, not just a payload refusal: anything else is a member no signature covers and no rule
// reads, so a reader could take meaning from it that the settler never gave.
var eip3009AuthorizationMembers = map[string]struct{}{
	"message":         {},
	"message_prehash": {},
	"signature":       {},
}

// An EIP-3009 authorization carries its typed data as a JSON string in
// authorization.message_prehash, the EIP-712 digest of that typed data in
// authorization.message, and the settler's signature over the digest in
// authorization.signature. It has no payload.
const eip3009PrimaryType = "TransferWithAuthorization"

var eip3009Types = []typedDataField{
	{Name: "from", Type: "address"},
	{Name: "to", Type: "address"},
	{Name: "value", Type: "uint256"},
	{Name: "validAfter", Type: "uint256"},
	{Name: "validBefore", Type: "uint256"},
	{Name: "nonce", Type: "bytes32"},
}

var (
	eip712DomainTypeHash = crypto.Keccak256([]byte("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"))
	eip3009TypeHash      = crypto.Keccak256([]byte("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"))
	secp256k1HalfN       = new(big.Int).Rsh(crypto.S256().Params().N, 1)

	evmAddressPattern = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)
	bytes32Pattern    = regexp.MustCompile(`^0x[0-9a-fA-F]{64}$`)
	uintPattern       = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)
	maxUint256        = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
)

type typedDataField struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

type eip3009TypedData struct {
	Domain struct {
		Name              string      `json:"name"`
		Version           string      `json:"version"`
		ChainID           json.Number `json:"chainId"`
		VerifyingContract string      `json:"verifyingContract"`
	} `json:"domain"`
	Types       map[string][]typedDataField `json:"types"`
	PrimaryType string                      `json:"primaryType"`
	Message     struct {
		From        string `json:"from"`
		To          string `json:"to"`
		Value       string `json:"value"`
		ValidAfter  string `json:"validAfter"`
		ValidBefore string `json:"validBefore"`
		Nonce       string `json:"nonce"`
	} `json:"message"`
}

func parseEIP3009(authorization generated.SignedMessage, rawMembers map[string]json.RawMessage, destination string, opts options) (authorizedTransfer, error) {
	if authorization.Payload != nil {
		return authorizedTransfer{}, fmt.Errorf("EIP-3009 authorization must not carry payload; the transfer is read from message_prehash")
	}
	for member := range rawMembers {
		if _, ok := eip3009AuthorizationMembers[member]; !ok {
			return authorizedTransfer{}, fmt.Errorf("EIP-3009 authorization has unknown member %s", member)
		}
	}
	if authorization.MessagePrehash == nil || *authorization.MessagePrehash == "" {
		return authorizedTransfer{}, fmt.Errorf("EIP-3009 authorization requires message_prehash (the TransferWithAuthorization typed data as JSON)")
	}
	// No "@context" exemption: a signed prehash carries no JSON-LD, so every member is checked.
	if path, err := jsonmembers.FirstAmbiguousMemberStrict([]byte(*authorization.MessagePrehash)); err != nil {
		return authorizedTransfer{}, fmt.Errorf("message_prehash: %w", err)
	} else if path != "" {
		return authorizedTransfer{}, fmt.Errorf("message_prehash has ambiguous member %s: two members of one object fold to the same name", path)
	}
	decoded, err := decodeEIP3009(*authorization.MessagePrehash)
	if err != nil {
		return authorizedTransfer{}, err
	}
	transfer, digest := decoded.transfer, decoded.digest
	if !bytes32Pattern.MatchString(authorization.Message) || !bytes.Equal(common.FromHex(authorization.Message), digest) {
		return authorizedTransfer{}, fmt.Errorf("authorization.message %s is not the EIP-712 digest of message_prehash (0x%x)", authorization.Message, digest)
	}
	// The settler's signature has three outcomes, by who can prove it:
	//
	//   - ValidateWithChain: the chain is read, and the signature is proved by the rule the token
	//     applies. That check is deferred to after every offline rule, in verifySignature below.
	//   - Validate, a 65-byte signature: recovered here and matched to message.from. A pass proves the
	//     settler's key signed.
	//   - Validate, anything else: refused, unless the caller passed AllowContractSignature. This
	//     validator cannot tell an EOA settler from a contract one without an eth_call, so the
	//     permissive branch is reachable for any settler, and accepting it by default meant a pass no
	//     longer proved the settler signed (CORE-2955). Under the option the token is the authority.
	//
	// Contract signatures are real: every token in the EIP-3009 list verifies through
	// SignatureChecker.isValidSignatureNow, which sends an EOA signer to ECRecover and a signer WITH
	// CODE to its ERC-1271 isValidSignature — USDC's FiatTokenV2_2, PYUSD, USDT0's
	// ArbitrumExtensionV2 and TetherTokenCeloExtension all do.
	var verifySignature func() error
	switch {
	case opts.chain != nil:
		if err := requireSignatureHex(authorization.Signature); err != nil {
			return authorizedTransfer{}, err
		}
		verifySignature = func() error {
			return opts.chain.verify(transfer.From, decoded.chainID, decoded.verifyingContract, digest, authorization.Signature)
		}
	case isEOASignature(authorization.Signature):
		if err := requireEOASigner(digest, authorization.Signature, transfer.From); err != nil {
			return authorizedTransfer{}, err
		}
	case !opts.allowContractSignature:
		return authorizedTransfer{}, errNotEOASignature(authorization.Signature)
	default:
		if err := requireSignatureBytes(authorization.Signature); err != nil {
			return authorizedTransfer{}, err
		}
	}
	if err := requireDomainBinding(decoded.chainID, decoded.verifyingContract, destination); err != nil {
		return authorizedTransfer{}, err
	}
	transfer.verifySignature = verifySignature
	return transfer, nil
}

// decodedEIP3009 is what decodeEIP3009 reads out of message_prehash: the transfer the typed data
// authorizes, its EIP-712 digest, and the two domain fields that digest was computed over, kept
// apart from the transfer so the scheme can bind each to the quote by its signed name.
type decodedEIP3009 struct {
	transfer          authorizedTransfer
	digest            []byte
	chainID           *big.Int
	verifyingContract string
}

// requireDomainBinding ties the EIP-712 domain to the quote's destination asset, which is the
// token the authorization is for: domain.chainId must be the destination's chain reference and
// domain.verifyingContract its token address. The message fields are bound to the quote (from to
// the settler, to to the recipient, value to the amount, nonce to the quote hash, validBefore to
// the deadline, validAfter to 0), and a consumer takes a pass as "this authorization is for this
// payment", so these two domain fields are bound the same way (CORE-2991).
//
// domain.name and domain.version sit in the same domain separator and are NOT bound: they are only
// type-checked, so a pass does not prove the token will accept the signature. An authorization
// signed under a name or version the token does not hash reverts on chain.
//
// Not a hole on chain: both fields are in the EIP-712 domain separator, so the destination token
// computes a different digest and rejects a signature made under another domain. The shared
// asset rule also compares the whole CAIP-19 identifier the domain reduces to; this check runs
// first and names the field that differs, in the words the settler signed. Both halves are
// compared as the shared rules compare accounts and assets: folded, so a checksummed and a
// lower-case spelling of one address are the same token.
func requireDomainBinding(chainID *big.Int, verifyingContract, destination string) error {
	chain, asset, _ := strings.Cut(destination, "/")
	_, token, _ := strings.Cut(asset, ":")
	if !sameAsset("eip155:"+chainID.String(), chain) {
		return fmt.Errorf("message_prehash domain.chainId %s is not the quote destination's chain %s", chainID, chain)
	}
	if !sameAccount(verifyingContract, token) {
		return fmt.Errorf("message_prehash domain.verifyingContract %s is not the quote destination's token %s", verifyingContract, token)
	}
	return nil
}

// decodeEIP3009 reads message_prehash, which must be exactly the TransferWithAuthorization
// typed data the settler signs, and returns the transfer it describes, its EIP-712 digest and
// the domain fields the digest covers.
func decodeEIP3009(prehash string) (decodedEIP3009, error) {
	var typed eip3009TypedData
	decoder := json.NewDecoder(strings.NewReader(prehash))
	decoder.UseNumber()
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&typed); err != nil {
		return decodedEIP3009{}, fmt.Errorf("message_prehash is not EIP-3009 typed data: %w", err)
	}
	if decoder.More() {
		return decodedEIP3009{}, fmt.Errorf("message_prehash has trailing data after the typed data")
	}
	if typed.PrimaryType != eip3009PrimaryType {
		return decodedEIP3009{}, fmt.Errorf("message_prehash primaryType %q is not %s", typed.PrimaryType, eip3009PrimaryType)
	}
	if len(typed.Types) != 1 || !reflect.DeepEqual(typed.Types[eip3009PrimaryType], eip3009Types) {
		return decodedEIP3009{}, fmt.Errorf("message_prehash types must be exactly the EIP-3009 TransferWithAuthorization type")
	}

	domain := typed.Domain
	chainID, ok := parseUint256(domain.ChainID.String())
	if !ok || chainID.Sign() == 0 {
		return decodedEIP3009{}, fmt.Errorf("message_prehash domain.chainId %q is not a positive integer", domain.ChainID)
	}
	if !evmAddressPattern.MatchString(domain.VerifyingContract) {
		return decodedEIP3009{}, fmt.Errorf("message_prehash domain.verifyingContract %q is not an EVM address", domain.VerifyingContract)
	}

	message := typed.Message
	if !evmAddressPattern.MatchString(message.From) || !evmAddressPattern.MatchString(message.To) {
		return decodedEIP3009{}, fmt.Errorf("message_prehash message.from and message.to must be EVM addresses")
	}
	value, okValue := parseUint256(message.Value)
	validAfter, okAfter := parseUint256(message.ValidAfter)
	validBefore, okBefore := parseUint256(message.ValidBefore)
	if !okValue || !okAfter || !okBefore {
		return decodedEIP3009{}, fmt.Errorf("message_prehash message.value, validAfter and validBefore must be uint256 decimal strings")
	}
	// The settler signs validAfter 0 and the README documents it. A later not-before is a
	// transfer the token refuses until it passes, so it only shortens the window the
	// originator was quoted, and an authorization no one can execute reads as one that can.
	if validAfter.Sign() != 0 {
		return decodedEIP3009{}, fmt.Errorf("message_prehash message.validAfter must be 0, got %s", message.ValidAfter)
	}
	if !bytes32Pattern.MatchString(message.Nonce) {
		return decodedEIP3009{}, fmt.Errorf("message_prehash message.nonce %q is not bytes32 hex", message.Nonce)
	}

	domainSeparator := crypto.Keccak256(
		eip712DomainTypeHash,
		crypto.Keccak256([]byte(domain.Name)),
		crypto.Keccak256([]byte(domain.Version)),
		common.LeftPadBytes(chainID.Bytes(), 32),
		common.LeftPadBytes(common.HexToAddress(domain.VerifyingContract).Bytes(), 32),
	)
	structHash := crypto.Keccak256(
		eip3009TypeHash,
		common.LeftPadBytes(common.HexToAddress(message.From).Bytes(), 32),
		common.LeftPadBytes(common.HexToAddress(message.To).Bytes(), 32),
		common.LeftPadBytes(value.Bytes(), 32),
		common.LeftPadBytes(validAfter.Bytes(), 32),
		common.LeftPadBytes(validBefore.Bytes(), 32),
		common.FromHex(message.Nonce),
	)
	digest := crypto.Keccak256([]byte{0x19, 0x01}, domainSeparator, structHash)

	return decodedEIP3009{
		transfer: authorizedTransfer{
			From:      message.From,
			To:        message.To,
			Value:     value,
			Asset:     fmt.Sprintf("eip155:%s/erc20:%s", chainID, domain.VerifyingContract),
			Nonce:     message.Nonce,
			NotBefore: validAfter,
			Expiry:    validBefore,
		},
		digest:            digest,
		chainID:           chainID,
		verifyingContract: domain.VerifyingContract,
	}, nil
}

// isEOASignature reports whether the signature is the 65-byte r‖s‖v form an EOA produces, and so
// is one this validator can verify offline. Anything else is a contract (ERC-1271) signature,
// whose shape is the wallet's own business and whose validity only the chain can answer.
func isEOASignature(signature string) bool {
	return strings.HasPrefix(signature, "0x") && len(common.FromHex(signature)) == 65
}

// errNotEOASignature is the strict-default refusal: the signature is not the 65-byte EOA form,
// and the caller did not say its settler may be a contract wallet.
func errNotEOASignature(signature string) error {
	if !strings.HasPrefix(signature, "0x") {
		return fmt.Errorf("authorization.signature must be 0x-prefixed hex")
	}
	return fmt.Errorf("authorization.signature must be 65 bytes, got %d; pass AllowContractSignature if this settler may be a contract wallet", len(common.FromHex(signature)))
}

// requireSignatureBytes is the only check a contract signature gets here: that it is hex, and not
// empty. ERC-1271 puts no shape on the bytes, so there is nothing else to assert offline.
func requireSignatureBytes(signature string) error {
	if !strings.HasPrefix(signature, "0x") {
		return fmt.Errorf("authorization.signature must be 0x-prefixed hex")
	}
	if len(common.FromHex(signature)) == 0 {
		return fmt.Errorf("authorization.signature is empty")
	}
	return nil
}

// requireEOASigner is the offline rule for a 65-byte signature: it recovers to from.
func requireEOASigner(digest []byte, signature, from string) error {
	signer, err := recoverSigner(digest, signature)
	if err != nil {
		return err
	}
	if signer != common.HexToAddress(from) {
		return fmt.Errorf("authorization.signature recovers to %s, not message.from %s", signer.Hex(), from)
	}
	return nil
}

// recoverSigner recovers the address that produced a 65-byte r‖s‖v signature over digest.
// It refuses high-s signatures, which EIP-3009 tokens reject on chain.
func recoverSigner(digest []byte, signature string) (common.Address, error) {
	sig := bytes.Clone(common.FromHex(signature))
	// Only 27 and 28. FiatToken's ECRecover reverts on 0 and 1, so accepting them here would
	// pass an authorization whose transferWithAuthorization cannot be executed, and a
	// go-ethereum producer that skips the +27 (CORE-2772) would clear this gate.
	switch sig[64] {
	case 27, 28:
		sig[64] -= 27
	default:
		return common.Address{}, fmt.Errorf("authorization.signature has recovery id %d; EIP-3009 accepts only 27 and 28", sig[64])
	}
	r := new(big.Int).SetBytes(sig[:32])
	s := new(big.Int).SetBytes(sig[32:64])
	if s.Cmp(secp256k1HalfN) > 0 || !crypto.ValidateSignatureValues(sig[64], r, s, true) {
		return common.Address{}, fmt.Errorf("authorization.signature is not a canonical secp256k1 signature")
	}
	pub, err := crypto.SigToPub(digest, sig)
	if err != nil {
		return common.Address{}, fmt.Errorf("authorization.signature does not recover: %w", err)
	}
	return crypto.PubkeyToAddress(*pub), nil
}

// parseUint256 reads a canonical unsigned decimal (no sign, no leading zeros) that fits uint256.
func parseUint256(s string) (*big.Int, bool) {
	if !uintPattern.MatchString(s) {
		return nil, false
	}
	n, ok := new(big.Int).SetString(s, 10)
	if !ok || n.Cmp(maxUint256) > 0 {
		return nil, false
	}
	return n, true
}
