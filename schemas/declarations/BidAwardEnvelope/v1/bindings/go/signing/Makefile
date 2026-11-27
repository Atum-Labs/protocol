.PHONY: test lint

# The award-hash Go module is a pure keccak256 over ethers-style primitives
# (no JSON-LD contexts), so unlike the ld-verification signing modules it has
# no verify-context step. Its conformance_test.go pins ComputeAwardHash to the
# frozen vectors in ../../../conformance/award-hash-golden.json (the same file the
# TS port asserts against).

test:
	go test ./...

lint:
	go mod tidy
	git diff --exit-code -- go.mod go.sum
	golangci-lint run
