# Pre-publication audit: secrets and publishable cleanliness (2026-09-16)

Ticket: CORE-2485. Scope: the `protocol` repository (`Atum-Labs/protocol`), working tree at
`e336b357` and the full reachable history behind it (991 commits across 147 refs: `main`, 144
remote branches, one tag), plus everything a visibility flip publishes alongside the tree: commit
messages, pull request bodies and review threads, retained Actions run logs, and the repository's
security alerts. This is the register that CORE-2445 executes against.

Every finding below carries exactly one disposition:

| Disposition                           | Meaning                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `rotated`                             | A live credential. Revoked or abandoned provider-side; the evidence is recorded in this file.              |
| `remove-before-flip`                  | Not a credential, but must not ship. Removed from the tree, edited on GitHub, or stripped by CORE-2445.    |
| `accepted-for-publication-by-geneAum` | Reviewed and accepted as publishable by Gene Aumson (GitHub `geneAum`).                                    |

Out of scope, per the ticket: selecting or applying the source-available license (CORE-2494 lands
Apache-2.0 separately), rewriting this repository's history (dispositions here; rewrite or accept on
CORE-2445), the settler-agent tree and history (CORE-2443), contract vulnerability findings
(CORE-2311), publishing Go modules (CORE-2403), removing keeper scripts (CORE-2374) and the legacy
webhook docs (CORE-2446).

## 1. Method

| Step                    | Tool / command                                                                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Working-tree scan       | `gitleaks detect --no-git --source . --config .gitleaks.toml` (gitleaks 8.30.1)                                                                                                                             |
| History scan            | `gitleaks detect --source . --log-opts="--all" --config .gitleaks.toml`                                                                                                                                     |
| Raw baseline            | Same two scans with the stock ruleset and no allowlist, to size the noise the policy suppresses                                                                                                             |
| Live-credential checks  | `eth_blockNumber` against the historical Alchemy key on three hosts; `cast balance` / `cast nonce` for every EVM key literal on 8 mainnets and 7 testnets; `getBalance` / `getSignaturesForAddress` for every committed Solana keypair on mainnet-beta and devnet; TronGrid account lookup on Tron mainnet, Shasta and Nile |
| Tree listing            | `git ls-files`, `.gitignore` review, `git log --all --name-only` for tool directories                                                                                                                       |
| Workflow review         | Every file under `.github/` read for `CORE-\d+`, `pull_request_target`, `secrets.*`                                                                                                                         |
| Message and PR sweep    | `git log --all` messages, and every PR body, issue comment, review and review-thread comment through the GraphQL API, grepped for `CORE-\d+`, internal hostnames, GCP, Slack, cluster and repository names |
| Actions log scan        | Every retained run's log via `gh run view --log` (and the REST log archive where that fails), grepped for provider token shapes, key material next to a key-ish word, basic-auth URLs and internal names   |
| Security alerts         | Dependabot, secret-scanning and advisory endpoints of the REST API                                                                                                                                          |
| License review          | Every `LICENSE` and every `package.json` `license` / `private` / `publishConfig.access` field                                                                                                              |
| Anonymous clone         | Fresh clone with an empty `HOME`, no npm, GitHub or cloud credentials; `pnpm install --frozen-lockfile && pnpm -r build && pnpm -r test`                                                                    |

The stock gitleaks ruleset has no detector for Alchemy app keys, 32-byte hex keys assigned to a
key-ish variable, or Solana keypair files. It reported 165 (tree) and 411 (history) findings, all of
them 20-byte EVM addresses, Solana mints and genesis hashes, Anvil default accounts, hashes and
generated enum literals; it did report the one real key in `accounts.sh` (as `generic-api-key`,
since retired) but not the Alchemy key in section 3. `.gitleaks.toml` adds five rules (Alchemy URL
keys, 32-byte keys next to a key-ish name, 32-byte values assigned to any name, Solana keypair
arrays, Solana secret keys) and allowlists the material in section 4.4. Under that policy the
working-tree scan reports nothing: the one real key, `accounts.sh` `TEST_ACCOUNT_PRIVATE_KEY`, was
removed under CORE-2499 (section 3.1). The history scan still sees it in the commit that added the
line, and the push-to-main job walks all of main's history, so that one commit is excused by
commit-qualified fingerprint in `.gitleaksignore`; both scans run at zero and CI enforces that
(section 6).

## 2. Result summary

| Acceptance criterion                                                          | Result                                                                                                                                 |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Working tree scans clean                                                      | PASS: 0 findings. The one real key, `contracts/evm/docker/accounts.sh` `TEST_ACCOUNT_PRIVATE_KEY`, was removed under CORE-2499 (section 3.1). `.gitleaksignore` holds only the commit-qualified fingerprints of the historical commit, which do not apply to the tree |
| Every history finding recorded with SHA, path, type, provider                 | PASS: section 3                                                                                                                        |
| Provider-side revocation timestamp per historical credential                  | PASS as a bound: the Alchemy app is deactivated and the key was already inactive when first probed, 2026-09-16 11:37 UTC. Alchemy exposes no deactivation instant, so that observation is the timestamp of record (CORE-2498); section 5 |
| Actions run logs scanned, every match listed with a disposition               | Section 8                                                                                                                              |
| `.github/workflows/`: every `CORE-\d+`, `pull_request_target`, `secrets.*`    | Section 6                                                                                                                              |
| Commit messages and PR bodies: `CORE-\d+`, hostnames, GCP, Slack, clusters    | Section 7                                                                                                                              |
| Dependabot, secret-scanning alerts, advisories reviewed                       | Section 9                                                                                                                              |
| No `.wolf/` or `.claude/` committed, both gitignored                          | PASS: neither ever committed on any ref; both ignored. `.cursor/` was committed on one unmerged branch and is now ignored too (section 4.3) |
| `LICENSE` / `license` / `publishConfig.access` contradiction stated           | Section 10: a flip contradicts three proprietary licenses and `restricted` access today; CORE-2494 resolves the license side           |
| Anonymous `pnpm install && pnpm -r build && pnpm -r test` succeeds            | PASS: section 11                                                                                                                       |
| Every finding carries one disposition                                         | Every row below                                                                                                                        |
| Register for CORE-2445                                                        | Section 12                                                                                                                             |
| History carries every `remove-before-flip` item; mechanism stated             | Section 12.3: fresh-root publication with the listed replace-text and path filters, executed by CORE-2445 / CORE-2487                  |

## 3. Credentials found in history

Values are deliberately not reproduced here. Each row is locatable from the commit and path.

| #   | Credential type            | Provider | Introduced                              | Path at introduction                                        | Also at                                                               | Removed                 | Disposition |
| --- | -------------------------- | -------- | --------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------- | ----------- |
| 1   | Alchemy app key (32 chars) | Alchemy  | `1575c173` (2026-07-08, contract import) | `contracts/evm/repo/test/fork/*.json` (28 files, `rpc_url`) | `00abb8ff` rename to `contracts/evm/source/test/fork/*.json`; `1d11a479` (the squash on `main`) | `5386f88a` (2026-07-10), PR #6 `f76c38d2` | `rotated`   |

