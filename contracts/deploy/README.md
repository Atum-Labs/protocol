# Contract deployment tooling

Operator tooling for deploying the v4 escrow to **real chains**. Everything here drives the
per-VM primitives that already live beside the contracts — the `forge script`s under
`contracts/evm/source/script/`, the tronbox migrations under `contracts/tvm/source/migrations/`,
the Anchor scripts under `contracts/svm/source/scripts/`. It does not replace them; it sequences
them, checks the preconditions they assume, and refuses when something is off.

| Path | Scope |
|---|---|
| [`../evm/deploy/`](../evm/deploy/) | EVM: 10-phase orchestrator (0–9), deploy driver, token config, funding, keystore |
| [`../tvm/deploy/`](../tvm/deploy/) | TVM: tronbox migrate with a compile-time witness gate, mnemonic key import |
| [`../svm/deploy/`](../svm/deploy/) | SVM: readiness gates, program-ID minting and propagation, mnemonic key import |
| `assert-typehashes.sh` | Cross-VM: does a **live** address pin the widened witness typehashes? |
| `verify-all.sh` | Cross-VM: run every verification check, EVM → TVM → SVM, with one verdict |
| `bootstrap.sh` | Cross-VM: set up a fresh clone — toolchain check, `$ATUM_HOME`, PATH commands, env templates |

### What each VM gives you, and where they differ

The three are not symmetrical, because the chains are not. Know this before you start:

| | EVM | TVM | SVM |
|---|---|---|---|
| deploy step | `atum-evm-deploy`, or `atum-evm-run-all` for all 10 phases (0–9) | `atum-tvm-deploy` | `atum-svm-deploy` |
| funding check | `atum-evm-funding-check` | `atum-tvm-deploy --check` | `atum-svm-readiness` |
| token config | atum-core `contracts/evm/token-config.sh`, or the manual forge form in the guide | `node scripts/admin/...` from the guide | `scripts/configure-token.ts` |
| address is predictable | **yes** — CREATE2 | no | no |
| redeploy is safe | yes, same address | **no** — creates a second live pair | no — new program ID, fresh PDAs |

All three now have a `--check` / dry / `--broadcast` driver with the same shape, so the *sequence* is
uniform even though the mechanics are not. EVM still has the most tooling around it, because it
deploys to seven chains at once and CREATE2 makes the result checkable in advance. On SVM the deploy
itself is short but the *propagation* afterwards is the hard part — a program ID appears inside every
signature preimage — so its guide is mostly about getting that right. Follow the per-VM guide; do not
assume the EVM shape transfers.

## If you have never deployed a contract before

Read this once; it is the vocabulary the per-VM guides assume.

**What gets deployed.** Two contracts per chain: the **Escrow**, which holds a payer's funds and
releases them against a signed authorisation, and the **FulfillmentProxy**, which the settler calls to
fulfil. Both exist on all three VM families — EVM (Ethereum and friends), TVM (Tron), SVM (Solana) —
with the same behaviour and completely different mechanics.

**A deployment is five things, in this order.** Every per-VM guide is a longer version of this list:

1. **Get a deployer.** One key that pays gas. It also *ends up* as the initial admin, but only
   because the deploy scripts pass it: `defaultAdmin` is a **constructor argument** on EVM and TVM
   (`new Escrow{salt}(permit2, msg.sender)`, and tronbox's `accounts` in the migration), not
   `msg.sender` read inside the contract. Two consequences worth knowing before you plan a deploy:
   you can name **any** address as admin by changing that one argument, without holding its key; and
   because constructor arguments are part of the initcode, changing it **moves the CREATE2 address**
   on EVM.
2. **Fund it** on every target chain. Deployment costs real gas.
3. **Deploy** the two contracts.
4. **Configure**: grant the remaining three roles and allowlist each token with its fee settings.
   Only `defaultAdmin` is set at construction; `PAUSER`, `TREASURER` and `TOKEN_CONFIG` are separate
   post-deploy `grantRole` calls, and each is gated on `DEFAULT_ADMIN_ROLE` — so whoever you named as
   admin has to sign them. If that is not you, deploy as your own admin, grant the three, then hand
   admin over with `beginDefaultAdminTransfer` / `acceptDefaultAdminTransfer`: one signature from them
   instead of four. Allowlist tokens **last**, after the handover — the escrow cannot take a deposit
   until a token is allowlisted, so the window where your key is admin carries nothing.
5. **Verify** that what is live matches what you intended — then point service config at it.

**Vocabulary you will hit immediately:**

| Term | What it means here |
|---|---|
| **deployer** | the key that pays for and creates the contracts, and starts out as their admin |
| **the four roles** | `DEFAULT_ADMIN`, `PAUSER`, `TREASURER`, `TOKEN_CONFIG` — split them on mainnet, since one key holding all four can drain fees alone |
| **witness typehash** | a hash of the exact *shape* of the message users sign. If the contract pins a different shape than the signer produces, **every deposit reverts** and nothing warns you at deploy time — which is why `verify-all` checks it three ways |
| **CREATE2** (EVM only) | lets you compute the contract's address *before* deploying. Same deployer + same salt + same bytecode = same address on every chain. Tron and Solana have no equivalent, so their addresses move on every redeploy |
| **PDA** (Solana only) | an account address derived from seeds. Ours are derived *without* the program ID, so a new program ID means an entirely fresh set — nothing carries over |
| **dry run** | every driver here simulates by default and moves no funds. You must pass `--broadcast` to spend anything |

**Nothing in this directory spends money until you pass `--broadcast`** (EVM/TVM) or explicitly run
the SVM deploy script. Read-only is the default everywhere, on purpose.

**Deploy one VM at a time.** There is deliberately no "deploy everything" command: each VM needs a
different key, different funding and different confirmations, and a single failure midway through a
combined run would leave you guessing what landed. Bootstrap and verification *are* cross-VM
(`bootstrap.sh`, `verify-all.sh`); deployment is not.

## Install the toolchains

`bootstrap.sh` tells you what is missing but does not install anything — installing compilers is
your call, not a script's. Each VM needs only its own toolchain, so install what you are deploying.

Every VM needs `git` and `python3` (both ship with macOS / most Linux distros).

**EVM — Foundry** (`forge`, `cast`):

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

Then install the Solidity dependencies — `contracts/evm/source` is **not** a pnpm-workspace package,
so the flag is mandatory or the install hoists to the wrong place:

```bash
cd contracts/evm/source && pnpm install --ignore-workspace
ls node_modules/@openzeppelin/contracts    # must exist, or nothing compiles
```

Without it, solc fails on missing `@openzeppelin` imports and reports only "Compilation failed" —
which looks like broken code rather than an un-installed checkout. `verify-all.sh` checks for the
dependency first and reports a **skip with this command**, rather than a misleading failure.

The build settings that make the address reproducible are pinned in `contracts/evm/source/foundry.toml`
(solc `0.8.27`, `via_ir`, `optimizer_runs = 4294967295`, `bytecode_hash = "none"`,
`cbor_metadata = false`). `atum-evm-derive-guard`, run from `contracts/evm/source`, confirms your tree
matches them — **a mismatch changes the bytecode and therefore the CREATE2 address**, so check it
before deriving anything.

**TVM — Node plus the project's own tronbox:**

```bash
# node 20+ and pnpm; then, from the repo:
cd contracts/tvm/source && pnpm install --ignore-workspace
ls node_modules/.bin/tronbox        # must exist before going further
```

`tronbox` is a project dependency, not a global install. `--ignore-workspace` is mandatory here — the
TVM tree is deliberately outside the pnpm workspace. Key derivation additionally uses `cast`, so
install Foundry too even for a TVM-only deploy.

**SVM — Solana CLI plus Anchor**, at the versions `contracts/svm/source/Anchor.toml` pins
(`solana_version = "2.3.0"`, `anchor_version = "0.32.1"`):

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"   # solana, solana-keygen
cargo install --git https://github.com/coral-xyz/anchor avm --locked
avm install 0.32.1 && avm use 0.32.1
```

**Match the Anchor version exactly.** A different Anchor produces different bytecode, and a
mismatched IDL does not error — it *fabricates* fields from adjacent bytes, so a wrong-version build
decodes into plausible nonsense rather than failing.

Re-run `bootstrap.sh --check` after installing; it exits non-zero while anything required is absent.

> **A fresh clone reports `INCOMPLETE` (exit 2), and that is correct.** Nothing is built yet, so most
> checks cannot run. Each skip names the exact command that fixes it — work through them, and the
> verdict becomes a real sign-off. An exit 2 you have read and understood is fine; an exit 0 you got
> by skipping everything would not be.
>
> **`forge` writes to the tracked `contracts/evm/source/foundry.lock`**, so building or testing can
> leave your tree dirty with a lockfile change you did not make. That is upstream behaviour, not
> something you broke — `git checkout -- contracts/evm/source/foundry.lock` if you want it clean.

## Quick start, from a fresh clone

### 1. Bootstrap — all three VMs, or just one

Pick whichever entry point matches what you are deploying. They are the same script: the per-VM
files are thin wrappers around `contracts/deploy/bootstrap.sh`, so the three cannot drift apart.

| Run this | Sets up |
|---|---|
| `contracts/deploy/bootstrap.sh` | **all three VMs** |
| `contracts/deploy/bootstrap.sh evm tvm` | any subset, named |
| `contracts/evm/deploy/bootstrap.sh` | EVM only |
| `contracts/tvm/deploy/bootstrap.sh` | TVM only |
| `contracts/svm/deploy/bootstrap.sh` | SVM only |

Every form takes the same flags:

```bash
contracts/deploy/bootstrap.sh --check     # report what WOULD change; touches nothing
contracts/deploy/bootstrap.sh --help
```

What a run does, in order — and it is idempotent, so re-run it freely:

1. **Checks the toolchain** for the VMs you selected, and tells you what is missing rather than
   half-working. Missing prerequisites make it exit non-zero.
2. **Creates `$ATUM_HOME`** (default `~/.atum`): `keys/` at `0700` for key material — deliberately
   outside the repo — and `env/` for per-cluster settings.
3. **Links the operator commands** into `$ATUM_BIN` (default `~/.local/bin`), so nothing afterwards
   needs a relative path or a `cd`. Re-running refreshes the links.
4. **Writes an env template** per VM at `0600`, full of placeholders. An **existing env file is left
   alone**, so your filled-in values survive a re-run; delete it to regenerate.
5. **Runs the key-derivation self-tests**, so a green bootstrap means the tools actually work rather
   than merely being present.

It writes no key material and contacts no network. Override the locations with `ATUM_HOME` and
`ATUM_BIN` if the defaults do not suit you.

> **If `$ATUM_BIN` is not on your `PATH`**, bootstrap says so and prints the line to add. It also
> warns when the repo itself sits on a temporary path (`/tmp`, `/private/tmp`): the installed
> commands are symlinks *into the repo*, so they dangle after a reboot and then fail as
> "command not found", which reads like a broken install rather than a wiped directory.

### 2. Fill in the env for your target cluster

```bash
"${EDITOR:-vi}" "${ATUM_HOME:-$HOME/.atum}/env/<vm>.env"
source            "${ATUM_HOME:-$HOME/.atum}/env/<vm>.env"
```

> **`${EDITOR:-vi}`, not `$EDITOR`.** Unset, the command collapses to the bare path and the shell
> tries to execute it; since the env templates are `0600` that surfaces as
> `permission denied: …/env/<vm>.env`, which looks like a file-permission fault rather than an unset
> variable.

The templates ship with placeholders, not defaults that would quietly deploy the wrong thing. Each
per-VM README explains where every value comes from.

### 3. Verify, before you deploy and before you commit

```bash
contracts/deploy/verify-all.sh            # or: atum-verify-all
contracts/deploy/verify-all.sh --list     # show the stages without running them
contracts/deploy/verify-all.sh --deployed # also check LIVE contracts (see its header for the env)
```

Runs every check in the canonical order **EVM → TVM → SVM**, whatever order you name them in.

**A skipped check is not a pass.** Exit `0` only when every selected stage actually ran *and* passed;
`1` on failure; `2` when something could not run — a missing toolchain, no build, an unset address.
Exit `2` exists because a green run that silently verified nothing looks exactly like a real one.
Once you have read the skip reasons and accepted them, `--allow-skip` collapses `2` into `0`.

### 4. Then read the per-VM README

Each is a step-by-step for one VM and assumes nothing beyond a clean checkout.

## Why localnet tooling is not reused

`contracts/*/docker/` builds devnet images: it deploys its own Permit2, mints mock tokens, and
bakes a state dump. None of that applies to a real chain, where Permit2 and the CREATE2 factory
are pre-existing and the deployer address is inside the initcode. The two sets answer different
questions and neither supersedes the other.

## The three typehash checks, and which to use

The witness type strings are the thing most likely to be silently wrong: Permit2 takes the
witness as an opaque `bytes32`, so a contract that pins the pre-widening shape fails nothing at
build or deploy time — every deposit just reverts at signature verification. Three checks exist
because they catch it at three different moments, and none subsumes another:

| Question | Tool | When |
|---|---|---|
| Does the **source** declare the widened set? | `contracts/evm/source/test/EncodingExamples.verify.t.sol` | every PR, via `forge test` in CI |
| Does the **compiled artifact** pin it? | `contracts/tvm/source/docker/assert-widened-witnesses.js` | TVM image build, before any deploy |
| Does the **live contract** pin it? | `assert-typehashes.sh --deployed <addr> --rpc <url>` | after deploy, before pointing config at it |

The source check is the strongest and should be preferred wherever it applies: it rebuilds each
type string from the `struct` declaration in `src/interfaces/IEscrow.sol` and compares, so it
cannot be fooled by a renamed member. The other two match hashes against bytecode and carry a
hand-maintained copy of the type strings — if they ever disagree with the forge test, the forge
test is right.

`assert-typehashes.sh` deliberately has no `--artifact` mode. For EVM the forge test already does
that job better; for TVM the tronbox artifact is `assert-widened-witnesses.js`'s job.

## Run artifacts

The drivers write logs, per-chain summaries and `addresses.json` **outside** the checkout
(`$HOME/atum-v4-*` by default, override with `OUT=`). Deployment output is not source and does
not belong in git — but do keep it: `deploy.sh` reads
`broadcast/DeployAndConfigureAllRoles.s.sol/<chain>/run-latest.json` back to confirm the
deployed address matches the predicted one.
