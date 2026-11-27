.PHONY: install-tronbox build-tronbox tron-node-up tron-node-down migrate-tronbox test-tronbox install-foundry build-foundry test-foundry test-foundry-gas-snapshot generate-abi check-abi verify-manual-escrow verify-manual-proxy

# foundry_tests/helpers/LocalPermit2.sol etches Permit2's runtime bytecode at its
# CANONICAL address and then require()s that PERMIT2_ADDRESS equals that address
# (LocalPermit2.sol:39,57-62). For the forge suites the variable therefore has
# exactly ONE legal value: it is friction, not configuration.
#
# It lived only in .env, which is gitignored, and in CI as vars.PERMIT2_ADDRESS.
# So CI was green while a fresh clone failed 10 of 12 suites in setUp() with
#   [FAIL: vm.envAddress: environment variable "PERMIT2_ADDRESS" not found]
# an error naming neither .env nor .env.example. The two suites that passed
# (Destination.canonicalExamples, Escrow.declarationOrder) are the two that never
# construct an Escrow, which made it look selective rather than environmental.
#
# Defaulted here for the TEST targets only, and an existing value still wins.
# Deploy targets must NOT inherit it: Permit2 on Tron is a different address
# entirely (mainnet TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m), and foundry_scripts/
# DeployCoreContracts.s.sol reads the same variable name for real deployments.
CANONICAL_PERMIT2 := 0x000000000022D473030F116dDEE9F6B43aC78BA3

# SALT has the same shape of problem and needed the same treatment, but for a
# different reason. Eight of the suites construct their contracts through
# foundry_scripts/DeployCoreContracts.s.sol, which reads vm.envBytes32("SALT")
# to CREATE2 the pair -- so the tests inherit a real DEPLOYMENT parameter purely
# as a side effect of reusing the deploy script. CI passes vars.SALT; a fresh
# clone got "environment variable SALT not found" and, unlike PERMIT2_ADDRESS,
# SALT is not in .env.example either -- so `cp .env.example .env` fixes two of
# the ten suites and leaves eight failing on a second, different name.
#
# No test asserts a deployed address and the value only feeds `new X{salt: ...}`,
# so for the suites any bytes32 does. The default below is deliberately NOT a
# plausible deployment salt: it must never be copied into one. The real EVM salt
# is a separate, still-unsettled decision (there are two competing candidates),
# and the deploy scripts pin their expected CREATE2 addresses precisely so a
# wrong salt fails loudly rather than deploying somewhere unexpected.
#
# Nothing in this Makefile deploys -- there are zero `forge script` invocations --
# so this default cannot reach a real deployment from here.
TEST_ONLY_SALT := 0x00000000000000000000000000000000000000000000000000000000deadbeef

# start local TRON node using docker
tron-node-up:
	@echo "Starting local TRON node..."
	@docker compose --profile tron up -d tron-local
	@echo "Waiting for TRON node to be ready..."
	./scripts/wait-for-tron.sh
	@echo "TRON node is running on http://localhost:9090"

# stop local TRON node
tron-node-down:
	@echo "Stopping local TRON node..."
	@docker compose --profile tron stop tron-local
	@docker compose --profile tron rm -f tron-local
	@echo "TRON node stopped"

# install contract dependencies
install-tronbox:
	@echo "Installing contract dependencies..."
	@pnpm install
	@echo "Contract dependencies installed successfully"

# build contracts using tronbox
build-tronbox:
	@echo "Building contracts with tronbox..."
	@pnpm run compile
	@echo "Contracts built successfully"

# deploy contracts to local TRON node
migrate-tronbox: tron-node-up
	@echo "Deploying contracts to local TRON node..."
	pnpm run migrate:development
	@echo "Contracts deployed successfully"

