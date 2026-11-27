#!/usr/bin/env bash
# Interactive mnemonic -> Tron private key, with derivation-path discovery.
#
#   ./import-deployer.sh --self-test            # prove the toolchain, no phrase needed
#   ./import-deployer.sh --private-key          # CHECK an existing key: print its address, write nothing
#   ./import-deployer.sh --private-key --write  # import it for real
#   ./import-deployer.sh --private-key --write --force  # ... replacing an existing key file
#   ./import-deployer.sh                        # scan only, write nothing
#   ./import-deployer.sh --write                # also write the key to a 0600 file
#   EXPECT=T... ./import-deployer.sh            # look for a different address
#   SCAN=25 ./import-deployer.sh                # widen the index search (default 10)
#   NETWORK=mainnet ./import-deployer.sh --write # target file/env for mainnet
#
# Needs only `cast` (foundry) and python3. No node, no tronweb, no network access —
# so it runs from anywhere, including a checkout with no node_modules installed.
#
# The mnemonic phrase itself is never echoed, never in shell history, and never a command-line
# argument (which would be visible in `ps`): it reaches `cast` only via --mnemonic-path, pointing
# at a 0600 temp file wiped on exit, including on Ctrl-C. That claim covers the phrase and
# nothing else. Four other values DO reach argv, because `cast` takes them only as arguments,
# and each is visible to `ps` for the life of its call:
#   1. The BIP39 passphrase, via PASSARG: once per scanned derivation path (39 of them at the
#      default SCAN=10) and again on the key-extracting write.
#   2. A pasted raw key, on the --private-key path. That derivation runs BEFORE the PK_WRITE
#      branch, so — unlike the EVM sibling, which derives from argv only on the dry check —
#      it happens on --private-key --write too, not just on the check.
#   3. The OUTGOING key, read back under --force to name the address about to be destroyed.
#   4. The just-written key, read back to confirm what landed on disk.
# Do not use those paths on a shared machine.
#
# (3) and (4) are documented here, not removed. Both could be dropped instead — deriving from
# the mnemonic file already in hand rather than reading the key back off disk — so a truthful
# description of this argv surface and a smaller argv surface are two different states. This
# script claims the first one only.
#
# This is deliberately a TVM-specific statement rather than a copy of the EVM sibling's narrower
# one. EVM can claim an argv-free import because `cast wallet import --interactive` prompts for
# the key; `cast wallet address` has no usable equivalent — its --interactive needs a real TTY,
# see the note on the --private-key path below — so TVM cannot make the same split.
#
# The SCAN never derives a private key at all — `cast wallet address` yields the Ethereum
# address directly, and a Tron address is the same 20 bytes under a different prefix and
# checksum. A private key is derived exactly once, for the single matching path, and only
# under --write.
#
# Why derivation goes through `cast` rather than tronweb: TronWeb.fromMnemonic guards its
# path argument with a m/44'/195' prefix match and throws "Invalid tron path provided" on
# anything else, so it cannot reach a coin-type-60 path — exactly the case when the seed was
# created in an EVM-first wallet and the Tron address is a re-encoding of an Ethereum-path
# key. `cast` takes an arbitrary --mnemonic-derivation-path.
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

: "${EXPECT:=}"   # no default: a hardcoded address is wrong for any deployer but one
: "${SCAN:=10}"
: "${NETWORK:=shasta}"

MODE="${1:-scan}"
case "$MODE" in --write|--self-test|--private-key) ;; scan|"") MODE=scan ;; *) echo "unknown arg: $MODE" >&2; exit 2 ;; esac
# --private-key is a DRY CHECK unless --write is also given, matching the rest of this tooling.
PK_WRITE=0; FORCE=0
for a in "$@"; do
  [ "$a" = --write ] && PK_WRITE=1
  [ "$a" = --force ] && FORCE=1
done

case "$NETWORK" in
  mainnet) ENVVAR=PRIVATE_KEY_MAINNET ;;
  shasta)  ENVVAR=PRIVATE_KEY_SHASTA ;;
  nile)    ENVVAR=PRIVATE_KEY_NILE ;;
  *) echo "unknown NETWORK '$NETWORK' (expected shasta|nile|mainnet)" >&2; exit 2 ;;
esac
# Default into the bootstrap layout ($ATUM_HOME/keys). A key already at the older
# ~/.atum-tron-<network> path still wins, so an existing setup keeps working untouched.
: "${ATUM_HOME:=$HOME/.atum}"
# deploy.sh reads EXPECT_DEPLOYER for the same purpose; accept either so one
# tvm.env field feeds both tools.
: "${EXPECT:=${EXPECT_DEPLOYER:-}}"
if [ -z "${OUTF:-}" ] && [ -f "$HOME/.atum-tron-$NETWORK" ]; then
  OUTF="$HOME/.atum-tron-$NETWORK"
