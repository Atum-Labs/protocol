#!/usr/bin/env bash
# Assert that an escrow pins the widened witness typehashes, and NOT
# the pre-widening V1 ones.
#
#   assert-typehashes.sh --deployed <address> --rpc <url>   # a LIVE contract, any EVM chain
#   assert-typehashes.sh --artifact [path]                  # a COMPILED artifact
#
# With --artifact and no path it searches the usual places (see find_artifact), so it runs from
# anywhere without hunting for the build directory. Needs only `cast` and python3 — no node, no
# tronweb, no network for the artifact mode.
#
# Which check to use, and why three exist. The witness type strings are the thing most likely to
# be silently wrong: Permit2 takes the witness as an opaque bytes32, so a contract pinning the
# pre-widening shape fails nothing at build or deploy time — every deposit just reverts at
# signature verification.
#
#   source     -> contracts/evm/source/test/EncodingExamples.verify.t.sol is BEST for the EVM
#                 source, and this script does not try to replace it. It rebuilds each type
#                 string from the `struct` declaration in src/interfaces/IEscrow.sol
#                 (`_typeStringFromDeclaration`, comments stripped via `_codeOnly`) and runs on
#                 every PR through `forge test`. Deriving from the declaration beats restating
#                 it: a hand-maintained list passes even when someone renames a member and
#                 updates the copy to match.
#   artifact   -> what THIS script's --artifact mode covers, and the forge test does not: a
#                 *compiled* artifact, including the TVM one. The forge test validates EVM
#                 source; it says nothing about what tronbox actually produced.
#                 contracts/tvm/source/docker/assert-widened-witnesses.js does the same job for
#                 the Tron image build, but it is pinned to one directory by construction — it
#                 resolves __dirname/../build/contracts/Escrow.json and require()s tronweb by
#                 walking up — so it only runs from an installed source tree. This mode is the
#                 portable equivalent.
#   deployed   -> what nothing else answers: does the contract at this address, on this chain,
#                 right now, pin the widened set? A green CI and a correct artifact still say
#                 nothing about what is live at an address the config is about to point at.
#
# The typehash is keccak256(typeString) and both EVM and TVM pin the same strings, so the same
# six constants apply to both. TIP-712 vs EIP-712 differ in the DOMAIN SEPARATOR, not these.
#
# NOTE the type strings below are a hand copy of the declarations in IEscrow.sol. They are the
# check's weak point: keep them in step with EncodingExamples.verify.t.sol, which is the
# authority. If the two ever disagree, the forge test is right.
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

V4=(
"DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)"
"ReserveWitness(bytes32 depositId,bytes32 quoteHash,address settler,uint256 sourceAmount)"
"ReleaseWitness(bytes32 depositId,bytes32 quoteHash,bytes32 depositRequestHash,bytes32 destinationHash,address depositor,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser,address settler)"
"RefundWitness(bytes32 depositId,bytes32 quoteHash,bytes32 depositRequestHash,bytes32 destinationHash,address depositor,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser,address settler)"
)
V1=(
"DepositWitness(address reserver,address releaser)"
"ReserveWitness(bytes32 paymentId,address settler)"
)

# Locate a compiled Escrow artifact without being told where it is. Checks, in order: the
# explicit argument, $TVM_ESCROW_ARTIFACT, the cwd's own build tree, both VM source trees
# relative to this script, and then walks up from the cwd looking for a checkout.
find_artifact() {
  local c
  for c in \
    "${TVM_ESCROW_ARTIFACT:-}" \
    "./build/contracts/Escrow.json" \
    "./out/Escrow.sol/Escrow.json" \
    "$HERE/../tvm/source/build/contracts/Escrow.json" \
    "$HERE/../evm/source/out/Escrow.sol/Escrow.json" \
    "$HERE/../source/build/contracts/Escrow.json"
  do
    [ -n "$c" ] && [ -f "$c" ] && { printf '%s' "$c"; return 0; }
  done
  local d; d="$(pwd)"
  while [ "$d" != "/" ]; do
    for c in "$d/contracts/tvm/source/build/contracts/Escrow.json" \
             "$d/contracts/evm/source/out/Escrow.sol/Escrow.json"; do
      [ -f "$c" ] && { printf '%s' "$c"; return 0; }
    done
    d="$(dirname "$d")"
  done
  return 1
}

