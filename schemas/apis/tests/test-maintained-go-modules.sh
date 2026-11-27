#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/../../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# shellcheck source=lib/go-module-asserts.sh
source "$(dirname "$0")/lib/go-module-asserts.sh"
mode=${1:-go}
case "$mode" in
  go) apis=(veri-fill registration webhook) ;;
  full) apis=(veri-fill) ;;
  *) echo "usage: $0 [go|full]" >&2; exit 1 ;;
esac
fixture="$work/repo"
mkdir -p "$fixture"
# Include the workspace manifests and tools for full TS generation; exclude local build output.
git -C "$repo" ls-files -z -co --exclude-standard -- schemas contracts key-management tooling package.json pnpm-lock.yaml pnpm-workspace.yaml |
  (cd "$repo" && while IFS= read -r -d '' f; do
    if [ -e "$f" ] || [ -L "$f" ]; then printf '%s\0' "$f"; fi
  done) |
  (cd "$repo" && tar --null --no-recursion -T - -cf -) |
  (cd "$fixture" && tar -xf -)

select_api() {
  api=$1
  case "$api" in
    veri-fill|payment-gateway)
      binding="$api/v1/bindings/go"
      target="generate-$api"
      initializer="init-$api-go-module"
      ;;
    registration|webhook)
      binding="counterparty-gateway/v1/$api/bindings/go"
      target="generate-counterparty-gateway-$api"
      initializer="init-counterparty-gateway-$api-go-module"
      ;;
  esac
}

# A downgraded manifest that gets committed would pass every regeneration below,
# because the initializers keep an existing go.mod as is. Check the committed
# graphs against the seed versions directly.
if [ "$mode" = go ]; then
  for api in "${apis[@]}"; do
    select_api "$api"
    assert_minimum "$repo/schemas/apis/$binding" golang.org/x/crypto v0.55.0
    assert_minimum "$repo/schemas/apis/$binding" golang.org/x/net v0.58.0
    assert_minimum "$repo/schemas/apis/$binding" google.golang.org/protobuf v1.36.12
    assert_go_version "$repo/schemas/apis/$binding"
  done
  echo "PASS: committed graphs meet the seed versions"
fi

generate() {
  if ! make -C "$fixture/schemas/apis" "$1" > "$work/generate.log" 2>&1; then
    echo "FAIL: $1" >&2
    cat "$work/generate.log" >&2
    exit 1
  fi
}

snapshot() {
  mkdir -p "$work/$1/$api"
  cp -R "$fixture/schemas/apis/$binding/." "$work/$1/$api/"
}

compare() {
  diff -ru "$work/$1/$api" "$fixture/schemas/apis/$binding"
}

customize() {
  (
    cd "$fixture/schemas/apis/$binding"
    go mod edit -require=github.com/gin-gonic/gin@v1.11.0 \
      -replace=github.com/gin-gonic/gin=github.com/gin-gonic/gin@v1.11.0
    go mod tidy
  )
  printf '\n// maintained manifest marker\n' >> "$fixture/schemas/apis/$binding/go.mod"
}

assert_version() {
  local actual
  actual=$(cd "$fixture/schemas/apis/$binding" && go list -mod=mod -m -f '{{.Version}}' "$1")
  if [ "$actual" != "$2" ]; then
    echo "FAIL: $binding: $1 expected $2, got $actual" >&2
    exit 1
  fi
}

assert_bootstrap() {
  test -f "$fixture/schemas/apis/$binding/go.mod"
  test "$(cd "$fixture/schemas/apis/$binding" && go list -m -f '{{.GoVersion}}')" = 1.25.0
  assert_version golang.org/x/crypto v0.55.0
  assert_version golang.org/x/net v0.58.0
  assert_version google.golang.org/protobuf v1.36.12
  if [ "$api" = veri-fill ]; then
    assert_version github.com/gin-gonic/gin v1.10.1
    assert_version github.com/oapi-codegen/runtime v1.4.1
    assert_version filippo.io/edwards25519 v1.2.0
    assert_version github.com/decred/dcrd/dcrec/secp256k1/v4 v4.4.1
  else
    assert_version github.com/gin-gonic/gin v1.9.1
  fi
  if [ "$api" = webhook ]; then
    assert_version github.com/atum-labs/protocol/schemas/declarations/AuthorizationResponse/v1/bindings/go v0.1.1
    test "$(cd "$fixture/schemas/apis/$binding" && go list -m -f '{{.Replace.Path}}' github.com/atum-labs/protocol/schemas/declarations/AuthorizationResponse/v1/bindings/go)" = ../../../../../../declarations/AuthorizationResponse/v1/bindings/go
  fi
}

