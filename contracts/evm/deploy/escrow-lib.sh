#!/usr/bin/env bash
# Sourced by deploy.sh, funding-check.sh and run-all.sh. Not run directly.
#
# Escrow.reserve() delegatecalls EscrowReserveLib, an external library, so the Escrow initcode
# carries a link placeholder (`__$<hash>$__`) until it is given the library's address. That address
# is inside the escrow's initcode and therefore inside its CREATE2 address, which has two
# consequences every driver here has to respect:
#
#   1. The library is deployed through the same CREATE2 factory, with the same SALT, BEFORE the
#      escrow. Left to forge, `forge script` deploys the library itself, and with this tree's
#      always_use_create_2_factory it does so through the factory with salt 0: a deterministic address,
#      but not the SALT-derived one. The escrow is then linked to that library, lands at an address no
#      derivation made here produces, and nothing reverts.
#   2. Anything that hashes or measures the Escrow initcode must hash the LINKED one. The unlinked
#      bytecode is not hex (the placeholder is text), so `cast keccak` and `cast estimate` on it
#      either fail or silently answer for different bytes.
#
# derive_escrow_link needs the cwd to be the vendored EVM project and FACTORY and SALT to be set.
# It sets LIB_BC, LIB_H, WANT_LIB, LIB_SPEC (the `--libraries` argument) and ESC_BC (linked).
#
# A tree without src/EscrowReserveLib.sol is the v4 generation, whose escrow has no library (a v4
# redeploy comes from its SRC_SHA, see README). There WANT_LIB, LIB_SPEC and LIB_BC are empty and
# ESC_BC is the plain bytecode, and every caller skips its library step on an empty WANT_LIB.

# The address out of `cast create2`, whichever way this foundry version lays the line out (older
# versions print `Address: 0x..` then `Salt: 0x..`, newer ones `0x..<TAB>0x..`). Taking the last line
# returns the salt on one and both fields on the other.
create2_address() { # deployer salt init-code-hash
  cast create2 --deployer "$1" --salt "$2" --init-code-hash "$3" 2>/dev/null \
    | grep -oE '0x[0-9a-fA-F]{40}\b' | head -1
}

derive_escrow_link() {
  LIB_BC=""; LIB_H=""; WANT_LIB=""; LIB_SPEC=""
  if [ ! -f src/EscrowReserveLib.sol ]; then
    ESC_BC=$(forge inspect src/Escrow.sol:Escrow bytecode) || return 1
    return 0
  fi
  LIB_BC=$(forge inspect src/EscrowReserveLib.sol:EscrowReserveLib bytecode) || return 1
  case "$LIB_BC" in
    *'__$'*) echo "EscrowReserveLib has link placeholders of its own; this tooling links one library level." >&2; return 1 ;;
  esac
  LIB_H=$(cast keccak "$LIB_BC") || return 1
  WANT_LIB=$(create2_address "$FACTORY" "$SALT" "$LIB_H")
  [ -n "$WANT_LIB" ] || { echo "could not derive the EscrowReserveLib CREATE2 address" >&2; return 1; }
  LIB_SPEC="src/EscrowReserveLib.sol:EscrowReserveLib:$WANT_LIB"
  ESC_BC=$(forge inspect src/Escrow.sol:Escrow bytecode --libraries "$LIB_SPEC") || return 1
  case "$ESC_BC" in
    *'__$'*) echo "Escrow still has an unlinked placeholder after --libraries $LIB_SPEC" >&2; return 1 ;;
  esac
}
