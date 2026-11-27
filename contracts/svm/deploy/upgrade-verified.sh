#!/usr/bin/env bash
#
# Upgrade an SVM program IN PLACE with a container-built artifact, then register the verified
# build so explorers show it as verified.
#
# WHY THIS EXISTS
# ---------------
# The deployed v4 programs were built natively on macOS. A verified build is by definition
# reproduced inside the standardised Linux container, and the two do not produce the same bytes
# even at identical toolchain versions -- so the deployed artifacts cannot be registered as they
# stand. The only route is to replace them with container-built bytes. See
# UPGRADE-VERIFIED-BUILDS.md for the measurements.
#
# THIS IS A REAL CODE CHANGE, NOT A COSMETIC REBUILD. Same source, same anchor and solana
# versions, but .text differs by ~496 bytes because the macOS and Linux platform-tools ship
# stdlibs compiled on different hosts. Treat the result like any other deploy.
#
# WHAT IT DOES NOT CHANGE: the program id, every PDA derived from it, and all program state.
#
# THE ONE INVARIANT THIS SCRIPT EXISTS TO HOLD
# --------------------------------------------
# The bytes deployed and the commit registered MUST be the same source.
#
# The first version of this script did not hold it. It built from the local working tree while
# registering a fixed commit hash, and the two silently disagreed -- the worktree carried commits
# the registered hash did not, so osec rebuilt different source and the hashes could never match.
# Nothing caught it, because nothing connected the two halves. Measured afterwards: the worktree
# build gave b2bb4d60..., the registered commit gave 7e4a48a9..., and the container itself was
# perfectly reproducible the whole time.
#
# So: this clones the ref it registers, builds THAT, deploys THAT, and registers the commit it
# just cloned. The working tree is never read and never modified.
#
# VERIFICATION REFS
# -----------------
# osec builds the commit verbatim, and declare_id! compiles into the binary. The working branches
# deliberately carry the v1/v3 pair, because a committed cluster-specific id breaks every other
# cluster for anyone who pulls -- which also means no working branch can ever reproduce deployed
# bytes. Each cluster therefore has a dedicated ref whose declare_id! matches its deployed
# programs. They exist only to be verified against, and must never be merged.
#
# USAGE
#   ./upgrade-verified.sh                                   # dry run, every program, both clusters
#   ./upgrade-verified.sh --cluster devnet                  # dry run, devnet only
#   ./upgrade-verified.sh --cluster devnet --apply          # upgrade + register devnet
#
# ENV
#   SVM_AUTHORITY_KEYPAIR   upgrade authority keypair (required for --apply). It SIGNS and it
#                           PAYS: `solana program deploy` takes the fee payer from the CLI
#                           config's default keypair otherwise, which is some unrelated local
#                           key, and fails with "insufficient funds" naming an account nobody
#                           recognises while the funded authority sits unused.
#   REPO_URL                default https://github.com/Atum-Labs/protocol
#   VERIFY_REF_DEVNET / VERIFY_REF_MAINNET   override a cluster's verification ref
#
set -uo pipefail

SELF="${BASH_SOURCE[0]}"
HERE="$(cd -P "$(dirname "$SELF")" && pwd)"
DEPLOYMENTS="$HERE/../deployments-v4.json"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'
FAIL=0
ok()   { printf '  %s✓%s %s\n' "$GRN" "$OFF" "$*"; }
bad()  { printf '  %s✗%s %s\n' "$RED" "$OFF" "$*"; FAIL=$((FAIL+1)); }
warn() { printf '  %s!%s %s\n' "$YEL" "$OFF" "$*"; }
hdr()  { printf '\n%s== %s%s\n' "$BLD" "$*" "$OFF"; }

MODE=dry; ONLY_CLUSTER=""; ONLY_PROGRAM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply)   MODE=apply ;;
    --cluster) ONLY_CLUSTER="${2:-}"; shift ;;
    --program) ONLY_PROGRAM="${2:-}"; shift ;;
    -h|--help) sed -n '2,55p' "$SELF"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

REPO_URL="${REPO_URL:-https://github.com/Atum-Labs/protocol}"

