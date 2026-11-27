#!/usr/bin/env bash
# Publish contract SOURCE to each chain's explorer for the v4 deployments (CORE-2124).
#
#   contracts/deploy/verify-sources.sh testnet --dry-run   # show what would be submitted
#   contracts/deploy/verify-sources.sh testnet             # submit
#   contracts/deploy/verify-sources.sh mainnet             # submit (do testnet first)
#
# THIS PUBLISHES SOURCE PUBLICLY AND PERMANENTLY. Sourcify has no practical withdrawal, so the
# first successful submission on ANY network makes this source public -- testnet and mainnet
# compile from the same tree. Treat the first run as the disclosure decision, not the mainnet one.
#
# WHAT IT REFUSES TO DO. It will not submit source for an address it cannot prove that source
# produced. Before anything is sent, the tree's compiler settings are asserted (derive-guard.sh),
# the initcode is rebuilt with the same constructor arguments deploy.sh uses, and the resulting
# CREATE2 address is compared against each recorded deployment. Source is submitted only for a
# contract whose recorded address this tree reproduces: publishing it anywhere else would attach the
# wrong source to a live contract -- worse than leaving it unverified, because it would look
# authoritative. A contract built from an earlier commit is skipped by name, and a network where
# the tree reproduces nothing aborts.
#
# FulfillmentProxy and FulfillmentProxyPreview are both FulfillmentProxy source with different
# bytecode, so one tree reproduces at most one of them on a network. Verify the other from the
# commit that built it.
#
# The comparison is cheap and covers a whole network at once: CREATE2 with a fixed factory and
# salt gives every chain on a network the same address, which is why all eight testnet chains
# share one and all eight mainnet chains share another.
set -uo pipefail

HERE="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # contracts/deploy
CONTRACTS="$(cd -P "$HERE/.." && pwd)"                    # contracts
SRC_DIR="$CONTRACTS/evm/source"

NETWORK="${1:-}"
DRY_RUN=0
for a in "$@"; do [ "$a" = "--dry-run" ] && DRY_RUN=1; done
case "$NETWORK" in
  testnet|mainnet) ;;
  *) echo "usage: $0 <testnet|mainnet> [--dry-run]" >&2; exit 64 ;;
esac

command -v forge >/dev/null || { echo "REFUSING: forge is not installed" >&2; exit 2; }
command -v cast  >/dev/null || { echo "REFUSING: cast is not installed" >&2; exit 2; }

cd "$SRC_DIR" || exit 2

# 1. The tree must be the one whose settings reproduce canonical bytecode. Without this the
#    initcode below is not the deployed initcode and every later check is meaningless.
echo "== compiler settings"
"$HERE/../evm/deploy/derive-guard.sh" || { echo "REFUSING: wrong compiler settings" >&2; exit 1; }

# shellcheck disable=SC1090
. "$CONTRACTS/evm/deploy/${NETWORK}.env"

echo "== building"
forge build >/dev/null || { echo "REFUSING: build failed" >&2; exit 1; }

# 2. Rebuild the initcode exactly as deploy.sh does, constructor arguments included. These are
#    the arguments that went into the deployed address, so they are also the arguments the
#    explorer needs in order to match.
ESC_ARGS=$(cast abi-encode 'c(address,address)' "$PERMIT2_ADDRESS" "$DEPLOYER" | cut -c3-)
FP_ARGS=$(cast abi-encode 'c(address)' "$DEPLOYER" | cut -c3-)
# A tree with src/EscrowReserveLib.sol links the Escrow to a CREATE2 library, so its initcode (and
# address) is that of the LINKED Escrow. escrow-lib.sh derives it as deploy.sh does and sets ESC_BC,
# WANT_LIB and LIB_SPEC; on a tree with no library those are the plain bytecode and empty.
# shellcheck disable=SC1091
. "$CONTRACTS/evm/deploy/escrow-lib.sh"
derive_escrow_link || { echo "REFUSING: could not derive the linked Escrow initcode" >&2; exit 1; }
FP_BC=$(forge inspect src/FulfillmentProxy.sol:FulfillmentProxy bytecode) || exit 1
# create2_address takes only the address, whichever way this cast version lays out the line.
ESC_ADDR=$(create2_address "$FACTORY" "$SALT" "$(cast keccak "${ESC_BC}${ESC_ARGS}")")
FP_ADDR=$(create2_address "$FACTORY" "$SALT" "$(cast keccak "${FP_BC}${FP_ARGS}")")
[ -n "$ESC_ADDR" ] && [ -n "$FP_ADDR" ] || { echo "REFUSING: could not derive the CREATE2 addresses" >&2; exit 1; }
lc() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }

# 3. The refusal gate, per contract: derived must equal recorded, or that contract is not submitted.
echo "== address self-check"
PLAN=(); MATCHED=0
while read -r chainId explorer name rec; do
  case "$name" in
    Escrow) got=$ESC_ADDR; target=src/Escrow.sol:Escrow; args=$ESC_ARGS ;;
    FulfillmentProxy|FulfillmentProxyPreview) got=$FP_ADDR; target=src/FulfillmentProxy.sol:FulfillmentProxy; args=$FP_ARGS ;;
    *) continue ;;
  esac
  if [ "$(lc "$rec")" = "$(lc "$got")" ]; then
    printf '  OK   %-8s %-24s %s\n' "$chainId" "$name" "$rec"
    PLAN+=("$chainId|$explorer|$name|$target|$rec|$args"); MATCHED=$((MATCHED+1))
  else
    printf '  SKIP %-8s %-24s %s -- this tree builds %s, so it is not submitted\n' "$chainId" "$name" "$rec" "$got"
  fi
done < <(node -e "
  const d=require('$CONTRACTS/evm/deployments-v4.json'), x=require('$CONTRACTS/explorers.json');
  const want=('$NETWORK'==='mainnet');
  for (const [id,e] of Object.entries(d)) if (!!e.mainnet===want) {
    const ex=(x.evm[id] && (x.evm[id].checks||[]).length) ? 'ok' : 'null';
    for (const n of ['Escrow','FulfillmentProxy','FulfillmentProxyPreview'])
      if (e.contracts[n]) console.log(id, ex, n, e.contracts[n]);
  }
")
[ "$MATCHED" -gt 0 ] || { echo "REFUSING: this tree produces none of the recorded $NETWORK addresses" >&2; exit 1; }

# 4. Submit. Chains with no identified explorer are skipped by name, never silently.
echo "== submitting${ETHERSCAN_API_KEY:+ to Etherscan, falling back} to Sourcify"
SUBMITTED=0; SKIPPED=0; FAILED=0
for row in "${PLAN[@]}"; do
  IFS='|' read -r chainId explorer name target addr args <<< "$row"
  # The linked Escrow needs its library address at verification, or the explorer recompiles a
  # different initcode. (The library itself is a separate contract and is not submitted here.)
  libflags=()
  if [ "$name" = "Escrow" ] && [ -n "${LIB_SPEC:-}" ]; then libflags=(--libraries "$LIB_SPEC"); fi
  if [ "$explorer" = "null" ]; then
    echo "  SKIP $chainId $name — no explorer identified (recorded as unresolved in explorers.json)"
    SKIPPED=$((SKIPPED+1)); continue
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  DRY  chain=$chainId $name $target $addr"
    continue
  fi
  # Etherscan FIRST when a key is present: it recompiles and compares bytecode itself, so it is
  # the only verifier that can give us a full match, and it is the explorer people open. Sourcify
  # is the keyless fallback and tops out at partial for our stripped-metadata bytecode.
  # Per-contract log: a shared per-chain log makes one contract's failure indistinguishable
  # from its sibling's success, which misreported Avalanche Fuji on the first real run.
  LOGF="/tmp/vs.$chainId.$name.log"
  : > "$LOGF"
  ok=0; how=""
  if [ -n "${ETHERSCAN_API_KEY:-}" ]; then
    # forge reads ETHERSCAN_API_KEY from the environment. Passing it as a flag would put the key
    # in argv, visible to ps for the life of the call.
    if forge verify-contract "$addr" "$target" \
         --chain-id "$chainId" --verifier etherscan \
         --constructor-args "0x$args" "${libflags[@]+"${libflags[@]}"}" --watch >>"$LOGF" 2>&1; then
      ok=1; how="etherscan"
    fi
  fi
  if [ "$ok" -eq 0 ]; then
    if forge verify-contract "$addr" "$target" \
         --chain-id "$chainId" --verifier sourcify \
         --verifier-url https://sourcify.dev/server \
         --constructor-args "0x$args" "${libflags[@]+"${libflags[@]}"}" --watch >>"$LOGF" 2>&1; then
      ok=1; how="sourcify${ETHERSCAN_API_KEY:+ (etherscan failed)}"
    fi
  fi
  if [ "$ok" -eq 1 ]; then
    echo "  OK   chain=$chainId $name $addr — $how"
    SUBMITTED=$((SUBMITTED+1))
  else
    echo "  FAIL chain=$chainId $name $addr — $(tail -2 "$LOGF" | tr '\n' ' ')"
    FAILED=$((FAILED+1))
  fi
done

echo
echo "  submitted=$SUBMITTED skipped=$SKIPPED failed=$FAILED"
# This tally is ADVISORY. forge --watch can stop polling while the explorer goes on to accept the
# submission asynchronously, which reports a false failure -- it did on the first real run. The
# authoritative answer is check-explorer-verification.mjs, so re-run that before believing this.
echo "  (advisory: re-run check-explorer-verification.mjs for the authoritative state)"
[ "$FAILED" -eq 0 ] || exit 1
