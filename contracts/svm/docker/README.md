# Local Solana Validator Image (`contracts/svm/docker/`)

Dockerized `solana-test-validator` with the Atum escrow programs deployed and test
accounts/tokens pre-funded. This is the Solana analogue of the EVM Anvil-fork
containers under `contracts/evm/docker/`: the same "run the contract repo's own
deploy script to produce a ready-to-use local chain" pattern, adapted to Solana.

## What it does

**Build (builder stage):** compiles the three programs from `contracts/svm/source`
at the protocol commit `ESCROW_V4_REF` (the v4 escrow, raw hash signing), and the
escrow alone from the current `contracts/svm/source` (v5, readable text signing),
with the toolchain the source pins (Anchor 0.32.1 / Solana 2.3.0, per
`Anchor.toml`), after running `anchor keys sync` against our committed
**throwaway localnet program keypairs** so the `.so` binaries carry **local**
`declare_id!`s (we do not hold the canonical program keypairs). The build fails
if the v4 IDL differs from
`bindings/typescript/escrow-encoding/idl-history/v4/escrow.json` other than in the
program id.

`ESCROW_V4_REF` is fetched from GitHub. While the repository is private, pass a
token, or hand the stage a local copy of that commit:

```bash
GIT_AUTH_TOKEN=<token> docker build --secret id=GIT_AUTH_TOKEN,env=GIT_AUTH_TOKEN ...
git archive 8b6c17901ffd855eb84ed5ed1d2e24a9c7b5ac62 contracts/svm/source | tar -x -C /tmp/escrow-v4
docker build --build-context escrow-v4-source=/tmp/escrow-v4 ...
```

**Run:** boots a fresh validator, then runs the escrow's
`scripts/deploy-local.ts` each start — deploy programs → `initialize_protocol`
(`cluster_id="localnet"`, signature-domain v5) → create USDC/USDT mints →
allowlist them. Then `deploy-escrow-v5.ts` deploys the v5 escrow at its own id
beside v4, initializes its `ProtocolConfig` the same way, allowlists the same
mints and adds `programs.escrowV5` to `deployment-addresses.json`. v5 shares the
v4 fulfillment proxy. Then it airdrops SOL and mints USDC/USDT to the test accounts, and
serves `deployment-addresses.json` over HTTP on port 80.

## Ports

| Port | Purpose                                        |
| ---- | ---------------------------------------------- |
| 8899 | JSON-RPC (`SOLANA_RPC_URL=http://solana:8899`) |
| 8900 | PubSub / WebSocket                             |
| 80   | HTTP serving `deployment-addresses.json`       |

## Committed accounts (`../accounts/`)

Throwaway localnet keypairs (Hardhat-keys philosophy) — **never** used outside
local dev. A Solana keypair JSON is a 64-byte array = 32-byte ed25519 seed ‖
32-byte public key.

| File                              | Pubkey                                         | Role                                                 |
| --------------------------------- | ---------------------------------------------- | ---------------------------------------------------- |
| `escrow.json`             | `CFKUVjrHDt1cXXzHMTCbHj5NxFZjtCqxxTc2k61gry7R` | escrow program ID (local `declare_id!`)              |
| `escrow_v5.json`          | `AtBJCoGvJynVf4pk3XtAnn1WbyhiW7eZCtA24FCzrUqF` | v5 escrow program ID (readable text signing)         |
| `fulfillment_proxy.json`  | `FLNuCtE9w1qsyr2wjDSf1BCy7KCR6pvnVYht2KaY2dAn` | fulfillment_proxy program ID                         |
| `mock_transfer_hook.json` | `FHUH8QAmdnMTnggSeuXc1T1tAh8CSsxS31WvKb77h4jE` | mock_transfer_hook program ID (off the payment path) |
| `payer.json`                      | `22TT1dPcRQkEEBx7Pj1ZDgS5wJHWp5Ln94opkWBKobjw` | deploy authority + mint/ATA authority                |
| `sender.json`                     | `DPkNrAdtKVsYmsieheeodrhxBaNk2tV4XkH31XXZ3ZmC` | test originator (deposits on Solana-origin)          |
| `settler.json`                    | `8rFdrAvxQotqMUjsXfU7iN36zU2ScZGR7wSzipyLSUCQ` | settler signer (fronts liquidity)                    |
| `reserver.json`                   | `2qiX6MT2C1zdVmT8nZcaK5vaarbM78fjshysphoMKpSL` | payment-gw signer — **derived** (see below)          |
| `releaser.json`                   | `E4iiepyXadkf3o9Sh2mesnrGGrB4Y4H3ekP5TjF1eEYN` | veri-fill signer — **derived** (see below)           |
| `usdc-mint.json`                  | `A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo` | deterministic local USDC mint                        |
| `usdt-mint.json`                  | `Ayk9cDDaw2QdnCkTpSB9txfnp7R7LjvcsYXuWPPdPgGw` | deterministic local USDT mint                        |

**Reserver / releaser are derived, not random.** Their seeds are the existing hex
secrets in `docker-compose.dev.yml`:

- reserver seed = `0x341ee66f…` (`docker-compose.dev.yml:99`, payment-gw `PRIVATE_KEY_SOLANA_LOCALNET`)
- releaser seed = `0xbb641c49…` (`docker-compose.dev.yml:108`, veri-fill `PRIVATE_KEY_SOLANA_LOCALNET`)

So the on-chain pubkeys match what payment-gw (reserve) and veri-fill (release)
sign with. (payment-gw/veri-fill take the key as **hex**; the validator/settler
use the keypair-JSON / base58 form — same underlying ed25519 key.)

`accounts.sh` is the single source of truth for all of the above (mirrors the EVM
`accounts.sh`).

## The deterministic-mint mechanism (build-time patch)

`createMint(...)` in `spl-token` takes an **optional 6th `keypair` arg**; when
omitted it generates a **random** mint address each run. Every Atum service
resolves the Solana USDC/USDT mint from **static config at startup**, so the local
mint address must be **deterministic**.

We pin it via `deploy-local-mint-keypair.patch`, applied at Docker build time. The
patch makes `deployMockTokens` read `LOCAL_USDC_MINT_KEYPAIR` /
`LOCAL_USDT_MINT_KEYPAIR` (paths to committed keypair JSONs) and pass them as the
6th `createMint` arg. When those env vars are unset the behavior is unchanged
(random mint), so **devnet/testnet deploys are untouched**.

## Verify (local)

```bash
# 1. Build (linux/amd64; cargo-build-sbf ~5-10 min the first time).
docker compose -f docker-compose.yml -f docker-compose.dev.yml build solana

# 2. Start it.
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d solana

# 3. Watch it become healthy.
docker inspect --format '{{.State.Health.Status}}' $(docker compose ps -q solana)
docker compose logs -f solana   # look for "Local Solana environment ready."

# 4. Program is deployed (loader-v4 — use `solana account`, not `program show`,
#    which only reads upgradeable-loader programs). Expect Owner: LoaderV4...,
#    Executable: true.
docker compose exec solana solana account \
  CFKUVjrHDt1cXXzHMTCbHj5NxFZjtCqxxTc2k61gry7R --url http://127.0.0.1:8899

# 5. ProtocolConfig PDA exists + addresses served.
docker compose exec solana /contracts/svm/docker/healthcheck.sh
curl http://localhost:8901/deployment-addresses.json   # if port 80->8901 mapped

# 6. A deposit succeeds against the local mint (run an escrow deposit test
#    against the container RPC, or the e2e Solana flow once the stack is wired).
```
