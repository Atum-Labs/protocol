# v4 EVM deployment — step by step

**Operator guide.** The commands are on `PATH` after bootstrap, so they run from any directory.

Run once from a fresh clone:

```bash
contracts/evm/deploy/bootstrap.sh          # --check to preview; installs $ATUM_HOME + PATH commands
```

Then, before deploying or committing:

```bash
atum-verify-all                             # every check, EVM -> TVM -> SVM; exit 2 = something could not run
```
Source of truth: **protocol `main`**, path `contracts/evm/source/`. Record the exact commit you build
from — the CREATE2 address is a function of the bytecode, so the commit *is* part of the deployment
identity.

> **Deploy from protocol, not the retired per-VM `evm-contracts` repo.** The vendored copy under
> `contracts/evm/source/` is the **union** of the upstream PRs and ahead of them: upstream lacks both
> `SETTLER_ROLE` / `s_settlerAllowlistEnforced` and the `NonExactTransfer`
> fee-on-transfer guard. Confirm for the tree you are in rather than trusting this note:
>
> ```bash
> cd contracts/evm/source
> grep -rc 'SETTLER_ROLE' src/ | grep -v ':0$'
> grep -rc 'balanceOf(address(this))' src/ | grep -v ':0$'
> ```
> Deploying from the retired `evm-contracts` tree would ship an escrow with no exact-transfer guard
> and no allowlist.
> Both sources pin the same widened typehashes, so this is easy to miss.

---

## Run it in one command

Everything below is scripted, and all the values are now known and pinned in
`./testnet.env.example`.

**First, make your env file.** The drivers read `./$NETWORK.env`, which is gitignored so that a
local file carrying private endpoints can never be committed. The tracked templates beside it hold
the pinned values and public endpoints:

```bash
cp contracts/evm/deploy/testnet.env.example contracts/evm/deploy/testnet.env
# and, for mainnet
cp contracts/evm/deploy/mainnet.env.example contracts/evm/deploy/mainnet.env
```

```bash
NETWORK=testnet atum-evm-run-all --check       # read-only: toolchain, source, keystore, RPCs, funding, derivation, live state
NETWORK=testnet atum-evm-run-all --dry         # + simulate the deploy and token config
NETWORK=testnet atum-evm-run-all --broadcast   # real deployment (each sub-step still prompts)

FROM=6 NETWORK=testnet atum-evm-run-all --check   # resume from a phase
ONLY=9 NETWORK=testnet atum-evm-run-all --check   # just re-verify what is live
```

`NETWORK` is required; there is no default. Each driver refuses a `CHAIN_TABLE` entry whose chain id
is not in that network's set in `networks.sh`, and an RPC whose live chain id differs from its entry,
so a mainnet chain in `testnet.env` (or the reverse) stops the run before anything is signed.

| Phase | What it checks | Sub-script |
|---|---|---|
| 0 | forge / cast / git / pnpm / python3 present | — |
| 1 | source at the pinned SHA, deps installed, built | — |
| 2 | right tree (`NonExactTransfer`, `SETTLER_ROLE`, widened witness) + compiler settings | `derive-guard.sh` |
| 3 | keystore present, and matching the deployer when a TTY allows | `import-deployer.sh` |
| 4 | every RPC in `CHAIN_TABLE` reachable and reporting the right chain id | — |
| 5 | funding per chain against measured create-gas | `funding-check.sh` |
| 6 | initcode size, both initcode hashes, both derived addresses | — |
| 7 | deploy, resumable per chain | `deploy.sh` |
| 8 | 25 token configs, dispatching on on-chain state | not run here — see Step 8 |
| 9 | live verification: typehashes, 4 roles, admin delay, allowlist dormant | `assert-typehashes.sh` |

`--check` on the pre-Tempo deployment passed every phase: 7/7 RPCs, 7/7 funded, derivation matching
the recorded hashes, and all 7 live escrows then at `typehashes=PASS roles=4/4 allowlist=false`;
`deployments-v4.json` now records nine v4 mainnets, Tempo Mainnet and Arc included.

**With the whole `CHAIN_TABLE` this is still not a clean pass on the defaults, and that is correct
rather than a regression.** On mainnet phase 5 reports `FUND` for Tempo because the deployer holds
**0.445863 pathUSD** against the floor, and `mainnet.env` pins the library generation, so a v4 chain
is checked only with the v4 block exported. Arc Testnet has the v4 escrow and both proxies since
2026-11-11 (`deployments-v4.json`, deployed from the ce01e304 recipe in `testnet.env.example` plus
`deploy-fulfillment-proxy.sh`); Arc mainnet has them since 2026-11-23 (the v4 block in
`mainnet.env.example`, then the preview proxy with `ENVF` pointing at a copy of `mainnet.env` whose
`ESCROW` is the v4 one, since the proxy driver takes `ESCROW` from the env file alone). One
difference from the other v4 mainnets: the Arc run took the env file's role defaults, so the escrow's
`TREASURER_ROLE` and `TOKEN_CONFIG_ROLE` went straight to the Safe `0x85B8530e…b36c`, which has no
code on 5042 yet (read 2026-11-24), while the deployer kept `DEFAULT_ADMIN_ROLE` and `PAUSER_ROLE`.
The Arc USDC token config runs as the deployer and would revert until either the Safe is deployed
on Arc or the deployer, still the admin, grants itself `TOKEN_CONFIG_ROLE` again
(`script/access-control/grant/GrantTokenConfigRole.s.sol`; these grants are not delayed). Read a
clean pass only once each chain has actually been deployed.

**For mainnet**, override in the env file (or export first): the four role addresses, and the RPCs —
use private endpoints rather than the public ones. Then follow
Step 10 for the `DeployCoreContracts` + Safe-handover path, which `--broadcast` deliberately does not
automate.

> `defaultAdminDelay()` is **1 second** on all eight, Tempo Moderato included (verified on chain). Phase 9 prints it every run precisely so it stays
> visible. Raise it while the deployer still holds admin.

---

## STEP 0 — Two decisions, before you touch anything

### 0a. Pick the SALT
`.env.example` ships `SALT=` empty. Two values are treated as canonical and they give **different
addresses**:

| Salt | Where it lives |
|---|---|
| `0x22b4280b956c7f0613b6313bbd60cf38e78fdbd98dee9876ee5db5fb1e7e4367` | `contracts/evm/docker/Dockerfile:41`, and the generator that produces service configuration |
| `0x9c22ff5f21f0b81b113e63f7db6da94fedef11b2119b4088b89664fb9a3cb658` | every committed `contracts/evm/repo/broadcast/**` record |

**Recommendation: `0x22b4280b…`.** It is the value two independent pieces of tooling agree on, and
one of them is what generates service configuration — so the address it derives is the one the
platform expects. The broadcast salt is a historical record of what was run, not a declaration
of intent. Whichever you choose, **write it down** and use it unchanged on all 16 chains.

### 0b. Decide the role addresses
The v3 alpha deploy granted **every role to the deployer itself** —
`0xB9b11aE0f9E2378a2FF8De772BCF6671F3a9b430` for PAUSER, TREASURER and TOKEN_CONFIG across 15 chains.
That is what "ALPHA/TESTNET only" in the script header means.

- **Testnet:** reusing the deployer is fine and matches precedent.
- **Mainnet:** set real addresses. And note: the current Safe is 1-of-2 holding
  `DEFAULT_ADMIN_ROLE` **and** `TREASURER_ROLE` with `defaultAdminDelay()` of 1 second. A fresh deploy
  is the cheapest moment to split TREASURER off and set a real delay. Decide now, not after handover.

### 0c. Confirm the deployer

Confirm the deployer is what you think it is before deriving anything from it.
`script/deploy/DeployCoreContracts.s.sol` passes `msg.sender` as the `defaultAdmin` **constructor
argument** (`new Escrow{salt: salt}(IPermit2(permit2Address), msg.sender)`), and constructor arguments
are part of the initcode — so a different deployer silently yields different CREATE2 addresses. Note
what that also means: you can name a **different** admin by changing that argument, without holding
its key, and the addresses then move accordingly.
Check EIP-55 validity, and that it is an EOA — not a contract — on every target chain:

```bash
cast to-check-sum-address "$DEPLOYER"          # must echo $DEPLOYER back unchanged
# Prints the chain name, never the URL: with an Alchemy key the key is inside the URL.
# A blank field means that call got no answer.
for chain in "Ethereum Sepolia|$ETH_SEPOLIA_RPC" "Base Sepolia|$BASE_SEPOLIA_RPC" "Arbitrum Sepolia|$ARB_SEPOLIA_RPC"; do
  name=${chain%%|*}; rpc=${chain#*|}
  printf '%s  code=%s nonce=%s balance=%s\n' "$name" \
    "$(cast code  "$DEPLOYER" --rpc-url "$rpc" 2>/dev/null)" \
    "$(cast nonce "$DEPLOYER" --rpc-url "$rpc" 2>/dev/null)" \
    "$(cast balance "$DEPLOYER" --rpc-url "$rpc" 2>/dev/null)"
done
```

`code=0x` confirms an EOA rather than a contract. If a public RPC does not answer, recheck with your
own endpoint rather than treating silence as an answer.

**The nonce does not matter.** CREATE2 through the factory is nonce-independent, so the deployer may
be a brand-new key or one with years of history; determinism is unaffected. Do not read a non-zero
nonce as a problem, and do not read nonce 0 as proof you have the right key.

**Do not assume it is unfunded, either.** A key already in use may hold balances on some chains and
not others. Run `atum-evm-funding-check` and fund what it reports short, rather than funding all of
them blind (Step 5).

**Changing the deployer moves the addresses.** It goes into the constructor as `defaultAdmin`, so it
is inside the initcode and inside the CREATE2 address — independently of any bytecode change. Two
things follow: the v3 broadcast address `0xBEc3fbF58e4115e373670C2A6F12f4bF0601E488` is not
reproducible with a different key, and **any address precomputed against a different deployer or a
different admin argument is void**. Re-derive in Step 6 whenever either changes.

**If the key is in routine use elsewhere, decide that deliberately.** It will hold
`DEFAULT_ADMIN_ROLE` and, unless you split them, `TREASURER_ROLE` on every escrow you deploy. A key
that also signs other traffic widens what a compromise reaches. The mitigation is the handover in
0b — and note `acceptDefaultAdminTransfer` must be signed by the *incoming* admin, so plan for that
key to be available when you do it.

```bash
export SALT=0x22b4280b956c7f0613b6313bbd60cf38e78fdbd98dee9876ee5db5fb1e7e4367
export PERMIT2_ADDRESS=0x000000000022D473030F116dDEE9F6B43aC78BA3
export DEPLOYER=<0x… the deployer/admin address>   # must be EIP-55 checksummed; see 0c
export CREATE2_FACTORY=0x4e59b44847b379578588920ca78fbf26c0b4956c
```

---

## STEP 1 — Get the source and build

```bash
git clone git@github.com:Atum-Labs/protocol.git the protocol checkout
cd the protocol checkout
git checkout main
git rev-parse HEAD          # RECORD THIS — main moves; see the note below
git submodule update --init --recursive
cd contracts/evm/source

# @openzeppelin/contracts resolves via remappings.txt to node_modules/ LOCAL to this dir.
# contracts/evm/source is NOT a pnpm-workspace package, so a plain `pnpm install` hoists to the
# protocol root and forge then cannot find OZ. Use --ignore-workspace:
pnpm install --ignore-workspace
ls node_modules/@openzeppelin/contracts    # must exist before building

forge build
```

> **Pin the SHA you build from.** `main` moves, and the CREATE2 address is a function of the
> bytecode. Record the commit, and before deploying confirm the initcode hashes still match
> Step 6a. With `bytecode_hash = "none"` + `cbor_metadata = false`, comment-only changes compile
> **byte-identical** — so a moving `main` does not necessarily move the address, and you can confirm
> that rather than assume it either way. If your hashes differ from what you derived, the bytecode
> moved and every derived address is void.

Toolchain is pinned in `foundry.toml` and **must not drift** — these five settings determine the
bytecode and therefore the CREATE2 address: `solc = "0.8.27"`, `via_ir = true`, `optimizer = true`,
`optimizer_runs = 4294967295`, `bytecode_hash = "none"`, `cbor_metadata = false`.
`always_use_create_2_factory = true` routes every `new X{salt}` through the deterministic factory.

### Preconditions that have changed an address

Each of these was hit on the Tempo Mainnet deploy of the library generation (CORE-3264). None raises an error:
the build succeeds and derives a plausible, wrong address.

