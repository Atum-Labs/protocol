#!/usr/bin/env bash
# Cloud Agent install for the Atum Protocol monorepo.
#
# Prepares the full core development experience validated by CI:
#   - Go 1.24 default toolchain (Go + TypeScript + schema-guards + proto lanes)
#   - the pinned schema/codegen CLIs the schemas/ Makefiles shell out to
#   - the pnpm workspace dependencies
#
# It is idempotent: safe to run repeatedly and against a warm/cached tree.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Pinned to match CI (.github/workflows/ci.yml) and the go.mod `toolchain` lines.
GO_VERSION="1.24.11"
GOJQ_VERSION="v0.12.17"
GO_JSONSCHEMA_VERSION="v0.20.0"
OAPI_CODEGEN_VERSION="v2.5.1"
BUF_VERSION="v1.50.0"

# ── 1. Go 1.24 default toolchain ─────────────────────────────────────────────
# Several modules declare a two-component `go 1.24` / `go 1.25.0` directive with
# no `toolchain` line. The base image ships Go 1.22, which cannot resolve those
# via GOTOOLCHAIN=auto (it looks for a non-existent literal "go1.24" release), so
# CI runs an actual Go 1.24.x. Install it as the default; GOTOOLCHAIN stays
# `auto`, so the lone `go 1.25.0` module still auto-fetches its newer toolchain.
need_go=1
if command -v go >/dev/null 2>&1; then
  case "$(go env GOVERSION 2>/dev/null || echo none)" in
    go1.24.*|go1.25.*|go1.26.*) need_go=0 ;;
  esac
fi
if [ "$need_go" -eq 1 ]; then
  echo "Installing Go ${GO_VERSION}..."
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/go.tgz" "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz"
  sudo rm -rf /usr/local/go
  sudo tar -C /usr/local -xzf "$tmp/go.tgz"
  sudo ln -sf /usr/local/go/bin/go /usr/local/bin/go
  sudo ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
  rm -rf "$tmp"
fi
hash -r
go version

# ── 2. Schema / codegen CLIs ─────────────────────────────────────────────────
# The schemas/ Makefiles invoke these by bare name. Install to GOPATH/bin, then
# symlink onto PATH so the Make targets resolve them without any PATH juggling.
GOBIN_DIR="$(go env GOPATH)/bin"
export PATH="$PATH:$GOBIN_DIR"
echo "Installing pinned schema/codegen CLIs..."
go install "github.com/itchyny/gojq/cmd/gojq@${GOJQ_VERSION}"
go install "github.com/atombender/go-jsonschema@${GO_JSONSCHEMA_VERSION}"
go install "github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@${OAPI_CODEGEN_VERSION}"
go install "github.com/bufbuild/buf/cmd/buf@${BUF_VERSION}"
for tool in gojq go-jsonschema oapi-codegen buf; do
  sudo ln -sf "$GOBIN_DIR/$tool" "/usr/local/bin/$tool"
done

# ── 3. pnpm workspace ────────────────────────────────────────────────────────
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
fi
echo "Installing pnpm workspace (frozen lockfile)..."
pnpm install --frozen-lockfile

echo "✅ Atum Protocol dev environment ready."
