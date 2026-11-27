
.PHONY: breaking-openapi breaking-auth-session test-payment-gateway-go-module
.PHONY: test-maintained-go-modules test-veri-fill-go-module
.PHONY: build check-api-bindings check-canonical-shapes generate-canonical-shapes check-conformance-fixtures check-decline-catalog check-error-catalog check-error-code-examples check-go-bindings check-hosts check-host-literals check-ld-verification-drift check-openapi-ts-clients check-pgc-openapi-client check-proto check-shared-error-shape check-tools check-ts-bindings check-veri-fill-openapi-client clean deps format generate-hosts test-hosts test-pgc-openapi-client-guard generate-go-bindings generate-proto lint lint-json lint-proto test-shared-error-shape validate-examples validate-jsonld verify-version

# Build the schema validator
bin/schema-validator: schema-validator.go
	@echo "Building schema validator..."
	@mkdir -p bin
	@go build -o bin/schema-validator schema-validator.go
	@echo "✅ Schema validator built"

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	@rm -rf bin/
	@echo "✅ Build artifacts cleaned"

# Install required dependencies
deps:
	@echo "Installing schema dependencies..."
	@echo "Installing gojq..."
	@go install github.com/itchyny/gojq/cmd/gojq@v0.12.17
	@echo "Installing go-jsonschema..."
	@go install github.com/atombender/go-jsonschema@v0.20.0
	@cd declarations && pnpm install
	@$(MAKE) -C apis deps
	@echo "✅ Schema dependencies installed"

# Check if required schema tools are installed
check-tools:
	@echo "Checking schema tools..."
	@which gojq > /dev/null || (echo "✗ gojq tool not found. Please install: go install github.com/itchyny/gojq/cmd/gojq@v0.12.17" && exit 1)
	@which go-jsonschema > /dev/null || (echo "✗ go-jsonschema tool not found. Please install: go install github.com/atombender/go-jsonschema@v0.20.0" && exit 1)
	@echo "✅ Schema tools found"

# Lint JSON Schema files using built validator
lint-json: bin/schema-validator
	@echo "Linting JSON Schema files..."
	@if find . -name "*.json" -type f | grep -q .; then \
		./bin/schema-validator .; \
	else \
		echo "No JSON files found, skipping JSON linting"; \
	fi

# Validate JSON-LD files using built validator
validate-jsonld: bin/schema-validator
	@echo "Validating JSON-LD files..."
	@if find . -name "*.jsonld" -type f | grep -q .; then \
		for file in $$(find . -name "*.jsonld" -type f); do \
			echo "Validating $$file"; \
			./bin/schema-validator "$$file" || (echo "✗ JSON-LD validation failed for $$file" && exit 1); \
		done; \
		echo "✅ JSON-LD files validated"; \
	else \
		echo "No JSON-LD files found, skipping JSON-LD validation"; \
	fi

# Validate JSON-LD context sync with schemas
validate-context-sync: bin/schema-validator
	@echo "Validating JSON-LD context sync with schemas..."
	@./bin/schema-validator --context-sync .
	@echo "✅ All JSON-LD contexts are in sync with schemas"

# Main lint target - runs all schema validation
lint: deps bin/schema-validator lint-json validate-jsonld validate-context-sync validate-examples check-canonical-shapes check-go-bindings check-ts-bindings check-openapi-ts-clients test-pgc-openapi-client-guard check-hosts test-hosts check-host-literals check-conformance-fixtures test-shared-error-shape check-shared-error-shape check-error-code-examples breaking-openapi breaking-auth-session lint-apis lint-ld-verification verify-version
	@echo "✅ All schema files validated"

# Main format target - formats all schema files
format:
	@echo "Nothing to format"

# Validate example.json files against schema.json using built validator
validate-examples: bin/schema-validator
	@echo "Validating all example.json files against their schema.json..."
	@if find . -name "example.json" -type f | grep -q .; then \
		./bin/schema-validator --examples .; \
	else \
		echo "No example.json files found, skipping example validation"; \
	fi

# Generate Go and TypeScript bindings from JSON schemas
build: generate-go-bindings generate-ts-bindings

# Drift guard between schema regex and hand-written Version constants.
# Asserts the constant matches the schema's version regex AND that Go +
# TS constants agree. CI runs this so a producer-side bump that skips
# the schema (or vice versa) fails loudly.
define check_version_triple
	@schema='$(1)'; gofile='$(2)'; tsfile='$(3)'; \
	regex=$$(gojq -r '.properties.version.pattern' "$$schema"); \
	goval=$$(grep -oE 'Version = "[^"]+"' "$$gofile" | sed 's/Version = "\(.*\)"/\1/'); \
	tsval=$$(grep -oE 'VERSION = "[^"]+"' "$$tsfile" | sed 's/VERSION = "\(.*\)"/\1/'); \
	if [ -z "$$regex" ] || [ -z "$$goval" ] || [ -z "$$tsval" ]; then \
		echo "❌ missing fields ($$schema regex='$$regex' go='$$goval' ts='$$tsval')"; \
		exit 1; \
	fi; \
	if [ "$$goval" != "$$tsval" ]; then \
		echo "❌ Go constant ($$goval) and TS constant ($$tsval) disagree for $$schema"; \
		exit 1; \
	fi; \
	if ! echo "$$goval" | grep -Eq "$$regex"; then \
		echo "❌ Version constant $$goval does NOT match $$schema regex $$regex"; \
		exit 1; \
	fi; \
	echo "  ✓ $$schema → $$goval"
endef

verify-version:
	@echo "Verifying schema version regex matches Version constants..."
	$(call check_version_triple,declarations/PaymentRequest/v1/schema.json,declarations/PaymentRequest/v1/bindings/go/version.go,declarations/PaymentRequest/v1/bindings/typescript/version.ts)
	$(call check_version_triple,declarations/FulfillmentQuote/v1/schema.json,declarations/FulfillmentQuote/v1/bindings/go/version.go,declarations/FulfillmentQuote/v1/bindings/typescript/version.ts)
	$(call check_version_triple,declarations/BidAward/v1/schema.json,declarations/BidAward/v1/bindings/go/version.go,declarations/BidAward/v1/bindings/typescript/version.ts)
	$(call check_version_triple,declarations/FulfillmentQuoteEnvelope/v1/schema.json,declarations/FulfillmentQuoteEnvelope/v1/bindings/go/version.go,declarations/FulfillmentQuoteEnvelope/v1/bindings/typescript/version.ts)
	$(call check_version_triple,declarations/PaymentRequestEnvelope/v1/schema.json,declarations/PaymentRequestEnvelope/v1/bindings/go/version.go,declarations/PaymentRequestEnvelope/v1/bindings/typescript/version.ts)
	$(call check_version_triple,declarations/AuthorizationResponseEnvelope/v1/schema.json,declarations/AuthorizationResponseEnvelope/v1/bindings/go/version.go,declarations/AuthorizationResponseEnvelope/v1/bindings/typescript/version.ts)
	$(call check_version_triple,declarations/FulfillmentAuthorization/v1/schema.json,declarations/FulfillmentAuthorization/v1/bindings/go/version.go,declarations/FulfillmentAuthorization/v1/bindings/typescript/version.ts)
	$(call check_version_triple,declarations/SettlementResultEnvelope/v1/schema.json,declarations/SettlementResultEnvelope/v1/bindings/go/version.go,declarations/SettlementResultEnvelope/v1/bindings/typescript/version.ts)
	$(call check_version_triple,declarations/BidDeclineEnvelope/v1/schema.json,declarations/BidDeclineEnvelope/v1/bindings/go/version.go,declarations/BidDeclineEnvelope/v1/bindings/typescript/version.ts)
	@echo "✅ All declaration Version constants match their schema regex"

# Declarations whose Go validator embeds its schema. Drives both the copy step and the drift guard,
# so a new one cannot get the copy without also getting guarded.
EMBEDDED_SCHEMA_DECLS := PaymentRequest FulfillmentQuote AuthorizationResponse FulfillmentAuthorization SettlementResult BidDecline
EMBEDDED_SCHEMA_FILES := $(foreach d,$(EMBEDDED_SCHEMA_DECLS),declarations/$(d)/v1/bindings/go/schema.json)

