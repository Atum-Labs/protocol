#!/usr/bin/env bash

# Docker HEALTHCHECK for the local Solana validator container. Verifies:
#   1. RPC answers getHealth = "ok"
#   2. the escrow program account exists and is executable (deployed)
#   3. the escrow ProtocolConfig PDA exists (initialize_protocol ran)
#   4. busybox httpd serves the deployment addresses

set -euo pipefail

DOCKER_DIR="/contracts/svm/docker"
ESCROW_DIR="/contracts/svm/source"
RPC_PORT="${RPC_PORT:-8899}"
RPC_URL="http://127.0.0.1:${RPC_PORT}"

# shellcheck source=/dev/null
source "${DOCKER_DIR}/accounts.sh"

# 1. RPC health
health=$(curl -s "${RPC_URL}" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null || true)
if ! echo "${health}" | grep -q '"result":"ok"'; then
  echo "unhealthy: RPC getHealth != ok"
  exit 1
fi

# 2. escrow program account is deployed + executable
prog=$(solana account "${LOCAL_ESCROW_PROGRAM_ID}" --url "${RPC_URL}" --output json 2>/dev/null || true)
if ! echo "${prog}" | grep -q '"executable": true'; then
  echo "unhealthy: escrow program ${LOCAL_ESCROW_PROGRAM_ID} not deployed/executable"
  exit 1
fi

# 3. ProtocolConfig PDA exists. The PDA = findProgramAddress(["protocol_config"],
#    escrow_program_id); deriving it needs the curve check, so use web3.js (present
#    in the escrow node_modules at runtime).
protocol_config=$(cd "${ESCROW_DIR}" && node -e '
const { PublicKey } = require("@solana/web3.js");
const [pda] = PublicKey.findProgramAddressSync(
  [Buffer.from("protocol_config")],
  new PublicKey(process.argv[1])
);
console.log(pda.toBase58());
' "${LOCAL_ESCROW_PROGRAM_ID}" 2>/dev/null || true)
if [ -z "${protocol_config}" ]; then
  echo "unhealthy: could not derive ProtocolConfig PDA"
  exit 1
fi
pda_acct=$(solana account "${protocol_config}" --url "${RPC_URL}" --output json 2>/dev/null || true)
if ! echo "${pda_acct}" | grep -q '"lamports"'; then
  echo "unhealthy: ProtocolConfig PDA ${protocol_config} missing (initialize_protocol not run)"
  exit 1
fi

# 4. httpd serves deployment addresses
if ! curl -fs "http://localhost:80/deployment-addresses.json" >/dev/null 2>&1; then
  echo "unhealthy: httpd not serving deployment-addresses.json"
  exit 1
fi

echo "healthy: RPC ok, escrow deployed, ProtocolConfig present, addresses served"
exit 0
