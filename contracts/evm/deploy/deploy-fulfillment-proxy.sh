#!/usr/bin/env bash
# Deploy FulfillmentProxy only. Escrow is not constructed and not deployed.
#
#   NETWORK=mainnet contracts/evm/deploy/deploy-fulfillment-proxy.sh \
#     --sender <deployer> --salt <salt> [--expect <address>]
#   ... --broadcast --expect <address> --password-file <path> --slow
#
# Guards it shares with deploy.sh: the canonical forge-config refusal, the chain-id preflight,
# the independent address pin (--expect, passed to the script as EXPECT_FPROXY), and a
# post-broadcast check that the proxy is at that address. It adds: $NETWORK.env must exist, and
# its DEPLOYER and ESCROW are used even when the shell exports others; --sender must be that
# DEPLOYER; --expect must be the address this tree predicts, and neither the Escrow nor $FPROXY;
# code at $ESCROW is required; and the proxy must end with a PAUSER_ROLE holder. The script grants
# PAUSER_ROLE to FP_PAUSER_ADDRESS (or --pauser) in the same broadcast; on a chain that already
# has this proxy, a dry-run reports a missing pauser and --broadcast grants it. A proxy built
# from an earlier commit is refused by the --expect pin; grant its pauser with
# script/access-control/grant/GrantPauserRole.s.sol directly.
#
# Omitted --broadcast is a dry-run. It simulates with --sender alone and never
# unlocks the keystore, so it needs no password file.
#
# NETWORK (testnet|mainnet, required) picks $NETWORK.env next to this
# script, exactly as run-all.sh and funding-check.sh do, and its CHAIN_TABLE is
# the chain set. CHAINS="1 8453" narrows it to those chain ids. RPC URLs stay in
# the environment: this script never prints them, and it does not read, echo,
# or log the password file. Forge opens that path itself.
set -uo pipefail

SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do
  _d="$(cd -P "$(dirname "$SELF")" && pwd)"
  SELF="$(readlink "$SELF")"
  case "$SELF" in /*) ;; *) SELF="$_d/$SELF" ;; esac
done
HERE="$(cd -P "$(dirname "$SELF")" && pwd)"
SRC_DIR="$(cd "$HERE/../source" 2>/dev/null && pwd)" || { echo "cannot resolve ../source from $HERE" >&2; exit 1; }

BROADCAST=0
PASSWORD_FILE=
SENDER=
SALT=
EXPECT=
PAUSER=
SLOW=0

while [ $# -gt 0 ]; do
  case "$1" in
    --broadcast) BROADCAST=1; shift ;;
    --slow) SLOW=1; shift ;;
    --password-file)
      [ $# -ge 2 ] || { echo "--password-file needs a value" >&2; exit 2; }
      PASSWORD_FILE=$2; shift 2 ;;
    --sender)
      [ $# -ge 2 ] || { echo "--sender needs a value" >&2; exit 2; }
      SENDER=$2; shift 2 ;;
    --salt)
      [ $# -ge 2 ] || { echo "--salt needs a value" >&2; exit 2; }
      SALT=$2; shift 2 ;;
    --expect)
      [ $# -ge 2 ] || { echo "--expect needs a value" >&2; exit 2; }
      EXPECT=$2; shift 2 ;;
    --pauser)
      [ $# -ge 2 ] || { echo "--pauser needs a value" >&2; exit 2; }
      PAUSER=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; echo "usage: deploy-fulfillment-proxy.sh [--broadcast] [--slow] --sender <address> --salt <bytes32> [--expect <address>] [--pauser <address>] [--password-file <path>]" >&2; exit 2 ;;
  esac
done

# DEPLOYER (--sender) and SALT have no default. Guessing either changes the CREATE2 address.
[ -n "$SENDER" ] || { echo "--sender is required. It is the CREATE2 defaultAdmin. There is no default." >&2; exit 2; }
[ -n "$SALT" ] || { echo "--salt is required. There is no default." >&2; exit 2; }
if [ "$BROADCAST" -eq 1 ]; then
  [ -n "$EXPECT" ] || { echo "--expect is required with --broadcast" >&2; exit 2; }
  [ -n "$PASSWORD_FILE" ] || { echo "--password-file is required with --broadcast" >&2; exit 2; }
fi

# Load $NETWORK.env, which is required. Every assignment in it is `: "${VAR:=...}"`, so values
# the caller exported win (private RPC URLs, for one). Remember --salt and --sender and put them
# back after, so the file cannot replace either. Do not print the file or any RPC URL. Do not
# read contracts/evm/source/.env.
# shellcheck source=networks.sh
. "$HERE/networks.sh"
require_network
ENVF="${ENVF:-$HERE/$NETWORK.env}"
[ -f "$ENVF" ] || {
  echo "environment file not found: $ENVF" >&2
  echo "  copy the tracked template first: cp $HERE/$NETWORK.env.example $ENVF" >&2
  exit 2; }
# DEPLOYER and ESCROW guard this run, so take them from the file alone. A value exported in the
# shell would otherwise win over the file and switch the sender and Escrow checks to it.
file_value() { # <var>: its value in $ENVF, read in a clean environment
  env -i PATH="$PATH" HOME="$HOME" bash -c 'set -a; . "$1"; eval "printf %s \"\${$2:-}\""' _ "$ENVF" "$1"
}
FILE_DEPLOYER=$(file_value DEPLOYER)
FILE_ESCROW=$(file_value ESCROW)
FILE_FPROXY=$(file_value FPROXY)
saved_salt=$SALT
saved_sender=$SENDER
set -a
# shellcheck disable=SC1090
. "$ENVF"
set +a
SALT=$saved_salt
SENDER=$saved_sender
[ -n "$FILE_DEPLOYER" ] || { echo "DEPLOYER is not set in $ENVF. Refusing." >&2; exit 2; }
[ -n "$FILE_ESCROW" ] || { echo "ESCROW is not set in $ENVF. Refusing." >&2; exit 2; }
for v in DEPLOYER ESCROW; do
  eval "shell=\${$v:-}; file=\$FILE_$v"
  if [ "$(printf '%s' "$shell" | tr 'A-Z' 'a-z')" != "$(printf '%s' "$file" | tr 'A-Z' 'a-z')" ]; then
    echo "$v is exported as $shell, but $ENVF says $file. Unset it, or fix the file. Refusing." >&2
    exit 2
  fi
done
# The keystore is fixed by the network: atum-deployer-testnet or atum-deployer-mainnet.
ACCOUNT="atum-deployer-$NETWORK"

[ -n "${CHAIN_TABLE:-}" ] || {
  echo "CHAIN_TABLE is not set, so there is no chain set to iterate." >&2
  echo "  $ENVF must define it, as $NETWORK.env.example does." >&2
  exit 2; }
require_chain_table_matches_network

# The deployer is the constructor's defaultAdmin, so it is part of the address. A
# testnet sender against the mainnet chain set (or the reverse) simulates cleanly
# and deploys to an address nobody expects.
lc() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }
if [ "$(lc "$SENDER")" != "$(lc "$FILE_DEPLOYER")" ]; then
  echo "--sender $SENDER is not the $NETWORK deployer $FILE_DEPLOYER from $ENVF. Refusing." >&2
  exit 2
fi

# The constructor grants no pauser. --pauser wins, then FP_PAUSER_ADDRESS from the env file, which
# both templates default to the deployer, as the live proxies have it.
[ -n "$PAUSER" ] || PAUSER="${FP_PAUSER_ADDRESS:-}"
[ -n "$PAUSER" ] || { echo "no pauser: pass --pauser or set FP_PAUSER_ADDRESS in $ENVF" >&2; exit 2; }
PAUSER_ROLE=0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a

has_code() {
  local c
  c="$(cast code "$1" --rpc-url "$2" 2>/dev/null)"
  [ -n "$c" ] && [ "$c" != "0x" ]
}

if [ "$(lc "$SALT")" = "0x00000000000000000000000000000000000000000000000000000000deadbeef" ]; then
  echo "refusing placeholder salt 0x00000000000000000000000000000000000000000000000000000000deadbeef" >&2
  exit 2
fi

role_ok() { # contract rolehash holder rpc
  [ "$(cast call "$1" 'hasRole(bytes32,address)(bool)' "$2" "$3" --rpc-url "$4" 2>/dev/null | tail -1)" = "true" ]
}

simulated_address() {
  printf '%s\n' "$1" | grep 'FulfillmentProxy contract deployed at:' | grep -oE '0x[0-9a-fA-F]{40}' | head -1
}

cd "$SRC_DIR" || { echo "SRC_DIR not found: $SRC_DIR" >&2; exit 1; }

# Same refusal as deploy.sh: a wrong tree silently changes the bytecode and so the address.
chk() { got=$(forge config 2>/dev/null | grep -E "^$1 " | head -1 | sed 's/.*= *//' | tr -d '"')
        [ "$got" = "$2" ] || { echo "  foundry config $1=$got expected $2" >&2; return 1; }; }