1. **Build from a clean checkout at the pinned commit, not from your working clone.** The initcode is a
   function of the source, so a modified or untracked file under `contracts/evm/source/` changes the address
   (the first checkout used for the Tempo Mainnet run was dirty). Use a fresh worktree and check it before
   building:

   ```bash
   git worktree add ~/atum-v5-mainnet-deploy <SRC_SHA>      # SRC_SHA from the env file in use
   cd ~/atum-v5-mainnet-deploy
   git rev-parse HEAD                                       # must equal SRC_SHA
   git status --short                                       # must print nothing
   git submodule update --init --recursive
   ```

2. **`node_modules/@openzeppelin/contracts` must be 5.4.0.** `contracts/evm/source/package.json` pins it, but
   a `node_modules` left by an older install still holds 5.3.0, which compiles to different bytecode and so
   different addresses (seen in a protocol checkout on 2026-10-28). Install from the lockfile and read the
   version back before building:

   ```bash
   cd contracts/evm/source
   pnpm install --ignore-workspace --frozen-lockfile
   jq -r .version node_modules/@openzeppelin/contracts/package.json    # must print 5.4.0
   ```

3. **`forge build --sizes` does not show the library.** It lists the escrow but has no row for
   `EscrowReserveLib`, so a size table cannot confirm the library. The check is the library's initcode hash
   that `derive_escrow_link` prints (Step 6a), compared with `escrowReserveLibInitcodeHash` in
   `contracts/evm/deployments-v5.json`. Together with the escrow's `ESCROW_BYTES` guard that covers both
   contracts.

4. **One shell, and variables on the command.** Every `export` in this guide only exists in the shell that ran
   it. Commands run in a different terminal tab saw empty variables and failed with an empty `--account` or
   `--rpc-url`. Run a whole procedure in one shell, and where a command matters (a broadcast, a role change)
   write its variables inline in front of it, as the Step 8 and Step 10 commands do, rather than relying on an
   earlier `export`. `echo "$ACCOUNT" "$RPC"` before the first broadcast costs nothing.

---

## STEP 2 — Prove you have the right source (4 assertions)

Run all four. If any fails, stop.

```bash
cd contracts/evm/source

# 1. exact-transfer guard present (absent in the retired evm-contracts tree)
grep -c 'NonExactTransfer' src/Escrow.sol                 # expect >= 1
grep -c 'balanceOf(address(this))' src/Escrow.sol          # expect 2

# 2. settler allowlist present and DORMANT
grep -n 'SETTLER_ROLE\|s_settlerAllowlistEnforced' src/FulfillmentProxy.sol
grep -n 'bool public s_settlerAllowlistEnforced' src/FulfillmentProxy.sol   # no initializer = false

# 3. widened typehashes
grep -o 'DepositWitness([^)]*)' src/Escrow.sol
# expect: DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)

# 4. deploy scripts are present in this tree
ls script/deploy script/access-control/admin
```

---

## STEP 3 — Keys (interactive, mnemonic or private key)

`cast wallet import --interactive` prompts **only for a private key** — its prompt is literally
`Enter private key:` and it rejects a mnemonic. There is no built-in interactive mnemonic prompt, and
`--mnemonic /dev/stdin` does not work either (cast parses the string as a phrase, not a path). So use
the wrapper below, which gives you the interactive flow.

### 3a. Run the interactive importer

**Network-aware invocation.** The importer reads neither `$NETWORK` nor `$DEPLOYER`: the expected
address is a positional argument with **no default**, so the bare command exits 2 with *"No expected
address given"*. Source the env first and pass its values, so the network decides the target address
rather than your memory:

```bash
cd <protocol-root>
set -a; . contracts/evm/deploy/testnet.env; set +a     # or mainnet.env
atum-evm-import-deployer "$ACCOUNT" "$DEPLOYER"
# widen the index search:  SCAN=50 atum-evm-import-deployer "$ACCOUNT" "$DEPLOYER"
```

> **The keystore is fixed by the network.** `NETWORK=testnet` signs with `atum-deployer-testnet`
> (deployer `0x11121EEC…76B5`) and `NETWORK=mainnet` with `atum-deployer-mainnet` (deployer
> `0xf92f2F17…fE5A`). There is no override. Check an entry before importing over it:
>
> ```bash
> cast wallet address --account atum-deployer-testnet     # or -mainnet; prompts for the password
> ```
>
> If it already prints that network's `$DEPLOYER`, **skip the import**. A keystore still named
> `atum-deployer` from before this convention: confirm which address it holds, then rename it, e.g.
> `mv ~/.foundry/keystores/atum-deployer ~/.foundry/keystores/atum-deployer-testnet`.
>
> A keystore file stores no plaintext address, so an entry's network cannot be identified by
> inspection — only by unlocking it.

> **On the mnemonic path, the "already exists" refusal comes late.** The early guard lives in the
> `--private-key` branch; the sweep path has none, so it prompts for your seed phrase and scans all
> the indices before `cast` refuses. Nothing is overwritten (verified: `cast wallet import` errors
> with *"Keystore file already exists"* and leaves the file byte-unchanged), but you will have
> entered the phrase for nothing. Pick the account name before you start.


It prompts for the phrase and an optional BIP39 passphrase with **input hidden**, scans
`m/44'/60'/0'/0/0..9` for the expected deployer, imports only the matching index, then re-reads the
keystore and confirms the address. Nothing is imported unless an index matches.

**Already have the key, rather than a seed phrase?** A different deployer — a mainnet key, say —
need not come from the same mnemonic, so there is nothing to sweep. `--private-key` takes the key
directly. It is a **dry check** by default: it derives the address, prints it, and writes nothing.
Add `--write` to import for real.

```bash
atum-evm-import-deployer --private-key                       # print the address, import nothing
atum-evm-import-deployer --private-key "" 0xExpected        # and verify it matches
atum-evm-import-deployer --private-key --write acct 0xExpected   # into the keystore
```

The key is entered hidden, never appears in argv or shell history, and a dry check leaves no file
behind. `--write` refuses to overwrite an existing key rather than replacing a deployer silently.

`--write` refuses when a key is already in place, so an existing deployer is never replaced by
accident. Add `--force` to replace it deliberately:

```bash
atum-evm-import-deployer --private-key --write --force acct 0xExpected
```

It names what is being replaced first. The two kinds of key are treated differently on purpose: the
plaintext TVM and SVM key files are **shredded**, since leaving copies of a bare secret around is
itself the risk, while a foundry keystore is encrypted at rest and is **moved aside** to
`<account>.replaced-<timestamp>` — a mistaken `--force` there would otherwise destroy a key that was
still recoverable. Delete that backup once you are satisfied.


`--write` here uses `cast wallet import --interactive`, so the key never reaches argv — but it needs a
real terminal and will not work piped from a script.



Why a wrapper rather than a one-liner: the phrase must not become a command-line argument, because
arguments are visible in `ps` to any user on the machine and land in shell history. The script reads
it with `read -rs` (no echo, no history), writes it to a `0600` temp file only because `cast` requires
a file or an argument, and wipes that file on exit via a trap that also fires on Ctrl-C.

Verified behaviour, all tested:

| Case | Result |
|---|---|
| Correct phrase, right index | imports, then confirms the keystore address matches |
| Expected address not in range | **exit 2, imports nothing**, tells you to widen `SCAN` or try a custom path |
| Wrong BIP39 passphrase | derives a completely different but valid address set → no match → refuses |
| Ctrl-C mid-run | temp mnemonic file wiped by the trap |

### 3b. If you hold a raw private key instead

```bash
cast wallet import "$ACCOUNT" --interactive     # prompts; nothing in shell history
```

### 3c. Confirm, always

```bash
cast wallet address --account "$ACCOUNT"
# MUST print $DEPLOYER — stop here if it does not
```

The wrapper does this for you, but check it by eye anyway.

> **The keystore name is not the same on every network.** `atum-deployer-mainnet` holds the mainnet deployer
> (`0xf92f2F17…`, the one behind the Tempo Mainnet deployment); `atum-deployer-testnet` is the testnet / Moderato key,
> and a machine can hold both (`ls ~/.foundry/keystores`). The drivers fix the name by `NETWORK`, and
> `mainnet.env.example` sets `ACCOUNT` to the mainnet one. Confirm which one a name resolves to before any broadcast, with
> `ACCOUNT` set inline:
>
> ```bash
> ACCOUNT=atum-deployer-mainnet; cast wallet address --account "$ACCOUNT"    # must print the mainnet $DEPLOYER
> ```

> **Why this check is load-bearing.** A wrong index or a wrong passphrase does not error — both
> silently produce a valid keystore for a *different* address. The deployer is passed as
> `defaultAdmin` in the constructor, so it sits inside the initcode and inside the CREATE2 address:
> the wrong key deploys to a different address on all 16 chains, and your derived addresses and
> generated config all become void. Catching it here costs nothing; catching it at Step 6a costs a
> rebuild; catching it after broadcasting costs a redeploy.

> **Skipping the keystore:** `forge script` also accepts `--mnemonics <path> --mnemonic-indexes <N>`.
> The keystore is worth it across 14 deploys plus role and token-config transactions — re-passing the
> mnemonic each time widens the exposure for no gain.

## STEP 4 — RPC URLs

`foundry.toml` has no `[rpc_endpoints]`, so `--rpc-url` needs a literal URL every time.

> **Atum operators:** the recipe for pulling Atum's private endpoints, the variable names the
> services read, and the environment cutover that follows a deploy all live in the `atum-core`
> repository next to the rest of the deployment infrastructure. This guide covers deploying the
> contracts, so it names no infrastructure-specific project, secret or cluster.

### 4a. Public endpoints, per network

A testnet deploy needs nothing private — working RPC URLs are enough, and these nine are verified
responding with the correct `eth_chainId`:

```bash
export ETH_SEPOLIA_RPC=https://ethereum-sepolia-rpc.publicnode.com      # 11155111
export ARB_SEPOLIA_RPC=https://sepolia-rollup.arbitrum.io/rpc           # 421614
export BASE_SEPOLIA_RPC=https://sepolia.base.org                        # 84532
export CELO_SEPOLIA_RPC=https://forno.celo-sepolia.celo-testnet.org     # 11142220
export AMOY_RPC=https://polygon-amoy-bor-rpc.publicnode.com             # 80002
export OP_SEPOLIA_RPC=https://sepolia.optimism.io                       # 11155420
export FUJI_RPC=https://api.avax-test.network/ext/bc/C/rpc              # 43113
export MODERATO_RPC=https://rpc.moderato.tempo.xyz                      # 42431
export ARC_TESTNET_RPC=https://rpc.testnet.arc.io                  # 5042002
```

`https://rpc.testnet.tempo.xyz` is an **alias for the same chain** (42431) — both were verified
reporting that id. The env file names only `MODERATO_RPC`, so two rows can never disagree about
which endpoint a driver actually used.

**Mainnet public endpoints**, under the names the drivers read; these are what `mainnet.env.example` ships:

```bash
export ETH_MAINNET_RPC=https://ethereum-rpc.publicnode.com    # 1
export ARB_ONE_RPC=https://arb1.arbitrum.io/rpc               # 42161
export BASE_MAINNET_RPC=https://mainnet.base.org              # 8453
export CELO_MAINNET_RPC=https://forno.celo.org                # 42220
export POLYGON_RPC=https://polygon-bor-rpc.publicnode.com     # 137
export OP_MAINNET_RPC=https://mainnet.optimism.io             # 10
export AVAX_RPC=https://api.avax.network/ext/bc/C/rpc         # 43114
export TEMPO_MAINNET_RPC=https://rpc.mainnet.tempo.xyz        # 4217
export ARC_MAINNET_RPC=https://rpc.mainnet.arc.io             # 5042
```

`https://rpc.tempo.xyz` is an alias for 4217, same as above.

> **The deploy scripts and the services use different variable names, both correct.** The `export`
> blocks above use the names the **deploy scripts** read (`MODERATO_RPC`, `TEMPO_MAINNET_RPC`, from
> `$NETWORK.env`). Service configuration uses its own set (`ETHEREUM_RPC_URL` where the scripts say
> `ETH_MAINNET_RPC`, and so on), documented with the infrastructure. Neither is a typo for the other,
> so do not "fix" one to match the other.

**Read-only work only.** They are enough for `NETWORK=mainnet atum-evm-run-all --check` and
`atum-evm-funding-check`; do not broadcast through them. Prefer sourcing the env file, which also
sets `CHAIN_TABLE` so every driver iterates mainnet instead of the testnet set:

```bash
set -a; . contracts/evm/deploy/mainnet.env; set +a
```

