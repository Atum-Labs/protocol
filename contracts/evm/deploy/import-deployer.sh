#!/usr/bin/env bash
# Interactive mnemonic -> forge keystore import, with index discovery.
#
#   ./import-deployer.sh [account] [expected-address]   # sweep a mnemonic for the address
#   ./import-deployer.sh --private-key                 # CHECK a key: print its address, import nothing
#   ./import-deployer.sh --private-key --write [account] [expected-address]
#                                                      # import it into the foundry keystore
#   ./import-deployer.sh --private-key --write --force [account] [expected]
#                                                      # ... replacing an existing keystore entry
#
# A different deployer (a mainnet key, say) need not come from the same seed as the testnet one,
# so --private-key skips the sweep entirely and hands the key straight to the keystore.
# The phrase is never echoed, never in shell history, and never a command-line argument
# (which would be visible in `ps`). It touches disk only in a 0600 temp file that is
# wiped on exit, including on Ctrl-C.
#
# Two values DO reach argv, because `cast` accepts them only as arguments: a raw
# --private-key in the paste-a-key path (L48), and the BIP39 passphrase, which is passed
# on every sweep iteration and on the import. Both are visible to `ps` for the life of
# each call, the passphrase once per sweep index. Do not use those paths on a shared
# machine.
set -uo pipefail

MODE=mnemonic
if [ "${1:-}" = "--private-key" ]; then MODE=private-key; shift; fi
# --private-key is a DRY CHECK unless --write is also given, matching the rest of this tooling.
PK_WRITE=0; FORCE=0
for a in "$@"; do
  [ "$a" = --write ] && PK_WRITE=1
  [ "$a" = --force ] && FORCE=1
done
set -- ${@:+"${@}"}; ARGS=()
for a in "$@"; do case "$a" in --write|--force) ;; *) ARGS+=("$a") ;; esac; done
set -- ${ARGS[@]+"${ARGS[@]}"}

# Keystores are named by network: atum-deployer-testnet or atum-deployer-mainnet. With no account
# name, NETWORK picks it; with neither, refuse rather than guess (as networks.sh does).
ACCOUNT="${1:-}"
if [ -z "$ACCOUNT" ]; then
  case "${NETWORK:-}" in
    testnet|mainnet) ACCOUNT="atum-deployer-$NETWORK" ;;
    *) echo "Name the keystore account, or set NETWORK=testnet|mainnet to use atum-deployer-<network>." >&2; exit 2 ;;
  esac
fi
# No default expected address: hardcoding one is wrong for every deployer but a single historical
# one, and a stale default either fails confusingly or gets waved through.
EXPECT="${2:-}"
SCAN="${SCAN:-10}"

# Catch the swap. The order is [account] [expected-address], and getting it backwards is quiet
# and expensive: the sweep runs to completion hunting for an account NAME as though it were an
# address, prints ten correct-looking derivations, and reports "No index derives <name>" -- which
# reads as a bad phrase or a wrong passphrase. If $1 looks like an address and $2 does not, it is
# a swap, not a deliberate choice: no keystore is named after an address.
is_addr() { case "$1" in 0x[0-9a-fA-F]*) [ "${#1}" -eq 42 ] ;; *) false ;; esac; }
if is_addr "$ACCOUNT" && [ -n "$EXPECT" ] && ! is_addr "$EXPECT"; then
  echo "The arguments are the wrong way round: the order is [account] [expected-address]." >&2
  echo "  you passed : account '$ACCOUNT'  expected-address '$EXPECT'" >&2
  echo "  you meant  : $0 $EXPECT $ACCOUNT" >&2
  exit 2
fi
if is_addr "$ACCOUNT" && [ -z "$EXPECT" ]; then
  echo "'$ACCOUNT' is an address, but the first argument is the keystore ACCOUNT NAME." >&2
  echo "  did you mean: $0 <account-name> $ACCOUNT" >&2
  exit 2
fi

want="$(printf '%s' "$EXPECT" | tr 'A-Z' 'a-z')"

# Keystore location, shared by both paths. FOUNDRY_KEYSTORES_DIR / FOUNDRY_KEYSTORE_DIR are NOT
# read by `cast wallet import` in foundry 1.7, so the directory is controlled explicitly with -k
# and the guard below looks at exactly the file cast will write.
KSDIR="${KEYSTORE_DIR:-$HOME/.foundry/keystores}"
KSFILE="$KSDIR/$ACCOUNT"
KSARG=(); [ -n "${KEYSTORE_DIR:-}" ] && KSARG=(-k "$KEYSTORE_DIR")

# Refuse an occupied name. Called EARLY on both paths -- before the mnemonic prompt -- so an
# existing entry never costs you a seed-phrase entry and a full sweep.
keystore_refuse_if_occupied() {
  [ -e "$KSFILE" ] || return 0
  [ "$FORCE" = 1 ] && return 0
  echo "REFUSING: a keystore entry named '$ACCOUNT' already exists at $KSFILE." >&2
  echo "  Pick another account name, or replace it deliberately with --force." >&2
  exit 1
}

