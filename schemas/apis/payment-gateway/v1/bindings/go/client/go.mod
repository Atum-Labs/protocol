module github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client

go 1.25.0

// This module is self-contained: no replace directives, and no dependency on sibling modules
// that carry no tags. `go get github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client` works.
//
// The packages it needs live under internal/, copied from their canonical locations in this repo
// by scripts/flatten.mjs. They are GENERATED — edit the canonical package and re-run the script.
// `node scripts/flatten.mjs --check` fails if the two have drifted, which is what keeps a copy
// from quietly diverging the way three copies of a JSON-LD context once did.

require (
	github.com/ethereum/go-ethereum v1.17.5
	github.com/fbsobreira/gotron-sdk v0.24.1
	github.com/mr-tron/base58 v1.3.0
	github.com/piprate/json-gold v0.6.0
	github.com/stretchr/testify v1.11.1
	golang.org/x/crypto v0.55.0
)

require (
	github.com/Microsoft/go-winio v0.6.2 // indirect
	github.com/ProjectZKM/Ziren/crates/go-runtime/zkvm_runtime v0.0.0-20251001021608-1fe7b43fc4d6 // indirect
	github.com/StackExchange/wmi v1.2.1 // indirect
	github.com/bits-and-blooms/bitset v1.20.0 // indirect
	github.com/btcsuite/btcd/btcec/v2 v2.3.4 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/consensys/gnark-crypto v0.18.1 // indirect
	github.com/crate-crypto/go-eth-kzg v1.5.0 // indirect
	github.com/davecgh/go-spew v1.1.1 // indirect
	github.com/deckarep/golang-set/v2 v2.6.0 // indirect
	github.com/decred/dcrd/dcrec/secp256k1/v4 v4.4.0 // indirect
	github.com/ethereum/c-kzg-4844/v2 v2.1.8 // indirect
	github.com/fjl/jsonw v0.1.0 // indirect
	github.com/fsnotify/fsnotify v1.6.0 // indirect
	github.com/go-logr/logr v1.4.3 // indirect
	github.com/go-logr/stdr v1.2.2 // indirect
	github.com/go-ole/go-ole v1.3.0 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/gorilla/websocket v1.5.3 // indirect
	github.com/holiman/uint256 v1.3.2 // indirect
	github.com/pmezard/go-difflib v1.0.0 // indirect
	github.com/pquerna/cachecontrol v0.0.0-20180517163645-1555304b9b35 // indirect
	github.com/shengdoushi/base58 v1.0.0 // indirect
	github.com/shirou/gopsutil v3.21.4-0.20210419000835-c7a38de76ee5+incompatible // indirect
	github.com/supranational/blst v0.3.16 // indirect
	github.com/tklauser/go-sysconf v0.3.12 // indirect
	github.com/tklauser/numcpus v0.6.1 // indirect
	go.opentelemetry.io/auto/sdk v1.2.1 // indirect
	go.opentelemetry.io/otel v1.41.0 // indirect
	go.opentelemetry.io/otel/metric v1.41.0 // indirect
	go.opentelemetry.io/otel/trace v1.41.0 // indirect
	golang.org/x/sync v0.19.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
)
