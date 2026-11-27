#!/usr/bin/env bash
# v4 TVM (Tron) deploy driver.
#
#   contracts/tvm/deploy/deploy.sh --check              # read-only: threshold, balance, energy, shortfall
#   contracts/tvm/deploy/deploy.sh --print-source-dir    # print the resolved tronbox tree and exit
#   contracts/tvm/deploy/deploy.sh                      # dry: compile + widened-witness assertion, no broadcast
#   contracts/tvm/deploy/deploy.sh --broadcast          # migrate to shasta (prompts)
#   NETWORK=mainnet contracts/tvm/deploy/deploy.sh --broadcast
#   FORCE=1 ... --broadcast                   # override the duplicate-deploy guard (read Step 11 first)
#
# Tron has NO CREATE2: a re-run deploys a SECOND live pair at new addresses rather than colliding.
# So this refuses to re-run once it has recorded addresses for a network.
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

# Locate the TVM source tree without being told where it is, so this runs from any cwd and
# from a copy of the script outside the repo. A candidate counts only if it looks like the
# tronbox project (config + the contract), not merely a directory that exists.
is_src() { [ -f "$1/tronbox-config.js" ] && [ -f "$1/contracts/Escrow.sol" ]; }
case "${1:-}" in --print-source-dir) PRINT_SRC=1 ;; esac

find_src() {
  local c d
  # cwd FIRST — see the note in svm/deploy/readiness.sh: sibling-before-cwd makes the repo copy and
  # a PATH symlink disagree from the same directory.
  for c in "$(pwd)" "$HERE/../source" "$HERE/../../tvm/source"; do
    is_src "$c" && { (cd "$c" && pwd); return 0; }
  done
  d="$(pwd)"
  while [ "$d" != "/" ]; do
    is_src "$d/contracts/tvm/source" && { (cd "$d/contracts/tvm/source" && pwd); return 0; }
    d="$(dirname "$d")"
  done
  return 1
}
if [ -n "${SRC_DIR:-}" ]; then
  # An explicitly set SRC_DIR that is not a TVM project is an error, never a cue to search
  # elsewhere — silently compiling a different tree is how you deploy the wrong bytecode.
  is_src "$SRC_DIR" || { echo "SRC_DIR=$SRC_DIR is not a tronbox project (no tronbox-config.js + contracts/Escrow.sol)" >&2; exit 1; }
  SRC_DIR="$(cd "$SRC_DIR" && pwd)"
else
  SRC_DIR="$(find_src)" || {
    echo "Could not find the TVM source tree." >&2
    echo "  Looked beside this script, in the cwd, and upward for contracts/tvm/source." >&2
    echo "  Set it explicitly:  SRC_DIR=/path/to/contracts/tvm/source $0 ${*:-}" >&2
    exit 1; }
fi

# Expose the resolved tree so callers can cd to it without re-implementing the search.
# Printed alone and nothing else, so it is safe in a command substitution.
if [ "${PRINT_SRC:-0}" = "1" ]; then printf '%s\n' "$SRC_DIR"; exit 0; fi

# find_src prefers the CWD, deliberately: running from inside a tree must compile THAT tree. But it
# means the driver and the source can come from different checkouts with nothing saying so, and for
# a mainnet deploy the provenance of the bytecode is the whole question. Say it out loud.
OWN_SRC="$(cd -P "$HERE/../source" 2>/dev/null && pwd)"
if [ -n "$OWN_SRC" ] && [ "$SRC_DIR" != "$OWN_SRC" ]; then
  echo "NOTE: compiling a DIFFERENT tree from the one this script ships with."
  echo "        using  : $SRC_DIR"
  echo "        beside : $OWN_SRC"
  echo "      Allowed, and it is what your cwd or SRC_DIR asked for; the bytecode you deploy comes"
  echo "      from the tree above. To use the one beside this script instead:"
  echo "        SRC_DIR=\"$OWN_SRC\" $0 ${*:-}"
  echo