else
  OUTF="${OUTF:-$ATUM_HOME/keys/tron-$NETWORK}"
fi
mkdir -p "$(dirname "$OUTF")" && chmod 700 "$(dirname "$OUTF")" 2>/dev/null || true

command -v cast    >/dev/null || { echo "cast not found — install foundry" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 not found" >&2; exit 1; }

# ETH hex address -> Tron base58check. A Tron address is keccak(pubkey)[12:] — the same 20
# bytes an Ethereum address is — prefixed with 0x41 and base58check'd with a double-sha256
# checksum. cast already did the keccak, so this is pure encoding.
PY='
import hashlib, sys
A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
raw = bytes.fromhex(sys.argv[1].lower().removeprefix("0x"))
if len(raw) != 20: sys.exit("expected a 20-byte address")
p = b"\x41" + raw
p += hashlib.sha256(hashlib.sha256(p).digest()).digest()[:4]
n = int.from_bytes(p, "big"); out = ""
while n: n, r = divmod(n, 58); out = A[r] + out
for b in p:
    if b: break
    out = "1" + out
print(out)'

tron_from_eth() { python3 -c "$PY" "$1" 2>/dev/null; }

MNF="$(mktemp "${TMPDIR:-/tmp}/.atum-tron-mn.XXXXXX")"
chmod 600 "$MNF"
cleanup() { command shred -u "$MNF" 2>/dev/null || rm -Pf "$MNF" 2>/dev/null || rm -f "$MNF"; }
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------- self-test
# Proves derivation and encoding on THIS machine against published vectors, using only
# public test material. No prompt, no user secret, nothing written.
if [ "$MODE" = --self-test ]; then
  rc=0
  # (1) Encoding alone, no BIP32: a fixed private key.
  #     trustwallet/wallet-core tests/common/CoinAddressDerivationTests.cpp
  E="$(cast wallet address --private-key 0x4646464646464646464646464646464646464646464646464646464646464646 2>/dev/null)"
  G="$(tron_from_eth "$E")"; W=TQLCsShbQNXMTVCjprY64qZmEA4rBarpQp
  [ "$G" = "$W" ] && printf '  ok   address encoding      %s\n' "$G" \
                  || { printf '  FAIL address encoding      got %s want %s\n' "$G" "$W"; rc=1; }

  # (2) Full BIP39 -> BIP32 -> Tron. Published as the Tron "test seed" by LedgerHQ/app-tron
  #     and KeystoneHQ/keystone3-firmware (rust/apps/tron/src/address.rs).
  printf 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about\n' > "$MNF"
  E="$(cast wallet address --mnemonic-path "$MNF" --mnemonic-derivation-path "m/44'/195'/0'/0/0" 2>/dev/null)"
  G="$(tron_from_eth "$E")"; W=TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH
  [ "$G" = "$W" ] && printf "  ok   m/44'/195'/0'/0/0     %s\n" "$G" \
                  || { printf "  FAIL m/44'/195'/0'/0/0     got %s want %s\n" "$G" "$W"; rc=1; }

  # (3) The BIP39 passphrase actually reaches the derivation. wallet-core
  #     swift/Tests/HDWalletTests.swift testDeriveTron — resolves ONLY with "TREZOR".
  printf 'ripple scissors kick mammal hire column oak again sun offer wealth tomorrow wagon turn fatal\n' > "$MNF"
  E="$(cast wallet address --mnemonic-path "$MNF" --mnemonic-derivation-path "m/44'/195'/0'/0/0" \
        --mnemonic-passphrase TREZOR 2>/dev/null)"
  G="$(tron_from_eth "$E")"; W=THJrqfbBhoB1vX97da6S6nXWkafCxpyCNB
  [ "$G" = "$W" ] && printf '  ok   passphrase honoured   %s\n' "$G" \
                  || { printf '  FAIL passphrase honoured   got %s want %s\n' "$G" "$W"; rc=1; }

  # (4) Optional independent cross-check, when a built source tree happens to be present.
  SRC="${SRC_DIR:-$HERE/../source}"
  if [ -d "$SRC/node_modules/tronweb" ]; then
    G="$(NODE_PATH="$SRC/node_modules" node -e '
      const { TronWeb } = require("tronweb");
      const a = TronWeb.fromMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
      process.stdout.write(a.address);' 2>/dev/null)"
    W=TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH
    [ "$G" = "$W" ] && printf '  ok   tronweb agrees        %s\n' "$G" \
                    || { printf '  FAIL tronweb disagrees     got %s want %s\n' "$G" "$W"; rc=1; }
  else
    printf '  --   tronweb cross-check   skipped (no node_modules; not required)\n'
  fi

  echo
  [ $rc -eq 0 ] && echo "PASS — derivation and encoding match the published vectors." \
                || echo "FAIL — do NOT trust this toolchain to find your key."
  exit "$rc"
fi

# ---------------------------------------------------------------- import an existing key
# A different deployer (a mainnet key, say) need not come from the same seed as the testnet one,
# so there is nothing to sweep: take the key directly. Same hygiene as the mnemonic path.
if [ "$MODE" = --private-key ]; then
  printf 'Enter the Tron private key, 64 hex chars, 0x optional (input hidden, then Enter): '
  IFS= read -rs SK; printf '\n'
  [ -z "$SK" ] && { echo "empty input; aborting" >&2; exit 1; }
  # Normalise and validate before anything touches disk. tronbox wants BARE hex, no 0x.
  SK="$(printf '%s' "$SK" | tr -d '[:space:]' | sed 's/^0[xX]//')"
  case "$SK" in
    *[!0-9a-fA-F]*) echo "not hex: the key contains non-hex characters" >&2; exit 1 ;;
  esac
  [ "${#SK}" -eq 64 ] || { echo "expected 64 hex chars, got ${#SK}" >&2; exit 1; }
  SK="$(printf '%s' "$SK" | tr 'A-F' 'a-f')"

  if [ "$PK_WRITE" = 1 ] && [ -e "$OUTF" ]; then
    if [ "$FORCE" = 0 ]; then
      echo "REFUSING: $OUTF already exists. Move or delete it first, so an existing deployer key is" >&2
      echo "never silently replaced." >&2
      echo "  To replace it deliberately: $0 --private-key --write --force" >&2
      exit 1
    fi
    # --force: name the outgoing address before destroying it, and shred rather than truncate.
    OLD_T="$(tron_from_eth "$(cast wallet address --private-key "0x$(cat "$OUTF")" 2>/dev/null)" 2>/dev/null || echo unreadable)"
    echo "--force: REPLACING the existing key at $OUTF"
    echo "         outgoing address: $OLD_T"
    command shred -u "$OUTF" 2>/dev/null || rm -Pf "$OUTF" 2>/dev/null || rm -f "$OUTF"
  fi

  # Derive the address BEFORE writing, so a bad key never leaves a file behind.
  #
  # The key reaches argv for this one short-lived local `cast` call — exposure (2) in the header
  # at the top of this file, and note it happens on --write as well as on the dry check.
  # Unavoidable GIVEN `cast`, not in principle: `cast wallet address --interactive` reads the key
  # without argv but REQUIRES a real TTY and dies with "Device not configured (os error 6)" on a
  # pipe, so it cannot be fed programmatically. Do not "fix" this by piping into --interactive;
  # it does not work. The alternative is to stop using `cast` here at all, as this PR's own
  # contracts/svm/deploy/import-deployer.sh:208-214 does: derive in python from a two-line 0600
  # file, so nothing but a file path is ever an argument. The --force read-back just above is
  # exposure (3); the mnemonic --write path below carries (1) and (4), as it has since it shipped.
  ETHADDR="$(cast wallet address --private-key "0x$SK" 2>/dev/null)" \
    || { echo "cast could not derive an address from that key" >&2; exit 1; }
  TADDR="$(tron_from_eth "$ETHADDR")"

  if [ -n "${EXPECT:-}" ] && [ "$TADDR" != "$EXPECT" ]; then
    echo "MISMATCH — EXPECT=$EXPECT but this key is $TADDR. NOTHING was written." >&2
    exit 3
  fi

  if [ "$PK_WRITE" = 0 ]; then
    echo
    echo "  tron address : $TADDR"
    echo "  eth  address : $ETHADDR   (same 20 bytes; Tron re-encodes them)"
    [ -n "${EXPECT:-}" ] && echo "  MATCHES EXPECT."
    echo
    echo "Nothing was written. To import it:"
    echo "  NETWORK=$NETWORK $0 --private-key --write"
    exit 0
  fi

  umask 077
  printf '%s' "$SK" > "$OUTF"
  chmod 600 "$OUTF"
  unset SK
  echo
  echo "Wrote the key (bare hex, no 0x — the form tronbox-config.js expects) to $OUTF, mode 0600."
  echo "  tron address : $TADDR"
  echo "  eth  address : $ETHADDR   (same 20 bytes; Tron re-encodes them)"
  [ -n "${EXPECT:-}" ] && echo "  MATCHES EXPECT." \
    || echo "  No EXPECT set, so nothing was cross-checked. Confirm the address above is the deployer you intend."
  echo
  echo "Use it with:"
  echo "  export $ENVVAR=\"\$(cat $OUTF)\""
  echo "  export ADMIN_PK=\"\$(cat $OUTF)\""
  exit 0
