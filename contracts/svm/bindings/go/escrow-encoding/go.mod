module github.com/atum-labs/protocol/contracts/svm/bindings/go/escrow-encoding

go 1.25.0

replace github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go => ../../../../../schemas/declarations/PaymentRequest/v1/bindings/go

require (
	github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go v0.2.0
	github.com/mr-tron/base58 v1.2.0
	github.com/stretchr/testify v1.9.0
	golang.org/x/crypto v0.55.0
)

require (
	github.com/davecgh/go-spew v1.1.1 // indirect
	github.com/pmezard/go-difflib v1.0.0 // indirect
	github.com/xeipuuv/gojsonpointer v0.0.0-20180127040702-4e3ac2762d5f // indirect
	github.com/xeipuuv/gojsonreference v0.0.0-20180127040603-bd5ef7bd5415 // indirect
	github.com/xeipuuv/gojsonschema v1.2.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
)
