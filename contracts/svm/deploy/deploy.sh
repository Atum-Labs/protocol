#!/usr/bin/env bash
# v4 SVM (Solana) deploy driver.
#
#   contracts/svm/deploy/deploy.sh --check              # read-only: env, keypairs, ids, balance, chain state
#   contracts/svm/deploy/deploy.sh                      # dry: preflight + anchor build + artifact checks
#   contracts/svm/deploy/deploy.sh --broadcast          # deploy the two programs, then initialize
#   contracts/svm/deploy/deploy.sh --print-source-dir   # print the resolved Anchor tree and exit
#   FORCE=1 ... --broadcast                             # override the duplicate-deploy guard
#
# Why this exists rather than calling scripts/deploy.ts directly. deploy.ts runs a BARE
# `anchor deploy`, and anchor's default is "deploys each program in the workspace" — which here
# includes `mock_transfer_hook`, a test-only program whose declare_id! does not match the keypair
# anchor auto-mints for it. On any non-localnet cluster that aborts the run, after having already
# spent SOL. This driver deploys the two real programs EXPLICITLY, one `-p` at a time, then hands
# initialization back to deploy.ts with SKIP_BUILD/SKIP_DEPLOY set.
#
# It also passes --program-keypair, so the deployed id comes from the keypair you custodied rather
# than from whatever happens to sit in target/deploy/. Anchor reads the id from that file, not from
# Anchor.toml, so a stale target/deploy keypair silently deploys to the wrong id.
#
# Solana has NO CREATE2 and PDAs are seeded WITHOUT the program id: redeploying at a new id yields a
# disjoint PDA namespace, so nothing carries over and every mint must be re-seeded. This refuses to
# re-run once it has recorded a deployment for a cluster.
set -uo pipefail

