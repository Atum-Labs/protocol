#!/usr/bin/env bash
# Pre-finalisation gate for `solana program set-upgrade-authority --final`.
#
# `--final` is a ONE-WAY DOOR. It removes the upgrade authority permanently: there is no
# recovery, no governance override, no patch path. Every property this script checks is one
# that becomes uncorrectable the moment it runs, so a BLOCK here is not advice.
#
# What it deliberately does NOT check, because --final does not touch it: the four config
# roles. default_admin, token_config_authority, treasurer and pauser stay exactly as they
# are and remain changeable afterwards. Freezing the code does nothing about single-key
# custody of those; see the README section this script is documented in.
#
#   CLUSTER=mainnet-beta ./pre-finalize.sh          # report only, changes nothing
#
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CLUSTER="${CLUSTER:-mainnet-beta}"
ESCROW="${SOLANA_ESCROW_PROGRAM_ID:-5BD9UAUCRCg6Chv6CS5k4sBHGd7CciWpng9u7iJxJFjx}"
FPROXY="${SOLANA_FULFILLMENT_PROXY_PROGRAM_ID:-CMxMPzpmeJPJbyUK4DDSDEhEYdCCAUt7w5cr5SWEHoNJ}"
SRC_DIR="${SRC_DIR:-$HERE/../source}"

case "$CLUSTER" in
  devnet)       URL=${SOLANA_RPC_URL:-https://api.devnet.solana.com} ;;
  mainnet-beta) URL=${SOLANA_RPC_URL:-https://api.mainnet-beta.solana.com} ;;
  testnet)      URL=${SOLANA_RPC_URL:-https://api.testnet.solana.com} ;;
  *) echo "unknown CLUSTER: $CLUSTER" >&2; exit 2 ;;
esac

FAIL=0
gate() {
  if [ "$1" = ok ]; then printf '  \033[32mPASS\033[0m  %-36s %s\n' "$2" "$3"
  else printf '  \033[31mBLOCK\033[0m %-36s %s\n' "$2" "$3"; FAIL=$((FAIL+1)); fi
}
info() { printf '  \033[36minfo\033[0m  %-36s %s\n' "$1" "$2"; }

echo "pre-finalize gate — cluster $CLUSTER"
echo "  escrow $ESCROW"
echo "  proxy  $FPROXY"
echo

# ---------------------------------------------------------------- cluster guard
# Freezing devnet would destroy the only cluster where the next version can be tested.
# This is the one gate that exits immediately rather than counting a failure.
if [ "$CLUSTER" != mainnet-beta ]; then
  gate no "cluster is mainnet-beta" "refusing: --final on $CLUSTER would destroy the cluster you test upgrades on"
  echo; echo "REFUSING on a non-mainnet cluster." >&2; exit 1
fi
gate ok "cluster is mainnet-beta" "devnet stays upgradeable"

# ------------------------------------------------------- still upgradeable at all?
for P in "$ESCROW" "$FPROXY"; do
  # stderr is KEPT. Dropping it made every failure mode -- unreachable RPC, rate limit, typo'd
  # program id, missing solana binary -- produce an empty $A, which the old `[ -z "$A" ]` branch
  # reported as "already final, nothing to do" about a fully upgradeable program.
  #
  # And `solana program show` prints the literal word `none` for a frozen program, never a blank
  # line, so that branch could not fire for a program that genuinely IS final. It was inverted in
  # both directions: green on every error, and never green on the one case it described.
  A=$(solana program show "$P" --url "$URL" 2>&1 | awk '/^Authority:/{print $2}')
  case "$A" in
    none) gate ok "already final: ${P:0:8}…"      "no upgrade authority — nothing to do for this program" ;;
    "")   gate no "authority readable: ${P:0:8}…" "no Authority line — RPC unreachable, or wrong program id" ;;
    *)    info    "upgrade authority ${P:0:8}…"   "$A" ;;
  esac
done

# ------------------------------------------------- permanent fields, no setter exists
# signature_domain_version and cluster_id are written ONLY by initialize_protocol and have
# no setter instruction. Both sit inside every signature preimage, so a wrong value cannot
# be corrected after --final except by deploying a NEW program id -- which changes the
# preimage again and invalidates all 13 hash anchors and every offchain signer.
EXPECT_VER=$(grep -oE 'CURRENT_SIGNATURE_DOMAIN_VERSION: u8 = [0-9]+' \
  "$SRC_DIR/programs/escrow/src/state.rs" 2>/dev/null | grep -oE '[0-9]+$')