fi

# The witness gate. Not optional — if it cannot be found, fail rather than deploy ungated.
find_assert() {
  local c d
  for c in "$HERE/../../deploy/assert-typehashes.sh" "$HERE/assert-typehashes.sh"; do
    [ -f "$c" ] && { printf '%s' "$c"; return 0; }
  done
  d="$(pwd)"
  while [ "$d" != "/" ]; do
    [ -f "$d/contracts/deploy/assert-typehashes.sh" ] && { printf '%s' "$d/contracts/deploy/assert-typehashes.sh"; return 0; }
    d="$(dirname "$d")"
  done
  return 1
}
ASSERT="$(find_assert)" || {
  echo "Could not find assert-typehashes.sh (the widened-witness gate)." >&2
  echo "  Expected beside this script or at contracts/deploy/assert-typehashes.sh." >&2
  echo "  Refusing to deploy without it." >&2
  exit 1; }
: "${NETWORK:=shasta}"
: "${MARGIN:=2}"
: "${ENERGY_V3:=6041000}"          # measured on the v3 shasta deployment
OUT="${OUT:-$HOME/atum-v4-tvm-deploy}"; LOGS="$OUT/logs"; mkdir -p "$LOGS"
LOG="$LOGS/$NETWORK.log"; REC="$OUT/$NETWORK.addresses.json"

# Dry is the default, and --dry names it explicitly because the guide referred to
# that flag for a long time while nothing parsed it. Unknown arguments are now
# REFUSED rather than ignored: the old parse fell through to dry for anything it
# did not recognise, so `atum-tvm-deploy --brodcast` dry-ran and reported success
# without ever saying the flag was not understood. Harmless in that direction,
# but a typo silently changing what the command does is not a property to keep.
MODE=dry
case "${1:-}" in
  ''|--dry)            MODE=dry ;;
  --check)             MODE=check ;;
  --broadcast)         MODE=broadcast ;;
  --print-source-dir)  ;;                     # handled earlier, before any network access
    -h|--help)
      # A documented flag should not exit 2 as "unknown argument".
      echo "usage: atum-tvm-deploy [--check | --dry | --broadcast | --print-source-dir]"
      echo "  --check       read-only; no signing key needed"
      echo "  --dry         build and sign locally, broadcast nothing (the default)"
      echo "  --broadcast   deploy for real; prompts for confirmation"
      echo "  --print-source-dir  print the resolved tronbox tree and exit"
      exit 0 ;;
  *)
    echo "unknown argument: ${1}" >&2
    echo "usage: atum-tvm-deploy [--check | --dry | --broadcast | --print-source-dir]" >&2
    echo "  --check       read-only; no signing key needed" >&2
    echo "  --dry         build and sign locally, broadcast nothing (the default)" >&2
    echo "  --broadcast   deploy for real; prompts for confirmation" >&2
    exit 2 ;;
esac
# Declared up front, not created on first use: `arr+=(x)` would create it, so an undeclared
# BLOCKERS is unbound under `set -u` precisely when no blocker fired -- the ready-to-deploy path.
BLOCKERS=()
# --print-source-dir is handled earlier (PRINT_SRC), before any network access.

case "$NETWORK" in
  # DEFAULT_EXPECT is the address this network is EXPECTED to deploy from. It is a default for
  # EXPECT_DEPLOYER, never a source of truth: the address actually used is derived from the
  # signing key, and the two are compared. Per-network, because validating the testnet deployer
  # during a mainnet run is precisely the mistake this replaces.
  shasta)  API=https://api.shasta.trongrid.io; NETID=2; PK_VAR=PRIVATE_KEY_SHASTA
           DEFAULT_EXPECT=TBXUCNjhkhENigyVLS8QqzDMawCE9MfDYa ;;
  # The same secp256k1 key as the EVM mainnet deployer, re-encoded for Tron: identical 20 bytes,
  # 0x41 prefix, base58check. Verified by decoding, not assumed.
  # The v3 mainnet admin, and the v4 deployer: deploying from it makes defaultAdmin identical to
  # what is live today, so no role migration and no admin handover. Its owner permission is 2-of-3,
  # but its ACTIVE permission id=2 is threshold 1 with CreateSmartContract, so one signature is
  # enough -- provided the transaction sets permission_id: 2, which tronbox cannot do.
  mainnet) API=https://api.trongrid.io;        NETID=1; PK_VAR=PRIVATE_KEY_MAINNET
           DEFAULT_EXPECT=TS22r3RgJdHxDp1VvkKFT1buep8usUsRxe ;;
  *) echo "NETWORK must be shasta or mainnet" >&2; exit 1 ;;
