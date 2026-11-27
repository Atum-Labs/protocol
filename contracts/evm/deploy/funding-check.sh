#!/usr/bin/env bash
# How much native gas does the v4 EVM deploy need, per chain, and what is short?
#
#   contracts/evm/deploy/funding-check.sh                  # every chain in CHAIN_TABLE
#   CHAINS="84532 421614" contracts/evm/deploy/funding-check.sh
#   MARGIN=5 contracts/evm/deploy/funding-check.sh         # safety multiplier (default 3)
#
# Gas for the two CREATE2 deployments is MEASURED per chain via `cast estimate --create`.
# Role grants are an allowance (ROLE_GAS, default 240k for 4 grants).
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
: "${NETWORK:=testnet}"
case "$NETWORK" in
  testnet|mainnet) ;;
  *) echo "unknown NETWORK '$NETWORK' (expected testnet|mainnet)" >&2; exit 2 ;;
esac
ENVF="${ENVF:-$HERE/$NETWORK.env}"
[ -f "$ENVF" ] && { set -a; . "$ENVF"; set +a; }


: "${SRC_DIR:=$(cd "$HERE/../source" 2>/dev/null && pwd)}"
[ -n "$SRC_DIR" ] || { echo "cannot resolve ../source from $HERE" >&2; exit 1; }
: "${DEPLOYER:=}"
[ -n "$DEPLOYER" ] || {
  echo "DEPLOYER is not set. Source testnet.env or mainnet.env first; it used to default to the" >&2
  echo "testnet deployer, which reported funding for the wrong account on a mainnet run." >&2
  exit 2; }
: "${PERMIT2_ADDRESS:=0x000000000022D473030F116dDEE9F6B43aC78BA3}"
: "${FACTORY:=0x4e59b44847b379578588920ca78fbf26c0b4956c}"
: "${SALT:=}"
[ -n "$SALT" ] || {
  echo "SALT is not set. The Escrow initcode embeds EscrowReserveLib's CREATE2 address, which depends on it," >&2
  echo "so the deploy cannot even be sized without it. Source testnet.env or mainnet.env first." >&2
  exit 2; }
: "${MARGIN:=3}"
: "${ROLE_GAS:=240000}"
# Practical floor per token. The computed figure is meaningless when a chain reports a
# sub-gwei price (Fuji) and excludes the L1 data fee on OP-stack rollups, so recommend
# at least this much on any chain that needs a top-up at all.
# chain id -> "<native symbol> <is-op-stack-l2>". Keeping this keyed on the id means CHAIN_TABLE
# carries only cid|name|rpc, the same three fields every other driver uses, instead of a second
# table format that has to be kept in step.
chain_meta() {
  case "$1" in
    1|11155111)     echo "ETH 0"  ;;   # Ethereum / Sepolia
    8453|84532)     echo "ETH 1"  ;;   # Base
    42161|421614)   echo "ETH 1"  ;;   # Arbitrum
    10|11155420)    echo "ETH 1"  ;;   # Optimism
    137|80002)      echo "POL 0"  ;;   # Polygon / Amoy
    42220|11142220) echo "CELO 0" ;;   # Celo
    43114|43113)    echo "AVAX 0" ;;   # Avalanche
    5042|5042002)   echo "USDC 0" ;;   # Arc: the native coin IS USDC, 18 decimals over RPC, so no token_gas_meta entry
    *) echo "" ;;                      # unknown: refuse rather than guess
  esac
}

# chain id -> "<gas-token address> <decimals> <symbol>", for chains that charge gas in an ERC-20
# instead of a native coin. Tempo does: "Tempo charges gas in pathUSD, not a native coin"
# (atum-core config/chains/devnet.yaml:153). Membership lives ONLY here, and chain_meta() above
# deliberately returns "" for these ids, so the native path and this one cannot disagree about
# which chains are which.
#
# Why a separate path at all: `cast balance` on Tempo returns 4242424242...4242 -- a placeholder,
# byte-identical on both of its chains and unrelated to spendable gas. Priced through the native
# path that reads as astronomically over-funded, while the deployer actually held 0.445863 pathUSD
# on mainnet. A confidently wrong funding verdict is worse than no verdict.
token_gas_meta() {
  case "$1" in
    4217)  echo "0x20C0000000000000000000000000000000000000 6 pathUSD" ;;  # Tempo Mainnet
    42431) echo "0x20C0000000000000000000000000000000000000 6 pathUSD" ;;  # Tempo Moderato
    *) echo "" ;;
  esac
}