# Tokens implementing EIP-3009, which an originator-fulfilled destination needs. One source,
# copied into the Go module (embedded) and generated into the TypeScript binding.
EIP3009_TOKENS_SOURCE := declarations/PaymentRequest/v1/eip3009-tokens.json

generate-go-bindings: deps
	@echo "Generating Go bindings from JSON schemas..."
	@cd declarations/PaymentRequest/v1 && mkdir -p bindings/go/generated && rm -f bindings/go/generated/payment_request.go && go-jsonschema -p generated -o bindings/go/generated/payment_request.go schema.json
	@cd declarations/BidAward/v1 && mkdir -p bindings/go/generated && rm -f bindings/go/generated/bid_award.go && go-jsonschema -p generated -o bindings/go/generated/bid_award.go schema.json
	@cd declarations/FulfillmentQuote/v1 && mkdir -p bindings/go/generated && rm -f bindings/go/generated/fulfillment_quote.go && go-jsonschema -p generated -o bindings/go/generated/fulfillment_quote.go schema.json
	@cd declarations/FulfillmentQuoteEnvelope/v1 && mkdir -p bindings/go/generated && rm -f bindings/go/generated/fulfillment_quote_envelope.go && go-jsonschema -p generated -o bindings/go/generated/fulfillment_quote_envelope.go schema.json
	@cd declarations/PaymentRequestEnvelope/v1 && mkdir -p bindings/go/generated && rm -f bindings/go/generated/payment_request_envelope.go && go-jsonschema -p generated -o bindings/go/generated/payment_request_envelope.go schema.json
	@cd declarations/AuthorizationResponse/v1 && mkdir -p bindings/go/generated && rm -f bindings/go/generated/authorization_response.go && go-jsonschema -p generated -o bindings/go/generated/authorization_response.go schema.json
	@cd declarations/AuthorizationResponseEnvelope/v1 && mkdir -p bindings/go/generated && rm -f bindings/go/generated/authorization_response_envelope.go && go-jsonschema -p generated -o bindings/go/generated/authorization_response_envelope.go schema.json
	@# Each embedding validator needs the schema inside its own module directory.
	@$(foreach d,$(EMBEDDED_SCHEMA_DECLS),cp declarations/$(d)/v1/schema.json declarations/$(d)/v1/bindings/go/schema.json;)
	@# The EIP-3009 token list ships with the PaymentRequest bindings the same way.
	@cp $(EIP3009_TOKENS_SOURCE) declarations/PaymentRequest/v1/bindings/go/eip3009_tokens.json
	@cd declarations/FulfillmentAuthorization/v1 && mkdir -p bindings/go/generated && rm -f bindings/go/generated/fulfillment_authorization.go && go-jsonschema -p generated -o bindings/go/generated/fulfillment_authorization.go schema.json
	@cd declarations/SettlementResult/v1 && mkdir -p bindings/go/generated && rm -f bindings/go/generated/settlement_result.go && go-jsonschema -p generated -o bindings/go/generated/settlement_result.go schema.json
	@cd declarations/SettlementResultEnvelope/v1 && mkdir -p bindings/go/generated && rm -f bindings/go/generated/settlement_result_envelope.go && go-jsonschema -p generated -o bindings/go/generated/settlement_result_envelope.go schema.json
	@cd declarations/BidDecline/v1 && mkdir -p bindings/go/generated && rm -f bindings/go/generated/bid_decline.go && go-jsonschema -p generated -o bindings/go/generated/bid_decline.go schema.json
	@cd declarations/BidDeclineEnvelope/v1 && mkdir -p bindings/go/generated && rm -f bindings/go/generated/bid_decline_envelope.go && go-jsonschema -p generated -o bindings/go/generated/bid_decline_envelope.go schema.json
	@echo "✅ Go bindings generated"

# Generate TypeScript bindings from JSON schemas.
#
# Regeneration is always an explicit step. The api-side packages write their committed
# src/*.ts from their own `generate` script, never from `build`: a `build` that rewrote
# tracked files would let any build path — workspace, package or release — ship generated
# code that differs from what is committed, so `build` only compiles what is. The drift
# guard below is what makes skipping regeneration fail. (`apis/Makefile` regenerates the
# same four files from its own targets; both paths produce identical bytes.)
generate-ts-bindings: deps
	@echo "Generating TypeScript bindings from JSON schemas..."
	@cd declarations && pnpm run generate
	@pnpm --filter @atum-labs/atum-escrow run generate
	@pnpm --filter @atum-labs/fulfillment-confirmation run generate
	@$(MAKE) -C apis generate-wallet-orch-ts-client
	@echo "✅ TypeScript bindings generated"

# Go binding files to check
GO_BINDING_FILES := declarations/PaymentRequest/v1/bindings/go/generated/payment_request.go \
                    declarations/BidAward/v1/bindings/go/generated/bid_award.go \
                    declarations/FulfillmentQuote/v1/bindings/go/generated/fulfillment_quote.go \
                    declarations/FulfillmentQuoteEnvelope/v1/bindings/go/generated/fulfillment_quote_envelope.go \
                    declarations/PaymentRequestEnvelope/v1/bindings/go/generated/payment_request_envelope.go \
                    declarations/AuthorizationResponse/v1/bindings/go/generated/authorization_response.go \
                    declarations/AuthorizationResponseEnvelope/v1/bindings/go/generated/authorization_response_envelope.go \
                    $(EMBEDDED_SCHEMA_FILES) \
                    declarations/PaymentRequest/v1/bindings/go/eip3009_tokens.json \
                    declarations/FulfillmentAuthorization/v1/bindings/go/generated/fulfillment_authorization.go \
                    declarations/SettlementResult/v1/bindings/go/generated/settlement_result.go \
                    declarations/SettlementResultEnvelope/v1/bindings/go/generated/settlement_result_envelope.go \
                    declarations/BidDecline/v1/bindings/go/generated/bid_decline.go \
                    declarations/BidDeclineEnvelope/v1/bindings/go/generated/bid_decline_envelope.go

# Check if Go bindings are up to date
check-go-bindings:
	@echo "Checking if Go bindings are up to date..."
	@$(MAKE) generate-go-bindings
	@if [ -n "$$(git status --porcelain $(GO_BINDING_FILES))" ]; then \
		echo "❌ Go bindings are out of date!"; \
		echo "The following files have changed:"; \
		git status --porcelain $(GO_BINDING_FILES); \
		echo ""; \
		echo "Diff of changes:"; \
		git diff declarations/; \
		echo ""; \
		echo "Please run 'make build' or 'make generate-go-bindings' in the schemas directory to update the Go bindings."; \
		echo "Then commit the changes."; \
		exit 1; \
	else \
		echo "✅ Go bindings are up to date!"; \
	fi

# TypeScript binding files to check
TS_BINDING_FILES := declarations/PaymentRequest/v1/bindings/typescript/generated/index.ts \
                    declarations/PaymentRequest/v1/bindings/typescript/generated/eip3009-tokens.ts \
                    declarations/BidAward/v1/bindings/typescript/generated/index.ts \
                    declarations/FulfillmentQuote/v1/bindings/typescript/generated/index.ts \
                    declarations/FulfillmentQuoteEnvelope/v1/bindings/typescript/generated/index.ts \
                    declarations/PaymentRequestEnvelope/v1/bindings/typescript/generated/index.ts \
                    declarations/AuthorizationResponse/v1/bindings/typescript/generated/index.ts \
                    declarations/AuthorizationResponseEnvelope/v1/bindings/typescript/generated/index.ts \
                    declarations/FulfillmentAuthorization/v1/bindings/typescript/generated/index.ts \
                    declarations/SettlementResult/v1/bindings/typescript/generated/index.ts \
                    declarations/SettlementResultEnvelope/v1/bindings/typescript/generated/index.ts \
                    declarations/BidDecline/v1/bindings/typescript/generated/index.ts \
                    declarations/BidDeclineEnvelope/v1/bindings/typescript/generated/index.ts \
                    apis/x402/v1/bindings/typescript/src/extra.ts \
                    apis/x402/v1/bindings/typescript/src/payload.ts \
                    apis/x402/v1/bindings/typescript/src/request.ts \
                    apis/fulfillment-confirmation/v1/bindings/typescript/src/types.ts \
                    apis/wallet-orch/v1/bindings/typescript/src/types.gen.ts \
                    apis/wallet-orch/v1/bindings/typescript/src/schemas.gen.ts \
                    apis/wallet-orch/v1/bindings/typescript/src/services.gen.ts