# Move an existing entry aside. Called LATE, immediately before the import, so --force on the
# mnemonic path cannot displace a working key for a sweep that then finds nothing. A foundry
# keystore is encrypted at rest and a mistaken --force would otherwise destroy something still
# recoverable, so move rather than shred.
keystore_force_move_aside() {
  [ -e "$KSFILE" ] || return 0
  BAK="$KSFILE.replaced-$(date +%Y%m%dT%H%M%S)"
  mv "$KSFILE" "$BAK" || { echo "could not move the existing keystore aside" >&2; exit 1; }
  echo "--force: moved the existing '$ACCOUNT' entry aside"
  echo "         $BAK"
  echo "         Its address cannot be shown without its password: this keystore format stores"
  echo "         only crypto/id/version, no plaintext address. Delete the backup once you are"
  echo "         satisfied the new key is right."
}

# ---------------------------------------------------------------- import an existing key
if [ "$MODE" = private-key ] && [ "$PK_WRITE" = 0 ]; then
  # Dry check: derive and print, touch no keystore. The key reaches argv for one short-lived
  # local `cast` call; `--interactive` avoids argv but REQUIRES a real TTY (it dies with
  # "Device not configured" on a pipe), so it cannot be used for a scripted check.
  printf 'Enter the private key, 64 hex chars, 0x optional (input hidden, then Enter): '
  IFS= read -rs SK; printf '\n'
  [ -z "$SK" ] && { echo "empty input; aborting" >&2; exit 1; }
  SK="$(printf '%s' "$SK" | tr -d '[:space:]' | sed 's/^0[xX]//')"
  case "$SK" in *[!0-9a-fA-F]*) echo "not hex: the key contains non-hex characters" >&2; exit 1 ;; esac
  [ "${#SK}" -eq 64 ] || { echo "expected 64 hex chars, got ${#SK}" >&2; exit 1; }
  got="$(cast wallet address --private-key "0x$SK" 2>/dev/null)" \
    || { echo "cast could not derive an address from that key" >&2; exit 1; }
  unset SK
  echo
  echo "address: $got"
  if [ -n "$EXPECT" ]; then
    if [ "$(printf '%s' "$got" | tr 'A-Z' 'a-z')" = "$want" ]; then echo "MATCHES $EXPECT."
    else echo "MISMATCH — expected $EXPECT." >&2; exit 3; fi
  fi
  echo
  echo "Nothing was imported. To import it into the keystore:"
  echo "  $0 --private-key --write ${ACCOUNT}${EXPECT:+ $EXPECT}"
  exit 0
fi

if [ "$MODE" = private-key ]; then
  # `cast wallet import --interactive` prompts for the key itself, so it never appears in argv
  # (visible in `ps`) nor in shell history. Do NOT switch this to --private-key <key>.
  # cast refuses when the entry exists ("Keystore file already exists at ..."), so --force has to
  # clear it first. Unlike the TVM/SVM key files, a foundry keystore is ENCRYPTED at rest, and a
  # mistaken --force would otherwise destroy a key that is still recoverable. So move it aside
  # rather than shred it; the plaintext paths shred precisely because copies there are a liability.
  # The guard and cast MUST look at the same directory, so control it explicitly with -k rather
  # than hoping an env var is honoured. FOUNDRY_KEYSTORES_DIR / FOUNDRY_KEYSTORE_DIR are NOT read
  # by `cast wallet import` in foundry 1.7 -- it writes to the default regardless, which makes a
  # guard based on them check a path cast never touches. Verified, not assumed.
  if [ -e "$KSFILE" ] && [ "$FORCE" = 0 ]; then
    echo "REFUSING: a keystore entry named '$ACCOUNT' already exists at $KSFILE." >&2
    echo "  Pick another account name, or replace it deliberately:" >&2
    echo "    $0 --private-key --write --force $ACCOUNT${EXPECT:+ $EXPECT}" >&2
    exit 1
  fi
  keystore_force_move_aside

  echo "Importing an existing private key as '$ACCOUNT'."
  echo "You will be prompted for the key, then for a keystore password to encrypt it at rest."
  cast wallet import "$ACCOUNT" ${KSARG[@]+"${KSARG[@]}"} --interactive || exit 1

  # `cast wallet address` takes --keystore <FILE>, not -k <DIR> (only `import` accepts -k), so the
  # read-back has to address the file directly when a custom directory is in play.
  if [ -n "${KEYSTORE_DIR:-}" ]; then
    got="$(cast wallet address --keystore "$KSFILE")" || exit 1
  else
    got="$(cast wallet address --account "$ACCOUNT")" || exit 1
  fi
  echo
  echo "keystore '$ACCOUNT' holds: $got"
  if [ -z "$EXPECT" ]; then
    echo "No expected address given, so nothing was cross-checked. Confirm the address above is"
    echo "the deployer you intend before funding it or deploying with it."
    echo "  Re-run as: $0 --private-key $ACCOUNT <expected-address>   to have it verified."
    exit 0
  fi
  if [ "$(printf '%s' "$got" | tr 'A-Z' 'a-z')" = "$want" ]; then
    echo "MATCHES the expected deployer. Proceed."
    exit 0
  fi
  echo "MISMATCH — expected $EXPECT. Do NOT deploy with this keystore." >&2
  echo "The keystore entry was still created; remove it with:" >&2
  echo "  rm ~/.foundry/keystores/$ACCOUNT" >&2
  exit 3