# Floor for a token-gas chain, in whole tokens. NOT derived from gas x gasPrice: on Tempo the gas
# figure is wei-scaled (21000 x 6e8 = 1.26e13, i.e. ~1.26e-5 at 18dp) while the token it settles in
# is 6dp, and the conversion the chain applies is not observable over RPC. So this is an EMPIRICAL
# floor, not an estimate.
#
# MEASURED 2026-09-02 on the real Moderato v4 deploy (6 transactions, gas price 0.686 gwei):
# the whole deploy cost **0.023466 pathUSD**. (The linked generation adds a seventh transaction, the
# EscrowReserveLib deploy, and a larger Escrow, roughly 1.3x that: still a tenth of the floor.) Scaled to Tempo Mainnet's 0.600 gwei that is about
# 0.0205. The floor below is roughly 10x that, which is what a floor is for -- catching an empty or
# wrong deployer, not predicting the bill -- and it leaves room for the five token-config
# transactions that follow.
#
# The previous value was 1000, guessed from Moderato's ~1,000,000 pathUSD seed on the assumption
# that a large seed implied a large cost. It is about 42,000x the real figure, and it manufactured a
# blocker: Tempo Mainnet holds 0.4459 pathUSD -- 21.7x what the deploy actually needs -- and was
# reported as FUND, needing 999.55 more. Do not raise this above ~0.44 without re-measuring, or
# mainnet goes back to failing a check it comfortably passes.
: "${TEMPO_GAS_FLOOR:=0.25}"

# A recommended top-up floor, so a sub-gwei reading does not suggest funding a rounding error.
# Chain-id keyed, not symbol keyed: Ethereum MAINNET gas is the volatile one, and a floor tuned
# for a testnet at 0.04 gwei is far too low there. At a routine 3-5 gwei, 7M gas costs
# ~0.02-0.035 ETH, so 0.05 leaves real headroom; the L2s stay cheap.
floor_for() {  # <chainid> <symbol>
  case "$1" in
    1)     echo 0.05 ;;                 # Ethereum mainnet
    42220) echo 5    ;;                 # Celo mainnet
    137)   echo 10   ;;                 # Polygon mainnet
    43114) echo 1    ;;                 # Avalanche mainnet
    *) case "$2" in ETH) echo 0.02;; CELO) echo 2;; POL) echo 5;; AVAX) echo 0.5;; USDC) echo 1;; *) echo 0.05;; esac ;;
  esac
}

# chainid|name|symbol|l2|rpc
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
TABLE="$CHAIN_TABLE"

cd "$SRC_DIR" || { echo "SRC_DIR not found: $SRC_DIR" >&2; exit 1; }
# Sized on the LINKED Escrow initcode (the unlinked one is not hex), plus the library's own deploy:
# EscrowReserveLib is a second contract creation, ahead of the Escrow, at its CREATE2 address.
. "$HERE/escrow-lib.sh"
derive_escrow_link || { echo "could not link Escrow to EscrowReserveLib" >&2; exit 1; }
# DEPLOY_PROXY=0 sizes the Escrow and library only (the proxy is already deployed; see deploy.sh).
: "${DEPLOY_PROXY:=1}"
FP_BC=""; [ "$DEPLOY_PROXY" = 1 ] && { FP_BC=$(forge inspect src/FulfillmentProxy.sol:FulfillmentProxy bytecode) || exit 1; }

printf 'deployer %s   margin %sx   role-grant allowance %s gas\n\n' "$DEPLOYER" "$MARGIN" "$ROLE_GAS"
printf '%-18s %-5s %11s %10s %12s %12s %12s %11s  %s\n' CHAIN SYM GAS GWEI NEEDED HAVE SHORT "TOP UP" STATUS
printf '%s\n' "---------------------------------------------------------------------------------------------------------------"

