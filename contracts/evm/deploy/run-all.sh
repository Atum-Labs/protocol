#!/usr/bin/env bash
# v4 EVM deployment, end to end, from one command.
#
#   NETWORK=testnet contracts/evm/deploy/run-all.sh --check       # read-only: everything verifiable without spending gas
#   NETWORK=testnet contracts/evm/deploy/run-all.sh --dry         # + simulate the deploy and token config
#   NETWORK=testnet contracts/evm/deploy/run-all.sh --broadcast   # real deployment (each sub-step prompts)
#   FROM=6 NETWORK=testnet contracts/evm/deploy/run-all.sh --check         # start at a phase
#   ONLY=9 NETWORK=testnet contracts/evm/deploy/run-all.sh --check         # run one phase
#
# NETWORK (testnet|mainnet) is required, and every CHAIN_TABLE chain must belong to it (networks.sh).
#
# All values come from ./testnet.env. Override anything by exporting it first,
# or point ENVF at your own file (see README.md "Mainnet differences").
set -uo pipefail
# Resolve through symlinks so this works when invoked from a PATH symlink: BASH_SOURCE points
# at the LINK, and the files that ship beside this script (derive.py, ../source) live next to the
# TARGET. Without this, a global install silently loses them.
SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do
  _d="$(cd -P "$(dirname "$SELF")" && pwd)"
  SELF="$(readlink "$SELF")"
  case "$SELF" in /*) ;; *) SELF="$_d/$SELF" ;; esac
done
HERE="$(cd -P "$(dirname "$SELF")" && pwd)"

# Looking only at $1, with no catch-all, meant `run-all.sh --brodcast` ran the read-only --check
# and never said the flag was not understood -- safe by luck rather than by design. The other
# drivers in this tree all refuse an unrecognised argument (deploy.sh's argument parsing and the
# svm driver's); this one was the last that did not.
#
# Parsed HERE, ahead of the NETWORK/ENVF resolution below, deliberately: unlike deploy.sh, which
# sources its env file only when it exists, this script hard-exits when $ENVF is missing, so a
# parse placed after it would make --help unreachable in exactly the situation the help text
# answers ("point ENVF at your own file").
MODE=check
case "${1:-}" in
  ''|--check)   MODE=check ;;
  --dry)        MODE=dry ;;
  --broadcast)  MODE=broadcast ;;
  # '2,11p' is the header: :11 is its last line and :12 is `set -uo pipefail`, so a wider
  # range prints shell as "help".
  --help|-h)    sed -n '2,11p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "unknown argument: $1" >&2
     echo "usage: run-all.sh [--check | --dry | --broadcast]" >&2
     echo "  phases are selected with FROM=<n> / ONLY=<n>; see --help" >&2
     exit 2 ;;
esac
# Only $1 was inspected, so `run-all.sh --check --broadcast` silently took --check -- and those
# two differ by whether real transactions are sent.
[ $# -gt 1 ] && { echo "unexpected extra arguments: ${*:2}" >&2; exit 2; }

# NETWORK picks the environment file, so the deployer, salt, derived addresses and chain set are
# all consistent with each other. Validating the TESTNET deployer during a mainnet run was the
# specific failure this replaces: every phase after it inherited the wrong expectation.
# shellcheck source=networks.sh
. "$HERE/networks.sh"
require_network
export NETWORK   # deploy.sh and funding-check.sh run as children and read it
ENVF="${ENVF:-$HERE/$NETWORK.env}"
[ -f "$ENVF" ] || {
  echo "environment file not found: $ENVF" >&2
  echo "  copy the tracked template first: cp $ENVF.example $ENVF" >&2
  exit 2; }
set -a; . "$ENVF"; set +a
# The keystore is fixed by the network: atum-deployer-testnet or atum-deployer-mainnet.
ACCOUNT="atum-deployer-$NETWORK"
: "${SRC_DIR:=$(cd "$HERE/../source" && pwd)}"
# Escrow -> EscrowReserveLib linking (CREATE2 library, linked initcode); see the file for why.
. "$HERE/escrow-lib.sh"

# DEPLOY_PROXY=0: the Escrow (and its library) is deployed on its own, next to a FulfillmentProxy that is
# already live (deploy.sh explains why). Phases 6 and 9 then neither derive nor verify a proxy.
: "${DEPLOY_PROXY:=1}"
FROM="${FROM:-0}"; ONLY="${ONLY:-}"
TOOLS="$HERE/../../deploy"          # cross-VM tooling (assert-typehashes.sh)
FAILED=()

# The chain set comes from the env file, which is the single place it is defined. This used to keep
# its own copy of the testnet seven and reference $ETH_SEPOLIA_RPC and friends unconditionally,
# which aborted a mainnet run under `set -u` because those names do not exist in mainnet.env.
[ -n "${CHAIN_TABLE:-}" ] || {
  echo "CHAIN_TABLE is not set. It is exported by $NETWORK.env; check that $ENVF defines it." >&2
  exit 2; }
require_chain_table_matches_network
CHAINS_TBL="$(printf '%s' "$CHAIN_TABLE" | sed '/^[[:space:]]*$/d')"
# CHAINS (space-separated chain ids) narrows every phase to those rows, as it already narrows deploy.sh and
# funding-check.sh. Without this, phases 4 and 9 walked the whole table even when the deploy was scoped to one
# chain, and reported "no escrow deployed" for every chain that was out of scope.
if [ -n "${CHAINS:-}" ]; then
  CHAINS_TBL="$(printf '%s\n' "$CHAINS_TBL" | awk -F'|' -v want=" $CHAINS " 'index(want, " " $1 " ")')"
  [ -n "$CHAINS_TBL" ] || { echo "CHAINS='$CHAINS' matches no row of CHAIN_TABLE ($NETWORK.env)." >&2; exit 2; }
fi

run_phase() { n="$1"; [ -n "$ONLY" ] && [ "$ONLY" != "$n" ] && return 1; [ "$n" -lt "$FROM" ] && return 1; return 0; }
hdr() { printf '\n\033[1m── PHASE %s — %s\033[0m\n' "$1" "$2"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED+=("phase $CUR: $1"); }
good(){ printf '  \033[32mok\033[0m   %s\n' "$1"; }
# The tally lives in a function because phase 7 can stop the run early and must still print it;
# it only prints, so each caller picks its own exit status.
summary() {
  echo
  if [ ${#FAILED[@]} -eq 0 ]; then echo "── no failures in the phases that ran"; else
    printf '── %s failure(s):\n' "${#FAILED[@]}"; for f in "${FAILED[@]}"; do echo "   - $f"; done; fi
}

echo "mode=$MODE  network=$NETWORK  env=$(basename "$ENVF")  src=$SRC_DIR  deployer=$DEPLOYER"
echo "escrow=$ESCROW"
echo "fproxy=$FPROXY"

# ---------- 0: tools ----------
# Count the chains from CHAIN_TABLE rather than hardcoding it: these headers said "7 chains"
# while the loops iterated whatever CHAIN_TABLE held, so adding Tempo made the label a lie about
# the work being done.
NCHAIN=$(printf '%s\n' "$CHAINS_TBL" | grep -c '|')

CUR=0; if run_phase 0; then hdr 0 "toolchain"
  for t in forge cast git pnpm python3; do
    command -v "$t" >/dev/null && good "$t $(command -v "$t")" || bad "$t not found"
  done
fi

# ---------- 1: source ----------
CUR=1; if run_phase 1; then hdr 1 "source at $SRC_SHA"
  if [ ! -d "$SRC_DIR" ]; then
    bad "$SRC_DIR missing — clone protocol and checkout $PROTOCOL_REF (README Step 1)"
  else
    cd "$SRC_DIR"
    have=$(git rev-parse HEAD 2>/dev/null)
    # An env file of your own (ENVF) may leave SRC_SHA empty to skip the check; without this guard that
    # reported "HEAD is , expected " as a failure. The shipped templates pin it with `:=`, which also
    # replaces an exported empty value, so they never reach this branch.
    if [ -z "$SRC_SHA" ]; then good "SRC_SHA not pinned — HEAD not checked"
    else [ "$have" = "$SRC_SHA" ] && good "HEAD == $SRC_SHA" || bad "HEAD is $have, expected $SRC_SHA"; fi
    [ -d node_modules/@openzeppelin/contracts ] && good "OpenZeppelin present" \
      || bad "no node_modules/@openzeppelin — run: pnpm install --ignore-workspace"
    [ -f out/Escrow.sol/Escrow.json ] && good "build artifact present" || bad "not built — run forge build"
    if [ -f src/EscrowReserveLib.sol ]; then
      [ -f out/EscrowReserveLib.sol/EscrowReserveLib.json ] && good "EscrowReserveLib artifact present" \
        || bad "EscrowReserveLib not built — run forge build"
    fi
  fi
fi

# ---------- 2: right source + right settings ----------
CUR=2; if run_phase 2; then hdr 2 "source identity + compiler settings"
  cd "$SRC_DIR" 2>/dev/null || true
  [ "$(grep -c NonExactTransfer src/Escrow.sol 2>/dev/null)" -ge 1 ] \
    && good "NonExactTransfer guard present" || bad "no NonExactTransfer — wrong tree (the retired evm-contracts tree lacks it)"
  [ "$(grep -c SETTLER_ROLE src/FulfillmentProxy.sol 2>/dev/null)" -ge 1 ] \
    && good "SETTLER_ROLE present (dormant)" || bad "no SETTLER_ROLE — wrong tree"
  grep -q 'DepositWitness(bytes32 depositRequestHash,string destination' src/Escrow.sol 2>/dev/null \
    && good "widened deposit witness" || bad "deposit witness not widened"
  bash "$HERE/derive-guard.sh" >/dev/null 2>&1 && good "compiler settings match" \
    || bad "compiler settings wrong — are you in contracts/evm/source?"
fi

# ---------- 3: keystore ----------
CUR=3; if run_phase 3; then hdr 3 "keystore"
  # `cast wallet address --account` decrypts, so it needs a TTY for the password prompt.
  # Non-interactively it dies with "Device not configured" — which is NOT a missing keystore.
  KS="$HOME/.foundry/keystores/$ACCOUNT"
  if [ ! -f "$KS" ]; then
    bad "no keystore '$ACCOUNT' at $KS (run ./import-deployer.sh)"
  elif [ -t 0 ]; then
    got=$(cast wallet address --account "$ACCOUNT" 2>/dev/null || echo unreadable)
    [ "$(echo "$got" | tr A-Z a-z)" = "$(echo "$DEPLOYER" | tr A-Z a-z)" ] \
      && good "keystore '$ACCOUNT' == $DEPLOYER (verified)" \
      || bad "keystore '$ACCOUNT' is $got, expected $DEPLOYER"
  else
    good "keystore '$ACCOUNT' present — address NOT verified (needs a TTY for the password)"
    echo "       verify by hand: cast wallet address --account $ACCOUNT"
  fi
fi

# ---------- 4: RPCs ----------
CUR=4; if run_phase 4; then hdr 4 "RPC health, $NCHAIN chains"
  # Herestring, not a pipe: `while` on the right of a pipe runs in a subshell, so an
  # append to FAILED there is discarded when the subshell exits and the phase reports
  # red while the run still exits 0.
  while IFS='|' read -r cid name rpc; do
    [ -n "$cid" ] || continue
    live=$(cast chain-id --rpc-url "$rpc" 2>/dev/null)
    [ "$live" = "$cid" ] && good "$(printf '%-18s %s' "$name" "$cid")" \
      || bad "$(printf '%-18s reports %s' "$name" "${live:-unreachable}")"
  done <<< "$CHAINS_TBL"
fi

# ---------- 5: funding ----------
CUR=5; if run_phase 5; then hdr 5 "funding"
  # Capture the status before the pipe: `cmd | sed` reports sed's exit code, so piping
  # funding-check straight into sed discarded the only signal it gives.
  fund_out=$(bash "$HERE/funding-check.sh" 2>&1); fund_rc=$?
  # funding-check.sh prints the deployer/margin banner on line 1, a blank on 2, its column header
  # on 3, the rule on 4, then one row per chain. Sized from NCHAIN rather than the hardcoded
  # `3,12p` that was here: that window held exactly 8 rows, which is precisely full for both
  # env files' CHAIN_TABLE, so a ninth chain would have been silently cut.
  echo "$fund_out" | sed -n "3,$((4 + NCHAIN))p"
  # A chain that could not be MEASURED is only visible in the far-right STATUS column of that
  # table, and funding-check.sh's warning about it can only be printed after the table -- the
  # count is not known before then -- which is outside the window above no matter how it is
  # sized. So pull those lines through by their prefix. Matches funding-check.sh:248-259.
  echo "$fund_out" | grep '^UNMEASURED:' || true
  [ "$fund_rc" -eq 0 ] && good "funding check passed" || bad "funding-check.sh exited $fund_rc"
fi

# ---------- 6: derive + match ----------
CUR=6; if run_phase 6; then hdr 6 "address derivation"
  cd "$SRC_DIR" 2>/dev/null || true
  # Hashed LINKED: the Escrow initcode embeds EscrowReserveLib's CREATE2 address (escrow-lib.sh).
  if derive_escrow_link 2>/dev/null; then eb="$ESC_BC"; else bad "could not link Escrow to EscrowReserveLib"; eb=""; fi
  if [ -n "$WANT_LIB" ]; then
    good "EscrowReserveLib CREATE2 address $WANT_LIB (deployed before the escrow)"
    # ESCROW_LIB is the optional pin for a library generation, like ESCROW_INITCODE_HASH below.
    if [ -n "${ESCROW_LIB:-}" ]; then
      [ "$(echo "$WANT_LIB"|tr A-Z a-z)" = "$(echo "$ESCROW_LIB"|tr A-Z a-z)" ] \
        && good "library address matches ESCROW_LIB" || bad "library $WANT_LIB != ESCROW_LIB $ESCROW_LIB"
    fi
  else
    good "no EscrowReserveLib in this tree (v4 generation, nothing to link)"
  fi
  fb=$(forge inspect src/FulfillmentProxy.sol:FulfillmentProxy bytecode 2>/dev/null)
  n=$(( (${#eb}-2)/2 ))
  [ "$n" = "$ESCROW_BYTES" ] && good "escrow initcode $n bytes" || bad "escrow initcode $n, expected $ESCROW_BYTES"
  eh=$(cast keccak "${eb}$(cast abi-encode 'c(address,address)' "$PERMIT2_ADDRESS" "$DEPLOYER" | cut -c3-)")
  fh=""; [ "$DEPLOY_PROXY" = 1 ] && fh=$(cast keccak "${fb}$(cast abi-encode 'c(address)' "$DEPLOYER" | cut -c3-)")
  [ "$eh" = "$ESCROW_INITCODE_HASH" ] && good "escrow initcode-hash matches" || bad "escrow initcode-hash $eh != $ESCROW_INITCODE_HASH"
  if [ "$DEPLOY_PROXY" = 1 ]; then
    [ "$fh" = "$FPROXY_INITCODE_HASH" ] && good "fproxy initcode-hash matches" || bad "fproxy initcode-hash drift"
  else good "fproxy not deployed by this run (DEPLOY_PROXY=0), initcode-hash not checked"; fi
  de=$(create2_address "$FACTORY" "$SALT" "$eh")
  df=""; [ "$DEPLOY_PROXY" = 1 ] && df=$(create2_address "$FACTORY" "$SALT" "$fh")
  [ "$(echo "$de"|tr A-Z a-z)" = "$(echo "$ESCROW"|tr A-Z a-z)" ] && good "escrow address $de" || bad "derived $de != $ESCROW"
  if [ "$DEPLOY_PROXY" = 1 ]; then
    [ "$(echo "$df"|tr A-Z a-z)" = "$(echo "$FPROXY"|tr A-Z a-z)" ] && good "fproxy address $df" || bad "derived $df != $FPROXY"
  fi
fi

# ---------- 7: deploy ----------
# Both branches score the child's status. deploy.sh exits 1 when any chain failed
# (its last line, reached only after the per-chain loop closes) and both branches used to
# discard it, so a --broadcast whose deploy failed everywhere still
# reached "no failures in the phases that ran".
# --dry will now red a chain that is deployed but missing a role, because deploy.sh's
# ROLES_INCOMPLETE branch counts a simulate-mode ROLES_INCOMPLETE as a failure. That is not a new false positive:
# phase 9 already reds the same condition, so only an extra summary line appears.
#
# A red summary line is not enough on a REFUSAL: falling through goes on to ask "shall I
# configure tokens" after deploy.sh declined to deploy anything. Telling a refusal from a
# per-chain failure cannot be done from the exit status alone. Only one refusal has a code of
# its own — exit 4, when EXPECT_ESCROW/EXPECT_FPROXY/EXPECT_LIB/EXPECT_SALT disagrees with what
# this configuration derives (deploy.sh's pin check), so the addresses are not the ones intended.
# The rest all exit 1, the same code as "some chain failed": a wrong Escrow byte count (the
# ESCROW_BYTES guard), no terminal for the confirmation prompt, and the one an operator actually
# hits — typing the wrong address at that prompt ("aborted"). Prompting to
# configure tokens immediately after an operator deliberately aborted a mainnet broadcast is
# exactly what this stop exists to prevent, and a threshold on the exit code cannot see it.
#
# This probe does not depend on deploy.sh's exit codes, so the discriminator is one of its SIDE
# EFFECTS rather than its status: it truncates and rewrites $OUT/summary.tsv after every refusal
# listed above and before the per-chain loop begins, in simulate mode as well as broadcast.
# So the summary is moved ASIDE before the call, which makes its PRESENCE
# afterwards proof that this run wrote it, and its absence proof that deploy.sh never got that
# far. Moved rather than timestamped on purpose: `-nt` against a stamp file compares whole
# seconds on the bash macOS ships (3.2), so a refusal that lands inside the same second as the
# stamp is indistinguishable from a completed loop — a false STOP, observed in a stubbed run
# before this was rewritten. OUT is passed IN rather than read back out, so this is the path
# deploy.sh actually used and not a guess at its default.
# The residual ambiguity resolves TOWARD stopping: if the move cannot be made, a stale summary
# is indistinguishable from a fresh one, the question is recorded as unanswerable and exit 1
# stops the run. That costs an `ONLY=8` re-run, where the other way round configures tokens
# after an abort. The proper fix belongs in deploy.sh, which is out of scope for this pass:
# give the byte-count guard, the missing-terminal guard and the aborted confirmation exit codes
# of their own, as the pin check already has, and this whole probe collapses back to a plain
# case on $deploy_rc.
DEPLOY_OUT="${OUT:-$HOME/atum-v4-deploy-run}"   # deploy.sh's default OUT; passed in below
DEPLOY_SUMMARY="$DEPLOY_OUT/summary.tsv"
DEPLOY_ASIDE="$DEPLOY_SUMMARY.pre-run-all"
CUR=7; if run_phase 7; then hdr 7 "deploy"
  # A broadcast does not start on top of a red earlier phase. bad() only records, so without this a wrong
  # source tree, a failed address derivation or a funding shortfall printed FAIL and the deploy went ahead.
  # (ONLY=7 or FROM=7 skips the earlier phases, so there is nothing recorded to stop on: run them first.)
  if [ "$MODE" = broadcast ] && [ ${#FAILED[@]} -gt 0 ]; then
    printf '  \033[31mSTOP\033[0m not broadcasting: an earlier phase failed. Fix these and re-run.\n'
    summary; exit 1
  fi
  deploy_rc=
  # DEPLOY_PROBE=1 means "presence of the summary afterwards is trustworthy". Nothing is created
  # here and --check is left alone entirely: that mode is documented read-only.
  DEPLOY_PROBE=0
  if [ "$MODE" != check ]; then
    if [ ! -e "$DEPLOY_SUMMARY" ]; then DEPLOY_PROBE=1
    elif mv -f "$DEPLOY_SUMMARY" "$DEPLOY_ASIDE" 2>/dev/null; then DEPLOY_PROBE=1
    fi
  fi
  case "$MODE" in
    check) echo "  (skipped in --check)";;
    # Capture the status before the pipe: `cmd | tail` reports tail's exit code, so piping
    # deploy.sh straight into tail discarded the only signal it gives.
    dry)       deploy_out=$(OUT="$DEPLOY_OUT" bash "$HERE/deploy.sh" 2>&1); deploy_rc=$?
               printf '%s\n' "$deploy_out" | tail -14
               [ "$deploy_rc" -eq 0 ] && good "deploy.sh simulated cleanly" \
                 || bad "deploy.sh exited $deploy_rc";;
    # NOT piped: this is the real deploy and its progress has to appear line by line as it
    # happens, not in one block once it is over. (The confirmation prompt is safe either way:
    # deploy.sh writes it to /dev/tty precisely so that a caller's pipe cannot
    # trap it. Streaming is the reason to leave this unpiped, not the prompt.)
    broadcast) OUT="$DEPLOY_OUT" bash "$HERE/deploy.sh" --broadcast; deploy_rc=$?
               [ "$deploy_rc" -eq 0 ] && good "deploy.sh completed" \
                 || bad "deploy.sh exited $deploy_rc";;
  esac
  # Answer the question, then put the directory back the way it was: keep the new summary and
  # drop the copy, or restore the copy because deploy.sh never wrote one. An interrupted run can
  # leave the copy behind; the next run reclaims it either way, by restoring it (no new summary)
  # or discarding it (a newer one exists), so it cannot accumulate.
  deploy_reached=0
  [ "$DEPLOY_PROBE" -eq 1 ] && [ -f "$DEPLOY_SUMMARY" ] && deploy_reached=1
  if [ "$deploy_reached" -eq 1 ]; then rm -f "$DEPLOY_ASIDE" 2>/dev/null || true
  elif [ -f "$DEPLOY_ASIDE" ]; then mv -f "$DEPLOY_ASIDE" "$DEPLOY_SUMMARY" 2>/dev/null || true
  fi
  # Empty = the phase never ran it (--check). Exit 1 WITH a rewritten summary is per-chain
  # failure, which deliberately does NOT stop the run: the chains that succeeded still want
  # their token config. Everything else stops.
  if [ -n "$deploy_rc" ] && [ "$deploy_rc" -ne 0 ] \
     && { [ "$deploy_rc" -ne 1 ] || [ "$deploy_reached" -ne 1 ]; }; then
    printf '  \033[31mSTOP\033[0m deploy.sh exited %s — not continuing into token config\n' "$deploy_rc"
    # Two different reasons reach here, and only one of them is a finding about deploy.sh.
    if [ "$DEPLOY_PROBE" -eq 1 ]; then
      echo "       deploy.sh rewrites $DEPLOY_SUMMARY"
      echo "       before its first chain and this run left none there, so it refused up front and"
      echo "       deployed nothing: a wrong byte count, no terminal for the confirmation prompt, a"
      echo "       pin mismatch, or an aborted confirmation. Fix that and re-run."
    else
      echo "       $DEPLOY_SUMMARY could not be moved"
      echo "       aside, so a refusal and a per-chain failure cannot be told apart on this run."
      echo "       Stopping is the safe answer; read deploy.sh's output above to see which it was."
    fi
    echo "       To configure tokens for a deploy that HAS already finished: ONLY=8 $0 --$MODE"
    summary; exit "$deploy_rc"
  fi
fi

# ---------- 8: token config ----------
# The registry-driven driver lives in atum-core, because the token list it dispatches on is the
# registry in that repository and vendoring it here would fork it. This phase therefore reports
# only that the step is outstanding. That matters more than it looks: phase 9 verifies no token
# state at all -- grep it for isTokenAllowed/getTokenConfig/MAX_FEE and you get nothing -- so
# NOTHING in this tree will tell you whether the $250 MAX_FEE cap was applied. Get that
# confirmation from the atum-core run, or from the manual form in the guide.
CUR=8; if run_phase 8; then hdr 8 "token config"
  case "$MODE" in
    check) echo "  (skipped in --check)";;
    *) echo "  NOT RUN HERE: the registry-driven driver is atum-core contracts/evm/token-config.sh"
       echo "  Nothing below reports token state, so confirm the fee cap from that run.";;
  esac
fi

# ---------- 9: verify what is live ----------
CUR=9; if run_phase 9; then hdr 9 "on-chain verification, $NCHAIN chains"
  R_P=0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a
  R_T=0x3496e2e73c4d42b75d702e60d9e48102720b8691234415963a5a857b86425d07
  R_C=0x05eb16f4c9c7577cc114446a1a0bef50a2238ef90db029c789ddddf014b006a7
  # The library address this tree links to, for the per-chain check below. Empty only for a v4 tree
  # (no src/EscrowReserveLib.sol); a derivation FAILURE on a tree that has one must not read as
  # "nothing to check".
  WANT_LIB=""
  if [ -f "$SRC_DIR/src/EscrowReserveLib.sol" ]; then
    pushd "$SRC_DIR" >/dev/null || true
    derive_escrow_link >/dev/null 2>&1 || { bad "could not derive the EscrowReserveLib address from $SRC_DIR"; WANT_LIB=""; }
    popd >/dev/null || true
  fi
  while IFS='|' read -r cid name rpc; do
    [ -n "$cid" ] || continue
    code=$(cast code "$ESCROW" --rpc-url "$rpc" 2>/dev/null)
    if [ "$code" = "0x" ] || [ -z "$code" ]; then bad "$(printf '%-18s no escrow deployed' "$name")"; continue; fi
    th=$(bash "$TOOLS/assert-typehashes.sh" --deployed "$ESCROW" --rpc "$rpc" 2>&1 | tail -1 | grep -c PASS)
    r1=$(cast call "$ESCROW" 'hasRole(bytes32,address)(bool)' "$R_P" "$ESCROW_PAUSER_ADDRESS" --rpc-url "$rpc" 2>/dev/null)
    r2=$(cast call "$ESCROW" 'hasRole(bytes32,address)(bool)' "$R_T" "$ESCROW_TREASURER_ADDRESS" --rpc-url "$rpc" 2>/dev/null)
    r3=$(cast call "$ESCROW" 'hasRole(bytes32,address)(bool)' "$R_C" "$ESCROW_TOKEN_CONFIG_ADDRESS" --rpc-url "$rpc" 2>/dev/null)
    if [ "$DEPLOY_PROXY" = 1 ]; then
      r4=$(cast call "$FPROXY" 'hasRole(bytes32,address)(bool)' "$R_P" "$FP_PAUSER_ADDRESS" --rpc-url "$rpc" 2>/dev/null)
    else
      # Escrow-only: the proxy's roles are not this run's to check, but the proxy the escrow is meant to sit
      # next to must exist. A chain with no code at FPROXY must fail here, not read as 4/4.
      pcode=$(cast code "$FPROXY" --rpc-url "$rpc" 2>/dev/null)
      case "$pcode" in ''|0x) r4=NOPROXY ;; *) r4=true ;; esac
    fi
    dl=$(cast call "$ESCROW" 'defaultAdminDelay()(uint48)' --rpc-url "$rpc" 2>/dev/null | head -1)
    en=$(cast call "$FPROXY" 's_settlerAllowlistEnforced()(bool)' --rpc-url "$rpc" 2>/dev/null | tail -1)
    roles="$r1$r2$r3$r4"
    # A linked escrow needs its library deployed AND embedded in the escrow's runtime. Without the
    # code, reserve() and refundUnreserved() revert (empty revert data); without the
    # embedded address, the escrow was linked to some other library (forge's nonce-based default).
    lib=n/a
    if [ -n "$WANT_LIB" ]; then
      lcode=$(cast code "$WANT_LIB" --rpc-url "$rpc" 2>/dev/null)
      if [ -z "$lcode" ] || [ "$lcode" = "0x" ]; then lib=MISSING
      else
        case "$(printf '%s' "$code" | tr A-Z a-z)" in
          *"$(printf '%s' "${WANT_LIB#0x}" | tr A-Z a-z)"*) lib=ok ;;
          *) lib=UNLINKED ;;
        esac
      fi
    fi
    st=ok; [ "$th" = "1" ] || st=FAIL; [ "$roles" = "truetruetruetrue" ] || st=FAIL
    case "$lib" in ok|n/a) ;; *) st=FAIL ;; esac
    line=$(printf '%-18s typehashes=%s roles=%s lib=%s delay=%ss allowlist=%s' \
      "$name" "$([ "$th" = 1 ] && echo PASS || echo FAIL)" \
      "$([ "$roles" = truetruetruetrue ] && echo 4/4 || echo "$roles")" "$lib" "$dl" "$en")
    [ "$st" = ok ] && good "$line" || bad "$line"
  done <<< "$CHAINS_TBL"
  echo
  echo "  NOTE defaultAdminDelay=1s makes an admin handover effectively immediate — raise it while the deployer still holds admin."
fi

summary
[ ${#FAILED[@]} -eq 0 ] || exit 1