# Solana has TWO deployments; the four service environments map onto them two-to-one
# (staging-testnet and prod-testnet both use devnet, staging-mainnet and prod-mainnet both use
# mainnet). Upgrading devnet moves staging AND prod testnet at the same instant -- there is no
# independent staging soak on SVM.
cluster_url() { case "$1" in devnet) echo "https://api.devnet.solana.com" ;; mainnet) echo "https://api.mainnet-beta.solana.com" ;; *) echo "" ;; esac; }
cluster_key() { case "$1" in devnet) echo "EtWTRABZaYq6iMfeYKouRu166VU2xqa1" ;; mainnet) echo "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" ;; *) echo "" ;; esac; }
cluster_ref() {
  case "$1" in
    devnet)  echo "${VERIFY_REF_DEVNET:-svm-verify/devnet}" ;;
    mainnet) echo "${VERIFY_REF_MAINNET:-svm-verify/mainnet}" ;;
    *) echo "" ;;
  esac
}

json_get() {
  python3 - "$DEPLOYMENTS" "$1" "$2" <<'PY'
import json,io,sys
d=json.load(io.open(sys.argv[1],encoding='utf-8'))
cur=d.get(sys.argv[2]) or {}
for p in sys.argv[3].split('.'):
    cur=(cur or {}).get(p) if isinstance(cur,dict) else None
print(cur or '')
PY
}
lib_of() { case "$1" in escrow) echo Escrow ;; fulfillment_proxy) echo FulfillmentProxy ;; esac; }

WORKROOT="$(mktemp -d)"
cleanup() { rm -rf "$WORKROOT"; }
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------- preflight
hdr "preflight"
for t in solana solana-verify docker git python3; do
  command -v "$t" >/dev/null 2>&1 && ok "$t present" || bad "$t is not installed"
done
docker info >/dev/null 2>&1 && ok "docker daemon running" || bad "docker is not running"
if [ "$MODE" = apply ]; then
  { [ -n "${SVM_AUTHORITY_KEYPAIR:-}" ] && [ -f "$SVM_AUTHORITY_KEYPAIR" ]; } \
    && ok "authority keypair present" \
    || bad "SVM_AUTHORITY_KEYPAIR is unset or missing -- required for --apply (it signs AND pays)"
fi
[ "$FAIL" -gt 0 ] && { printf '\n%s%d preflight failure(s); refusing to continue.%s\n' "$RED" "$FAIL" "$OFF"; exit 1; }

# Arrays, so --cluster / --program values reach the loops as one word each: an unknown value is
# reported as "unknown cluster" below instead of being split on spaces or glob-expanded.
CLUSTERS=(devnet mainnet); [ -n "$ONLY_CLUSTER" ] && CLUSTERS=("$ONLY_CLUSTER")
PROGRAMS=(escrow fulfillment_proxy); [ -n "$ONLY_PROGRAM" ] && PROGRAMS=("$ONLY_PROGRAM")