# ANY_SHORT is a funding shortfall with a recommendation in TOP UP THESE; ANY_ERR COUNTS the chains
# that could not be MEASURED at all. Both exit 1, but they are kept apart deliberately: an
# unmeasured chain contributes no recommendation, so folding it into ANY_SHORT would print
# funding-looks-fine output while exiting non-zero. A count, not a flag, so the summary below can
# say how many rows are unmeasured rather than only that some row is.
TOTALS=""; ANY_SHORT=0; ANY_ERR=0
for line in $(echo "$TABLE" | tr ' ' '\a' | grep -v '^$'); do
  row=$(printf '%s' "$line" | tr '\a' ' ')
  CID=$(echo "$row"|cut -d'|' -f1); NAME=$(echo "$row"|cut -d'|' -f2)
  RPC=$(echo "$row"|cut -d'|' -f3)
  # CHAINS filters FIRST, ahead of every branch below that can touch a flag. It used to be applied
  # after the unknown-chain-id check, so `CHAINS="8453"` could still be failed by an unrelated row
  # in CHAIN_TABLE -- a run scoped to one chain reporting the status of a chain it never printed.
  [ -n "${CHAINS:-}" ] && ! echo " $CHAINS " | grep -q " $CID " && continue
  # Token-gas chains take their own path: the balance is an ERC-20, and the verdict is against an
  # empirical floor rather than a computed need (see token_gas_meta above).
  TGAS="$(token_gas_meta "$CID")"
  if [ -n "$TGAS" ]; then
    TOK="${TGAS%% *}"; rest="${TGAS#* }"; TDEC="${rest%% *}"; TSYM="${rest##* }"
    live=$(cast chain-id --rpc-url "$RPC" 2>/dev/null) || {
      printf '%-18s %-5s %11s %10s %12s %12s %12s %11s  RPC UNREACHABLE\n' "$NAME" "$TSYM" - - - - - -
      ANY_ERR=$((ANY_ERR+1)); continue; }
    if [ "$live" != "$CID" ]; then
      printf '%-18s %-5s %11s %10s %12s %12s %12s %11s  CHAIN ID %s != %s\n' "$NAME" "$TSYM" - - - - - - "$live" "$CID"
      ANY_ERR=$((ANY_ERR+1)); continue
    fi
    raw=$(cast call "$TOK" 'balanceOf(address)(uint256)' "$DEPLOYER" --rpc-url "$RPC" 2>/dev/null | awk '{print $1}')
    gp=$(cast gas-price --rpc-url "$RPC" 2>/dev/null)
    case "$raw" in
      ''|*[!0-9]*)
        printf '%-18s %-5s %11s %10s %12s %12s %12s %11s  GAS-TOKEN READ FAILED\n' "$NAME" "$TSYM" - - - - - -
        ANY_ERR=$((ANY_ERR+1)); continue ;;
    esac
    read -r GWEI HAVE SHORT REC VERDICT <<EOF
