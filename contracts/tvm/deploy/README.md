# v4 TVM (Tron) deployment — step by step

**Operator guide.** The commands are on `PATH` after bootstrap, so they run from any directory.

Run once from a fresh clone:

```bash
"$(git rev-parse --show-toplevel)"/contracts/tvm/deploy/bootstrap.sh   # --check to preview; installs $ATUM_HOME + PATH commands
```

Then, before deploying or committing:

```bash
atum-verify-all                             # every check, EVM -> TVM -> SVM; exit 2 = something could not run
```
Source: **protocol `main`**, `contracts/tvm/source/`. Verified against `main` and live chain queries.

> **Read this first: Tron is not EVM-with-different-addresses.** Three differences change the whole
> procedure.
>
> - **Deployment is `tronbox migrate`, not foundry.** `foundry_scripts/` exists but targets
>   eth-sepolia and cannot broadcast Tron transactions; foundry here is a test/compile harness only.
> - **No CREATE2.** Addresses derive from the creation transaction, so they **move on every redeploy**
>   and **cannot be predicted in advance**. There is no Step 6a equivalent — you capture the addresses
>   from the migration output. They also differ between shasta and mainnet.
> - **Cost is energy + bandwidth, not gas.** Sizing is in TRX burned for energy.

---

<!-- toc -->

**Contents**

