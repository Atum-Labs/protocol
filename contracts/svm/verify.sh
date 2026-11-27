#!/usr/bin/env bash
#
# Local verification for SVM contract changes. Builds the Anchor program, diffs
# the vendored IDL against the freshly built one, and asserts the program-sourced
# parity golden. This is the exact guard a path-filtered contracts/svm/** CI job
# will run once the monorepo follow-up wires it in. Until then it is a manual
# step: run it after changing the program's compute_*_hash, the encoders, or the
# vendored IDL, so a stale golden or IDL cannot slip through unnoticed.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$SCRIPT_DIR/source"
CHECK_IDL="$SCRIPT_DIR/bindings/typescript/escrow-encoding/scripts/check-idl.sh"

for tool in anchor cargo; do
  if ! command -v "$tool" > /dev/null 2>&1; then
    echo "ERROR: '$tool' not found. Install the Anchor and Rust toolchain to run this check." >&2
    exit 1
  fi
done

echo "==> Building the Anchor program ($REPO_DIR)"
(cd "$REPO_DIR" && anchor build)

echo "==> Diffing the vendored IDL against the build"
bash "$CHECK_IDL"

# A cargo filter that matches nothing exits 0 and prints "0 passed; 0 failed; N filtered out".
# This used to filter on `parity_golden`, which matches NO test — so this stage was a green light
# that verified nothing. Assert a non-zero count, and name the modules that actually exist.
run_tests() {   # <filter> <label>
  local filter="$1" label="$2" out ran
  echo "==> $label  (cargo test -p escrow $filter)"
  if ! out="$(cd "$REPO_DIR" && cargo test -p escrow "$filter" 2>&1)"; then
    printf '%s\n' "$out"
    echo "ERROR: $label FAILED." >&2
    exit 1
  fi
  # Sum across every test binary rather than trusting the first line.
  # Fields look like: test result: ok. 15 passed; 0 failed; ...  — note the trailing semicolon.
  ran="$(printf '%s\n' "$out" | awk '/^test result: ok\./ {for(i=1;i<NF;i++) if($(i+1) ~ /^passed/) s+=$i} END{print s+0}')"
  if [ "$ran" -eq 0 ]; then
    printf '%s\n' "$out" | tail -4
    echo "ERROR: filter '$filter' matched NO tests, so nothing was verified." >&2
    echo "       cargo exits 0 on an empty filter — a rename upstream turns this stage into a" >&2
    echo "       false green. Fix the filter rather than deleting this check." >&2
    exit 1
  fi
  echo "    $label: $ran test(s) passed"
}

run_tests hash_anchor_tests          "program-sourced hash anchors"
run_tests cross_vm_fee_parity_tests  "cross-VM fee parity"

echo "SVM contract verification complete."