fi

# ---------------------------------------------------------------- mnemonic sweep
# The sweep has nothing to search FOR without a target address.
if [ -z "$EXPECT" ]; then
  echo "No expected address given, so there is nothing to search the mnemonic indices for." >&2
  echo "  Sweeping a mnemonic:  $0 $ACCOUNT <expected-address>" >&2
  echo "  Importing a raw key:  $0 --private-key $ACCOUNT [expected-address]" >&2
  exit 2
fi

# Before asking for anything secret: if the name is taken and --force was not given, stop here.
# The old code only discovered this after the phrase was entered and every index swept, and
# --force was accepted but never acted on, so the import failed anyway.
keystore_refuse_if_occupied

MNF="$(mktemp "${TMPDIR:-/tmp}/.atum-mn.XXXXXX")"
chmod 600 "$MNF"
cleanup() { command shred -u "$MNF" 2>/dev/null || rm -Pf "$MNF" 2>/dev/null || rm -f "$MNF"; }
trap cleanup EXIT INT TERM

printf 'Enter mnemonic / seed phrase (input hidden, then Enter): '
IFS= read -rs MN; printf '\n'
[ -z "$MN" ] && { echo "empty input; aborting" >&2; exit 1; }

printf 'BIP39 passphrase (hidden, blank if none): '
IFS= read -rs PASS; printf '\n'

printf '%s\n' "$MN" > "$MNF"
unset MN

PASSARG=(); [ -n "${PASS:-}" ] && PASSARG=(--mnemonic-passphrase "$PASS")
unset PASS

echo
echo "Scanning m/44'/60'/0'/0/0..$((SCAN-1)) for $EXPECT"
FOUND=""
for i in $(seq 0 $((SCAN-1))); do
  a="$(cast wallet address --mnemonic "$MNF" --mnemonic-index "$i" ${PASSARG[@]+"${PASSARG[@]}"} 2>/dev/null)" || continue
  got="$(printf '%s' "$a" | tr 'A-Z' 'a-z')"
  if [ "$got" = "$want" ]; then printf '  index %-2s -> %s   <== MATCH\n' "$i" "$a"; FOUND="$i"
  else printf '  index %-2s -> %s\n' "$i" "$a"; fi
done

if [ -z "$FOUND" ]; then
  echo
  echo "No index in 0..$((SCAN-1)) derives $EXPECT." >&2
  echo "Either the passphrase is wrong (a wrong one silently derives valid but DIFFERENT" >&2
  echo "addresses), or the key is on a non-default path. Try:" >&2
  echo "  cast wallet address --mnemonic <file> --mnemonic-derivation-path \"m/44'/60'/0'/0/0\"" >&2
  echo "Re-run with SCAN=50 to widen the search. Nothing was imported." >&2
  exit 2
fi

echo
echo "Importing index $FOUND as '$ACCOUNT' (you will be prompted for a keystore password)"
# Only now that the sweep has actually found the address is it safe to displace an existing entry.
keystore_force_move_aside
# -k so KEYSTORE_DIR is honoured here as it is on the private-key path; without it this wrote to
# the default directory while the guard checked another, which is the failure the -k comment above
# warns about.
cast wallet import "$ACCOUNT" ${KSARG[@]+"${KSARG[@]}"} --mnemonic "$MNF" --mnemonic-index "$FOUND" ${PASSARG[@]+"${PASSARG[@]}"} || exit 1

echo
# `cast wallet address` takes --keystore <FILE>; only `import` accepts -k <DIR>.
if [ -n "${KEYSTORE_DIR:-}" ]; then got="$(cast wallet address --keystore "$KSFILE")" || exit 1
else got="$(cast wallet address --account "$ACCOUNT")" || exit 1; fi
echo "keystore holds: $got"
if [ "$(printf '%s' "$got" | tr 'A-Z' 'a-z')" = "$want" ]; then
  echo "MATCHES the expected deployer. Proceed."
else
  echo "MISMATCH — expected $EXPECT. Do NOT deploy with this keystore." >&2; exit 3
fi
