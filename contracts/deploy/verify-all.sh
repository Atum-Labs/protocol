#!/usr/bin/env bash
# Run every contract-verification check across all three VMs, in order: EVM -> TVM -> SVM.
#
#   contracts/deploy/verify-all.sh                 # every offline check, all three VMs
#   contracts/deploy/verify-all.sh evm svm         # a subset, still in canonical order
#   contracts/deploy/verify-all.sh --deployed      # also verify what is LIVE (needs the env below)
#   contracts/deploy/verify-all.sh --allow-skip    # exit 0 even when stages could not run
#   contracts/deploy/verify-all.sh --list          # show the stages and exit
#
# A SKIPPED STAGE IS NOT A PASS. Default exit codes:
#   0  every selected stage RAN and passed
#   1  at least one stage FAILED
#   2  nothing failed, but some stage could not run (missing toolchain, no build, unset env)
# Exit 2 exists because a green run that silently verified nothing is indistinguishable from a
# real one — the same reason check-idl.sh has REQUIRE_IDL_CHECK. Pass --allow-skip to collapse
# 2 into 0 once you have read the skip reasons and accepted them.
#
# Deployed mode reads, per VM, and skips that VM's live check when unset:
#   EVM   EVM_ESCROW_ADDRESS + EVM_RPC_URL
#   TVM   TVM_ESCROW_ADDRESS + TVM_NETWORK (shasta|nile|mainnet)
#   SVM   ESCROW_ID + SOLANA_RPC_URL
set -uo pipefail
SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do
  _d="$(cd -P "$(dirname "$SELF")" && pwd)"
  SELF="$(readlink "$SELF")"
  case "$SELF" in /*) ;; *) SELF="$_d/$SELF" ;; esac
done
HERE="$(cd -P "$(dirname "$SELF")" && pwd)"     # contracts/deploy
ROOT="$(cd -P "$HERE/.." && pwd)"               # contracts

DEPLOYED=0; ALLOW_SKIP=0; LIST=0; VMS=()
for a in "$@"; do
  case "$a" in
    --deployed)   DEPLOYED=1 ;;
    --allow-skip) ALLOW_SKIP=1 ;;
    --list)       LIST=1 ;;
    evm|tvm|svm)  VMS+=("$a") ;;
    -h|--help)    sed -n '2,27p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done
# Canonical order is fixed regardless of the order given on the command line.
if [ ${#VMS[@]} -eq 0 ]; then VMS=(evm tvm svm); else
  ordered=(); for v in evm tvm svm; do for g in "${VMS[@]}"; do [ "$g" = "$v" ] && { ordered+=("$v"); break; }; done; done
  VMS=(${ordered[@]+"${ordered[@]}"})
fi

# NOTE: array expansions use ${A[@]+"${A[@]}"} — on bash 3.2 (the macOS system bash, and what
# this shebang resolves to there) "${A[@]}" on an EMPTY array is a fatal unbound variable
# under `set -u`. Do not "simplify" these back.
RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; CYA=$'\033[36m'; BLD=$'\033[1m'; OFF=$'\033[0m'
PASSED=0; FAILED=0; SKIPPED=0; ROWS=()
have() { command -v "$1" >/dev/null 2>&1; }

# `forge test --match-path <p>` EXITS 0 when p matches nothing: it prints "No tests found in
# project!" and stops. A deleted or renamed test file therefore reads as a pass. Require a
# non-zero count, for the same reason contracts/svm/verify.sh asserts its own.
forge_tests_must_run() {
  local path="$1" out ran
  out="$(forge test --match-path "$path" 2>&1)" || { printf '%s\n' "$out"; return 1; }
  printf '%s\n' "$out"
  # forge prints "... : 38 tests passed, 0 failed, ..." -- note the COMMA. Match a PREFIX, not an
  # exact token; an exact match on "passed" silently yields 0 and turns a real pass into a failure.
  ran="$(printf '%s\n' "$out" | awk '/tests passed/ {for(i=1;i<NF-1;i++) if($(i+1)=="tests" && $(i+2) ~ /^passed/) s+=$i} END{print s+0}')"
  if [ "${ran:-0}" -eq 0 ]; then
    echo "ERROR: this path matched NO tests, so nothing was verified. forge exits 0 on an empty" >&2
    echo "       match, which is indistinguishable from a real pass." >&2
    return 1
  fi
  echo "    $ran test(s) passed"
}

# stage <vm> <name> <workdir|-> <command...>
stage() {
  local vm="$1" name="$2" wd="$3"; shift 3
  printf '\n%s-- [%s] %s%s\n' "$CYA" "$vm" "$name" "$OFF"
  if [ "$LIST" -eq 1 ]; then ROWS+=("$vm|$name|listed"); return; fi
  local out rc
  out=$( { [ "$wd" = "-" ] || cd "$wd" || exit 97; "$@"; } 2>&1 ); rc=$?
  printf '%s\n' "$out" | sed 's/^/   /' | tail -25
  if [ "$rc" -eq 0 ]; then
    printf '   %sPASS%s %s\n' "$GRN" "$OFF" "$name"; PASSED=$((PASSED+1)); ROWS+=("$vm|$name|${GRN}PASS${OFF}")
  else
    printf '   %sFAIL%s %s (exit %s)\n' "$RED" "$OFF" "$name" "$rc"; FAILED=$((FAILED+1)); ROWS+=("$vm|$name|${RED}FAIL${OFF}")
  fi
}
# broken_tree <vm> <dir> <missing> — the checkout itself is incomplete. Report that ONCE rather
# than letting each stage fail on its own missing input: a vanished foundry.toml surfaces as seven
# wrong compiler settings, and a vanished test file surfaces as a PASS. Neither is what happened.
# Not hypothetical -- /tmp checkouts get reaped by the OS while still looking like a working repo,
# because .git and recently-touched files survive.
broken_tree() {
  local vm="$1" dir="$2" missing="$3"
  printf '\n%s-- [%s] tree integrity%s\n' "$CYA" "$vm" "$OFF"
  printf '   %sFAIL%s the checkout at %s is INCOMPLETE. Missing:\n' "$RED" "$OFF" "$dir"
  # $missing is UNQUOTED on purpose: callers pass one space-separated list of missing
  # relative paths (all literals in this file) and we want one per line. Quoting it
  # prints the whole list as a single row.
  # shellcheck disable=SC2086
  for f in $missing; do printf '        %s\n' "$f"; done
  printf '   Every %s check below would fail, or pass vacuously, on inputs that are absent.\n' "$vm"
  printf '   Skipping them. If this tree is under /tmp the OS reaper deletes by age; re-clone\n'
  printf '   somewhere durable and re-run bootstrap so the PATH commands follow it.\n'
  FAILED=$((FAILED+1)); ROWS+=("$vm|tree integrity|${RED}FAIL${OFF} — incomplete checkout")
}

# skip <vm> <name> <reason>
skip() {
  printf '\n%s-- [%s] %s%s\n   %sSKIP%s %s\n' "$CYA" "$1" "$2" "$OFF" "$YEL" "$OFF" "$3"
  SKIPPED=$((SKIPPED+1)); ROWS+=("$1|$2|${YEL}SKIP${OFF} — $3")
}

printf '%s%s== Atum contract verification — EVM -> TVM -> SVM%s\n' "$BLD" "$CYA" "$OFF"
printf 'selected: %s   deployed checks: %s\n' "${VMS[*]}" "$([ "$DEPLOYED" -eq 1 ] && echo on || echo off)"

for vm in "${VMS[@]}"; do
case "$vm" in

# ---------------------------------------------------------------------- EVM
evm)
  src="$ROOT/evm/source"
  if [ ! -d "$src" ]; then skip evm "all stages" "$src not present"; continue; fi
  miss=""
  for f in foundry.toml src/Escrow.sol test/EncodingExamples.verify.t.sol; do
    [ -f "$src/$f" ] || miss="$miss $f"
  done
  [ -n "$miss" ] && { broken_tree evm "$src" "$miss"; continue; }

  if have forge; then
    # derive-guard only reads foundry config, so it works in a dependency-free checkout.
    stage evm "compiler settings reproduce canonical bytecode" "$src" "$ROOT/evm/deploy/derive-guard.sh"

    # Anything that COMPILES needs the Solidity dependencies. Without them solc fails on
    # missing @openzeppelin imports, which surfaces as "Compilation failed" — indistinguishable
    # from genuinely broken code unless we look first. Reporting that as FAIL sends someone
    # hunting a bug when all they have is an un-installed checkout, so check and SKIP instead.
    if [ -d "$src/node_modules/@openzeppelin/contracts" ]; then
      # The source-of-truth typehash check: rebuilds each type string from the struct
      # declaration, so it does not pass when a member is renamed in lockstep with a copy.
      stage evm "source typehashes (EncodingExamples.verify.t.sol)" "$src" \
        forge_tests_must_run 'test/EncodingExamples.verify.t.sol'
    else
      skip evm "source typehashes" "Solidity deps not installed — run: (cd contracts/evm/source && pnpm install --ignore-workspace)"
    fi
  else
    skip evm "compiler settings" "forge not installed"
    skip evm "source typehashes" "forge not installed"
  fi

  art="$src/out/Escrow.sol/Escrow.json"
  if [ -f "$art" ]; then
    stage evm "compiled artifact pins widened witnesses" - "$HERE/assert-typehashes.sh" --artifact "$art"
  else
    skip evm "compiled artifact typehashes" "no build at ${art#$ROOT/} — run: (cd contracts/evm/source && forge build)"
  fi

  if [ "$DEPLOYED" -eq 1 ]; then
    if [ -n "${EVM_ESCROW_ADDRESS:-}" ] && [ -n "${EVM_RPC_URL:-}" ]; then
      stage evm "LIVE escrow pins widened witnesses" - \
        "$HERE/assert-typehashes.sh" --deployed "$EVM_ESCROW_ADDRESS" --rpc "$EVM_RPC_URL"
    else
      skip evm "LIVE escrow typehashes" "set EVM_ESCROW_ADDRESS and EVM_RPC_URL"
    fi
  fi
  ;;

# ---------------------------------------------------------------------- TVM
tvm)
  src="$ROOT/tvm/source"
  if [ ! -d "$src" ]; then skip tvm "all stages" "$src not present"; continue; fi
  miss=""
  for f in tronbox-config.js contracts/Escrow.sol docker/assert-widened-witnesses.js; do
    [ -f "$src/$f" ] || miss="$miss $f"
  done
  [ -n "$miss" ] && { broken_tree tvm "$src" "$miss"; continue; }
  art="$src/build/contracts/Escrow.json"

  # Portable artifact check first: needs only cast + python3, so it runs even where
  # node/tronweb are absent. This is what the forge test cannot cover — tronbox output.
  if [ -f "$art" ]; then
    stage tvm "compiled artifact pins widened witnesses (portable)" - \
      "$HERE/assert-typehashes.sh" --artifact "$art"
  else
    skip tvm "compiled artifact typehashes" "no build at ${art#$ROOT/} — run: (cd contracts/tvm/source && npx tronbox compile)"
  fi

  # The image-build guard. Same assertion, both directions (widened present, V1 absent).
  if [ -f "$art" ] && have node && [ -d "$src/node_modules/tronweb" ]; then
    stage tvm "image-build witness guard (assert-widened-witnesses.js)" "$src" \
      node docker/assert-widened-witnesses.js
  elif [ ! -f "$art" ]; then
    skip tvm "image-build witness guard" "needs a tronbox build first"
  else
    skip tvm "image-build witness guard" "needs node + tronweb (cd contracts/tvm/source && pnpm install)"
  fi

  # The permission_id signing path. A new sign-and-verify flow that only ever ran
  # by hand is a flow nobody notices breaking, and this one decides whether a
  # multisig-owned admin account can grant roles at all. The self-test is hermetic
  # (fullHost pinned to a closed port), so it belongs here, not behind --deployed.
  if [ -f "$ROOT/tvm/deploy/admin-preflight.js" ] && have node && [ -d "$src/node_modules/tronweb" ]; then
    stage tvm "permission_id signing path (admin-preflight --self-test)" "$ROOT/tvm/deploy" \
      node admin-preflight.js --self-test
  elif [ ! -f "$ROOT/tvm/deploy/admin-preflight.js" ]; then
    skip tvm "permission_id signing path" "contracts/tvm/deploy/admin-preflight.js not present"
  else
    skip tvm "permission_id signing path" "needs node + tronweb (cd contracts/tvm/source && pnpm install)"
  fi

  if [ "$DEPLOYED" -eq 1 ]; then
    if [ -n "${TVM_ESCROW_ADDRESS:-}" ] && [ -n "${TVM_NETWORK:-}" ] && have node; then
      # Recompiles and diffs against on-chain deployment bytecode.
      stage tvm "LIVE bytecode matches compiled (verify-contract.js)" "$src" \
        node scripts/verify-contract.js Escrow "$TVM_NETWORK" "$TVM_ESCROW_ADDRESS"
    else
      skip tvm "LIVE bytecode match" "set TVM_ESCROW_ADDRESS and TVM_NETWORK (needs node)"
    fi
  fi
  ;;

# ---------------------------------------------------------------------- SVM
svm)
  if [ ! -d "$ROOT/svm/source" ]; then skip svm "all stages" "$ROOT/svm/source not present"; continue; fi
  miss=""
  for f in Anchor.toml programs/escrow/src/lib.rs; do
    [ -f "$ROOT/svm/source/$f" ] || miss="$miss $f"
  done
  [ -f "$ROOT/svm/verify.sh" ] || miss="$miss ../verify.sh"
  # The vendored IDL is what check-idl.sh diffs against. If it is ABSENT the diff reports
  # "STALE", which reads as drift rather than as a missing file -- so treat absence as a broken
  # tree and leave "STALE" to mean what it says.
  for f in escrow.json escrow.ts fulfillment_proxy.json fulfillment_proxy.ts; do
    [ -f "$ROOT/svm/bindings/typescript/escrow-encoding/src/generated/$f" ] || miss="$miss generated/$f"
  done
  [ -n "$miss" ] && { broken_tree svm "$ROOT/svm/source" "$miss"; continue; }

  # verify.sh = anchor build + vendored-IDL diff + program-sourced parity golden.
  # REQUIRE_IDL_CHECK=1 so a missing target dir is fatal rather than a silent pass:
  # verify.sh anchor-builds immediately before the check, so absent artifacts mean a
  # broken build, not "nothing to compare".
  if have anchor && have cargo; then
    stage svm "anchor build + IDL parity + 21 program-sourced tests (verify.sh)" - \
      env REQUIRE_IDL_CHECK=1 bash "$ROOT/svm/verify.sh"
  else
    skip svm "verify.sh (build + IDL + golden)" "needs anchor and cargo"
  fi

  if [ "$DEPLOYED" -eq 1 ]; then
    if have solana && [ -n "${ESCROW_ID:-}" ] && [ -n "${SOLANA_RPC_URL:-}" ]; then
      stage svm "LIVE program + config readiness" - "$ROOT/svm/deploy/readiness.sh"
    else
      skip svm "LIVE program readiness" "set ESCROW_ID and SOLANA_RPC_URL (needs the solana CLI)"
    fi
  fi
  ;;
esac
done

# ---------------------------------------------------------------------- verdict
printf '\n%s%s== summary%s\n' "$BLD" "$CYA" "$OFF"
for r in ${ROWS[@]+"${ROWS[@]}"}; do
  IFS='|' read -r v n s <<<"$r"; printf '  %-4s %-52s %s\n' "$v" "$n" "$s"
done
[ "$LIST" -eq 1 ] && exit 0

printf '\n  %spassed %s   failed %s   skipped %s%s\n' "$BLD" "$PASSED" "$FAILED" "$SKIPPED" "$OFF"
if [ "$FAILED" -gt 0 ]; then
  printf '  %sNOT SIGNED OFF — %s check(s) failed.%s Fix them before deploying or committing.\n' "$RED" "$FAILED" "$OFF"
  exit 1
fi
if [ "$SKIPPED" -gt 0 ]; then
  printf '  %sINCOMPLETE — %s check(s) could not run, so this is NOT a full sign-off.%s\n' "$YEL" "$SKIPPED" "$OFF"
  printf '  Install what is missing or set the env above, then re-run. --allow-skip accepts it as-is.\n'
  [ "$ALLOW_SKIP" -eq 1 ] && { printf '  %s(--allow-skip given: exiting 0)%s\n' "$YEL" "$OFF"; exit 0; }
  exit 2
fi
printf '  %sALL CHECKS RAN AND PASSED — signed off across %s.%s\n' "$GRN" "${VMS[*]}" "$OFF"
exit 0
