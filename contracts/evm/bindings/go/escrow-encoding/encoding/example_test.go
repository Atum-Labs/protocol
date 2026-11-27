package encoding_test

import (
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"

	"github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/encoding"
	contracts "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/generated"
)

// The EIP-712 digest a payer signs to deposit into escrow; the witness commits it to one destination.
func ExampleEscrowDepositEncoder_DigestWithDestination() {
	var (
		permit2 = common.HexToAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3")
		usdc    = common.HexToAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
		escrow  = common.HexToAddress("0x1111111111111111111111111111111111111111")
	)
	witness := contracts.IEscrowDepositWitness{
		DepositRequestHash: [32]byte{0xaa},
		Destination:        "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@0x0000000000000000000000000000000000000002",
		Reserver:           common.HexToAddress("0x2222222222222222222222222222222222222222"),
		Releaser:           common.HexToAddress("0x3333333333333333333333333333333333333333"),
	}
	amount, nonce, deadline, chainID := big.NewInt(1_000_000), big.NewInt(1), big.NewInt(1893456000), big.NewInt(8453)

	enc := encoding.NewEscrowDepositEncoder()
	digest, _, err := enc.DigestWithDestination(permit2, usdc, escrow, witness, amount, nonce, deadline, chainID)
	if err != nil {
		panic(err)
	}

	witness.Destination = "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@0x0000000000000000000000000000000000000003"
	redirected, _, err := enc.DigestWithDestination(permit2, usdc, escrow, witness, amount, nonce, deadline, chainID)
	if err != nil {
		panic(err)
	}
	fmt.Printf("0x%x\n", digest)
	fmt.Println("changes with the destination:", fmt.Sprintf("%x", digest) != fmt.Sprintf("%x", redirected))
	// Output:
	// 0x2efe0ce5dc9b237abbee551a53a9202ce4c13b1242e04092e1ede006ebb29ae1
	// changes with the destination: true
}
