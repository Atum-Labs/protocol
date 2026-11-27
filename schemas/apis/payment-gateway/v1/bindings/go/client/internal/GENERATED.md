# Generated — do not edit

Every file under `internal/` is copied from the canonical package elsewhere in this repo by
`scripts/flatten.mjs`. Edit the canonical package and re-run the script; `--check` fails CI if
the two disagree.

This exists so the module can be `go get`-ed: it has no `replace` directives and no
dependency on sibling modules that are not separately tagged.

Canonical sources:

- `contracts/evm/bindings/go/escrow-encoding/encoding`
- `contracts/evm/bindings/go/escrow-encoding/generated`
- `contracts/stellar/bindings/go/escrow-encoding/encoding`
- `contracts/svm/bindings/go/escrow-encoding/encoding`
- `contracts/tvm/bindings/go/escrow-encoding/encoding`
- `contracts/tvm/bindings/go/escrow-encoding/generated`
- `schemas/declarations/FulfillmentQuote/v1/bindings/go/generated`
- `schemas/declarations/FulfillmentQuote/v1/bindings/go/signing`
- `schemas/declarations/FulfillmentQuoteEnvelope/v1/bindings/go/generated`
- `schemas/declarations/PaymentRequest/v1/bindings/go/generated`
- `schemas/declarations/PaymentRequest/v1/bindings/go/jsonmembers`
- `schemas/declarations/PaymentRequest/v1/bindings/go/sender-auth/senderauth`
- `schemas/declarations/PaymentRequest/v1/bindings/go/signing`
- `schemas/declarations/PaymentRequestEnvelope/v1/bindings/go`
- `schemas/declarations/PaymentRequestEnvelope/v1/bindings/go/signing`
- `schemas/declarations/common/ld-data-integrity/go`