# Check if TypeScript bindings are up to date
check-ts-bindings:
	@echo "Checking if TypeScript bindings are up to date..."
	@$(MAKE) generate-ts-bindings
	@if [ -n "$$(git status --porcelain $(TS_BINDING_FILES))" ]; then \
		echo "❌ TypeScript bindings are out of date!"; \
		echo "The following files have changed:"; \
		git status --porcelain $(TS_BINDING_FILES); \
		echo ""; \
		echo "Please run 'make generate-ts-bindings' to update the TypeScript bindings."; \
		echo "Then commit the changes."; \
		exit 1; \
	else \
		echo "✅ TypeScript bindings are up to date!"; \
	fi

# The TypeScript clients generated from an OpenAPI spec, which check-ts-bindings
# does not cover. Nothing regenerated these, so a spec change shipped without
# them and the published payment-gateway client sat without `retry_classification`
# for the life of a branch. Paths are relative to this Makefile.
#
# Split into two halves on purpose, because they need different toolchains:
#   * the payment-gateway client is pure Node (@hey-api/openapi-ts via pnpm)
#   * veri-fill additionally needs oapi-codegen and `go mod tidy`
# The CI TypeScript lane installs Go but NOT the codegen binaries, and it is the
# only lane whose path filter sees a payment-gateway-client-only change -- so it
# has to be able to run the PGC half alone. Keeping them as one target would
# force that lane to install Go codegen tools it otherwise has no use for.
#
# They also compare differently, and that is deliberate rather than a second copy of
# one rule. The PGC half owns its whole output directory, so it generates into a temp
# directory and uses `diff -r`, which reports files present on only one side. veri-fill
# cannot do that: its generated files share a directory with hand-written wrappers, so
# comparing the directory would report a human's own work as codegen drift. It stays an
# explicit file list compared through git.

# The committed tree the PGC guard compares against: a plain path handed to `diff -r`,
# not a git pathspec. Overridable, which is how testdata/pgc-client-guard/run.sh points
# the guard at scratch copies to prove it still fails on every kind of drift.
#
# A whole DIRECTORY rather than named files. The old list covered 3 of the 13 files the
# generator emits, so a hand-edit to core/request.ts or PaymentGatewayClient.ts passed
# even though the next `generate` would erase it. Everything under src/generated is
# generator output -- verified by deleting the tree and regenerating it, which
# reproduces all 13 files byte-identically and adds nothing -- so there is no
# hand-written file in there for the directory comparison to flag by mistake.
PGC_OPENAPI_CLIENT_PATHS := apis/payment-gateway/v1/bindings/typescript/client/src/generated

# veri-fill stays an explicit file list on purpose: its generated output shares a
# directory with hand-written wrappers (client.ts, verdict.ts), so watching the
# directory would report a human's own edits as codegen drift.
VERI_FILL_OPENAPI_CLIENT_PATHS := apis/veri-fill/v1/bindings/typescript/src/types.ts \
                                  apis/veri-fill/v1/bindings/typescript/src/types.gen.ts \
                                  apis/veri-fill/v1/bindings/typescript/src/schemas.gen.ts \
                                  apis/veri-fill/v1/bindings/typescript/src/services.gen.ts

# Git-based drift comparison: $(1) names what drifted, $(2) is the pathspecs, $(3) the
# command that fixes it. Regeneration is the caller's job; this only compares.
#
# One caller today (the veri-fill half). It stays a `define` because the PGC half used
# it until that half moved to a temp-directory `diff -r`, and because it is the right
# shape for any future generator whose output shares a directory with hand-written code.
#
# Mirrors lint-x402 in apis/Makefile: `git diff` against the index, plus an explicit
# untracked-file check. Two reasons to prefer that over `git status --porcelain`:
#   * `git diff` is working-tree-vs-index, so the guard still passes when the regen
#     output is already staged. `git status` reports any dirtiness at all and so can
#     never go green on a tree with staged changes.
#   * `git diff` alone cannot see a newly emitted file -- a new endpoint, or a
#     deletion the generator restored -- which `git ls-files --others` catches.
define check_openapi_client_drift
	@paths='$(2)'; \
	if ! git diff --quiet -- $$paths || \
	   [ -n "$$(git ls-files --others --exclude-standard -- $$paths)" ]; then \
		echo "❌ $(1) is out of date!"; \
		echo "What changed:"; \
		git --no-pager diff --stat -- $$paths; \
		git ls-files --others --exclude-standard -- $$paths | sed 's/^/  (untracked) /'; \
		echo ""; \
		echo "Either the spec changed without regenerating the client built from it, or a"; \
		echo "generated file was edited by hand. Generated code is not the place to make a"; \
		echo "change: edit the spec, or the hand-written wrapper around the client."; \
		echo "Run '$(3)' and commit the result."; \
		exit 1; \
	fi; \
	echo "✅ $(1) is up to date"
endef

# Regenerates via the package's own entry point rather than reimplementing the
# codegen invocation, so this cannot drift from how the client is really produced.
# Node only -- safe to call from any lane that has run `pnpm install`.
#
# Generates into a TEMPORARY directory and compares with `diff -r`, rather than
# regenerating in place and asking git what moved. Two reasons:
#
#   * `diff -r` reports files present on only one side, so a hand-WRITTEN file added
#     to the top level of src/generated is caught. Regenerating in place cannot see
#     one: openapi-ts 0.45.1 wipes and rewrites core/, but at the top level it only
#     overwrites the 13 files it emits and leaves anything else alone -- so a
#     committed stray file is untouched, identical to the index, and invisible to
#     both `git diff` and `git ls-files --others`. It would have passed forever.
#     The same hole hid a top-level file the generator had STOPPED emitting.
#   * The guard no longer mutates the tree it is inspecting. Previously a failure
#     left your working copy full of regenerated output, a half-finished generator
#     run left a mix of old and new files, and an uncommitted hand-edit under
#     src/generated was silently overwritten with no warning.
check-pgc-openapi-client:
	@echo "Checking if the payment-gateway TypeScript client is up to date..."
	@out=$$(mktemp -d) || exit 1; \
	trap 'rm -rf "$$out" "$$out.diff"' EXIT; \
	PGC_GEN_OUT="$$out" pnpm --filter @atum-labs/payment-gateway-client run generate >/dev/null \
	  || { echo "❌ the payment-gateway client generator failed (its error is above) -- this is NOT drift"; \
	       [ -n "$$GITHUB_ACTIONS" ] && echo "::error::openapi-ts failed to run; the committed client was not checked"; \
	       exit 1; }; \
	if ! diff -r $(PGC_OPENAPI_CLIENT_PATHS) "$$out" > "$$out.diff" 2>&1; then \
		echo "❌ The payment-gateway TypeScript client is out of date!"; \
		echo "What differs (committed tree vs a fresh generate):"; \
		sed 's/^/  /' "$$out.diff" | head -40; \
		rm -f "$$out.diff"; \
		echo ""; \
		echo "Either the spec changed without regenerating the client built from it, a"; \
		echo "generated file was edited by hand, or a hand-written file was added under"; \
		echo "src/generated. Generated code is not the place to make a change: edit the"; \
		echo "spec, or the hand-written wrapper around the client."; \
		echo "Run 'pnpm --filter @atum-labs/payment-gateway-client run generate' and commit."; \
		[ -n "$$GITHUB_ACTIONS" ] && echo "::error::schemas/apis/payment-gateway/v1/bindings/typescript/client/src/generated is stale or hand-edited. Run 'pnpm --filter @atum-labs/payment-gateway-client run generate' and commit the result."; \
		exit 1; \
	fi; \
	rm -f "$$out.diff"; \
	echo "✅ The payment-gateway TypeScript client is up to date"