esac
# tvm.env ships a single EXPECT field, but this script has always read
# EXPECT_DEPLOYER while import-deployer.sh reads EXPECT -- two names for one
# concept, so filling in the template did nothing here. Accept either.
: "${EXPECT_DEPLOYER:=${EXPECT:-}}"
: "${EXPECT_DEPLOYER:=${DEFAULT_EXPECT:-}}"

cd "$SRC_DIR" || { echo "SRC_DIR not found: $SRC_DIR" >&2; exit 1; }

echo "network   : $NETWORK  (network_id $NETID)"
echo "api       : $API"
echo "tree      : $SRC_DIR"
echo "mode      : $MODE"
echo

# ---------- source sanity: must be v4 ----------
n_net=$(grep -c 'NonExactTransfer' contracts/Escrow.sol 2>/dev/null || echo 0)
n_set=$(grep -c 'SETTLER_ROLE' contracts/FulfillmentProxy.sol 2>/dev/null || echo 0)
dw=$(grep -o 'DepositWitness([^)]*)' contracts/Escrow.sol 2>/dev/null | head -1)
printf 'source    : NonExactTransfer=%s SETTLER_ROLE=%s\n' "$n_net" "$n_set"
printf '            %s\n' "$dw"
case "$dw" in
  *depositRequestHash*destination*) : ;;
  *) echo "REFUSING: deposit witness is not the widened v4 shape. Wrong tree?" >&2; exit 1 ;;
esac
[ "$n_net" -ge 1 ] || { echo "REFUSING: no NonExactTransfer guard — this is not the v4 source." >&2; exit 1; }

# ---------- endpoint + energy price ----------
if [ "$NETWORK" = mainnet ] && grep -q '<API_KEY>' tronbox-config.js 2>/dev/null; then
  echo "BLOCKED: tronbox-config.js mainnet fullHost is still the literal <API_KEY> placeholder." >&2
  echo "         Fix it (and scripts/config.js) before any mainnet attempt." >&2
  BLOCKERS+=("tronbox-config.js mainnet fullHost is a placeholder")
fi

# TronGrid throttles anonymous requests, and a throttled read surfaces as "could not read
# getEnergyFee" rather than as a rate limit. Send the key when we have one -- and assign this
# BEFORE the first read: it used to be set immediately AFTER, so the getEnergyFee call was the
# one request in the whole script that never carried the key, and it was also the first. Exporting
# TRON_API_KEY therefore did not stop this failing, which made it look like a dead endpoint.
API_HDR=()
[ -n "${TRON_API_KEY:-}" ] && API_HDR=(-H "TRON-PRO-API-KEY: $TRON_API_KEY")

