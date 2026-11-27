#!/usr/bin/env bash

# Runtime entrypoint for the local Solana validator container.
#
# Every container start boots a fresh solana-test-validator, then runs the
# escrow's deploy-local.ts (deploy programs + init protocol + create mints +
# allowlist) and funds the test accounts, so the chain comes up ready for tests.

set -euo pipefail

ESCROW_DIR="/contracts/svm/source"
DOCKER_DIR="/contracts/svm/docker"
RPC_PORT="${RPC_PORT:-8899}"
RPC_URL="http://127.0.0.1:${RPC_PORT}"
LEDGER_DIR="/solana-ledger"

# shellcheck source=/dev/null
source "${DOCKER_DIR}/accounts.sh"

echo "[entrypoint] Starting solana-test-validator on :${RPC_PORT} ..."
# --reset: fresh ledger each boot. --bind-address 0.0.0.0 so the RPC is
# reachable from sibling compose services. Faucet enabled for airdrops.
solana-test-validator \
  --reset \
  --quiet \
  --ledger "${LEDGER_DIR}" \
  --rpc-port "${RPC_PORT}" \
  --bind-address 0.0.0.0 \
  &
VALIDATOR_PID=$!

# --- Wait for RPC to answer getHealth ("ok") ---
echo "[entrypoint] Waiting for RPC health ..."
healthy=false
for i in $(seq 1 60); do
  health=$(curl -s "${RPC_URL}" \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null || true)
  if echo "${health}" | grep -q '"result":"ok"'; then
    healthy=true
    echo "[entrypoint] RPC healthy."
    break
  fi
  if ! kill -0 "${VALIDATOR_PID}" 2>/dev/null; then
    echo "[entrypoint] Validator exited during startup." >&2
    exit 1
  fi
  sleep 1
done

# A timed-out loop ends the same way as a successful break, so without this guard
# the script would proceed to deploy against a live-but-not-ready validator and
# fail with a confusing downstream error. Abort here with a precise cause instead.
# This is the likely failure mode under CPU emulation, where startup is slower.
if [ "${healthy}" != "true" ]; then
  echo "[entrypoint] Validator alive but RPC never reported healthy within 60s; aborting." >&2
  exit 1
fi

# Point the Solana CLI at our local validator + the deploy payer keypair so any
# `solana ...` calls (deploy-local.ts shells out to the CLI) use the right wallet.
solana config set --url "${RPC_URL}" --keypair "${PAYER_KEYPAIR}" >/dev/null

# --- Run the canonical deploy/init/mints/allowlist script ---
# ANCHOR_WALLET = payer (deploy authority). The validator uses --reset, so this
# is always a fresh deploy. The mint-keypair env vars pin the mint addresses to
# the committed keypairs (honored by the build-time patch to deploy-local.ts).
echo "[entrypoint] Running deploy-local.ts (deploy + init + mints + allowlist) ..."
(
  cd "${ESCROW_DIR}"
  # Fund the deploy payer in a single large airdrop. The default funds in small
  # repeated chunks, but the test-validator faucet deduplicates identical airdrops
  # in the same blockhash window, so only the first lands and the balance stalls
  # below the amount needed to deploy the programs. One big airdrop avoids that.
  ANCHOR_WALLET="${PAYER_KEYPAIR}" \
  ANCHOR_PROVIDER_URL="${RPC_URL}" \
  SOLANA_RPC_URL="${RPC_URL}" \
  SOLANA_DEPLOY_AIRDROP_CHUNK_SOL=100 \
  LOCAL_USDC_MINT_KEYPAIR="${USDC_MINT_KEYPAIR}" \
  LOCAL_USDT_MINT_KEYPAIR="${USDT_MINT_KEYPAIR}" \
  tsx scripts/deploy-local.ts
)

# --- Fund the test accounts: SOL airdrop + USDC/USDT ATAs + mintTo ---
echo "[entrypoint] Funding test accounts (SOL + USDC/USDT) ..."
for kp in "${FUNDED_KEYPAIRS[@]}"; do
  pubkey=$(solana address --keypair "${kp}")
  solana airdrop 100 "${pubkey}" --url "${RPC_URL}" >/dev/null
  echo "[entrypoint]   airdropped 100 SOL -> ${pubkey}"
  # Create the ATA (owner = pubkey) and mint a working balance. --fund-recipient
  # creates the recipient ATA if missing; mint authority is the payer wallet.
  for mint in "${LOCAL_USDC_MINT}" "${LOCAL_USDT_MINT}"; do
    spl-token create-account "${mint}" --owner "${pubkey}" \
      --fee-payer "${PAYER_KEYPAIR}" --url "${RPC_URL}" >/dev/null 2>&1 || true
    spl-token mint "${mint}" 1000000 \
      --recipient-owner "${pubkey}" \
      --mint-authority "${PAYER_KEYPAIR}" \
      --fee-payer "${PAYER_KEYPAIR}" \
      --url "${RPC_URL}" >/dev/null
  done
  echo "[entrypoint]   minted 1,000,000 USDC + USDT -> ${pubkey}"
done

# --- Publish deployment addresses over HTTP (EVM /deploymentAddresses analogue) ---
echo "[entrypoint] Publishing deployment addresses over HTTP :80 ..."
mkdir -p /var/www
# deploy-local.ts wrote deployment-addresses.json under the escrow repo root.
cp "${ESCROW_DIR}/deployment-addresses.json" /var/www/deployment-addresses.json
busybox httpd -p 80 -h /var/www
echo "[entrypoint] httpd serving /deployment-addresses.json"

echo "[entrypoint] Local Solana environment ready."

# Keep the container alive on the validator process.
wait "${VALIDATOR_PID}"
