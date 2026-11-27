# shellcheck shell=bash
# Which chain ids belong to which network. Sourced by deploy.sh, run-all.sh and
# deploy-fulfillment-proxy.sh.
#
# NETWORK picks the env file, the deployer and the keystore, but it is a label the operator types.
# A chain id cannot be mislabelled, so every chain in CHAIN_TABLE must be in NETWORK's set: a
# mainnet chain pasted into testnet.env (or the reverse) is refused before anything is simulated
# or signed. Each driver also checks every RPC's live chain id against its CHAIN_TABLE entry, so
# the live chain is covered too. Add a chain here before adding it to an env file.
MAINNET_CHAIN_IDS="1 10 137 8453 42161 42220 43114 4217 5042"
TESTNET_CHAIN_IDS="11155111 11155420 80002 84532 421614 11142220 43113 42431 5042002"

# NETWORK must be set explicitly. A default would make a forgotten NETWORK=mainnet a testnet run.
require_network() {
  case "${NETWORK:-}" in
    testnet|mainnet) ;;
    "") echo "NETWORK is not set. Run with NETWORK=testnet or NETWORK=mainnet." >&2; exit 2 ;;
    *) echo "unknown NETWORK '$NETWORK' (expected testnet|mainnet)" >&2; exit 2 ;;
  esac
}

network_of_chain() { # <chain id> -> mainnet | testnet | unknown
  case " $MAINNET_CHAIN_IDS " in *" $1 "*) echo mainnet; return ;; esac
  case " $TESTNET_CHAIN_IDS " in *" $1 "*) echo testnet; return ;; esac
  echo unknown
}

# Refuse the whole run if any CHAIN_TABLE entry (cid|name|rpc) is not a $NETWORK chain.
require_chain_table_matches_network() {
  local line cid name net bad=0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    cid=$(printf '%s' "$line" | cut -d'|' -f1)
    name=$(printf '%s' "$line" | cut -d'|' -f2)
    net=$(network_of_chain "$cid")
    if [ "$net" != "$NETWORK" ]; then
      echo "REFUSING: CHAIN_TABLE lists $name ($cid), a $net chain, but NETWORK=$NETWORK." >&2
      bad=1
    fi
  done <<< "$CHAIN_TABLE"
  [ "$bad" -eq 0 ] || { echo "  Fix $NETWORK.env, or add the chain id to networks.sh." >&2; exit 2; }
}