# Signing key first, before any network read. This used to be checked twice and
# both were too late: the permissioned handoff exited with a bare "$PK_VAR is not
# set" while the message that actually says what to do sat further down, on the
# tronbox path, unreachable. So the operator waited through the chain-parameter,
# balance and permission reads to be told a variable was unset, by whichever of
# the two messages happened to fire -- usually the terse one.
#
# Checking here also means the deployer is DERIVED rather than reported as
# ASSUMED, so the funding and permission checks below describe the account that
# will really sign.
if [ "$MODE" != check ]; then
  if [ -z "${!PK_VAR:-}" ]; then
    : "${ATUM_HOME:=$HOME/.atum}"
    KEYF="$ATUM_HOME/keys/tron-$NETWORK"
    echo "$PK_VAR is not set, and $MODE mode signs transactions." >&2
    echo >&2
    if [ -f "$KEYF" ]; then
      echo "  The key is already imported. Export it:" >&2
      echo "    export $PK_VAR=\"\$(cat \"$KEYF\" | tr -d '[:space:]')\"" >&2
    else
      echo "  No key at $KEYF. Import one first:" >&2
      echo "    NETWORK=$NETWORK atum-tvm-import-deployer --private-key --write" >&2
      echo "    export $PK_VAR=\"\$(cat \"$KEYF\" | tr -d '[:space:]')\"" >&2
    fi
    echo >&2
    echo "  Mainnet also needs the endpoint and API key (guide step 4):" >&2
    echo "    export TRON_RPC_URL=<your TronGrid endpoint>" >&2
    echo "    export TRON_API_KEY=<your TronGrid API key>" >&2
    echo >&2
    echo "  Or use --check to inspect the account read-only, with no key." >&2
    exit 1
  fi
  # tronbox and tronweb both want BARE hex. A 0x prefix does not error, it silently
  # resolves to a different (or no) account -- so refuse it before anything else.
  case "${!PK_VAR}" in
    0x*|0X*) echo "$PK_VAR has a 0x prefix; tronbox needs bare 64-hex. Strip it." >&2; exit 1 ;;
  esac
  _K="${!PK_VAR}"
  printf '%s' "$_K" | grep -qE '^[0-9a-fA-F]{64}$' \
    || { echo "$PK_VAR is not 64 hex characters (got ${#_K}). A key file read with a trailing newline looks like this; pipe it through tr -d '[:space:]'." >&2; exit 1; }
  unset _K
fi

EFEE=$(curl -s ${API_HDR[@]+"${API_HDR[@]}"} "$API/wallet/getchainparameters" | python3 -c "
import json,sys
for p in json.load(sys.stdin).get('chainParameter',[]):
    if p.get('key')=='getEnergyFee': print(p.get('value')); break" 2>/dev/null)
if [ -z "$EFEE" ]; then
  echo "could not read getEnergyFee from $API" >&2
  if [ -z "${TRON_API_KEY:-}" ]; then
    echo "  TRON_API_KEY is not set, and anonymous TronGrid is throttled to ~3 rps -- a throttled" >&2
    echo "  read looks exactly like this, not like a rate limit. Set it and retry:" >&2
    echo "    export TRON_API_KEY=<your TronGrid API key>" >&2
  else
    echo "  TRON_API_KEY is set, so this is the endpoint or the key: check $API, and that the key" >&2
    echo "  is valid and not over quota. Repeated runs in quick succession can still be throttled." >&2
  fi
  exit 1
fi

# ---------- deployer identity: derived from the SIGNING key, not assumed ----------
# This used to be a per-network hardcoded address, which meant the balance and threshold checks
# below inspected one account while the broadcast signed with whatever $PK_VAR held -- the two were
# never compared. On a network whose configured deployer is not the key you hold, that reports the
# wrong balance and the wrong threshold, and can both block a deploy that would work and wave
# through one that will not.
#
# EXPECT_DEPLOYER is now an optional PIN, not a source of truth.
tron_from_eth() {  # 0x<20-byte hex> -> base58check T...
  python3 -c '
import hashlib, sys
raw = bytes.fromhex(sys.argv[1].lower().removeprefix("0x"))
p = b"\x41" + raw
c = hashlib.sha256(hashlib.sha256(p).digest()).digest()[:4]
n = int.from_bytes(p + c, "big"); A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
s = ""
while n: n, r = divmod(n, 58); s = A[r] + s
print(s)' "$1"
}

if [ -n "${!PK_VAR:-}" ]; then
  case "${!PK_VAR}" in 0x*|0X*) K="$(printf '%s' "${!PK_VAR}" | sed 's/^0[xX]//')" ;; *) K="${!PK_VAR}" ;; esac
  ETHD="$(cast wallet address --private-key "0x$K" 2>/dev/null)" \
    || { echo "$PK_VAR is set but cast could not derive an address from it" >&2; exit 1; }
  DEPLOYER_ADDR="$(tron_from_eth "$ETHD")"
  DEPLOYER_SRC="derived from $PK_VAR"
  unset K