MODE=""; ADDR=""; RPC=""; ART=""
while [ $# -gt 0 ]; do
  case "$1" in
    --deployed) MODE=deployed; ADDR="$2"; shift 2;;
    --rpc)      RPC="$2"; shift 2;;
    --artifact) MODE=artifact
                case "${2:-}" in -*|"") shift 1;; *) ART="$2"; shift 2;; esac;;
    -h|--help) sed -n '2,8p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

if [ "$MODE" = artifact ]; then
  if [ -n "$ART" ]; then
    # An explicitly named path that does not exist is an ERROR, never a cue to go looking
    # elsewhere: silently checking a different artifact and reporting PASS is the worst thing
    # a gate can do.
    [ -f "$ART" ] || { echo "FATAL: artifact not found: $ART" >&2; exit 1; }
  else
    ART="$(find_artifact)" || {
      echo "FATAL: no compiled Escrow artifact found." >&2
      echo "  Compile first (TVM: pnpm run compile in contracts/tvm/source), or pass a path:" >&2
      echo "    assert-typehashes.sh --artifact <path/to/Escrow.json>" >&2
      echo "  or set TVM_ESCROW_ARTIFACT." >&2
      exit 1; }
  fi
  # tronbox: {"bytecode":"0x..","deployedBytecode":"0x.."} · foundry: {"bytecode":{"object":"0x.."}}
  CODE=$(python3 - "$ART" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
c = []
for k in ("bytecode", "deployedBytecode"):
    v = d.get(k)
    if isinstance(v, dict): v = v.get("object", "")
    c.append(v or "")
print(max(c, key=len).lower())
PY
) || { echo "FATAL: could not read bytecode from $ART" >&2; exit 1; }
  SRC="artifact $ART"
elif [ "$MODE" = deployed ]; then
  [ -n "$RPC" ] || { echo "--deployed needs --rpc" >&2; exit 2; }
  CODE=$(cast code "$ADDR" --rpc-url "$RPC" 2>/dev/null | tr 'A-Z' 'a-z')
  { [ "$CODE" = "0x" ] || [ -z "$CODE" ]; } && { echo "FATAL: no code at $ADDR" >&2; exit 1; }
  SRC="deployed $ADDR"
else
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 2
fi

[ ${#CODE} -lt 100 ] && { echo "FATAL: bytecode too short to be an escrow ($SRC)" >&2; exit 1; }

echo "checking $SRC  (${#CODE} hex chars)"
rc=0
for t in "${V4[@]}"; do
  h=$(cast keccak "$t" | tr 'A-Z' 'a-z'); h=${h#0x}
  n=$(printf '%s' "$t" | cut -d'(' -f1)
  case "$CODE" in *"$h"*) printf '  ok:   %-16s 0x%s... present\n' "$n" "${h:0:16}";;
    *) printf '  FAIL: %-16s 0x%s... MISSING\n' "$n" "${h:0:16}"; rc=1;; esac
done
for t in "${V1[@]}"; do
  h=$(cast keccak "$t" | tr 'A-Z' 'a-z'); h=${h#0x}
  n=$(printf '%s' "$t" | cut -d'(' -f1)
  case "$CODE" in *"$h"*) printf '  FAIL: V1 %-13s 0x%s... PRESENT (supports both shapes)\n' "$n" "${h:0:16}"; rc=1;;
    *) printf '  ok:   V1 %-13s 0x%s... absent as expected\n' "$n" "${h:0:16}";; esac
done
echo
[ "$rc" -eq 0 ] && echo "PASS — pins the widened witness typehashes, and only those." \
              || echo "FAIL — do not point config at this contract."
exit "$rc"