# Self-test for the guard above. Mirrors test-shared-error-shape: point the guard at
# scratch copies of the generated tree, mutate each one differently, and assert both the
# exit code and the diagnostic. A guard mutated to reject everything would satisfy every
# failing case, so the passing case is load-bearing.
#
# This exists because the failure being fixed was a guard that was GREEN when it should
# have been RED, for months. Nothing else would catch a repeat.
test-pgc-openapi-client-guard:
	@MAKE='$(MAKE)' testdata/pgc-client-guard/run.sh

# ---------------------------------------------------------------------------
# Shared shapes generated from one definition
# ---------------------------------------------------------------------------
#
# A credential, a proof and a signed message appear in most declarations, and the shapes an
# API exchanges are often the same shapes that get signed. One shape held in several
# hand-edited places cannot be kept true by review alone, so each is written once and every
# other copy is generated from it: declarations draw from declarations/common/shapes, and a
# spec draws from the declaration whose data it carries.
#
# Generated into each file rather than referenced from it, because a cross-file $$ref does
# not survive this repository's generators. On the spec side oapi-codegen resolves only
# #/components/schemas pointers and cannot follow a $$defs pointer at all, and the embed/go
# copy is a plain cp two directories deeper, so a relative ref would dangle there. Between
# declarations, go-jsonschema names every schema root alike and does not namespace across
# files, so two schemas sharing a ref emit Go that does not compile. Generating keeps every
# file self-contained and readable on its own.
#
# Adding a manifest here is how a spec or a declaration opts in.
# Declarations come first: an API draws its shapes from a declaration, so the shared
# definitions must be in place before a spec is generated from one.
CANONICAL_SHAPE_MANIFESTS := \
	declarations/PaymentRequest/v1/canonical-shapes.yaml \
	declarations/PaymentRequestEnvelope/v1/canonical-shapes.yaml \
	declarations/FulfillmentQuote/v1/canonical-shapes.yaml \
	declarations/FulfillmentQuoteEnvelope/v1/canonical-shapes.yaml \
	declarations/BidAward/v1/canonical-shapes.yaml \
	declarations/BidAwardEnvelope/v1/canonical-shapes.yaml \
	declarations/AuthorizationResponse/v1/canonical-shapes.yaml \
	declarations/AuthorizationResponseEnvelope/v1/canonical-shapes.yaml \
	declarations/FulfillmentAuthorization/v1/canonical-shapes.yaml \
	declarations/SettlementResultEnvelope/v1/canonical-shapes.yaml \
	declarations/BidDeclineEnvelope/v1/canonical-shapes.yaml \
	apis/payment-gateway/v1/canonical-shapes.yaml \
	apis/payment-gateway/v1/canonical-shapes.fulfillment-authorization.yaml \
	apis/payment-gateway/v1/canonical-shapes.reserve-auth.yaml \
	apis/payment-gateway/v1/canonical-shapes.error.yaml \
	apis/veri-fill/v1/canonical-shapes.yaml

# What the generator writes, derived from the manifests rather than listed again: every
# manifest names its own target, so a new manifest is guarded the moment it is added. A
# second hand-maintained list would let a file be generated and never drift-checked, which
# fails silently and forever.
CANONICAL_SHAPE_PATHS = $(foreach m,$(CANONICAL_SHAPE_MANIFESTS),$(dir $(m))$(shell sed -n 's/^target: *//p' $(m)))