if ! { chk solc 0.8.27 && chk via_ir true && chk optimizer true \
    && chk optimizer_runs 4294967295 && chk bytecode_hash none && chk cbor_metadata false; }; then
  echo "REFUSING: $SRC_DIR is not the vendored EVM project — bytecode and address would be wrong." >&2
  exit 1
fi

# The address this tree, --sender and --salt produce. --expect must be it before any chain is
# touched: the SKIP and REPAIR paths below only look for code at --expect, so without this pin
# --expect could name any contract the deployer administers (the old proxy, the Escrow) and be
# skipped as "deployed" or handed a PAUSER_ROLE grant.
FP_BC=$(forge inspect src/FulfillmentProxy.sol:FulfillmentProxy bytecode) || { echo "forge inspect failed" >&2; exit 1; }
FP_HASH=$(cast keccak "${FP_BC}$(cast abi-encode 'c(address)' "$SENDER" | cut -c3-)")
# cut -f1: newer cast prints the salt after the address on the same line.
PREDICTED=$(cast create2 --deployer 0x4e59b44847b379578588920ca78fbf26c0b4956c --salt "$SALT" --init-code-hash "$FP_HASH" | tail -1 | cut -f1)
if [ -n "$EXPECT" ]; then
  for other in "Escrow:$FILE_ESCROW" "FPROXY:$FILE_FPROXY"; do
    if [ -n "${other#*:}" ] && [ "$(lc "$EXPECT")" = "$(lc "${other#*:}")" ]; then
      echo "REFUSING: --expect $EXPECT is the ${other%%:*} from $ENVF, not a new proxy." >&2
      exit 2
    fi
  done
  if [ "$(lc "$EXPECT")" != "$(lc "$PREDICTED")" ]; then
    echo "REFUSING: --expect $EXPECT, but this tree, --sender and --salt produce $PREDICTED." >&2
    echo "  A proxy built from another commit cannot be deployed or repaired from this one." >&2
    exit 2
  fi
fi

# Everything forge reads, set explicitly. EXPECT_FPROXY from the env file stays in force when
# --expect is not given; ESCROW comes from the env file and must have code on every chain.
export SALT FP_PAUSER_ADDRESS="$PAUSER" ESCROW="$FILE_ESCROW"
[ -n "$EXPECT" ] && export EXPECT_FPROXY="$EXPECT"

echo "mode      : $([ "$BROADCAST" -eq 1 ] && echo 'BROADCAST — real transactions' || echo 'dry-run')"
echo "network   : $NETWORK"
echo "sender    : $SENDER"
echo "pauser    : $PAUSER"
[ "$BROADCAST" -eq 1 ] && echo "keystore  : $ACCOUNT"
[ -n "${EXPECT_FPROXY:-}" ] && echo "expect    : $EXPECT_FPROXY"
echo "predicted : $PREDICTED"
echo "escrow    : $ESCROW (must have code)"
echo "script    : script/deploy/DeployFulfillmentProxy.s.sol"
echo

fail=0
ran=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  CID=$(printf '%s' "$line" | cut -d'|' -f1)
  NAME=$(printf '%s' "$line" | cut -d'|' -f2)
  RPC=$(printf '%s' "$line" | cut -d'|' -f3-)
  [ -n "${CHAINS:-}" ] && ! printf ' %s ' "$CHAINS" | grep -q " $CID " && continue
  if [ -z "$RPC" ]; then
    echo "=== $NAME ($CID)"
    echo "  FAILED — no RPC for chain $CID in CHAIN_TABLE"
    fail=1
    [ "$BROADCAST" -eq 1 ] && exit 1
    continue
  fi

  echo "=== $NAME ($CID)"
  ran=1

  live=$(cast chain-id --rpc-url "$RPC" 2>/dev/null) || live=
  if [ "$live" != "$CID" ]; then
    echo "  FAILED — RPC reports chain ${live:-<unreachable>}, expected $CID"
    fail=1
    [ "$BROADCAST" -eq 1 ] && exit 1
    continue
  fi

  if [ -n "$EXPECT" ] && has_code "$EXPECT" "$RPC"; then
    if role_ok "$EXPECT" "$PAUSER_ROLE" "$PAUSER" "$RPC"; then
      echo "  SKIP — deployed at $EXPECT, $PAUSER holds PAUSER_ROLE"
      continue
    fi
    if [ "$BROADCAST" -eq 0 ]; then
      echo "  INCOMPLETE — deployed at $EXPECT, but $PAUSER lacks PAUSER_ROLE. --broadcast grants it."
      fail=1
      continue
    fi
    echo "  REPAIR — granting PAUSER_ROLE on $EXPECT to $PAUSER"
    flags=(--rpc-url "$RPC" --account "$ACCOUNT" --sender "$SENDER" --password-file "$PASSWORD_FILE" --broadcast)
    grant_log=$(mktemp)
    if ! CONTRACT_ADDRESS="$EXPECT" PAUSER_ADDRESS="$PAUSER" \
        forge script script/access-control/grant/GrantPauserRole.s.sol "${flags[@]}" >"$grant_log" 2>&1 \
        || ! role_ok "$EXPECT" "$PAUSER_ROLE" "$PAUSER" "$RPC"; then
      echo "  FAILED — PAUSER_ROLE grant on $NAME ($CID)"
      tail -12 "$grant_log" | sed 's/^/      /'
      rm -f "$grant_log"
      exit 1
    fi
    rm -f "$grant_log"
    echo "  repaired $NAME"
    continue
  fi

  sim=$(mktemp)
  # Simulation only, with --sender alone: the keystore is not unlocked.
  if ! forge script script/deploy/DeployFulfillmentProxy.s.sol \
      --rpc-url "$RPC" \
      --sender "$SENDER" \
      >"$sim" 2>&1
  then
    echo "  FAILED — simulation"
    tail -12 "$sim" | sed 's/^/      /'
    rm -f "$sim"
    fail=1
    [ "$BROADCAST" -eq 1 ] && exit 1
    continue
  fi

  got=$(simulated_address "$(cat "$sim")")
  gas=$(grep -E 'Estimated total gas used for script:|Estimated amount required:' "$sim" | sed 's/^ */  /')
  rm -f "$sim"
  if [ -z "$got" ]; then
    echo "  FAILED — simulation did not log a fulfillment proxy address"
    fail=1
    [ "$BROADCAST" -eq 1 ] && exit 1
    continue
  fi
  echo "  simulated $got"
  [ -n "$gas" ] && printf '%s\n' "$gas"

  if [ "$BROADCAST" -eq 0 ]; then
    if [ -n "$EXPECT" ] && [ "$(lc "$got")" != "$(lc "$EXPECT")" ]; then
      echo "  MISMATCH — simulated $got, expected $EXPECT"
      fail=1
    fi
    continue
  fi

  if [ "$(lc "$got")" != "$(lc "$EXPECT")" ]; then
    echo "  REFUSING — simulated $got, expected $EXPECT. Not broadcasting $NAME."
    exit 1
  fi

  flags=(--rpc-url "$RPC" --account "$ACCOUNT" --sender "$SENDER" --password-file "$PASSWORD_FILE" --broadcast)
  [ "$SLOW" -eq 1 ] && flags+=(--slow)
  if ! forge script script/deploy/DeployFulfillmentProxy.s.sol "${flags[@]}"; then
    echo "  FAILED — broadcast stopped on $NAME ($CID)"
    exit 1
  fi
  # Read the chain, not the script's log: the proxy is at the pinned address and has a pauser.
  if ! has_code "$EXPECT" "$RPC"; then
    echo "  FAILED — no code at $EXPECT on $NAME ($CID) after broadcast"
    exit 1
  fi
  if ! role_ok "$EXPECT" "$PAUSER_ROLE" "$PAUSER" "$RPC"; then
    echo "  FAILED — $PAUSER lacks PAUSER_ROLE on $EXPECT; re-run with --broadcast to grant it"
    exit 1
  fi
  echo "  broadcast $NAME — $EXPECT, PAUSER_ROLE held by $PAUSER"
done < <(printf '%s\n' "$CHAIN_TABLE")

if [ "$ran" -eq 0 ]; then
  echo "no chains selected" >&2
  exit 2
fi
[ "$fail" -eq 0 ] || exit 1
