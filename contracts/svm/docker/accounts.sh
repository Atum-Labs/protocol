#!/usr/bin/env bash

# Central source of truth for the local Solana validator's committed identities.
# These are THROWAWAY localnet keypairs (Hardhat-keys philosophy) committed under
# accounts/. They are NOT the canonical devnet/testnet/mainnet program IDs
# (44DjKbs.../77AqGeSh...); local builds run `anchor keys sync` against these
# keypairs so the program binaries carry these local declare_id!s instead.
#
# Static config across the repo (payment-gw, veri-fill, settler env,
# token registry) is repointed to these values; e2e tests fetch them at runtime
# from the address endpoint this container serves over HTTP.

# --- Keypair file locations (inside the image) ---
KEYPAIR_DIR="/contracts/svm/accounts"

ESCROW_KEYPAIR="${KEYPAIR_DIR}/escrow.json"
ESCROW_V5_KEYPAIR="${KEYPAIR_DIR}/escrow_v5.json"
FULFILLMENT_PROXY_KEYPAIR="${KEYPAIR_DIR}/fulfillment_proxy.json"
MOCK_TRANSFER_HOOK_KEYPAIR="${KEYPAIR_DIR}/mock_transfer_hook.json"
PAYER_KEYPAIR="${KEYPAIR_DIR}/payer.json"
SENDER_KEYPAIR="${KEYPAIR_DIR}/sender.json"
SETTLER_KEYPAIR="${KEYPAIR_DIR}/settler.json"
RESERVER_KEYPAIR="${KEYPAIR_DIR}/reserver.json"
RELEASER_KEYPAIR="${KEYPAIR_DIR}/releaser.json"
RECIPIENT_KEYPAIR="${KEYPAIR_DIR}/recipient.json"
USDC_MINT_KEYPAIR="${KEYPAIR_DIR}/usdc-mint.json"
USDT_MINT_KEYPAIR="${KEYPAIR_DIR}/usdt-mint.json"

# --- Program IDs (local declare_id!s; set by `anchor keys sync` to match the
#     keypairs above) ---
LOCAL_ESCROW_PROGRAM_ID="CFKUVjrHDt1cXXzHMTCbHj5NxFZjtCqxxTc2k61gry7R"
# v5 escrow (signs readable text) beside v4, built from the current source and
# sharing the v4 fulfillment proxy.
LOCAL_ESCROW_V5_PROGRAM_ID="AtBJCoGvJynVf4pk3XtAnn1WbyhiW7eZCtA24FCzrUqF"
LOCAL_FULFILLMENT_PROXY_PROGRAM_ID="FLNuCtE9w1qsyr2wjDSf1BCy7KCR6pvnVYht2KaY2dAn"
LOCAL_MOCK_TRANSFER_HOOK_PROGRAM_ID="FHUH8QAmdnMTnggSeuXc1T1tAh8CSsxS31WvKb77h4jE"

# --- Account pubkeys ---
# payer        = Anchor wallet / deploy authority (also the mint + ATA authority,
#                and the protocol_config treasurer that collects mint fees on
#                release/refund). Must NOT double as a test recipient.
# sender       = test originator (deposits on Solana-origin tests)
# settler      = settler signer (fronts liquidity on Solana-destination tests)
# reserver     = payment-gw signer (DERIVED from PRIVATE_KEY_SOLANA_LOCALNET, payment-gw)
# releaser     = veri-fill signer  (DERIVED from PRIVATE_KEY_SOLANA_LOCALNET, veri-fill)
# recipient    = test recipient on Solana-destination tests. Separate from payer
#                so fees collected by the treasurer do not leak into the balance
#                delta the test framework measures against the recipient ATA.
PAYER_PUBKEY="22TT1dPcRQkEEBx7Pj1ZDgS5wJHWp5Ln94opkWBKobjw"
SENDER_PUBKEY="DPkNrAdtKVsYmsieheeodrhxBaNk2tV4XkH31XXZ3ZmC"
SETTLER_PUBKEY="8rFdrAvxQotqMUjsXfU7iN36zU2ScZGR7wSzipyLSUCQ"
RESERVER_PUBKEY="2qiX6MT2C1zdVmT8nZcaK5vaarbM78fjshysphoMKpSL"
RELEASER_PUBKEY="E4iiepyXadkf3o9Sh2mesnrGGrB4Y4H3ekP5TjF1eEYN"
RECIPIENT_PUBKEY="7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4"

# --- Token mints (deterministic via committed keypairs + the build patch) ---
LOCAL_USDC_MINT="A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo"
LOCAL_USDT_MINT="Ayk9cDDaw2QdnCkTpSB9txfnp7R7LjvcsYXuWPPdPgGw"

# Accounts that must be funded with SOL + token ATAs at startup.
FUNDED_ACCOUNTS=(
    "$SENDER_PUBKEY"
    "$SETTLER_PUBKEY"
    "$RESERVER_PUBKEY"
    "$RELEASER_PUBKEY"
    "$RECIPIENT_PUBKEY"
)

FUNDED_KEYPAIRS=(
    "$SENDER_KEYPAIR"
    "$SETTLER_KEYPAIR"
    "$RESERVER_KEYPAIR"
    "$RELEASER_KEYPAIR"
    "$RECIPIENT_KEYPAIR"
)
