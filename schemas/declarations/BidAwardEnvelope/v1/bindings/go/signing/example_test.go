package awardhash_test

import (
	"fmt"

	awardhash "github.com/atum-labs/protocol/schemas/declarations/BidAwardEnvelope/v1/bindings/go/signing"
)

// The award hash binds an award-authority signature to one payment, quote and settler, so it cannot be replayed.
func ExampleComputeAwardHash() {
	const (
		paymentID = "0x1111111111111111111111111111111111111111111111111111111111111111"
		quoteHash = "0x2222222222222222222222222222222222222222222222222222222222222222"
	)
	awarded, err := awardhash.ComputeAwardHash(paymentID, quoteHash, "settler-a")
	if err != nil {
		panic(err)
	}
	other, err := awardhash.ComputeAwardHash(paymentID, quoteHash, "settler-b")
	if err != nil {
		panic(err)
	}
	fmt.Println(awarded)
	fmt.Println("differs for another settler:", awarded != other)
	// Output:
	// 0x8082326c2d038a6b882dc712000a8cd2f5fc8077d3d6337f99234ba3aff16512
	// differs for another settler: true
}
