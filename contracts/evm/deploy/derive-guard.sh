#!/usr/bin/env bash
# Verify we are in a tree whose compiler settings reproduce the canonical bytecode.
set -uo pipefail
need() { # key expected
  got=$(forge config 2>/dev/null | grep -E "^$1 " | head -1 | sed 's/.*= *//' | tr -d '"')
  if [ "$got" = "$2" ]; then printf '  OK   %-28s %s\n' "$1" "$got"
  else printf '  FAIL %-28s got=%s expected=%s\n' "$1" "${got:-<unset>}" "$2"; return 1; fi
}
rc=0
need solc 0.8.27            || rc=1
need via_ir true            || rc=1
need optimizer true         || rc=1
need optimizer_runs 4294967295 || rc=1
need bytecode_hash none     || rc=1
need cbor_metadata false    || rc=1
need always_use_create_2_factory true || rc=1
if [ $rc -ne 0 ]; then
  echo
  echo "WRONG TREE. You are in: $(pwd)" >&2
  echo "cd into the vendored EVM project (contracts/evm/source) — its foundry.toml is what" >&2
  echo "makes the bytecode, and therefore the CREATE2 address, reproducible." >&2
  exit 1
fi
echo "  settings match — safe to derive"