# Built once and reused, the way bin/schema-validator is: `go run` per manifest re-links the
# binary on every iteration.
bin/canonical-shapes: $(wildcard canonical-shapes/*.go)
	@mkdir -p bin
	@go build -o bin/canonical-shapes ./canonical-shapes

generate-canonical-shapes: bin/canonical-shapes
	@echo "Generating shared component schemas from the canonical declarations..."
	@for manifest in $(CANONICAL_SHAPE_MANIFESTS); do \
		./bin/canonical-shapes -manifest "$$manifest" || exit 1; \
	done
	@echo "✅ Shared component schemas generated"

# Regenerate, then fail if the committed spec differs. The Go and TypeScript bindings
# derived from the spec are guarded separately by check-api-bindings and
# check-pgc-openapi-client, so this target owns the spec itself and nothing else.
check-canonical-shapes:
	@echo "Checking if the generated shared component schemas are up to date..."
	@$(MAKE) generate-canonical-shapes
	@if [ -n "$$(git status --porcelain $(CANONICAL_SHAPE_PATHS))" ]; then \
		echo "❌ The shared component schemas are out of date!"; \
		echo "The following files have changed:"; \
		git status --porcelain $(CANONICAL_SHAPE_PATHS); \
		echo ""; \
		echo "Diff:"; \
		git diff -- $(CANONICAL_SHAPE_PATHS); \
		echo ""; \
		echo "These blocks are generated from the canonical declaration. Edit the declaration"; \
		echo "named in the manifest, not the spec, then run:"; \
		echo "    make -C schemas generate-canonical-shapes"; \
		echo "and commit the result together with the regenerated bindings."; \
		exit 1; \
	fi
	@echo "✅ The generated shared component schemas are up to date"

test-veri-fill-go-module:
	@bash apis/tests/test-maintained-go-modules.sh full

# Full generation also rebuilds Go; test manifest preservation before comparing TS.
check-veri-fill-openapi-client: test-veri-fill-go-module
	@echo "Checking if the veri-fill TypeScript client is up to date..."
	@$(MAKE) -C apis generate-veri-fill
	$(call check_openapi_client_drift,The veri-fill TypeScript client,$(VERI_FILL_OPENAPI_CLIENT_PATHS),make -C schemas check-veri-fill-openapi-client)

# Both halves. Used by `make lint` and by the CI schema-guards lane, which has the
# Go codegen tools installed.
#
# Sequential sub-makes rather than prerequisites: under `make -j` prerequisites run
# concurrently, and both halves shell out to git in the same repository (`git ls-files`,
# and `go mod tidy` on the veri-fill side). Two git commands racing for .git/index.lock
# fail with "Unable to create index.lock", which reads as codegen drift rather than as
# the flake it is.
#
# Not `.NOTPARALLEL: check-openapi-ts-clients`. Scoping .NOTPARALLEL to named targets
# only works on GNU Make 4.4+; on anything older the prerequisites are ignored and it
# serializes the ENTIRE makefile. macOS ships 3.81 and the GitHub runners ship 4.3, so
# that form would have silently done something much broader than it claimed here.
check-openapi-ts-clients:
	@$(MAKE) check-pgc-openapi-client
	@$(MAKE) check-veri-fill-openapi-client

# Conformance fixture drift guard. Mirrors check-go-bindings /
# check-ts-bindings: regenerate both languages' fixtures and fail loudly
# on any diff. Without this, a signer-only change that didn't break
# verification of the existing fixtures (e.g. a key-ordering or
# formatting tweak in one language only) would leave both committed
# files stale-but-identical and the byte-identity test would still pass
# — visible only when someone remembered to manually regenerate.
CONFORMANCE_FIXTURES_DIR := declarations/FulfillmentQuote/v1/conformance/fixtures
# The inner PaymentRequest signer/verifier ships its own
# cross-language fixture set, regenerated + drift-guarded alongside FQ's.
PR_CONFORMANCE_FIXTURES_DIR := declarations/PaymentRequest/v1/conformance/fixtures
# Settler report declarations: Go-generated content-hash goldens, asserted by Go, TS and the settler.
REPORT_CONTENT_HASH_GOLDENS := declarations/SettlementResult/v1/conformance/content-hash-golden.json \
                               declarations/BidDecline/v1/conformance/content-hash-golden.json
check-conformance-fixtures: build-ld-data-integrity build-payment-request-ld-signing
	@echo "Checking if conformance fixtures are up to date..."
	@$(MAKE) -C declarations/FulfillmentQuote/v1/bindings/go/signing gen-conformance-fixtures
	@pnpm --filter @atum-labs/ld-signing run gen-conformance-fixtures
	@$(MAKE) -C declarations/PaymentRequest/v1/bindings/go/signing gen-conformance-fixtures
	@pnpm --filter @atum-labs/payment-request-ld-signing run gen-conformance-fixtures
	@$(MAKE) -C declarations/SettlementResult/v1/bindings/go/signing gen-conformance
	@$(MAKE) -C declarations/BidDecline/v1/bindings/go/signing gen-conformance
	@if [ -n "$$(git status --porcelain $(CONFORMANCE_FIXTURES_DIR) $(PR_CONFORMANCE_FIXTURES_DIR) $(REPORT_CONTENT_HASH_GOLDENS))" ]; then \
		echo "❌ Conformance fixtures are out of date!"; \
		echo "The following files have changed:"; \
		git status --porcelain $(CONFORMANCE_FIXTURES_DIR) $(PR_CONFORMANCE_FIXTURES_DIR) $(REPORT_CONTENT_HASH_GOLDENS); \
		echo ""; \
		echo "Diff:"; \
		git diff -- $(CONFORMANCE_FIXTURES_DIR) $(PR_CONFORMANCE_FIXTURES_DIR) $(REPORT_CONTENT_HASH_GOLDENS); \
		echo ""; \
		echo "Run 'make check-conformance-fixtures' locally to regenerate, then commit the diff."; \
		exit 1; \
	else \
		echo "✅ Conformance fixtures are up to date!"; \
	fi

# Deterministic API-binding drift guard (Option A scope). Regenerates ONLY
# the version-pinned Go artifacts — the oapi-codegen@v2.5.1 bindings for every
# API, the go-jsonschema@v0.20.0 types for the JSON-Schema APIs, and the
# payment-gateway embed/go/openapi.{yaml,go} copy — via apis/generate-go-bindings
# (Go-only, no Node), then fails on any diff. It deliberately does NOT run
# @hey-api/openapi-ts or openapi-typescript, so the unpinned TS client files
# (VeriFillClient.ts, *.gen.ts, core/**, client.ts, ...)
# are never regenerated or diffed.
#
# Paths are relative to schemas/ (this Makefile's dir); veri-fill only guards
# its generated/ subdir so hand-written builders/validation stay untouched.
API_GO_BINDING_PATHS := \
	apis/veri-fill/v1/bindings/go/generated \
	apis/veri-fill/v1/bindings/go/go.mod \
	apis/veri-fill/v1/bindings/go/go.sum \
	apis/payment-gateway/v1/bindings/go/types.go \
	apis/payment-gateway/v1/bindings/go/client.go \
	apis/payment-gateway/v1/bindings/go/server.go \
	apis/payment-gateway/v1/bindings/go/go.mod \
	apis/payment-gateway/v1/bindings/go/go.sum \
	apis/payment-gateway/v1/embed/go \
	apis/auth/v1/bindings/go/types.go \
	apis/auth/v1/bindings/go/client.go \
	apis/auth/v1/bindings/go/server.go \
	apis/auth/v1/bindings/go/go.mod \
	apis/auth/v1/bindings/go/go.sum \
	apis/counterparty-gateway/v1/registration/bindings/go/types.go \
	apis/counterparty-gateway/v1/registration/bindings/go/client.go \
	apis/counterparty-gateway/v1/registration/bindings/go/server.go \
	apis/counterparty-gateway/v1/registration/bindings/go/go.mod \
	apis/counterparty-gateway/v1/registration/bindings/go/go.sum \
	apis/counterparty-gateway/v1/webhook/bindings/go/types.go \
	apis/counterparty-gateway/v1/webhook/bindings/go/client.go \
	apis/counterparty-gateway/v1/webhook/bindings/go/server.go \
	apis/counterparty-gateway/v1/webhook/bindings/go/go.mod \
	apis/counterparty-gateway/v1/webhook/bindings/go/go.sum \
	apis/error/v1/bindings/go/types.go \
	apis/error/v1/bindings/go/go.mod \
	apis/fulfillment-confirmation/v1/bindings/go/types.go \
	apis/fulfillment-confirmation/v1/bindings/go/go.mod \
	apis/wallet-orch/v1/bindings/go/types.go \
	apis/wallet-orch/v1/bindings/go/client.go \
	apis/wallet-orch/v1/bindings/go/server.go \
	apis/wallet-orch/v1/bindings/go/go.mod \
	apis/wallet-orch/v1/bindings/go/go.sum \
	apis/x402/v1/bindings/go/extra/types.go \
	apis/x402/v1/bindings/go/payload/types.go \
	apis/x402/v1/bindings/go/request/types.go \
	apis/x402/v1/bindings/go/go.mod \
	apis/x402/v1/bindings/go/go.sum

test-payment-gateway-go-module:
	@bash apis/tests/test-payment-gateway-go-module.sh

test-maintained-go-modules:
	@bash apis/tests/test-maintained-go-modules.sh go

check-api-bindings: test-maintained-go-modules test-payment-gateway-go-module
	@echo "Checking if deterministic Go API bindings + payment-gateway embed are up to date..."
	@$(MAKE) -C apis generate-go-bindings
	@if [ -n "$$(git status --porcelain $(API_GO_BINDING_PATHS))" ]; then \
		echo "❌ Go API bindings / payment-gateway embed are out of date!"; \
		echo "The following files have changed:"; \
		git status --porcelain $(API_GO_BINDING_PATHS); \
		echo ""; \
		echo "Diff:"; \
		git diff -- $(API_GO_BINDING_PATHS); \
		echo ""; \
		echo "Run 'make -C schemas/apis generate-go-bindings' to regenerate, then commit the diff."; \
		exit 1; \
	else \
		echo "✅ Go API bindings + payment-gateway embed are up to date!"; \
	fi

# ld-verification (signing/go) drift guard. The drift signals for these
# signer/verifier modules are the embedded context snapshot + a clean
# `go mod tidy` — NOT the golangci-lint style gate (style is out of scope
# for this concern, so this target deliberately omits `golangci-lint run`).
# For each module: verify-context asserts the go:embed'd .jsonld contexts
# still match their canonical sources, then `go mod tidy` + a scoped
# git diff --exit-code fails on any go.mod/go.sum churn.
LD_VERIFICATION_MODULES := \
	declarations/FulfillmentQuote/v1/bindings/go/signing \
	declarations/PaymentRequest/v1/bindings/go/signing \
	declarations/AuthorizationResponse/v1/bindings/go/signing \
	declarations/PaymentRequestEnvelope/v1/bindings/go \
	declarations/PaymentRequestEnvelope/v1/bindings/go/signing \
	declarations/SettlementResult/v1/bindings/go/signing \
	declarations/BidDecline/v1/bindings/go/signing

check-ld-verification-drift:
	@echo "Checking ld-verification context snapshots + go.mod tidiness..."
	@for mod in $(LD_VERIFICATION_MODULES); do \
		echo "→ $$mod"; \
		$(MAKE) -C $$mod verify-context || exit 1; \
		( cd $$mod && go mod tidy && git diff --exit-code -- go.mod go.sum ) || { \
			echo "❌ $$mod go.mod/go.sum drifted after 'go mod tidy' — run 'go mod tidy' there and commit."; \
			exit 1; \
		}; \
	done
	@echo "✅ ld-verification context snapshots + go.mod are clean!"

# Error catalog drift guard. Delegated to the apis Makefile, which owns the
# generator and mirrors. Run explicitly in CI (the apis lint target is not).
check-error-catalog:
	@$(MAKE) -C apis check-error-catalog

# Specs that must carry an ErrorResponse matching error/v1. Listing a spec here is how
# a service opts into the shared error shape, and the guard fails if a listed spec stops
# conforming, so a migration cannot be silently reverted. x402/facilitator is absent
# because it declares no 4xx/5xx at all.
# payment-gateway/v1/embed/go is generated by cp from payment-gateway/v1, so it is
# excluded from discovery below rather than listed.
# Every spec declaring a 4xx or 5xx must be listed here. The guard enforces that
# in both directions, so a spec cannot leave the shared shape by dropping its
# entry. decline/v1 and x402/v1/facilitator declare no error responses at all,
# which is why they are absent rather than exempted.
SHARED_ERROR_SPECS := \
	auth/v1/openapi.yaml \
	counterparty-gateway/v1/registration/openapi.yaml \
	counterparty-gateway/v1/webhook/openapi.yaml \
	payment-gateway/v1/openapi.yaml \
	veri-fill/v1/openapi.yaml \
	wallet-orch/v1/openapi.yaml

# Compares property names, each property's top-level type, and the required set.
# Deliberately NOT compared: pattern, maxLength, format, enum, nullable, items, and
# nested structure. The migrated specs legitimately differ on those, and requiring
# error/v1's domain enum would change their generated Go types.
# A component that $refs (or allOf-wraps a $ref to) error/v1's ErrorResponse passes.
ERROR_SHAPE_REF := (^|/)error/v1/openapi\\.yaml[^/]*/components/schemas/ErrorResponse$$
ERROR_SHAPE_PROJ := .components.schemas.ErrorResponse // .components.schemas.APIError \
	| if . == null then "none" else \
	  ( ((.["$$ref"]) // ((.allOf // .oneOf // .anyOf // []) | map(.["$$ref"]) | map(select(. != null)) | first)) as $$rf \
	    | if $$rf != null \
	      then (if ($$rf | test("$(ERROR_SHAPE_REF)")) then "shared-ref" else "foreign-ref" end) \
	      else ((.required//[]|sort) as $$r | ((.properties//{})|to_entries|map({k:.key,t:.value.type})|sort_by(.k)) as $$p | {r:$$r,p:$$p}) \
	      end ) \
	  end

# OpenAPI specs with a consumer outside Atum Labs. A change here is a change to
# somebody else's code, so it must not go out incompatibly by accident.
#
#   payment-gateway/v1                     we serve it, PSPs build clients against it
#   veri-fill/v1                           we serve it, and a third-party settler calls it
#                                          directly for the release signature, at whatever
#                                          endpoint the payment request names
#   counterparty-gateway/v1/registration   a beneficiary PSP calls it to register its webhook
#   counterparty-gateway/v1/webhook        a beneficiary PSP serves it, we call it
#   x402/v1/facilitator                    merchants call it, and it implements a public
#                                          standard whose clients are outside Atum by definition
#
# Who a break hurts differs across them, which is why the ones we call are listed
# alongside the ones we host: on a spec we serve, a narrowed response hurts the
# integrator reading it, and on the webhook it hurts Atum, because there we are
# the client. Either way it is a break in a contract with an outside party.
#
# The baseline goes to oasdiff as a git ref rather than a file copied out of the
# tree, so a spec that $refs a sibling by relative path still resolves. x402 does
# exactly that, and flattening the baseline into a temp dir is what used to make
# it unusable here.
#
# CORE-2226 is why this exists. A required field on the webhook error body was
# renamed inside an unrelated internal cleanup, with no ticket and no notice to
# the PSPs who implement that endpoint. Nothing broke, because Atum reads only
# the HTTP status there, but nobody would have known if it had. None of the other
# guards could have caught it: the spec and the code moved together, so nothing
# was ever inconsistent, and a rule about touching a changelog only proves a file
# was edited.
EXTERNAL_SPECS := apis/payment-gateway/v1/openapi.yaml \
                  apis/veri-fill/v1/openapi.yaml \
                  apis/counterparty-gateway/v1/registration/openapi.yaml \
                  apis/counterparty-gateway/v1/webhook/openapi.yaml \
                  apis/x402/v1/facilitator/openapi.yaml

BREAKING_REF ?= main

# Per-spec record of breaks that were agreed and announced. oasdiff matches each
# line against its own output. A line names what the change is attached to, then
# describes it: "METHOD /path <description>" for an endpoint, or the bare word
# "components", "security" or "info" plus the description for the rest. Absent
# for a spec that has never broken.
BREAKING_IGNORE := breaking-ignore.txt
OASDIFF_INSTALL := go install github.com/oasdiff/oasdiff@v1.31.0

# Mirrors breaking-proto, which does the same for the gRPC wire contract.
#
# --flatten-allof merges a schema's allOf branches before comparing. Without it oasdiff
# compares the branches one at a time and cannot tell whether another branch still
# guarantees what one of them dropped, so it reports a real break through an allOf as a
# warning rather than an error. A single-member allOf is how a 3.0.3 spec attaches a
# description to a $ref at all -- the Reference Object says a sibling "SHALL be ignored" --
# so without this flag every field documented that way is graded softer than the same field
# written inline. --fail-on WARN already fails the build either way; the flag is what keeps
# that from being the only thing standing between a break and a green gate.
breaking-openapi:
	@command -v oasdiff >/dev/null || { echo "✗ oasdiff not found. Install: $(OASDIFF_INSTALL)"; exit 1; }
	@git rev-parse --verify --quiet "$(BREAKING_REF)^{commit}" >/dev/null || { \
		echo "✗ BREAKING_REF=$(BREAKING_REF) does not resolve, so there is nothing to compare against."; \
		echo "  In CI this means the checkout is shallow and needs fetch-depth: 0."; \
		exit 1; \
	}
	@echo "Checking externally consumed specs against $(BREAKING_REF)..."
	@rc=0; \
	for f in $(EXTERNAL_SPECS); do \
		if ! git cat-file -e "$(BREAKING_REF):schemas/$$f" 2>/dev/null; then \
			echo "  - schemas/$$f is new on this branch, nothing to compare"; continue; \
		fi; \
		if [ ! -f "$$f" ]; then \
			echo "  ✗ schemas/$$f exists on $(BREAKING_REF) but not here. Removing or renaming a spec"; \
			echo "      an outside party consumes is itself the break this guard exists to catch."; \
			rc=1; continue; \
		fi; \
		ignore="$$(dirname "$$f")/$(BREAKING_IGNORE)"; \
		if [ -f "$$ignore" ]; then \
			ignore_args="--err-ignore $$ignore --warn-ignore $$ignore"; \
		else \
			ignore_args=""; \
		fi; \
		out=$$(oasdiff breaking --fail-on WARN --flatten-allof $$ignore_args "$(BREAKING_REF):schemas/$$f" "$$f" 2>&1); \
		status=$$?; \
		case $$status in \
			0) echo "  ✓ schemas/$$f" ;; \
			1) echo "  ✗ schemas/$$f changed incompatibly:"; \
			   echo "$$out" | sed 's/^/      /'; \
			   rc=1 ;; \
			*) echo "  ✗ oasdiff could not compare schemas/$$f (exit $$status):"; \
			   echo "$$out" | sed 's/^/      /'; \
			   rc=1 ;; \
		esac; \
	done; \
	if [ $$rc -ne 0 ]; then \
		echo "✗ A contract with a party outside Atum Labs changed incompatibly, or could not be compared."; \
		echo "  An intended break is not a reason to weaken this list. Tell the integrators first, then"; \
		echo "  record each accepted line in $(BREAKING_IGNORE) beside that spec, in the form:"; \
		echo "      POST /v1/example the response property \`x\` became optional for the status \`400\`"; \
		echo "  The file is the record of what was announced, so a break nobody wrote down still fails."; \
		exit 1; \
	fi
	@echo "✅ Externally consumed specs are compatible with $(BREAKING_REF)"

# The auth session contract, every path under /v1/auth/ in the auth spec, is frozen before
# it is served: the API gateway and integrators build against it now. The auth spec is not in
# EXTERNAL_SPECS, because its other endpoint, /v1/payment-request, has one caller inside Atum
# Labs and changes together with it, and listing the spec there would freeze that endpoint
# too. So this compares only the frozen paths. --match-path drops every other path from both
# sides before oasdiff compares them, which leaves /v1/payment-request free to change, while a
# shared component such as ErrorResponse is still compared through every frozen path that
# uses it. Removing or renaming a frozen path is still reported, because the baseline keeps
# it. Once the auth spec joins EXTERNAL_SPECS, breaking-openapi covers all of this and this
# target can go.
#
# The flags, the baseline and the record of announced breaks (breaking-ignore.txt beside the
# spec) are the same as for breaking-openapi above.
AUTH_SESSION_SPEC := apis/auth/v1/openapi.yaml
AUTH_SESSION_PATHS := ^/v1/auth/

breaking-auth-session:
	@command -v oasdiff >/dev/null || { echo "✗ oasdiff not found. Install: $(OASDIFF_INSTALL)"; exit 1; }
	@git rev-parse --verify --quiet "$(BREAKING_REF)^{commit}" >/dev/null || { \
		echo "✗ BREAKING_REF=$(BREAKING_REF) does not resolve, so there is nothing to compare against."; \
		echo "  In CI this means the checkout is shallow and needs fetch-depth: 0."; \
		exit 1; \
	}
	@echo "Checking the frozen auth session contract ($(AUTH_SESSION_PATHS)) against $(BREAKING_REF)..."
	@f="$(AUTH_SESSION_SPEC)"; \
	if ! git cat-file -e "$(BREAKING_REF):schemas/$$f" 2>/dev/null; then \
		echo "  - schemas/$$f is new on this branch, nothing to compare"; exit 0; \
	fi; \
	if [ ! -f "$$f" ]; then \
		echo "  ✗ schemas/$$f exists on $(BREAKING_REF) but not here. Removing or renaming the spec"; \
		echo "      removes the frozen session contract with it."; \
		exit 1; \
	fi; \
	ignore="$$(dirname "$$f")/$(BREAKING_IGNORE)"; \
	if [ -f "$$ignore" ]; then \
		ignore_args="--err-ignore $$ignore --warn-ignore $$ignore"; \
	else \
		ignore_args=""; \
	fi; \
	out=$$(oasdiff breaking --fail-on WARN --flatten-allof --match-path '$(AUTH_SESSION_PATHS)' $$ignore_args "$(BREAKING_REF):schemas/$$f" "$$f" 2>&1); \
	status=$$?; \
	case $$status in \
		0) echo "  ✓ schemas/$$f, paths matching $(AUTH_SESSION_PATHS)" ;; \
		1) echo "  ✗ schemas/$$f changed the frozen session contract incompatibly:"; \
		   echo "$$out" | sed 's/^/      /'; \
		   echo "✗ The session contract under /v1/auth/ is frozen: the API gateway and integrators"; \
		   echo "  build against it. An intended break is not a reason to weaken this check. Tell the"; \
		   echo "  integrators first, then record each accepted line in $$ignore, in the form:"; \
		   echo "      POST /v1/auth/token the response property \`x\` became optional for the status \`200\`"; \
		   exit 1 ;; \
		*) echo "  ✗ oasdiff could not compare schemas/$$f (exit $$status):"; \
		   echo "$$out" | sed 's/^/      /'; \
		   exit 1 ;; \
	esac
	@echo "✅ The frozen auth session contract is compatible with $(BREAKING_REF)"

