module github.com/atum-labs/protocol/schemas/declarations/PaymentRequestEnvelope/v1/bindings/go/signing

go 1.25.0

require (
	github.com/atum-labs/protocol/schemas/declarations/FulfillmentQuote/v1/bindings/go/signing v0.2.0
	github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go/signing v0.2.0
	github.com/atum-labs/protocol/schemas/declarations/PaymentRequestEnvelope/v1/bindings/go v0.2.0
	github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go v0.2.0
	github.com/ethereum/go-ethereum v1.17.5
	github.com/stretchr/testify v1.12.1
)

require (
	github.com/ProjectZKM/Ziren/crates/go-runtime/zkvm_runtime v0.0.0-20251001021608-1fe7b43fc4d6 // indirect
	github.com/atum-labs/protocol/contracts/stellar/bindings/go/escrow-encoding v0.1.0 // indirect
	github.com/atum-labs/protocol/schemas/declarations/FulfillmentQuote/v1/bindings/go v0.2.0 // indirect
	github.com/atum-labs/protocol/schemas/declarations/FulfillmentQuoteEnvelope/v1/bindings/go v0.2.0 // indirect
	github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go v0.2.0 // indirect
	github.com/decred/dcrd/dcrec/secp256k1/v4 v4.4.0 // indirect
	github.com/holiman/uint256 v1.3.2 // indirect
	github.com/mr-tron/base58 v1.3.0 // indirect
	github.com/piprate/json-gold v0.6.0 // indirect
	github.com/pquerna/cachecontrol v0.0.0-20180517163645-1555304b9b35 // indirect
	go.yaml.in/yaml/v3 v3.0.5 // indirect
	golang.org/x/crypto v0.55.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
)

replace github.com/atum-labs/protocol/schemas/declarations/PaymentRequestEnvelope/v1/bindings/go => ..

replace github.com/atum-labs/protocol/schemas/declarations/FulfillmentQuote/v1/bindings/go/signing => ../../../../../FulfillmentQuote/v1/bindings/go/signing

replace github.com/atum-labs/protocol/schemas/declarations/FulfillmentQuote/v1/bindings/go => ../../../../../FulfillmentQuote/v1/bindings/go

replace github.com/atum-labs/protocol/schemas/declarations/FulfillmentQuoteEnvelope/v1/bindings/go => ../../../../../FulfillmentQuoteEnvelope/v1/bindings/go

replace github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go/signing => ../../../../../PaymentRequest/v1/bindings/go/signing

replace github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go => ../../../../../PaymentRequest/v1/bindings/go

replace github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go => ../../../../../common/ld-data-integrity/go

replace github.com/atum-labs/protocol/contracts/stellar/bindings/go/escrow-encoding => ../../../../../../../contracts/stellar/bindings/go/escrow-encoding
