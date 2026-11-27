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

if [ ! -f "$TARGET_IDL" ] || [ ! -f "$TARGET_TYPES" ] || [ ! -f "$TARGET_IDL_FP" ] || [ ! -f "$TARGET_TYPES_FP" ]; then
  echo "Error: Anchor build artifacts not found."
  echo "  Expected: $TARGET_IDL"
  echo "  Expected: $TARGET_TYPES"
  echo "  Expected: $TARGET_IDL_FP"
  echo "  Expected: $TARGET_TYPES_FP"
  echo "Run 'anchor build' in $ANCHOR_DIR first."
  exit 1
fi

mkdir -p "$GENERATED_DIR"
cp "$TARGET_IDL" "$GENERATED_DIR/escrow.json"
cp "$TARGET_TYPES" "$GENERATED_DIR/escrow.ts"
cp "$TARGET_IDL_FP" "$GENERATED_DIR/fulfillment_proxy.json"
cp "$TARGET_TYPES_FP" "$GENERATED_DIR/fulfillment_proxy.ts"

echo "IDL synced to $GENERATED_DIR"
