# Stellar (Soroban) deployment runbook

Tooling for deploying the Stellar contracts. Source: `contracts/stellar/source/scripts/` (TypeScript,
`@stellar/stellar-sdk` 17.3.0). Output: `contracts/stellar/deploy/deployments-<network>.json`, shaped like
`contracts/svm/deployments-v4.json` (a map keyed by network reference, here `stellar:testnet` /
`stellar:pubnet`, with `name`, `mainnet`, `contracts`, plus wasm hashes, role holders, tokens and TTL).

> ## Status
>
> Run end to end on **Stellar testnet (Protocol 30)** on 2026-11-10: both contracts deployed from the `stellar-wasm`
> CI artifact for commit `0b64dbf0`, the on-chain wasm hashes verified against that artifact's `hashes.txt`, and
> both flows of `smoke-deposit-release.ts` passed (deposit, release; deposit, refund). The deployment record is
> `deployments-testnet.json`. Not yet run on mainnet. Unit tests use an in-memory fake RPC; the local run and the
> testnet run are the real-chain evidence.
>
> The extra scenarios (`smoke-scenarios.ts`: over-cap deposit #75, expired delegate #73, pause #10, proxy
> `fulfill`, `strict_fulfill` with a replay #4 and a late deadline #3, `authorize_fulfillment`) were run on testnet
> on 2026-11-11 against a **separate deployment of the same wasm** (salt tag `scenarios-20261111`, escrow
> `CBQZLNAHCTFXASTCJ2XWYHJ6UXB45HLU37OY4SXUFPNQMSKJJ5BAXBT3`, proxy
> `CDRPDY75EYOP5GJTVXCAPFOBGSFNVEKJJ5DF5NH3VBG7J4GMXSZEVXJL`), not the deployment in
> `deployments-testnet.json`. That run was automated and did not use the recorded deployer's key, so it deployed
> its own copy; the recorded deployer holds every role too, so this is not a difference in roles. The testnet
> deploy extended the TTL of the code and instances (`ttl` in `deployments-testnet.json`), but `extend_deposit_ttl`
> and archival with ledgers advanced past the TTL have not been run on testnet.

## Still blocked

1. **The testnet deployment is a pre-audit build.** It was built with `soroban-sdk =30.0.0-rc.1` and an
   `escrow.wasm` that reproduces only on an x86_64 Linux build host (see "Reproducible build"), and the deployer
   key holds every role with a one-second admin delay. Mainnet moves to Protocol 30 only after its upgrade vote.
2. **Stellar CLI v30.0.1 is released** (2026-11-03). The CI lane and the testnet deployment used a build from
   `stellar-cli` commit `90a3d42`, which is three commits before v30.0.1 (a dependency bump, muxed contract address
   support in the CLI, and the version bump). Checked on 2026-11-10: v30.0.1 builds the same source to the same
   code. The only difference in either wasm is the embedded `cliver` string (38 of its 47 bytes differ), so the hashes differ
   (escrow `1e5e9060e081caf63010589e5cfaf098f9a46a56825dab1c9dbc05afc770dfca`, proxy
   `94f7c233858ea668eab4d2af19a8a191fa65180b77d045d35a19d4ac816c4e53`). The bump is not applied (protocol#356 is
   on hold), so the reference hashes and the deployed bytes stay equal through the audit.
3. **`soroban-sdk =30.0.0-rc.1` is a release candidate**, and the audit freezes on it. If stable 30.0.0 is
   published before the fix re-review, the change from rc.1 to stable is reviewed then. The wasm records the SDK
   version, so moving to stable changes the hashes: rebuild and redeploy (new `--salt-tag`) after.

The scripts never build: pass the compiled wasm (`--escrow-wasm`, `--proxy-wasm`).

## Reproducible build

The reference build is the `stellar-wasm` CI lane (`.github/workflows/ci.yml`), which runs on Linux. It builds
the wasm and publishes it with its sha256s as a workflow artifact named `stellar-wasm-<commit sha>` (`escrow.wasm`,
`fulfillment_proxy.wasm` and `hashes.txt`). It records the hashes and compares them with nothing, and it does not
gate merges. No reference hash is recorded in this README; the two hashes under "Still blocked" belong to the
held CLI v30.0.1 comparison, not to the reference build.

What is pinned: `contracts/stellar/source/rust-toolchain.toml` pins rustc `1.98.1` and the `wasm32v1-none` target
(rustup reads it automatically), and the build needs Stellar CLI `30.0.0` built from `stellar-cli` commit
`90a3d42d9327ccfaa0d301373766f45beae3e6d9`. The CI lane reads that commit from this paragraph, so this is the one
place it is recorded.

**Known gap: the build is not reproducible across platforms.** Built from the same source, `fulfillment_proxy.wasm`
had the same sha256 on every platform tried, and `escrow.wasm` did not. The CI diagnostic lanes on commit `0b64dbf0`
(run 42635138109) show that the CPU architecture is the variable, not the operating system: Linux arm64 and macOS
arm64 produce the same `escrow.wasm`, and the Linux x86_64 reference lane produces a different one. The unoptimized
escrow build differs the same way, so the difference arises when the code is compiled, not in the optimizer. Why
escrow compiles differently per architecture is not yet known. Only an x86_64 Linux build reproduces the CI artifact
(the one deployed to testnet), so **do not deploy from a laptop**, including an Apple silicon or arm64 Linux one.

### Deploy from the CI artifact

1. Take the artifact for the commit being deployed: the `stellar-wasm` run on the push to `main` for that commit
   (`gh run download <run-id> --repo Atum-Labs/protocol --name stellar-wasm-<commit sha>`, or the Actions UI). A
   pull request run builds a test merge of the PR and its base, not a commit on `main`. Artifacts are kept for 90
   days; after that, re-run the lane on the commit and use the new artifact.
2. In the download directory, `sha256sum -c hashes.txt` (macOS: `shasum -a 256 -c hashes.txt`) must pass.
3. Upload that wasm: pass the downloaded files to `deploy.ts` as `--escrow-wasm` and `--proxy-wasm`. Do not rebuild it.
4. Verify on chain that the wasm hash equals the sha256 in that artifact's `hashes.txt`:
   `stellar contract info hash --contract-id <id> --network <network>`, or fetch the code with
   `stellar contract fetch --id <id> --network <network> --out-file <file>` and hash the file.

Any source, dependency or toolchain change changes the hashes; there is nothing to update here when it does. To
build locally for development, run `cd contracts/stellar/source && stellar contract build`; that output is not
deployable.

## Local run (Protocol 30, localhost only)

```bash
# Local P30 network (quickstart image, core + RPC, Friendbot on 8000)
docker run -d --name stellar-local -p 8000:8000 stellar/quickstart:testing \
  --local --protocol-version 30 --enable core,rpc
# CLI v30: build stellar-cli at 90a3d42 (the reference build; v30.0.1 is released, see "Still blocked") and call it by full path, e.g. ~/.stellar-cli-30/bin/stellar
# Wasm: cd contracts/stellar/source && ~/.stellar-cli-30/bin/stellar contract build
```

Then, with throwaway keys exported as env vars (never printed, never reused outside the local network):

1. Fund each classic account with Friendbot (`curl "http://localhost:8000/friendbot?addr=G..."`). Raw
   ed25519 roles (delegate signer, reserver, releaser) need no account.
2. Issue a test asset from a throwaway issuer, add trustlines for depositor/settler/submitter, pay the
   depositor, and deploy its SEP-41 contract:
   `STELLAR_RPC_URL=http://localhost:8000/rpc STELLAR_NETWORK_PASSPHRASE="Standalone Network ; February 2017" STELLAR_ACCOUNT=$ISSUER_SECRET stellar contract asset deploy --asset TEST:G...`
3. `pnpm run stellar-deploy deploy --network local ... --token <SAC>:7:1000000 --dry-run`, then the same
   without `--dry-run`, then once more to see everything skipped except the TTL extension.
4. `pnpm run smoke --network local --escrow ... --token ... --settler G...` (release flow, then refund flow).
5. `pnpm run scenarios --network local --escrow ... --proxy ... --token ... --settler G...`: over-cap deposit
   (#75), expired delegate (#73), pause blocks deposit (#10) then unpause, proxy `fulfill`, `strict_fulfill`
   (replay #4, late #3), `authorize_fulfillment`. Needs `STELLAR_SMOKE_ADMIN_SECRET` (the deployer).

Verify: re-read `get_deposit_hash` (the smoke script does, and compares it with the TS encoder), check
balances, and compare `ttl.liveUntilLedgerSeq` in the deployments file. `--network local` defaults to
`http://localhost:8000/rpc` and refuses an RPC that reports another passphrase. Do not commit a deployments
file for a throwaway local network (`deploy/.gitignore` ignores `deployments-local*.json`; testnet and mainnet files stay trackable).

## What the scripts do

| Script | What |
|---|---|
| `deploy.ts deploy` | upload both wasms, create Escrow and FulfillmentProxy at deterministic addresses, run constructors, grant escrow roles, allow tokens and set fees, extend TTL of code and instances, write the deployments file |
| `deploy.ts extend-ttl` | the TTL keeper for code, instances (from the deployments file) and the escrow's balance entry in each allowlisted token, whose list it reads from the escrow (`get_allowed_tokens`, a simulated read) at every run, so a token allowed since the last `deploy` run is covered; run it at least once per 30 days |
| `smoke-deposit-release.ts` | `create_delegate` + SEP-41 `approve`, delegate-signed `deposit`, `release`; then a second deposit ending in `refund` (testnet/local only; run on local P30 and on testnet) |

Constructors: Escrow `(default_admin, admin_delay_secs)`; FulfillmentProxy `(default_admin, pauser,
delay_seconds)`. The escrow constructor sets only the default admin, so the script then calls `grant_role`
for `Pauser`, `Treasurer`, `TokenConfig`. `src/abi.test.ts` parses the Rust source and fails if any call's
argument names, order or types drift.

On testnet and local, all roles default to the deployer (on mainnet that is refused, see below). Every holder is a flag (`--admin`, `--pauser`, `--treasurer`,
`--token-config`, `--proxy-admin`, `--proxy-pauser`). If a holder other than the deployer must sign a step
(grants need the default admin; token config needs the `TokenConfig` holder), the script does not attempt it
and lists it under `pendingAdminSteps` in the deployments file.

Re-running is safe, and decisions come from chain state, not from flags: the deployments file records
constructor values (admin, delays, proxy pauser) as read back from the chain, each escrow role as
`{holder, granted}` from `has_role`, and `tokens` as every token the contract has allowed. Steps whose state
is already satisfied are skipped; steps that need a signer the deployer is not (for example `grant_role`
after the default admin was handed off) are kept in `pendingAdminSteps` without being simulated, and clear
on the next run once someone applies them. Omitted role flags reuse the holders recorded by the previous
run of the same deployer and `--salt-tag`. **After an admin handoff use `extend-ttl`** to keep code and
instance TTLs alive; a `deploy` re-run also does it but is not needed. `extend-ttl` takes the token list from the
escrow at each run, not from the deployments file, so no `deploy` re-run is needed after a token is allowed. It
logs how many tokens it found and which balance entries it extended, and warns when the escrow lists none (a
fresh deployment has none) because then no token balance entry is extended. If the read fails, the run fails
rather than use the file. A token the escrow no longer lists (`disallow_token`) but the file still records is
extended as well, since its in-flight deposits stay settleable; a `deploy` run drops it from the file, so keep
running `extend-ttl` before that, or extend its balance entry by hand while deposits remain. The 30 day cadence
still applies.

In particular: wasm already uploaded, an instance already at the deterministic address, a role already
held and a token already configured identically are skipped. An instance at that address running a
*different* wasm is refused; use a new `--salt-tag` for a new version. TTL extension runs every time.

## Prerequisites

- Node >= 22.12 and the repo's pnpm: `pnpm install` at the repo root (the package is a workspace member).
- Stellar CLI **v30** (the reference build is `90a3d42`; v30.0.1 is released and held, see "Still blocked") for `stellar contract build` and the verification commands.
- Compiled wasm: `cd contracts/stellar/source && stellar contract build`, then take
  `target/wasm32v1-none/release/{escrow,fulfillment_proxy}.wasm`.
- A deployer key in the macOS Keychain, never in a file or on argv:
  ```bash
  security add-generic-password -a "$USER" -s atum-stellar-testnet-deployer -w   # prompts; paste the S... secret
  ```
  The script reads it with `--keychain-item atum-stellar-testnet-deployer`, or from an exported env var
  (`--secret-env NAME`, default `STELLAR_DEPLOYER_SECRET`). `--secret` is rejected. Use a throwaway key per
  network; never reuse a testnet key on mainnet. Mainnet accepts only `--keychain-item`.
- Testnet only: fund the deployer with Friendbot yourself (`stellar keys fund <name> --network testnet`).
  The scripts never call Friendbot.
- RPC: testnet defaults to `https://soroban-testnet.stellar.org`. Mainnet has no default; pass `--rpc-url`.
  The RPC's reported passphrase must match `--network` or the run aborts.

## Steps (testnet)

```bash
cd contracts/stellar/source/scripts
W=../target/wasm32v1-none/release

# 1. Dry-run: build + simulate + print every transaction, submit nothing, write nothing
pnpm run stellar-deploy deploy --network testnet --keychain-item atum-stellar-testnet-deployer \
  --escrow-wasm $W/escrow.wasm --proxy-wasm $W/fulfillment_proxy.wasm \
  --token <C...>:7:1000000 --dry-run

# 2. Real run (same command without --dry-run)
# 3. TTL keeper: rerun well before `ttl.liveUntilLedgerSeq` in the deployments file (read the network max from the ledger)
pnpm run stellar-deploy extend-ttl --network testnet --keychain-item atum-stellar-testnet-deployer

# 4. Smoke (see the "Smoke" section; keys for five roles)
pnpm run smoke --network testnet --escrow <C...> --token <C...> --keychain-prefix atum-stellar-smoke-
```

`--dry-run` also works with only a public key (`--deployer-address G...`). In a dry run, steps that depend on an
earlier step that was only planned (for example `create` before `upload`) log that their simulation failure is
expected rather than aborting. `--token C...:decimals:feePct6[:min6[:max6]]` is repeatable;
`feePct6` 1_000_000 = 1%. The token's contract must already be deployed (an asset
contract is deployed with `stellar contract asset deploy`): the escrow refuses a token that does not answer
`decimals`, so a dry run against an undeployed asset contract fails with contract error 24. The mainnet flags are in the next section.

## Mainnet is refused unless two things agree

`--network mainnet` fails before any key is read or any socket opened unless **all** hold:
`--i-know-this-is-mainnet`; `--environment staging-mainnet|production-mainnet`; and that environment is listed
in the shell's `ATUM_STELLAR_MAINNET_ALLOWLIST` (comma-separated). The smoke script refuses mainnet outright.
Do not deploy to mainnet from this tooling before the P30 mainnet upgrade and an audit of the release build.

Mainnet is also refused, for `deploy`, when any of these holds (checked in `src/networks.ts`):

- The signing secret would come from an environment variable (`--secret-env`, or the default
  `STELLAR_DEPLOYER_SECRET` when no source is given). Refused before any key is read, for `extend-ttl` as well.
  Pass `--keychain-item`, or `--deployer-address` with `--dry-run`.
- Any of the six role holders resolves to the deployer: Escrow default admin, `Pauser`, `Treasurer`,
  `TokenConfig`, and the proxy admin and pauser. Pass all six flags with other addresses.
- `--admin-delay-secs` or `--proxy-delay-secs` is below 86400, one day (the testnet default is 1).

This closes the default of one environment-held key holding every role. It does not provide a hardware or
secure-store signer or a multisig hand-off: the Keychain item still holds an `S...` secret that the scripts sign
with in process, so the key custody for a mainnet run is open (see "What is NOT built").

## Verify on chain

```bash
# wasm hash on chain equals the sha256 in the CI artifact's hashes.txt (see "Reproducible build")
stellar contract info hash --contract-id <Escrow> --network testnet
# constructor state, read-only
stellar contract invoke --id <Escrow> --network testnet --source <any> --send=no -- default_admin
stellar contract invoke --id <FulfillmentProxy> --network testnet --source <any> --send=no -- pauser
stellar contract invoke --id <Escrow> --network testnet --source <any> --send=no -- get_token_config --token <C...>
```

Signature domain: every escrow digest commits to `sha256(network passphrase)` and the escrow's contract id;
`networkId` in the deployments file is the former. A redeploy changes the contract id, so signers must
reload it.

## Smoke

Times (`issued_at`, deadlines, delegate expiry) come from the latest ledger's close time, never the wall clock.

Needs a test token (SEP-41) allowed on the escrow, and one funded account per role. Secrets come from
`STELLAR_SMOKE_<ROLE>_SECRET` or Keychain items `<prefix><role>` for `depositor`, `delegate`, `reserver`,
`releaser`, `submitter`. The depositor must hold at least `2 x --amount` atoms; the settler (default: the
submitter) must exist. It cross-checks the on-chain `get_deposit_hash` against the TS encoder, so a mismatch
between `escrow-encoding` and the contract fails loudly. The unit tests use a model chain that verifies the
same digests with the same encoders; they do not prove the contract accepts the transactions.

## What is NOT built

- Multisig rotation of admin, pauser, token-config and treasurer, and the unsigned-XDR admin scripts.
  Until then the deployer holds every role; `begin_default_admin_transfer` is not scripted.
- Settler-allowlist cutover on the proxy (`add_authorized_settler`, `set_settler_allowlist_enforced`).
- Anything for mainnet beyond the guard (network flags, key source, roles off the deployer, admin delay) and the
  same code path. In particular no hardware or secure-store signer: the scripts sign only with an in-process
  `Keypair` read from the Keychain or, off mainnet, the environment.
- A build step, a wasm download, or Friendbot calls.
- Automatic restore of archived code/instance beyond what a simulation's restore preamble triggers.

## Open questions

- Testnet token: Circle's testnet USDC SAC address, or a Stellar Asset Contract for a test asset we issue?
- Mainnet RPC provider, and whether staging uses one endpoint for all runs.
- `--extend-to` default is `max entry TTL - 1`, read from the ledger. Answered for testnet: max entry TTL is 3110400 and
  the default 3110399 was accepted (`ttl.extendTo` in `deployments-testnet.json`). The bound itself, `max entry TTL`, was not exercised by this run.
- Deployments key: `stellar:testnet` / `stellar:pubnet` (CAIP-2 style) versus the passphrase hash; the
  off-chain gateway's token registry key for Stellar is not defined yet.