$(python3 -c "
raw=$raw; dec=$TDEC; floor=float('$TEMPO_GAS_FLOOR'); gp=${gp:-0}
have=raw/(10**dec)
short=max(0.0, floor-have)
print(f'{gp/1e9:.6f}', f'{have:.6f}', f'{short:.6f}', f'{short:.6f}', 'OK' if short==0 else 'FUND')
")
EOF
    # Same guard as the native block below: four good readings still leave every name empty
    # if python3 is missing or the snippet raises, and VERDICT is the last field printed, so
    # anything other than OK/FUND means the block produced nothing. Without this the row
    # prints blank and a token-gas chain passes unmeasured -- which is the silent pass this
    # check exists to prevent, and it was live on Tempo while the native path was guarded.
    case "$VERDICT" in
      OK|FUND) ;;
      *) printf '%-18s %-5s %11s %10s %12s %12s %12s %11s  COMPUTE FAILED (token-gas)\n' \
           "$NAME" "$TSYM" - - - - - -
         ANY_ERR=$((ANY_ERR+1)); continue ;;
    esac
    [ "$VERDICT" = "FUND" ] && ANY_SHORT=1
    printf '%-18s %-5s %11s %10s %12s %12s %12s %11s  %s (token-gas)\n' \
      "$NAME" "$TSYM" - "$GWEI" "$TEMPO_GAS_FLOOR" "$HAVE" "$SHORT" "$REC" "$VERDICT"
    TOTALS="$TOTALS$TSYM $REC\n"
    continue
  fi

  META="$(chain_meta "$CID")"
  if [ -z "$META" ]; then
    printf '%-18s %-5s  UNKNOWN CHAIN ID -- add it to chain_meta(); refusing to guess its native\n' "$NAME" "?"
    printf '%-18s %-5s  token, because the wrong symbol yields the wrong funding floor.\n' "" ""
    ANY_ERR=$((ANY_ERR+1)); continue   # must affect the exit status: RC was never read, so this would pass
  fi
  SYM="${META%% *}"; L2="${META##* }"

  # Widths match the header printf above; these three rows carried their own, so a failure row
  # never lined up with the table it appears in.
  live=$(cast chain-id --rpc-url "$RPC" 2>/dev/null) || {
    printf '%-18s %-5s %11s %10s %12s %12s %12s %11s  RPC UNREACHABLE\n' "$NAME" "$SYM" - - - - - -
    ANY_ERR=$((ANY_ERR+1)); continue; }
  if [ "$live" != "$CID" ]; then
    printf '%-18s %-5s %11s %10s %12s %12s %12s %11s  CHAIN ID %s != %s\n' "$NAME" "$SYM" - - - - - - "$live" "$CID"
    ANY_ERR=$((ANY_ERR+1)); continue
  fi

  e=$(cast estimate --rpc-url "$RPC" --from "$DEPLOYER" --create "$ESC_BC" 'constructor(address,address)' "$PERMIT2_ADDRESS" "$DEPLOYER" 2>/dev/null | tail -1)
  l=0; [ -n "$LIB_BC" ] && l=$(cast estimate --rpc-url "$RPC" --from "$DEPLOYER" --create "$LIB_BC" 2>/dev/null | tail -1)
  f=0; [ "$DEPLOY_PROXY" = 1 ] && f=$(cast estimate --rpc-url "$RPC" --from "$DEPLOYER" --create "$FP_BC" 'constructor(address)' "$DEPLOYER" 2>/dev/null | tail -1)
  gp=$(cast gas-price --rpc-url "$RPC" 2>/dev/null)
  bal=$(cast balance "$DEPLOYER" --rpc-url "$RPC" 2>/dev/null)
  # Each reading is tested on its own. The old guard concatenated all four before matching, so
  # ""|*[!0-9]* only fired when EVERY read came back empty; the likely case -- one `cast` failing --
  # concatenated into a still-numeric string and slipped straight through. Downstream that reaches
  # python3 as `e=; f=21000; ...`, which raises a SyntaxError; with no `set -e`, `read` then leaves
  # all six names empty, VERDICT is neither OK nor FUND, a blank row prints and the chain passes.
  BAD=""
  for v in "$e" "$l" "$f" "$gp" "$bal"; do
    case "$v" in ''|*[!0-9]*) BAD=1 ;; esac
  done
  if [ -n "$BAD" ]; then
    printf '%-18s %-5s %11s %10s %12s %12s %12s %11s  ESTIMATE FAILED\n' "$NAME" "$SYM" - - - - - -
    ANY_ERR=$((ANY_ERR+1)); continue
  fi

  read -r GAS GWEI NEED HAVE SHORT VERDICT <<EOF