# Resolve through symlinks: BASH_SOURCE points at the LINK, but derive.py and ../source live beside
# the TARGET. Without this a PATH install silently loses them.
SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do
  _d="$(cd -P "$(dirname "$SELF")" && pwd)"
  SELF="$(readlink "$SELF")"
  case "$SELF" in /*) ;; *) SELF="$_d/$SELF" ;; esac
done
HERE="$(cd -P "$(dirname "$SELF")" && pwd)"
: "${ATUM_HOME:=$HOME/.atum}"

# ---------- locate the Anchor tree: cwd first, then beside this script, then upward ----------
is_src() { [ -f "$1/Anchor.toml" ] && [ -d "$1/programs/escrow" ]; }
case "${1:-}" in --print-source-dir) PRINT_SRC=1 ;; esac
find_src() {
  local c d
  # cwd FIRST: running from inside a tree must use THAT tree, not a sibling.
  for c in "$PWD" "$PWD/contracts/svm/source" "$HERE/../source"; do
    [ -n "$c" ] && is_src "$c" && { (cd "$c" && pwd); return 0; }
  done
  d="$PWD"
  while [ "$d" != / ]; do
    is_src "$d/contracts/svm/source" && { (cd "$d/contracts/svm/source" && pwd); return 0; }
    d="$(dirname "$d")"
  done
  return 1
}
if [ -n "${SRC_DIR:-}" ]; then
  # An explicit SRC_DIR that is not an Anchor project is an error, never a cue to search elsewhere —
  # silently building a different tree is how you deploy the wrong bytecode.
  is_src "$SRC_DIR" || { echo "SRC_DIR=$SRC_DIR is not an Anchor project (no Anchor.toml + programs/escrow)" >&2; exit 1; }
  SRC_DIR="$(cd "$SRC_DIR" && pwd)"
else
  SRC_DIR="$(find_src)" || {
    echo "Could not find the SVM source tree." >&2
    echo "  Looked in the cwd, beside this script, and upward for contracts/svm/source." >&2
    echo "  Set it explicitly:  SRC_DIR=/path/to/contracts/svm/source $0 ${*:-}" >&2
    exit 1; }
fi
[ "${PRINT_SRC:-0}" = "1" ] && { printf '%s\n' "$SRC_DIR"; exit 0; }

# Records live OUTSIDE the source tree, matching the EVM and TVM drivers ($HOME/atum-v4-*). A
# record written into contracts/svm/source would show up as an untracked file in the repo.
OUT="${OUT:-$HOME/atum-v4-svm-deploy}"; mkdir -p "$OUT" 2>/dev/null || true

# Looking only at $1, with no catch-all, meant `deploy.sh --brodcast` built, printed
# DRY RUN COMPLETE and exited 0 without ever saying the flag was not understood. The EVM
# and TVM drivers refuse unknown arguments for the same reason.
MODE=dry
case "${1:-}" in
  --check)      MODE=check ;;
  --broadcast)  MODE=broadcast ;;
  ''|--dry)     ;;
  # Never reached: --print-source-dir prints the resolved tree and exits at the PRINT_SRC
  # check ABOVE, which is what makes the catch-all below safe -- not the ordering against
  # tree resolution, which necessarily precedes it since the path has to be resolved to be
  # printed. Listed anyway so the catch-all cannot swallow the flag if that exit ever moves.
  --print-source-dir) ;;
  # '2,23p' is the header: :23 is its last line, :24 is `set -uo pipefail` and :26 an
  # internal comment, so a wider range prints shell and a comment fragment as "help".
  --help|-h)    sed -n '2,23p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "unknown argument: $1" >&2
     echo "usage: deploy.sh [--check | --dry | --broadcast | --print-source-dir]" >&2; exit 2 ;;
esac
# Only $1 is inspected, so `deploy.sh --check --broadcast` silently took --check.
[ $# -gt 1 ] && { echo "unexpected extra arguments: ${*:2}" >&2; exit 2; }

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'
FAIL=0
ok()   { printf '  %sok%s   %s\n'   "$GRN" "$OFF" "$1"; }
warn() { printf '  %s--%s   %s\n'   "$YEL" "$OFF" "$1"; }
bad()  { printf '  %sFAIL%s %s\n'   "$RED" "$OFF" "$1"; FAIL=$((FAIL+1)); }
hdr()  { printf '\n%s-- %s%s\n' "$BLD" "$1" "$OFF"; }
die()  { printf '\n%sREFUSING:%s %s\n' "$RED" "$OFF" "$1" >&2; exit 1; }

printf '%s== v4 SVM deploy driver — mode %s%s\n' "$BLD" "$MODE" "$OFF"
printf 'source    : %s\n' "$SRC_DIR"

# ---------- toolchain ----------
hdr "toolchain"
for t in anchor solana solana-keygen; do
  command -v "$t" >/dev/null 2>&1 && ok "$t" || bad "$t not installed"
done
[ "$FAIL" -gt 0 ] && die "install the missing tools first (see contracts/deploy/README.md)"
# A different anchor/solana produces different bytecode, so a mismatch against the pinned versions
# is a real risk, not pedantry.
PIN_A="$(grep -oE 'anchor_version *= *"[^"]+"' "$SRC_DIR/Anchor.toml" | sed 's/.*"\(.*\)"/\1/')"
GOT_A="$(anchor --version 2>/dev/null | awk '{print $2}')"
[ -n "$PIN_A" ] && { [ "$PIN_A" = "$GOT_A" ] && ok "anchor $GOT_A matches the pin" \
  || warn "anchor $GOT_A != pinned $PIN_A — this CHANGES the bytecode; align before a real deploy"; }

# ---------- required environment ----------
hdr "environment"
# The RPC URL carries an API key in its PATH (both GCP secrets are Alchemy
# endpoints), so printing it verbatim puts a live credential in the terminal, the
# scrollback, and any pasted output. Show scheme+host only.
redact_url() { printf '%s' "$1" | sed -E 's#^(https?://[^/?]+).*#\1/<redacted>#'; }

for v in SOLANA_RPC_URL ESCROW_CLUSTER_ID DEPLOYER_KEYPAIR; do
  eval "val=\${$v:-}"
  case "$v" in SOLANA_RPC_URL) shown="$(redact_url "$val")" ;; *) shown="$val" ;; esac
  [ -n "$val" ] && ok "$v=$shown" || bad "$v is not set — see \$ATUM_HOME/env/svm.env"
done
# cluster_id is written ONCE into ProtocolConfig and has no setter. Inferring it is how you end up
# redeploying at a new program id to fix a label.
[ -n "${ESCROW_CLUSTER_ID:-}" ] || bad "ESCROW_CLUSTER_ID must be EXPLICIT — never let deploy.ts infer it"

# ESCROW_CLUSTER_ID is written ONCE into ProtocolConfig and there is no setter, so a
# wrong value is permanent. Checking only that it is non-empty was a false green on
# the most irreversible field in the deploy: sourcing svm.env (which shipped
# ESCROW_CLUSTER_ID=devnet) after the per-network file leaves "devnet" set against a
# mainnet endpoint, and this reported ok. It also picks which [programs.*] table is
# validated below, so the whole id check was being run against the wrong cluster.
#
# Compare against the GENESIS HASH rather than the hostname. deploy.ts's own
# fallback string-matches the URL, which a private or aliased endpoint defeats; the
# genesis hash is the cluster's identity and cannot be aliased.
if [ -n "${ESCROW_CLUSTER_ID:-}" ] && [ -n "${SOLANA_RPC_URL:-}" ]; then
  GEN="$(solana genesis-hash --url "$SOLANA_RPC_URL" 2>/dev/null | head -1)"
  case "$GEN" in
    5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d) EP_CLUSTER=mainnet ;;
    EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG) EP_CLUSTER=devnet ;;
    4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY) EP_CLUSTER=testnet ;;
    "")   EP_CLUSTER="" ;;
    *)    EP_CLUSTER=unknown ;;
  esac
  case "$EP_CLUSTER" in
    "")      warn "could not read the genesis hash, so ESCROW_CLUSTER_ID='$ESCROW_CLUSTER_ID' could not be checked against the endpoint" ;;
    unknown) warn "endpoint reports an unrecognised genesis hash ($GEN); ESCROW_CLUSTER_ID='$ESCROW_CLUSTER_ID' not verifiable — a localnet or fork?" ;;
    *)
      # mainnet-beta is spelled "mainnet" in ESCROW_CLUSTER_ID.
      if [ "$EP_CLUSTER" = "$ESCROW_CLUSTER_ID" ]; then
        ok "ESCROW_CLUSTER_ID agrees with the endpoint's genesis hash ($EP_CLUSTER)"
      else
        bad "ESCROW_CLUSTER_ID='$ESCROW_CLUSTER_ID' but the endpoint IS $EP_CLUSTER (genesis $GEN). This value is written ONCE into ProtocolConfig with no setter, so deploying now would stamp '$ESCROW_CLUSTER_ID' permanently onto a $EP_CLUSTER deployment. Source \$ATUM_HOME/env/svm.$EP_CLUSTER.env AFTER svm.env, or set ESCROW_CLUSTER_ID=$EP_CLUSTER explicitly."
      fi ;;
  esac
fi
# Revocation is now OPT-IN: deploy.ts revokes only when REVOKE_UPGRADE_AUTHORITY lowercases to
# "true", so not revoking is the default and needs no variable at all.
#
# SKIP_REVOKE_AUTHORITY is obsolete and deploy.ts refuses on any presence of it, after the programs
# are already deployed. Refuse here, before anything is spent.
if [ -n "${SKIP_REVOKE_AUTHORITY+x}" ]; then
  bad 'SKIP_REVOKE_AUTHORITY is obsolete and deploy.ts refuses on it — remove it from your env. Not revoking is now the default; set REVOKE_UPGRADE_AUTHORITY=true only to freeze deliberately.'
fi
RUA_LC="$(printf '%s' "${REVOKE_UPGRADE_AUTHORITY:-}" | tr '[:upper:]' '[:lower:]')"
case "$RUA_LC" in
  true) ok "REVOKE_UPGRADE_AUTHORITY=true — both programs will be made PERMANENTLY IMMUTABLE after deploy. Read contracts/svm/deploy/pre-finalize.sh first." ;;
  "")   ok "upgrade authority RETAINED (REVOKE_UPGRADE_AUTHORITY unset — the default)" ;;
  *)    bad "REVOKE_UPGRADE_AUTHORITY='$REVOKE_UPGRADE_AUTHORITY' does not lowercase to 'true'. deploy.ts treats anything but 'true' as false, so this reads as RETAIN — set it to 'true' or remove it, rather than leaving a value that looks decisive and is not." ;;
esac
[ -n "${DEPLOYER_KEYPAIR:-}" ] && { [ -f "$DEPLOYER_KEYPAIR" ] && ok "deployer keypair present" || bad "DEPLOYER_KEYPAIR=$DEPLOYER_KEYPAIR does not exist"; }

# ---------- program ids: keypair == declare_id! == Anchor.toml ----------
hdr "program ids"
PROGRAMS="escrow fulfillment_proxy"
declare_id_of() { grep -ohE 'declare_id!\("[^"]+"\)' "$SRC_DIR/programs/$1/src/lib.rs" 2>/dev/null | sed 's/declare_id!("//;s/")//' | head -1; }
toml_id_of()    { sed -n "/^\[programs\.$2\]/,/^\[/p" "$SRC_DIR/Anchor.toml" | grep -E "^$1 *= *\"" | sed 's/.*"\(.*\)"/\1/' | head -1; }
KP_DIR="${SVM_KEY_DIR:-$ATUM_HOME/keys}"
for p in $PROGRAMS; do
  DID="$(declare_id_of "$p")"
  KP="$KP_DIR/$p-keypair.json"
  if [ -f "$KP" ]; then
    KID="$(solana-keygen pubkey "$KP" 2>/dev/null)"
    # Anchor reads the id from the KEYPAIR, not Anchor.toml. A mismatch here is
    # DeclaredProgramIdMismatch (4100) at the first instruction — after you have paid to deploy.
    [ "$KID" = "$DID" ] && ok "$p: keypair == declare_id! ($DID)" \
      || bad "$p: keypair is $KID but declare_id! is $DID — anchor deploys the KEYPAIR's id, so every instruction would fail DeclaredProgramIdMismatch (4100). Fix by either pointing declare_id! (and Anchor.toml, PROGRAM_ID_BYTES, the hash anchors) at $KID per the guide's propagation step, or by using the keypair whose pubkey is $DID."
  else
    bad "$p: no keypair at $KP (generate + custody it, see the guide Step 2c; override the dir with SVM_KEY_DIR)"
  fi
  TID="$(toml_id_of "$p" "${ESCROW_CLUSTER_ID:-devnet}")"
  if [ -n "$TID" ]; then
    [ "$TID" = "$DID" ] && ok "$p: Anchor.toml [${ESCROW_CLUSTER_ID:-devnet}] agrees" \
      || bad "$p: Anchor.toml [${ESCROW_CLUSTER_ID:-devnet}] says $TID, declare_id! says $DID"
  else
    warn "$p: no entry under [programs.${ESCROW_CLUSTER_ID:-devnet}] in Anchor.toml"
  fi
done
# The mock is test-only and its declare_id! does not match anchor's auto-minted keypair. We never
# invoke a bare `anchor deploy`, so it is never deployed — state that rather than leave it implicit.
[ -d "$SRC_DIR/programs/mock_transfer_hook" ] && ok "mock_transfer_hook present but NOT deployed (explicit -p per program)"

# ---------- PROGRAM_ID_BYTES must decode to declare_id! ----------
hdr "signature preimage anchors"
if [ -f "$HERE/derive.py" ]; then
  if python3 "$HERE/derive.py" --sync-id-bytes "$SRC_DIR" --check >/dev/null 2>&1; then
    ok "PROGRAM_ID_BYTES decodes to declare_id!"
  else
    # A deploy SUCCEEDS with this stale; signatures then disagree with every off-chain signer.
    bad "PROGRAM_ID_BYTES is stale — run: derive.py --sync-id-bytes $SRC_DIR. A deploy will SUCCEED and then every signature will mismatch."
  fi
else
  warn "derive.py not beside this script — cannot check PROGRAM_ID_BYTES"
fi

# ---------- payer balance ----------
hdr "payer"
# Per cluster, matching readiness.sh, which had this hardcoded at 7.0 while this file
# already honoured NEED_SOL -- so the gate and the driver could disagree about whether
# the same balance was sufficient. 6.0 on mainnet sits above the 5.73 measured for both
# programs plus IDLs; it is deliberately NOT 12.0 (a full retry's stranded buffer)
# because --buffer makes a failed upload resumable at no extra rent. See the guide.
case "${ESCROW_CLUSTER_ID:-}" in
  mainnet|mainnet-beta) NEED="${NEED_SOL:-6.0}" ;;
  *)                    NEED="${NEED_SOL:-7.0}" ;;
esac
if [ -n "${DEPLOYER_KEYPAIR:-}" ] && [ -f "${DEPLOYER_KEYPAIR:-/nonexistent}" ]; then
  PAYER="$(solana-keygen pubkey "$DEPLOYER_KEYPAIR" 2>/dev/null)"
  BAL="$(solana balance "$PAYER" --url "${SOLANA_RPC_URL:-}" 2>/dev/null | awk '{print $1}')"
  if [ -n "$BAL" ]; then
    printf '  payer     : %s\n  balance   : %s SOL   need ~%s SOL\n' "$PAYER" "$BAL" "$NEED"
    python3 -c "import sys; sys.exit(0 if float('$BAL') >= float('$NEED') else 1)" 2>/dev/null \
      && ok "funded" || bad "UNDERFUNDED — top up to ~$NEED SOL (rent for both programs plus their ProgramData)"
  else
    bad "could not read the payer balance from $(redact_url "${SOLANA_RPC_URL:-<unset>}")"
  fi
fi

# ---------- on-chain state at the target ids ----------
hdr "target program ids on chain"
# Reachability FIRST. Without this, a dead endpoint makes every `program show` fail and — if you
# treat failure as absence — every occupied id reads as "free to deploy into". That is the most
# dangerous possible false negative here, so absence must be detected POSITIVELY.
RPC_OK=0
if [ -n "${SOLANA_RPC_URL:-}" ] && solana block-height --url "${SOLANA_RPC_URL:-}" >/dev/null 2>&1; then
  RPC_OK=1; ok "rpc reachable ($(redact_url "$SOLANA_RPC_URL"))"
else
  bad "rpc NOT reachable at '$(redact_url "${SOLANA_RPC_URL:-<unset>}")' — cannot tell whether the target ids are free. Refusing to guess."
fi
for p in $PROGRAMS; do
  DID="$(declare_id_of "$p")"
  [ -n "$DID" ] || continue
  [ "$RPC_OK" = "1" ] || { warn "$p ($DID): not checked — no reachable rpc"; continue; }
  INFO="$(solana program show "$DID" --url "${SOLANA_RPC_URL:-}" 2>&1)"
  if printf '%s' "$INFO" | grep -q 'Program Id:'; then
    :   # deployed — fall through to the authority checks below
  elif printf '%s' "$INFO" | grep -qi 'unable to find the account'; then
    # The one string that actually means "nothing is there".
    ok "$p ($DID): unoccupied — a fresh deploy will create it"
    continue
  else
    bad "$p ($DID): could not determine on-chain state. solana said: $(printf '%s' "$INFO" | head -1)"
    continue
  fi
  AUTH="$(printf '%s' "$INFO" | awk -F': *' '/^Authority/{print $2; exit}')"
  if [ -n "${PAYER:-}" ] && [ "$AUTH" = "$PAYER" ]; then
    ok "$p ($DID): already deployed, upgrade authority is the payer — this would be an UPGRADE"
  elif [ -z "$AUTH" ] || [ "$AUTH" = "none" ]; then
    bad "$p ($DID): deployed with NO upgrade authority — immutable, it can never be upgraded. Use a new program id."
  else
    bad "$p ($DID): deployed, but the upgrade authority is $AUTH, not the payer ${PAYER:-<unknown>} — you cannot upgrade it"
  fi
done

# ---------- duplicate-deploy guard ----------
REC="$OUT/${ESCROW_CLUSTER_ID:-unknown}.deployed"
if [ -f "$REC" ] && [ "${FORCE:-0}" != "1" ] && [ "$MODE" = broadcast ]; then
  echo
  echo "REFUSING: $REC already records a deployment for ${ESCROW_CLUSTER_ID}:"
  sed 's/^/    /' "$REC"
  echo "  Solana has no CREATE2 and PDAs are seeded WITHOUT the program id, so a redeploy at a new"
  echo "  id gives a DISJOINT PDA namespace — the recorded programs stay live and keep serving their"
  echo "  deposits while nothing carries over to the new ones. Pass FORCE=1 only if that is intended."
  exit 1
fi

# ---------- verdict for --check ----------
if [ "$MODE" = check ]; then
  echo
  if [ "$FAIL" -gt 0 ]; then printf '%s%s check(s) FAILED — not safe to deploy.%s\n' "$RED" "$FAIL" "$OFF"; exit 1; fi
  printf '%sPREFLIGHT CLEAN.%s Next: run without --check for a dry build, then --broadcast.\n' "$GRN" "$OFF"; exit 0
fi
[ "$FAIL" -gt 0 ] && die "$FAIL preflight check(s) failed — fix them before building or deploying"

# ---------- build ----------
hdr "anchor build"
( cd "$SRC_DIR" && anchor build ) || die "anchor build failed"
for p in $PROGRAMS; do
  SO="$SRC_DIR/target/deploy/$p.so"
  [ -f "$SO" ] && ok "$p.so built ($(wc -c <"$SO" | tr -d ' ') bytes)" || die "$p.so missing after build"
done
# The IDL must exist or deploy.ts's initialize step cannot run.
for p in $PROGRAMS; do
  [ -f "$SRC_DIR/target/idl/$p.json" ] && ok "$p IDL present" || die "$p IDL missing after build"
done

if [ "$MODE" = dry ]; then
  echo
  printf '%sDRY RUN COMPLETE — nothing was broadcast and no SOL was spent.%s\n' "$GRN" "$OFF"
  echo "Re-run with --broadcast to deploy."
  exit 0
fi

# ---------- broadcast ----------
hdr "deploy (explicit, one program at a time)"
printf '  cluster %s   rpc %s\n  payer   %s\n' "${ESCROW_CLUSTER_ID:-}" "$(redact_url "${SOLANA_RPC_URL:-}")" "${PAYER:-?}"
printf '\n  This SPENDS SOL and is not reversible. Type the cluster id to continue: '
read -r CONFIRM
[ "$CONFIRM" = "${ESCROW_CLUSTER_ID:-}" ] || die "confirmation did not match — nothing was deployed"

for p in $PROGRAMS; do
  KP="$KP_DIR/$p-keypair.json"
  echo
  echo "==> anchor deploy -p $p"
  # -p and --program-keypair together: deploy ONLY this program, from the keypair we custodied,
  # never from whatever sits in target/deploy.
  ( cd "$SRC_DIR" && anchor deploy -p "$p" \
      --program-keypair "$KP" \
      --provider.cluster "${SOLANA_RPC_URL:-}" \
      --provider.wallet "${DEPLOYER_KEYPAIR:-}" ) || die "deploy of $p failed — earlier programs may already be live; check with --check before retrying"
  ok "$p deployed"
done

# ---------- initialize ----------
hdr "initialize (deploy.ts, build and deploy phases skipped)"
( cd "$SRC_DIR" && SKIP_BUILD=true SKIP_DEPLOY=true npx ts-node scripts/deploy.ts ) \
  || die "initialization failed — the programs ARE deployed. Re-run initialization with: (cd $SRC_DIR && SKIP_BUILD=true SKIP_DEPLOY=true npx ts-node scripts/deploy.ts)"

# ---------- record ----------
# Redacted in the run record too: this file persists, and a deploy log with a live
# API key in it is worse than one in a terminal.
{ printf 'cluster=%s\nrpc=%s\npayer=%s\n' "$ESCROW_CLUSTER_ID" "$(redact_url "$SOLANA_RPC_URL")" "${PAYER:-}"
  for p in $PROGRAMS; do printf '%s=%s\n' "$p" "$(declare_id_of "$p")"; done
} > "$REC"

echo
printf '%sDEPLOYED AND INITIALIZED.%s\n' "$GRN" "$OFF"
echo "recorded  : $REC"
echo
echo "Still to do, and none of it is optional — see the guide:"
echo "  * create the per-cluster address lookup table (a deposit tx overruns without one)"
echo "  * allowlist each mint with its fee config"
echo "  * propagate the program ids to the hash anchors and consumers"
echo "  * verify:  atum-verify-all svm --deployed"