Two of these are replacements for endpoints that services still carry as defaults but which are
**dead**: `https://sepolia.drpc.org` (Ethereum Sepolia) and `https://rpc-amoy.polygon.technology`
(Polygon Amoy) both fail to respond. Worth fixing on the service side separately, since a service
falls back to its baked-in literal whenever its RPC variable is unset.

Re-verify before you deploy, since public endpoints come and go:

```bash
# Once mainnet.env is sourced, CHAIN_TABLE is authoritative and this checks the right set.
# Prints chain names only, never URLs: with an Alchemy key the key is inside the URL, and cast's
# stderr is dropped so a failure cannot echo one back either. A blank answer means no reply.
if [ -n "${CHAIN_TABLE:-}" ]; then
  printf '%s' "$CHAIN_TABLE" | while IFS='|' read -r cid name url; do
    [ -z "$cid" ] && continue
    got=$(cast chain-id --rpc-url "$url" 2>/dev/null | tail -1)
    printf '%-14s want %-9s got %s\n' "$name" "$cid" "${got:-no answer}"
  done
else
  for chain in "Ethereum Sepolia|$ETH_SEPOLIA_RPC" "Arbitrum Sepolia|$ARB_SEPOLIA_RPC" "Base Sepolia|$BASE_SEPOLIA_RPC" \
               "Celo Sepolia|$CELO_SEPOLIA_RPC" "Polygon Amoy|$AMOY_RPC" "Optimism Sepolia|$OP_SEPOLIA_RPC" \
               "Avalanche Fuji|$FUJI_RPC" "Tempo Moderato|$MODERATO_RPC" "Arc Testnet|$ARC_TESTNET_RPC"; do
    name=${chain%%|*}; rpc=${chain#*|}
    got=$(cast chain-id --rpc-url "$rpc" 2>/dev/null | tail -1)
    printf '%-18s %s\n' "$name" "${got:-no answer}"
  done
fi
```

**Use private endpoints to BROADCAST on mainnet.** Public RPCs rate-limit, and a throttled or
silently-lagging node partway through a multi-chain deploy loop is not a risk worth taking with real
funds. Put a private endpoint in each of the variables above before you broadcast.

> **Confirm no `YOUR_API_KEY` survives** in whatever you source. A placeholder endpoint fails at
> deploy time rather than at generate time, which is the expensive place to find out.

> Whatever file holds live endpoints should be mode `0600` and must not be committed. The copy the
> drivers read, `contracts/evm/deploy/$NETWORK.env`, is gitignored for that reason — remove it when
> you are done.

## STEP 5 — Per-chain preflight and funding

Use the calculator: **`atum-evm-funding-check`**

```bash
atum-evm-funding-check                       # testnet by default: every chain in CHAIN_TABLE, exits 1 if any is short
NETWORK=mainnet atum-evm-funding-check       # the mainnet CHAIN_TABLE
CHAINS="84532 421614" atum-evm-funding-check
MARGIN=5 atum-evm-funding-check              # default margin is 3x
```

`NETWORK` selects `testnet.env` or `mainnet.env` (your copy of the template), which carries the deployer, the chain set and the
RPCs together — so the deployer it checks and the chains it iterates always match. Anything you export
first still wins; every assignment in those files is `: "${VAR:=…}"`.

**The funding floors are per chain, not per token.** Ethereum mainnet gas is the volatile one: at a
sub-gwei reading the arithmetic asks for ~0.001 ETH, but at a routine 3-5 gwei the same 7M gas costs
0.02-0.035, so the recommendation is floored at 0.05 there. Do not fund from the raw `NEEDED` column.

It measures the two CREATE2 deployments per chain with `cast estimate --create` rather than guessing,
adds a role-grant allowance (`ROLE_GAS`, default 240k for four grants), multiplies by the live gas
price and the margin, subtracts the current balance, and applies a practical floor so the
recommendation is usable rather than merely arithmetically correct.

**Measured cost of the deploy:** Escrow `5,007,189` gas, FulfillmentProxy `1,770,529`, so ~7.02M gas
per chain including role grants.

### Check funding per chain

Gas price moves, so read it rather than reusing a figure:

```bash
atum-evm-funding-check
```

It reports, per chain, the estimated gas, the live gas price, the deployer balance and the shortfall.
Two things it will not tell you:

- **Arbitrum's estimate roughly doubles** (~7M to ~14.4M) because its gas accounting charges for L1
  calldata; budget for the higher figure there, not the nominal one.
- A **sub-gwei** gas price makes a shortfall look negligible when it is not — an unfunded deployer
  still fails, just cheaply.
| Polygon Amoy | 7.04M | 80 gwei | 0 | **top up 5 POL** |

**Totals to top up: 0.06 ETH split across the three L2s, and 5 POL on Amoy.** Three chains are
already funded. Re-run the script before deploying — gas prices move (Amoy went 30 → 80 gwei between
two samples minutes apart, which is exactly why the margin exists).

### Three things the raw arithmetic gets wrong

- **Arbitrum Sepolia's gas estimate is not stable, and that is expected.** Arbitrum folds the L1 data
  cost into the gas number itself, scaled by the current L1 base fee, so the estimate moves with L1
  congestion. Measured both: **14,396,762** gas for the script when the L1 estimate was non-zero, and
  **7,017,718** when `ArbGasInfo.getL1BaseFeeEstimate()` (precompile `0x…6C`) returned `0` — at which
  point the Escrow create-gas is `5,007,189`, byte-for-byte identical to Ethereum Sepolia's pure
  execution cost. So budget for the high end: Arbitrum's requirement can roughly double with no change
  on your side. Check it directly with:
  `cast call 0x000000000000000000000000000000000000006C 'getL1BaseFeeEstimate()(uint256)' --rpc-url <arb-rpc>`

  Base and Optimism behave the opposite way: their L1 data fee sits **outside** `gas_price x gas`, so
  the computed figure there is an underestimate rather than a variable one. Either way the margin and
  the floor are doing real work. Do not trim them.
- **Avalanche Fuji reports a sub-gwei price**, which makes `NEEDED` round to zero. Meaningless output;
  it already holds 0.099 AVAX, which is ample. Treat any sub-gwei price as unreliable.
- **A zero balance does not always fail a simulation.** Only OP-stack chains enforce the fee check
  during simulation, which is why Base and Optimism Sepolia were the two that failed the Step 7
  simulate pass while Arbitrum and Amoy passed on a zero balance.

Faucet pointers are printed by the script.

## The escrow library (every generation from CORE-3048 on)

`Escrow.reserve()` and `Escrow.refundUnreserved()` delegatecall `EscrowReserveLib`, an external
library (4,401 bytes of runtime). These bodies live in the library to keep the escrow, including
its deposit-time fee snapshot and getter, below EIP-170 (24,537 bytes of runtime). The escrow's
initcode therefore carries a link placeholder, and **the library's address is inside the escrow's
initcode, so it is inside the escrow's CREATE2 address.** Three rules follow, and the drivers here
enforce them (`escrow-lib.sh` is the shared part):

1. **The library is deployed first, through the same CREATE2 factory with the same `SALT`.** Left to
   forge, `forge script` deploys the library itself, and with this tree's `always_use_create_2_factory`
   it does so through the factory with **salt 0**: a deterministic address, but not the `SALT`-derived
   one. The escrow is then linked to that library, lands at an address no derivation here produces, and
   nothing reverts.
   `deploy.sh` runs `script/deploy/DeployEscrowReserveLib.s.sol` (a no-op when the library is there),
   then the escrow script with `--libraries src/EscrowReserveLib.sol:EscrowReserveLib:<address>`.
2. **Hash and size the linked initcode.** The unlinked bytecode is not hex. `ESCROW_BYTES` is the same
   for both (25,996 bytes of creation code without its constructor arguments, 26,060 with them), so the
   guard cannot tell them apart; the hash can.
3. **A missing library reverts, and it takes `refundUnreserved()` down with `reserve()`.** Both functions
   call the library, and a call to an address with no code reverts with empty revert data (solc checks
   `extcodesize` first; measured against an escrow linked to a codeless address). So an escrow without
   its library still takes `directDeposit` funds but can neither reserve them nor refund an unreserved
   deposit, until the library lands (`Escrow.directDeposit.t.sol`, `test_missingLibrary_*`, etches the
   library empty and asserts exactly this, including that `directDeposit` still works). `deploy.sh` reports an escrow without its
   library as `LIB_MISSING` instead of `COMPLETE` and, when broadcasting, deploys the library at the
   address the escrow already embeds. `run-all.sh` phase 9 prints `lib=ok|MISSING|UNLINKED`: code at
   the derived address **and** that address inside the escrow's runtime. `UNLINKED` means the escrow
   was linked to some other library, which is what forgetting `--libraries` produces; the escrow
   script also reverts on it when `ESCROW_RESERVE_LIB_ADDRESS` is set, which `deploy.sh` always does.

The pins for a library generation are the escrow's `ESCROW_INITCODE_HASH`, `ESCROW`, and the library's
`ESCROW_LIB` (checked by `run-all.sh` phase 6) or `EXPECT_LIB` (checked by `deploy.sh` before it
broadcasts). `testnet.env.example` and `mainnet.env.example` both carry the library generation's pins (the mainnet ones
are what is deployed on Tempo Mainnet, CORE-3264) and keep the v4 pins in a comment for the chains still on v4. The
mainnet build is **pre-audit** (the security audit, CORE-3057, is still open) and a non-default escrow next to the v4
one: Tempo Mainnet only, so don't lift `CHAINS` for this build until the audit closes; the audited build gets its own
record rather than replacing the entry while settlements name it. Which chains actually have it,
with transaction hashes and gas, is `contracts/evm/deployments-v5.json`; this README does not repeat it.
A tree without `src/EscrowReserveLib.sol` is treated as v4 and every library step is skipped, so a v4
redeploy from its `SRC_SHA` is unchanged: export the v4 block at the top of that network's own env file first
(`testnet.env.example` or `mainnet.env.example`; the `ESCROW` and hash in each are that network's deployer's), and
set `SRC_DIR` in it to a built ce01e304 checkout.

The library has no constructor arguments, so its address depends on the factory and `SALT` only and is the same
for both deployers; the escrow differs because the deployer is a constructor argument. Phase 6 checks the
library address, the creation-code size (`ESCROW_BYTES`, not the 24,537-byte runtime), the initcode hash and the
escrow address against the pins of the env file in use. `mainnet.env.example` defaults `CHAINS` to `4217` and
`DEPLOY_PROXY` to `0`, the same guard as the testnet file, so a mainnet run on its defaults cannot reach a chain whose
escrow is still v4.

**`CHAINS` narrows every phase**, as well as `deploy.sh` and `funding-check.sh`. `testnet.env.example` defaults
it to `42431` and `DEPLOY_PROXY` to `0`, so a run on its defaults cannot reach a chain whose escrow is still v4;
export `CHAINS=` (empty) for the whole table. `run-all.sh` also refuses to broadcast after any failed phase.
To check the library generation, from a checkout whose HEAD is not the pinned `SRC_SHA`:

```bash
SRC_SHA=$(git rev-parse HEAD) atum-evm-run-all --check
```

