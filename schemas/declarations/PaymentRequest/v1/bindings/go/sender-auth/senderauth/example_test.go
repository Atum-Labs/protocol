package senderauth_test

import (
	"fmt"

	"github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go/sender-auth/senderauth"
)

// Deriving request_id from the intent makes a rebuilt payment resolve to the original instead of a duplicate.
func ExampleDeterministicRequestID() {
	const payer = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
	first, err := senderauth.DeterministicRequestID("order-42", payer, "shop")
	if err != nil {
		panic(err)
	}
	retry, err := senderauth.DeterministicRequestID("order-42", payer, "shop")
	if err != nil {
		panic(err)
	}
	fmt.Println(first)
	fmt.Println("same on retry:", first == retry)
	// Output:
	// shop64fb6736ec0dc978a3702326
	// same on retry: true
}

// The escrow stores only the hash of this string, so it is canonicalized (lowercased) for every producer.
func ExampleBuildEscrowDestination() {
	dest, err := senderauth.BuildEscrowDestination(
		"eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
		"0x0000000000000000000000000000000000000002",
	)
	if err != nil {
		panic(err)
	}
	fmt.Println(dest)
	// Output:
	// eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@0x0000000000000000000000000000000000000002
}
