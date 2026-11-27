.PHONY: test test-fuzz lint update-context verify-context

CONTEXT_SRC := ../../../context.jsonld
CONTEXT_DST := contexts/authorization-response-context.jsonld

# FUZZTIME controls how long each fuzz function runs in active-fuzzing
# mode. CI overrides this for nightly discovery runs (e.g., FUZZTIME=5m).
FUZZTIME ?= 30s

test:
	go test ./...

# test-fuzz invokes Go's active-fuzzing mode for every Fuzz* function in
# this package. Each invocation can target only ONE function (a Go fuzz
# constraint), so add a line here when adding a new fuzz function.
# `-run=^$$` matches no regular tests, so this target ONLY fuzzes —
# unit tests already run via `make test`.
test-fuzz:
	go test -run=^$$ -fuzz=FuzzVerifyAuthorizationResponse -fuzztime=$(FUZZTIME) ./

lint:
	go mod tidy
	git diff --exit-code -- go.mod go.sum
	$(MAKE) verify-context
	golangci-lint run

update-context:
	cp $(CONTEXT_SRC) $(CONTEXT_DST)

verify-context:
	@diff -q $(CONTEXT_SRC) $(CONTEXT_DST) > /dev/null || ( \
		echo "context snapshot is stale; run 'make -C schemas/declarations/AuthorizationResponse/v1/signing/go update-context'"; \
		exit 1)