- [STEP 0 — Target status](#step-0--target-status)
- [STEP 1 — Get the source and install](#step-1--get-the-source-and-install)
- [STEP 2 — Verify you have the v4 source](#step-2--verify-you-have-the-v4-source)
- [STEP 2b — Two on-chain parameters are baked at deploy time](#step-2b--two-on-chain-parameters-are-baked-at-deploy-time)
- [STEP 3 — Keys](#step-3--keys)
- [STEP 4 — RPC endpoints](#step-4--rpc-endpoints)
- [STEP 5 — Funding (energy, not gas)](#step-5--funding-energy-not-gas)
- [STEP 6 — Pre-deploy gate (there is no address to predict)](#step-6--pre-deploy-gate-there-is-no-address-to-predict)
- [STEP 7 — Deploy](#step-7--deploy)
- [STEP 8 — Rewrite `scripts/config.js` FIRST, then grant roles](#step-8--rewrite-scriptsconfigjs-first-then-grant-roles)
- [STEP 9 — Verify](#step-9--verify)
- [STEP 10 — A multisig deployer, and why the blocker is the tooling](#step-10--a-multisig-deployer-and-why-the-blocker-is-the-tooling)
- [STEP 11 — Record the addresses](#step-11--record-the-addresses)

<!-- /toc -->

## STEP 0 — Target status

Establish these three things about your deployer on the target network before anything else. The
owner threshold is the one that can stop you outright:

| Check | Why it can block you |
|---|---|
| **Activated?** | An unactivated Tron address cannot transact until it receives its first TRX. |
| **Owner threshold** | `tronbox` **cannot sign a threshold > 1** — it has no `permission_id` support. A 2-of-3 owner permission means no deploy from this tooling, whatever the balance. |
| **Balance** | Deployment burns energy and bandwidth; budget from the estimate in Step 7, not a guess. |

```bash
atum-tvm-deploy --check         # threshold, balance, energy price and shortfall for $NETWORK
```

Shasta serves staging-testnet and production-testnet; mainnet serves staging-mainnet and
production-mainnet. As on EVM, environment separation is by **which address each env's config names**,
not by separate deployments.

> **Do not assume the v4 deployer is the v3 one.** Confirm which address your seed actually controls
> before planning around it — a v3 deployer whose key is no longer held is a live account you cannot
> use, and the balance sitting in it tells you nothing about whether you can sign.
>
> A useful property when the v3 key is unavailable: the **EVM deployer re-encodes to a valid Tron
> address** — same 20 bytes, `0x41` prefix instead of `0x` — so one identity can serve both VMs. The
> derivation path is the EVM one, `m/44'/60'/0'/0/0`, not Tron's `m/44'/195'/…`. `import-deployer.sh`
> sweeps both families; see Step 3.
>
> **Admin is set at construction, but it is an argument, not the sender.** `defaultAdmin` is the
> third constructor parameter, and the migration happens to pass tronbox's `accounts` into it (Step
> 2b) — so today the deploying identity becomes the admin. Changing that one argument names any admin
> you like, without holding its key. Choosing the EVM deployer as *both* means one identity across
> VMs; it also means the v3 and v4 Tron admins differ. Since Tron has no CREATE2 the addresses move on
> redeploy regardless, so nothing is lost by switching.
>
> **This is also the lever on a multisig-blocked mainnet.** If the configured mainnet deployer is
> 2-of-3, `tronbox` cannot sign for it at all. An alternative identity at threshold 1 removes the
> blocker entirely — trading a co-signing ceremony for an activation-and-funding step. Decide it
> explicitly before mainnet: Step 10 is written for the 2-of-3 case.

---

## STEP 1 — Get the source and install

```bash
nvm use 20        # .nvmrc pins 20; tronbox 4.2.0 is untested on newer Node
git clone git@github.com:Atum-Labs/protocol.git the protocol checkout     # if not already cloned
cd the protocol checkout && git checkout main && git rev-parse HEAD       # RECORD THIS
cd "$(git rev-parse --show-toplevel)/contracts/tvm/source"
pnpm install --ignore-workspace --no-frozen-lockfile
ls node_modules/.bin/tronbox      # must exist before you go further
```

> **`--ignore-workspace` is mandatory, and omitting it fails misleadingly.** protocol has a pnpm
> workspace at the root and `contracts/tvm/source` is **not** a member (`pnpm-workspace.yaml` lists
> `contracts/*/bindings/typescript/escrow-encoding`, never `contracts/*/source`). A bare `pnpm install` walks
> up, installs the root workspace, **exits 0**, and creates no local `node_modules` — then the compile
> dies with `ERROR: Package "@alexroan/permit2-tron" is not installed`, which points at the wrong
> problem entirely. `--no-frozen-lockfile` because the lockfile was written by an older pnpm.
>
> **Do not use `npx tronbox`.** With no local install, npx silently fetches tronbox **4.10.0** from the
> registry instead of the pinned 4.2.0. Use `./node_modules/.bin/tronbox` or the pnpm scripts.

---

## STEP 2 — Verify you have the v4 source

```bash
cd "$(git rev-parse --show-toplevel)/contracts/tvm/source"
grep -c 'NonExactTransfer' contracts/Escrow.sol                     # exact-transfer guard
grep -c 'SETTLER_ROLE' contracts/FulfillmentProxy.sol               # settler allowlist gate, ships dormant
grep -o 'DepositWitness([^)]*)' contracts/Escrow.sol | head -1
# expect: DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)
```

> The retiring `contracts/tvm/repo` submodule in atum-core is **v3 and has none of the widened-witness work at all** —
> tvm-contracts has a single `v3` tag. Build from protocol `main`, never from that submodule.

Compiler settings that must not drift (they determine the bytecode and any verification):
solc **0.8.23**, `viaIR: true`, `optimizer.runs: 4294967295`, `bytecodeHash: 'none'`,
`appendCBOR: false`.

---

## STEP 2b — Two on-chain parameters are baked at deploy time

Decide these deliberately; both are permanent properties of the deployed contract.

- **`userFeePercentage`** is written on-chain at deploy and **differs per network**: shasta `50`,
  mainnet `100`. Verified live — the shasta v3 escrow carries `consume_user_resource_percent=50`,
  meaning **the deployer subsidises half of every caller's energy, indefinitely**. If that is not
  intended for v4, change it in `tronbox-config.js` before migrating.
- **`defaultAdmin` is the deployer EOA only because the migration makes it so.**
  `migrations/2_deploy_all_contracts.js` passes tronbox's `accounts` straight into
  `Escrow(permit2, usdt, defaultAdmin)` and `FulfillmentProxy(defaultAdmin)`, and tronbox sets that to
  the address derived from the private key. It is a constructor **argument**, so naming a different
  admin — the existing v3 admin, say, for an exact replacement — is a one-line edit to that migration
  and needs none of that account's keys at deploy time. Both live mainnet contracts confirm it, and
  `defaultAdminDelay()` is **1 second** on both — so set a real delay after deploy, or plan a
  begin/accept transfer pair.

## STEP 3 — Keys

**Raw hex private keys in environment variables. There is no keystore, no ledger, and no multisig
support anywhere in the TVM path.** `tronbox-config.js` reads `PRIVATE_KEY_SHASTA` /
`PRIVATE_KEY_MAINNET`; the admin scripts read `ADMIN_PK`. The value must be **bare 64-hex, no `0x`
prefix** — see the trap note below, because the failure is silent.

Use 3a if you hold a mnemonic / seed phrase, 3b if you hold a raw private key. Then do 3c either way.

### 3a. From a mnemonic / seed phrase

```bash
atum-tvm-import-deployer --self-test      # prove the toolchain first (no phrase needed)
atum-tvm-import-deployer                  # scan only — finds the derivation path, writes nothing
atum-tvm-import-deployer --write          # scan, then persist the key to "${ATUM_HOME:-$HOME/.atum}/keys/tron-shasta" (0600)
```

Run `--self-test` once before trusting a scan. It checks the derivation chain on **your** machine
against three published vectors and needs no phrase of yours:

```
  ok   address encoding      TQLCsShbQNXMTVCjprY64qZmEA4rBarpQp
  ok   m/44'/195'/0'/0/0     TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH
  ok   passphrase honoured    THJrqfbBhoB1vX97da6S6nXWkafCxpyCNB
PASS — derivation and encoding match the published vectors.
```

The three are deliberately separable: the first uses a fixed private key, so it isolates
address encoding (keccak → `0x41` → base58check) from BIP32; the second is the Tron "test seed"
published by **LedgerHQ/app-tron** and **KeystoneHQ/keystone3-firmware**; the third is
trustwallet/wallet-core's `testDeriveTron`, whose vector only resolves **with** the passphrase
`TREZOR` — so it fails if the `--mnemonic-passphrase` plumbing is silently dropped. Verified: without
the passphrase that seed derives `TJ9VWHMsmZLeA5Xp6WmDLiN4as1eySgB9c` instead.

The scan itself — the second and third commands — prompts for the phrase and an optional BIP39
passphrase, with input hidden. The phrase is never echoed, never in shell history, and never a
command-line argument (which would be visible in `ps`); it touches disk only in a 0600 temp file
wiped on exit, Ctrl-C included. Derived keys stay in a shell variable and a pipe, never argv.

The scan prints the address for each candidate path, so you can see which one matches:

```
Scanning 39 derivation paths for <the address you expect>
  m/44'/195'/0'/0/0      TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH
  m/44'/195'/0'/0/1      TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK
  ...
```

Four path families are scanned, in this order:

| Family | Why |
|---|---|
| `m/44'/195'/0'/0/i` | Tron's registered BIP44 coin type is **195** (SLIP-0044). The normal case, and tronweb's default at `i=0`. |
| `m/44'/195'/i'/0/0` | Some wallets increment the **account** level rather than the address index for "account 2". |
| `m/44'/195'/i'` | TIP-01's 3-level "primary account" form. A real shape, and it derives a *different* key from the 5-level path. |
| `m/44'/60'/0'/0/i` | A seed generated in an **EVM-first** wallet keeps its key on Ethereum's path even when the address is shown as Tron. |

Useful knobs:

```bash
SCAN=50 atum-tvm-import-deployer                        # widen the index search (default 10)
NETWORK=mainnet atum-tvm-import-deployer --write        # writes "${ATUM_HOME:-$HOME/.atum}/keys/tron-mainnet", names PRIVATE_KEY_MAINNET
EXPECT=T... atum-tvm-import-deployer                    # look for a different address
```

**Already have the key, rather than a seed phrase?** A different deployer — a mainnet key, say —
need not come from the same mnemonic, so there is nothing to sweep. `--private-key` takes the key
directly. It is a **dry check** by default: it derives the address, prints it, and writes nothing.
Add `--write` to import for real.

```bash
atum-tvm-import-deployer --private-key                  # print the Tron address, write nothing
EXPECT=T... atum-tvm-import-deployer --private-key      # and verify it matches
NETWORK=mainnet atum-tvm-import-deployer --private-key --write
```

The key is entered hidden, never appears in argv or shell history, and a dry check leaves no file
behind. `--write` refuses to overwrite an existing key rather than replacing a deployer silently.

`--write` refuses when a key is already in place, so an existing deployer is never replaced by
accident. Add `--force` to replace it deliberately:

```bash
NETWORK=mainnet atum-tvm-import-deployer --private-key --write --force
```

It names what is being replaced first. The two kinds of key are treated differently on purpose: the
plaintext TVM and SVM key files are **shredded**, since leaving copies of a bare secret around is
itself the risk, while a foundry keystore is encrypted at rest and is **moved aside** to
`<account>.replaced-<timestamp>` — a mistaken `--force` there would otherwise destroy a key that was
still recoverable. Delete that backup once you are satisfied.




If nothing matches it **writes nothing and exits 2**. The first thing to suspect is the BIP39
passphrase: a wrong one does not error, it silently derives a valid but *different* set of
addresses, so the scan output looks perfectly healthy and is simply the wrong wallet.

> **Why it shells out to `cast` for the derivation instead of using tronweb.** `TronWeb.fromMnemonic`
> hard-rejects any non-195 path with `Invalid tron path provided`, so it cannot reach the third
> family above — precisely the case you hit with an EVM-origin seed. `cast wallet private-key`
> takes an arbitrary `--mnemonic-derivation-path`, so the script derives with `cast` and uses
> tronweb only to convert the key to a base58 address. The two agree: on the public BIP39 vector
> (`abandon`×11 `about`) both produce `TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH` at `m/44'/195'/0'/0/0`,
> and `cast` reproduces the canonical `0x9858EfFD…aEda94` for that phrase on the coin-60 path.

### 3b. From a raw private key

Use the importer rather than writing the file by hand — it validates the key, derives the Tron
address, and refuses to overwrite an existing one:

```bash
atum-tvm-import-deployer --private-key                      # derive and print, write nothing
EXPECT=T... atum-tvm-import-deployer --private-key           # ... and check it is the right account
NETWORK=mainnet EXPECT=T... atum-tvm-import-deployer --private-key --write
```

The key is entered hidden, never reaches argv or shell history, and lands at
`${ATUM_HOME:-$HOME/.atum}/keys/tron-<network>` mode 0600. `--force` replaces an existing key,
shredding the old one and printing the address it is discarding.

It accepts the key with or without a `0x` prefix and strips it, which matters because tronbox needs
bare hex and `TronWeb.address.fromPrivateKey` returns `false` rather than throwing on a prefixed key.

### 3c. Confirm, always

`--private-key` and `--write` both print the derived address and, given `EXPECT`, refuse on a
mismatch — `--write` deletes the file it just wrote rather than leaving a wrong key behind. So this is
a re-confirmation, not the first line of defence:

Set `NET` once and everything below follows it. Every command in Steps 3c and 8 is written against
it, so a mainnet run is the same commands with one different value — not the shasta commands with
`shasta` edited out of each one, which is how a testnet address ends up in a mainnet grant:

```bash
NET=mainnet                                   # or shasta
KEY="${ATUM_HOME:-$HOME/.atum}/keys/tron-$NET"

export "PRIVATE_KEY_$(echo "$NET" | tr a-z A-Z)"="$(cat "$KEY" | tr -d '[:space:]')"
NETWORK=$NET atum-tvm-deploy --check          # prints the deployer it derives FROM THAT KEY, plus balance
```

`--check` derives the address from `PRIVATE_KEY_<NETWORK>` when it is exported, so it confirms the key
and the funding in one step. It needs no `node_modules` and no `cd`. The `tr -d` matters: a key file
read with its trailing newline is 65 characters, and the driver refuses it by length.

**For the Step 10 admin operations, set `ADMIN_PK` from the same file.** With the migration as
shipped the admin is the deployer — `migrations/2_deploy_all_contracts.js` passes tronbox's `accounts`
straight in as the `defaultAdmin` argument (Step 2b) — so `scripts/admin/` needs the identical key
under a different variable name. If you changed that argument to name a different admin, `ADMIN_PK`
must be the key for **that** address instead:

```bash
export ADMIN_PK="$(cat "$KEY" | tr -d '[:space:]')"
```

> **Two silent failures worth knowing.**
> - **`TronWeb.address.fromPrivateKey` returns `false` rather than throwing** when the key is
>   malformed — and a `0x` prefix counts as malformed. So a prefixed key does not produce an error,
>   it produces the string `false`, and a naive equality check just reports a mismatch. Strip the
>   prefix; `import-deployer.sh` does.
> - **Node resolves modules from the script's own directory, not the cwd.** Anything `require`ing
>   tronweb has to live under `contracts/tvm/source`, or be run with
>   `NODE_PATH=<...>/contracts/tvm/source/node_modules`. This is the same constraint that keeps
>   `assert-widened-witnesses.js` in the source tree (Step 6).

Delete the file when done: `shred -u "${ATUM_HOME:-$HOME/.atum}/keys/tron-shasta" 2>/dev/null || rm -P "${ATUM_HOME:-$HOME/.atum}/keys/tron-shasta"`

---

## STEP 4 — RPC endpoints

Both files that pick an endpoint are now env-driven for mainnet, so there is nothing to hand-edit:

| Network | Where | Default | Override |
|---|---|---|---|
| shasta | `tronbox-config.js`, `scripts/config.js` | `https://api.shasta.trongrid.io` | none — hardcoded, and fine; unauthenticated TronGrid is throttled to ~3 rps |
| nile | `tronbox-config.js` | `https://nile.trongrid.io` | none |
| mainnet | `tronbox-config.js`, `scripts/config.js` | `https://api.trongrid.io` | **`TRON_RPC_URL`** |
| mainnet auth | `tronbox-config.js` | none | **`TRON_API_KEY`** → sent as a `TRON-PRO-API-KEY` header |

**Shasta needs nothing.** For mainnet, export an authenticated TronGrid endpoint and its key:

```bash
export TRON_RPC_URL=https://api.trongrid.io   # or your own TronGrid endpoint
export TRON_API_KEY=<your TronGrid API key>
```

An authenticated shasta read works the same way if you want one, though nothing in this guide
requires it.

> **Atum operators:** how Atum fetches these values from its own secret store, and the environment
> cutover that follows a deploy, live in the `atum-core` repository next to the rest of the
> deployment infrastructure. This guide covers deploying the contracts, so it names no
> infrastructure-specific project, secret or cluster.


> **The endpoint secret is plain TronGrid, not Alchemy**, and the key is a *separate* secret sent as a
> header rather than embedded in the URL. Both files used to carry a literal
> `https://tron-mainnet.g.alchemy.com/v2/<API_KEY>` placeholder — the wrong provider *and* the wrong
> auth mechanism. An earlier version of this step told you to hand-edit it; that is no longer the case
> and doing it would now override the environment.

> **Without the API key, TronGrid throttles anonymous reads, and a throttled read does not present as
> a rate limit.** It surfaces as `could not read getEnergyFee`, which reads like a broken endpoint.

`atum-tvm-deploy --check` refuses when the tree it is compiling still holds the unfilled placeholder,
so a **stale checkout** is caught rather than discovered mid-deploy — this is the
`tronbox-config.js mainnet fullHost is a placeholder` blocker. If you see it, you are pointed at a tree
that predates the fix; check the `tree :` line in the output, since the compiled tree is resolved from
your **cwd** and need not be the one the script ships beside.

To confirm a tree is current, look for the env plumbing rather than grepping for `API_KEY` — the
header support added by the fix contains that string, so `grep API_KEY` matches the *solution* and
reads as though the placeholder were still present:

```bash
grep -n 'TRON_RPC_URL' tronbox-config.js scripts/config.js   # 2 hits on a current tree
grep -nF '<API_KEY>'   tronbox-config.js scripts/config.js   # 0 hits on a current tree
```

Grep for the placeholder literal, not for the provider name: a current tree carries a comment
explaining that the secret is TronGrid *and not* Alchemy, so `grep alchemy` matches that comment and
reads as a stale tree. `<API_KEY>` is the string the blocker itself tests, and `-F` keeps the angle
brackets from being read as a pattern.

---

## STEP 5 — Funding (energy, not gas)

Live chain parameters, queried on both networks: `getEnergyFee` = **100 sun per energy**,
`getMaxFeeLimit` = 15,000,000,000 sun (15,000 TRX — which is exactly what `tronbox-config.js` sets as
`feeLimit`, i.e. the chain maximum).

The v3 shasta deployment measured **~6,041,000 energy**, so at 100 sun/energy the burn is
~**604 TRX**, and the driver applies a 2× margin: **~1,250 TRX** to fund.

`userFeePercentage` is 50 on shasta and 100 on mainnet. Do not work from a remembered balance — the
deployer differs per network and the check reads it live:

```bash
NETWORK=shasta  atum-tvm-deploy --check
NETWORK=mainnet atum-tvm-deploy --check
```

`--check` is the one mode that needs **no signing key**. It derives the deployer from
`PRIVATE_KEY_<NETWORK>` when that is exported, and otherwise reports the per-network
`EXPECT_DEPLOYER` while saying plainly that it is an assumption. It prints the balance, the live
energy price, the shortfall and the owner threshold.

`--dry` and `--broadcast` both sign, so both **require** the key, and it is validated **before any
network read** — a missing or malformed key fails immediately with the export line to run, rather
than after the chain-parameter, balance and permission reads. A malformed key reports its length,
since a key file read without stripping whitespace is the usual cause.

An owner threshold above 1 is **not** a refusal. `tronbox` cannot sign against a multisig owner
permission, but the account may carry an active permission that allows a single-key deploy, in which
case the driver hands the whole deploy to a TronWeb path that can name it. Step 10 has the detail.

> **An unactivated account reports no threshold at all**, not threshold 1. The check says so
> explicitly rather than leaving you to read `None/0` as a permission problem. A Tron address must
> receive TRX from an already-active account before it can transact, so budget ~1 TRX of activation on
> top of the deploy cost for a fresh identity.

Staking TRX for energy instead of burning it is cheaper if you have the TRX to lock, but burning is
simpler for a one-off and is what the 604 TRX figure assumes.

---

## STEP 6 — Pre-deploy gate (there is no address to predict)

Because Tron has no CREATE2, there is nothing to derive. The equivalent safety step is proving the
**compiled artefact** pins the widened typehashes before you spend energy:

Compile first — the assertion reads a build artefact, so there is nothing to check until then:

```bash
cd "$(git rev-parse --show-toplevel)/contracts/tvm/source"
make test-foundry-gas-snapshot        # forge install && build && test --gas-snapshot-check
./node_modules/.bin/tronbox compile   # produces build/contracts/Escrow.json
make generate-abi && make check-abi
```

Then run the gate **from wherever you happen to be** — it finds the artefact itself:

```bash
atum-assert-typehashes --artifact
```

No `cd` required and no path to remember — this is the installed name, not a relative path. (It used
to be written `../../deploy/assert-typehashes.sh`, directly under that sentence, which only worked
from `contracts/tvm/source`.) With no path argument it searches `$TVM_ESCROW_ARTIFACT`,
the cwd's own `build/` or `out/`, both VM source trees relative to the script, and then walks up
from the cwd looking for a checkout. Pass a path explicitly when you want a specific artefact:

```bash
../../deploy/assert-typehashes.sh --artifact path/to/Escrow.json
```

A path you name explicitly and that does not exist is a **hard error**, never a cue to go looking
elsewhere — otherwise the gate could check a different artefact and report PASS.

It needs only `cast` and python3, so it works in a checkout with no `node_modules`. `atum-tvm-deploy`
runs the same assertion for you and treats a failure as fatal.

Expected output — six lines, then exit 0:

```
checking artifact .../contracts/tvm/source/build/contracts/Escrow.json  (46292 hex chars)
  ok:   DepositWitness   0x49bfb2c307c3a420... present
  ok:   ReserveWitness   0x231586e09714868d... present
  ok:   ReleaseWitness   0x7b53386f16fef70a... present
  ok:   RefundWitness    0x3b5d88b266408664... present
  ok:   V1 DepositWitness 0xbcc7a43f42a7faf5... absent as expected
  ok:   V1 ReserveWitness 0x64c29c15f679cf6b... absent as expected

PASS — pins the widened witness typehashes, and only those.
```

Verified to be load-bearing rather than decorative: pointed at `FulfillmentProxy.json`, which does
not pin the witness hashes, it reports the four as MISSING and exits 1.

`docker/assert-widened-witnesses.js` remains for the Tron **image build**, where a node script in
the source tree is what the Dockerfile can call. It asserts exactly the same six hashes — verified
identical output — but it is pinned to that directory by construction, which is why it is not what
this step uses.

> **Why it lives in `contracts/tvm/source/docker/` and not next to this guide.** Two hard
> constraints, both easy to trip if you move it:
> - It resolves its input as `__dirname/../build/contracts/Escrow.json`, so it **must sit one level
>   below the TVM project root**. From anywhere else it looks for a `build/` that isn't there.
> - It `require`s `tronweb`, which Node resolves by walking up from the script — so it has to be
>   inside `contracts/tvm/source`, after `pnpm install --ignore-workspace`.
>
> Both were verified by moving it and watching it break.

**It asserts both directions**, which is what makes it worth running: the four widened typehashes must be
**present** and the two V1 ones **absent**. Presence alone would pass on a contract supporting both shapes.
It also derives the hashes from the member lists rather than hard-coding them, so renaming a member and
updating a constant to match cannot sneak past.

That assertion exists precisely because the retiring tree compiles clean while signing the wrong
typehashes — Permit2 takes the witness as an opaque `bytes32`, so a wrong typehash is not a compile
error, it is a settlement failure.

---

## STEP 7 — Deploy

```bash
atum-tvm-deploy --check              # read-only: endpoint, identity, balance vs energy cost
atum-tvm-deploy                      # DRY: preflight + compile + assertions, no broadcast
atum-tvm-deploy --dry                # the same thing, named explicitly
atum-tvm-deploy --broadcast          # deploy to shasta (prompts)
NETWORK=mainnet atum-tvm-deploy --broadcast    # mainnet, via the permissioned path (Step 10)
```

An unrecognised argument is **refused**, not ignored. It used to fall through to dry, so
`atum-tvm-deploy --brodcast` dry-ran and reported success without saying the flag meant nothing.

**What has to be exported.** `--check` needs nothing on shasta. Everything else needs the signing
key, and mainnet needs the endpoint and API key as well (Step 4):

```bash
export PRIVATE_KEY_MAINNET="$(cat "${ATUM_HOME:-$HOME/.atum}/keys/tron-mainnet" | tr -d '[:space:]')"
export TRON_RPC_URL=...    # the mainnet endpoint from Step 4
export TRON_API_KEY=...    # its TronGrid key, from Step 4
```

Missing any of them fails up front and names the one that is missing, including whether the key file
already exists — so this is a checklist rather than something to discover one refusal at a time.

**Runs from any directory.** Like the Step 6 gate, the driver locates what it needs rather than
assuming a cwd: it finds the tronbox project beside itself, in the cwd, or by walking up looking for
`contracts/tvm/source`, then `cd`s there itself before compiling. So an absolute path works fine:

```bash
/path/to/contracts/tvm/deploy/deploy.sh --check
```

A candidate only counts as the source tree if it has **both** `tronbox-config.js` and
`contracts/Escrow.sol`, so it cannot latch onto an unrelated directory. If you run a copy of the
script from outside the repo — say from `~`, with no source tree above it — it says so and tells you
the flag to set, rather than guessing:

```bash
SRC_DIR=/path/to/contracts/tvm/source atum-tvm-deploy --check
```

An `SRC_DIR` you set explicitly that is *not* a tronbox project is a hard error, not a cue to search
elsewhere: silently compiling a different tree is how you deploy the wrong bytecode. The
widened-witness gate is located the same way, and if it cannot be found the driver **refuses to
deploy** rather than proceeding ungated.

The driver preflights (endpoint, deployer identity, balance vs energy cost), runs the widened-witness
assertion, migrates, then **captures the addresses from the tronbox output and the build artefacts**,
writing them to `~/atum-v4-tvm-deploy/` (override with `OUT=`). Failures are logged there. Run
artefacts deliberately stay outside the checkout.

`tronbox migrate` is **not** resumable the way the EVM driver is — there is no CREATE2 collision to
detect, so a re-run **deploys a second, different pair of contracts** while the first pair stays live
and callable. The driver therefore refuses to re-run once it has recorded addresses for a network.
The override is the environment variable **`FORCE=1`**, not a flag:

```bash
FORCE=1 atum-tvm-deploy --broadcast     # read Step 11 first
```

---

## STEP 8 — Rewrite `scripts/config.js` FIRST, then grant roles

This ordering is mandatory. Every admin script resolves its target through
`scripts/config.js` → `NETWORKS.<net>.contracts.{ESCROW_ADDRESS,FULFILLMENT_PROXY_ADDRESS}`, and there
is **no override flag** — no CLI argument, no env var. Point it at the wrong pair and every command
below silently operates on the *old* contracts.

**Everything from 8b on runs from the source tree.** 8a is a PATH tool and does not care where you
are, but 8c–8e invoke `node scripts/admin/…` by relative path. Start here:

```bash
cd "$(atum-tvm-deploy --print-source-dir)"
```

An absolute path works too — `node "$SRC/scripts/admin/…"` resolves its `require`s relative to the
module rather than the cwd, verified by running it from `/` — but the `cd` is still the right move,
because `config.js` calls `require('dotenv').config()`, which reads `.env` from the **current
directory**. From anywhere else a `.env` in the source tree is silently not picked up, and that is
exactly the `ADMIN_PK` fallback 8b tells you about.

> **This `cd` used to live inside 8a and was lost when 8a became a PATH tool.** The symptom is 8c
> failing with `MODULE_NOT_FOUND` naming `contracts/tvm/deploy/scripts/admin/…` — the *deploy*
> directory, which is where the reader is left standing by 8c's own preflight command if they ran it
> from there. The path in that error does not exist and never did, which makes it look like a missing
> file rather than a wrong directory.

### 8a. Point `scripts/config.js` at the new pair

Addresses are **base58 (`T…`)** here, not the `41…` hex the migration prints. `getContracts()` passes
them straight to `tronWeb.contract(abi, address)`.

The migration prints `41…` hex; **base58 is what goes in the file.** Update two fields per network:

| Field | Set to |
|---|---|
| `ESCROW_ADDRESS` | the newly deployed Escrow, base58 |
| `FULFILLMENT_PROXY_ADDRESS` | the newly deployed FulfillmentProxy, base58 |

Leave `PERMIT2_ADDRESS` and `USDT_ADDRESS` alone — they are pre-existing, not redeployed.

**Do not transcribe the addresses.** The deploy wrote them down; read them from there:

```bash
NETWORK=mainnet atum-tvm-sync-config            # show the change, write nothing
NETWORK=mainnet atum-tvm-sync-config --write    # apply it
```

It reads `${OUT:-$HOME/atum-v4-tvm-deploy}/<network>.addresses.json` — the record the deploy driver
writes — and prints exactly what it would change before changing anything:

```
network : mainnet
source  : /Users/you/atum-v4-tvm-deploy/mainnet.addresses.json

  change  ESCROW_ADDRESS
            from TLea6C58GyirmvcT2csY6FaRdF45WZjW95
            to   TYj48kPL31aMpJfm2LKi96e9hEfVKGmv5Y
  change  FULFILLMENT_PROXY_ADDRESS
            from TPeKaatrDGKaQEAhjD6P7MJE96ShXcZpwc
            to   TB32KsTZ9WKozgfgKtDVaJLu7f49qS88yo

  kept    PERMIT2_ADDRESS = TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m
  kept    USDT_ADDRESS = TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
```

Four things it handles that a `sed` does not:

| | |
|---|---|
| **The two drivers record differently.** | The permissioned path writes `{"escrow": {"address": "T…"}}`; the tronbox path writes `{"Escrow": "41…"}`. Both shapes are read, and `41`-hex is converted with the library — the one conversion this guide is emphatic you should not do by eye. |
| **base58check is verified, not assumed.** | An address is round-tripped through hex before use, so a mistyped character fails with *"fails its base58check checksum"* rather than becoming a live misconfiguration. One wrong character is otherwise a valid-*looking* address that silently does nothing. |
| **The edit is scoped to one network's block.** | `mainnet` and `shasta` sit in the same file, each with its own `PERMIT2_ADDRESS` and `USDT_ADDRESS`. An unscoped substitution is how you update mainnet and quietly rewrite shasta. After writing, it re-reads the file and asserts the *other* network's block is byte-identical, rolling back if not. |
| **It is idempotent.** | Run twice and the second says `Nothing to do`, so it is safe in a re-run of the sequence. |

A `.bak` is written alongside, and the review command is printed. If you have a pair on hand rather
than a record — an older deployment, or a hand-off — pass them explicitly and the same validation
applies:

```bash
ESCROW=T... FPROXY=T... NETWORK=mainnet atum-tvm-sync-config --write
```

<details>
<summary>By hand, if you would rather</summary>

Set both fields in the target network's block only, and convert rather than retype — base58check is
`0x41` + the 20 bytes + a double-SHA256 checksum:

```bash
node -e '
  const {TronWeb}=require("tronweb");
  console.log(TronWeb.address.fromHex(process.argv[1]));
' 41<the-20-byte-hex>
```

Then confirm: `grep -n 'ESCROW_ADDRESS\|FULFILLMENT_PROXY_ADDRESS' scripts/config.js`
</details>

> Check `DEFAULTS.DEPOSITOR_ADDRESS` in the same file. It commonly still names an **old deployer whose
> key nobody holds**. It is only a default for the demo/deposit scripts, not for anything in this
> step, but it misleads whoever reads it next — fix it or note it.

### 8b. Export the admin key

Every `scripts/admin/**` script calls `config.initAdminTronWeb()`, which reads **`ADMIN_PK`** (via
`dotenv`, so a `.env` in `contracts/tvm/source` works too). With the migration as shipped the
deployer is also the admin, so this is the same key — if you changed the `defaultAdmin` argument, this
must be the key for **that** address instead:

```bash
NET=mainnet                                   # or shasta — the rest of Step 8 follows this
export ADMIN_PK="$(cat "${ATUM_HOME:-$HOME/.atum}/keys/tron-$NET" | tr -d '[:space:]')"
```

There is one key file per network and the mainnet admin is not the shasta admin, so a hardcoded
`tron-shasta` here is not a harmless default — on a mainnet run it either fails with *no such file*
or, if you happen to have both, signs with the wrong account.

**If the admin account's owner permission is multisig, set the permission id too.** Every
`scripts/admin/**` script now reads `TRON_PERMISSION_ID` and, when it is set, stamps `Permission_id` on
the transaction so it is signed against that **active** permission rather than the owner permission:

```bash
export TRON_PERMISSION_ID=2
```

Unset, nothing changes: no `Permission_id`, no extra network call, a transaction byte-identical to the
one produced before this existed. Set, the permission is verified **before** signing and the choice is
printed on every run — signing against a different permission than you intended is otherwise invisible,
because the transaction looks completely normal right up to the node's rejection.

The verification refuses the cases that actually bite:

| Refused | Why it matters |
|---|---|
| the permission does not include **`TriggerSmartContract` (operation 31)** | This is a **different bit** from `CreateSmartContract` (operation 30). Step 10's deploy check tests 30. A permission that can deploy cannot necessarily call, so a deploy that succeeded tells you nothing about whether the role grants will. |
| this key's **weight** is below the permission's **threshold** | One signature silently falls short and the run needs co-signers. |
| `TRON_PERMISSION_ID=0` or `=1` | 0 is the owner permission, which is already the default — accepting it would let you believe you had switched when you had not. 1 is the witness permission and cannot call contracts. Active ids start at **2**. |

> **`wallet/getaccount` returns permission keys as 41-prefixed hex, not base58.** Comparing them
> directly against a base58 signer address is always false, which presents as "this key is not on the
> permission" for an account where it plainly is — printing the very same address back at you. Both
> encodings are normalised before comparison, and both are covered by the self-test.

`config.js` also pulls the Permit2 ABI out of `node_modules`
(`require('@alexroan/permit2-tron/…')`), so the module cannot even load in a checkout that was never
installed. Deploying from this tree already satisfies that; in a fresh checkout run
`pnpm install --ignore-workspace` first (Step 1 explains why the flag is mandatory).

There are **no pnpm scripts** for any of this — `package.json` exposes only `compile`, `migrate:*`,
`test*`, `console*` and lint. Every admin operation is a bare `node scripts/admin/...` invocation.

### 8c. Grant the four roles

**The migration grants none of these.** It leaves `DEFAULT_ADMIN_ROLE` with the deployer on both
contracts and `PAUSER`/`TREASURER`/`TOKEN_CONFIG` all `false` — matching the v3 history, which shows
four separate `grantRole` transactions. Verify on-chain rather than assuming either way; Step 8d
reads them back.

**Rehearse first.** `admin-preflight.js` builds and signs every transaction in 8c and 8d locally and
broadcasts nothing, so you find out whether the sequence will work before spending anything:

```bash
NETWORK=$NET TRON_PERMISSION_ID=2 atum-tvm-admin-preflight
```

**No addresses to supply.** It reads the same deploy record 8a did —
`${OUT:-$HOME/atum-v4-tvm-deploy}/<network>.addresses.json` — and prints where each address came
from, so the provenance is on screen rather than assumed:

```
escrow       : TYj48kPL31aMpJfm2LKi96e9hEfVKGmv5Y  (from the deploy record)
fproxy       : TB32KsTZ9WKozgfgKtDVaJLu7f49qS88yo  (from the deploy record)
```

Override when you have a pair the record does not hold — a hand-off, or an older deployment. Env and
flags take precedence in that order, and the source line changes to match:

```bash
# environment
ESCROW_ADDRESS=T... FULFILLMENT_PROXY_ADDRESS=T... \
  NETWORK=$NET TRON_PERMISSION_ID=2 atum-tvm-admin-preflight

# flags, which win over the environment
NETWORK=$NET TRON_PERMISSION_ID=2 atum-tvm-admin-preflight --escrow T... --fproxy T...
```

`ESCROW` / `FPROXY` are accepted as aliases, since `atum-tvm-sync-config` grew the shorter pair
first — both tools take both spellings, so exporting one pair and running the other works.

> **Set both or neither.** A half-set override is refused rather than filled in from the record. One
> new address beside one stale one would rehearse a pair that does not exist and report `READY`.

Deliberately **not** read from `scripts/config.js`, even after 8a has updated it: rehearsing against
the file you are about to rely on only tells you the file is self-consistent. The record is what the
deploy actually wrote.

It reads the permission from chain and checks it can actually call contracts, then for each transaction
asserts that `Permission_id` is stamped, that the function selector matches the signature derived from
`Escrow.sol`, and that the signature recovers to the key you think you are using. It works **before the
contracts exist on chain** — which matters here, because without CREATE2 the v4 addresses are not known
until the deploy transaction lands. Addresses come from `--escrow`/`--fproxy` or from the deploy record
at `${OUT:-$HOME/atum-v4-tvm-deploy}/<network>.addresses.json`, and deliberately **not** from
`scripts/config.js`, whose mainnet entries still name the v3 pair until 8a is done — rehearsing against
those would pass while testing the wrong contracts.

`--self-test` checks the tool's own machinery against pinned constants with `fullHost` aimed at a closed
port, so it is hermetic and any accidental network call fails loudly rather than passing:

```bash
atum-tvm-admin-preflight --self-test
```

`grant-role.js <network> <contract> <role> <account>` — contract is `escrow` or `fulfillment-proxy`:

```bash
ADMIN=$(NETWORK=$NET atum-tvm-admin-preflight --print-admin) && echo "admin: $ADMIN"

node scripts/admin/access-control/grant-role.js "$NET" escrow            TOKEN_CONFIG_ROLE "$ADMIN"
node scripts/admin/access-control/grant-role.js "$NET" escrow            PAUSER_ROLE       "$ADMIN"
node scripts/admin/access-control/grant-role.js "$NET" escrow            TREASURER_ROLE    "$ADMIN"
node scripts/admin/access-control/grant-role.js "$NET" fulfillment-proxy PAUSER_ROLE       "$ADMIN"
```

`--print-admin` prints one line and touches nothing, like `atum-tvm-deploy --print-source-dir`. It
takes `ADMIN_ADDRESS` if set, else the `admin` the deploy record names, else the address derived from
`ADMIN_PK` — and if those disagree it says so on stderr and names each source, because granting a
role to the wrong account is not a self-correcting mistake. The warning goes to stderr, so the
`$(…)` capture is unaffected.

> **This line used to read `export ADMIN="$EXPECT"  # $EXPECT is from your tvm.env`, and it set
> `ADMIN` to nothing.** Three reasons at once: `tvm.env` ships `EXPECT=` as an empty placeholder,
> nothing in Step 8 tells you to source `tvm.env`, and `EXPECT` was read only by
> `atum-tvm-import-deployer` — `atum-tvm-deploy` read `EXPECT_DEPLOYER`, so filling the template
> field in did nothing for the deploy either. The two names are now interchangeable in both tools, so
> one `tvm.env` field feeds both. The failure was at least loud: `grant-role.js` rejects an empty
> account with *"Invalid account address format"* before any network call, so nothing was sent.

`TOKEN_CONFIG_ROLE` goes first because 8d needs it. Each is ~23,000 energy (v3-measured), so all four
cost well under 10 TRX.

### 8d. Allow the token and set its fee config

`allow-token-and-set-fee-config.js <network> <token> <decimals> <fee%> <min-fee> <max-fee>`, all fee
values scaled 1e6. Same policy as EVM — `20000` = 0.02% = 2 bps, `250000000` = the $250 cap:

The token address is **per network** — there is no default worth having here, since allowlisting the
wrong contract is the whole failure mode:

| Network | USDT |
|---|---|
| mainnet | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` |
| shasta | `TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs` |

```bash
case "$NET" in
  mainnet) USDT=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t ;;
  shasta)  USDT=TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs ;;
esac

node scripts/admin/token-config/allow-token-and-set-fee-config.js \
  "$NET" "$USDT" 6 20000 0 250000000
```

> **`max-fee` must equal the cap the offchain signer uses**, and the script's own header says so. A
> mismatch reverts `InvalidWitnessValues` on **both** release and refund for any deposit above the
> cap threshold — neither releasable nor refundable. Below the threshold neither cap binds and the
> two agree, which is exactly why a mismatch survives testing. `max-fee = 0` means **uncapped**, not
> "no fee". The cap is only correct for a **6-decimal** token.

`allow-token.js` and `set-token-fee-config.js` exist separately and are **exact inverses** on the
allow check: `allow-token*` requires the token *not* be allowed, `set-token-fee-config` requires that
it *is*. Use the combined script on a fresh deployment; use `set-token-fee-config` to change a rate
later.

### 8e. Read the state back

```bash
node scripts/inspect-escrow.js "$NET"
```

That reports paused state, immutable config, allowed tokens with their fee config, and reconstructs
role holders from `RoleGranted`/`RoleRevoked` events — so it confirms the grants landed rather than
just that the transactions were accepted. Then Step 9 for the typehash and witness assertions.

Expect, after 8c–8d: 4/4 roles held by the admin, one allowed token (USDT) at `20000 / 0 / 250000000`,
`s_settlerAllowlistEnforced` **false** (the settler allowlist gate ships dormant), and `defaultAdminDelay` **1
second** — verified live on the new pair. Raise the delay while the deployer still holds admin; it is
the same one-second admin-delay concern as EVM.

### 8f. The v3 addresses live in more than `config.js` — and most must NOT change

`scripts/config.js` is the only file that changes the behaviour of the commands above, but it is not
the only place the old pair appears. Sweep for **both** encodings, because the hex form is invisible
to a base58 search:

```bash
( cd "$(git rev-parse --show-toplevel)" &&
  grep -rEn 'TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4py|TBx4epYWH6gp5b6hqhjo3pUmzMXdj4ypML|2e9fbe1886fa094573e3bd25c554e827873bb9fc|15b8ddc35de07784331ec006165eb487026a246a' . \
    | grep -vE 'node_modules|/build/|/out/|pnpm-lock|\.git/' )
```

The subshell is deliberate. This sweep needs the repo root, and Step 9 immediately after it needs the
source tree — a bare `cd` here leaks and makes the next step fail with `MODULE_NOT_FOUND` two screens
later, which reads as a missing file rather than a wrong directory.

`0x2e9fbe…b9fc` is `TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4py` and `0x15b8ddc3…246a` is
`TBx4epYWH6gp5b6hqhjo3pUmzMXdj4ypML` — same 20 bytes, different encoding. A trap when writing such a
grep: a leading `\b` before a hex literal **silently matches nothing**, because the `x`→digit
transition in `0x2e…` is not a word boundary.

That sweep returns ~70 hits. Triage matters more than the count:

| Hits | Action |
|---|---|
| `contracts/tvm/source/scripts/config.js:8,9` | **Change** — done in 8a. The only file that redirects the admin scripts. |
| `key-management/.../settler-testnet.example.yaml:87,88,123` | **Change** — a settler Turnkey policy template. Its `allowedTo` / `allowedSpendersHex` pin the escrow and proxy, and unlike EIP-712 field pinning these *are* enforced for transactions. It is an `.example.yaml` with `REPLACE_WITH_…` placeholders and has no live sibling in the repo, so nothing breaks today — but the next settler provisioning would allowlist the **v3** pair and deny calls to v4. |
| `contracts/tvm/deployments-v3.json:15,16` | **Add, don't edit** — that file is the v3 record. v4 wants a `deployments-v4.json` sibling; the consumers of these registries live in atum-core. |
| everything under `contracts/{tvm,evm}/{bindings,conformance}/**`, `contracts/tvm/source/encoding-examples.json`, `schemas/apis/payment-gateway/v1/bindings/typescript/client/**/*.test.ts`, `schemas/apis/x402/v1/bindings/x402-atum-escrow/**/*.test.ts` | **Leave alone.** These are frozen encoding vectors — the address is an arbitrary fixed input to a hash, not a pointer to a live contract. Rewriting them changes the expected digests and breaks the parity suites, which are live CI gates. `v2_domain_test.go`'s `domainEscrowAddr` looks like a domain-separator that "must move on a redeploy"; it is a test fixture anchoring the encoder, and it must not. |

The distinction to hold onto: an address that some code **calls** has to change; an address that some
test **hashes** must not.

> **The live Tron escrows allowlist exactly one token: USDT.** Verified via `getAllowedTokens()` on
> both shasta and mainnet. `config/tokens/testnet.yaml` also lists a shasta USDC
> (`TSdZwNqpHofzP6BsBKGQUWdBeJphLmF6id`) which has **never** been allowlisted. Decide whether v4 adds
> it rather than assuming the registry reflects on-chain state.

---

## STEP 9 — Verify

```bash
cd "$(git rev-parse --show-toplevel)/contracts/tvm/source"
node scripts/inspect-escrow.js "$NET"
```

> **This line used to read `node scripts/inspect-escrow.js` with no argument, and it could not work
> from any directory.** `inspect-escrow.js` requires exactly one — bare, it exits 1 with
> `Error: Invalid number of arguments`. The `# or query-escrow.js` alternative it offered needs
> **two** (`<network> <escrow-address>`), so that was wrong as well. 8e passes `"$NET"` correctly;
> this line simply did not.

> **`assert-widened-witnesses.js` cannot be used here.** It reads the **compiled artifact**
> (`build/contracts/Escrow.json`) and never touches a chain, so it is strictly a **pre-deploy** gate —
> Step 6, not Step 9. An earlier version of this guide said to re-run it against the deployed address;
> that is not possible. To verify a *deployed* Tron contract you have to read its bytecode back and
> search for the same PUSH32 typehash constants yourself, which is the gap noted below.

Check: the deployed contract pins the widened typehashes; the four roles are held by the intended
addresses; tokens allowed and fee config set; `deposit` is callable. Then a shasta smoke:
deposit → reserve → fulfill → release with a markup, asserting the debit equals `sourceAmount`.

---

> **This script arguably belongs in `protocol`, not atum-core.** It validates the compiled output of
> `protocol/contracts/tvm/source`, protocol `main` has no equivalent, and today it survives only inside
> one unmerged atum-core commit — so anyone deploying without knowing that SHA has no gate at all. Worth
> moving it next to the source it checks, alongside an SVM counterpart (there is none; it is tracked
> as part of the SVM deployment work).

## STEP 10 — A multisig deployer, and why the blocker is the tooling

`--check` reports `BLOCKED` when the deployer's `owner_permission.threshold` is greater than 1. Before
concluding a co-signing ceremony is required, check whether the account also carries an **`active`
permission at threshold 1** that permits deployment:

```bash
curl -s "$API/wallet/getaccount" -X POST \
  -d "{\"address\":\"$DEPLOYER_HEX\",\"visible\":false}" |
  python3 -c '
import json,sys
d=json.load(sys.stdin)
print("owner threshold:", (d.get("owner_permission") or {}).get("threshold"))
for a in d.get("active_permission") or []:
    ops=a.get("operations","")
    # The operations bitmap is little-endian by BYTE, LSB-first within each byte.
    # ContractType 30 = CreateSmartContract, 31 = TriggerSmartContract.
    b=bytes.fromhex(ops)
    can=lambda t: bool(b[t//8] >> (t%8) & 1) if t//8 < len(b) else False
    print(f"  active id={a.get(\"id\")} threshold={a.get(\"threshold\")}"
          f" CreateSmartContract={can(30)} TriggerSmartContract={can(31)}")'
```

An active permission at threshold 1 that includes ContractType 30 means **the account itself permits
single-key deployment**.

**In that case the blocker is the tooling, not the account.** A Tron transaction selects a permission
via `permission_id` (active permissions start at 2); omitted, it defaults to 0 = owner, which needs
the full threshold. There is **no `permission_id` handling anywhere in the TVM repo** — grep returns
nothing — so tronbox signs against the owner permission and a single signature is rejected.

**This is handled.** `deploy-permissioned.js` builds the `CreateSmartContract` transaction, stamps
`Permission_id`, signs once and broadcasts, and `atum-tvm-deploy` hands off to it automatically when
it detects this situation — so the usual preflight, the widened-witness gate and the duplicate-deploy
guard all still apply:

```bash
NETWORK=mainnet atum-tvm-deploy --check        # reports, hands off to nothing
NETWORK=mainnet atum-tvm-deploy                # DRY: builds, signs, predicts addresses, sends nothing
NETWORK=mainnet atum-tvm-deploy --broadcast    # real, prompts for the deployer address
```

It needs `TRON_RPC_URL` and `TRON_API_KEY`, both exported as in Step 4.

> **The endpoint secret is plain TronGrid, not Alchemy**, and the key is a *separate* secret sent as a
> `TRON-PRO-API-KEY` header rather than embedded in the URL. `tronbox-config.js` used to carry an
> Alchemy placeholder, which was the wrong provider and the wrong auth mechanism; both it and
> `scripts/config.js` now read `TRON_RPC_URL` from the environment. Without the key TronGrid throttles
> anonymous reads, and a throttled read surfaces as `could not read getEnergyFee` rather than as a
> rate limit.

> **The compiled tree is resolved from your CWD, and it is printed.** `deploy.sh` names it on the
> `tree :` line and the driver names it again as `source tree : … (from SRC_DIR)`. The two always
> agree now; they did not always, and the artifact deployed was then not the artifact checked. If the
> two trees differ from the one the script ships beside, it says so explicitly.

> **"Could not read the permissions" is not "there is no permission".** A throttled or failed account
> read used to be reported as *this account genuinely needs N signatures* — a confident wrong answer
> that sends you to arrange a co-signing ceremony you do not need. It now says **UNKNOWN**, and says
> explicitly that it is not a statement of impossibility. If you see it, set `TRON_API_KEY` (Step 4)
> and re-run; anonymous TronGrid is throttled to ~3 rps and a throttled read looks exactly like a
> definite negative.

> **Blockers are enforced before the handoff.** They used to be reported and then stepped over on the
> permissioned path, so an underfunded run proceeded and was discovered by the chain. Without CREATE2
> that is worse than it sounds: an Escrow that lands followed by a proxy that runs out of energy
> leaves a half-deployed pair at addresses nothing predicted. Each contract is now recorded the
> moment it lands, rather than both after the second succeeds.

> **Run `--dry` first, and read the `Permission_id` line.** TronWeb's `multiSign` looks the account up
> to validate the permission, so this path cannot be exercised against anything but the real account —
> `--dry` builds and signs the exact transaction, prints the stamped `Permission_id` and the predicted
> addresses, and broadcasts nothing. If `Permission_id` comes out as `0 (owner)` the script refuses
> rather than sending something the network will reject against the 2-of-3 threshold.

### The admin half of the same problem

Deploying is only the first transaction. Granting the four roles (8c) and allowlisting the token (8d)
are **`TriggerSmartContract`** calls, and they go through `scripts/admin/**` rather than the deploy
driver — so closing the gap for deployment left every post-deploy admin operation still signing against
the owner permission and still being rejected.

That is closed too, in `scripts/config.js`. `config.writeOptions(tronWeb)` is now the single source of
send options for all 19 transaction send sites in the tree, and it honours `TRON_PERMISSION_ID` (see
8b). TronWeb has supported `permissionId` on a contract call all along; nothing here needed a second
driver, only the option threaded to the sites that send.

**Check operation 31, not 30.** The deploy check above tests `CreateSmartContract`. Calling a contract
is `TriggerSmartContract`, a different bit in the same bitmap, and a permission can carry either
without the other. `admin-preflight.js` tests 31 explicitly; a green deploy is not evidence about it.

If an account genuinely has no single-key path, the remaining options are to **co-sign** with a
multisig-capable tool, or to **change the owner threshold to 1** — itself an `AccountPermissionUpdate`
requiring the full threshold, and it removes the multisig. Do not reach for that casually.

> **An active permission can be broader than the multisig it sits behind.** The mainnet deployer's
> permission 2 is threshold **1** and includes `Transfer` (op 1) and `AccountPermissionUpdate` (op 45)
> alongside the two contract operations. Whatever the owner permission's 2-of-3 implies, a single key
> holding that active permission is what actually governs the account. `admin-preflight.js` warns on
> both. Worth a deliberate decision rather than a discovery.

---

## STEP 11 — Record the addresses

Nothing automates this, and **the Tron addresses are new and unpredictable**, so capture them from the
deploy output immediately.

| File | Why |
|---|---|
| `contracts/tvm/source/scripts/config.js` | every admin script reads it; update before Step 8 |
| `payment-gw/config/config.yaml` → `"tron:shasta"` / `"tron:mainnet"` | baked config; serves staging-testnet, staging-mainnet, production-mainnet |
| `veri-fill/config/chains/testnet.yaml` → `tron:shasta` | refund signing (escrow) and the refund path's fulfillment scan (proxy) |
| `contracts/tvm/deployments-v*.json` | read by service config generation and the e2e suite |

> **Never re-run a migration to "fix" a bad record.** Without CREATE2 a second migration deploys a
> second pair of live contracts at new addresses, and the old pair stays deployed and callable. That is
> how you end up with two escrows on one chain and configs disagreeing about which is real.
