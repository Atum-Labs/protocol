#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/../../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
binding=schemas/apis/payment-gateway/v1/bindings/go
# shellcheck source=lib/go-module-asserts.sh
source "$(dirname "$0")/lib/go-module-asserts.sh"

# Copies tracked and unignored files only, so local build output (Anchor
# target/, Foundry out/, submodule checkouts) stays out of the fixture.
# Paths deleted in the working tree are skipped so tar does not fail on them.
fixture() {
  mkdir -p "$work/$1"
  git -C "$repo" ls-files -z -co --exclude-standard -- schemas contracts key-management |
    (cd "$repo" && while IFS= read -r -d '' f; do
      if [ -e "$f" ] || [ -L "$f" ]; then printf '%s\0' "$f"; fi
    done) |
    (cd "$repo" && tar --null --no-recursion -T - -cf -) |
    (cd "$work/$1" && tar -xf -)
}

generate() {
  if ! make -C "$work/$1/schemas/apis" "$2" > "$work/generate.log" 2>&1; then
    cat "$work/generate.log" >&2
    exit 1
  fi
}

fixture preserve
(
  cd "$work/preserve/$binding"
  go mod edit -require=golang.org/x/crypto@v0.55.0
)
generate preserve generate-payment-gateway
actual=$(cd "$work/preserve/$binding" && go list -m -f '{{.Version}}' golang.org/x/crypto)
if [ "$actual" != v0.55.0 ]; then
  echo "generation downgraded golang.org/x/crypto: expected v0.55.0, got $actual" >&2
  exit 1
fi
echo "PASS: full generation preserves an existing patched requirement"

cp -R "$work/preserve/$binding" "$work/expected-binding"
cp -R "$work/preserve/schemas/apis/payment-gateway/v1/embed/go" "$work/expected-embed"

generate preserve generate-go-bindings
actual=$(cd "$work/preserve/$binding" && go list -m -f '{{.Version}}' golang.org/x/crypto)
if [ "$actual" != v0.55.0 ]; then
  echo "Go-only generation downgraded golang.org/x/crypto: expected v0.55.0, got $actual" >&2
  exit 1
fi
echo "PASS: Go-only generation preserves an existing higher requirement"

for target in generate-payment-gateway generate-go-bindings; do
  generate preserve "$target"
  diff -ru "$work/expected-binding" "$work/preserve/$binding"
  diff -ru "$work/expected-embed" "$work/preserve/schemas/apis/payment-gateway/v1/embed/go"
done
echo "PASS: repeated full and Go-only generation is byte-identical"

generate preserve clean
for manifest in go.mod go.sum; do
  if ! cmp -s "$work/expected-binding/$manifest" "$work/preserve/$binding/$manifest"; then
    echo "clean removed or changed the maintained $manifest" >&2
    exit 1
  fi
done
echo "PASS: clean keeps the maintained manifest"

assert_minimum "$repo/$binding" golang.org/x/crypto v0.52.0
echo "PASS: committed graph meets the crypto security floor"

assert_minimum "$repo/$binding" golang.org/x/net v0.55.0
echo "PASS: committed graph meets the net security floor"

assert_minimum "$repo/$binding" google.golang.org/protobuf v1.33.0
echo "PASS: committed graph meets the protobuf security floor"
assert_go_version "$repo/$binding"

fixture bootstrap
rm "$work/bootstrap/$binding/go.mod" "$work/bootstrap/$binding/go.sum"
generate bootstrap generate-payment-gateway
actual=$(cd "$work/bootstrap/$binding" && go list -m -f '{{.Version}}' github.com/atum-labs/protocol/schemas/apis/error/v1/bindings/go)
if [ "$actual" != v0.1.2 ]; then
  echo "bootstrap must require published error v0.1.2, got $actual" >&2
  exit 1
fi
echo "PASS: fresh generation requires the published error module"

assert_minimum "$work/bootstrap/$binding" golang.org/x/crypto v0.52.0
assert_minimum "$work/bootstrap/$binding" golang.org/x/net v0.55.0
assert_minimum "$work/bootstrap/$binding" google.golang.org/protobuf v1.33.0
assert_go_version "$work/bootstrap/$binding"
echo "PASS: fresh generation meets the security floors"

rm "$work/bootstrap/$binding/go.mod" "$work/bootstrap/$binding/go.sum"
generate bootstrap generate-go-bindings
assert_minimum "$work/bootstrap/$binding" golang.org/x/crypto v0.52.0
assert_minimum "$work/bootstrap/$binding" golang.org/x/net v0.55.0
assert_minimum "$work/bootstrap/$binding" google.golang.org/protobuf v1.33.0
assert_go_version "$work/bootstrap/$binding"
echo "PASS: Go-only generation bootstraps the patched graph"
