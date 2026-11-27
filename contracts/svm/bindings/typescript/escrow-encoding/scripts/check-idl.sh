#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"
ANCHOR_DIR="$PKG_DIR/../../../source"
TARGET_IDL="$ANCHOR_DIR/target/idl/escrow.json"
TARGET_TYPES="$ANCHOR_DIR/target/types/escrow.ts"
TARGET_IDL_FP="$ANCHOR_DIR/target/idl/fulfillment_proxy.json"
TARGET_TYPES_FP="$ANCHOR_DIR/target/types/fulfillment_proxy.ts"
GENERATED_DIR="$PKG_DIR/src/generated"

if [ ! -d "$ANCHOR_DIR/target" ]; then
  # Locally this is a convenience: you have not built, so there is nothing to compare
  # against. In CI it must NOT be a pass — a green "check" that verified nothing is
  # indistinguishable from a real one. CI anchor-builds immediately before calling this,
  # so a missing target dir there means the build silently stopped producing artifacts.
  # Callers that guarantee a preceding build set REQUIRE_IDL_CHECK=1 to make that fatal.
  if [ "${REQUIRE_IDL_CHECK:-0}" = "1" ]; then
    echo "ERROR: REQUIRE_IDL_CHECK=1 but the Anchor target directory is missing ($ANCHOR_DIR/target)." >&2
    echo "A preceding 'anchor build'/'anchor test' was expected to produce it. Refusing to report" >&2
    echo "success without actually comparing the committed IDL against a fresh build." >&2
    exit 1
  fi
  echo "Skipping IDL check: Anchor target directory not found (run 'anchor build' first)."
  echo "NOTE: nothing was verified. Set REQUIRE_IDL_CHECK=1 to make this state an error."
  exit 0
fi

# Target dir exists, so a build was attempted: fail closed if any artifact is
# missing rather than silently passing on a partial or broken build.
if [ ! -f "$TARGET_IDL" ] || [ ! -f "$TARGET_TYPES" ] || [ ! -f "$TARGET_IDL_FP" ] || [ ! -f "$TARGET_TYPES_FP" ]; then
  echo "ERROR: Anchor target exists but a generated IDL or types file is missing (incomplete build)." >&2
  echo "Expected $TARGET_IDL, $TARGET_TYPES, $TARGET_IDL_FP and $TARGET_TYPES_FP. Re-run 'anchor build'." >&2
  exit 1
fi

STALE=0

if ! diff -q "$GENERATED_DIR/escrow.json" "$TARGET_IDL" > /dev/null 2>&1; then
  echo "STALE: src/generated/escrow.json differs from target/idl/escrow.json"
  STALE=1
fi

if ! diff -q "$GENERATED_DIR/escrow.ts" "$TARGET_TYPES" > /dev/null 2>&1; then
  echo "STALE: src/generated/escrow.ts differs from target/types/escrow.ts"
  STALE=1
fi

if ! diff -q "$GENERATED_DIR/fulfillment_proxy.json" "$TARGET_IDL_FP" > /dev/null 2>&1; then
  echo "STALE: src/generated/fulfillment_proxy.json differs from target/idl/fulfillment_proxy.json"
  STALE=1
fi

if ! diff -q "$GENERATED_DIR/fulfillment_proxy.ts" "$TARGET_TYPES_FP" > /dev/null 2>&1; then
  echo "STALE: src/generated/fulfillment_proxy.ts differs from target/types/fulfillment_proxy.ts"
  STALE=1
fi

if [ "$STALE" -eq 1 ]; then
  echo "Run 'npm run sync-idl' to update generated files."
  exit 1
fi

echo "IDL is up to date."
