.PHONY: test lint update-context verify-context

# Snapshot pairs (SRC → DST). Each row pins one canonical .jsonld into this
# lib's go:embed-rooted contexts/ dir, because go:embed cannot reach outside
# the package directory. update-context copies SRC over DST; verify-context
# fails CI if any pair has drifted.
#
# This module is listed in schemas/Makefile LD_VERIFICATION_MODULES, which is
# what makes verify-context actually run in CI. A snapshot that is not listed
# there is ungated, and drift in it would change what the envelope signature
# is computed over.
# No snapshot here any more: it moved to the bindings package, which is what
# verifiers import. This module has nothing of its own to verify, so the pair
# list is empty and verify-context is a no-op that stays for interface parity
# with the other LD_VERIFICATION_MODULES.
CONTEXT_PAIRS :=

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
			echo "context snapshot is stale ($$dst); run 'make -C schemas/declarations/PaymentRequestEnvelope/v1/bindings/go/signing update-context'"; \
			exit 1); \
	done