The same key was used for 14 Alchemy hosts (Ethereum, Arbitrum, Base, Avalanche, Celo, Optimism,
Polygon and Tron mainnets and testnets). HEAD carries `YOUR_API_KEY` in every fork config; CI
substitutes `ALCHEMY_API_KEY` at run time. Only `1d11a479` is reachable from `main`; `1575c173` and
`00abb8ff` sit on the import branch. All three are pinned in `.gitleaks.toml` so the history scan
stays at zero once section 3.1 closes.

### 3.1 Test signing keys committed as fixtures

`contracts/evm/docker/accounts.sh` (introduced at `1575c173`) declared four EVM private keys for
the local Anvil stack until CORE-2499 removed one; three remain. Verified on 2026-09-16 and again
on 2026-09-17 on Ethereum, Arbitrum, Base,
Optimism, Polygon, Avalanche, Celo and BSC mainnets and on Sepolia, Arbitrum Sepolia, Base Sepolia,
Optimism Sepolia, Avalanche Fuji, Celo Sepolia and Polygon Amoy:

| Variable                        | Derived address                              | Balance / activity                                                                                                                                    | Disposition                                    |
| ------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `PROTOCOL_DEPLOYER_PRIVATE_KEY` | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | Anvil default account 1, published in `anvil --help`                                                                                                  | `accepted-for-publication-by-geneAum`          |
| `TEST_ACCOUNT_PRIVATE_KEY`      | `0xF0D07a1c182Bc68a757C641014e0bAE7C4f17640` | 0 on every mainnet. Funded and used on Sepolia (0.05 ETH, nonce 1), Arbitrum Sepolia (0.099 ETH, nonce 503), Base Sepolia (nonce 6), Celo Sepolia (2.98 CELO, nonce 23) | `rotated` (CORE-2499)                          |
| `TEST_ACCOUNT_2_PRIVATE_KEY`    | `0xd3ff9644Da7f7a0Ac8E77f395736203b473446F7` | 0 balance, nonce 0 everywhere                                                                                                                         | `accepted-for-publication-by-geneAum`          |
| `TEST_ACCOUNT_3_PRIVATE_KEY`    | `0x5826064F7E2f839d5B7e23f915fbcaACBC1bc654` | 0 balance, nonce 0 everywhere                                                                                                                         | `accepted-for-publication-by-geneAum`          |

`TEST_ACCOUNT_PRIVATE_KEY` was funded from faucets and used on four public testnets, which
CORE-2499 defines as leaked. CORE-2499 removed the key from `accounts.sh` and, in the same change,
deleted the bare fingerprints that were hiding it; `.gitleaksignore` now excuses only the historical
commit, by commit-qualified fingerprint (section 6.1). The address stays: the account deploys the local stack's
TUSDC and TUSDT tokens at nonce 0 and 1, and those derived addresses are pinned in 35 files in
`atum-core`, 20 files here, one settler-agent test and one atum-docs example. Rather than move
them, `seed-custom-tokens.sh` now acts for the address through `anvil_impersonateAccount`, so the
repo holds no key for it and the pinned addresses are unchanged. The testnet balances (below) are
abandoned; they were never on a mainnet. `atum-core` still carries the old key in its own copy of
`accounts.sh` and as the e2e payer signer in seven more files; that rotation is atum-core work and
does not gate the protocol flip. The address is quoted as an
example in `schemas/apis/wallet-orch/v1/openapi.yaml`, `schemas/apis/x402/v1/payload/example.json`
and `payment-gateway-client/src/cli/entrypoints.test.ts`; those uses are public identifiers and
stay.

Other key literals in the tree, verified the same day:

| Material                                                          | Where                                                                                                                            | Result                                                                                | Disposition                           |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------- |
| Eleven Solana keypairs (64-byte JSON arrays)                      | `contracts/svm/accounts/*.json`; identical bytes at `contracts/svm/docker/keypairs/*.json` in `1575c173`                         | Every derived public key: 0 lamports, 0 signatures on mainnet-beta and devnet         | `accepted-for-publication-by-geneAum` |
| Tron regression key (address starting with byte `0x41`)           | `payment-gateway-client/src/signers/raw.test.ts:200`                                                                             | Address `TFvbhehcSYEqkFNaNSMQD26Pt7zvENqghF` has no account on Tron mainnet, Shasta or Nile | `accepted-for-publication-by-geneAum` |
| web3.js documentation example key                                 | `payment-gateway-client-go/sender_auth_test.go` at `e3b1bf9c` (branch `core-997-signing-helpers`, not on `main`)                 | Publicly documented key; address `0x2c7536E3605D9C16a7a3D7b1898e529396a65c23`, 0 balance | `accepted-for-publication-by-geneAum` |
| Anvil default accounts 0-2                                        | Solidity tests, deploy scripts, SDK tests, conformance fixture generators                                                        | Published in `anvil --help`                                                           | `accepted-for-publication-by-geneAum` |
| All-zeros, all-ones, repeated-`0x46` keys                         | `ci.yml` TronBox dummy, `contracts/tvm/docker/README.md`, `contracts/tvm/deploy/import-deployer.sh` (wallet-core test vector)     | Not keys                                                                              | `accepted-for-publication-by-geneAum` |

The Solana keypair public keys, for the record: `CFKUVjrHDt1cXXzHMTCbHj5NxFZjtCqxxTc2k61gry7R`
(escrow), `FLNuCtE9w1qsyr2wjDSf1BCy7KCR6pvnVYht2KaY2dAn` (fulfillment_proxy),
`FHUH8QAmdnMTnggSeuXc1T1tAh8CSsxS31WvKb77h4jE` (mock_transfer_hook),
`22TT1dPcRQkEEBx7Pj1ZDgS5wJHWp5Ln94opkWBKobjw` (payer), `7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4`
(recipient), `E4iiepyXadkf3o9Sh2mesnrGGrB4Y4H3ekP5TjF1eEYN` (releaser),
`2qiX6MT2C1zdVmT8nZcaK5vaarbM78fjshysphoMKpSL` (reserver), `DPkNrAdtKVsYmsieheeodrhxBaNk2tV4XkH31XXZ3ZmC`
(sender), `8rFdrAvxQotqMUjsXfU7iN36zU2ScZGR7wSzipyLSUCQ` (settler),
`A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo` (usdc-mint), `Ayk9cDDaw2QdnCkTpSB9txfnp7R7LjvcsYXuWPPdPgGw`
(usdt-mint). `contracts/svm/docker/accounts.sh` documents them as throwaway localnet identities.

### 3.2 Other history findings, all placeholders or public identifiers

