// Command gen-simple-fold writes the TypeScript simple-folding table. Run from the module root:
//
//	go run ./cmd/gen-simple-fold
package main

import (
	"log"
	"os"

	"github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go/sender-auth/internal/simplefold"
)

func main() {
	if err := os.WriteFile(simplefold.TypeScriptFile, []byte(simplefold.TypeScript()), 0o644); err != nil {
		log.Fatal(err)
	}
}