fi

# The mnemonic sweep has nothing to search FOR without a target address.
if [ -z "${EXPECT:-}" ]; then
  echo "EXPECT is not set, so there is no address to search the derivation paths for." >&2
  echo "  Sweeping a mnemonic:   EXPECT=T... $0" >&2
  echo "  Importing a raw key:   $0 --private-key" >&2
  exit 2
fi

# ---------------------------------------------------------------- scan
printf 'Enter mnemonic / seed phrase (input hidden, then Enter): '
IFS= read -rs MN; printf '\n'
[ -z "$MN" ] && { echo "empty input; aborting" >&2; exit 1; }

printf 'BIP39 passphrase (hidden, blank if none): '
IFS= read -rs PASS; printf '\n'

printf '%s\n' "$MN" > "$MNF"
unset MN
PASSARG=(); [ -n "${PASS:-}" ] && PASSARG=(--mnemonic-passphrase "$PASS")
unset PASS

# Candidate paths, most likely first. Tron's registered BIP44 coin type is 195 (SLIP-0044);
# the 60 block is there because a seed generated in an EVM-first wallet keeps its key on
# Ethereum's path even when the address is displayed as Tron.
PATHS=()
for i in $(seq 0 $((SCAN-1))); do PATHS+=("m/44'/195'/0'/0/$i"); done
for i in $(seq 1 $((SCAN-1))); do PATHS+=("m/44'/195'/$i'/0/0"); done   # i=0 repeats the line above
for i in $(seq 0 $((SCAN-1))); do PATHS+=("m/44'/195'/$i'"); done       # TIP-01 3-level "primary account"
for i in $(seq 0 $((SCAN-1))); do PATHS+=("m/44'/60'/0'/0/$i"); done

