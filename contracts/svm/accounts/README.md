# Local-only Solana keypairs — intentionally public

**These private keys are committed on purpose. They are not sensitive and they are
not a leak.** They were freshly generated for this repository and are used
exclusively by the local `solana-test-validator` container. They have never held
funds or authority on devnet, testnet, or mainnet, and they must never be used
outside the local development cluster.

This is the Solana equivalent of the well-known Anvil/Hardhat development
accounts (`0xf39F…` etc.) already committed in our docker-compose files for the
EVM forks: publicly-known keys whose entire universe is a disposable local chain.

## Why private keys must be committed (public keys are not enough)

1. **On Solana, addresses *are* public keys.** A program's ID is the public key
   of its deploy keypair, and an SPL token's address is the public key of its
   mint account keypair. The rest of the stack (payment-gw config,
   veri-fill chain config, docker-compose, the e2e framework) hardcodes
   these addresses — so every developer machine and CI run must deploy to the
   *same* addresses, which requires deploying with the *same* keypairs.
2. **The validator is stateless.** Every container start is a fresh chain with
   empty genesis. Programs are re-deployed and mints re-created at boot, and
   deploying/creating requires *signing* — which requires the private half.
3. **Tests and services sign transactions.** The settler signs bids and
   settlement transactions; the e2e sender signs deposits. Signing is impossible
   with only a public key.

Generating fresh keys per boot would avoid committing them, but then every
hardcoded address above would need runtime discovery — significant complexity
for zero security benefit, since the keys control nothing of value anywhere.

## Why these keys pose no threat

- A private key is only sensitive because of *what it controls on a specific
  network*. These keys control accounts inside a throwaway local validator: the
  SOL they hold is minted by the container's own faucet, and the tokens they
  manage exist only inside the container. Everything they control is destroyed
  with the container.
- On every public cluster these addresses are empty accounts with no authority.
  Atum's devnet/testnet/mainnet deployments use entirely different,
  properly-managed keys; no environment outside local dev references these
  addresses.
- Someone could deploy a program or create a token at these addresses on a
  public cluster — that artifact would have no connection to Atum and no effect
  on anything we run.

## The one rule

**Never fund or reuse these keys on a real network.** Because the keys are
public, anything sent to these addresses on a public cluster is immediately
claimable by anyone. The risk is not leakage — the keys are already public by
design — it is accidental reuse. Keep them confined to the local cluster.

## Key inventory

| File | Role |
| ---- | ---- |
| `escrow.json` | escrow program ID (deploy keypair; matches the local `declare_id!`) |
| `escrow_v5.json` | v5 escrow program ID, deployed beside v4 (deploy keypair) |
| `fulfillment_proxy.json` | fulfillment_proxy program ID (deploy keypair) |
| `mock_transfer_hook.json` | mock_transfer_hook program ID (test-only program, off the payment path) |
| `usdc-mint.json` / `usdt-mint.json` | local USDC / USDT mint account keypairs (fix the token addresses) |
| `payer.json` | deploy/setup payer; funded by the local faucet at boot |
| `settler.json` | local settler agent signing key (prefunded at boot) |
| `sender.json` | e2e test sender (prefunded at boot) |
| `reserver.json` / `releaser.json` | quote-selector / fulfillment-verifier signing keys for the local flow |

The exact public keys for each file, and how they are derived and wired into the
rest of the stack, are documented in [`../README.md`](../README.md).

File format: each JSON file is the standard Solana CLI keypair format — a
64-byte array holding the 32-byte ed25519 seed followed by the 32-byte public
key.
