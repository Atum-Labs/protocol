.PHONY: test lint update-context verify-context gen-conformance

CONTEXT_SRC := ../../../context.jsonld
CONTEXT_DST := contexts/settlement-result-context.jsonld

test:
	go test -race ./...

lint:
	go mod tidy
	git diff --exit-code -- go.mod go.sum
	$(MAKE) verify-context
	golangci-lint run

update-context:
	cp $(CONTEXT_SRC) $(CONTEXT_DST)

verify-context:
	@diff -q $(CONTEXT_SRC) $(CONTEXT_DST) > /dev/null || ( \
		echo "context snapshot is stale; run 'make -C schemas/declarations/SettlementResult/v1/bindings/go/signing update-context'"; \
		exit 1)

# Rewrites ../../../conformance/content-hash-golden.json from the vectors in conformance_test.go.
gen-conformance:
	go test -run '^TestConformance_Golden$$' -update ./