| Path                                                                           | Commit(s)  | What                                                                            | Disposition                           |
| ------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------- | ------------------------------------- |
| `schemas/apis/settler-gateway/settler-gateway-registration/v1/openapi.yaml`   | `1fe1d615` | Two `sk_live_abcd1234...`-style OpenAPI examples in a spec deleted since        | `accepted-for-publication-by-geneAum` |
| `schemas/apis/wallet-orch/v1/openapi.yaml`, its `schemas.gen.ts`               | HEAD       | `sk_test_abcdef123456` OpenAPI example                                          | `accepted-for-publication-by-geneAum` |
| `contracts/evm/deploy/deploy.sh`                                               | HEAD       | Three keccak256 role identifiers                                                | `accepted-for-publication-by-geneAum` |
| `contracts/svm/deploy/readiness.sh`                                            | HEAD       | Mainnet and devnet program authority and payer public keys                      | `accepted-for-publication-by-geneAum` |
| Fork configs, encoding examples, SDK tests, OpenAPI specs                      | many       | Token contract addresses, Solana mints and genesis hashes, Tron addresses, `did:key` values | `accepted-for-publication-by-geneAum` |

A provider-shape sweep over every added line in history (Infura, QuickNode, Helius, Datadog, Slack,
GitHub, AWS, GCP, npm, JWT, Stripe, basic-auth URLs) found nothing beyond the rows above.

## 4. Working tree

### 4.1 Config surfaces

| Surface                                          | Credential-shaped values                                                         | Result |
| ------------------------------------------------ | -------------------------------------------------------------------------------- | ------ |
| `contracts/evm/source/.env.example`              | `YOUR_API_KEY` Alchemy placeholders                                              | PASS   |
| `contracts/evm/source/test/fork/*.json`          | `rpc_url` is `YOUR_API_KEY` in all 28 files                                      | PASS   |
| `payment-gateway-client/.env.example`            | Public gateway hosts; no key values                                              | PASS   |
| `contracts/evm/docker/accounts.sh`               | Three keys, all Anvil defaults or unfunded; see section 3.1                     | PASS   |
| `contracts/svm/accounts/*.json`                  | Eleven localnet keypairs; see section 3.1                                        | PASS   |
| `.github/workflows/*.yml`                        | Only `${{ secrets.* }}` references and an all-zeros TronBox dummy                | PASS   |

### 4.2 Docs, READMEs, AGENTS.md and scripts

| Path                                                                        | Finding                                                                                                          | Disposition                                   |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `key-management/providers/turnkey/typescript/scripts/create-sub-organization.ts:17` | A usage example with a named employee's first name and work email                                       | `remove-before-flip` (CORE-2445)              |
| `*/AGENTS.md` (three SDK packages)                                          | Agent guidance for the published SDKs; names no internal system, host, channel or person                        | `accepted-for-publication-by-geneAum`         |
| `mppx-atum-escrow/LICENSE`, `x402-atum-escrow/LICENSE`, `x402-atum-escrow/README.md` | `legal@atumlabs.xyz` contact address in the proprietary license text                                    | `accepted-for-publication-by-geneAum` (replaced anyway by CORE-2494) |
| 107 lines under `atum.xyz` and 259 lines in 122 files under `atum.network`, across specs, SDKs, tests and READMEs | `docs.atum.xyz`, `schemas.atum.xyz`, `payment-gw.production-{testnet,mainnet}.atum.xyz`, `auth.production-*.atum.xyz`, `veri-fill.production-testnet.atum.xyz`; `schemas.atum.network` (149 lines, the most frequent host in the repo), `solver.atum.network`, `verifier.atum.network`, `issuer.atum.network`, `devnet.atum.network` as JSON-LD context, `did:web` and example hosts | `accepted-for-publication-by-geneAum`: public product endpoints and published schema hosts |
| `schemas/apis/x402/v1/payload/example.json:76`, `:84`, `:96`                  | `did:web:issuer.dev.atum.network` and `did:web:dev.atum.network`: dev-environment names in a published example payload | `remove-before-flip`: replace with the production `did:web` hosts or an `example.com` DID |
| `.github/PULL_REQUEST_TEMPLATE/licensed-package-release.md`                 | Names npm trusted publishing and a Legal sign-off step; no internal tool or host                                  | `accepted-for-publication-by-geneAum`         |
| `contracts/evm/deploy/README.md` (4 lines), `contracts/svm/deploy/README.md` (4), `contracts/tvm/deploy/README.md` (6), `contracts/tvm/deploy/deploy.sh` (4), `contracts/tvm/deploy/deploy-permissioned.js` (2), `contracts/evm/deploy/{mainnet,testnet}.env` (1 each) | `gcloud secrets ... --project atum-core` invocations: the GCP project id and the Secret Manager names `tron_api_key`, `mainnet_tron_rpc_url`, `${NET}_solana_rpc_url`, `${NETWORK}_tron_rpc_url`, `testnet_tempo_rpc_url`, plus the `config-gen ... --fetch-secrets` recipes that read them | `remove-before-flip`: team decision of 2026-09-17, an integrator does not need them and they describe Atum's infrastructure; not accepted |
| `contracts/evm/deploy/README.md:1093`, `contracts/tvm/deploy/README.md:1034` | The GKE overlay path `deploy/apps/envs/production-testnet-gke/overlays/payment-gw/file-config.yaml` and its Flux behaviour ("to prod in ~5 min, `prune: true`, no approval") | `remove-before-flip`                          |
| `contracts/svm/deploy/README.md:1540-1544`, `:1566`, `:1572`                 | `terraform/environments/{production,staging}-mainnet/settler-agent.tf`, `deploy/apps/envs/**`, and `settler-agents/prod/packages/...` file paths from a private repository | `remove-before-flip`                          |
| `contracts/{evm,svm,tvm}/deploy/README.md` (3752 lines together)             | Operator runbooks for real-chain deployment. Team decision of 2026-09-17: protocol keeps "how you deploy these contracts" (forge, CREATE2, public RPCs, `YOUR_API_KEY`, `.env.example`); "how Atum fetches deploy secrets and runs its environments" (config-gen, project id, Secret Manager names, environment cutover, GKE, Flux, terraform) moves to `atum-core`, the way the SVM runbook already splits (2 `gcloud` lines against 15 in EVM and 11 in TVM) | `remove-before-flip` for the operator half (section 12.1); `accepted-for-publication-by-geneAum` for the deploy-the-contracts half |

Outside the deploy runbooks, no `README.md`, `docs/` file or script names a GCP project, a cluster,
a Kubernetes namespace or a Slack channel; every other "cluster" in the tree is a Solana cluster.
The first version of this report missed the runbook rows because its name sweep looked for
hostnames and service-account shapes but not for `--project` or `gcloud secrets`.

### 4.3 Tool directories