# Self-test for check-shared-error-shape. That guard is the only thing holding
# seven service specs to one error shape, and it is the only hand-written
# comparator among the check-* targets: the rest regenerate and diff, where the
# generator is the spec. A mutation that makes it always pass is invisible
# against the real tree, which is how every false pass it has had was found by
# hand rather than by CI. run.sh re-invokes it once per fixture tree and asserts
# both the exit code and which diagnostic fired.
test-shared-error-shape:
	@MAKE='$(MAKE)' testdata/shared-error-shape/run.sh

# Scan root for the guard below. Only the self-test overrides it, to point the
# same logic at a fixture tree. The default reproduces the real invocation.
ERROR_SHAPE_ROOT := apis

check-shared-error-shape:
	@which gojq > /dev/null || (echo "✗ gojq not found. Install: go install github.com/itchyny/gojq/cmd/gojq@v0.12.17" && exit 1)
	@echo "Checking service specs use the error/v1 ErrorResponse field set..."
	@cd $(ERROR_SHAPE_ROOT) || exit 1; \
	set -f; \
	ref=$$(gojq --yaml-input -c '$(ERROR_SHAPE_PROJ)' error/v1/openapi.yaml); \
	case "$$ref" in \
		*'"k":"code"'*) ;; \
		*) echo "✗ error/v1 ErrorResponse did not project a field set (got: $$ref). Is gojq working?"; exit 1;; \
	esac; \
	case "$$ref" in \
		*'"k":"message"'*) ;; \
		*) echo "✗ error/v1 ErrorResponse did not project a field set (got: $$ref). Is gojq working?"; exit 1;; \
	esac; \
	rc=0; seen=''; \
	for f in $$(find . -name openapi.yaml \
			-not -path './error/v1/*' \
			-not -path '*/node_modules/*' \
			-not -path './payment-gateway/v1/embed/*' \
		| sed 's|^\./||' | sort); do \
		required=$$(echo " $(SHARED_ERROR_SPECS) " | grep -Fc " $$f " || true); \
		if [ "$$required" != "0" ]; then seen="$$seen $$f"; fi; \
		if [ "$$required" = "0" ]; then \
			errs=$$(gojq --yaml-input -r '[(.paths//{})[]|.[]?|(.responses//{})|keys[]?|select(test("^[45]"))]|length' "$$f" 2>/dev/null || echo 0); \
			if [ "$$errs" != "0" ]; then \
				echo "  ✗ $$f declares a 4xx/5xx response but is not in SHARED_ERROR_SPECS, so nothing holds its error shape to error/v1. Add it."; \
				rc=1; continue; \
			fi; \
		fi; \
		got=$$(gojq --yaml-input -c '$(ERROR_SHAPE_PROJ)' "$$f"); \
		if [ -z "$$got" ]; then \
			echo "  ✗ $$f could not be projected"; rc=1; continue; \
		fi; \
		case "$$got" in \
			'"none"') \
				if [ "$$required" = "0" ]; then continue; fi; \
				echo "  ✗ $$f is in SHARED_ERROR_SPECS but defines no ErrorResponse component"; rc=1;; \
			'"shared-ref"'|"$$ref") \
				;; \
			'"foreign-ref"') \
				echo "  ✗ $$f references an error shape that is not the error/v1 ErrorResponse"; rc=1;; \
			*) \
				echo "  ✗ $$f defines its own error field set instead of the error/v1 one"; \
				echo "      want $$ref"; \
				echo "      got  $$got"; rc=1;; \
		esac; \
	done; \
	for want in $(SHARED_ERROR_SPECS); do \
		case "$$seen " in \
			*" $$want "*) ;; \
			*) echo "  ✗ SHARED_ERROR_SPECS lists $$want, which no spec matched. Remove the stale entry."; rc=1;; \
		esac; \
	done; \
	if [ $$rc -ne 0 ]; then \
		echo "✗ Error shape drift. Mirror the error/v1 ErrorResponse field set (see counterparty-gateway/v1/registration)."; \
		exit 1; \
	fi
	@echo "✅ Service specs use the error/v1 ErrorResponse field set"

