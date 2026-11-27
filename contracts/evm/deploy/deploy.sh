#!/usr/bin/env bash
# v4 EVM deploy driver — all active testnet chains, one pass.
#
#   NETWORK=testnet contracts/evm/deploy/deploy.sh                 # SIMULATE everything (default, no funds moved)
#   NETWORK=testnet contracts/evm/deploy/deploy.sh --broadcast     # actually deploy (prompts once)
#   CHAINS="84532 421614" NETWORK=testnet contracts/evm/deploy/deploy.sh --broadcast    # subset
#
# NETWORK (testnet|mainnet) is required, and every CHAIN_TABLE chain must belong to it (networks.sh).
#
# Per chain: preflight -> skip-if-already-deployed -> deploy EscrowReserveLib (CREATE2) -> deploy -> verify vs predicted address.
# The escrow is linked to that library at its CREATE2 address; see escrow-lib.sh for why that matters.
# Failures are logged per chain and do NOT abort the run; the summary at the end is authoritative.
set -uo pipefail
# Resolve through symlinks: invoked via a PATH symlink, BASH_SOURCE points at the LINK, so
# ../source would resolve next to ~/.local/bin instead of next to the real script. Every other
# driver here already does this; these three did not, so their installed names never worked.
SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do
  _d="$(cd -P "$(dirname "$SELF")" && pwd)"
  SELF="$(readlink "$SELF")"
  case "$SELF" in /*) ;; *) SELF="$_d/$SELF" ;; esac
done
HERE="$(cd -P "$(dirname "$SELF")" && pwd)"
# NETWORK selects the environment, exactly as run-all.sh does, so `NETWORK=mainnet <cmd>` works
# standalone instead of requiring a manual `set -a; . mainnet.env; set +a` first. Values already
# exported by the caller win: every assignment in those files is `: "${VAR:=...}"`.
# shellcheck source=networks.sh
. "$HERE/networks.sh"
require_network
ENVF="${ENVF:-$HERE/$NETWORK.env}"
[ -f "$ENVF" ] && { set -a; . "$ENVF"; set +a; }


: "${SRC_DIR:=$(cd "$HERE/../source" 2>/dev/null && pwd)}"
[ -n "$SRC_DIR" ] || { echo "cannot resolve ../source from $HERE" >&2; exit 1; }
# The keystore is fixed by the network: atum-deployer-testnet or atum-deployer-mainnet.
ACCOUNT="atum-deployer-$NETWORK"
: "${DEPLOYER:=}"
: "${SALT:=}"
: "${PERMIT2_ADDRESS:=0x000000000022D473030F116dDEE9F6B43aC78BA3}"
: "${FACTORY:=0x4e59b44847b379578588920ca78fbf26c0b4956c}"

# DEPLOYER and SALT have no default on purpose. They used to default to the TESTNET deployer and
# salt, which meant an unsourced run printed a plausible deployer, a plausible salt and plausible
# CREATE2 addresses -- and would have broadcast against them. There is no value that is safe to
# guess here: DEPLOYER goes into the initcode as defaultAdmin, so it and SALT together determine
# the addresses. PERMIT2_ADDRESS and FACTORY keep defaults because both are the same constant on
# every chain we deploy to.
for v in DEPLOYER SALT; do
  eval "val=\${$v:-}"
  [ -n "$val" ] && continue
  echo "$v is not set." >&2
  echo "  Source the environment for your target first:" >&2
  echo "    set -a; . \"\$(dirname \"\$0\")/testnet.env\"; set +a     # or mainnet.env" >&2
  echo "  Or run through the orchestrator, which does it for you:" >&2
  echo "    NETWORK=testnet run-all.sh --check" >&2
  exit 2
done
: "${ESCROW_BYTES:=23890}"
# Roles default to the deployer (v3 precedent for testnet). Override for mainnet.
: "${ESCROW_PAUSER_ADDRESS:=$DEPLOYER}"
: "${ESCROW_TREASURER_ADDRESS:=$DEPLOYER}"
: "${ESCROW_TOKEN_CONFIG_ADDRESS:=$DEPLOYER}"
: "${FP_PAUSER_ADDRESS:=$DEPLOYER}"
# DEPLOY_PROXY=0 deploys the Escrow (and its library) ONLY, for a chain whose FulfillmentProxy is already
# there. A tree built after the v4 deploys no longer derives the v4 proxy (authorizeFulfillment changed its
# bytecode, so its CREATE2 address differs), so deploying "both" would add a second, unpinned proxy next to the
# live one, and the chain reads FRESH rather than as having a proxy. A new escrow generation next to a deployed
# v4 proxy (CORE-3055, Moderato) is exactly that case: FPROXY names the live proxy and is only checked for code.
: "${DEPLOY_PROXY:=1}"
case "$DEPLOY_PROXY" in 0|1) ;; *) echo "DEPLOY_PROXY must be 0 or 1, got '$DEPLOY_PROXY'" >&2; exit 2 ;; esac
if [ "$DEPLOY_PROXY" = 0 ] && [ -z "${FPROXY:-}" ]; then
  echo "DEPLOY_PROXY=0 reuses the chain's live FulfillmentProxy, so FPROXY must name it (testnet.env and" >&2
  echo "mainnet.env export it). With none named nothing would notice a chain that has no proxy." >&2
  exit 2
fi

OUT="${OUT:-$HOME/atum-v4-deploy-run}"
LOGS="$OUT/logs"; mkdir -p "$LOGS"
ADDR_JSON="$OUT/addresses.json"; SUMMARY="$OUT/summary.tsv"

# Looking only at $1 meant `deploy.sh --yes --broadcast` simulated and printed SIMULATED
# without saying the flag was not understood. The TVM driver refuses unknown arguments
# for the same reason.
BROADCAST=0
case "${1:-}" in
  --broadcast)          BROADCAST=1 ;;
  ''|--dry|--simulate)  ;;
  *) echo "unknown argument: $1" >&2; echo "usage: deploy.sh [--dry | --broadcast]" >&2; exit 2 ;;
esac
[ $# -gt 1 ] && { echo "unexpected extra arguments: ${*:2}" >&2; exit 2; }

# chainid|name|rpc
# The chain set comes from the env file (testnet.env / mainnet.env), which is the single place it
# is defined. Each driver used to carry its own copy of the testnet seven as a fallback -- four
# copies, and they had drifted to two different behaviours: three defaulted missing RPCs to public
# endpoints while run-all.sh hard-failed on them. Requiring it removes both the duplication and the
# disagreement.
[ -n "${CHAIN_TABLE:-}" ] || {
  echo "CHAIN_TABLE is not set, so there is no chain set to iterate." >&2
  echo "  It is exported by testnet.env and mainnet.env; source one for your target:" >&2
  echo "    set -a; . \"$HERE/testnet.env\"; set +a          # or mainnet.env" >&2
  echo "  Or set NETWORK=testnet|mainnet and let this script source it." >&2
  exit 2; }
CHAIN_TABLE="$CHAIN_TABLE"
require_chain_table_matches_network

cd "$SRC_DIR" || { echo "SRC_DIR not found: $SRC_DIR" >&2; exit 1; }

# --- settings guard: a wrong tree silently changes the address, so refuse early ---
chk() { got=$(forge config 2>/dev/null | grep -E "^$1 " | head -1 | sed 's/.*= *//' | tr -d '"')
        [ "$got" = "$2" ] || { echo "  foundry config $1=$got expected $2" >&2; return 1; }; }
