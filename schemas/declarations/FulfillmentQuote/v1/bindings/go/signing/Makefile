.PHONY: test lint update-context verify-context gen-conformance-fixtures

# Snapshot pairs (SRC → DST). Each row pins one canonical .jsonld into
# this lib's go:embed-rooted contexts/ dir. update-context copies SRC
# over DST; verify-context fails CI if any pair has drifted.
#
# The generic cryptosuite + W3C VC v1 + known-to-atum
# contexts are owned by the shared ld-data-integrity library and resolved
# through its DocumentLoader. Only FQ's declaration-specific contexts remain
# embedded here.
#
# CONTEXT_PAIRS is whitespace-separated; each pair joined by `=`.
CONTEXT_PAIRS := \
	../../../context.jsonld=contexts/fulfillment-quote-context.jsonld \
	../../../../../FulfillmentQuoteEnvelope/v1/context.jsonld=contexts/fulfillment-quote-envelope-context.jsonld

test:
	go test ./...

lint:
	go mod tidy
	git diff --exit-code -- go.mod go.sum
	$(MAKE) verify-context
	golangci-lint run

update-context:
	@for pair in $(CONTEXT_PAIRS); do \
		src="$${pair%%=*}"; dst="$${pair##*=}"; \
		cp "$$src" "$$dst"; \
	done

verify-context:
	@for pair in $(CONTEXT_PAIRS); do \
		src="$${pair%%=*}"; dst="$${pair##*=}"; \
		diff -q "$$src" "$$dst" > /dev/null || ( \
			echo "context snapshot is stale ($$dst); run 'make -C schemas/declarations/FulfillmentQuote/v1/signing/go update-context'"; \
			exit 1); \
	done

# Regenerate the Go halves of the cross-language conformance fixtures.
# Pair this with `pnpm --filter @atum-labs/ld-signing run
# gen-conformance-fixtures` to regenerate the TS halves; the
# conformance/README.md spells out the full flow.
gen-conformance-fixtures:
	go run ./cmd/gen-conformance-fixtures