elif [ -n "${EXPECT_DEPLOYER:-}" ]; then
  DEPLOYER_ADDR="$EXPECT_DEPLOYER"
  DEPLOYER_SRC="EXPECT_DEPLOYER (ASSUMED — $PK_VAR is not set, so this is not necessarily what will sign)"
else
  echo "Cannot tell which account would deploy." >&2
  echo "  Either export $PK_VAR (authoritative — the address is derived from it)," >&2
  echo "  or set EXPECT_DEPLOYER=T... to check a specific account read-only." >&2
  exit 2
fi

# A pin, when both are known: refuse rather than deploy from an unintended account.
if [ -n "${EXPECT_DEPLOYER:-}" ] && [ "$DEPLOYER_ADDR" != "$EXPECT_DEPLOYER" ]; then
  echo "REFUSING: the signing key resolves to $DEPLOYER_ADDR, but EXPECT_DEPLOYER=$EXPECT_DEPLOYER." >&2
  echo "  Tron bakes defaultAdmin in at construction, so deploying from the wrong key is not" >&2
  echo "  recoverable by a config edit. Fix the key or the pin." >&2
  exit 3
fi

# ---------- balance ----------
BAL=$(curl -s -X POST "$API/wallet/getaccount" -H 'Content-Type: application/json' ${API_HDR[@]+"${API_HDR[@]}"} \
      -d "{\"address\":\"$DEPLOYER_ADDR\",\"visible\":true}" \
      | python3 -c "import json,sys; print(json.load(sys.stdin).get('balance',0))" 2>/dev/null)
