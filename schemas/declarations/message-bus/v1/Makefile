# Wire (proto) contracts for this module. Owns `buf lint` + `buf generate` and the
# drift check on the committed bindings/. Requires buf on PATH (locally:
# go install github.com/bufbuild/buf/cmd/buf@v1.50.0). The top-level schemas/Makefile
# fans its proto targets out to this via `make -C`.
.PHONY: lint generate check breaking

BUF_INSTALL := go install github.com/bufbuild/buf/cmd/buf@v1.50.0
BREAKING_REF ?= main

lint:
	@command -v buf >/dev/null || { echo "✗ buf not found. Install: $(BUF_INSTALL)"; exit 1; }
	@buf lint
	@echo "✅ proto lint clean ($(notdir $(CURDIR)))"

generate:
	@command -v buf >/dev/null || { echo "✗ buf not found. Install: $(BUF_INSTALL)"; exit 1; }
	@buf generate
	@echo "✅ proto bindings generated ($(notdir $(CURDIR)))"

check: lint generate
	@if [ -n "$$(git status --porcelain bindings)" ]; then \
		echo "❌ proto bindings out of date! Run 'make generate' here and commit."; \
		git status --porcelain bindings; \
		exit 1; \
	fi
	@echo "✅ proto bindings up to date ($(notdir $(CURDIR)))"

# Wire-compatibility check against the contract as committed on the baseline ref (buf.yaml
# selects the rule set). Override BREAKING_REF where no local `main` exists, e.g. in CI:
#   make breaking BREAKING_REF=origin/main
breaking:
	@command -v buf >/dev/null || { echo "✗ buf not found. Install: $(BUF_INSTALL)"; exit 1; }
	@root="$$(git rev-parse --show-toplevel)"; subdir="$$(git rev-parse --show-prefix)"; \
	buf breaking --against "$$root/.git#ref=$(BREAKING_REF),subdir=$${subdir%/}"
	@echo "✅ proto wire-compatible with $(BREAKING_REF) ($(notdir $(CURDIR)))"
