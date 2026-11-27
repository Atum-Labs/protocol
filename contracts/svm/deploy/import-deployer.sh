#!/usr/bin/env bash
# Interactive mnemonic -> Solana deployer keypair, with derivation-path discovery.
#
#   ./import-deployer.sh --self-test               # prove the derivation, no phrase needed
#   ./import-deployer.sh --from-secp256k1          # reuse the EVM/TVM 32-byte key as the ed25519 seed
#   ./import-deployer.sh --from-secp256k1 --write  # ... and write the keypair
#   ./import-deployer.sh --private-key             # CHECK an existing secret: print its pubkey, write nothing
#   ./import-deployer.sh --private-key --write     # import it for real
#   ./import-deployer.sh --private-key --write --force   # ... replacing an existing key file
#   ./import-deployer.sh                           # sweep and print addresses, write nothing
#   EXPECT=<pubkey> ./import-deployer.sh           # mark which path holds a known address
#   EXPECT=<pubkey> ./import-deployer.sh --write   # write a keypair that already exists
#   DERIVATION_PATH="m/44'/501'/0'/0'" ./import-deployer.sh --write   # CHOOSE a path (new deployer)
#   SCAN=25 ./import-deployer.sh                   # widen the sweep (default 10 per family)
#
# `deploy.ts` takes the deployer EITHER way, so both forms are available:
#   DEPLOYER_KEYPAIR      -> the JSON array of the 64-byte secret key, which --write produces
#   DEPLOYER_PRIVATE_KEY  -> the base58 secret key, printed only by an explicit second command
#
# Needs python3 only. No node, no Anchor, no network.
#
# Why not `solana-keygen recover`: it needs a real TTY for its seed-phrase prompt and dies with
# "Device not configured" on a pipe, so it cannot be swept over candidate paths without prompting
# once per path. This derives BIP39 + SLIP-0010(ed25519) directly; --self-test checks that against
# the published spec vectors AND against solana-keygen's own output before you trust it.
#
# The phrase and passphrase are never echoed, never in shell history, never in argv (visible in
# `ps`) and never in the environment. They touch disk only in one 0600 temp file, wiped on exit
# including on Ctrl-C.
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
DERIVE="$HERE/derive.py"

: "${SCAN:=10}"
: "${EXPECT:=}"
# Default into the bootstrap layout ($ATUM_HOME/keys). A key already at the older
# ~/.atum-svm-deployer.json path still wins, so an existing setup keeps working untouched.
: "${ATUM_HOME:=$HOME/.atum}"
if [ -z "${OUTF:-}" ] && [ -f "$HOME/.atum-svm-deployer.json" ]; then
  OUTF="$HOME/.atum-svm-deployer.json"
else
  : "${OUTF:=$ATUM_HOME/keys/svm-deployer.json}"
fi
mkdir -p "$(dirname "$OUTF")" && chmod 700 "$(dirname "$OUTF")" 2>/dev/null || true

MODE="${1:-scan}"
case "$MODE" in --write|--self-test|--private-key|--from-secp256k1) ;; scan|"") MODE=scan ;; *) echo "unknown arg: $MODE" >&2; exit 2 ;; esac
# --private-key is a DRY CHECK unless --write is also given, matching the rest of this tooling.
PK_WRITE=0; FORCE=0
for a in "$@"; do
  [ "$a" = --write ] && PK_WRITE=1
  [ "$a" = --force ] && FORCE=1
done

command -v python3 >/dev/null || { echo "python3 not found" >&2; exit 1; }
[ -f "$DERIVE" ] || { echo "missing $DERIVE — it ships beside this script" >&2; exit 1; }

[ "$MODE" = --self-test ] && { python3 "$DERIVE" --self-test; exit "$?"; }

