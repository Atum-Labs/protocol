package senderauth

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	evmencoding "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/encoding"
	tvmencoding "github.com/atum-labs/protocol/contracts/tvm/bindings/go/escrow-encoding/encoding"

	"github.com/ethereum/go-ethereum/common"
)

// ErrDepositRefUnreadable is returned by DepositFromSenderAuth when no deposit reference can be
// derived from the sender_auth. Detect it with errors.Is.
var ErrDepositRefUnreadable = errors.New("sender_auth: no deposit reference can be derived")

// DepositRef identifies the escrow deposit a sender_auth funds.
type DepositRef struct {
	// PaymentID is the escrow's deposit id: 0x + 64 lowercase hex.
	PaymentID string `json:"paymentId"`
	// Reserver is the signed witness reserver as the prehash spells it (EVM/Tron), "" on Solana.
	Reserver string `json:"reserver"`
}

// DepositFromSenderAuth derives the escrow's deposit id and the reserver from a sender_auth object read by
// exact member name, for the CAIP-2 source network and depositor. It verifies no signature or commitment.
// Any sender_auth admitted for deposit must have passed VerifyCommitment, which reads the same signed
// message, otherwise a funded deposit may be unreleasable.
func DepositFromSenderAuth(sourceNetwork, depositor string, senderAuth json.RawMessage) (DepositRef, error) {
	fail := func(format string, args ...any) (DepositRef, error) {
		return DepositRef{}, fmt.Errorf("%w: "+format, append([]any{ErrDepositRefUnreadable}, args...)...)
	}
	scheme, first, problem := readFirstSignedMessage(senderAuth)
	if problem != "" {
		return fail("%s", problem)
	}
	namespace := namespaceOf(sourceNetwork)
	if !slices.Contains(permittedSchemes[namespace], SenderAuthMessageScheme(scheme)) {
		return fail("message_scheme %s cannot authorise a payment from %s", quoteValue(scheme), quoteValue(sourceNetwork))
	}
	if namespace == "solana" {
		if first.MessagePrehash == nil || isJSONBlank(*first.MessagePrehash) {
			return fail("signed_messages[0].message_prehash is absent")
		}
		if !digestPattern.MatchString(first.Message) {
			return fail("signed_messages[0].message is not 0x + 64 hex")
		}
		return DepositRef{PaymentID: strings.ToLower(first.Message)}, nil
	}

	chainID, err := evmChainID(sourceNetwork)
	if namespace == "tron" {
		chainID, err = tronNumericChainID(sourceNetwork, nil)
	}
	if err != nil {
		return fail("%v", err)
	}
	root, outcome, detail := readPrehash(first.MessagePrehash)
	if outcome != "" {
		return fail("%s", detail)
	}
	var fields permitFields
	if reason := fields.read(root, chainID); reason != "" {
		return fail("message_prehash: %s", reason)
	}
	signature, err := hex.DecodeString(strings.TrimPrefix(first.Signature, "0x"))
	if err != nil {
		return fail("signed_messages[0].signature is not hex")
	}

	var id []byte
	if namespace == "eip155" {
		if !hexAddressPattern.MatchString(depositor) {
			return fail("depositor is not a 0x-prefixed 20-byte hex address")
		}
		id, err = evmencoding.NewEscrowPaymentIdEncoder().Digest(common.HexToAddress(depositor), signature, fields.nonce)
	} else {
		id, err = tvmencoding.NewEscrowPaymentIdEncoder().Digest(depositor, signature, fields.nonce)
	}
	if err != nil {
		return fail("%v", err)
	}
	return DepositRef{PaymentID: "0x" + hex.EncodeToString(id), Reserver: fields.reserver}, nil
}

// readFirstSignedMessage refuses an ambiguous or unreadable sender_auth and reads its message_scheme
// and signed_messages[0] by exact member name. signature must be present; it may be empty.
func readFirstSignedMessage(senderAuth []byte) (string, SignedMessageInput, string) {
	var first SignedMessageInput
	path, err := FirstAmbiguousMember(senderAuth)
	if err != nil {
		return "", first, "sender_auth is not a single valid JSON document"
	}
	if path != "" {
		return "", first, "sender_auth carries two members that differ only in letter case, at " + echo(path)
	}
	root, err := decodeScanned(senderAuth)
	if err != nil {
		return "", first, "sender_auth is not a single valid JSON document"
	}
	auth, ok := root.(map[string]any)
	if !ok {
		return "", first, "sender_auth is not an object"
	}
	scheme, ok := auth["message_scheme"].(string)
	if !ok {
		return "", first, "sender_auth.message_scheme is not a string"
	}
	list, ok := auth["signed_messages"].([]any)
	if !ok || len(list) == 0 {
		return "", first, "sender_auth.signed_messages is not a non-empty array"
	}
	m, ok := list[0].(map[string]any)
	if !ok {
		return "", first, "sender_auth.signed_messages[0] is not an object"
	}
	if first.Message, ok = m["message"].(string); !ok {
		return "", first, "sender_auth.signed_messages[0].message is not a string"
	}
	if first.Signature, ok = m["signature"].(string); !ok {
		return "", first, "sender_auth.signed_messages[0].signature is not a string"
	}
	if v, present := m["message_prehash"]; present && v != nil {
		prehash, ok := v.(string)
		if !ok {
			return "", first, "sender_auth.signed_messages[0].message_prehash is not a string"
		}
		first.MessagePrehash = &prehash
	}
	return scheme, first, ""
}