`.wolf/` and `.claude/` have never been committed on any ref (checked with `git log --all
--name-only`); the ticket's "known" line predates this check. Both are in `.gitignore`, together
with `CLAUDE.md`. The check was then widened from those two names to every tool directory:

| Path                                            | Where                                                                                    | Disposition                                                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `.cursor/environment.json`, `.cursor/install.sh` | `dab86da4` (2026-08-12) on `origin/cursor/setup-dev-environment-0480`, not on `main`      | `accepted-for-publication-by-geneAum`: a 73-line toolchain bootstrap with no names or credentials |
| `.cursor/` in `.gitignore`                      | Added by this change, next to `.wolf/` and `.claude/`, so the directory cannot come back  | n/a                                                                                                    |

Three `AGENTS.md` files are tracked on purpose (section 4.2).

### 4.4 Allowlisted test material

`.gitleaks.toml` allowlists by value, not by test path: every fixture key and public identifier is
listed literally (the Solana keypairs by the first six bytes of each array), so a real key pasted
into a test file, or a new keypair dropped into `contracts/svm/accounts/`, is still reported. The
only path exemptions are git submodules (third-party code held as gitlinks) and the generated
`*.gen.ts` and `schema.json` files, anchored to the directories the generators write to
(`payment-gateway-client/src/generated/`, `schemas/apis/*/v*/bindings/typescript/src/`,
`schemas/{apis,declarations}/**/schema.json`), so a file with the same suffix anywhere else is
scanned. Every row below matches something in the tree or in history; adding to the allowlist
requires adding a row here.

| Material                                                     | Where                                                                                       | Why it is not a secret                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Anvil / Hardhat accounts 0, 1 and 2                          | Solidity tests, `deploy-local.ts`, SDK tests, fixture generators, `accounts.sh`             | Published in `anvil --help`; the repo uses no other Anvil account                   |
| `accounts.sh` `TEST_ACCOUNT_2`, `TEST_ACCOUNT_3` keys        | `contracts/evm/docker/accounts.sh`                                                          | Unfunded, unused on every chain checked (section 3.1)                              |
| Tron regression key                                          | `payment-gateway-client/src/signers/raw.test.ts`                                            | No account on Tron mainnet or testnets                                             |
| web3.js documentation key                                    | `payment-gateway-client-go/sender_auth_test.go` (history, one branch)                       | Publicly documented example                                                         |
| Eleven Solana keypairs                                       | `contracts/svm/accounts/`, `contracts/svm/docker/keypairs/` (history)                       | Localnet identities; 0 lamports, 0 signatures on mainnet-beta and devnet           |
| All-zeros, all-ones, `0..01`, repeated-`0x46` keys           | `ci.yml`, `tvm-contracts.yml`, `contracts/tvm/docker/README.md`, `import-deployer.sh`       | Placeholders                                                                        |
| 20-byte EVM addresses, Tron base58 addresses                 | Everywhere                                                                                  | Public identifiers, matched by shape                                                |
| Solana mints, genesis hashes, program authorities, payer     | Specs, SDK tests, `readiness.sh`, `solana-clock.ts`                                         | Public identifiers, matched by value                                                |
| Two Solana transaction signatures                            | `schemas/apis/veri-fill/v1/conformance/*.json`                                              | Same base58 length as a secret key; public on-chain identifiers                     |
| Six Solana transaction signatures, v4 lookup table address   | `contracts/svm/bindings/typescript/escrow-encoding/testdata/*.json` (CORE-2291)                 | Mainnet transactions committed as test fixtures, each file carrying its own signature; the lookup table is public in `deployments-v4.json` and trips `generic-api-key` only as the value of `accountKey` |
| Two XLM Stellar Asset Contract addresses and their 32-byte contract ids | `contracts/stellar/conformance/vectors.json`, `regenerate_vectors.py` | Public contract addresses used as strkey decode vectors; matched by value; they trip `generic-api-key` as the value of `strkey` / `key` |
| `did:key:z6Mk...`                                            | JSON-LD signing tests                                                                       | Ed25519 public key                                                                  |
| Three keccak256 role identifiers                             | `contracts/evm/deploy/deploy.sh`                                                            | Public constants                                                                    |
| `sk_test_...`, `sk_live_abcd...` OpenAPI examples            | `wallet-orch` spec (HEAD), settler-gateway registration spec (history)                      | Placeholders                                                                        |
| `EVM_PERMIT2_ESCROW`, `feePercentage6Decimals`               | Generated Go bindings, `ONCHAIN_SPEC.md`                                                    | Enum and field names                                                                |
| Deterministic P-256 test keypair                             | `key-management/providers/turnkey/typescript/src/{stamp,client}.test.ts`                    | Documented as generated for the stamper tests and used nowhere else; the paired org id is a fixture UUID and the HTTP layer is mocked; absent from every other Atum repository |
| 32-byte values under hash-like or test-vector names          | Solidity, Go, Rust and TS tests, OpenAPI examples, `Cargo.lock`, deploy scripts (439 distinct values) | Cleared by the assigned NAME, not by value. Long tokens (`hash`, `digest`, `checksum`, `example`, `anchor`, ...) may appear anywhere in the name; short tokens (`id`, `pid`, `tx`, `sig`, `root`, `node`, `leaf`, `slot`, `mint`, `order`, `topic`, `salt`, `proof`, `nonce`) must be a whole snake_case or camelCase segment, so `validatorSeed`, `bridgeOperator`, `liquiditySource` and `roleValue` are reported while `tx_id`, `PaymentID` and `DEPOSITED_TOPIC0` are cleared. `role` is not a token: the three keccak role ids are allowlisted by value instead. The list carries no `(?i)`: gitleaks joins a rule's allowlist regexes into one alternation and a case flag on one leaks into all that follow, which would turn the segment anchoring back into substring matching. A key under a key-ish name is still caught by `evm-private-key-literal` |
| Zero-padded small integers, repeated-byte fillers, curve order | Foundry `vm.sign` toy keys, encoding tests, `Escrow.handler.t.sol`                          | Not keys                                                                            |

## 5. Revocation evidence

Baseline, deliberately invalid key against `eth-mainnet.g.alchemy.com`, 2026-09-16 11:36 UTC:

```
{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"Must be authenticated!"}}
HTTP_STATUS:401
```

Key 1 (section 3), the same day at 11:37 UTC, on `eth-mainnet`, `arb-mainnet` and `base-mainnet`:

```
{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"App is inactive. Please create a new app or contact support at https://dashboard.alchemy.com/support"}}
HTTP_STATUS:403
```

The owning Alchemy app has been deactivated, so the key no longer authenticates. Alchemy's error
does not carry the deactivation time, and neither does the dashboard: a deactivated app drops off
the app list and no deactivation instant is shown for it, so there is no value to read back.
Nor can this repository name the app. No app id, account or dashboard reference was ever
committed on any ref; the only handle on it is the key itself, in the 28 fork fixtures at
`1575c173`, and one key served all 13 Alchemy hosts, so it is a single app. An exact instant
would have to come from Alchemy support.