# ---------------------------------------------------------------- secp256k1 key as ed25519 seed
# One 32-byte secret serving EVM, Tron and Solana. Deliberate, non-standard, and irreversible in
# one specific way: no wallet and no seed phrase reproduces this address, so recovery depends on
# still holding the raw key. Same input hygiene as every other path here.
if [ "$MODE" = --from-secp256k1 ]; then
  SF="$(mktemp "${TMPDIR:-/tmp}/.atum-svm-k1.XXXXXX")"; chmod 600 "$SF"
  cleanup_k1() { command shred -u "$SF" 2>/dev/null || rm -Pf "$SF" 2>/dev/null || rm -f "$SF"; }
  trap cleanup_k1 EXIT INT TERM

  echo "Reusing a secp256k1 private key (the EVM/Tron deployer) as the ed25519 seed."
  echo "  * The Solana address will look UNRELATED to the EVM address. That is expected; there is"
  echo "    no derivation between the curves, only a shared 32 bytes."
  echo "  * NO seed phrase and NO wallet recovers it. Keep the raw key, or lose the account."
  echo "  * It reuses one secret across two signature algorithms."
  echo "  Prefer the mnemonic path unless that is a deliberate choice: $0 (no flag) sweeps it."
  echo
  printf 'Enter the secp256k1 private key, 64 hex chars, 0x optional (hidden, then Enter): '
  IFS= read -rs SK; printf '\n'
  [ -z "$SK" ] && { echo "empty input; aborting" >&2; exit 1; }
  printf '%s\n' "$SK" > "$SF"; unset SK

  if [ "$PK_WRITE" = 0 ]; then
    GOT="$(python3 "$DERIVE" --from-secp256k1 "$SF")" || exit 1
    echo
    echo "pubkey: $GOT"
    if [ -n "${EXPECT:-}" ]; then
      [ "$GOT" = "$EXPECT" ] && echo "MATCHES EXPECT." || { echo "MISMATCH — EXPECT=$EXPECT" >&2; exit 3; }
    fi
    echo
    echo "Nothing was written. To import it:"
    echo "  $0 --from-secp256k1 --write"
    exit 0
  fi

  if [ -e "$OUTF" ]; then
    CUR="$(solana-keygen pubkey "$OUTF" 2>/dev/null || echo unreadable)"
    if [ "$FORCE" = 0 ]; then
      echo "REFUSING: $OUTF already exists (pubkey $CUR)." >&2
      echo "  To replace it deliberately: $0 --from-secp256k1 --write --force" >&2
      exit 1
    fi
    echo "--force: REPLACING the existing key at $OUTF"
    echo "         outgoing pubkey: $CUR"
    command shred -u "$OUTF" 2>/dev/null || rm -Pf "$OUTF" 2>/dev/null || rm -f "$OUTF"
  fi

  GOT="$(python3 "$DERIVE" --from-secp256k1 "$SF" "$OUTF")" || exit 1
  chmod 600 "$OUTF"
  echo
  echo "Wrote $OUTF (0600) — pubkey $GOT"
  if [ -n "${EXPECT:-}" ]; then
    if [ "$GOT" = "$EXPECT" ]; then echo "MATCHES EXPECT. Proceed."
    else
      command shred -u "$OUTF" 2>/dev/null || rm -f "$OUTF"
      echo "MISMATCH — EXPECT=$EXPECT but this is $GOT. Removed the file." >&2; exit 3
    fi
  fi
  echo
  echo "Use it with:"
  echo "  export DEPLOYER_KEYPAIR=$OUTF"
  echo "Back up the secp256k1 key itself; nothing else regenerates this account."
  exit 0
fi

