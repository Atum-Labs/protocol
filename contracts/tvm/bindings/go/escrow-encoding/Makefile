.PHONY: test build lint generate check-generate

test:
	go test -v -count=1 ./...

build:
	go build ./...

lint:
	go mod tidy
	git diff --exit-code -- go.mod go.sum
	golangci-lint run

# Regenerate the Go contract bindings from the vendored ABIs (abigen, go-ethereum).
# Pinned to the go-ethereum version in go.mod. A different abigen reformats every file, which buries
# the real diff — do not fall back to a PATH abigen.
ABIGEN ?= go run github.com/ethereum/go-ethereum/cmd/abigen@v1.15.6
ABI_DIR := ../../../source/generated/abi
GEN_DIR := generated

# INTERFACES ONLY, deliberately. Generating the concrete Escrow/FulfillmentProxy ABIs as well emits a
# second copy of every shared struct (IEscrowDepositInput, IEscrowReleaseWitness, ...) into the same
# package and the build fails with "redeclared in this block". The previous version of this target
# looped over ALL of $(ABI_DIR)/*.json and so could not be run at all -- which is why these bindings
# silently drifted several releases behind the vendored source.
#
# The ABI dir also carries ITIP712 (the TVM EIP-712 base's interface, no bindings needed) and a stale
# Atum.json that `make generate-abi` in ../../source no longer emits; both are excluded for the same
# reason -- nothing in this module binds them. TIP712.json used to sit there too and was dropped in
# CORE-1866: its contract name collides with permit2-tron's, so tronbox's name-keyed build/contracts/
# emitted whichever compiled last and `make check-abi` could not be run in CI. See the comment on
# ABI_SOURCES in ../../source/Makefile.
GEN_TYPES := IERC20 IEscrow IFulfillmentProxy ITokenConfig SignatureVerification

generate:
	@set -e; for name in $(GEN_TYPES); do \
		echo "  abigen $$name"; \
		$(ABIGEN) --abi "$(ABI_DIR)/$$name.json" --pkg contracts --type "$$name" --out "$(GEN_DIR)/$$name.go"; \
	done
	@gofmt -w $(GEN_DIR)
	@echo "Regenerated. If an event shape changed, TestEventTopic0Stability fails -- update every"
	@echo "off-chain decoder of the changed event BEFORE reseeding the golden with"
	@echo "UPDATE_TOPIC0_GOLDEN=1."

# Fail if the committed bindings are not exactly what `generate` produces from the committed ABIs:
# a hand-edit, a stale binding after an ABI change, or a GEN_TYPES entry with no committed file.
# CI runs this; the ABIs themselves are anchored to the Solidity by `make -C ../../source check-abi`.
check-generate: generate
	@set -e; drift=$$(git status --porcelain -- $(GEN_DIR)); \
	if [ -n "$$drift" ]; then \
		echo "ERROR: the committed bindings in $(GEN_DIR)/ do not match the ABIs in $(ABI_DIR)."; \
		git status --porcelain -- $(GEN_DIR); \
		git --no-pager diff --stat -- $(GEN_DIR); \
		echo "Run 'make generate' here and commit the result."; \
		exit 1; \
	fi
	@echo "OK: bindings in $(GEN_DIR)/ match $(ABI_DIR)."