CORE-2498 therefore closes on the probe evidence, and what the probes establish is an upper bound:
the key was already inactive at the first observation and has stayed that way. That bound is the
timestamp of record for this criterion.

| Key | Revoked at (UTC)                     | Revoked by                           | Post-revocation capture                                     |
| --- | ------------------------------------ | ------------------------------------ | ------------------------------------------------------------- |
| 1   | At or before 2026-09-16 11:37        | Not recoverable from this repository | Above (403, inactive); re-probed 403 at 2026-09-17 13:38:59 on `eth-mainnet` and `base-mainnet`, with the same 401 control |

Probe command, run from a checkout that still has the import branch:

```sh
git grep -hoE 'https://[a-z0-9-]+\.g\.alchemy\.com/v2/[A-Za-z0-9_-]{16,}' 1575c173 -- 'contracts/evm/repo/test/fork/*.json' \
  | sort -u | head -3 \
  | while read -r url; do
      curl -s -w '\nHTTP_STATUS:%{http_code}\n' -X POST "$url" \
        -H 'content-type: application/json' \
        -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
        | sed -E 's#/v2/[A-Za-z0-9_-]+#/v2/<redacted>#'
    done
```

`TEST_ACCOUNT_PRIVATE_KEY` (section 3.1) is a testnet faucet account, not a provider credential.
There is nothing to revoke provider-side; the key was removed from the repo and the address is
now impersonated by the local stack. Balances re-read on 2026-09-17.

| Key                        | Rotated in                 | Rotated by        | Old-address balances abandoned                                                                        |
| -------------------------- | -------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------- |
| `TEST_ACCOUNT_PRIVATE_KEY` | CORE-2499 (this change)    | Federico Gimenez  | Sepolia 0.0500 ETH (nonce 1); Arbitrum Sepolia 0.0995 ETH (nonce 503); Base Sepolia 0.0003 ETH (nonce 6); Celo Sepolia 2.978 CELO (nonce 23); 0 on every mainnet |

## 6. CI enforcement and workflow review

### 6.1 The `secret-scan` job

The `secret-scan` job in `.github/workflows/ci.yml` installs gitleaks 8.30.1 (checksum pinned) and
runs the working-tree scan on every event, plus one history scan whose range depends on the event.
It is a dependency of `ci-gate`, so it gates merges as soon as that check is required.