if [ -z "$EXPECT_VER" ]; then
  gate no "domain version matches source" "could not read CURRENT_SIGNATURE_DOMAIN_VERSION (set SRC_DIR)"
else
  ONCHAIN=$(python3 "$HERE/read-protocol-config.py" --program "$ESCROW" --url "$URL" --field signature_domain_version 2>/dev/null)
  if [ "$ONCHAIN" = "$EXPECT_VER" ]; then
    gate ok "domain version matches source" "$ONCHAIN — permanent after --final"
  else
    gate no "domain version matches source" "on chain $ONCHAIN, source says $EXPECT_VER — PERMANENT once frozen"
  fi
fi

CID=$(python3 "$HERE/read-protocol-config.py" --program "$ESCROW" --url "$URL" --field cluster_id 2>/dev/null)
if [ "$CID" = mainnet ]; then
  gate ok "cluster_id is correct" "\"$CID\" — permanent after --final"
else
  gate no "cluster_id is correct" "on chain \"$CID\", expected \"mainnet\" — PERMANENT once frozen"
fi

# ------------------------------------------------------------- config initialised
ESZ=$(python3 "$HERE/read-protocol-config.py" --program "$ESCROW" --url "$URL" --field size 2>/dev/null)
FSZ=$(python3 "$HERE/read-protocol-config.py" --program "$FPROXY" --url "$URL" --field size 2>/dev/null)
[ "$ESZ" = 216 ] && gate ok "escrow protocol_config" "216 bytes, initialised" \
                 || gate no "escrow protocol_config" "got '${ESZ:-none}', expected 216"
[ "$FSZ" = 636 ] && gate ok "proxy protocol_config" "636 bytes, v4 layout with the allowlist" \
                 || gate no "proxy protocol_config" "got '${FSZ:-none}', expected 636"

# -------------------------------------------------------------- the hash anchors
# The program id is inside every preimage, so the 13 anchors are only valid for THIS id.
if [ -f "$SRC_DIR/scripts/anchors/derive_anchors.py" ]; then
  # NOT the exit code. derive_anchors.py --validate prints a MATCH/MISMATCH table and
  # returns 0 unconditionally -- and when the id you pass differs from the committed one
  # it says every ID-dependent row is EXPECTED to differ, then still exits 0. Gating on
  # `if python3 ... --validate` is a check that cannot fail.
  #
  # Two things must hold for a freeze: signatures.rs must be pinned to the id being
  # frozen, and every row must match.
  PINNED=$(grep -oE 'CURRENT_PROGRAM_ID_B58 = "[^"]+"' "$SRC_DIR/scripts/anchors/derive_anchors.py" \
             | grep -oE '"[^"]+"' | tr -d '"')
  if [ "$PINNED" != "$ESCROW" ]; then
    gate no "hash anchors are for THIS program id" \
      "signatures.rs pins anchors for ${PINNED:-unknown}, not the deployed $ESCROW — re-derive before freezing"
  else
    # The exit code is honoured. Grepping only for "MISMATCH" meant anything that died before the
    # table printed -- a failed keccak self-test (exit 3), any Python traceback -- contained no
    # "MISMATCH" and so went green. A real `N/N match` line is now required, not merely the
    # absence of a bad word.
    if ! OUT=$(cd "$SRC_DIR/scripts/anchors" && python3 derive_anchors.py "$ESCROW" --validate 2>&1); then
      gate no "hash anchors are for THIS program id" "derive_anchors.py exited non-zero — cannot verify"
    elif printf '%s\n' "$OUT" | awk '/^[0-9]+\/[0-9]+ match$/{split($1,a,"/"); if (a[1]==a[2] && a[1]>0) ok=1} END{exit !ok}'; then
      gate ok "hash anchors are for THIS program id" \
        "$(printf '%s\n' "$OUT" | grep -oE '^[0-9]+/[0-9]+ match' | tail -1), pinned to $ESCROW"
    else
      gate no "hash anchors are for THIS program id" "not all rows matched, or no table was produced"
    fi

    # And this gate now actually reads signatures.rs. derive_anchors.py opens no files -- its
    # COMMITTED table and CURRENT_PROGRAM_ID_B58 are hand-pasted constants -- so on its own it
    # proves only that the script agrees with itself. Pasting the digests into signatures.rs is a
    # manual step, so a re-derive with one paste missed left this green and then froze.
    SIG="$SRC_DIR/programs/escrow/src/utils/signatures.rs"
    if [ -f "$SIG" ]; then
      BAD=$(printf '%s\n' "$OUT" | awk '$4 ~ /^[0-9a-f]{64}$/{print $4}' \
              | while read -r H; do grep -q "$H" "$SIG" || echo "$H"; done | wc -l | tr -d ' ')
      if [ "$BAD" = 0 ]; then
        gate ok "anchors present in signatures.rs" "every derived digest found in the file"
      else
        gate no "anchors present in signatures.rs" "$BAD digest(s) derived but absent from signatures.rs"
      fi
    else
      gate no "anchors present in signatures.rs" "signatures.rs not found at $SIG"
    fi
  fi