# run TVM contract tests (starts node, deploys, runs tests, stops node)
test-tronbox: install-tronbox build-tronbox
	@echo "Running TVM contract tests..."
	@$(MAKE) tron-node-down || true
	@$(MAKE) tron-node-up
	@echo "Running tests (with deployment)..."
	@pnpm run test:tronbox || (EXITCODE=$$?; $(MAKE) tron-node-down; exit $$EXITCODE)
	@$(MAKE) tron-node-down
	@echo "TVM contract tests completed"

install-foundry:
	@echo "Installing foundry..."
	@forge install
	@echo "Foundry installed successfully"

build-foundry:
	@echo "Building foundry..."
	@forge build
	@echo "Foundry built successfully"

test-foundry: install-foundry build-foundry
	@echo "Running foundry tests..."
	@PERMIT2_ADDRESS="$${PERMIT2_ADDRESS:-$(CANONICAL_PERMIT2)}" SALT="$${SALT:-$(TEST_ONLY_SALT)}" forge test -vvv
	@echo "Foundry tests completed"

test-foundry-gas-snapshot: install-foundry build-foundry
	@echo "Running foundry tests with gas snapshot..."
	@PERMIT2_ADDRESS="$${PERMIT2_ADDRESS:-$(CANONICAL_PERMIT2)}" SALT="$${SALT:-$(TEST_ONLY_SALT)}" forge test -vvv --gas-snapshot-check=true
	@echo "Foundry tests completed"

# generated/abi is a COMMITTED artifact and the ORACLE for the Go guards next door: both
# TestEventTopic0Stability and TestGeneratedBindingsMatchSourceABI in
# ../bindings/go/escrow-encoding/encoding/event_topic0_test.go read ../../../source/generated/abi/*.json rather than
# the bindings they police. So `check-abi` has to be reproducible enough to run in CI, or that whole
# chain (Solidity -> ABI -> bindings -> topic0 golden) has no CI-side anchor and can go stale in lockstep
# while every guard stays green.
#
# It was NOT reproducible. tronbox keys build/contracts/ by CONTRACT NAME, and contract names are not
# unique across the dependency graph:
#
#   contracts/TIP712.sol                                     constructor(string name, string version)
#   node_modules/@alexroan/permit2-tron/contracts/TIP712.sol  no-arg constructor
#
# Two different contracts, one artifact path, last writer wins -- and which one writes last depends on the
# SET tronbox recompiles. A cold build compiles the whole graph and permit2's lands last; an incremental
# build recompiles only the Escrow closure and ours lands last. Same inputs, two different committed ABIs,
# so `check-abi` failed or passed on build state alone. It is not hypothetical: commit 3b8a332
# flipped this file from the (string,string) constructor to the no-arg one as incidental noise, with no
# change to either TIP712.sol. This is the TIP712 name-collision failure mode.
#
# Fix: TIP712 is no longer emitted. Nothing binds or loads it -- ../bindings/go/escrow-encoding/Makefile pins an
# explicit GEN_TYPES list that excludes it, scripts/config.js loads only Escrow/FulfillmentProxy/IERC20,
# and the two topic0 guards read only IEscrow/IFulfillmentProxy. No information is lost: Escrow.json
# already carries DOMAIN_SEPARATOR() through inheritance, and contracts/TIP712.sol remains the source of
# truth for the escrow's TIP-712 domain -- ../bindings/go/escrow-encoding/encoding/v2_domain_test.go pins
# TIP712("Escrow", "3") by scanning the .sol, never the ABI.
#
# ABI_SOURCES pins where every ABI we DO emit must have been compiled from, so the next name collision
# fails loudly here instead of silently swapping an ABI under a green build. Our own contracts are matched
# by path suffix and rejected if they resolve into node_modules; the three deliberately vendored ones are
# matched against their exact remapped module path.
ABI_SOURCES := \
	Escrow:/contracts/Escrow.sol \
	FulfillmentProxy:/contracts/FulfillmentProxy.sol \
	IEscrow:/contracts/interfaces/IEscrow.sol \
	IFulfillmentProxy:/contracts/interfaces/IFulfillmentProxy.sol \
	ITokenConfig:/contracts/interfaces/ITokenConfig.sol \
	IERC20:@openzeppelin/contracts/token/ERC20/IERC20.sol \
	ITIP712:@alexroan/permit2-tron/contracts/interfaces/ITIP712.sol \
	SignatureVerification:@alexroan/permit2-tron/contracts/libraries/SignatureVerification.sol