| Event            | History range                  | Why                                                                                                                                                                          |
| ---------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pull_request`   | `origin/<base>..HEAD`          | Only the commits the PR adds. The checkout also holds every other branch, so `--all` would let a stale WIP branch fail every open PR with no fix available to the PR author. |
| `push` to `main` | `HEAD` (all of main's history) | Merges reach main only through PRs, so this can only surface something that predates the job.                                                                                |

This deviates from the ticket's literal `--log-opts="--all"` for the same reason the settler-agent
audit did: the `--all` run over every ref is the audit itself (section 1) and can be repeated
locally at any time; the CI job is the regression gate, and a gate that unrelated branches can trip
is not enforceable. Verified locally on 2026-09-16 on a throwaway branch: a `${VAR:-0x...}` private
key default appended to a docker script, a 64-hex key constant appended to a `*.test.ts` file, and a
random Alchemy URL in a tracked file were all reported by the tree scan; the PR-range scan reported
exactly the planted commit's findings and nothing from `main`. On 2026-09-17 the same random key
under neutral names (`export FOO="0x..."` in a shell script, `deployer: 0x...` in YAML, `const k =
"..."` in TypeScript) was reported by `hex-64-assigned`; the same value assigned to `ROOT_HASH` was
not, which is the rule's documented residual risk. After the name allowlist moved to whole-segment
matching, a probe of eighteen names confirmed `validatorSeed`, `bridgeOperator`, `liquiditySource`,
`roleValue`, `FOO` and `deployer` are reported and `tx_id`, `depositId`, `PaymentID`,
`DEPOSITED_TOPIC0`, `ROOT_HASH`, `txAnchor` are cleared. One caveat worth knowing: the stock
gitleaks allowlist suppresses sequential placeholder values (an `AbCdEf...012345` key is ignored),
so gate tests must use random-looking values.

Known findings are tracked, not allowlisted. Until CORE-2499, `.gitleaksignore` listed the three
fingerprints of the `accounts.sh` key from section 3.1 in the bare `<path>:<rule>:<line>` form. That
form is what gitleaks calls the global fingerprint, and it is tested in both modes: it covered one
path, rule and line only, so the same value pasted elsewhere was still reported, but any other value
landing on that line was invisible in the tree as well. CORE-2499 removed the key and deleted the
file, which closed the blind spot and, because the same entries had been suppressing the history
finding too, turned the push-to-main scan red on the commit that added the line.

The file is back with the three entries rewritten as `<commit>:<path>:<rule>:<line>`, pinned to
`1d11a479`. A commit-qualified fingerprint never equals a tree finding's fingerprint, so the tree
keeps no blind spot: verified on 2026-09-17 by pasting the retired key back onto `accounts.sh:11`
with the file in place, which the tree scan reported on all three rules. A key reappearing in
`accounts.sh` is still a finding. Only entries in the commit-qualified form belong in this file, and
it says so.

### 6.2 Workflow contents

| Item                                     | Where                                                                                                        | Disposition                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `CORE-1863`                              | `ci.yml:84`, `ci.yml:408`, `ci.yml:485` (comments)                                                           | `remove-before-flip` (CORE-2445)                                                                              |
| `CORE-2022`, `CORE-2120`                 | `ci.yml:413`, `ci.yml:489` (comments)                                                                        | `remove-before-flip` (CORE-2445)                                                                              |
| `CORE-1866`                              | `ci.yml:535` (comment)                                                                                       | `remove-before-flip` (CORE-2445)                                                                              |
| `CORE-997`                               | `.github/scripts/go-install.sh:8` (comment)                                                                  | `remove-before-flip` (CORE-2445)                                                                              |
| `pull_request_target`                    | none                                                                                                         | PASS                                                                                                          |
| `secrets.ETH_MAINNET_RPC`                | `ci.yml:446`, in a `pull_request`-triggered job, with a public-RPC fallback when the secret is absent         | `accepted-for-publication-by-geneAum`: a fork PR gets no secret and the step still passes on the fallback     |
| `secrets.GITHUB_TOKEN`                   | The three `publish-*.yml` workflows, `workflow_dispatch` only                                                | `accepted-for-publication-by-geneAum`: the ephemeral job token, not a repository secret                        |

The line numbers are those of `main` at `e336b357`; the `secret-scan` job is inserted before
`ci-gate`, after them.

## 7. Commit messages, pull requests and author identities

| Item                                                        | Count                                                                                       | Disposition                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Commit subjects carrying `CORE-\d+`                         | 145 of 991 (53 more carry a key only in the body; 62 distinct keys)                         | `accepted-for-publication-by-geneAum`                                                |
| Tracked files carrying `CORE-\d+` in comments               | 121 files outside this audit: 91 under `contracts/`, 19 under `schemas/`, 5 under `key-management/`, 2 in `.github/`, 2 in `payment-gateway-client/src`, the two lint configs | `accepted-for-publication-by-geneAum`, same reasoning as commit messages, with two exceptions: the `.github/` lines, which CORE-2445's acceptance criteria require gone (section 6.2), and the 4 lines in `payment-gateway-client/src` (`chain-adapters/types.ts:13`, `:16`, `index.ts:696`, `:697`), which ship inside a published npm package whose own `AGENTS.md` rules out code-review references: `remove-before-flip`. `docs/signing.md:185` joined them after this snapshot, in `5ef8ebec`; `docs/**` ships as well (section 12.1) |
| Commit messages naming GCP                                  | A few deploy-tooling commits describe fetching RPC secrets with `gcloud`; none names a project id, secret name or host | `accepted-for-publication-by-geneAum`                                     |
| Commit messages naming a Slack channel, cluster or hostname | none (every "cluster" is a Solana cluster; every hostname is a public product host)         | PASS                                                                                 |
| Author identities at `@atumlabs.xyz`                        | 5 addresses, 151 commits; the rest are GitHub `noreply` addresses, one personal address, one `cursoragent@cursor.com` | `accepted-for-publication-by-geneAum`                                     |
| PR bodies carrying `CORE-\d+`                               | 59 of 136 PRs (10 more only in comments or reviews)                                          | `accepted-for-publication-by-geneAum`                                                |
| PR bodies or threads naming private repositories            | `atum-core` in 62 PRs, `settler-agent` in 31, `credit-cooperative` in 2                      | `accepted-for-publication-by-geneAum`: repository names, no content                  |
| PR bodies or threads naming public product hosts            | 9 PRs (`*.atum.xyz`, one `*.atumlabs.xyz`)                                                  | `accepted-for-publication-by-geneAum`                                                |
| PR #82 body                                                 | Two `atumlabs.slack.com/archives/...` thread links                                          | `remove-before-flip` (CORE-2445 edits the body)                                      |
| PR #1 review threads, PR #23 comment                        | The word "slack" referring to a conversation; no channel named                               | `accepted-for-publication-by-geneAum`                                                |
| Linear link-back comments by the `linear-code` bot          | 61 comments, plus 30 PR bodies linking `linear.app`                                          | `accepted-for-publication-by-geneAum`: links resolve only for Linear members         |

The Linear issue keys are opaque outside the company and the addresses are work addresses of people
who authored the code. Gene Aumson accepted their publication.

## 8. Actions run logs

Every retained run on 2026-09-16: 1909 runs since 2026-07-01 across `CI`, `CodeQL`, the three
`Publish *` workflows, `Explorer source verification`, `Dependency Graph` and the org-level `Verify
Commit Signatures` required workflow. Logs were fetched with `gh run view --log`, and through the
REST log archive for the 584 runs that command cannot serve (org-level workflows and a few others),
then grepped for provider token shapes (Alchemy URL keys, AWS, GitHub, Slack, npm, Stripe, JWTs,
PEM blocks), 64-hex key material next to a key-ish word, basic-auth URLs, and internal names
(`svc.cluster.local`, `gserviceaccount.com`, `gcr.io`, `pkg.dev`, `gke_`, `.internal`,
`hooks.slack.com`, `projects/<id>/`, `*.atum.xyz`, `*.atumlabs.xyz`). Bare 64-hex strings were
excluded on purpose: cache keys, digests and type hashes give every CI log that shape.

| Runs                                  | Count | Lines scanned |
| ------------------------------------- | ----- | ------------- |
| Logs fetched and scanned              | 1860  | 20.1 million  |
| No log exists: `startup_failure`      | 44    | n/a           |
| No log archive served by the API      | 5     | n/a           |

The 5 runs without an archive are three `PR #<n>`-named runs from a since-deleted workflow, one
`Verify Commit Signatures` run and one early `CI` run, all `failure` conclusions from July and
August whose logs GitHub no longer serves. They cannot be read by anyone after the flip either.

Every match, with its disposition:

| Match                                                                            | Runs | What it is                                                                                   | Disposition                           |
| -------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------- | ------------------------------------- |
| `PRIVATE_KEY_NILE: 0000...0000` echoed by the TVM contracts lane                  | 165  | The all-zeros TronBox dummy key that `ci.yml` sets explicitly; not a secret                  | `accepted-for-publication-by-geneAum` |
| `nodejs.internal.kHybridDispatch` in a Node stack trace                          | 1    | Node.js internals, matched by the `.internal` pattern                                        | `accepted-for-publication-by-geneAum` |
| `docs.atum.xyz` in a checked-out commit subject                                  | 6    | Public documentation host                                                                    | `accepted-for-publication-by-geneAum` |

No run log carries a credential, a basic-auth URL, a cluster address, a GCP project or service
account, or a Slack webhook. No run needs deleting before the flip. The hostname pattern covered
`*.atum.xyz` and `*.atumlabs.xyz` but not `atum.network`; since every `atum.network` host in the
tree is a public product or schema host (section 4.2), a match in a log would carry the same
disposition and the scan was not repeated for it.

## 9. GitHub security surfaces

| Surface                    | State on 2026-09-16                                                                                                                      | Disposition                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Dependabot alerts          | 614 open (159 critical, 171 high, 275 medium, 9 low); 390 Go, 222 npm, 2 Rust; oldest 2026-07-09. 265 fixed and 63 auto-dismissed to date | Open item for CORE-2445: each alert is `resolved` or accepted before the flip; see the breakdown below         |
| Secret-scanning alerts     | Endpoint returns 404: GitHub secret scanning is not enabled on this private repository                                                    | `accepted-for-publication-by-geneAum` for the past; enable secret scanning with push protection at the flip (free on public repositories) |
| Security advisories        | Endpoint returns 404: none published, feature not enabled                                                                                | PASS                                                                                                          |

Open Dependabot alerts by manifest (top rows; the 23 Go modules share the same handful of
transitive advisories, so one `go get -u` per module closes most of them):

| Manifest                                             | Open | Critical | High |
| ---------------------------------------------------- | ---- | -------- | ---- |
| `contracts/tvm/source/pnpm-lock.yaml`                | 81   | 3        | 35   |
| `pnpm-lock.yaml` (root)                              | 53   | 2        | 25   |
| `contracts/svm/source/pnpm-lock.yaml`                | 27   | 0        | 16   |
| `contracts/svm/source/package-lock.json`             | 22   | 0        | 13   |
| Each of 23 Go `go.mod` files under `schemas/`, `contracts/*/escrow-encoding/go`, `key-management/providers/turnkey/go` | 13 to 26 | 7 to 8 | 2 to 6 |
| `contracts/svm/source/Cargo.lock`                    | 2    | 0        | 0    |
| Each of 13 TypeScript `package.json` files           | 2 to 3 | 1      | 0    |

## 10. Licenses and package visibility

A visibility flip contradicts the repository's own license files today. CORE-2494 (PR #132)
replaces them with Apache-2.0; this section records the state at `e336b357`.

| Surface                                                                                       | State                                                                                                  | Contradiction with a public repository                                          |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Repository root                                                                               | No `LICENSE`, no `SECURITY.md`, no `CONTRIBUTING.md`                                                   | Unlicensed by default; must be resolved before the flip                          |
| `mppx-atum-escrow`, `payment-gateway-client`, `x402-atum-escrow`                              | Proprietary `LICENSE` forbidding public disclosure; `"license": "SEE LICENSE IN LICENSE"`; `publishConfig.access: restricted` | Yes: the license text forbids what the flip does                                |
| `tooling/publish-guard`                                                                       | `"license": "SEE LICENSE IN ../../LICENSE"` pointing at a file that does not exist                     | Yes: dangling reference                                                          |
| `.github/PULL_REQUEST_TEMPLATE/licensed-package-release.md`, `publish-*.yml`                  | Publish flow assumes `restricted` access and a Legal sign-off                                          | Consistent with public GitHub and private npm; unchanged by the flip             |
| 12 `package.json` files with no `license` field (root, `common-decline`, `common-error`, `settler-gateway-proto`, the `schemas/declarations/**` signing packages) | Unlicensed                                                          | Yes for the three publishable ones; the rest are `private: true` workspace packages |
| `fulfillment-confirmation`, `veri-fill-client`, `atum-escrow` (x402 bindings)                  | `"license": "MIT"`, `publishConfig.access: public`                                                     | No                                                                               |
| 9 other `package.json` files                                                                  | `"license": "MIT"` or `"ISC"`, no `publishConfig`                                                      | No                                                                               |

npm packages under `@atum-labs/*` stay `restricted`; public GitHub does not make them public npm.

## 11. Fresh clone without credentials

Clone of this branch into an empty directory with `HOME` pointed at an empty directory (no
`.npmrc`, no GitHub, npm or cloud credentials), submodules included; all three submodules are
public (`forge-std`, `permit2`). With `pnpm` 10.32.1 via corepack:

| Step                              | Result                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`  | exit 0                                                                                                             |
| `pnpm -r build`                   | exit 0                                                                                                             |
| `pnpm -r test`                    | exit 0; every workspace package with a `test` script passed (payment-gateway-client 530 tests, x402-atum-escrow 173, mppx-atum-escrow 135, sender-auth 204, signing 157 and 24, turnkey 155, token-approval 90) |

The Go modules, Foundry, Anchor and TronBox lanes are outside `pnpm -r`; CI runs them with public
toolchains and, for the EVM fork tests, a public RPC fallback (section 6.2). Nothing in the build
reaches a private registry or an Atum credential.

## 12. Register for CORE-2445

### 12.1 `remove-before-flip`, in the tree

- `contracts/*/deploy/README.md`, `contracts/tvm/deploy/deploy.sh`, `deploy-permissioned.js`,
  `contracts/evm/deploy/{mainnet,testnet}.env`: split the runbooks along the line the team set on
  2026-09-17 and the SVM runbook already follows. Protocol keeps the contract source and the
  scripts and guides that deploy those contracts: forge, CREATE2, public RPCs, `YOUR_API_KEY`,
  `.env.example`. `atum-core` takes how Atum fetches deploy secrets and talks to GCP: the
  `config-gen ... --fetch-secrets` recipes, the 22 `gcloud secrets ... --project atum-core` lines
  with the project id and Secret Manager names, the environment cutover sections, the GKE overlay
  path with its Flux behaviour, the terraform environment layout and the `settler-agents/prod/...`
  private-repo paths. None of the project id or secret names is accepted for publication:
  individually inert, together they are an enumeration map (exact resource names plus the project
  they live in). The EVM runbook carries most of it (25 `config-gen` and 15 `gcloud` mentions), TVM
  next (11 `gcloud`), SVM is nearly there already (2 `gcloud`). Each moved runbook leaves a pointer
  to its new home.
- `contracts/evm/deploy/mainnet.env`, `testnet.env`: untrack both (they escape the `.env` /
  `.env.*` ignore rules by name) and publish a `.env.example` with placeholders and public RPCs in
  their place. Their content today is public on-chain material (deployer and contract addresses,
  CREATE2 salt, initcode hashes, public RPC URLs) plus the commented `gcloud` recipe and the
  `atum-deployer` keystore alias; the untracking is about the operator surface, not about a secret.
- `key-management/providers/turnkey/typescript/scripts/create-sub-organization.ts:17`: replace the
  named example user and work email with a neutral placeholder.
- `schemas/apis/x402/v1/payload/example.json:76`, `:84`, `:96`: replace the `dev.atum.network`
  `did:web` hosts with production or `example.com` ones (section 4.2).
- `.github/workflows/ci.yml` comments at lines 84, 408, 413, 485, 489, 535 and
  `.github/scripts/go-install.sh:8`: drop or paraphrase the `CORE-\d+` references.
- `payment-gateway-client/src/chain-adapters/types.ts:13`, `:16`, `src/index.ts:696`, `:697`:
  drop the `CORE-2033` / `CORE-2120` references from the published SDK's comments (section 7).
  This list is a snapshot at `e336b357` and it decays. `5ef8ebec` (PR #112) has since added
  `docs/signing.md:185`, carrying `CORE-1852`, and `docs/**` is in the package's `files` array, so
  the scrub takes that line too; the `index.ts` lines have drifted to `:715` and `:716`. Re-read
  the register against HEAD before executing it. What stops it needing a re-read at flip time is a
  guard over the package's shipped surface, the way `2392a322` guards `.github/`.
- `contracts/evm/docker/accounts.sh`: the `TEST_ACCOUNT_PRIVATE_KEY` rotation landed under
  CORE-2499, which also replaced the bare `.gitleaksignore` fingerprints with commit-qualified ones
  (section 6.1). Done.
- `audit/pre-publication-2026-09-16.md`, this report: path-remove at the flip, listed with the
  other path removals in section 12.3. Once the runbook split lands, this is the last file in the
  tree that carries the enumeration map, and the replace-text patterns do not finish the job on it.
  They strip the literal project id and the three literal Secret Manager names, but not the
  templated `${NET}_solana_rpc_url` and `${NETWORK}_tron_rpc_url` at `:170`, not the bare
  `deploy/apps/envs/**` at `:172`, and nothing reaches the section 12.3 table, which publishes how
  widely each item spread and on which commits it is still readable. Beyond that map the report is
  a register of where the fixture keys sit and of the recipe for rewriting this history: an
  internal record for CORE-2445, useful to an attacker and to nobody integrating with the
  contracts. Relocating it beside the new `atum-core` runbook keeps it where its readers are; the
  requirement here is only that it does not ship.
- `.github/scripts/check-infra-references.sh`: `accepted-for-publication-by-geneAum`. It names the
  same items, because a guard has to name what it forbids, and it is the one file here that has to
  survive the flip to keep them out. It carries the patterns rather than the operator sequence they
  appeared in: no project-and-secret pairing to read off, no environment names, no ordering. If
  that trade is ever refused, the generic forms (`[a-z0-9_]*_api_key`, a wildcard project id) hold
  the same ground more loosely.

### 12.2 `remove-before-flip`, on GitHub

- PR #82 body: remove the two `atumlabs.slack.com/archives/...` links.
- Actions runs: see section 8.
- Dependabot: every open alert resolved or accepted (section 9).

### 12.3 History: removal at HEAD is not removal

Every `remove-before-flip` row above describes the working tree. The same content stays reachable
from every historical commit that carried it, and a visibility flip publishes all of them:

| Content                                            | Commits whose tree carries it                       | Since                    |
| -------------------------------------------------- | --------------------------------------------------- | ------------------------ |
| `--project atum-core` and the Secret Manager names | 337 of 1022 across all refs; 31 of 116 on `main`     | `c276b808` (2026-08-21)  |
| Alchemy app key                                    | 42 across all refs; 2 on `main`                     | `1575c173` (2026-07-08)  |
| `TEST_ACCOUNT_PRIVATE_KEY`                         | every commit since `1575c173`                       | `1575c173`               |
| The three deploy runbooks (53 commits touch them)  | every commit since each was added                   | `c276b808`               |

So the flip needs one of two mechanisms, and this report states which. Rewriting the existing
repository with `git filter-repo` and force-pushing is not enough on its own: GitHub keeps the
pre-rewrite commits fetchable by SHA (every merged PR page links to them) until GitHub Support
purges them, so the stripped blobs stay readable to anyone who has or guesses a SHA.

Recommendation: publish from a fresh root. Run the filter below on a local clone, push the result
to a new repository that takes the `protocol` name (or have Support purge the old one first), and
keep the current repository private. Consequences, all acceptable: commit history and authorship
survive minus the stripped content; every SHA changes, as it does for the settler-agent move; PR
bodies, review threads, Actions logs and Dependabot alerts stay on the private repository and are
not published, which closes the PR #82 Slack-link row and the `CORE-` PR-body rows without editing
anything, and makes sections 7 to 9 a record rather than a to-do. Executing this is CORE-2445 and
CORE-2487 work; the ticket for this audit puts the rewrite itself out of scope.

The filter has two parts. Replace-text patterns, applied to every blob in history:

- the Alchemy key literal (below);
- `--project[= ]atum-core` and the Secret Manager names `tron_api_key`, `mainnet_tron_rpc_url`,
  `testnet_tempo_rpc_url`, `<net>_solana_rpc_url`, `<network>_tron_rpc_url`;
- `deploy/apps/envs/production-testnet-gke/`, `terraform/environments/`, `settler-agents/prod/`;
- the `TEST_ACCOUNT_PRIVATE_KEY` literal is left in history on purpose: CORE-2499 found no mainnet
  exposure, the address itself stays public as the impersonated devnet deployer, and the testnet
  balances are abandoned. Nothing is protected by scrubbing it.

Path removals, so the operator sequence does not survive in old README blobs where no pattern
reaches it: `contracts/{evm,svm,tvm}/deploy/README.md`, `contracts/evm/deploy/mainnet.env`,
`contracts/evm/deploy/testnet.env`. The split versions (section 12.1) are re-added at HEAD in the
same change, so the deploy-the-contracts half is published once, current, rather than in 53
historical revisions.

`audit/pre-publication-2026-09-16.md` is removed by path too, for the reasons in its section 12.1
row: the patterns above do not clear it, and its own value is as a record of the flip rather than
as something the flip publishes. Removing it by path rather than editing it also means this
paragraph does not have to stay true of its own file.

Generate the Alchemy replace file rather than typing it, so the value never lands in a tracked
file:

```sh
git grep -hoE 'g\.alchemy\.com/v2/[A-Za-z0-9_-]{16,}' 1575c173 -- 'contracts/evm/repo/test/fork/*.json' \
  | sed 's#.*/v2/##' | sort -u \
  | sed 's/$/==>REDACTED-ALCHEMY-KEY/' > /tmp/replace-text.txt