# ---------------------------------------------------------------- import an existing key
# A different deployer (a mainnet key, say) will not come from the same seed as the testnet one,
# so there is nothing to sweep: take the secret directly. Same hygiene as the mnemonic path —
# hidden entry, never in argv or the environment, one 0600 temp file wiped on exit.
if [ "$MODE" = --private-key ]; then
  SF="$(mktemp "${TMPDIR:-/tmp}/.atum-svm-sk.XXXXXX")"; chmod 600 "$SF"
  cleanup_sk() { command shred -u "$SF" 2>/dev/null || rm -Pf "$SF" 2>/dev/null || rm -f "$SF"; }
  trap cleanup_sk EXIT INT TERM
  echo "Accepts any of: base58 secret (64 or 32 bytes), or a JSON array (64 or 32)."
  printf 'Enter the Solana secret key (input hidden, then Enter): '
  IFS= read -rs SK; printf '\n'
  [ -z "$SK" ] && { echo "empty input; aborting" >&2; exit 1; }
  printf '%s\n' "$SK" > "$SF"; unset SK

  if [ "$PK_WRITE" = 0 ]; then
    GOT="$(python3 "$DERIVE" --import-secret "$SF")" || exit 1
    echo
    echo "pubkey: $GOT"
    if [ -n "${EXPECT:-}" ]; then
      [ "$GOT" = "$EXPECT" ] && echo "MATCHES EXPECT." || { echo "MISMATCH — EXPECT=$EXPECT" >&2; exit 3; }
    fi
    echo
    echo "Nothing was written. To import it:"
    echo "  $0 --private-key --write"
    exit 0
  fi

  if [ -e "$OUTF" ]; then
    CUR="$(solana-keygen pubkey "$OUTF" 2>/dev/null || echo unreadable)"
    if [ "$FORCE" = 0 ]; then
      echo "REFUSING: $OUTF already exists. Move or delete it first, so an existing deployer is" >&2
      echo "never silently replaced. Current pubkey: $CUR" >&2
      echo "  To replace it deliberately: $0 --private-key --write --force" >&2
      exit 1
    fi
    # --force: say what is being destroyed, then shred rather than truncate. A plain overwrite
    # can leave the old secret in freed blocks.
    echo "--force: REPLACING the existing key at $OUTF"
    echo "         outgoing pubkey: $CUR"
    command shred -u "$OUTF" 2>/dev/null || rm -Pf "$OUTF" 2>/dev/null || rm -f "$OUTF"
  fi

  GOT="$(python3 "$DERIVE" --import-secret "$SF" "$OUTF")" || exit 1
  chmod 600 "$OUTF"
  echo
  echo "Wrote $OUTF (0600) — pubkey $GOT"
  if [ -n "${EXPECT:-}" ]; then
    if [ "$GOT" = "$EXPECT" ]; then
      echo "MATCHES EXPECT. Proceed."
    else
      command shred -u "$OUTF" 2>/dev/null || rm -f "$OUTF"
      echo "MISMATCH — EXPECT=$EXPECT but this key is $GOT. Removed the file; nothing was kept." >&2
      exit 3
    fi
  else
    echo "No EXPECT set, so nothing was cross-checked. Confirm the pubkey above is the deployer"
    echo "you intend before funding it or deploying with it."
  fi
  echo
  echo "Use it with:"
  echo "  export DEPLOYER_KEYPAIR=$OUTF"
  exit 0
fi

SF="$(mktemp "${TMPDIR:-/tmp}/.atum-svm-mn.XXXXXX")"
chmod 600 "$SF"
cleanup() { command shred -u "$SF" 2>/dev/null || rm -Pf "$SF" 2>/dev/null || rm -f "$SF"; }
trap cleanup EXIT INT TERM

printf 'Enter mnemonic / seed phrase (input hidden, then Enter): '
IFS= read -rs MN; printf '\n'
[ -z "$MN" ] && { echo "empty input; aborting" >&2; exit 1; }
printf 'BIP39 passphrase (hidden, blank if none): '
IFS= read -rs PW; printf '\n'

# line 1 = mnemonic, line 2 = passphrase. Both stay in this 0600 file only.
printf '%s\n%s\n' "$MN" "${PW:-}" > "$SF"
unset MN PW