echo
echo "Scanning ${#PATHS[@]} derivation paths for $EXPECT"

FOUND_PATH=""
for p in "${PATHS[@]}"; do
  eth="$(cast wallet address --mnemonic-path "$MNF" --mnemonic-derivation-path "$p" \
          ${PASSARG[@]+"${PASSARG[@]}"} 2>/dev/null)" || continue
  [ -n "$eth" ] || continue
  a="$(tron_from_eth "$eth")"
  if [ "$a" = "$EXPECT" ]; then
    printf '  %-22s %s   <== MATCH\n' "$p" "$a"; FOUND_PATH="$p"
  else
    printf '  %-22s %s\n' "$p" "$a"
  fi
done

if [ -z "$FOUND_PATH" ]; then
  echo
  echo "No scanned path derives $EXPECT. NOTHING was written." >&2
  echo "Most likely causes, in order:" >&2
  echo "  1. Wrong or missing BIP39 passphrase. A wrong passphrase does not error — it" >&2
  echo "     silently derives a valid but DIFFERENT set of addresses, which is what you" >&2
  echo "     are looking at above." >&2
  echo "  2. The key is at a higher index. Re-run with SCAN=50." >&2
  echo "  3. A path outside the four families scanned. Check one directly:" >&2
  echo "       cast wallet address --mnemonic-path <file> --mnemonic-derivation-path \"m/44'/195'/0'/0/7\"" >&2
  echo "     then convert that 0x address with this script's encoder." >&2
  exit 2
fi

echo
echo "Found $EXPECT at $FOUND_PATH"

if [ "$MODE" != --write ]; then
  echo
  echo "Scan only — nothing written. To persist the key for tronbox:"
  echo "  ./import-deployer.sh --write"
  exit 0
fi

# ---------------------------------------------------------------- write
# The only point at which a private key exists.
umask 077
cast wallet private-key --mnemonic-path "$MNF" --mnemonic-derivation-path "$FOUND_PATH" \
  ${PASSARG[@]+"${PASSARG[@]}"} 2>/dev/null | tr -d '\n' | sed 's/^0x//' > "$OUTF"
chmod 600 "$OUTF"

# Confirm what landed on disk resolves to the expected account, without printing it.
CHECK="$(tron_from_eth "$(cast wallet address --private-key "0x$(cat "$OUTF")" 2>/dev/null)")"
if [ "$CHECK" != "$EXPECT" ]; then
  command shred -u "$OUTF" 2>/dev/null || rm -Pf "$OUTF" 2>/dev/null || rm -f "$OUTF"
  echo "Wrote a key resolving to '$CHECK', not $EXPECT. File deleted. Do NOT deploy." >&2
  exit 3
fi

echo "Wrote the key (bare hex, no 0x — the form tronbox-config.js expects) to $OUTF, mode 0600."
echo
echo "Load it for this shell only:"
echo "  export $ENVVAR=\"\$(cat $OUTF)\""
echo "  export ADMIN_PK=\"\$(cat $OUTF)\"    # Step 10 admin scripts; same key, the deployer IS the admin"
echo
echo "Delete the file when the deploy is done:"
echo "  shred -u $OUTF 2>/dev/null || rm -P $OUTF"