**A new escrow next to a deployed proxy: `DEPLOY_PROXY=0`.** The `FulfillmentProxy` gained
`authorizeFulfillment` after v4 (#167), so a tree built from main derives a different proxy
(`0xd1254EF0…0144` with these salts) from the live v4 one, and deploying "both" would add a second, unpinned proxy
beside it. `DEPLOY_PROXY=0 deploy.sh` (and `run-all.sh`, `funding-check.sh`) deploy, size and verify the library and
the Escrow only, with `script/deploy/DeployEscrowOnly.s.sol`, and leave the existing proxy alone; `FPROXY` names
it and is only checked for code. The escrow's three roles are granted as usual; the proxy's are not checked.
Phase 6 and phase 9 skip the proxy rows.

The anvil/docker stack (`../docker/deploy-contracts.sh`) sets no `--libraries`: there forge deploys the
library itself (through the factory, salt 0), which is fine because nothing there depends on a
derived address.

**Doing it by hand** (the drivers do all of this): the manual steps below, Step 6 and Step 10, need the
same two additions or they link the escrow to forge's own library. Deploy the library, take its address,
and pass it twice, as `--libraries` and as `ESCROW_RESERVE_LIB_ADDRESS`; the escrow scripts revert when the
deployed escrow does not embed that address. The env examples export `ESCROW_RESERVE_LIB_ADDRESS` from
`ESCROW_LIB`, so once the generation's library is pinned there, a manual run is checked without remembering
to set it. Step 10 has the exact commands.

## STEP 6a — Derive the addresses before spending any gas

CREATE2 is deterministic, so you can know the addresses up front and pre-write config.

**Easiest route:** `NETWORK=<net> atum-evm-run-all --check` runs this as phase 6 and compares the
result against the pinned addresses. Derive by hand only when you want the intermediate values.

```bash
# 1. Load the environment FIRST. Every value below comes from it, and with the variables unset
#    `cast abi-encode 'c(address,address)' $PERMIT2_ADDRESS $DEPLOYER` receives ZERO arguments and
#    fails with "expected 2 types, got 0" — an error about the signature, not about what is missing.
DEPLOY_DIR=~/path/to/contracts/evm/deploy          # adjust
set -a; . "$DEPLOY_DIR/${NETWORK:-testnet}.env"; set +a

# 2. The cwd is load-bearing. Use the vendored EVM project, not the protocol root.
cd "$DEPLOY_DIR/../source"

# 3. Prove the compiler settings are the ones that reproduce the canonical bytecode.
#    Anything other than these values means a WRONG address, not an error.
atum-evm-derive-guard          # exits non-zero and says which setting is off

# 4. Fail loudly on anything the env file did not provide.
: "${PERMIT2_ADDRESS:?not set — did the env file load?}"
: "${DEPLOYER:?not set — did the env file load?}"
: "${SALT:?not set — did the env file load?}"
: "${FACTORY:=0x4e59b44847b379578588920ca78fbf26c0b4956c}"

# Fully-qualified contract paths. Do NOT use the bare names.
# If this tree has src/EscrowReserveLib.sol (the library generation, see "The escrow library" below),
# the Escrow initcode must be LINKED before it is hashed. derive_escrow_link does that, and sets
# WANT_LIB (the library's own CREATE2 address) as well; in a v4 tree it just returns the bytecode.
. "$DEPLOY_DIR/escrow-lib.sh"
derive_escrow_link || return 1 2>/dev/null || exit 1
FP_BC=$(forge inspect src/FulfillmentProxy.sol:FulfillmentProxy bytecode)

# Guard: wrong contract or a stale build both show up here. `return` so a bad size actually
# stops you — the old form printed "STOP" and carried on to derive a wrong address.
[ $(( (${#ESC_BC}-2)/2 )) -eq "${ESCROW_BYTES:-23890}" ] \
  || { echo "Escrow is $(( (${#ESC_BC}-2)/2 )) bytes, expected ${ESCROW_BYTES:-23890} — STOP"; return 1 2>/dev/null || exit 1; }

ESC_H=$(cast keccak "${ESC_BC}$(cast abi-encode 'c(address,address)' "$PERMIT2_ADDRESS" "$DEPLOYER" | cut -c3-)")
FP_H=$(cast keccak  "${FP_BC}$(cast abi-encode 'c(address)' "$DEPLOYER" | cut -c3-)")
echo "escrow initcode-hash $ESC_H"
echo "fproxy initcode-hash $FP_H"
echo "library    ${WANT_LIB:-none (v4 tree)}"
create2_address "$FACTORY" "$SALT" "$ESC_H"
create2_address "$FACTORY" "$SALT" "$FP_H"
```

> **`defaultAdmin` is a constructor argument, so it is inside the initcode and inside the address.**
> That is why the same bytecode and the same salt still give different addresses per network: the
> testnet and mainnet env files carry different `DEPLOYER` values. Deriving with the wrong env file
> loaded produces a plausible address for the other network, and nothing about the output says so —
> which is what the pins in `mainnet.env.example` and `atum-evm-deploy`'s `EXPECT_ESCROW` exist to catch.

> **Why the bare names fail.** `forge inspect Escrow bytecode` errors with
> `Multiple contracts found with the name 'Escrow'`, for two independent reasons:
>
> - `lib/permit2/lib/openzeppelin-contracts/contracts/utils/escrow/Escrow.sol` defines OpenZeppelin's
>   own unrelated `Escrow`.
> - protocol vendors a **second** `FulfillmentProxy` (and `Escrow`) at
>   `contracts/tvm/source/contracts/` for TVM. There is no root `foundry.toml` in protocol, so running
>   forge from the repo root discovers **both** vendored trees and every name is ambiguous.
>
> Running from `contracts/evm/source` fixes the TVM half; fully qualifying fixes the OpenZeppelin
> half. You need both, and the paths are relative to the project — from the protocol root
> `src/Escrow.sol` does not exist, which is why that form errors with
> `Could not find source file for contract 'Escrow' at src/Escrow.sol`.
>
> **The cwd is not cosmetic — it changes the bytecode.** protocol has no root `foundry.toml`, so forge
> at the root falls back to defaults that differ in every way that matters:
>
> | Setting | vendored project | root default |
> |---|---|---|
> | `via_ir` | `true` | `false` |
> | `optimizer` | `true` | `false` |
> | `optimizer_runs` | `4294967295` | `200` |
> | `bytecode_hash` | `none` | **`ipfs`** (metadata appended) |
> | `cbor_metadata` | `false` | **`true`** |
> | `always_use_create_2_factory` | `true` | `false` |
>
> Unoptimized, non-IR, with a metadata hash appended: a completely different initcode and therefore a
> completely different address — derived without any error. That is why the settings check above comes
> before the derivation, and why the 23,890-byte assertion is worth keeping as a backstop.
>
> Treat the earlier ambiguity error as protective: had forge silently resolved to OpenZeppelin's
> `Escrow`, you would have derived a plausible wrong address and found out only after broadcasting.

**Worked example.** These values are what one particular deployer and commit produce — yours will
differ. What matters is that your own derivation is *reproducible* and agrees with what you broadcast:

| | value |
|---|---|
| Escrow initcode-hash | `0xe8afbb92f8a2c9192ffb25033c5553f4ba42e2fc3103598a3e1044e1fa5ee572` |
| FProxy initcode-hash | `0x9efddf157169aa58f6c7dcf48fe82f508bcfb45056a4f78150e778817a97ee7e` |
| Escrow, SALT A | `0x0F875601504C9179562506AFa34b2D084268869b` |
| FProxy, SALT A | `0x1F1F8FA642bc5F530ba37F1Db3a656E9eB8BaFeb` |
| Escrow, SALT B | `0x5F48F31e0BB842ff6D63734Dac12214D57126c84` |
| FProxy, SALT B | `0x248b93d0Edf44930516dE050C436e2DDd6833A56` |

Escrow creation bytecode is 23,890 bytes. **Method validated** against the v3 broadcast records: the
same derivation over the recorded v3 initcode reproduces the real deployed
`0xBEc3fbF58e4115e373670C2A6F12f4bF0601E488` / `0xF385Fe59777fbf1341d668865905d8fe9d9cf62b` exactly.

## STEP 6 — Dry run and lock in the predicted address

Run **without** `--broadcast` on one testnet first. Note the predicted addresses.

```bash
cd contracts/evm/source
PERMIT2_ADDRESS=$PERMIT2_ADDRESS SALT=$SALT \
ESCROW_PAUSER_ADDRESS=$DEPLOYER ESCROW_TREASURER_ADDRESS=$DEPLOYER \
ESCROW_TOKEN_CONFIG_ADDRESS=$DEPLOYER FP_PAUSER_ADDRESS=$DEPLOYER \
  forge script script/deploy/DeployAndConfigureAllRoles.s.sol \
  --rpc-url $RPC --account "$ACCOUNT" --sender $DEPLOYER
```

For the library generation add `ESCROW_RESERVE_LIB_ADDRESS=<library>` and
`--libraries src/EscrowReserveLib.sol:EscrowReserveLib:<library>` (see "The escrow library" above; Step 10
shows how to get the address). The simulation does not need the library deployed.

**Checkpoint:** repeat the dry run against a second chain's RPC. The predicted Escrow and
FulfillmentProxy addresses **must be identical**. If they differ, your deployer, salt or build settings
changed — do not proceed.

> **Do NOT pass `--verify`.** There is no `[etherscan]` block and no API key in the repo, so explorer
> verification is unconfigured and the flag fails the run. (`README.md:109` mentions it and also gives
> the wrong script path.) Verify afterwards instead: Step 9b has the procedure for Tempo's verifier.

---

## Tempo, before you deploy it — read this once

Tempo is EVM (`eip155`) and joins the standard flow, but it differs from the other 14 in four ways
that all bite during a deploy. Everything below was read from the chain on 2026-09-02.

| | Tempo Mainnet | Tempo Moderato |
|---|---|---|
| chain id | `4217` | `42431` |
| canonical RPC | `rpc.mainnet.tempo.xyz` | `rpc.moderato.tempo.xyz` |
| alias (same chain) | `rpc.tempo.xyz` | `rpc.testnet.tempo.xyz` |
| v3 escrow `0xa61a0C02…` | **live** | **live** |
| v4 escrow | absent | absent |
| `defaultAdmin` on v3 | `0xf92f2F17…` | `0xf92f2F17…` |
| deployer gas balance | **0.445863 pathUSD** | ~1,000,000 pathUSD |

**1. Gas is paid in pathUSD, not a native coin.** `cast balance` returns
`4242424242…4242` on *both* chains — a placeholder, byte-identical, unrelated to spendable gas.
Priced through the ordinary funding path that reads as astronomically over-funded. Phase 5 routes
Tempo through `token_gas_meta()` instead and reads the ERC-20 balance at
`0x20C0000000000000000000000000000000000000` (6dp). **Tempo Mainnet is currently unfunded for a
deploy** — 0.45 pathUSD against a 1000 floor — so expect `FUND (token-gas)` there and fund it before
Step 7. Moderato is already seeded.

**2. The v4 address is predetermined, so there is nothing new to record.** Permit2 is present at the
canonical `0x000000000022D473030F116dDEE9F6B43aC78BA3` on both chains with byte-identical code to
Base, so the constructor args — and therefore the initcode hash — match every other chain on that
network. Tempo lands on the existing pair: `0x815d450F…`/`0xA8F40Ed7…` on 4217,
`0x0F875601…`/`0x1F1F8FA6…` on 42431. If your derived address differs, stop: something about the
salt or the args has drifted, and that is the signal Phase 6 exists to catch.

**3. Its token set is the largest of any chain — five per chain, all predeploys.** Every Tempo token
sits at a deterministic `0x20C0…` address rather than being deployed by anyone:

| Tempo Mainnet (4217) | Tempo Moderato (42431) |
|---|---|
| pathUSD `0x20C0000000000000000000000000000000000000` | pathUSD `0x20C0000000000000000000000000000000000000` |
| rUSD `0x20c0000000000000000000007F7ba549dd0251B9` | alphaUSD `0x20C0000000000000000000000000000000000001` |
| USDT0 `0x20C00000000000000000000014f22CA97301EB73` | betaUSD `0x20C0000000000000000000000000000000000002` |
| SBC `0x20C000000000000000000000Ae247A1130450f09` | thetaUSD `0x20C0000000000000000000000000000000000003` |
| USDC.e `0x20C000000000000000000000b9537d11c60E8b50` | USDC.e `0x20C0000000000000000000009e8d7eB59B783726` |

pathUSD is at the same address on both chains, and it is also the gas token — so it is both a
configured asset and the thing you fund with.

**4. 🔴 Tempo already runs a live v3, and the namespace flags currently break it. Order matters.**

Unlike the other 14 chains, you are not deploying into empty space. v3 is serving on both Tempo
chains, and the now-enabled `eip155` namespace switches Tempo to a widened witness that the **v3**
escrow rejects. That is a live regression on Tempo, independent of anything in this
guide. Deploying v4 does not fix it and can make diagnosis harder, because two generations will be
live at once with the flag pointing at the wrong one.

Required order:

1. **Settle the v3 witness rejection first** — either it is resolved out of band, or you explicitly
   accept that Tempo stays broken while you deploy. This guide deliberately does not prescribe the
   remediation: step 5 below is the v4 cutover, not a fix for the live v3 rejection. Do not start Step 7 for Tempo on the assumption that the deploy resolves it —
   it does not.
**2. Tempo caps a single transaction at 30,000,000 gas, and forge's default margin exceeds it.**
The v4 Escrow deployment estimated about **24.47M** gas, which is comfortably under the cap — but
`forge script` defaults to `--gas-estimate-multiplier 130`, asks for **31,807,465**, and the node
rejects it. (The library generation is bigger. `cast estimate` of the actual CREATE2-factory call on Moderato, which
is what forge sends, measured **26.64M** for the linked Escrow (26,060 B of initcode) and **5.07M** for
`EscrowReserveLib`, 2026-10-21; an estimate of a bare `--create` reads about 0.9M lower and is not the
number the node sees. 30M / 26.64M puts the ceiling at multiplier **112**; use **107**, which is what
`deploy.sh` suggests (28.5M, 5% under the cap, 7% over the estimate). The library is a separate, smaller
transaction and fits at the default margin: 5.07M x 1.30 = 6.59M.) What the real deploy used, per
transaction, is in `contracts/evm/deployments-v5.json`.

```
Error: Failed to send transaction after 4 attempts
  error code -32000: transaction gas limit (31807465) is greater than the cap (30000000)
```

That reads as a transaction too large for the chain. It is not — the transaction fits; the *safety
margin* does not. Lower the margin and it goes through. For the linked generation use **107**:

```bash
EXTRA_FORGE_FLAGS='--gas-estimate-multiplier 107' CHAINS="42431" NETWORK=testnet atum-evm-deploy --broadcast
```

`26.64M × 1.07 = 28.5M`, about 5% under the cap. (The v4 escrow was smaller: `24.47M × 1.17 = 28.6M`,
about 4.6% under the cap, so v4 used 117, which would ask for 31.2M here and fail.) There is **no** `foundry.toml` key or `FOUNDRY_*`
env var for that flag (checked against forge 1.7.1 `forge config`), so `EXTRA_FORGE_FLAGS` exists
purely to reach it. `deploy.sh` now detects this failure and prints the fitting multiplier for you.

> Do not reach for `--gas-limit` here: in forge 1.7 it is an alias for `--block-gas-limit`, which
> configures the local EVM rather than the transaction that gets sent, so it does not move what the
> node sees.

> **The mainnet deployer is EIP-7702 DELEGATED on Tempo Mainnet** (`0xef0100 63c0c19a282a1b52…`;
> `0xef0100` is the 7702 designator prefix). It is not delegated on Moderato. `deploy.sh` detects
> this and forces `--slow`, because op-geth refuses gapped-nonce transactions from a delegated
> account — which is what forge does when it fires the script's 6 transactions without waiting.
> Signing is unaffected; expect the run to take longer as the transactions go one at a time.

**Both Tempo chains share a 30,000,000 per-transaction cap while reporting a 500,000,000 block gas
limit**, so the block limit is not the constraint and cannot be used to predict it. Verified on both.

3. ~~Fund Tempo Mainnet with pathUSD.~~ **Not needed — this was a false blocker.** The real
   Moderato deploy cost **0.023466 pathUSD** across its 6 transactions (measured 2026-09-02), which
   scales to about **0.0205** at Tempo Mainnet's cheaper gas. Tempo Mainnet holds **0.4459 pathUSD**
   — roughly **22x** what the deploy needs. The earlier `FUND ... 999.55` verdict came from a
   `TEMPO_GAS_FLOOR` of 1000 guessed off Moderato's ~1,000,000 seed, about **42,000x** the true
   cost. The floor is now the measured 0.25, and Tempo Mainnet reports `OK (token-gas)`.
4. Deploy v4 (Step 7 for Moderato, Step 10 for mainnet). v3 keeps serving throughout; nothing in the
   deploy touches it.
5. Seed the 5 token configs per chain (Step 8). Fresh escrow, so nothing carries over from v3.
5. **Only then** repoint the flag/config at v4, as a deliberate cutover. That is the step that ends
   the v3 witness rejection, and it is not part of deploying.

Deploying before step 1 is decided is the mistake to avoid: it leaves a chain with two live escrow
generations, a flag selecting a witness one of them rejects, and no record of which was intended.

## STEP 7 — Deploy the testnet chains

Use the driver: **`atum-evm-deploy`**

```bash
NETWORK=testnet atum-evm-deploy                          # SIMULATE all 7 (default — moves no funds)
NETWORK=testnet atum-evm-deploy --broadcast              # real deploy; prompts for confirmation
CHAINS="84532 421614" NETWORK=testnet atum-evm-deploy    # subset
OUT=~/run2 NETWORK=testnet atum-evm-deploy --broadcast   # custom output dir
```

Chains (authoritative: `config-manifest.yaml` → `active_chains.testnet.evm`):
Ethereum Sepolia `11155111` · Arbitrum Sepolia `421614` · Base Sepolia `84532` ·
Celo Sepolia `11142220` · Polygon Amoy `80002` · Optimism Sepolia `11155420` · Avalanche Fuji `43113`

> **Do not deploy BNB Testnet `97` or Celo Alfajores `44787`.** They exist in the deployments JSONs but
> are excluded from `active_chains` and appear in no service chain file. They are not in the script's
> table.

### What it does per chain

1. **Refuses up front** unless `forge config` matches the canonical settings — a wrong tree changes
   the bytecode and therefore the address, silently.
2. Derives the expected addresses once and asserts the Escrow creation code is `ESCROW_BYTES` long.
3. **Preflight:** RPC reachable and reporting the right chain id, CREATE2 factory present, Permit2 has
   code, deployer non-zero (broadcast mode only).
4. **Classifies what actually landed and resumes accordingly.** This matters because
   `forge script` sends the script's **six** transactions (2 CREATE2 deploys + 4 role grants)
   sequentially with **no rollback** — so any one of them can be the last that succeeded.

   | State detected | Meaning | Action |
   |---|---|---|
   | `FRESH` | neither contract has code | run the full script |
   | `COMPLETE` | both contracts + all 4 roles present | **skip** |
   | `ROLES_INCOMPLETE` | contracts up, some role missing | **auto-repair** — runs only the missing grant scripts |
   | `HALF_DEPLOYED` | one contract exists, the other does not | **refuses**, and says why |

   Roles are checked individually with `hasRole(bytes32,address)` against the expected holder, so a
   grant that failed at transaction 4 of 6 is detected rather than masked. Auto-repair is safe because
   OpenZeppelin's `_grantRole` is idempotent — `if (!hasRole(...))`, returns false, never reverts.

   `HALF_DEPLOYED` is deliberately not auto-resumed: re-running the all-in-one script would revert on
   the CREATE2 that already succeeded, because that address is occupied. The driver says which half
   exists. For the library generation a missing Escrow is deployed by hand, library first, then
   `DeployEscrowOnly.s.sol`, each with `--libraries` and `ESCROW_RESERVE_LIB_ADDRESS`, as in Step 10
   (a v4 tree has no Escrow-only script: stop). A missing proxy is deployed with
   `deploy-fulfillment-proxy.sh` (below), but if `$FPROXY` already has code, the tree builds a
   different proxy and deploying it is a cutover, not a repair. Re-run the driver afterwards for the roles.

5. Deploys, then **verifies the deployed address equals the predicted one**, reading
   `broadcast/.../run-latest.json` rather than scraping stdout.
6. On failure: prints the last 12 log lines and keeps going. One bad chain does not abort the rest.

### Bytecode-only FulfillmentProxy redeploy

This is not Step 7 and not Step 10. Testnet and mainnet already have Escrow, so
`DeployCoreContracts.s.sol` and `DeployAndConfigureAllRoles.s.sol` revert on that CREATE2.
`DeployFulfillmentProxy.s.sol` deploys only the proxy, through the same CREATE2 factory, and grants
`PAUSER_ROLE` in the same broadcast.

**The address moves.** The CREATE2 address is a function of `SALT`, the deployer (the constructor's
`defaultAdmin`) and the bytecode. The same `SALT` and deployer give a new address whenever the
bytecode changes: #167 moved testnet `0x1F1F…BaFeb` to `0x3f2F…700c`, and CORE-2710 (#217) moved it
again, to `0xd1254EF0f2bc75AD577FE48fC5CC9c3ec13B0144`, deployed on all 8 testnets on 2026-10-25 with
this runner (CORE-2902). The earlier `0x3f2F…700c` predates `whenNotPaused` on `authorizeFulfillment`
and is being retired. Mainnet moves from `0xA8F4…6c83` to `0x1FaF7640110Fb09BaD288dBEf5B4f676b0eC1932`
at `a58ff7c0`. Re-derive whenever any of the three changes.

**Adopting the new proxy is a cutover, in this order.** Each payment delivers to the proxy it names,
and veri-fill takes the proxies it releases against and scans for delivery only from its own chain
table. A proxy the settler trusts but veri-fill does not list is delivered to, its release refused,
and then refunded after the deadline.

1. **veri-fill lists both proxies**, in atum-core's `veri-fill/config/chains/<testnet|mainnet>.yaml`
   (`contracts.fulfillment_proxy` as a list, old proxy first), and is deployed. atum-core's
   `veri-fill/internal/config/settler_proxy_parity_test.go` fails when the pinned settler trusts a
   proxy this table omits.
2. **The settler trusts it**: settler-agent's `packages/agent/src/plugins/evm/config.yaml`
   `fulfillmentProxy` list, repinned in atum-core.
3. **Every settler Turnkey policy allows it** (below).
4. **payment-gw's default moves to it**: `payment-gw/config/config.yaml` `chain_defaults`
   `fulfillment_proxy_contract_address`.

Keep the old proxy in all four for at least the longest quote deadline plus `FulfillMargin` plus
finality after the last payment created on it. Separately, veri-fill's refund gate counts only
`Fulfilled` and `FulfilledMany` as delivery, never `FulfillmentAuthorized`, so an originator-fulfill
payment that is not released before its deadline can be refunded on request whatever the tables
say (CORE-2781).

**Run it through `deploy-fulfillment-proxy.sh`.** A human runs it, from any directory, with
`$NETWORK.env` in place; the chain set is that file's `CHAIN_TABLE` narrowed by `CHAINS`. Both
templates default `CHAINS` to one Tempo chain (`4217` on mainnet, `42431` on testnet), so a run on
the defaults touches that chain only: export `CHAINS=` (empty) for the whole table, or
`CHAINS="1 8453"` for some of it. Without `--broadcast` it is a dry-run that simulates with
`--sender` alone and never unlocks the keystore.

```bash
# dry-run: prints the simulated address and gas per chain
NETWORK=mainnet contracts/evm/deploy/deploy-fulfillment-proxy.sh --sender "$DEPLOYER" --salt "$SALT" \
  --expect <address>

# broadcast, once every chain simulated the expected address
NETWORK=mainnet contracts/evm/deploy/deploy-fulfillment-proxy.sh --sender "$DEPLOYER" --salt "$SALT" \
  --expect <address> --password-file <path> --broadcast --slow
```

Testnet sender is `0x11121EECf186b5365C3E65A7B16BfD231eAC76B5`. Mainnet sender is
`0xf92f2F170C2f649AE8CF07A8a84c43C74d65fE5A`.

From `deploy.sh` it keeps the canonical forge-config refusal, the chain-id preflight, the
independent address pin (`--expect`, which the script enforces as `EXPECT_FPROXY` before it
broadcasts), and a post-broadcast check of the chain itself. It adds its own:

- `$NETWORK.env` must exist, and its `DEPLOYER` and `ESCROW` are used even if the shell exports
  others (it refuses when they differ);
- `--sender` must be that `DEPLOYER`;
- `--expect` must be the address this tree, `--sender` and `--salt` produce, and neither the Escrow
  nor `$FPROXY`. This runs before any chain is touched, so `--expect` cannot point the "already
  deployed" and pauser-repair paths at another contract;
- the script requires code at `$ESCROW`;
- after broadcast it reads `hasRole(PAUSER_ROLE, pauser)` on the chain.

Skip it and run the bare `forge script` command in the script's header only if you re-create those
checks by hand.

**Pauser.** The constructor grants only `DEFAULT_ADMIN_ROLE`, so the script grants `PAUSER_ROLE` to
`FP_PAUSER_ADDRESS` (both env templates default it to the deployer, as the live proxies have it;
`--pauser` overrides). On a chain where this proxy already exists without that pauser, a dry-run
reports `INCOMPLETE` and `--broadcast` grants it. The runner only repairs the proxy this tree builds.
The retiring testnet `0x3f2F…700c` predates #217, so the runner refuses it by design; its deployer was
granted `PAUSER_ROLE` directly on all 8 testnets (CORE-2817), per chain, from `contracts/evm/source`:

```bash
CONTRACT_ADDRESS=0x3f2F4Fa9EA195028f534851ddFd26994e4e3700c PAUSER_ADDRESS="$DEPLOYER" \
  forge script script/access-control/grant/GrantPauserRole.s.sol \
  --rpc-url <RPC> --account atum-deployer-testnet --sender "$DEPLOYER" --broadcast
```

Confirm per chain:

```bash
cast call <address> 'hasRole(bytes32,address)(bool)' \
  0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a "$FP_PAUSER_ADDRESS" --rpc-url <RPC>  # true
cast call <address> 'defaultAdmin()(address)' --rpc-url <RPC>        # $DEPLOYER
cast call <address> 'defaultAdminDelay()(uint48)' --rpc-url <RPC>    # 1 until changed
cast call <address> 'paused()(bool)' --rpc-url <RPC>                 # false
cast call <address> 's_settlerAllowlistEnforced()(bool)' --rpc-url <RPC>  # false until enabled
```

**Admin, delay and the settler allowlist (mainnet).** After the deploy, the deployer EOA is admin of
every mainnet proxy, with a 1-second delay, as it is of the old proxy and the Escrow. The handover
is CORE-2268, due before payment-gw's default moves to the new proxy (CORE-2814). Per proxy and
chain:

1. Raise the delay with `script/access-control/admin/ChangeDefaultAdminDelay.s.sol` while the EOA
   still holds admin. An increase takes effect after `min(newDelay, defaultAdminDelayIncreaseWait())`,
   which is 5 days on these contracts.
2. Run `BeginFulfillmentProxyAdminTransfer` with `NEW_PAUSER_ADDRESS` set to a dedicated pauser key,
   not the Safe, so an incident pause does not need a multisig transaction. Then set
   `FP_PAUSER_ADDRESS` in the env file to that key; otherwise `deploy.sh`, `run-all.sh` and this
   runner report the pauser missing and attempt a grant the deployer can no longer make.
3. The new admin accepts after the delay. A Safe cannot run `AcceptFulfillmentProxyAdminTransfer`:
   it accepts with a Safe transaction calling `acceptDefaultAdminTransfer()` on the proxy.

The settler allowlist ships off, so while it stays off anyone can read a `quoteHash` from
`Escrow.Deposited` and front-run `strictFulfill` with a dust token to burn that payment's marker.
Enabling it means granting `SETTLER_ROLE` to every settler wallet, then calling
`setSettlerAllowlistEnforced(true)` as admin. Whether to do that before the cutover is an open
decision: CORE-2515 plans per-settler marker keying in the next contract release instead.

**Allow the new proxy in every settler's Turnkey policy first.** Turnkey pins `eth.tx.to`, so a
settler whose policy does not list the new proxy gets HTTP 403 on every transaction to it. Before
anything points at the new proxy:

- add it to `allowedTo` on every EVM chain whose agent config lists it under `fulfillmentProxy`, and
  to `allowedSelectors` as `0x15922c85` (`authorizeFulfillment`) wherever selectors are restricted;
- if the settler moves tokens through it, add it to `approveDeny` `allowedSpendersHex` too;
- keep the old proxy allowed while anything still sends to it (staging-testnet and prod-testnet
  share a Turnkey org);
- re-run `apply-policies` for each settler sub-org.

protocol#206 does this for `settler-testnet.example.yaml`. Since CORE-2719 (protocol#198), every
settler config also needs a `transferWithAuthorizationTokens` block (`{}` if the settler does no
EIP-3009), and `apply-policies` refuses one without it, so add that in the same change. See
`key-management/providers/turnkey/typescript/scripts/PROVISIONING.md`.

**Record it.** Step 11 lists where the address lives. `deployments-v4.json` records the new proxy as
`FulfillmentProxyPreview`, beside `FulfillmentProxy` (#218). The env files' `FPROXY` stays the old
proxy until the cutover, and this tree builds the new one. The templates default `DEPLOY_PROXY` to
`0`, under which `run-all.sh` phase 6 does not check the proxy at all. With `DEPLOY_PROXY=1` it fails
on both networks (`fproxy initcode-hash drift`, then a derived address that is not `$FPROXY`:
`0x1FaF…` on mainnet, `0xd125…` on testnet, both already live as `FulfillmentProxyPreview`). That is
expected until the cutover moves `FPROXY`.

### Outputs (default `~/atum-v4-deploy-run/`)

(The directory name is a leftover from the v4 deploy: it holds the output of every generation. Set `OUT` to
name a run, as in the examples above.)

| Path | Contents |
|---|---|
| `addresses.json` | expected pair + per-chain status and actual addresses |
| `summary.tsv` | one row per chain: `chain_id, name, status, escrow, fulfillment_proxy` |
| `logs/<chainid>.log` | full forge output for that chain, success or failure |
| `logs/<chainid>.broadcast.json` | copy of the broadcast record (broadcast mode) |

Statuses: `SIMULATED`, `DEPLOYED`, `COMPLETE`, `REPAIRED`, `REPAIR_FAILED`,
`ROLES_INCOMPLETE:<which>`, `HALF_DEPLOYED`, `PREFLIGHT_FAIL: <reason>`, `FAILED`,
`ADDRESS_MISMATCH`. Exit code is non-zero if anything failed.

**Re-running after a partial failure is the intended path.** Deploy all eight, and if two fail, just
run it again — the five that succeeded come back `COMPLETE` and cost nothing but a few `eth_call`s.
Use `CHAINS="..."` to narrow it if you prefer, but you do not have to.

### Fund before you simulate

Verified on the pre-Tempo seven: a simulate run with an unfunded deployer **succeeds on 5 of those 7
and fails on Base Sepolia and Optimism Sepolia** with `transaction validation error: lack of funds
(0) for max fee (…)`. Tempo was not in that run, so treat the ratio as the recorded observation it is
rather than a prediction for your eight — the rule it illustrates is what matters.
OP-stack chains enforce the fee check during simulation; the others do not. So fund all eight first —
the simulate pass is then a genuine end-to-end rehearsal, not just a compile check.

Chains that do simulate should produce **exactly** the addresses you derived in Step 6a. That
agreement is the real check — it confirms the derivation matches what the deploy path actually does.
A simulate that yields a different address means the derivation inputs and the deploy inputs disagree;
do not broadcast.

### Roles

Defaults are all four role env vars set to the deployer, matching the v3 testnet precedent. Override
for anything other than testnet:

```bash
ESCROW_PAUSER_ADDRESS=0x… ESCROW_TREASURER_ADDRESS=0x… \
ESCROW_TOKEN_CONFIG_ADDRESS=0x… FP_PAUSER_ADDRESS=0x… \
  NETWORK=testnet atum-evm-deploy --broadcast
```

`DEFAULT_ADMIN_ROLE` stays with the deployer either way — hand it over per Step 10.

## STEP 8 — Token config, per chain

`AllowTokenAndSetFeeConfig.s.sol` needs **six** env vars, not one. Missing any of them reverts with
`vm.envAddress: environment variable "X" not found` before it touches the chain.

| Env var | Value | Meaning |
|---|---|---|
| `CONTRACT_ADDRESS` | the **Escrow** address | not the proxy |
| `TOKEN_ADDRESS` | per chain, see table | the ERC-20 |
| `TOKEN_DECIMALS` | `6` for every token below | |
| `FEE_PERCENTAGE` | `20000` | scaled 1e6 → 0.02% = **2 bps** |
| `MIN_FEE` | `0` | no floor (v3 precedent) |
| `MAX_FEE` | `250000000` | scaled 1e6 → **$250** cap |

`--sender` must hold **`TOKEN_CONFIG_ROLE`**, which is the deployer on testnet.

> **`MAX_FEE` has no default and `0` means UNCAPPED, not zero.** The script's own header says it:
> *"MAX_FEE has no default — whatever you export is written on-chain — and this comment is the only
> guidance in the repo, so it is the control surface for a deployment."* `ITokenConfig.TokenConfig`
> confirms `maxFee6Decimals … 0 = uncapped (no maximum)`. Export it explicitly, every time.

> **The cap is denominated in token units, so it is only $250 for a 6-decimal token.** All 15 registry
> tokens on the active testnets are 6-decimal (verified), so `250000000` is correct everywhere today.
> An 18-decimal token would make that same number a $0.00000025 cap.

### Use the driver

The registry-driven driver is **not in this repository**. It dispatches on a token registry that
lives in `atum-core`, and vendoring that list here would immediately fork it, so the driver lives
next to the registry as `contracts/evm/token-config.sh` there. It reads the forge project from this
repository and reports which tokens it would add or update.

> **Atum operators:** run it from an atum-core checkout. `atum-evm-run-all` phase 8 does not run it
> and says so; nothing else in this tree reports token state, so that run is your only confirmation
> that the fee cap was applied.

Without an atum-core checkout, use the **manual form** below: the forge scripts are in this
repository and the token addresses are tabulated above, so every token can be configured by hand.
The driver dispatches on **actual on-chain state**, because the two scripts are not
interchangeable, and the manual form makes you pick:

| On-chain state | Script | Why |
|---|---|---|
| not allowed | `AllowTokenAndSetFeeConfig` | allow + set fee in one tx |
| allowed, fee/min/max differ | **`SetTokenFeeConfig`** | `_allowToken` would revert |
| allowed, all three match | **skip** | nothing to do |
| allowed with different decimals than the registry | **refuse** | reconcile before touching it |

> **Why an already-allowed token cannot go through `AllowTokenAndSetFeeConfig`.** `_allowToken` has
> `require(!_isTokenAllowed(token), TokenAlreadyAllowed(token))`, so it **always reverts** on a
> re-run. `_setTokenFeeConfig` has the exact inverse, `require(_isTokenAllowed(token),
> TokenNotAllowed(token))`. That is why both scripts exist, and why a repeat run has to pick between
> them rather than just retrying the first one.

Repeat runs and partial failures are the intended path: already-correct tokens report `ALREADY_SET`
and cost only two `eth_call`s each. If a `TokenAlreadyAllowed` or `TokenNotAllowed` revert does slip
through — the state changed between the read and the write — it is recorded as a **skip**, not a
failure, and the next run settles it.

Also: refuses any token whose decimals are not 6 unless you override `MAX_FEE` deliberately, and
forces `--slow` where the sender is a delegated (EIP-7702) account. Logs per chain to
`~/atum-v4-tokencfg/logs/`.

> **On-chain decimals are checked for you.** `_allowToken` staticcalls the token's `decimals()` and
> reverts `TokenDecimalsMismatch` if your `TOKEN_DECIMALS` disagrees — so a wrong value cannot be
> written for any token that exposes `decimals()`.

Other validation that will reject a bad config rather than store it: `feePercentage > 100_000_000`
(100%) reverts; `minFee > maxFee` reverts when both are non-zero; and `maxFee > 0` with
`feePercentage == 0` reverts as `FeePercentageCannotBeZeroWhenMaxFeeIsSet`.

### The 25 token configs

| Chain | Tokens |
|---|---|
| Ethereum Sepolia `11155111` | USDC `0x1c7D4B19…7238`, USDT `0xaA8E23Fb…33D0`, PYUSD `0xCaC524Bc…3bB9` |
| Arbitrum Sepolia `421614` | USDC `0x75faf114…AA4d`, USDT `0x93d67359…7248`, PYUSD `0x637A1259…B1B1` |
| Base Sepolia `84532` | USDC `0x036CbD53…CF7e`, **rUSD** `0x6122C596…0314` |
| Celo Sepolia `11142220` | USDC `0x01C5C012…C44E`, USDT `0xd077A400…4fDb` |
| Polygon Amoy `80002` | USDC `0x41E94Eb0…7582` |
| Optimism Sepolia `11155420` | USDC `0x5fd84259…30D7`, USDT `0x7e09Dd0b…C8a2` |
| Avalanche Fuji `43113` | USDC `0x54258902…Bc65`, USDT `0x134Dc38A…6682` |

> **Do not miss `rUSD` on Base Sepolia.** It is Rain USD, the token for the **credit-coop corridor**.
> My first pass at parsing the registry dropped it, because the symbol has a lowercase letter and
> the regex only matched `[A-Z0-9]+`. If you configure tokens by
> hand rather than with the driver, enumerate the YAML directly and do not assume symbols are
> uppercase.

### Manual form, if you prefer

```bash
CONTRACT_ADDRESS=$ESCROW_ADDRESS \
TOKEN_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e \
TOKEN_DECIMALS=6 FEE_PERCENTAGE=20000 MIN_FEE=0 MAX_FEE=250000000 \
  forge script script/token-config/AllowTokenAndSetFeeConfig.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC --account "$ACCOUNT" --sender $DEPLOYER --broadcast --slow
```

Verify with `cast call $ESCROW 'getTokenConfig(address)((uint88,uint80,uint80,uint8))' $TOKEN --rpc-url $RPC`
— expect `(20000, 250000000, 0, 6)`. The tuple order is `feePercentage, maxFee, minFee, decimals`: a zero
in the first slot is "no fee", and a zero in the second is "uncapped", not "free".

### Mirroring an existing escrow exactly (Tempo Mainnet, CORE-3264)

The registry-driven driver and a live escrow's allowlist can disagree, and the driver then gives the wrong
list. For Tempo Mainnet the atum-core registry (`config/tokens/mainnet.yaml`, `eip155:4217`) lists six tokens
(no GBPA) in the checkout read on 2026-10-28, while the live **v4** escrow `0x815d450F…` allows seven. The new
escrow `0xedaD6a98…` mirrors v4, so the per-token scripts above are the way to reproduce it, one transaction
per token, rather than `token-config.sh`:

| Token | Address |
|---|---|
| pathUSD | `0x20C0000000000000000000000000000000000000` |
| rUSD | `0x20c0000000000000000000007F7ba549dd0251B9` |
| USDT0 | `0x20C00000000000000000000014f22CA97301EB73` |
| SBC | `0x20C000000000000000000000Ae247A1130450f09` |
| USDC.e | `0x20C000000000000000000000b9537d11c60E8b50` |
| OUSD | `0x20c0000000000000000000006a37DA5C996874BE` |
| GBPA | `0x20C0000000000000000000000a6Da882d075a4C3` |

All seven are 6-decimal, and every one gets fee `20000` (2 bps), min `0`, max `250000000`. The max is the $250
cap that veri-fill signs with: an escrow whose max differs from it makes the release and refund transactions
revert, so do not tune it per token. v4 differs on two of them: it charges **zero** on OUSD and GBPA
(`getTokenConfig` reads `(0, 0, 0, 6)`; Tasos called that a config gap on 2026-10-21). The new escrow charges
2 bps on both. The seven read back with exactly these values on 2026-10-28.

Which script, per token, follows the state table above. For a token that is not yet allowed
(`AllowTokenAndSetFeeConfig`, six variables; `AllowToken` takes only `CONTRACT_ADDRESS`, `TOKEN_ADDRESS` and
`TOKEN_DECIMALS`, for an allow with no fee config to be set later):

```bash
CONTRACT_ADDRESS=0xedaD6a9846c79A64449603e95F8c77fd5A46881b TOKEN_ADDRESS=0x20c0000000000000000000006a37DA5C996874BE \
TOKEN_DECIMALS=6 FEE_PERCENTAGE=20000 MIN_FEE=0 MAX_FEE=250000000 \
  forge script script/token-config/AllowTokenAndSetFeeConfig.s.sol \
  --rpc-url https://rpc.mainnet.tempo.xyz --account atum-deployer-mainnet --sender 0xf92f2F170C2f649AE8CF07A8a84c43C74d65fE5A \
  --broadcast --slow
```

For a token that is already allowed (the three fee variables only, no `TOKEN_DECIMALS`), as when OUSD and
GBPA were allowed first at zero fee and moved to 2 bps after:

```bash
CONTRACT_ADDRESS=0xedaD6a9846c79A64449603e95F8c77fd5A46881b TOKEN_ADDRESS=0x20c0000000000000000000006a37DA5C996874BE \
FEE_PERCENTAGE=20000 MIN_FEE=0 MAX_FEE=250000000 \
  forge script script/token-config/SetTokenFeeConfig.s.sol \
  --rpc-url https://rpc.mainnet.tempo.xyz --account atum-deployer-mainnet --sender 0xf92f2F170C2f649AE8CF07A8a84c43C74d65fE5A \
  --broadcast --slow
```

The sender needs `TOKEN_CONFIG_ROLE`, so run token config **before** the handover in Step 10 revokes the
deployer's roles. Read every token back:

```bash
cast call 0xedaD6a9846c79A64449603e95F8c77fd5A46881b 'getTokenConfig(address)((uint88,uint80,uint80,uint8))' \
  0x20c0000000000000000000006a37DA5C996874BE --rpc-url https://rpc.mainnet.tempo.xyz    # (20000, 250000000, 0, 6)
```

## STEP 9 — Verify before pointing anything at it

```bash
# widened typehashes, against the LIVE contract
../../deploy/assert-typehashes.sh --deployed $ESCROW --rpc $RPC

# selectors resolve (a bare address with no fallback() reverts every deposit with EMPTY returndata)
cast call $ESCROW 'i_permit2()(address)'          --rpc-url $RPC
cast call $ESCROW 'getDepositHash(bytes32)(bytes32)' 0x00..00 --rpc-url $RPC

# allowlist is dormant
cast call $FP 's_settlerAllowlistEnforced()(bool)' --rpc-url $RPC     # expect false

# admin delay is not 1 second
cast call $ESCROW 'defaultAdminDelay()(uint48)'   --rpc-url $RPC
```

> **Note on the typehash gate — three checks, three moments.** The *source* check is
> `test/EncodingExamples.verify.t.sol`, which rebuilds each type string from the `struct`
> declaration in `src/interfaces/IEscrow.sol` and runs in CI on every PR; it is the strongest of
> the three and the authority if they ever disagree. The *artifact* check is
> `contracts/tvm/source/docker/assert-widened-witnesses.js`, which is Tron-only by design — it
> reads the tronbox `build/contracts/Escrow.json` and never touches a chain. `assert-typehashes.sh`
> deliberately does neither: it only asserts against a **deployed address** via `cast code`, which
> is the one question the other two cannot answer. See
> [`../../deploy/README.md`](../../deploy/README.md).
>
> The typehashes are **identical across EVM and TVM** — the typehash is `keccak256(typeString)` and both
> VMs pin the same strings; TIP-712 and EIP-712 differ in the *domain separator*, not these constants.
> Verified: the same four hashes (`0x49bfb2c3…`, `0x231586e0…`, `0x7b53386f…`, `0x3b5d88b2…`) appear in
> both compiled trees, and the two V1 hashes in neither.
>
> **All 7 deployed testnet escrows pass this check** — asserted against live bytecode, 0 failures.
> Re-run it before repointing any config, and again on mainnet before handover.

Then a smoke on one chain: deposit → reserve → fulfill → release with a markup, asserting the wallet
debit equals `sourceAmount` (strictly below the authorized ceiling) and that release and refund both
succeed with no `InvalidWitnessValues`.

### 9a. Prove the bytecode equals a reference deployment (a new chain, same generation)

When the same generation is deployed to another chain, the proof that it is the same code is a comparison
of runtime bytecode with a chain that already has it, not the address alone. Same source, salt and compiler
give the same library byte for byte; the escrow differs only in its immutables: the EIP-712 cached domain
separator, the cached chain id and `address(this)`, which compile to `PUSH32` (and, for the address, `PUSH20`)
operands. The reference is Tempo Moderato (`0x2db35C05…` escrow, `0x88090131…` library, from
`deployments-v5.json`) or any chain already compared. Save this once as `cmp_runtime.py`; it walks both
bytecodes opcode by opcode and fails on any differing opcode or any differing operand that is not a 20- or
32-byte push:

```python
#!/usr/bin/env python3
# usage: cmp_runtime.py <runtime-hex-A> <runtime-hex-B>
# Both args are files holding `cast code` output. Walks both bytecodes opcode by opcode and reports every
# operand that differs. Expected for the same Escrow on two chains: only PUSH32 / PUSH20 operands (the
# EIP712 cached domain separator, cached chain id, cached address(this)) and nothing else.
import sys, collections
def load(p):
    h = open(p).read().strip()
    return bytes.fromhex(h[2:] if h.startswith("0x") else h)
a, b = load(sys.argv[1]), load(sys.argv[2])
if len(a) != len(b):
    print("FAIL: lengths differ", len(a), len(b)); sys.exit(1)
i, diffs, bad = 0, collections.Counter(), []
while i < len(a):
    op = a[i]
    n = op - 0x5f if 0x60 <= op <= 0x7f else 0
    if a[i] != b[i]:
        bad.append((i, "opcode", a[i], b[i]))
    elif n and a[i+1:i+1+n] != b[i+1:i+1+n]:
        diffs[n] += 1
    i += 1 + n
print("operand-only differences by PUSH width:", dict(diffs))
print("opcode differences:", len(bad))
for x in bad[:10]: print("  ", x)
ok = not bad and set(diffs) <= {20, 32}
print("RESULT:", "PASS (differences are PUSH20/PUSH32 immutables only)" if ok else "FAIL")
sys.exit(0 if ok else 1)
```

Run it, one shell, with the values on the command (the new chain's RPC replaces `RPC`; Tempo Mainnet is the
example):

```bash
mkdir -p ~/atum-v5-verify && cd ~/atum-v5-verify
RPC=https://rpc.mainnet.tempo.xyz; REF=https://rpc.moderato.tempo.xyz
ESCROW=0xedaD6a9846c79A64449603e95F8c77fd5A46881b; REF_ESCROW=0x2db35C05D04F8bB21C602735C4FA9eEc932c2536
LIB=0x88090131EC8bdFA1759f6B0e27d5aEa307b8eBBf
cast code "$REF_ESCROW" --rpc-url "$REF" > ref-escrow.hex
cast code "$ESCROW" --rpc-url "$RPC" > new-escrow.hex
python3 -I cmp_runtime.py ref-escrow.hex new-escrow.hex          # RESULT: PASS, exit 0
cmp <(cast code "$LIB" --rpc-url "$REF") <(cast code "$LIB" --rpc-url "$RPC") && echo LIB_IDENTICAL
```

On 2026-10-28 this gave, for Tempo Mainnet against Moderato, `PASS` with three `PUSH32` operands differing
(`{32: 3}`) and no opcode differences, and `LIB_IDENTICAL`. Any opcode difference, a length difference, or a
differing library means a different build: stop, and look at the preconditions in Step 1 before anything else.

### 9b. Verify the source on Tempo's verifier

Tempo's explorer takes verified sources from a Sourcify-compatible verifier at `https://contracts.tempo.xyz`.
It needs **no API key**, and nothing needs adding to `foundry.toml` (there is still no `[etherscan]` block, and
`--verify` on `forge script` stays off, Step 6). Run from `contracts/evm/source` of the same clean checkout the
deploy was built from (Step 1): the compiler settings come from its `foundry.toml` (solc 0.8.27, `via_ir`,
`optimizer_runs` 4294967295, `bytecode_hash` none, `cbor_metadata` false; `evm_version` is not set there, so
forge's own default applies, prague in forge 1.8.1), so a different tree, forge or `node_modules` can verify as
a mismatch. `--rpc-url`, `--verifier sourcify`,
`--verifier-url` and `--chain` are all Tempo-specific here: the other chains use their own explorers.

The library first, then the escrow, which links to it. Constructor arguments are `permit2` then the
deployer (the `defaultAdmin`):

```bash
cd contracts/evm/source
LIB=0x88090131EC8bdFA1759f6B0e27d5aEa307b8eBBf
forge verify-contract "$LIB" src/EscrowReserveLib.sol:EscrowReserveLib \
  --rpc-url https://rpc.mainnet.tempo.xyz --verifier sourcify --verifier-url https://contracts.tempo.xyz \
  --chain 4217 --watch

forge verify-contract 0xedaD6a9846c79A64449603e95F8c77fd5A46881b src/Escrow.sol:Escrow \
  --rpc-url https://rpc.mainnet.tempo.xyz --verifier sourcify --verifier-url https://contracts.tempo.xyz \
  --chain 4217 --watch \
  --constructor-args "$(cast abi-encode 'c(address,address)' 0x000000000022D473030F116dDEE9F6B43aC78BA3 0xf92f2F170C2f649AE8CF07A8a84c43C74d65fE5A)" \
  --libraries "src/EscrowReserveLib.sol:EscrowReserveLib:$LIB"
```

Read the result back; the verifier's own status, not the forge exit code, is the proof. Expect HTTP 200 and
`match` in all three fields:

```bash
curl -s -w ' HTTP %{http_code}\n' \
  'https://contracts.tempo.xyz/v2/contract/4217/0xedaD6a9846c79A64449603e95F8c77fd5A46881b?fields=match,creationMatch,runtimeMatch,verifiedAt'
```

Both Tempo Mainnet contracts were verified this way on 2026-10-29 with status `match` (library job
`89d059dc-c450-4edd-b952-f61f5bb29471`, escrow job `cbc0c421-3fcc-41fb-a1ee-838a3b058228`), and the read-back
above returned 200 with `match`, `creationMatch` and `runtimeMatch` for both addresses. If the verifier cannot
find the creation transaction, add `--creation-transaction-hash <hash>` with the hash of the transaction that
created that contract (the library's and the escrow's are in the deploy's broadcast record and in `deployments-v5.json`); this fallback was **not** run, so it is untested.

---

## STEP 10 — Mainnet

Chains: Ethereum `1` · Optimism `10` · Polygon `137` · Base `8453` · Arbitrum One `42161` ·
Celo `42220` · Avalanche C-Chain `43114` · Tempo Mainnet `4217`

**Do not use `DeployAndConfigureAllRoles`** — its own header says alpha/testnet only. Use:

```bash
PERMIT2_ADDRESS=$PERMIT2_ADDRESS SALT=$SALT \
  forge script script/deploy/DeployCoreContracts.s.sol \
  --rpc-url $RPC --account "$ACCOUNT" --sender $DEPLOYER --broadcast
```

**For the library generation (a tree with `src/EscrowReserveLib.sol`) that command alone is wrong.** It
would link the escrow to a library forge deploys itself, at an address no derivation produces. Deploy the
library first and pass its address twice (see "The escrow library"):

```bash
cd contracts/evm/source
# 1. The library, at its CREATE2 address. A no-op when it is already there.
SALT=$SALT forge script script/deploy/DeployEscrowReserveLib.s.sol \
  --rpc-url $RPC --account "$ACCOUNT" --sender $DEPLOYER --broadcast
# 2. Its address, derived the way the drivers do.
LIB=$(FACTORY=${FACTORY:-0x4e59b44847b379578588920ca78fbf26c0b4956c} SALT=$SALT \
      bash -c '. ../deploy/escrow-lib.sh && derive_escrow_link >/dev/null && echo "$WANT_LIB"')
# 3. The escrow, linked to it. The script reverts if the deployed escrow does not embed $LIB.
ESCROW_RESERVE_LIB_ADDRESS=$LIB PERMIT2_ADDRESS=$PERMIT2_ADDRESS SALT=$SALT \
  forge script script/deploy/DeployCoreContracts.s.sol \
  --libraries "src/EscrowReserveLib.sol:EscrowReserveLib:$LIB" \
  --rpc-url $RPC --account "$ACCOUNT" --sender $DEPLOYER --broadcast
```

`DeployCoreContracts` deploys the proxy too, so on a chain that already has it (every v4 chain) step 3
reverts on the second CREATE2. There, use `script/deploy/DeployEscrowOnly.s.sol` in its place, with
`ESCROW_PAUSER_ADDRESS`, `ESCROW_TREASURER_ADDRESS` and `ESCROW_TOKEN_CONFIG_ADDRESS` set to the real
holders, and the same `--libraries` and `ESCROW_RESERVE_LIB_ADDRESS`. It grants those three roles and
leaves the deployer as `DEFAULT_ADMIN_ROLE`, so the handover below still applies.

Then grant roles explicitly to the **real** addresses (`script/access-control/grant/*`), set token
config (Step 8), verify (Step 9), and hand over:

```bash
# Step 1 of the handover — run by the CURRENT admin. Grants the 4 roles to the new admin,
# revokes from current, and calls beginDefaultAdminTransfer on BOTH contracts.
ESCROW_ADDRESS=<escrow> FP_ADDRESS=<fp> NEW_ADMIN_ADDRESS=<safe> \
  forge script script/access-control/TransferAllRoles.s.sol:GrantRevokeAndBeginTransfer \
  --rpc-url $RPC --account "$ACCOUNT" --sender $DEPLOYER --broadcast

# wait defaultAdminDelay(), then the NEW ADMIN accepts on both contracts.
# If the new admin is the Safe this is a SAFE TRANSACTION, not a forge script —
# you cannot --account a Safe. The accept-side contract in the same file only helps
# when the incoming admin is an EOA you hold.
```

Set a real delay with `script/access-control/admin/ChangeDefaultAdminDelay.s.sol` or hand admin over first:
the two orders, and which one this deployment uses, are in "Handover order, role plan and the Safe" below.
Do not use `TransferAllRoles.s.sol` for a new escrow: it takes `FP_ADDRESS` and also begins an admin transfer
on the live v4 `FulfillmentProxy` (see below).

### Handover order, role plan and the Safe

**The role plan used for the Tempo Mainnet escrow** (`0xedaD6a98…`), from the CORE-2268 handover plan (the
2026-10-02 comment):

| Role | Holder | Note |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | the Safe `0x85B8530eAFbA1Cff05D64717fE7E6Ac1F6Fbb36c` | transfer per the order below |
| `TREASURER_ROLE` | the same Safe | interim exception, below |
| `TOKEN_CONFIG_ROLE` | the same Safe | interim exception, below |
| `PAUSER_ROLE` | a dedicated, fast-acting key, **not** a multisig | address **not yet decided** |

The Safe is Safe v1.4.1 and has the same address on every chain; code is present at that address on
eight of the nine mainnets (read 2026-10-28), including Tempo `4217`, and not yet on Arc `5042`
(read 2026-11-24), where the Arc deploy nevertheless granted it `TREASURER_ROLE` and
`TOKEN_CONFIG_ROLE` (see the Arc note above). On Tempo it reads threshold 1 with two owners, i.e.
**1-of-2 until CORE-2073 reconfigures it to 2-of-3**; the owners and threshold were not read on the other
chains. The pauser is a single key on purpose: pausing has to be fast, which a multisig is not. The
interim exception puts treasurer and token-config on the admin's own Safe, which adds no attack surface:
`grantRole` and `revokeRole` for these three roles are **immediate and not gated by the admin delay**, so an
admin can give itself any of them at once anyway. Split them off when a separate treasury signer exists.
(CORE-2268 also records that Ledger signing on Tempo needed confirming; not verified here.)

**The delay only gates admin changes.** It governs `DEFAULT_ADMIN_ROLE` transfers and changes to the delay
itself. The escrow is deployed with a delay of 1 second, and the Escrow NatSpec (`src/Escrow.sol`, the
constructor) describes the low value as a deployment convenience. A raise is itself scheduled: OpenZeppelin's
`AccessControlDefaultAdminRules` makes an increase effective after `min(newDelay, defaultAdminDelayIncreaseWait())`,
and that wait is 5 days (`432000`, read from the live escrow), so a delay of 30 days is in force 5 days after
the call and the delay stays 1 second until then. `beginDefaultAdminTransfer` reads the delay **when it is
called**, and the new admin may accept only once that schedule has passed.

**Two orders, and the sources disagreed.** Step 10 used to tell the operator to raise the delay before
handing admin over; the Escrow NatSpec says to transfer first and let the multisig raise it. Both work:

| | Delay first (this guide, **chosen for the Tempo Mainnet escrow**, CORE-2268) | Transfer first (the NatSpec) |
|---|---|---|
| 1 | deployer: `changeDefaultAdminDelay(newDelay)` | deployer: `beginDefaultAdminTransfer(safe)`, schedule is now + 1 s |
| 2 | wait `min(newDelay, 5 days)`; `defaultAdminDelay()` flips by itself | Safe: `acceptDefaultAdminTransfer()` as a Safe transaction |
| 3 | deployer: `beginDefaultAdminTransfer(safe)`, schedule is now + `newDelay` | Safe: `changeDefaultAdminDelay(newDelay)` |
| 4 | wait `newDelay`, then the Safe: `acceptDefaultAdminTransfer()` | wait `min(newDelay, 5 days)` for the new delay |
| End to end | `min(newDelay, 5 days) + newDelay`: about 2 x the new delay up to 5 days, then 5 days + the delay | seconds to hand over, then `min(newDelay, 5 days)` until the delay is raised |
| Trade-off | the deployer key stays admin for the whole wait, and the Safe is never admin at a delay of 1 s | the Safe is admin at a 1 s delay until the raise takes effect, and the raise is a Safe transaction |

**In the delay-first order, do not begin the transfer before the increase has taken effect.** Begin reads the
delay at that moment, so a begin that lands while `defaultAdminDelay()` is still 1 s is scheduled at 1 s and the
raise buys nothing for this transfer. Read `defaultAdminDelay()` and expect the new value first.

**The script's log line is wrong for increases.** `ChangeDefaultAdminDelay.s.sol` prints that the new delay
"will take effect after the current delay period". That holds for a decrease (after `current - new`). For an
increase it is `min(newDelay, defaultAdminDelayIncreaseWait())`, 5 days at most. The script is unchanged; trust
`pendingDefaultAdminDelay()`, which returns the new delay and its schedule while a change is pending.

**What the Safe must do, as Safe transactions.** A Safe cannot be an `--account`, and
`acceptDefaultAdminTransfer()` only succeeds when `msg.sender` is the pending admin, so the Safe itself calls
the escrow (value 0):

| Call, `to` = the escrow | Calldata |
|---|---|
| `acceptDefaultAdminTransfer()` | `0xcefc1429` |
| `changeDefaultAdminDelay(uint48)`, 2 days as the example | `cast calldata 'changeDefaultAdminDelay(uint48)' 172800` |

**Per-contract scripts, never `TransferAllRoles.s.sol`, for a new escrow.** `GrantRevokeAndBeginTransfer`
requires `FP_ADDRESS` and begins an admin transfer on the `FulfillmentProxy` as well; with `DEPLOY_PROXY=0`
that is the live v4 proxy. Use the scripts that take one contract (all take `CONTRACT_ADDRESS`):

| Script (`script/access-control/…`) | Other variable |
|---|---|
| `grant/GrantPauserRole`, `grant/GrantTreasurerRole`, `grant/GrantTokenConfigRole` | `PAUSER_ADDRESS`, `TREASURER_ADDRESS`, `TOKEN_CONFIG_ADDRESS` |
| `revoke/RevokePauserRole`, `revoke/RevokeTreasurerRole`, `revoke/RevokeTokenConfigRole` | the same names, the account to revoke |
| `admin/BeginDefaultAdminRoleTransfer` | `NEW_DEFAULT_ADMIN_ADDRESS` |
| `admin/ChangeDefaultAdminDelay` | `NEW_DELAY` (seconds) |
| `admin/CancelDefaultAdminTransfer` | none |

Run them as the Step 8 manual form is run: `--account`, `--sender` and `--rpc-url` inline, and `--slow` on Tempo
Mainnet (the deployer is EIP-7702 delegated there). Do the token configuration first, because it needs
`TOKEN_CONFIG_ROLE` on the deployer, and read back `defaultAdmin()`, `defaultAdminDelay()` and
`pendingDefaultAdminDelay()` after each step.

---

## STEP 11 — Record the addresses

Nothing automates this.

| Target | Serves |
|---|---|
| `payment-gw/config/config.yaml` (baked) | staging-testnet, staging-mainnet, production-mainnet |
| `contracts/evm/deployments-v*.json` | read by service config generation and the e2e suite (v4 is `deployments-v4.json`; the library generation is `deployments-v5.json`; don't overwrite older ones) |

The escrow address has more than one home, and a redeploy that moves it has to reach all of
them. payment-gw's config is where a deposit is addressed. veri-fill holds it too, in a
per-chain table: it is the EIP-712 `verifyingContract` for the refund path, so a copy left on
the old deployment refuses every refund. solver-gw does not hold it.

> **Atum operators:** the paths, and the order to update them in, are part of the cutover
> inventory in `atum-core`; that list is the one kept current with the environments. Do not
> treat any single service's config as the only place the address lives.

> **Boot coupling.** When you add a namespace to `PAYMENT_GW_RESERVE_WITNESS_INCLUDE_QUOTE_SOURCE_CHAINS`,
> payment-gw **refuses to start** unless `quote_signature_verification.enabled=true` AND
> `.required=true`. `main` ships `required: false`. Addresses + namespace list + that flip in the
> **same commit**, or the prod pod crash-loops.

---

## Reference values

| | |
|---|---|
| Source | protocol **`main`**, `contracts/evm/source/` — record the commit you build from |
| Permit2 (all 16 chains) | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| CREATE2 factory | `0x4e59b44847b379578588920ca78fbf26c0b4956c` |
| **v4 deployer** | `$DEPLOYER` — must be an EOA (`code=0x`); nonce is irrelevant to CREATE2 |
| v3 deployer / admin (historical) | `0xB9b11aE0f9E2378a2FF8De772BCF6671F3a9b430` |
| v3 addresses (broadcast) | Escrow `0xBEc3fbF58e4115e373670C2A6F12f4bF0601E488`, FP `0xF385Fe59777FBF1341d668865905d8fe9D9cf62b` |
| Live prod-testnet (v1 gen) | Escrow `0xA8388AbbB1d9B3027F5985f883BC164DE7756873`, FP `0xdC2F5Aec02191A3Da56100b2A7CbD314FF6b9b46` |
| deployments-v3 / baked config | Escrow `0xa61a0C025943Aa79B73D8D07E3aDbEe1873738b4`, FP `0x09A5a0d6955E5394A661Cd9E7007076fa63B4158` |
| PAUSER_ROLE | `0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a` |
| TREASURER_ROLE | `0x3496e2e73c4d42b75d702e60d9e48102720b8691234415963a5a857b86425d07` |
| TOKEN_CONFIG_ROLE | `0x05eb16f4c9c7577cc114446a1a0bef50a2238ef90db029c789ddddf014b006a7` |

**Three live address generations disagree** (see table above), and prod-testnet's Solana program ids
appear in no repo file. Baseline what is actually live per chain with `cast code` before repointing.