else
  # Fail closed, and say where the tool is. derive_anchors.py ships with the SVM deploy
  # tooling in a sibling PR, so on a checkout without it the anchors CANNOT be verified --
  # and freezing without verifying them is exactly the mistake this gate exists to stop.
  gate no "hash anchors match the program id" \
    "no derive_anchors.py under \$SRC_DIR/scripts/anchors — cannot verify; set SRC_DIR to a tree that has it"
fi

# ------------------------------------------------- THE precondition: reproducible build
# After --final a source/binary mismatch is permanent: the deployed program can never be
# corrected to match the audited source. This is the only gate that justifies holding the
# freeze on its own.
#
# The previous command could never run: `verify-from-repo` takes the repo URL as a REQUIRED
# positional and has no `--dry-run` flag, so clap rejected it before any verification happened.
# The operator then read "verification FAILED", which points at the binary rather than at the
# command -- and since the gate could never pass, the script could never exit 0 and the closing
# "all gates pass" banner was unreachable.
#
# The hash pair below is read-only: no docker, no repo clone, no on-chain write, so the header's
# "reports only, changes nothing" promise still holds. Both programs are checked, because both are
# frozen -- the old gate looked at $ESCROW alone, so the proxy could be made permanently immutable
# with no evidence about its binary at all.
#
# Worth being precise about what this proves: deployed == what is in target/deploy, which is
# WEAKER than a reproducible-build attestation. The full check is
# `solana-verify verify-from-repo <repo-url> --commit-hash <sha> --program-id <id> -y`, but it
# clones, docker-builds and writes on chain, so adopting it means dropping the promise in the
# header above.
if command -v solana-verify >/dev/null 2>&1; then
  for PAIR in "$ESCROW:escrow" "$FPROXY:fulfillment_proxy"; do
    P=${PAIR%%:*}; NAME=${PAIR##*:}
    ON=$(solana-verify get-program-hash "$P" --url "$URL" 2>/dev/null)
    LO=$(solana-verify get-executable-hash "$SRC_DIR/target/deploy/$NAME.so" 2>/dev/null)
    if [ -n "$ON" ] && [ "$ON" = "$LO" ]; then
      gate ok "deployed binary == built source: $NAME" "$ON"
    else
      gate no "deployed binary == built source: $NAME" "on chain '${ON:-unreadable}', local '${LO:-not built}'"
    fi
  done
else
  gate no "deployed binary == built source" \
    "solana-verify not installed — cannot prove the deployed .so matches the built source"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  cat <<'EOF'
── all gates pass. Read this before running the command:

   --final removes the UPGRADE authority only. It does NOT touch default_admin,
   token_config_authority, treasurer or pauser: those keep their current holder and
   stay changeable. Freezing the code does not reduce single-key custody risk.

   A future bug cannot be patched. It needs a NEW program id, which changes every
   signature preimage, invalidates all 13 hash anchors, and requires PROGRAM_ID_BYTES,
   ~50 consumer sites and every offchain signer to move in lockstep.

   solana program set-upgrade-authority <PROGRAM_ID> --final \
     -k "$DEPLOYER_KEYPAIR" --url "$SOLANA_RPC_URL"

   Then re-run this script: both programs should report "already final".
EOF
  exit 0
fi
printf '── %s gate(s) BLOCK. Do not run --final.\n' "$FAIL"
exit 1
