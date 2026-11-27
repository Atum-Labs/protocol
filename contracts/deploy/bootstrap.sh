#!/usr/bin/env bash
# Bootstrap the Atum contract-deployment tooling for a fresh clone.
#
#   contracts/deploy/bootstrap.sh              # all three VMs
#   contracts/deploy/bootstrap.sh evm tvm      # a subset
#   contracts/deploy/bootstrap.sh --check      # report only, change nothing
#
# What it does, idempotently:
#   1. checks the toolchain each VM needs, and says what is missing rather than half-working
#   2. creates $ATUM_HOME (default ~/.atum): keys/ at 0700, env/ for per-cluster settings
#   3. exposes the operator commands on PATH via symlinks in $ATUM_BIN (default ~/.local/bin)
#   4. writes an env TEMPLATE per VM from the repo's committed defaults — never a live secret
#   5. runs the read-only self-tests so a green bootstrap means the tools actually work
#
# It writes no key material and contacts no network except the read-only self-tests.
# Re-running is safe: symlinks are refreshed, existing env files are left alone.
set -uo pipefail
SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do
  _d="$(cd -P "$(dirname "$SELF")" && pwd)"
  SELF="$(readlink "$SELF")"
  case "$SELF" in /*) ;; *) SELF="$_d/$SELF" ;; esac
done
HERE="$(cd -P "$(dirname "$SELF")" && pwd)"      # contracts/deploy
ROOT="$(cd -P "$HERE/.." && pwd)"                # contracts

: "${ATUM_HOME:=$HOME/.atum}"
: "${ATUM_BIN:=$HOME/.local/bin}"

CHECK=0; VMS=()
for a in "$@"; do
  case "$a" in
    --check) CHECK=1 ;;
    evm|tvm|svm) VMS+=("$a") ;;
    -h|--help) sed -n '2,17p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $a (expected evm|tvm|svm|--check)" >&2; exit 2 ;;
  esac
done
[ ${#VMS[@]} -eq 0 ] && VMS=(evm tvm svm)

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; CYA=$'\033[36m'; OFF=$'\033[0m'
MISSING=0; NOTES=()
ok()   { printf '  %sok%s   %s\n'   "$GRN" "$OFF" "$1"; }
warn() { printf '  %s--%s   %s\n'   "$YEL" "$OFF" "$1"; NOTES+=("$1"); }
bad()  { printf '  %sMISS%s %s\n'   "$RED" "$OFF" "$1"; MISSING=$((MISSING+1)); }
hdr()  { printf '\n%s== %s%s\n' "$CYA" "$1" "$OFF"; }

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- toolchain
hdr "toolchain"
need_common=(git python3)
for t in "${need_common[@]}"; do have "$t" && ok "$t" || bad "$t — required by every VM"; done

for vm in "${VMS[@]}"; do
  case "$vm" in
    evm) for t in forge cast; do have "$t" && ok "$t (evm)" || bad "$t — install foundry (getfoundry.sh)"; done ;;
    tvm) have cast && ok "cast (tvm: key derivation)" || bad "cast — install foundry"
         have node && ok "node (tvm: tronbox)"        || bad "node — tronbox needs it"
         have pnpm && ok "pnpm (tvm)"                 || warn "pnpm absent — needed only to build contracts/tvm/source" ;;
    svm) have solana        && ok "solana (svm)"        || bad "solana — install the Agave/Solana CLI"
         have solana-keygen && ok "solana-keygen (svm)" || bad "solana-keygen"
         have anchor        && ok "anchor (svm)"        || warn "anchor absent — needed only to build/deploy, not to check readiness" ;;
  esac
done

# ---------------------------------------------------------------- home layout
hdr "home layout ($ATUM_HOME)"
if [ "$CHECK" -eq 1 ]; then
  [ -d "$ATUM_HOME" ] && ok "$ATUM_HOME exists" || warn "$ATUM_HOME would be created"
else
  mkdir -p "$ATUM_HOME/keys" "$ATUM_HOME/env" || { echo "could not create $ATUM_HOME" >&2; exit 1; }
  chmod 700 "$ATUM_HOME" "$ATUM_HOME/keys"
  ok "$ATUM_HOME/keys  (0700 — key material lives here, never in the repo)"
  ok "$ATUM_HOME/env   (per-cluster settings)"
fi

# ---------------------------------------------------------------- PATH commands
hdr "commands on PATH ($ATUM_BIN)"
link() {  # link <target> <name>
  local tgt="$1" name="$2"
  [ -f "$tgt" ] || { warn "$name — source missing at $tgt"; return; }
  if [ "$CHECK" -eq 1 ]; then
    [ "$(readlink "$ATUM_BIN/$name" 2>/dev/null)" = "$tgt" ] && ok "$name" || warn "$name would be linked"
    return
  fi
  mkdir -p "$ATUM_BIN"
  ln -sf "$tgt" "$ATUM_BIN/$name" && chmod 755 "$tgt" && ok "$name -> ${tgt#$ROOT/}"
}
for vm in "${VMS[@]}"; do
  case "$vm" in
    evm) link "$ROOT/evm/deploy/run-all.sh"        atum-evm-run-all
         link "$ROOT/evm/deploy/deploy.sh"          atum-evm-deploy
         link "$ROOT/evm/deploy/funding-check.sh"   atum-evm-funding-check
         link "$ROOT/evm/deploy/import-deployer.sh" atum-evm-import-deployer
         link "$ROOT/evm/deploy/derive-guard.sh"    atum-evm-derive-guard ;;
    tvm) link "$ROOT/tvm/deploy/deploy.sh"           atum-tvm-deploy
         link "$ROOT/tvm/deploy/import-deployer.sh"  atum-tvm-import-deployer
         link "$ROOT/tvm/deploy/admin-preflight.js"  atum-tvm-admin-preflight
         link "$ROOT/tvm/deploy/sync-config-addresses.js" atum-tvm-sync-config ;;
    svm) link "$ROOT/svm/deploy/readiness.sh"       atum-svm-readiness
         link "$ROOT/svm/deploy/deploy.sh"          atum-svm-deploy
         link "$ROOT/svm/deploy/import-deployer.sh" atum-svm-import-deployer ;;
  esac
done
link "$HERE/assert-typehashes.sh" atum-assert-typehashes
link "$HERE/verify-all.sh"        atum-verify-all
link "$HERE/bootstrap.sh"         atum-bootstrap

# Symlinks point INTO the repo. If the repo lives on a volatile path, every installed command
# dangles after a reboot — and a dangling symlink fails as "command not found", which reads like a
# bad install rather than a wiped directory.
case "$ROOT" in
  /tmp/*|/private/tmp/*|/var/tmp/*)
    warn "the repo is under a temporary path ($ROOT) — these symlinks will DANGLE after a reboot; re-run bootstrap from a durable clone" ;;
esac

case ":$PATH:" in
  *":$ATUM_BIN:"*) ok "$ATUM_BIN is on PATH" ;;
  *) warn "$ATUM_BIN is NOT on PATH — add: export PATH=\"$ATUM_BIN:\$PATH\"" ;;
esac

# ---------------------------------------------------------------- env templates
hdr "env templates ($ATUM_HOME/env)"
tmpl() {  # tmpl <name> <heredoc-on-stdin>
  local f="$ATUM_HOME/env/$1"
  if [ "$CHECK" -eq 1 ]; then
    [ -f "$f" ] && ok "$1 exists" || warn "$1 would be written"
    cat >/dev/null; return
  fi
  if [ -f "$f" ]; then
    cat >/dev/null
    ok "$1 exists — left alone (delete it to regenerate)"
  else
    cat > "$f"; chmod 600 "$f"
    ok "$1 written (0600) — review it, it ships with placeholders"
  fi
}

for vm in "${VMS[@]}"; do
  case "$vm" in
    evm) tmpl evm.env <<'EOF'
# EVM deployment settings. Values here are NOT secrets; the key lives in the foundry keystore.
export ACCOUNT=atum-deployer-testnet    # foundry keystore name, per network (see atum-evm-import-deployer)
export DEPLOYER=                        # 0x… the deployer/admin address; must match the keystore
export SALT=                            # CREATE2 salt; must match your service config generator
export PERMIT2_ADDRESS=0x000000000022D473030F116dDEE9F6B43aC78BA3
export FACTORY=0x4e59b44847b379578588920ca78fbf26c0b4956c
export FEE_PERCENTAGE=20000             # 0.02% = 2 bps, scaled 1e6
export MIN_FEE=0
export MAX_FEE=250000000                # $250 cap for a 6-decimal token. 0 means UNCAPPED.
export EXPECT_DECIMALS=6
# Roles default to $DEPLOYER. Override all four for mainnet.
export ESCROW_PAUSER_ADDRESS=
export ESCROW_TREASURER_ADDRESS=
export ESCROW_TOKEN_CONFIG_ADDRESS=
export FP_PAUSER_ADDRESS=
# Public testnet RPCs. Use private endpoints for mainnet.
export ETH_SEPOLIA_RPC=https://ethereum-sepolia-rpc.publicnode.com
export ARB_SEPOLIA_RPC=https://sepolia-rollup.arbitrum.io/rpc
export BASE_SEPOLIA_RPC=https://sepolia.base.org
export CELO_SEPOLIA_RPC=https://forno.celo-sepolia.celo-testnet.org
export AMOY_RPC=https://polygon-amoy-bor-rpc.publicnode.com
export OP_SEPOLIA_RPC=https://sepolia.optimism.io
export FUJI_RPC=https://api.avax-test.network/ext/bc/C/rpc
EOF
    ;;
    tvm) tmpl tvm.env <<'EOF'
# TVM (Tron) deployment settings.
export NETWORK=shasta                   # shasta | nile | mainnet
export EXPECT=                          # T… the deployer you expect; read by BOTH atum-tvm-import-deployer
#                                         and atum-tvm-deploy (which also accepts EXPECT_DEPLOYER)
# tronbox reads PRIVATE_KEY_<NETWORK> as BARE 64-hex, no 0x prefix.
# Produce it with:  atum-tvm-import-deployer --write
#   then:           export PRIVATE_KEY_SHASTA="$(cat "$ATUM_HOME/keys/tron-shasta")"
#                   export ADMIN_PK="$PRIVATE_KEY_SHASTA"   # deployer IS the admin on Tron
export FEE_PERCENTAGE=20000
export MIN_FEE=0
export MAX_FEE=250000000
EOF
    ;;
    svm) tmpl svm.env <<'EOF'
# SVM (Solana) deployment settings. Fill in per cluster.
# SOLANA_RPC_URL and ESCROW_CLUSTER_ID are deliberately NOT here. They belong in a
# per-network file (svm.<network>.env; see the SVM guide's "RPC endpoints"), because a
# value in this cluster-agnostic file is a default that the OTHER cluster inherits in
# silence -- and ESCROW_CLUSTER_ID is write-once on chain, so inheriting it is permanent.
# This template used to ship "https://api.devnet.solana.com" and "devnet", which a
# mainnet run picked up unless the operator noticed and edited them.
export DEPLOYER_KEYPAIR="$ATUM_HOME/keys/svm-deployer.json"
export ESCROW_ID=                       # the escrow program id for this cluster
export FP_ID=                           # the fulfillment_proxy program id
export ADMIN=                           # the deployer pubkey; the four roles default to it
export DEFAULT_ADMIN="$ADMIN"
export TOKEN_CONFIG_AUTHORITY="$ADMIN"
export TREASURER="$ADMIN"
export PAUSER="$ADMIN"
export DEFAULT_ADMIN_DELAY_SECONDS=0    # make this a decision, not a default; see the guide
# Revocation is OPT-IN: leave REVOKE_UPGRADE_AUTHORITY unset to keep both programs upgradeable
# (the default). Set it to true ONLY to freeze them permanently, and read pre-finalize.sh first.
# Do NOT add SKIP_REVOKE_AUTHORITY -- it is obsolete and deploy.ts refuses on any presence of it.
export REVOKE_UPGRADE_AUTHORITY=
export MINT=                            # the SPL mint to allowlist for this cluster
EOF
    ;;
  esac
done

# ---------------------------------------------------------------- self-tests
hdr "self-tests (read-only)"
for vm in "${VMS[@]}"; do
  case "$vm" in
    tvm) if [ -x "$ROOT/tvm/deploy/import-deployer.sh" ] && have cast; then
           "$ROOT/tvm/deploy/import-deployer.sh" --self-test >/dev/null 2>&1 \
             && ok "tvm key derivation matches the published vectors" \
             || bad "tvm key-derivation self-test FAILED — do not trust it to find a key"
         else warn "tvm self-test skipped (needs cast)"; fi ;;
    svm) if [ -f "$ROOT/svm/deploy/derive.py" ] && have python3; then
           python3 "$ROOT/svm/deploy/derive.py" --self-test >/dev/null 2>&1 \
             && ok "svm key derivation matches the published vectors + solana-keygen" \
             || bad "svm key-derivation self-test FAILED — do not trust it to find a key"
         else warn "svm self-test skipped (needs python3)"; fi ;;
    evm) if [ -x "$ROOT/evm/deploy/derive-guard.sh" ]; then
           ok "evm compiler-settings guard present (run it from contracts/evm/source)"
         else warn "evm derive-guard.sh missing"; fi ;;
  esac
done

# ---------------------------------------------------------------- summary
printf '\n%s== next%s\n' "$CYA" "$OFF"
if [ "$MISSING" -gt 0 ]; then
  printf '  %s%s missing prerequisite(s)%s — install them, then re-run this script.\n' "$RED" "$MISSING" "$OFF"
fi
cat <<EOF
  1. source the env for the VM you are deploying:
       source $ATUM_HOME/env/<vm>.env
     Each ships with placeholders; fill them in from the guide for your target cluster.
  2. read the guide:
       contracts/<vm>/deploy/README.md
  3. every command is read-only until you pass --broadcast (EVM/TVM) or run deploy.ts (SVM).
EOF
[ ${#NOTES[@]} -gt 0 ] && { printf '\n  notes:\n'; for n in "${NOTES[@]}"; do printf '   - %s\n' "$n"; done; }
exit $([ "$MISSING" -gt 0 ] && echo 1 || echo 0)
