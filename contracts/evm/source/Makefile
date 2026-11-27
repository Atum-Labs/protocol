.PHONY: deps build test test-invariants test-all test-token-forks format bench-batching test-gas-snapshot test-gas-snapshot-invariants test-gas-snapshot-all generate-abi check-abi

all: deps build test format

# install contract dependencies
deps:
	@echo "Installing contract dependencies..."
	@pnpm install
	@echo "Contract dependencies installed successfully"

# build contracts using forge
build: deps
	@echo "Building contracts with forge..."
	@forge build --sizes
	@echo "Contracts built successfully"
	@echo "Generating ABIs..."
	@$(MAKE) generate-abi
	@echo "ABIs generated successfully"

# test contracts using forge (excludes invariant tests)
test:
	@echo "Running contract tests with forge (excluding invariants)..."
	@forge test -vvv --no-match-contract "Invariant"
	@echo "Contract tests completed"

# test invariant tests only
test-invariants:
	@echo "Running invariant tests with forge..."
	@forge test -vvv --match-contract "Invariant"
	@echo "Invariant tests completed"

# test all contracts including invariants
test-all:
	@echo "Running all contract tests with forge (including invariants)..."
	@forge test -vvv
	@echo "All contract tests completed"

# run fork tests for all token configs
test-token-forks:
	@echo "Running fork tests for all configs..."
	@for config in test/fork/*.json; do \
		echo ""; \
		echo "========================================"; \
		echo "Testing with config: $$config"; \
		echo "========================================"; \
		FORK_CONFIG="$$config" forge test --match-contract EscrowDeposit || exit 1; \
	done
	@echo ""
	@echo "All fork tests completed successfully!"

test-gas-snapshot:
	@echo "Running contract tests with forge (excluding invariants)..."
	@forge test -vvv --gas-snapshot-check=true --no-match-contract "Invariant"
	@echo "Contract tests completed"

test-gas-snapshot-invariants:
	@echo "Running invariant tests with gas snapshot check..."
	@forge test -vvv --gas-snapshot-check=true --match-contract "Invariant"
	@echo "Invariant tests with gas snapshot completed"

test-gas-snapshot-all:
	@echo "Running all tests with gas snapshot check..."
	@forge test -vvv --gas-snapshot-check=true
	@echo "All tests with gas snapshot completed"

# batching vs separate transactions, each call its own transaction (see test/bench/BatchingGas.t.sol).
# Writes snapshots/BatchingGasBench.json; with FORK_CONFIG + BENCH_FULFILLMENT_PROXY it measures the
# deployed escrow and proxy against a real token and only logs. pipefail keeps forge's exit status:
# without it the target exits with grep's, which is 0 whenever a [FAIL line matches. (bash -c rather
# than SHELL/.SHELLFLAGS, which the GNU Make 3.81 that macOS ships ignores.)
bench-batching:
	@bash -c 'set -o pipefail; forge test --isolate --match-contract "^BatchingGasBench$$" -vv | grep -E "BENCH|CALLDATA|PASS|FAIL|SKIP|Error"'

# format contracts using forge
format:
	@echo "Formatting contracts with forge..."
	@forge fmt
	@echo "Contract formatting completed"


# generate contract ABIs
generate-abi:
	@echo "Building contracts to generate ABIs..."
	@forge build --extra-output-files abi
	# Build SignatureVerification separately to avoid issues
	@forge build lib/permit2/src/libraries/SignatureVerification.sol --extra-output-files abi
	@echo "Creating ABI directory..."
	@mkdir -p generated/abi
	@echo "Extracting ABIs..."
	@jq '.abi' out/Escrow.sol/Escrow.json > generated/abi/Escrow.json
	@jq '.abi' out/FulfillmentProxy.sol/FulfillmentProxy.json > generated/abi/FulfillmentProxy.json
	@jq '.abi' out/ITokenConfig.sol/ITokenConfig.json > generated/abi/ITokenConfig.json
	@jq '.abi' out/IEscrow.sol/IEscrow.json > generated/abi/IEscrow.json
	@jq '.abi' out/IFulfillmentProxy.sol/IFulfillmentProxy.json > generated/abi/IFulfillmentProxy.json
	@jq '.abi' out/IERC20.sol/IERC20.json > generated/abi/IERC20.json
	@jq '.abi' out/SignatureVerification.sol/SignatureVerification.json > generated/abi/SignatureVerification.json
	@echo "✅ ABIs generated in ./generated/abi/"

# check if ABIs are up to date
check-abi: generate-abi
	@echo "Checking if ABIs are up to date..."
	@if [ -n "$$(git status --porcelain generated/abi/)" ]; then \
		echo "❌ ABIs are out of date!"; \
		echo "The following files have changed:"; \
		git status --porcelain generated/abi/; \
		echo ""; \
		echo "Diff of changes:"; \
		git diff generated/abi/; \
		echo ""; \
		echo "Please run 'make generate-abi' to update the ABIs."; \
		echo "Then commit the changes."; \
		exit 1; \
	else \
		echo "✅ ABIs are up to date!"; \
	fi

