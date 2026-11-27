package paymentrequest

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
)

// eip3009TokensJSON is a copy of ../../eip3009-tokens.json, embedded so the list ships with
// this module. make generate-go-bindings refreshes the copy and check-go-bindings guards it.
//
//go:embed eip3009_tokens.json
var eip3009TokensJSON []byte

// EIP3009Token is one token that implements EIP-3009 transferWithAuthorization.
type EIP3009Token struct {
	Symbol  string `json:"symbol"`
	Address string `json:"address"`
}

// eip3009Tokens is keyed by CAIP-2 chain ID. It is decoded at init so a malformed list fails
// every consumer at startup rather than reading as "no token qualifies".
var eip3009Tokens = mustDecodeEIP3009Tokens(eip3009TokensJSON)

func mustDecodeEIP3009Tokens(raw []byte) map[string][]EIP3009Token {
	var doc struct {
		Chains map[string][]EIP3009Token `json:"chains"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		panic(fmt.Sprintf("paymentrequest: decode eip3009_tokens.json: %v", err))
	}
	return doc.Chains
}

// EIP3009Tokens returns the tokens that implement EIP-3009, keyed by CAIP-2 chain ID. The
// result is a copy; callers may modify it.
func EIP3009Tokens() map[string][]EIP3009Token {
	out := make(map[string][]EIP3009Token, len(eip3009Tokens))
	for chain, tokens := range eip3009Tokens {
		out[chain] = append([]EIP3009Token(nil), tokens...)
	}
	return out
}

// SupportsEIP3009 reports whether the token at address on the CAIP-2 chain implements EIP-3009
// transferWithAuthorization, which an originator-fulfilled payment needs on its destination.
// EVM addresses compare case-insensitively.
func SupportsEIP3009(chain, address string) bool {
	for _, token := range eip3009Tokens[chain] {
		if strings.EqualFold(token.Address, address) {
			return true
		}
	}
	return false
}

// FulfillsAsOriginator reports whether a PaymentRequest executor value assigns the fulfill leg
// to the originator. It accepts the decoded JSON value: the string form applies to every leg,
// the object form names fulfill on its own. Absent (nil) means settler.
func FulfillsAsOriginator(executor any) bool {
	return legIsOriginator(executor, "fulfill")
}

// DepositsAsOriginator reports whether a PaymentRequest executor value assigns the deposit leg
// to the originator: the payer funds the escrow itself with directDeposit. It accepts the
// decoded JSON value: the string form applies to every leg, the object form names deposit on
// its own. Absent (nil) means settler.
func DepositsAsOriginator(executor any) bool {
	return legIsOriginator(executor, "deposit")
}

// legIsOriginator reports whether the executor value assigns leg to the originator.
func legIsOriginator(executor any, leg string) bool {
	switch v := executor.(type) {
	case string:
		return v == "originator"
	case map[string]any:
		value, _ := v[leg].(string)
		return value == "originator"
	}
	return false
}
