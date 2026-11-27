package encoding_test

import (
	"fmt"
	"math/big"

	"github.com/atum-labs/protocol/contracts/tvm/bindings/go/escrow-encoding/encoding"
)

// Tron addresses arrive base58 or hex; TVMAddress strips the 0x41 marker to the 20 bytes TIP-712 hashes.
func ExampleTVMAddress() {
	for _, spelling := range []string{
		"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
		"41a614f803b6fd780986a42c78ec9c7f77e6ded13c",
	} {
		addr, err := encoding.TVMAddress(spelling)
		if err != nil {
			panic(err)
		}
		fmt.Println(addr.Hex())
	}
	// Output:
	// 0xa614f803B6FD780986A42c78Ec9c7f77e6DeD13C
	// 0xa614f803B6FD780986A42c78Ec9c7f77e6DeD13C
}

// Tron's chain id is its 256-bit genesis block id; contracts hash the low 32 bits, so signers must mask too.
func ExampleMaskTronChainIdBig() {
	genesis, _ := new(big.Int).SetString("00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc", 16)
	fmt.Println(encoding.MaskTronChainIdBig(genesis))
	// Output:
	// 728126428
}