if ! { chk solc 0.8.27 && chk via_ir true && chk optimizer true \
    && chk optimizer_runs 4294967295 && chk bytecode_hash none && chk cbor_metadata false; }; then
  echo "REFUSING: $SRC_DIR is not the vendored EVM project — bytecode and address would be wrong." >&2
  exit 1
fi

# --- derive the expected addresses once ---
# Everything below needs the Solidity dependencies. Without them solc reports a wall of
# "Source not found" and this exits on the || below, which reads like a tooling fault rather
# than an un-installed checkout. Say which it is.
if [ ! -d "$SRC_DIR/node_modules/@openzeppelin/contracts" ]; then
  echo "Solidity dependencies are not installed in $SRC_DIR." >&2
  echo "  Run: (cd $SRC_DIR && pnpm install --ignore-workspace)" >&2
  echo "  The --ignore-workspace flag is mandatory; this tree is not a workspace package." >&2
  exit 1
fi
# The Escrow initcode is hashed LINKED: it embeds EscrowReserveLib's CREATE2 address, so the escrow's
# own address depends on the library's. The unlinked bytecode is not even hex.
. "$HERE/escrow-lib.sh"
derive_escrow_link || { echo "REFUSING: could not link Escrow to EscrowReserveLib" >&2; exit 1; }
FP_BC=""; [ "$DEPLOY_PROXY" = 1 ] && { FP_BC=$(forge inspect src/FulfillmentProxy.sol:FulfillmentProxy bytecode) || exit 1; }
n=$(( (${#ESC_BC}-2)/2 ))
[ "$n" -eq "$ESCROW_BYTES" ] || { echo "REFUSING: Escrow is $n bytes, expected $ESCROW_BYTES" >&2; exit 1; }
ESC_H=$(cast keccak "${ESC_BC}$(cast abi-encode 'c(address,address)' "$PERMIT2_ADDRESS" "$DEPLOYER" | cut -c3-)")
FP_H=""; [ "$DEPLOY_PROXY" = 1 ] && FP_H=$(cast keccak  "${FP_BC}$(cast abi-encode 'c(address)' "$DEPLOYER" | cut -c3-)")
WANT_ESC=$(create2_address "$FACTORY" "$SALT" "$ESC_H")
WANT_FP=""; [ "$DEPLOY_PROXY" = 1 ] && WANT_FP=$(create2_address "$FACTORY" "$SALT" "$FP_H")
[ -n "$WANT_ESC" ] && { [ -n "$WANT_FP" ] || [ "$DEPLOY_PROXY" = 0 ]; } || { echo "REFUSING: could not derive the CREATE2 addresses" >&2; exit 1; }
# Read by DeployAndConfigureAllRoles (via EscrowLinkCheck): it reverts when the deployed Escrow does not
# embed this address, which is what a forgotten --libraries produces. Unset for a tree with no library.
if [ -n "$WANT_LIB" ]; then export ESCROW_RESERVE_LIB_ADDRESS="$WANT_LIB"; else unset ESCROW_RESERVE_LIB_ADDRESS; fi

echo "tree      : $SRC_DIR"
echo "deployer  : $DEPLOYER   (keystore '$ACCOUNT')"
echo "salt      : $SALT"
[ -n "$WANT_LIB" ] && echo "expect    : Library $WANT_LIB   (EscrowReserveLib, deployed first, linked into the Escrow)"
echo "$([ -n "$WANT_LIB" ] && echo '            ' || echo 'expect    : ')Escrow $WANT_ESC"
if [ "$DEPLOY_PROXY" = 1 ]; then echo "            FProxy $WANT_FP"
else echo "            FProxy not deployed (DEPLOY_PROXY=0): the chain's live proxy at FPROXY ($FPROXY) is reused"; fi

# --- pin the derivation against intent -------------------------------------------------
# WANT_* is derived from $SALT, $DEPLOYER and the compiled initcode. That makes it
# self-consistent BY CONSTRUCTION: if the salt or the deployer is wrong, the expectation is
# wrong in exactly the same way as the deploy, the post-broadcast address comparison passes,
# and you have deployed both contracts to unintended addresses with everything reporting green.
# The only thing that catches that is an expectation formed INDEPENDENTLY of these inputs.
PINNED=0
for pin in "EXPECT_ESCROW:$WANT_ESC" "EXPECT_FPROXY:$WANT_FP" "EXPECT_LIB:$WANT_LIB" "EXPECT_SALT:$SALT"; do
  var="${pin%%:*}"; got="${pin#*:}"
  [ "$var" = EXPECT_FPROXY ] && [ "$DEPLOY_PROXY" = 0 ] && continue   # no proxy is derived to pin
  eval "want=\${$var:-}"
  [ -z "$want" ] && continue
  PINNED=$((PINNED+1))
  if [ "$(printf '%s' "$want" | tr 'A-Z' 'a-z')" != "$(printf '%s' "$got" | tr 'A-Z' 'a-z')" ]; then
    echo
    echo "REFUSING: $var does not match what this configuration derives." >&2
    echo "  pinned  : $want" >&2
    echo "  derived : $got" >&2
    echo "  Something upstream differs — the salt, the deployer/admin argument, or the bytecode." >&2
    echo "  Do not broadcast until they agree; the addresses are not recoverable by a config edit." >&2
    exit 4
  fi
  printf 'pin ok    : %-14s %s\n' "$var" "$got"
done
if [ "$PINNED" -eq 0 ]; then
  echo "pins      : NONE SET — the expected addresses above are derived from \$SALT and \$DEPLOYER,"
  echo "            so they agree with the deploy by construction and prove nothing about intent."
  echo "            Set EXPECT_ESCROW / EXPECT_FPROXY / EXPECT_LIB (and EXPECT_SALT) to have that checked."
fi
echo "mode      : $([ $BROADCAST -eq 1 ] && echo 'BROADCAST — real transactions' || echo 'simulate only')"
echo "output    : $OUT"
echo

if [ $BROADCAST -eq 1 ]; then
  # Prompt on /dev/tty, not stdout. A caller that pipes our output -- run-all.sh phase 7/8 used
  # `| tail` -- traps the prompt in the pipe, because tail cannot emit until we exit. The read then
  # blocks with nothing on screen, which reads as a hang rather than a question. /dev/tty also
  # survives a redirected stdin.
  # `[ -r /dev/tty ]` is TRUE even where opening it fails ("Device not configured"), so test an
  # actual open instead of the file mode.
  if ( : < /dev/tty ) 2>/dev/null && ( : > /dev/tty ) 2>/dev/null; then
    printf 'Type the deployer address to confirm broadcasting: ' > /dev/tty
    read -r ack < /dev/tty
  else
    echo "BROADCAST needs a terminal to confirm the deployer, and /dev/tty is unavailable." >&2
    echo "Run it directly rather than under a pipe, cron or CI." >&2
    exit 1
  fi
  [ "$ack" = "$DEPLOYER" ] || { echo "aborted"; exit 1; }
  echo
fi

lc() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }

R_PAUSER=0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a
R_TREASURER=0x3496e2e73c4d42b75d702e60d9e48102720b8691234415963a5a857b86425d07
R_TOKENCFG=0x05eb16f4c9c7577cc114446a1a0bef50a2238ef90db029c789ddddf014b006a7

# An errored probe (rate limit, timeout) prints nothing, and "" != "0x" answered YES,
# so two failed probes classified a FRESH chain as ROLES_INCOMPLETE and --broadcast took
# the role-repair path without ever deploying. Empty now reads as "no code", which agrees
# with run-all.sh's phase 9 and fails toward a CREATE2 revert rather than a silent skip.
# A tri-state distinguishing "could not tell" from "no code" would be better still; that
# needs the same decision in the atum-core token-config driver updated too. The --slow decision below needs the opposite
# default and so does that read itself, at the call site -- do not "fix" it back in here.
has_code() { local c; c="$(cast code "$1" --rpc-url "$2" 2>/dev/null)"; [ -n "$c" ] && [ "$c" != "0x" ]; }
role_ok() { # contract rolehash holder rpc
  [ "$(cast call "$1" 'hasRole(bytes32,address)(bool)' "$2" "$3" --rpc-url "$4" 2>/dev/null | tail -1)" = "true" ]
}
# Classify the chain's ACTUAL end state. forge sends the script's 6 txs sequentially with no
# rollback, so any of them can be the last one that landed.
MISSING_ROLES=""; STATE=""
# NOTE: sets the globals STATE and MISSING_ROLES. Must NOT be called via $(...) — a command
# substitution runs in a subshell and MISSING_ROLES would be silently lost.
chain_state() { # rpc
  local rpc="$1" e=0 f=0
  has_code "$WANT_ESC" "$rpc" && e=1
  has_code "$WANT_FP"  "$rpc" && f=1
  [ "$DEPLOY_PROXY" = 0 ] && f=$e     # escrow-only: the proxy is not this run's to deploy or classify
  if [ $e -eq 0 ] && [ $f -eq 0 ]; then STATE=FRESH; return; fi
  if [ $e -ne $f ]; then STATE=HALF_DEPLOYED; return; fi
  MISSING_ROLES=""
  role_ok "$WANT_ESC" "$R_PAUSER"    "$ESCROW_PAUSER_ADDRESS"       "$rpc" || MISSING_ROLES="$MISSING_ROLES escrow-pauser"
  role_ok "$WANT_ESC" "$R_TREASURER" "$ESCROW_TREASURER_ADDRESS"    "$rpc" || MISSING_ROLES="$MISSING_ROLES escrow-treasurer"
  role_ok "$WANT_ESC" "$R_TOKENCFG"  "$ESCROW_TOKEN_CONFIG_ADDRESS" "$rpc" || MISSING_ROLES="$MISSING_ROLES escrow-tokenconfig"
  [ "$DEPLOY_PROXY" = 0 ] || role_ok "$WANT_FP"  "$R_PAUSER"    "$FP_PAUSER_ADDRESS"           "$rpc" || MISSING_ROLES="$MISSING_ROLES fp-pauser"
  [ -z "$MISSING_ROLES" ] && STATE=COMPLETE || STATE=ROLES_INCOMPLETE
}
# Builds FLAGS for this chain's forge scripts: --slow when the deployer is (or may be) 7702-delegated,
# EXTRA_FORGE_FLAGS, --broadcast. Idempotent per chain, so the library deploy and the escrow deploy share it.
prep_flags() {
  [ -n "${FLAGS_READY:-}" ] && return 0
  FLAGS_READY=1
  # EIP-7702: if the deployer has a delegation designator on this chain, the node (op-geth)
  # refuses GAPPED-NONCE txs from it, which is exactly what forge does when it fires the
  # script's 6 txs without waiting. --slow sends them one at a time instead.
  #
  # This is the tri-state probe has_code() cannot be: its "empty means no code" is the right
  # default for the classification above, but here it is the WRONG one. A rate-limited or
  # timed-out `cast code` prints nothing, has_code answers "not delegated", --slow is skipped,
  # and forge fires six gapped nonces at a chain whose deployer may well be delegated -- into
  # the HALF_DEPLOYED state this script itself calls NOT auto-resumable above. So read the code
  # here and fail TOWARD --slow: slowing down costs wall-clock and nothing else. The polarity is
  # not a false-positive machine, because `cast code` prints 0x, not empty, for a codeless
  # account -- the same assumption the preflight above makes at :232/:235 -- so the unreadable
  # branch is reachable only on a genuine read failure. The atum-core token-config driver already decides the
  # identical question this way.
  SLOWF=()
  dc=$(cast code "$DEPLOYER" --rpc-url "$RPC" 2>>"$LOG")
  if [ -z "$dc" ]; then
    echo "  NOTE could not read the deployer's code here — forcing --slow, because an unseen 7702"
    echo "       delegation makes forge's gapped nonces fail on op-geth"
    echo "deployer code unreadable, using --slow" >> "$LOG"
    SLOWF=(--slow)
  elif [ "$dc" != "0x" ]; then
    echo "  NOTE deployer is DELEGATED here (${dc:0:24}...) — forcing --slow"
    echo "delegated deployer, using --slow: $dc" >> "$LOG"
    SLOWF=(--slow)
  fi

  # Some chains impose a PER-TRANSACTION gas cap below what forge's default
  # --gas-estimate-multiplier 130 produces. Tempo caps a transaction at 30,000,000 while the Escrow
  # deployment estimates ~24.5M for v4 (130% -> ~31.8M) and ~26.6M for the linked generation (130% -> ~34.6M), and the node rejects it with
  # "transaction gas limit (...) is greater than the cap (...)" -- an error about the MARGIN, not
  # about the transaction, which fits comfortably. There is no foundry.toml key or FOUNDRY_* env var
  # for that flag (verified against forge 1.7.1 `forge config`), so the CLI is the only route and
  # this hatch is it. Empty by default: nothing changes for chains that do not need it.
  EXTRA_FF=()
  [ -n "${EXTRA_FORGE_FLAGS:-}" ] && read -ra EXTRA_FF <<< "$EXTRA_FORGE_FLAGS"

  FLAGS=(--rpc-url "$RPC" --account "$ACCOUNT" --sender "$DEPLOYER" ${SLOWF[@]+"${SLOWF[@]}"} ${EXTRA_FF[@]+"${EXTRA_FF[@]}"})
  [ $BROADCAST -eq 1 ] && FLAGS+=(--broadcast)
  return 0
}

# Deploys EscrowReserveLib at its CREATE2 address (a no-op when it is already there). In simulate mode
# nothing lands, so "has code afterwards" is only asserted when broadcasting.
deploy_lib() {
  prep_flags
  if SALT="$SALT" FACTORY="$FACTORY" forge script script/deploy/DeployEscrowReserveLib.s.sol \
       "${FLAGS[@]}" >>"$LOG" 2>&1; then
    if [ $BROADCAST -eq 1 ] && ! has_code "$WANT_LIB" "$RPC"; then
      echo "  FAILED — EscrowReserveLib has no code at $WANT_LIB after its deploy (log: $LOG)"; return 1
    fi
    echo "  lib  EscrowReserveLib $WANT_LIB"; return 0
  fi
  echo "  FAILED deploying EscrowReserveLib — last lines:"
  tail -12 "$LOG" | sed 's/^/      /'
  echo "    full log: $LOG"
  return 1
}
: > "$SUMMARY"
printf 'chain_id\tname\tstatus\tescrow\tfulfillment_proxy\n' >> "$SUMMARY"
declare -a ROWS=()
ok=0; skip=0; fail=0

for line in $(echo "$CHAIN_TABLE" | tr ' ' '\a' | grep -v '^$'); do
  row=$(printf '%s' "$line" | tr '\a' ' ')
  CID=$(echo "$row" | cut -d'|' -f1); NAME=$(echo "$row" | cut -d'|' -f2); RPC=$(echo "$row" | cut -d'|' -f3)
  [ -n "${CHAINS:-}" ] && ! echo " $CHAINS " | grep -q " $CID " && continue
  LOG="$LOGS/$CID.log"
  FLAGS_READY=""
  printf '=== %-18s (%s)\n' "$NAME" "$CID"

  # preflight
  pf_fail=""
  live=$(cast chain-id --rpc-url "$RPC" 2>>"$LOG") || pf_fail="rpc unreachable"
  [ -z "$pf_fail" ] && [ "$live" != "$CID" ] && pf_fail="rpc reports chain $live, expected $CID"
  if [ -z "$pf_fail" ]; then
    [ "$(cast code "$FACTORY" --rpc-url "$RPC" 2>>"$LOG")" = "0x" ] && pf_fail="CREATE2 factory missing"
  fi
  if [ -z "$pf_fail" ]; then
    [ "$(cast code "$PERMIT2_ADDRESS" --rpc-url "$RPC" 2>>"$LOG")" = "0x" ] && pf_fail="Permit2 has no code"
  fi
  if [ -z "$pf_fail" ] && [ "$DEPLOY_PROXY" = 0 ]; then
    # Escrow-only mode neither derives, pins nor role-checks the proxy, so this is the only place a chain
    # with no proxy at FPROXY is caught; without it that chain would classify COMPLETE.
    [ "$(cast code "$FPROXY" --rpc-url "$RPC" 2>>"$LOG")" = "0x" ] && pf_fail="DEPLOY_PROXY=0 but no FulfillmentProxy at FPROXY $FPROXY"
  fi
  if [ -z "$pf_fail" ] && [ $BROADCAST -eq 1 ]; then
    bal=$(cast balance "$DEPLOYER" --rpc-url "$RPC" 2>>"$LOG" || echo 0)
    [ "$bal" = "0" ] && pf_fail="deployer has zero balance"
  fi
  if [ -n "$pf_fail" ]; then
    echo "  PREFLIGHT FAIL: $pf_fail  (log: $LOG)"
    echo "preflight: $pf_fail" >> "$LOG"
    printf '%s\t%s\tPREFLIGHT_FAIL: %s\t\t\n' "$CID" "$NAME" "$pf_fail" >> "$SUMMARY"
    fail=$((fail+1)); continue
  fi

  # --- resume logic: classify what actually landed, not just "does Escrow exist" ---
  chain_state "$RPC"
  # No library in this tree (a v4 checkout): nothing to deploy or link, so count it as up.
  LIB_UP=0; if [ -z "$WANT_LIB" ] || has_code "$WANT_LIB" "$RPC"; then LIB_UP=1; fi
  # An escrow without its library is not "complete": reserve() and refundUnreserved() both call the library, and
  # with no code at its address the call reverts (solc checks extcodesize and the revert data is empty), so
  # reserving and refunding an unreserved direct deposit are impossible until it is deployed.
  # The library lives at a CREATE2 address the escrow already embeds, so deploying it late repairs this.
  if { [ "$STATE" = COMPLETE ] || [ "$STATE" = ROLES_INCOMPLETE ]; } && [ $LIB_UP -eq 0 ]; then
    echo "  LIB MISSING — the escrow is deployed but EscrowReserveLib is not at $WANT_LIB"
    echo "    (reserve() and refundUnreserved() would revert with empty data until it is deployed)"
    if [ $BROADCAST -eq 0 ]; then
      echo "         (simulate mode: not repairing)"
      printf '%s\t%s\tLIB_MISSING\t%s\t%s\n' "$CID" "$NAME" "$WANT_ESC" "$WANT_FP" >> "$SUMMARY"
      fail=$((fail+1)); continue
    fi
    if ! deploy_lib; then
      printf '%s\t%s\tLIB_DEPLOY_FAILED\t%s\t%s\n' "$CID" "$NAME" "$WANT_ESC" "$WANT_FP" >> "$SUMMARY"
      fail=$((fail+1)); continue
    fi
    LIB_UP=1
  fi
  case "$STATE" in
    COMPLETE)
      echo "  SKIP — already complete ($([ "$DEPLOY_PROXY" = 1 ] && echo "both contracts + library + all 4 roles" || echo "escrow + library + its 3 roles; proxy not managed"))"
      printf '%s\t%s\tCOMPLETE\t%s\t%s\n' "$CID" "$NAME" "$WANT_ESC" "$WANT_FP" >> "$SUMMARY"
      skip=$((skip+1)); continue ;;
    HALF_DEPLOYED)
      # The all-in-one script would revert on the CREATE2 that already succeeded, so this is
      # never auto-resumed. Which half exists decides what, if anything, can be done.
      esc_at=MISSING; fp_at=MISSING
      has_code "$WANT_ESC" "$RPC" && esc_at=$WANT_ESC
      has_code "$WANT_FP" "$RPC" && fp_at=$WANT_FP
      if [ "$esc_at" = MISSING ]; then
        echo "  HALF-DEPLOYED — the FulfillmentProxy is at $WANT_FP but no Escrow is at $WANT_ESC."
        if [ -n "$WANT_LIB" ]; then
          echo "    Deploy the Escrow by hand, LIBRARY FIRST: DeployEscrowReserveLib.s.sol, then DeployEscrowOnly.s.sol"
          echo "    with --libraries $LIB_SPEC and ESCROW_RESERVE_LIB_ADDRESS=$WANT_LIB, then re-run for the roles."
          echo "    README: 'The escrow library'. If the proxy is meant to stay as it is, re-run with DEPLOY_PROXY=0."
        else
          echo "    No Escrow-only script exists for this generation, and the all-in-one script reverts on the"
          echo "    occupied proxy CREATE2. Stop and find out why before deploying anything on this chain."
        fi
      else
        echo "  HALF-DEPLOYED — the Escrow is at $WANT_ESC but no FulfillmentProxy is at $WANT_FP."
        if [ -n "${FPROXY:-}" ] \
            && [ "$(printf '%s' "$FPROXY" | tr 'A-Z' 'a-z')" != "$(printf '%s' "$WANT_FP" | tr 'A-Z' 'a-z')" ] \
            && has_code "$FPROXY" "$RPC"; then
          echo "    \$FPROXY $FPROXY has code: this tree builds a different proxy than the deployed one."
          echo "    Deploying $WANT_FP is a cutover to a new proxy address, not a repair. Read README"
          echo "    \"Bytecode-only FulfillmentProxy redeploy\" before running deploy-fulfillment-proxy.sh."
        else
          echo "    Deploy the proxy with deploy-fulfillment-proxy.sh (README \"Bytecode-only"
          echo "    FulfillmentProxy redeploy\"), then re-run this driver for the roles."
        fi
      fi
      printf '%s\t%s\tHALF_DEPLOYED\t%s\t%s\n' "$CID" "$NAME" "$esc_at" "$fp_at" >> "$SUMMARY"
      echo "state=HALF_DEPLOYED escrow=$esc_at fulfillment_proxy=$fp_at" >> "$LOG"; fail=$((fail+1)); continue ;;
    ROLES_INCOMPLETE)
      echo "  RESUME — contracts are up; missing roles:$MISSING_ROLES"
      if [ $BROADCAST -eq 0 ]; then
        echo "         (simulate mode: not repairing)"
        printf '%s\t%s\tROLES_INCOMPLETE:%s\t%s\t%s\n' "$CID" "$NAME" "$(echo $MISSING_ROLES|tr ' ' ',')" "$WANT_ESC" "$WANT_FP" >> "$SUMMARY"
        fail=$((fail+1)); continue
      fi
      rok=1
      for m in $MISSING_ROLES; do
        case "$m" in
          escrow-pauser)      SC=GrantPauserRole;      CA=$WANT_ESC; EV="PAUSER_ADDRESS=$ESCROW_PAUSER_ADDRESS" ;;
          escrow-treasurer)   SC=GrantTreasurerRole;   CA=$WANT_ESC; EV="TREASURER_ADDRESS=$ESCROW_TREASURER_ADDRESS" ;;
          escrow-tokenconfig) SC=GrantTokenConfigRole; CA=$WANT_ESC; EV="TOKEN_CONFIG_ADDRESS=$ESCROW_TOKEN_CONFIG_ADDRESS" ;;
          fp-pauser)          SC=GrantPauserRole;      CA=$WANT_FP;  EV="PAUSER_ADDRESS=$FP_PAUSER_ADDRESS" ;;
          # MISSING_ROLES is appended from exactly the four literals above (:209-212), so reaching
          # this branch means a fifth was added without a grant script. Refuse rather than fall
          # through: EV is never reset between iterations, so falling through would run the grant
          # with the PREVIOUS role's env var -- granting the wrong address, and reporting success.
          *) echo "         FAILED unknown role '$m' -- no grant script mapped; refusing to guess" >&2
             rok=0; continue ;;
        esac
        echo "         granting $m via $SC"
        RSLOW=(); has_code "$DEPLOYER" "$RPC" && RSLOW=(--slow)
        RFF=(); [ -n "${EXTRA_FORGE_FLAGS:-}" ] && read -ra RFF <<< "$EXTRA_FORGE_FLAGS"
        # "$EV" is safe to quote: every case branch above sets it to a single NAME=value word.
        # NOTE: that case has no *) branch and EV is never reset, so an $m outside the four would
        # carry the previous iteration's value through -- a latent bug quoting does not address.
        if ! env CONTRACT_ADDRESS="$CA" "$EV" forge script "script/access-control/grant/$SC.s.sol" \
             --rpc-url "$RPC" --account "$ACCOUNT" --sender "$DEPLOYER" --broadcast \
             ${RSLOW[@]+"${RSLOW[@]}"} ${RFF[@]+"${RFF[@]}"} >>"$LOG" 2>&1; then
          echo "         FAILED granting $m (log: $LOG)"; rok=0
        fi
      done
      chain_state "$RPC"
      if [ $rok -eq 1 ] && [ "$STATE" = "COMPLETE" ]; then
        echo "  REPAIRED — now complete"
        printf '%s\t%s\tREPAIRED\t%s\t%s\n' "$CID" "$NAME" "$WANT_ESC" "$WANT_FP" >> "$SUMMARY"
        ok=$((ok+1))
      else
        printf '%s\t%s\tREPAIR_FAILED\t%s\t%s\n' "$CID" "$NAME" "$WANT_ESC" "$WANT_FP" >> "$SUMMARY"
        fail=$((fail+1))
      fi
      continue ;;
  esac

  prep_flags
  if [ $LIB_UP -eq 0 ] && ! deploy_lib; then
    printf '%s\t%s\tLIB_DEPLOY_FAILED\t\t\n' "$CID" "$NAME" >> "$SUMMARY"
    fail=$((fail+1)); continue
  fi
  # The escrow script's flags: FLAGS plus --libraries when this tree has a library. FLAGS is never empty, so
  # copying it and appending needs no empty-array guard, and every expansion below is quoted.
  ESCROW_FLAGS=("${FLAGS[@]}")
  if [ -n "$LIB_SPEC" ]; then ESCROW_FLAGS+=(--libraries "$LIB_SPEC"); fi
  # $LOG is appended to across runs. Where this run's escrow output starts, so the gas-cap hint below reads
  # only this run's cap line and not an earlier run's.
  LOG_FROM=$(wc -l < "$LOG" 2>/dev/null || echo 0); LOG_FROM=$((LOG_FROM + 1))
  if PERMIT2_ADDRESS="$PERMIT2_ADDRESS" SALT="$SALT" \
     ESCROW_PAUSER_ADDRESS="$ESCROW_PAUSER_ADDRESS" ESCROW_TREASURER_ADDRESS="$ESCROW_TREASURER_ADDRESS" \
     ESCROW_TOKEN_CONFIG_ADDRESS="$ESCROW_TOKEN_CONFIG_ADDRESS" FP_PAUSER_ADDRESS="$FP_PAUSER_ADDRESS" \
     forge script "script/deploy/$([ "$DEPLOY_PROXY" = 1 ] && echo DeployAndConfigureAllRoles || echo DeployEscrowOnly).s.sol" \
       "${ESCROW_FLAGS[@]}" >>"$LOG" 2>&1
  then
    GOT_ESC="$WANT_ESC"; GOT_FP="$WANT_FP"
    BF="broadcast/$([ "$DEPLOY_PROXY" = 1 ] && echo DeployAndConfigureAllRoles || echo DeployEscrowOnly).s.sol/$CID/run-latest.json"
    if [ $BROADCAST -eq 1 ] && [ -f "$BF" ]; then
      GOT_ESC=$(python3 -c "
import json;d=json.load(open('$BF'))
print(next((t['contractAddress'] for t in d.get('transactions',[]) if t.get('contractName')=='Escrow'),''))" 2>/dev/null)
      GOT_FP=$(python3 -c "
import json;d=json.load(open('$BF'))
print(next((t['contractAddress'] for t in d.get('transactions',[]) if t.get('contractName')=='FulfillmentProxy'),''))" 2>/dev/null)
      cp "$BF" "$LOGS/$CID.broadcast.json" 2>/dev/null
    fi
    if [ "$(lc "$GOT_ESC")" = "$(lc "$WANT_ESC")" ] && [ "$(lc "$GOT_FP")" = "$(lc "$WANT_FP")" ]; then
      echo "  OK   Escrow $GOT_ESC"
      printf '%s\t%s\t%s\t%s\t%s\n' "$CID" "$NAME" "$([ $BROADCAST -eq 1 ] && echo DEPLOYED || echo SIMULATED)" "$GOT_ESC" "$GOT_FP" >> "$SUMMARY"
      ok=$((ok+1))
    else
      echo "  ADDRESS MISMATCH — got $GOT_ESC / $GOT_FP, expected $WANT_ESC / $WANT_FP  (log: $LOG)"
      printf '%s\t%s\tADDRESS_MISMATCH\t%s\t%s\n' "$CID" "$NAME" "$GOT_ESC" "$GOT_FP" >> "$SUMMARY"
      fail=$((fail+1))
    fi
  else
    echo "  FAILED — last lines:"
    tail -12 "$LOG" | sed 's/^/      /'
    echo "    full log: $LOG"
    # A per-transaction gas cap reads as a transaction problem when it is a margin problem. Say
    # which it is, and compute the multiplier that fits instead of leaving it to arithmetic.
    RUN_OUT=$(tail -n +"$LOG_FROM" "$LOG" 2>/dev/null)
    if printf '%s\n' "$RUN_OUT" | grep -q 'greater than the cap'; then
      CAPLINE=$(printf '%s\n' "$RUN_OUT" | grep -o 'transaction gas limit ([0-9]*) is greater than the cap ([0-9]*)' | tail -1)
      TRIED=$(printf '%s' "$CAPLINE" | sed -n 's/.*limit (\([0-9]*\)).*/\1/p')
      CAP=$(printf '%s' "$CAPLINE" | sed -n 's/.*cap (\([0-9]*\)).*/\1/p')
      if [ -n "$TRIED" ] && [ -n "$CAP" ]; then
        # The margin forge used: 130 unless EXTRA_FORGE_FLAGS already set one. Dividing by 1.30 whatever was
        # used made a retry at 117 suggest 124 and a retry at 124 suggest 117, forever.
        MULT=$(printf '%s' "${EXTRA_FORGE_FLAGS:-}" | sed -n 's/.*--gas-estimate-multiplier[ =]\([0-9][0-9]*\).*/\1/p')
        MULT=${MULT:-130}
        SUG=$(python3 -c "import math; raw=$TRIED*100/$MULT; print(max(101,min(129,int(math.floor($CAP/raw*100))-5)))" 2>/dev/null)
        echo "    -- $NAME caps a single transaction at $CAP gas."
        echo "       forge asked for $TRIED: its ${MULT}% margin over an estimate of about"
        echo "       $(( TRIED * 100 / MULT )). The transaction fits the cap; the margin does not."
        echo "       Retry this chain with a smaller margin:"
        echo "         EXTRA_FORGE_FLAGS='--gas-estimate-multiplier $SUG' CHAINS=\"$CID\" $0 --broadcast"
      fi
    fi
    printf '%s\t%s\tFAILED\t\t\n' "$CID" "$NAME" >> "$SUMMARY"
    fail=$((fail+1))
  fi
done

python3 - "$SUMMARY" "$ADDR_JSON" "$WANT_ESC" "$WANT_FP" "$WANT_LIB" <<'PY'
import csv,json,sys
rows=list(csv.DictReader(open(sys.argv[1]),delimiter='\t'))
out={r['chain_id']:{'name':r['name'],'status':r['status'],
     'Escrow':r['escrow'],'FulfillmentProxy':r['fulfillment_proxy']} for r in rows}
json.dump({'expected':{'Escrow':sys.argv[3],'FulfillmentProxy':sys.argv[4],'EscrowReserveLib':sys.argv[5]},'chains':out},
          open(sys.argv[2],'w'),indent=2)
PY

echo
echo "ok=$ok  skipped=$skip  failed=$fail"
column -t -s $'\t' "$SUMMARY" 2>/dev/null || cat "$SUMMARY"
echo
echo "addresses : $ADDR_JSON"
echo "logs      : $LOGS/"
[ $fail -gt 0 ] && exit 1 || exit 0