for cluster in "${CLUSTERS[@]}"; do
  URL="$(cluster_url "$cluster")"; CKEY="$(cluster_key "$cluster")"; REF="$(cluster_ref "$cluster")"
  [ -z "$URL" ] && { bad "unknown cluster: $cluster"; continue; }

  hdr "$cluster — clone the verification ref"
  echo "  ref: $REF"
  SRC="$WORKROOT/$cluster"
  if ! git clone --quiet --depth 1 --branch "$REF" "$REPO_URL" "$SRC" 2>/dev/null; then
    bad "cannot clone $REF -- create it first: a ref whose declare_id! matches this cluster's deployed programs"
    continue
  fi
  COMMIT="$(git -C "$SRC" rev-parse HEAD)"
  ok "cloned at $(echo "$COMMIT" | cut -c1-9)"

  for prog in "${PROGRAMS[@]}"; do
    PID="$(json_get "$CKEY" "contracts.$(lib_of "$prog")")"
    hdr "$cluster / $prog"
    [ -z "$PID" ] && { bad "no program id in deployments-v4.json"; continue; }
    echo "  program id : $PID"

    # The ref must declare the id being deployed to. declare_id! compiles into the binary, so a
    # ref carrying the wrong one produces bytes that can never match -- and that only surfaces at
    # registration, after the program has already been changed.
    DID="$(grep -ohE 'declare_id!\("[^"]+"\)' "$SRC/contracts/svm/source/programs/$prog/src/lib.rs" 2>/dev/null | sed 's/declare_id!("//;s/")//' | head -1)"
    if [ "$DID" = "$PID" ]; then
      ok "ref declares this program id"
    else
      bad "ref declares $DID but this cluster runs $PID -- wrong verification ref"
      continue
    fi

    BEFORE="$(solana-verify get-program-hash "$PID" --url "$URL" 2>/dev/null | tail -1)"
    ok "on-chain hash before: $BEFORE"

    ( cd "$SRC/contracts/svm/source" && solana-verify build --library-name "$prog" >/dev/null 2>&1 )
    ART="$SRC/contracts/svm/source/target/deploy/$prog.so"
    [ -f "$ART" ] || { bad "container build produced no artifact"; continue; }
    BUILT="$(solana-verify get-executable-hash "$ART" 2>/dev/null | tail -1)"
    ok "container build hash : $BUILT"

    if [ "$BUILT" = "$BEFORE" ]; then
      ok "on-chain bytes already equal this build -- skipping the upgrade, registering only"
      SKIP_DEPLOY=1
    else
      SKIP_DEPLOY=0
    fi

    if [ "$MODE" != apply ]; then
      [ "$SKIP_DEPLOY" = 1 ] && echo "  would register commit $(echo "$COMMIT" | cut -c1-9)" \
                             || echo "  would upgrade to $BUILT, then register $(echo "$COMMIT" | cut -c1-9)"
      continue
    fi

    if [ "$SKIP_DEPLOY" = 0 ]; then
      # ProgramData does not grow automatically and the container build is LARGER than the native
      # one deployed, so extend first or the deploy fails with "account data too small".
      NEED="$(stat -f%z "$ART" 2>/dev/null || stat -c%s "$ART")"
      HAVE="$(solana program show "$PID" --url "$URL" 2>/dev/null | grep -i 'Data Length' | grep -oE '[0-9]+' | head -1)"
      if [ -n "$HAVE" ] && [ "$NEED" -gt "$HAVE" ] 2>/dev/null; then
        # The loader enforces a 10240-byte minimum per extend, and `extend` takes --keypair only
        # (no --fee-payer: passing it is a usage error, and the extend silently never runs).
        GROW=$(( NEED - HAVE )); [ "$GROW" -lt 10240 ] && GROW=10240
        solana program extend "$PID" "$GROW" --keypair "$SVM_AUTHORITY_KEYPAIR" --url "$URL" >/dev/null 2>&1
        HAVE="$(solana program show "$PID" --url "$URL" 2>/dev/null | grep -i 'Data Length' | grep -oE '[0-9]+' | head -1)"
        [ "$HAVE" -ge "$NEED" ] 2>/dev/null && ok "ProgramData extended to $HAVE" \
          || { bad "extend failed -- ProgramData is $HAVE, need $NEED"; continue; }
      fi

      BUFOUT="$(solana program write-buffer "$ART" --url "$URL" \
        --keypair "$SVM_AUTHORITY_KEYPAIR" --fee-payer "$SVM_AUTHORITY_KEYPAIR" 2>&1)"
      BUF_ADDR="$(echo "$BUFOUT" | grep -oE '[1-9A-HJ-NP-Za-km-z]{32,44}' | tail -1)"
      [ -n "$BUF_ADDR" ] || { bad "write-buffer failed"; printf '      %s\n' "$(echo "$BUFOUT" | tail -2)"; continue; }
      ok "buffer: $BUF_ADDR"

      DEPLOYOUT="$(solana program deploy --program-id "$PID" --buffer "$BUF_ADDR" \
        --upgrade-authority "$SVM_AUTHORITY_KEYPAIR" \
        --keypair "$SVM_AUTHORITY_KEYPAIR" --fee-payer "$SVM_AUTHORITY_KEYPAIR" \
        --url "$URL" 2>&1)"
      SIG="$(echo "$DEPLOYOUT" | grep -oE 'Signature: [1-9A-HJ-NP-Za-km-z]+' | awk '{print $2}')"
      if [ -z "$SIG" ]; then
        # Never swallow this: the reason is the whole diagnostic, and the buffer is recoverable.
        bad "upgrade failed -- buffer $BUF_ADDR is recoverable"
        printf '      %s\n' "$(echo "$DEPLOYOUT" | tail -3)"
        continue
      fi
      # POLL for the new hash; do not read once. Confirming the transaction is not sufficient:
      # the subsequent read can land on an RPC node that has not caught up, and returns the
      # PREVIOUS hash. A single read reported two successful upgrades as failures and skipped
      # their registration -- the upgrades had in fact applied, as the slot numbers showed.
      solana confirm "$SIG" --url "$URL" >/dev/null 2>&1
      AFTER=""
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        AFTER="$(solana-verify get-program-hash "$PID" --url "$URL" 2>/dev/null | tail -1)"
        [ "$AFTER" = "$BUILT" ] && break
        sleep 6
      done
      [ "$AFTER" = "$BUILT" ] && ok "upgraded; on-chain hash equals the container build" \
        || { bad "on-chain hash is $AFTER but the build was $BUILT (after polling)"; continue; }
    fi

    # Two separate steps, and the difference matters. verify-from-repo rebuilds, compares, and
    # uploads the verification PDA. It does NOT queue osec's own build -- `remote submit-job`
    # does, and only that produces is_verified. Do not read a clean verify-from-repo as "done".
    #
    # Its output is NOT suppressed. An earlier version sent it to /dev/null and reported
    # "submitted" from the exit code alone, so a run that had uploaded nothing looked identical
    # to one that had, and the only symptom was is_verified never changing.
    VOUT="$(cd "$SRC/contracts/svm/source" && solana-verify verify-from-repo "$REPO_URL" \
        --commit-hash "$COMMIT" --program-id "$PID" --library-name "$prog" \
        --mount-path contracts/svm/source --url "$URL" \
        --keypair "$SVM_AUTHORITY_KEYPAIR" -y 2>&1)"
    if echo "$VOUT" | grep -q "Program hash matches"; then
      ok "local verification passed; PDA uploaded"
    else
      bad "verify-from-repo did not confirm a hash match"
      printf '      %s\n' "$(echo "$VOUT" | tail -4)"
      continue
    fi

    # REMOTE VERIFICATION IS MAINNET-ONLY. The Solana docs state it outright, and the CLI refuses
    # elsewhere with "Connect to mainnet with: --url mainnet". A devnet program can hold a valid
    # PDA and pass local verification -- as ours do -- and still never show a badge, because no
    # attestation job can be queued for it. This is a property of the service, not a failure.
    if [ "$cluster" != mainnet ]; then
      warn "remote verification is mainnet-only; $cluster stops at a locally-verified PDA and cannot show is_verified"
      continue
    fi

    UPLOADER="$(solana-keygen pubkey "$SVM_AUTHORITY_KEYPAIR" 2>/dev/null)"
    JOUT="$(solana-verify remote submit-job --program-id "$PID" --uploader "$UPLOADER" --url "$URL" 2>&1)"
    echo "$JOUT" | grep -qiE "error|To submit a remote job" \
      && { bad "remote submit-job did not queue"; printf '      %s\n' "$(echo "$JOUT" | tail -3)"; } \
      || ok "remote verification job submitted"

    curl -s --max-time 30 "https://verify.osec.io/status/$PID" 2>/dev/null | grep -q '"is_verified":true' \
      && ok "osec reports is_verified: true" \
      || warn "osec not yet verified -- the remote build is asynchronous; re-check with: curl -s https://verify.osec.io/status/$PID"
  done
done

hdr "result"
[ "$FAIL" -eq 0 ] && printf '  %sno failures%s\n' "$GRN" "$OFF" || printf '  %s%d failure(s)%s\n' "$RED" "$FAIL" "$OFF"
[ "$MODE" = dry ] && printf '  dry run only -- nothing was written on chain. Re-run with --apply.\n'
exit "$FAIL"