# Every error code named in error/v1's schemas, examples and README must exist in the
# catalog. AtumError and the example files carry INTERNAL codes (catalog keys);
# ErrorResponse carries PUBLIC codes. The README may also name a domain.
# Lives here rather than in TestCatalogIntegrity because error/v1/bindings/go is a
# zero-dependency module and the ErrorResponse examples exist only in the YAML.
# Covers codes named in these files, not ones named in Go or TS doc comments. Only
# backticked or parenthesized names are read there, so `{CATEGORY}_{SPECIFIC}` style
# prose patterns are left alone.
check-error-code-examples:
	@which gojq > /dev/null || (echo "✗ gojq not found. Install: go install github.com/itchyny/gojq/cmd/gojq@v0.12.17" && exit 1)
	@echo "Checking error/v1 code examples exist in the catalog..."
	@cd apis/error/v1 || exit 1; \
	internal=" $$(gojq -r '.entries | keys | join(" ")' catalog.json) "; \
	public=" $$(gojq -r '[.entries[].public_code, .fallback.public_code] | unique | join(" ")' catalog.json) "; \
	domains=" $$(gojq --yaml-input -r '.components.schemas.AtumError.properties.domain.enum | join(" ")' openapi.yaml) "; \
	n=$$(gojq -r '.entries | length' catalog.json 2>/dev/null || echo 0); \
	[ "$$n" -gt 0 ] 2>/dev/null || { echo "✗ could not read catalog.json. Is gojq working?"; exit 1; }; \
	rc=0; \
	chk() { \
		if [ -z "$$2" ] || [ "$$2" = "null" ]; then \
			echo "  ✗ $$1: read no codes. The schema path moved, or gojq failed."; rc=1; return; \
		fi; \
		for c in $$2; do \
			case "$$3" in *" $$c "*) ;; *) echo "  ✗ $$1: $$c is not $$4"; rc=1;; esac; \
		done; \
	}; \
	chk "openapi.yaml AtumError.code" \
		"$$(gojq --yaml-input -r '.components.schemas.AtumError.properties.code.examples | join(" ")' openapi.yaml)" \
		"$$internal" "a catalog key"; \
	chk "openapi.yaml ErrorResponse.code" \
		"$$(gojq --yaml-input -r '.components.schemas.ErrorResponse.properties.code.examples | join(" ")' openapi.yaml)" \
		"$$public" "a public code"; \
	chk "schema.json properties.code" \
		"$$(gojq -r '.properties.code.examples | join(" ")' schema.json)" \
		"$$internal" "a catalog key"; \
	for f in $$(ls *example*.json | sort); do \
		chk "$$f" "$$(gojq -r '.code' $$f)" "$$internal" "a catalog key"; \
	done; \
	chk "README.md" \
		"$$(awk '/^ *```/{f=!f; next} !f' README.md \
			| grep -oE '`[A-Z][A-Z0-9_]{3,}`|\([A-Z][A-Z0-9_]{3,}\)' \
			| tr -d '`()' | sort -u | tr '\n' ' ')" \
		"$$internal$$public$$domains" "a catalog key, public code or domain"; \
	if [ $$rc -ne 0 ]; then \
		echo "✗ error/v1 names codes that no emitter produces. Use a real code from catalog.json."; \
		exit 1; \
	fi
	@echo "✅ error/v1 code examples all exist in the catalog"