build_and_test() {
  (cd "$fixture/schemas/apis/$binding" && go build -mod=readonly ./... && go test -mod=readonly ./...)
}

go_only() {
  (
    export PATH="$work/go-bin"
    for tool in node pnpm; do
      if command -v "$tool" > /dev/null 2>&1; then
        echo "FAIL: Go-only fixture unexpectedly has $tool" >&2
        exit 1
      fi
    done
    generate generate-go-bindings
  )
}

if [ "$mode" = full ]; then
  if ! (cd "$fixture" && pnpm install --frozen-lockfile) > "$work/install.log" 2>&1; then
    cat "$work/install.log" >&2
    exit 1
  fi
  (cd "$fixture/schemas/apis/veri-fill/v1" && pnpm exec openapi-typescript --version)
  "$fixture/node_modules/.bin/openapi-ts" --version
fi

for api in "${apis[@]}"; do
  select_api "$api"
  customize
  snapshot preserve
  generate "$initializer"
  compare preserve
  echo "PASS: $api initialization preserves the existing manifest"
  if [ "$mode" = full ] || [ "$api" != veri-fill ]; then
    generate "$target"
    compare preserve
    echo "PASS: full $api generation preserves the maintained graph"
  fi
done

for api in "${apis[@]}"; do
  select_api "$api"
  rm "$fixture/schemas/apis/$binding/go.mod" "$fixture/schemas/apis/$binding/go.sum"
  if [ "$mode" = go ] && [ "$api" = veri-fill ]; then
    generate "$initializer"
  else
    generate "$target"
  fi
  assert_bootstrap
  if [ "$mode" = full ]; then build_and_test; fi
  echo "PASS: $api bootstraps the maintained graph"
done

if [ "$mode" = go ]; then
  mkdir -p "$work/go-bin"
  for tool in go oapi-codegen go-jsonschema make mkdir cp git ssh; do
    ln -s "$(command -v "$tool")" "$work/go-bin/$tool"
  done
  for api in "${apis[@]}"; do
    select_api "$api"
    cp "$repo/schemas/apis/$binding/go.mod" "$repo/schemas/apis/$binding/go.sum" "$fixture/schemas/apis/$binding/"
    customize
    snapshot go-preserve
  done
  go_only
  for api in "${apis[@]}"; do select_api "$api"; compare go-preserve; done
  echo "PASS: Go-only generation preserves all three graphs without Node"

  x402=x402/v1/bindings/go
  printf '\n// maintained manifest marker\n' >> "$fixture/schemas/apis/$x402/go.mod"
  mkdir -p "$work/x402"
  cp "$fixture/schemas/apis/$x402/go.mod" "$fixture/schemas/apis/$x402/go.sum" "$work/x402/"
  go_only
  cmp "$work/x402/go.mod" "$fixture/schemas/apis/$x402/go.mod"
  cmp "$work/x402/go.sum" "$fixture/schemas/apis/$x402/go.sum"
  echo "PASS: Go-only generation preserves the x402 manifest"

  rm "$fixture/schemas/apis/$x402/go.mod" "$fixture/schemas/apis/$x402/go.sum"
  go_only
  test "$(cd "$fixture/schemas/apis/$x402" && go list -m -f '{{.GoVersion}}')" = 1.24
  binding=$x402
  assert_version github.com/go-viper/mapstructure/v2 v2.5.0
  echo "PASS: Go-only generation bootstraps x402 with its seed versions"

  # auth pins gin and the oapi-codegen runtime for its consumers. A bump made
  # only in go.mod must show up as drift in the Go-only run, not wait for the
  # next full generate-auth to revert it.
  auth=auth/v1/bindings/go
  (
    cd "$fixture/schemas/apis/$auth"
    go mod edit -require=github.com/gin-gonic/gin@v1.11.0
    go mod tidy
  )
  cp "$fixture/schemas/apis/$auth/go.mod" "$work/auth-bumped.mod"
  go_only
  if cmp -s "$work/auth-bumped.mod" "$fixture/schemas/apis/$auth/go.mod"; then
    echo "FAIL: Go-only generation kept a gin bump made only in auth's go.mod" >&2
    exit 1
  fi
  binding=$auth
  assert_version github.com/gin-gonic/gin v1.10.1
  assert_version github.com/oapi-codegen/runtime v1.4.1
  echo "PASS: Go-only generation flags a go.mod-only bump of auth's pins"

  for api in "${apis[@]}"; do
    select_api "$api"
    rm "$fixture/schemas/apis/$binding/go.mod" "$fixture/schemas/apis/$binding/go.sum"
    go_only
    assert_bootstrap
    build_and_test
    echo "PASS: Go-only generation bootstraps $api without Node"
  done
