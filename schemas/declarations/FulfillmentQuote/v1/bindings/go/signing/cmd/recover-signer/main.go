// CLI: recover-signer
// Reads a signed FulfillmentQuote from stdin and prints the chain-canonical
// signer identity recovered from the proof. Auto-detects cryptosuite:
//   - EcdsaSecp256k1RecoverySignature2020 → 0x-prefixed lowercase hex EVM address.
//   - Ed25519Signature2020                → base58-encoded ed25519 public key.
//
// Used as the verifier half of the fulfillment-quote signing demo against the
// TypeScript signer. Wraps Verify rather than RecoverSigner so it can
// emit the canonical identity for either cryptosuite without the caller
// needing to know which one was used.
package main

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/mr-tron/base58"

	ldverification "github.com/atum-labs/protocol/schemas/declarations/FulfillmentQuote/v1/bindings/go/signing"
)

func main() {
	input, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error reading stdin: %v\n", err)
		os.Exit(1)
	}
	if len(input) == 0 {
		fmt.Fprintf(os.Stderr, "Usage: cat signed-quote.json | recover-signer\n")
		os.Exit(1)
	}

	res, err := ldverification.Verify(input)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error verifying signed quote: %v\n", err)
		os.Exit(1)
	}

	switch signer := res.Signer.(type) {
	case ldverification.RecoveredSecp256k1Signer:
		fmt.Println("0x" + strings.ToLower(common.Bytes2Hex(signer.Address.Bytes())))
	case ldverification.SelfAssertedEd25519Signer:
		fmt.Println(base58.Encode(signer.PublicKey))
	default:
		fmt.Fprintf(os.Stderr, "Unsupported signer type returned by Verify: %T\n", res.Signer)
		os.Exit(1)
	}
}