check-decline-catalog:
	@$(MAKE) -C apis check-decline-catalog

# API-related delegations
generate-apis:
	@echo "Generating API bindings..."
	@$(MAKE) -C apis generate
	@echo "✅ API bindings generated"

build-apis:
	@echo "Building API packages..."
	@$(MAKE) -C apis build
	@echo "✅ API packages built"

lint-apis:
	@echo "Checking API bindings..."
	@$(MAKE) -C apis lint
	@echo "✅ API bindings checked"

# Hosts.yaml is the writable SSOT for public API base URLs. These rewrite
# OpenAPI `servers:` and the hosts.generated.ts files (client + escrow trust lists).
generate-hosts:
	@node scripts/gen-hosts.mjs

check-hosts:
	@node scripts/gen-hosts.mjs --check

test-hosts:
	@node --test scripts/hosts.test.mjs apis/payment-gateway/v1/bindings/typescript/client/scripts/check-publishable.test.mjs

check-host-literals:
	@node scripts/check-host-literals.mjs

# Include API generation in main generate target
generate: generate-hosts generate-canonical-shapes generate-go-bindings generate-ts-bindings generate-apis

# Include API build + ld-signing build in main build target. ld-signing
# is a runtime library consumed by tests/e2e (the dev-vp E2E suite imports
# signQuote / signVP). Its `main` points at dist/lib.js — without a
# build step the file: dep installation in tests/e2e creates a symlink
# to an unbuilt source dir and module resolution fails with
# "Cannot find module '@atum-labs/ld-signing'". Building here matches
# the build-apis pattern for the API TypeScript packages.
#
# build-payment-request-ld-signing mirrors build-ld-signing
# for the inner PaymentRequest signer/verifier; like its FQ sibling it
# depends on the shared ld-data-integrity lib being built first.
build: generate-go-bindings generate-ts-bindings build-apis build-ld-data-integrity build-ld-signing build-payment-request-ld-signing

# Build the @atum-labs/ld-data-integrity TypeScript library FIRST —
# build-ld-signing depends on it (FQ TS canonicalize/hash/jws delegate
# to its primitives). Without the lib's dist/ + .d.ts
# in place, tsc fails to resolve `@atum-labs/ld-data-integrity` and
# build-ld-signing dies.
.PHONY: build-ld-data-integrity
build-ld-data-integrity:
	@echo "Building ld-data-integrity TypeScript package (shared W3C Data Integrity primitives)..."
	@cd declarations/common/ld-data-integrity/typescript && pnpm install && pnpm run build
	@echo "✅ ld-data-integrity TypeScript package built"

# Build the ld-signing TypeScript library. Pattern mirrors apis/build-*-ts.
.PHONY: build-ld-signing
build-ld-signing: build-ld-data-integrity
	@echo "Building ld-signing TypeScript package..."
	@cd declarations/FulfillmentQuote/v1/bindings/typescript/signing && pnpm install && pnpm run build
	@echo "✅ ld-signing TypeScript package built"

# Build the PaymentRequest ld-signing TypeScript library.
# Mirrors build-ld-signing — depends on the shared ld-data-integrity lib
# being built first (the PaymentRequest TS canonicalize/hash/jws delegate
# to its primitives).
.PHONY: build-payment-request-ld-signing
build-payment-request-ld-signing: build-ld-data-integrity
	@echo "Building payment-request-ld-signing TypeScript package..."
	@cd declarations/PaymentRequest/v1/bindings/typescript/signing && pnpm install && pnpm run build
	@echo "✅ payment-request-ld-signing TypeScript package built"

# Lint the FulfillmentQuote ld-verification Go module (sibling of the
# schema bindings) — its own Makefile owns go mod tidy + golangci-lint
# + verify-context. Listing it here keeps the schemas-tree lint
# self-contained rather than splitting it across the top-level Makefile.
# Driven from LD_VERIFICATION_MODULES rather than a second hand-kept list. The two lists had
# already drifted: AuthorizationResponse and PaymentRequestEnvelope were in the drift check but
# linted and tested by nothing, so each shipped a Makefile with a lint target no one invoked.
.PHONY: lint-ld-verification
lint-ld-verification:
	@echo "Linting ld-verification..."
	@for mod in $(LD_VERIFICATION_MODULES); do \
		echo "→ $$mod"; \
		$(MAKE) -C $$mod lint || exit 1; \
	done

# Test target - runs all tests
test:
	@echo "Running schema tests..."
	make -C apis test
	@for mod in $(LD_VERIFICATION_MODULES); do \
		echo "→ $$mod"; \
		$(MAKE) -C $$mod test || exit 1; \
	done
	pnpm --filter @atum-labs/ld-signing test
	pnpm --filter @atum-labs/payment-request-ld-signing test

# ── Proto (wire contracts) ───────────────────────────────────────────────────
# Each proto module owns its buf.yaml + buf.gen.yaml and a Makefile with
# lint/generate/check for its own committed bindings. These top-level targets fan
# out to those per-module Makefiles (the pattern schemas/ is moving toward), so a
# new proto module is added by dropping in its Makefile and listing it here.
PROTO_MODULE_DIRS := apis/settler-gateway/v1/session-stream declarations/message-bus/v1

lint-proto:
	@for d in $(PROTO_MODULE_DIRS); do $(MAKE) -C $$d lint || exit 1; done

generate-proto:
	@for d in $(PROTO_MODULE_DIRS); do $(MAKE) -C $$d generate || exit 1; done

check-proto:
	@for d in $(PROTO_MODULE_DIRS); do $(MAKE) -C $$d check || exit 1; done

# Wire compatibility against the baseline ref (default main; CI passes BREAKING_REF=origin/main).
breaking-proto:
	@for d in $(PROTO_MODULE_DIRS); do $(MAKE) -C $$d breaking || exit 1; done