fi

for api in "${apis[@]}"; do
  select_api "$api"
  cp "$fixture/schemas/apis/$binding/go.mod" "$work/valid.mod"
  printf 'not-a-go-module\n' > "$fixture/schemas/apis/$binding/go.mod"
  cp "$fixture/schemas/apis/$binding/go.mod" "$work/invalid.mod"
  generate "$initializer"
  cmp "$work/invalid.mod" "$fixture/schemas/apis/$binding/go.mod"
  if make -C "$fixture/schemas/apis" "$target" > "$work/invalid.log" 2>&1; then
    echo "FAIL: $api generation accepted a malformed manifest" >&2
    exit 1
  fi
  grep -q 'unknown directive: not-a-go-module' "$work/invalid.log"
  cmp "$work/invalid.mod" "$fixture/schemas/apis/$binding/go.mod"
  cp "$work/valid.mod" "$fixture/schemas/apis/$binding/go.mod"
  echo "PASS: $api preserves malformed input and reports the Go error"
done

if [ "$mode" = full ]; then
  select_api veri-fill
  snapshot repeat
  generate "$target"
  compare repeat
  echo "PASS: repeated full Veri-Fill generation is byte-identical"
  generate clean
  generate "$target"
  compare repeat
  echo "PASS: clean and full Veri-Fill generation retain its Go module"

  fc=fulfillment-confirmation/v1/bindings/go
  printf '\n// maintained manifest marker\n' >> "$fixture/schemas/apis/$fc/go.mod"
  cp "$fixture/schemas/apis/$fc/go.mod" "$work/fc.mod"
  generate generate-fulfillment-confirmation
  cmp "$work/fc.mod" "$fixture/schemas/apis/$fc/go.mod"
  echo "PASS: full fulfillment-confirmation generation preserves its manifest"
  rm "$fixture/schemas/apis/$fc/go.mod"
  generate generate-fulfillment-confirmation
  test "$(cd "$fixture/schemas/apis/$fc" && go list -m -f '{{.GoVersion}}')" = 1.24
  echo "PASS: full fulfillment-confirmation generation bootstraps its module"
fi

if [ "$mode" = go ]; then
  for api in "${apis[@]}"; do select_api "$api"; snapshot repeat; done
  go_only
  for api in "${apis[@]}"; do select_api "$api"; compare repeat; done
  echo "PASS: repeated Go-only generation is byte-identical"

  for api in "${apis[@]}" payment-gateway; do
    select_api "$api"
    snapshot clean
  done
  cp "$fixture/schemas/apis/fulfillment-confirmation/v1/bindings/go/go.mod" "$work/clean/fulfillment-confirmation.mod"
  cp "$fixture/schemas/apis/payment-gateway/v1/openapi.yaml" "$work/clean/payment-gateway-openapi.yaml"
  generate clean
  for api in "${apis[@]}" payment-gateway; do
    select_api "$api"
    cmp "$work/clean/$api/go.mod" "$fixture/schemas/apis/$binding/go.mod"
    cmp "$work/clean/$api/go.sum" "$fixture/schemas/apis/$binding/go.sum"
  done
  echo "PASS: clean retains all four maintained manifests"
  cmp "$work/clean/fulfillment-confirmation.mod" "$fixture/schemas/apis/fulfillment-confirmation/v1/bindings/go/go.mod"
  echo "PASS: clean retains the fulfillment-confirmation manifest"
  cmp "$work/clean/payment-gateway-openapi.yaml" "$fixture/schemas/apis/payment-gateway/v1/openapi.yaml"
  echo "PASS: clean retains the hand-maintained payment-gateway spec"
fi