# generate contract ABIs
#
# Two passes on purpose: verify every artifact's origin FIRST, write only once all of them check out. A
# single interleaved pass would leave generated/abi half-regenerated when the guard trips, and since the
# directory is committed that turns one clear error into a confusing diff.
generate-abi: build-tronbox
	@echo "Verifying tronbox artifacts came from the expected sources..."
	@set -e; for pair in $(ABI_SOURCES); do \
		name=$${pair%%:*}; want=$${pair#*:}; art="build/contracts/$$name.json"; \
		if [ ! -f "$$art" ]; then \
			echo "ERROR: $$art is missing -- tronbox did not compile $$name"; exit 1; \
		fi; \
		got=$$(jq -r '.sourcePath' "$$art"); \
		case "$$got" in \
			*"$$want") ;; \
			*) echo "ERROR: $$name.json was compiled from $$got, expected a path ending in $$want."; \
			   echo "   Some contract in the dependency graph is now also named $$name. tronbox keys"; \
			   echo "   build/contracts/ by contract name, so the two overwrite each other and the"; \
			   echo "   emitted ABI depends on compile order. See the TIP712 name-collision note above."; \
			   exit 1;; \
		esac; \
		case "$$want" in /*) case "$$got" in \
			*node_modules*) echo "ERROR: $$name.json resolved into node_modules ($$got), not this repo."; exit 1;; \
		esac;; esac; \
	done
	@echo "Creating ABI directory..."
	@mkdir -p generated/abi
	@echo "Extracting ABIs from tronbox build artifacts..."
	@set -e; for pair in $(ABI_SOURCES); do \
		name=$${pair%%:*}; \
		jq '.abi' "build/contracts/$$name.json" > "generated/abi/$$name.json"; \
	done
	@echo "OK: ABIs generated in ./generated/abi/"

# check if ABIs are up to date
check-abi: generate-abi
	@echo "Checking if ABIs are up to date..."
	@if [ -n "$$(git status --porcelain generated/abi/)" ]; then \
		echo "ERROR: ABIs are out of date!"; \
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
		echo "OK: ABIs are up to date!"; \
	fi

# manually verify Escrow contract bytecode matches on-chain deployment
verify-manual-escrow:
	@if [ -z "$(NETWORK)" ] || [ -z "$(ADDRESS)" ]; then \
		echo "ERROR: Error: NETWORK and ADDRESS are required"; \
		echo "Usage: make verify-manual-escrow NETWORK=<mainnet|shasta|nile> ADDRESS=<contract-address>"; \
		echo "Example: make verify-manual-escrow NETWORK=mainnet ADDRESS=TYourEscrowAddress"; \
		exit 1; \
	fi
	@node scripts/verify-contract.js Escrow $(NETWORK) $(ADDRESS)

# manually verify FulfillmentProxy contract bytecode matches on-chain deployment
verify-manual-proxy:
	@if [ -z "$(NETWORK)" ] || [ -z "$(ADDRESS)" ]; then \
		echo "ERROR: Error: NETWORK and ADDRESS are required"; \
		echo "Usage: make verify-manual-proxy NETWORK=<mainnet|shasta|nile> ADDRESS=<contract-address>"; \
		echo "Example: make verify-manual-proxy NETWORK=mainnet ADDRESS=TYourProxyAddress"; \
		exit 1; \
	fi
	@node scripts/verify-contract.js FulfillmentProxy $(NETWORK) $(ADDRESS)