$(python3 -c "
e=$e; l=$l; f=$f; rg=$ROLE_GAS; gp=$gp; bal=$bal; m=$MARGIN; l2=$L2
gas=e+l+f+rg
need=gas*gp*m
short=max(0,need-bal)
def eth(w): return f'{w/1e18:.6f}'
v='OK' if short==0 else 'FUND'
if l2=='1' and short==0: v='OK*'
print(gas, f'{gp/1e9:.6f}', eth(need), eth(bal), eth(short), v)
")
EOF
  # And the compute block itself: four good readings still leave every name empty if python3 is
  # missing or the snippet raises. VERDICT is the last field printed, so anything other than the
  # three values it can hold means the block produced nothing -- not a measured OK.
  case "$VERDICT" in
    OK|'OK*'|FUND) ;;
    *) printf '%-18s %-5s %11s %10s %12s %12s %12s %11s  COMPUTE FAILED\n' "$NAME" "$SYM" - - - - - -
       ANY_ERR=$((ANY_ERR+1)); continue ;;
  esac

  REC=0.000000
  if [ "$VERDICT" = "FUND" ]; then
    REC=$(python3 -c "print(f'{max(float(\"$SHORT\"), float(\"$(floor_for "$CID" "$SYM")\")):.6f}')")
    ANY_SHORT=1
  fi
  printf '%-18s %-5s %11s %10s %12s %12s %12s %11s  %s\n' "$NAME" "$SYM" "$GAS" "$GWEI" "$NEED" "$HAVE" "$SHORT" "$REC" "$VERDICT"
  TOTALS="$TOTALS$SYM $REC\n"
done

if [ "$ANY_ERR" -gt 0 ]; then
  # Its own labelled lines, not left to the STATUS column, which sits at the far right of a very
  # wide row. It CANNOT be printed above the table -- the count is not known until the loop has
  # finished -- and run-all.sh's funding phase shows a WINDOW of this output, sized to the table,
  # so anything printed after the table is outside it by construction. So the visibility is
  # arranged from the other end: every line here carries the literal prefix `UNMEASURED:`, and
  # run-all.sh greps for exactly that and reprints it alongside the table. Keep the two in step --
  # renaming this prefix silently removes the warning from every run-all.sh run.
  echo
  echo "UNMEASURED: $ANY_ERR chain(s) could not be measured -- see the STATUS column above."
  echo "UNMEASURED: those rows carry no funding figure and are NOT a pass; this check exits 1."
fi

echo
echo "TOP UP THESE (recommended, floor applied):"
printf "$TOTALS" | awk 'NF{a[$1]+=$2} END{for(s in a) printf "  %-6s %.6f\n", s, a[s]}'
cat <<'NOTE'

Notes
  * Token-gas rows are marked "(token-gas)". Their NEEDED column is an EMPIRICAL FLOOR in whole gas
    tokens, not gas x price: on Tempo the gas figure is wei-scaled while pathUSD is 6dp, and the
    conversion is not observable over RPC. Do not read those rows as a priced estimate, and do not
    trust `cast balance` on such a chain -- Tempo returns a placeholder there, identical on both of
    its chains, which prices as wildly over-funded while the real pathUSD balance may be under 1.
    The default floor is MEASURED, not guessed: the real Moderato v4 deploy cost 0.023466 pathUSD
    across its 6 transactions (2026-09-02), and the floor is ~10x that. Override with
    TEMPO_GAS_FLOOR if a deploy ever measures differently.
  * L2 rows (Arbitrum / Base / Optimism Sepolia): gas_price x gas does NOT include the L1 data fee,
    so the real cost is higher than shown. The margin absorbs it; do not trim the margin on these.
  - A suspiciously low gas price (e.g. Fuji reporting a few hundred wei) makes NEEDED look trivial.
    Treat any sub-gwei figure as unreliable and fund to a sane floor anyway.
  - Faucets: sepoliafaucet.com / Alchemy (ETH Sepolia), bridge or superchain faucet (Base/OP Sepolia),
    faucet.triangleplatform.com/arbitrum/sepolia, faucet.celo.org (Celo Sepolia),
    faucet.polygon.technology (Amoy), core.app/tools/testnet-faucet (Fuji), faucet.circle.com (Arc Testnet).
NOTE
if [ "$ANY_SHORT" -eq 1 ] || [ "$ANY_ERR" -gt 0 ]; then exit 1; fi
exit 0