PERMS=$(curl -s -X POST "$API/wallet/getaccount" -H 'Content-Type: application/json' ${API_HDR[@]+"${API_HDR[@]}"} \
      -d "{\"address\":\"$DEPLOYER_ADDR\",\"visible\":true}" \
      | python3 -c "
import json,sys
d=json.load(sys.stdin); op=d.get('owner_permission') or {}
print(f\"{op.get('threshold')}/{len(op.get('keys') or [])}\")" 2>/dev/null)

read -r NEED SHORT <<EOF
$(python3 -c "
e=$ENERGY_V3; f=$EFEE; m=$MARGIN; bal=$BAL
need=e*f*m/1_000_000
have=bal/1_000_000
print(f'{need:.2f}', f'{max(0,need-have):.2f}')")
EOF
printf 'energy fee: %s sun/energy   v3-measured energy: %s\n' "$EFEE" "$ENERGY_V3"
printf 'deployer  : %s  owner-threshold %s\n' "$DEPLOYER_ADDR" "$PERMS"
printf 'key src   : %s\n' "$DEPLOYER_SRC"
printf 'balance   : %s TRX\n' "$(python3 -c "print(f'{$BAL/1_000_000:,.2f}')")"
printf 'need (%sx) : %s TRX   shortfall: %s TRX\n' "$MARGIN" "$NEED" "$SHORT"

# owner threshold > 1 means tronbox (no permission_id support) cannot sign alone
THR=${PERMS%%/*}
if [ "$PERMS" = "None/0" ] || [ -z "$PERMS" ]; then
  echo
  echo "NOTE: $DEPLOYER_ADDR is NOT ACTIVATED on $NETWORK — it has no account object yet, so its"
  echo "      threshold is unknown rather than 1. It must receive TRX from an already-active account"
  echo "      before it can transact. Re-run this check once it is funded."
  # Exit non-zero in EVERY mode: "cannot transact at all" is not a passing preflight, and a
  # wrapper reading the status would otherwise see success. EVM funding-check behaves the same.
  BLOCKERS+=("$DEPLOYER_ADDR is not activated on $NETWORK")
fi
if [ "${THR:-1}" != "1" ] && [ "$PERMS" != "None/0" ]; then
  echo
  # Distinguish the two cases, because the remedy is completely different: an account that forbids
  # single-key deploys needs a co-signing ceremony, whereas one that permits it via an active
  # permission needs a transaction that names that permission. Read the account rather than assume.
  ACTIVE_OK=$(curl -s -X POST "$API/wallet/getaccount" -H 'Content-Type: application/json' ${API_HDR[@]+"${API_HDR[@]}"} \
    -d "{\"address\":\"$DEPLOYER_ADDR\",\"visible\":true}" | python3 -c "
import json,sys
# Three outcomes, not two. Printing '' for a failed read AND for 'no such
# permission' made a throttled response indistinguishable from a definite
# answer, and the caller then stated the account genuinely needs co-signers --
# a confident wrong diagnosis that sends someone to arrange a signing ceremony
# they do not need. An existing account's getaccount always carries 'address',
# so its absence means the read did not succeed, whatever the status code was.
raw = sys.stdin.read()
try: d = json.loads(raw)
except Exception: print('READ_FAILED'); raise SystemExit
if not isinstance(d, dict) or 'address' not in d:
    print('READ_FAILED'); raise SystemExit
for a in d.get('active_permission') or []:
    ops=a.get('operations','') or ''
    try: b=bytes.fromhex(ops)
    except Exception: continue
    can=lambda t: bool(b[t//8]>>(t%8)&1) if t//8<len(b) else False
    if a.get('threshold',99)<=1 and can(30):
        print(a.get('id')); break
else:
    print('NONE')
" 2>/dev/null)
  echo "BLOCKED: owner_permission.threshold=$THR — tronbox signs against the OWNER permission and has"
  echo "         no permission_id support (grep the repo: none), so a single signature is rejected."
  if [ -z "$ACTIVE_OK" ] || [ "$ACTIVE_OK" = READ_FAILED ]; then
    echo
    echo "         Could NOT read this account's permissions, so whether a single-key deploy is"
    echo "         possible is UNKNOWN — this is not a statement that it is impossible."
    if [ -z "${TRON_API_KEY:-}" ]; then
      echo "         TRON_API_KEY is not set and anonymous TronGrid is throttled to ~3 rps; a"
      echo "         throttled read looks exactly like this. Set it and re-run:"
      echo "           export TRON_API_KEY=<your TronGrid API key>"
    else
      echo "         TRON_API_KEY is set, so check the endpoint ($API) and the key's quota."
    fi
    BLOCKERS+=("could not read the deployer's permissions — unknown, not impossible")
  elif [ "$ACTIVE_OK" != NONE ]; then
    echo
    echo "         BUT this account PERMITS a single-key deploy: active permission id=$ACTIVE_OK is"
    echo "         threshold 1 and includes CreateSmartContract. The blocker is the TOOLING, not the"
    echo "         account — the transaction has to set permission_id: $ACTIVE_OK, which tronbox"
    echo "         cannot express. A TronWeb deploy path can (trx.multiSign(tx, key, $ACTIVE_OK))."
    echo "         No co-signing ceremony is needed. See Step 10 of the guide."
    if [ -f "$HERE/deploy-permissioned.js" ]; then
      echo
      echo "         deploy-permissioned.js handles this: it builds the CreateSmartContract"
      echo "         transaction, stamps Permission_id=$ACTIVE_OK, signs once and broadcasts."
      PERMISSIONED="$ACTIVE_OK"
    else
      BLOCKERS+=("tronbox cannot set permission_id: $ACTIVE_OK, and deploy-permissioned.js is missing")
    fi
  else
    echo "         This account has no active permission that allows a single-key deploy either, so it"
    echo "         genuinely needs $THR signatures. See Step 10 of the guide."
    BLOCKERS+=("owner_permission.threshold=$THR and no single-key active permission")
  fi
fi
if [ "$SHORT" != "0.00" ]; then
  echo "UNDERFUNDED by $SHORT TRX"
  BLOCKERS+=("underfunded by $SHORT TRX")
fi
# This gate comes BEFORE any handoff. It used to sit after, which let the
# permissioned path step over it entirely: an underfunded deploy, or any other
# accumulated blocker, would exec straight into the TronWeb driver and be
# discovered by the chain instead. That is worse on Tron than elsewhere -- Escrow
# can land and FulfillmentProxy then run out of energy, leaving a half-deployed
# pair at addresses nothing predicted.
if [ ${#BLOCKERS[@]} -gt 0 ]; then
  echo
  printf 'BLOCKED by %s condition(s):\n' "${#BLOCKERS[@]}" >&2
  # Plainly quoted, not the ${a[@]+"${a[@]}"} guard used for API_HDR/PASSARG: the branch
  # condition above already proves BLOCKERS is non-empty, so there is no empty-array-under-set-u
  # case to guard. Quoted so each blocker stays ONE %s even though they contain spaces.
  printf '  - %s\n' "${BLOCKERS[@]}" >&2
  echo "Nothing was compiled or broadcast." >&2
  exit 1
fi

# ---------- duplicate-deploy guard ----------
# BEFORE the handoff, not after. It used to sit below the exec, so it protected the
# tronbox path and was unreachable on the permissioned one -- meaning a re-run of a
# multisig-owned deploy would NOT be refused and would put a second live pair on
# chain. Same shape as the blockers gate above: anything that guards a broadcast
# has to precede every path that can broadcast.
#
# Only --broadcast is refused. A dry re-run cannot create anything, and rehearsing
# after a deploy is a reasonable thing to want, so that warns and continues.
if [ -f "$REC" ]; then
  if [ "$MODE" = broadcast ] && [ "${FORCE:-0}" != "1" ]; then
    echo
    echo "REFUSING: $REC already records a deployment for $NETWORK:" >&2
    python3 -c "
import json
d=json.load(open('$REC'))
for k in ('escrow','fulfillmentProxy'):
    v=d.get(k)
    if isinstance(v,dict): print(f'    {k:18} {v.get(\"address\")}  txid {str(v.get(\"txid\"))[:16]}...')
    elif v: print(f'    {k:18} {v}')" 2>/dev/null || cat "$REC" >&2
    echo "  Tron has no CREATE2, so re-running would deploy a SECOND live pair at new addresses" >&2
    echo "  while the recorded pair stays deployed and callable. Pass FORCE=1 only if that is what" >&2
    echo "  you intend, and read Step 11 first." >&2
    exit 1
  fi
  if [ "$MODE" = dry ]; then
    echo
    echo "NOTE: $REC already records a deployment for $NETWORK. This dry run broadcasts"
    echo "      nothing, so it is safe; a --broadcast would be refused without FORCE=1."
  fi
fi

# When an active permission is required, tronbox cannot express it -- hand the whole deploy to the
# TronWeb path. Everything above (source shape, deployer identity, funding, threshold) has already
# been checked AND enforced by the gate above, and that script re-runs the widened-witness gate on
# the artifact itself.
if [ -n "${PERMISSIONED:-}" ] && [ "$MODE" != check ]; then
  # deploy-permissioned.js is mainnet-only in three places this handoff does not
  # override: PERMIT2 and USDT default to the mainnet addresses (:86-87) while shasta's
  # Permit2 is TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp (source/scripts/config.js:10), and it
  # records into mainnet.addresses.json with network:'mainnet' (:281-282). Escrow takes
  # Permit2 as a CONSTRUCTOR argument and Tron has no CREATE2, so a non-mainnet run down
  # this path produces an Escrow permanently bound to the wrong Permit2 at an address no
  # config edit can correct -- and the exec below happens before the type-the-network
  # confirmation, so nothing else stops it. PERMISSIONED is set from the deployer's
  # active permission alone, which is not a mainnet-only property.
  if [ "$NETWORK" != mainnet ]; then
    echo "REFUSING: deploy-permissioned.js is mainnet-only. It defaults PERMIT2/USDT to the" >&2
    echo "  mainnet addresses and records into mainnet.addresses.json, so on $NETWORK it would" >&2
    echo "  construct Escrow against the wrong Permit2 and overwrite the mainnet record." >&2
    echo "  Deploy $NETWORK through the ordinary path, or make those constants per-network." >&2
    exit 1
  fi
  echo
  echo "==> handing off to deploy-permissioned.js (permission_id $PERMISSIONED)"
  # SRC_DIR is the tree resolved and validated above. Without it the driver recomputes
  # the path from its own location, so the artifact it deploys can come from a
  # different checkout than the one this script just checked and printed.
  TRON_RPC_URL="${TRON_RPC_URL:-$API}" PERMISSION_ID="$PERMISSIONED" \
  SRC_DIR="$SRC_DIR" \
  PRIVATE_KEY_MAINNET="${!PK_VAR}" \
    exec node "$HERE/deploy-permissioned.js" \
      "$([ "$MODE" = broadcast ] && echo --broadcast || echo --dry)"
fi


# A clean check exits 0 here; blockers above have already exited 1.
[ "$MODE" = check ] && exit 0

# ---------- compile + hard gate ----------
echo; echo "compiling…"
pnpm run compile >>"$LOG" 2>&1 || { echo "compile FAILED (log: $LOG)"; tail -12 "$LOG"; exit 1; }
# Portable gate: cast + python3 only, so it works with no node_modules installed.
if bash "$ASSERT" --artifact "$SRC_DIR/build/contracts/Escrow.json" >>"$LOG" 2>&1; then
  echo "widened-witness assertion: PASS"
else
  echo "widened-witness assertion FAILED (log: $LOG)"; tail -14 "$LOG"; exit 1
fi

if [ "$MODE" = dry ]; then
  echo; echo "dry run complete. Nothing broadcast. Re-run with --broadcast to migrate."
  exit 0
fi

# ---------- broadcast ----------
# The key was validated up front, before any network read, so there is nothing to
# re-check here. (The old block did, and its remediation named ~/.atum-tron-<net>,
# a path nothing has ever written -- import-deployer writes $ATUM_HOME/keys/tron-<net>.)
printf 'Type the network name to confirm broadcasting to %s: ' "$NETWORK"; read -r ack
[ "$ack" = "$NETWORK" ] || { echo aborted; exit 1; }

echo "migrating…"
if ! pnpm run "migrate:$NETWORK" >>"$LOG" 2>&1; then
  echo "MIGRATION FAILED — last lines:"; tail -20 "$LOG" | sed 's/^/    /'
  echo "  full log: $LOG"; exit 1
fi

# ---------- capture addresses from the build artefacts (more reliable than stdout) ----------
python3 - "$NETID" "$REC" "$LOG" <<'PY'
import json,sys,os
netid,rec,log=sys.argv[1],sys.argv[2],sys.argv[3]
out={}
for name in ("Escrow","FulfillmentProxy"):
    p=f"build/contracts/{name}.json"
    try:
        d=json.load(open(p))
        out[name]=d.get("networks",{}).get(netid,{}).get("address")
    except Exception as e:
        out[name]=None
json.dump(out,open(rec,"w"),indent=2)
print("addresses:", json.dumps(out))
if not all(out.values()):
    print("WARNING: an address is missing from the build artefacts — check", log)
PY
echo
echo "recorded  : $REC"
echo "log       : $LOG"
echo
echo "NEXT: rewrite scripts/config.js with these addresses BEFORE running any admin script (guide Step 8)."
