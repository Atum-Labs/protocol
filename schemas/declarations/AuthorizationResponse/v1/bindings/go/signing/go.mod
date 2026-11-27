module github.com/atum-labs/protocol/schemas/declarations/AuthorizationResponse/v1/bindings/go/signing

go 1.25.0

require (
	github.com/atum-labs/protocol/schemas/declarations/AuthorizationResponse/v1/bindings/go v0.2.0
	github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go v0.2.0
	github.com/ethereum/go-ethereum v1.17.5
	github.com/stretchr/testify v1.11.1
)

require (
	github.com/ProjectZKM/Ziren/crates/go-runtime/zkvm_runtime v0.0.0-20251001021608-1fe7b43fc4d6 // indirect
	github.com/davecgh/go-spew v1.1.1 // indirect
	github.com/decred/dcrd/dcrec/secp256k1/v4 v4.0.1 // indirect
	github.com/holiman/uint256 v1.3.2 // indirect
	github.com/mr-tron/base58 v1.3.0 // indirect
	github.com/piprate/json-gold v0.5.0 // indirect
	github.com/pmezard/go-difflib v1.0.0 // indirect
	github.com/pquerna/cachecontrol v0.0.0-20180517163645-1555304b9b35 // indirect
	golang.org/x/sys v0.47.0 // indirect
	gopkg.in/check.v1 v1.0.0-20201130134442-10cb98267c6c // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
)

replace github.com/atum-labs/protocol/schemas/declarations/AuthorizationResponse/v1/bindings/go => ..

replace github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go => ../../../../../common/ld-data-integrity/go
