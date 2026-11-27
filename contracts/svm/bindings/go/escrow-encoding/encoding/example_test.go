package svm_escrow_encoding_test

import (
	"bytes"
	"fmt"

	encoding "github.com/atum-labs/protocol/contracts/svm/bindings/go/escrow-encoding/encoding"
)

func key(b byte) encoding.Pubkey { return encoding.MustPubkeyFromBytes(bytes.Repeat([]byte{b}, 32)) }

// The deposit hash a payer signs on Solana; it is also the deposit's PDA seed, and it commits to the destination.
func ExampleComputeDepositHashV2() {
	params := encoding.EscrowDepositParams{
		DepositRequestHash: [32]byte{0xaa},
		Depositor:          key(1),
		Mint:               encoding.MustPubkeyFromBase58("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
		Amount:             1_000_000,
		Reserver:           key(2),
		Releaser:           key(3),
		Nonce:              1,
		IssuedAt:           1767225600,
		Deadline:           encoding.ComputeDeadline(1767225600),
	}
	domain := encoding.EscrowDomain{ClusterID: [32]byte{0x01}, SignatureDomainVersion: 4, ProgramID: key(9)}

	hash, err := encoding.ComputeDepositHashV2(params, "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@0x0000000000000000000000000000000000000002", domain)
	if err != nil {
		panic(err)
	}
	redirected, err := encoding.ComputeDepositHashV2(params, "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@0x0000000000000000000000000000000000000003", domain)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%x\n", hash)
	fmt.Println("changes with the destination:", hash != redirected)
	// Output:
	// bae1b3717baaae7aa2a2ce6767e108185ce9e75401aacb3135271318b99480c0
	// changes with the destination: true
}
