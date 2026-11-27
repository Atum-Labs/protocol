#!/usr/bin/env bash

# Test accounts (EOAs) for the local Anvil stack.
#
# Only one private key lives here, and it is an Anvil default (published in
# `anvil --help`). The test accounts below are addresses only. The local stack
# funds them with anvil_setBalance and acts for TEST_ACCOUNT through
# anvil_impersonateAccount (see seed-custom-tokens.sh), so no key is needed to
# deploy from it. TEST_ACCOUNT's nonce-0 and nonce-1 CREATE addresses are the
# TUSDC and TUSDT token addresses pinned across the devnet configs; that is why
# the address is fixed and why it must never be funded or used on a public
# chain. Its former private key was, and was retired under CORE-2499.
#
# Do not add private keys to this file. Anything committed here is public.

# Use the second Anvil account as the protocol deployer (has ETH for gas)
PROTOCOL_DEPLOYER_PRIVATE_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

# Primary test account, and the impersonated deployer of TUSDC / TUSDT
# (deterministic addresses at nonce 0 and 1). Address only; no key.
TEST_ACCOUNT="0xF0D07a1c182Bc68a757C641014e0bAE7C4f17640"

# Additional clean test accounts
TEST_ACCOUNT_2="0xd3ff9644Da7f7a0Ac8E77f395736203b473446F7"
TEST_ACCOUNT_2_PRIVATE_KEY="0x56e0cb477097ef6f9bfe54986904e520763f73518c891d866b31487f0d097a47"

TEST_ACCOUNT_3="0x5826064F7E2f839d5B7e23f915fbcaACBC1bc654"
TEST_ACCOUNT_3_PRIVATE_KEY="0xc4bbf4035c5b0eb93d12935b2ab5491a7a8430ebb8029190279116c3b1865cc2"

TEST_ACCOUNT_4="0x27050ee47befc43f4df7807a7aa8073039e5fa89"

# All 10 default Anvil accounts for testing
ANVIL_ACCOUNTS=(
    "$TEST_ACCOUNT"  # Use fresh test account as first account
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
    "0x90F79bf6EB2c4f870365E785982E1f101E93b906"
    "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"
    "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"
    "0x976EA74026E726554dB657fA54763abd0C3a0aa9"
    "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955"
    "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f"
    "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720"
)

# All clean test accounts (clean EOAs)
CLEAN_TEST_ACCOUNTS=(
    "$TEST_ACCOUNT"
    "$TEST_ACCOUNT_2"
    "$TEST_ACCOUNT_3"
    "$TEST_ACCOUNT_4"
)