echo
OUT="$(SVM_SCAN="$SCAN" SVM_EXPECT="$EXPECT" python3 "$DERIVE" --scan "$SF")" \
  || { echo "derivation failed" >&2; exit 1; }
printf '%s\n' "$OUT"

FOUND_PATH="$(printf '%s\n' "$OUT" | awk '/<== MATCH/{print $1; exit}')"

if [ -n "$EXPECT" ] && [ -z "$FOUND_PATH" ]; then
  echo
  echo "No scanned path derives $EXPECT. NOTHING was written." >&2
  echo "  1. Wrong or missing BIP39 passphrase. A wrong one does not error — it silently derives a" >&2
  echo "     valid but DIFFERENT set of addresses, which is what you are looking at above." >&2
  echo "  2. Higher index: re-run with SCAN=50." >&2
  echo "  3. A path outside the four families. SLIP-0010 ed25519 permits HARDENED components only," >&2
  echo "     so any path with a non-hardened level is not a Solana path at all." >&2
  exit 2
fi

if [ "$MODE" != --write ]; then
  echo
  echo "Sweep only — nothing written."
  echo "  EXPECT=<pubkey> $0 --write     # pins which path is the deployer, then writes it"
  exit 0
fi

# --write needs an unambiguous target. Two legitimate ways to give it one:
#   EXPECT=<pubkey>          RECOVERING a key that already exists somewhere
#   DERIVATION_PATH=<path>   CHOOSING a path deliberately, for a deployer that does not exist yet
# (Not PATH= — that is the shell's executable search path.)
if [ -z "$FOUND_PATH" ] && [ -n "${DERIVATION_PATH:-}" ]; then
  FOUND_PATH="$DERIVATION_PATH"
  echo
  echo "Writing the key at the explicitly chosen path $FOUND_PATH (no EXPECT to match against)."
fi
if [ -z "$FOUND_PATH" ]; then
  echo
  echo "Refusing to write: nothing identifies which path is the deployer." >&2
  echo "  Every path above yields a valid keypair, so picking one silently would be a guess." >&2
  echo >&2
  echo "  If the key already EXISTS somewhere, match it:" >&2
  echo "     EXPECT=<pubkey> $0 --write" >&2
  echo >&2
  echo "  If you are CREATING the deployer (none of these has on-chain history), choose a path:" >&2
  echo "     DERIVATION_PATH=\"m/44'/501'/0'/0'\" $0 --write" >&2
  echo "  m/44'/501'/0'/0' is the conventional index 0 — Phantom, Solflare, Ledger and" >&2
  echo "  solana-keygen 'prompt:?key=0/0' all use it. Record whichever you pick." >&2
  exit 2
fi

umask 077
GOT="$(python3 "$DERIVE" --write "$SF" "$FOUND_PATH" "$OUTF")" || { echo "write failed" >&2; exit 1; }
chmod 600 "$OUTF"

if [ -n "$EXPECT" ] && [ "$GOT" != "$EXPECT" ]; then
  command shred -u "$OUTF" 2>/dev/null || rm -f "$OUTF"
  echo "Wrote a key resolving to $GOT, not $EXPECT. File deleted; do NOT deploy." >&2
  exit 3
fi

echo
echo "Wrote $OUTF (0600) — pubkey $GOT, derived at $FOUND_PATH"
echo
echo "Point deploy.ts at it:"
echo "  export DEPLOYER_KEYPAIR=$OUTF"
echo
echo "The base58 form (DEPLOYER_PRIVATE_KEY) is deliberately NOT printed here. If you need it:"
echo "  python3 $DERIVE --show-base58 $OUTF"
echo
echo "Fund it before deploying: ~5.73 SOL measured for both programs plus their IDLs; ~7 with margin."
echo "Devnet is a free airdrop:  solana airdrop 2 $GOT --url devnet   (repeat; per-request capped)"
echo
echo "Delete when done:  shred -u $OUTF 2>/dev/null || rm -P $OUTF"