```

Paths that carried it: `contracts/evm/repo/test/fork/*.json` (`1575c173`, import branch) and
`contracts/evm/source/test/fork/*.json` (`00abb8ff` on the import branch, `1d11a479` on `main`).
The `TEST_ACCOUNT_PRIVATE_KEY` literal stays in history (last bullet of the replace-text list
above). Were that decision ever reversed, it comes from `contracts/evm/docker/accounts.sh:11` at
`1575c173` and `1d11a479` the same way.

### 12.4 Deliberately kept

Fixture and localnet keys (section 3.1), placeholder and public-identifier values (section 3.2),
`CORE-\d+` keys in history, in PR bodies and in source comments outside `.github/` and the published
SDK (section 7), `@atumlabs.xyz` identities in history (section 7), private repository names in PR
bodies (section 7), public product hostnames everywhere. Rewriting these would buy no security
and would break every existing link into the repository.

### 12.5 Merge rule

PR #124 (CORE-2311, the contract-audit register with exploit sequences) must not merge to `main`
while any Critical or High finding on it is still `open`. That rule once covered this report too,
holding it off `main` until the `PENDING` row in section 5 closed. The report merged in #138 on
2026-09-17 ahead of that; the row is closed above, and the hold no longer applies. PR #124's own
rule stands.

PR #330 (the Ironclad internal review of seven Solana PRs, branch
`mike-albanese/ironclad-solana-unaudited-prs-report`) carries exploit detail for findings that are
not fixed on the deployed programs, in its diff and in each of its four commits: the first carries
an HTML copy and the next two a PDF of about 1.7 MB, and the head commit deletes the PDF, which does
not remove it from those commits. Like #124 it must not merge to `main` while any finding it details
is open; its own handling note says so. Closing the PR or deleting the branch does not remove it:
GitHub serves `refs/pull/330/head`, as it still serves `refs/pull/124/head` for the closed #124
(both read 2026-11-10). The fresh-root publication in section 12.3 keeps both private only if the
push to the new repository carries `main` and no other ref (not `--all` or `--mirror`). An in-place
flip publishes both unless GitHub Support removes the two PRs and their commits first.
