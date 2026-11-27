.PHONY: test lint

test:
	go test ./...

lint:
	go mod tidy
	git diff --exit-code -- go.mod go.sum
	golangci-lint run
