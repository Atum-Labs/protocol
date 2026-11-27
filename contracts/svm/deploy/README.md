# v4 SVM (Solana) deployment — step by step

**Operator guide.** The commands are on `PATH` after bootstrap (see below), so they run from any
directory — including `contracts/svm/source`.
Source: **protocol `main`**, `contracts/svm/source/`.

> ## The route: fresh program IDs, not an in-place upgrade
>
> v4 changes account layouts that Solana cannot migrate in place, so v4 deploys to **new program
> IDs** and the old programs stay deployed to serve their existing deposits. Everything downstream
> follows from that:
>
> - PDAs are seeded **without** the program ID, so a new program ID yields a **disjoint PDA
>   namespace** — nothing carries over and every mint must be re-seeded. Adversarially verified: no
>   CPI into the old program and no program ID in any PDA seed.
> - `declare_id!` is inside every signature preimage, so the ID must be propagated to
>   `PROGRAM_ID_BYTES`, the hash anchors and every consumer (Steps 2c and 8), or off-chain signers
>   disagree with the chain.
> - `cluster_id` and `signature_domain_version` are written **once** at initialization and have no
>   setter. Getting either wrong means redeploying at yet another program ID.
>
> **Two things a green readiness verdict does NOT cover.** `PROGRAM_ID_BYTES`
> (`signatures.rs:377-381`) is only correct once `derive.py --sync-id-bytes` has run, and the 13 hash
> anchors need re-deriving. Neither blocks a deploy; both break signature agreement with off-chain
> signers — so they fail *after* you believe you are finished.
>
> **Use the readiness verdict for facts, not as a go/no-go.** Three of its gates apply only to an
> *in-place* upgrade and report as `info` on the fresh-ID route: the inspected program's IDL version,
> its ProtocolConfig size, and its open deposits. It inspects the cluster's v4 pair by default; set
> `ESC` / `FP` to inspect another pair.

---

<!-- toc -->

**Contents**

- [Bootstrap: the commands go on `PATH`](#bootstrap-the-commands-go-on-path)
- [Which mint](#which-mint)
- [RPC endpoints](#rpc-endpoints)
- [Set the environment](#set-the-environment)
- [v5 escrow (readable text signing): deploy checklist](#v5-escrow-readable-text-signing-deploy-checklist)
- [STEP 0 — The gates, with evidence](#step-0--the-gates-with-evidence)
- [STEP 1 — Source and toolchain](#step-1--source-and-toolchain)
- [STEP 2 — Keys](#step-2--keys)
- [STEP 3 — Preflight](#step-3--preflight)
- [STEP 4 — Drain (NOT a gate on the fresh-ID route)](#step-4--drain-not-a-gate-on-the-fresh-id-route)
- [STEP 5 — Deploy (once the decision in Step 0 is made)](#step-5--deploy-once-the-decision-in-step-0-is-made)
- [STEP 6 — Post-deploy, in order](#step-6--post-deploy-in-order)
- [STEP 7 — Verify](#step-7--verify)
- [STEP 8 — Record the addresses](#step-8--record-the-addresses)
- [What needs writing before this can run](#what-needs-writing-before-this-can-run)

<!-- /toc -->

## Bootstrap: the commands go on `PATH`

Run once from a fresh clone. It checks the toolchain, creates `$ATUM_HOME` (default `~/.atum`) with
`keys/` at `0700`, writes an env template, links the commands into `$ATUM_BIN` (default
`~/.local/bin`), and runs the key-derivation self-test:

```bash
contracts/svm/deploy/bootstrap.sh          # --check to preview without changing anything
```

Nothing below needs a relative path or a `cd` afterwards:

| Command | What |
|---|---|
| `atum-svm-readiness` | the read-only gate report (Step 3) |
| `atum-svm-import-deployer` | mnemonic → deployer keypair (Step 2a) |
| `atum-verify-all` | every verification check, EVM → TVM → SVM |
| `atum-assert-typehashes` | does an artifact or live address pin the widened witnesses |

Re-run `bootstrap.sh` after editing the repo copies; it refreshes the symlinks and leaves your env
files alone.

Each script **resolves its own symlink** before locating siblings (`derive.py`, `../source`).
Without that, `BASH_SOURCE` points at the link in `$ATUM_BIN` and the files that ship beside the
real script are invisible — a global install that silently loses half its inputs.

---

## Which mint

`$MINT` is read from atum-core's token registry, `config/tokens/<network>.yaml`, under the
`solana:<genesis-hash>` key — and that key is the **truncated** 32-character hash, the same convention
`deployments-v*.json` uses, not what `solana genesis-hash` prints.

| Cluster | Registry key | Symbol | Mint | Verified on chain |
|---|---|---|---|---|
| mainnet | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | yes — 82 B, Tokenkeg-owned |
| mainnet | same | USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | yes — 82 B, Tokenkeg-owned |
| testnet (devnet) | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | USDC | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | yes |
| testnet (devnet) | same | USDT | — | **no: the registered mint exists on neither cluster** |

> **The registry is not evidence that the mint exists.** The devnet USDT row above is the
> counter-example: configured, plausible, and present on no cluster. Allowlisting a mint that does not
> exist gives you an escrow accepting a token nobody can send. "Verify a mint exists before
> configuring it", further down, has the check; run it here rather than three steps later.
> `create-address-lookup-table.ts` also refuses an absent or non-token-owned mint, so 6b catches it —
> but by then you have already chosen.

**Which one to pass at 6b.** `--mint` is repeatable and each mint adds two tabled addresses (the mint
and its seed-derived `mint_fee_config` PDA), so tabling both costs four entries out of 256. Table every
mint you intend to transact; allowlist in 6c whichever you are launching with. Tabling a mint before it
is allowlisted is safe — the PDA address is seed-fixed, so it does not depend on the allowlisting
having happened.

For reference, TVM mainnet launched with **USDT only** (`TR7NHqje…`, 6 decimals, 0.02%, $250 cap), so
matching that on Solana means USDT. Confirm the intent rather than inferring it from this line.

---

## RPC endpoints

`$SOLANA_RPC_URL` appears throughout this guide and is the single value that decides **which cluster
you are actually operating on**. Define it here, before anything reads it.

| Atum network | Solana cluster | Public endpoint |
|---|---|---|
| testnet | **devnet** | `https://api.devnet.solana.com` |
| mainnet | **mainnet-beta** | `https://api.mainnet-beta.solana.com` |

Atum "testnet" means Solana **devnet**, not Solana testnet. Solana testnet exists and the old
programs are deployed there, but nothing in this deploy targets it.

The public endpoints are rate limited; a real deploy wants a private one. Set it per network:

```bash
NET=mainnet                                   # or testnet
export SOLANA_RPC_URL=<your endpoint for this cluster>

# confirm the cluster WITHOUT printing the URL, which embeds an API key
solana genesis-hash   --url "$SOLANA_RPC_URL"
solana cluster-version --url "$SOLANA_RPC_URL"
```

Expected genesis hashes, which is the only cluster identifier that cannot be faked by a hostname.
Read off the chain, not copied from the deployment records:

| Cluster | Genesis hash |
|---|---|
| mainnet-beta | `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` |
| devnet | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |
| testnet | `4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY` |

> **`deployments-v*.json` keys these clusters by a TRUNCATED genesis hash — the first 32 characters,
> not the whole thing.** `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` is a valid record key and is *not* what
> `solana genesis-hash` returns. Comparing the two reports a mismatch on a perfectly correct cluster,
> which is exactly what an earlier draft of this table did.

> **Both secrets embed their API key in the URL path.** They are Alchemy endpoints, unlike TVM's,
> where the key is a separate secret sent as a header. So never `echo "$SOLANA_RPC_URL"`, never paste
> a command containing it, and prefer `solana genesis-hash --url "$SOLANA_RPC_URL"` over printing the
> variable when you want to know where you are pointed.

> **Do not use the public endpoints for a deploy.** They are rate-limited and cannot reliably carry a
> program upload; that is the failure the mainnet funding note's `--use-rpc` and priority-fee flags
> exist to survive. They are fine for reads.

> **`ESCROW_CLUSTER_ID` is a separate decision from the endpoint, and it is WRITE-ONCE on chain.**
> `deploy.ts` falls back to inferring it by string-matching the RPC URL for `mainnet`/`devnet`/
> `testnet`, so a private or aliased endpoint whose hostname carries neither word silently stamps the
> wrong tag into `ProtocolConfig` — permanently. Set it explicitly, as the template does. The Alchemy
> hostnames above do contain the word, which is luck rather than a guarantee.

Write the pair into a per-network env file so a shell can be re-armed without re-deciding:

```bash
NET=mainnet                                   # or testnet
: "${ATUM_HOME:=$HOME/.atum}"
case "$NET" in
  mainnet) CLUSTER_ID=mainnet ;;
  testnet) CLUSTER_ID=devnet  ;;              # Atum testnet IS Solana devnet
  *) echo "NET must be mainnet or testnet"; return 1 ;;
esac

umask 077                                     # the URL carries a key; 0600, not 0644
cat > "$ATUM_HOME/env/svm.$NET.env" <<EOF
export SOLANA_RPC_URL=$SOLANA_RPC_URL
export ESCROW_CLUSTER_ID=$CLUSTER_ID
EOF
ls -l "$ATUM_HOME/env/svm.$NET.env"           # expect -rw-------
```

Then, per shell, source **both** — the cluster-agnostic file first and the network file second, so
the network-specific pair cannot be clobbered by a stale default:

```bash
source "$ATUM_HOME/env/svm.env"                # cluster-agnostic: keys, roles, program ids
source "$ATUM_HOME/env/svm.$NET.env"           # network: endpoint + write-once cluster id
solana genesis-hash --url "$SOLANA_RPC_URL"    # confirm before doing anything
```

Order matters and the reason is unglamorous: if `svm.env` still carries a `SOLANA_RPC_URL` line from
an older bootstrap, sourcing it second overwrites the endpoint you just fetched, and every subsequent
command silently targets whatever that line said. Sourcing it first means the network file wins.

---

## Set the environment

Steps 5, 6 and 7 all depend on these. Source them once per shell — a **fresh terminal loses them**,
and an unset variable fails unhelpfully: `solana find-program-derived-address "" string:protocol_config`
reports `Error: Bad parameter: PROGRAM_ID`, which names the parameter but not the empty variable
behind it.

`bootstrap.sh` writes a template at `${ATUM_HOME:-$HOME/.atum}/env/svm.env` (`ATUM_HOME` defaults to `~/.atum`).
Fill in the blanks for your target cluster, then source it:

```bash
: "${ATUM_HOME:=$HOME/.atum}"
"${EDITOR:-vi}" "$ATUM_HOME/env/svm.env"
source "$ATUM_HOME/env/svm.env"
```

> **`${EDITOR:-vi}`, not `$EDITOR`.** With `EDITOR` unset the command collapses to the bare path and
> the shell tries to *execute* the file. Because the template is `0600` by design, that reports
> `permission denied: …/env/svm.env`, which reads as a broken file permission rather than a missing
> variable; `command not found` would at least have pointed at the right thing.

The values it expects, and where each comes from:

```bash
# SOLANA_RPC_URL and ESCROW_CLUSTER_ID are NOT here. They live in the per-network
# file from "RPC endpoints" above, because a value in this cluster-agnostic file is
# a default one cluster inherits silently -- and ESCROW_CLUSTER_ID is write-once on
# chain, so inheriting it is permanent.
export DEPLOYER_KEYPAIR="${ATUM_HOME:-$HOME/.atum}/keys/svm-deployer.json"

# The two program IDs. Before Step 5 these are the pubkeys of the keypairs from Step 2c;
# after Step 5 they are what is deployed. They must agree with declare_id!.
export ESCROW_ID=<escrow program id>
export FP_ID=<fulfillment_proxy program id>

# The deployer. All four roles point at it, and on mainnet they MUST at init time:
# see "Do not hand the roles to Squads at init" below.
export ADMIN=<deployer pubkey>
export DEFAULT_ADMIN="$ADMIN"
export TOKEN_CONFIG_AUTHORITY="$ADMIN"
export TREASURER="$ADMIN"
export PAUSER="$ADMIN"

export DEFAULT_ADMIN_DELAY_SECONDS=0      # make this a decision, not a default; see Step 5
# Leave REVOKE_UPGRADE_AUTHORITY unset: the deploy keeps the upgrade authority by default.

export MINT=<SPL mint to allowlist>       # per cluster; see "Which mint" below
```

> **Do not hand the roles to Squads at init — on mainnet that bricks the rest of this guide.** It is
> tempting to "split them for mainnet" by pointing `DEFAULT_ADMIN` / `TOKEN_CONFIG_AUTHORITY` /
> `TREASURER` / `PAUSER` at the Squads vault here. Step 0's authority gate explains why you cannot:
> the mainnet authority is an **off-curve PDA with no private key**, and every admin TS script
> (`configure-token`, `read-state`, `escrow-rotate-all-roles`, `fp-*`) loads a keypair. Set a role to
> it at `initialize_protocol` and nothing can sign as that role afterwards — token allowlisting, the
> settler allowlist and the ALT all become unreachable, on a live program, with no undo.
>
> The order is therefore fixed:
>
> 1. `initialize_protocol` with the **hot deployer** holding all four roles
> 2. every step that needs a signature: token config, settler allowlist, ALT
> 3. read the state back and verify it
> 4. **only then** rotate the roles to the Squads vault, via `escrow-rotate-all-roles` and the `fp-*`
>    scripts, as the last action of the deploy
> 5. and separately, transfer the programs' **upgrade** authority (below) — a different thing from
>    the roles

| Variable | What it is |
|---|---|
| `ESCROW_ID` · `FP_ID` | the two v4 program IDs — pubkeys of the Step 2c keypairs, deployed in Step 5 |
| `DEPLOYER_KEYPAIR` | what `atum-svm-import-deployer --write` produced (Step 2a) |
| `ADMIN` | the deployer; all four roles point at it unless you split them |
| `MINT` | the SPL mint to allowlist, from `config/tokens/*.yaml` under the `solana:<genesis-hash>` key for your cluster — see "Which mint" |

> **Verify a mint exists before configuring it.** A mint listed in config is not proof it was ever
> created. A real SPL mint is **82 bytes** and owned by `TokenkegQfeZyiNw…`; check with
> `solana account <mint> --url "$SOLANA_RPC_URL"`. An entry that reports **0 bytes and System-owned
> does not exist** — `configure-token.ts` will fail on it, and config files do carry such entries.

Confirm it took before running anything that depends on it:

```bash
: "${ESCROW_ID:?run: source "${ATUM_HOME:-$HOME/.atum}/env/svm.env"}"
: "${FP_ID:?run: source "${ATUM_HOME:-$HOME/.atum}/env/svm.env"}"
: "${SOLANA_RPC_URL:?run: source "${ATUM_HOME:-$HOME/.atum}/env/svm.env"}"
echo "env ok — escrow $ESCROW_ID"
```

---

## v5 escrow (readable text signing): deploy checklist

v5 is the current source: its `deposit` takes `destination_hash` (32 bytes) and its signed
instructions verify readable text (`escrow-text-v1`) instead of the raw 32 byte hash. It deploys at
a **new program id beside v4**. The v4 programs stay deployed and keep serving every v4 deposit, so
nothing is drained, paused or upgraded in place. Clients and services pick raw or text per escrow
from the registry. v4 stays every chain's default through all of these steps. The only cutover is
per wallet and mint, in step 10, and only for a wallet that moves to v5. Extending the lookup table
(step 4) and listing v5 (step 11) change nothing for a v4 payment. Run per cluster, devnet first.

1. **Escrow only deploy.** Run Steps 1 to 6a for the escrow alone: `PROGRAMS=escrow ./deploy.sh`
   with `ESCROW_ID` set to the v5 escrow id (the preflight refuses one that differs from
   `declare_id!`) and `FP_ID` to the cluster's v4 fulfillment proxy (`../deployments-v4.json`). It needs no
   proxy keypair, and it neither deploys, initializes nor revokes the proxy, whose settler allowlist
   stays as it is. The run is recorded per escrow id, so the cluster's v4 record doesn't block it.
2. **Fresh program keypair** (Step 2c), custodied outside the repo. At deploy set the escrow's
   `declare_id!`, its four `Anchor.toml` tables, `PROGRAM_ID_BYTES` (`derive.py --sync-id-bytes`)
   and the 13 hash anchors (re-derived out of band) to that id. The committed source keeps the
   legacy id until then.
3. **`initialize_protocol`** (Step 6a) with the cluster's `ESCROW_CLUSTER_ID`. Confirm the
   `ProtocolConfig` reads `signature_domain_version` **5**.
4. **Lookup table.** Add the v5 escrow's addresses to the cluster's **existing** table with
   `ESCROW_ID=<v5 escrow id> create-address-lookup-table.ts --table <existing> --mint <mint>` per
   mint ("Later: adding a mint to an existing ALT" in 6b, `FP_ID` still the v4 proxy). `--keypair`
   must be the table's authority, which `../deployments-v4.json` notes isn't held locally for
   devnet: get that key first. Never create a second one: the settler carries one table per
   cluster, and without v5's `protocol_config` and `mint_fee_config` in it a v0 deposit plus reserve
   overruns 1232 B.
5. **Allow the mints.** Per mint, `allow_mint` and `set_mint_fee_config` with the v4 fees
   (Step 6c, `configure-token.ts`).
6. **Turnkey program allowlists.** Add the v5 program id beside v4 to `allowedPrograms` in each
   settler sub-org config for the cluster, and to `solanaEscrowProgramId` (it takes a list) in each
   sender sub-org config. Then run `apply-policies --dry-run`, `apply-policies --update` and
   `test-policies` for each (`key-management/providers/turnkey/typescript/scripts/PROVISIONING.md`).
   Without the settler entry the settler can't sign a v5 transaction. Without the sender entry
   step 10 is denied.
7. **Record and register.** Record the escrow id and the reused v4 proxy in a
   `../deployments-v5.json`, listing **only the clusters where v5 is deployed and initialized**:
   the registry generator trusts every chain in the file, and `published.txt` keeps a row for
   good. Add one `v5` entry for that file to `contracts/registry/versions.json`
   (`svmDomainVersion` 5, `svmMessage` `"escrow-text-v1"`), run `go run ./cmd/gen-chains` in
   `contracts/registry`, and add the `published.txt` line.
8. **Repins.** Pin that protocol commit in settler-agent, then protocol and settler-agent in
   atum-core (with the matching `go.mod` pseudo versions).
9. **Consumers before the gateway.** Append the v5 id after v4 in each settler's
   `programs.escrow` for the cluster, and in veri-fill's trusted Solana escrows. Deploy both and
   confirm each serves v5 (the settler logs both escrows at boot, veri-fill's chain check passes)
   before the next step. Until then every v5 payment is declined.
10. **Delegates, a cutover per wallet and mint.** A token account holds one SPL delegate, and
    `create_delegate` points it at the calling program's `escrow_delegate` PDA. So creating a
    wallet's v5 `EscrowDelegate` for a mint moves that wallet and mint off v4: every later v4
    deposit from it fails the settler's pre-flight after the award, and a later v4
    `revoke_delegate` breaks v5 the same way. Run
    `key-management/providers/turnkey/typescript/scripts/svm/create-delegate.ts <v5 escrow id> <mint> <capacity>`
    for a wallet only once it has no open v4 payment for that mint and names the v5 escrow on every
    payment from then on.
11. **`CONTRACT_VERSIONS`.** List `v5` after `v4` for the cluster's chain in each environment
    (`solana:<genesis>=v4,v5`). The list only says which versions a payment may name, so v4 stays
    the default and clients opt in to v5 by naming its escrow. Making v5 the default is a later,
    separate change.
12. **Upgrade authority.** The deploy keeps v5's upgrade authority on the deployer. Move it to the
    cluster's Squads vault (`solana program set-upgrade-authority <v5 escrow id> --new-upgrade-authority <vault>`).
    On mainnet, once the audit fixes for v5 are deployed, register the verified build (Step 6e, it
    is the one chance), run `SOLANA_ESCROW_PROGRAM_ID=<v5 escrow id> CLUSTER=mainnet-beta ./pre-finalize.sh`
    (it defaults to the v4 ids), and revoke through a vault proposal, since the vault holds the
    authority. Devnet keeps its authority: it is where upgrades are tested, and `pre-finalize.sh`
    refuses it. v4 stays frozen
    by convention: `upgrade-verified.sh` refuses to apply to the v4 programs without
    `ALLOW_V4_UPGRADE=1`.

---

## STEP 0 — The gates, with evidence

| Gate | Status | Evidence |
|---|---|---|
| Deployed program version | **v4 on devnet and mainnet** | Program ids per cluster are in `../deployments-v4.json`; both clusters run `signature_domain_version` 5. The v4 IDL's `deposit` takes `deposit_request_hash` and `destination`, and `DepositInfo` has 11 fields. Solana testnet has no v4 deployment. |
| Account layouts | **not in-place migratable** | v4 `DepositInfo::LEN` is 313 (pre-v4: 217); v4 fulfillment_proxy `ProtocolConfig::SIZE` is **636** (pre-v4: 119). A v4 program cannot read a pre-v4 account. |
| Realloc / migration | **absent by design** | `state.rs` says it outright: *"There is intentionally NO `realloc` and NO"* migration. `initialize_protocol` cannot re-create an existing PDA. |
| Fresh program IDs | **the route** | Generate keypairs (Step 2c) and custody them outside the repo. Repointing is not one edit: `declare_id!`, all four `Anchor.toml` tables, `scripts/deploy.ts` (Step 2c), then `PROGRAM_ID_BYTES`, the 13 hash anchors and ~50 consumer files (Step 8). A deploy succeeds with the last three stale — signature agreement is what breaks. |
| Open deposits | **not a gate on this route** | A deposit belongs to the program that created it. A pre-v4 deposit settles only against the pre-v4 program, with a signature over that program's id and its domain version (2). See Step 4. |
| Settler-allowlist tooling | `configure-settler-allowlist.ts` | Provisioning script for the settler allowlist. See Step 6d for the mandatory ordering — populate before enforcing. |
| ALT tooling | `create-address-lookup-table.ts` | A per-cluster ALT is **required** to send deposit and reserve in one transaction: without one that transaction overruns. The settler must carry the table at **both** `compileToV0Message()` sites, send *and* simulation — a mismatch lets a size overrun pass simulation and fail on send. Check whether your settler and service configuration carry the address for your cluster; that config home is easy to miss. |
| Widened-witness gate | **no SVM equivalent** | Solana has no typehash; `atum-assert-typehashes` covers EVM and TVM only. `contracts/svm/verify.sh` checks the IDL and the hash anchors, not a deployed program. |
| Mainnet authority | **off-curve PDA** | The Squads vault `9YvUZVux…` is not on the ed25519 curve, so **no private key exists**. Every admin TS script (`configure-token`, `read-state`, `escrow-rotate-all-roles`, `fp-*`) loads a keypair, so none can sign for it. The v4 upgrade authorities are the on-curve deploy payers recorded in `../deployments-v4.json`. |

> **The pre-v4 upgrade authority is NOT required on this route.** A fresh program at a fresh address
> is deployed by whoever holds the new program keypair and pays the fee, and *that* payer becomes the
> upgrade authority.
>
> **The payer stays upgrade authority over a live program.**
> The deploy keeps the upgrade authority by default, so after a mainnet deploy the plaintext hot key at `${ATUM_HOME:-$HOME/.atum}/keys/svm-deployer.json` — one `0600` JSON
> file — can rewrite the mainnet escrow at will, while the *roles* are on their way to Squads.
> Transfer it explicitly, per program, once the sequence above is done:
>
> ```bash
> solana program set-upgrade-authority "$ESCROW_ID" \
>   --new-upgrade-authority <squads-vault> --url "$SOLANA_RPC_URL"
> solana program set-upgrade-authority "$FP_ID" \
>   --new-upgrade-authority <squads-vault> --url "$SOLANA_RPC_URL"
> ```
>
> **Never `--final`.** `--final` removes the authority entirely and makes the program permanently
> immutable, and it is what leaving `REVOKE_UPGRADE_AUTHORITY` unset avoids. Transferring to the vault keeps upgradeability behind the multisig, which is the point.
>
> **The payer is what needs funding** — the deployer from Step 2a, not the admin authorities. On a
> testnet an airdrop is enough; check the measured figure below before assuming.
>
> **Measured cost, from the real deploy — not estimated.** `anchor deploy` does **not** pass
> `--max-len`, so ProgramData is allocated at exactly the `.so` size, not double it: escrow 495,536 B
> → 3.45 SOL, proxy 307,920 B → 2.14 SOL. Total observed spend for both, including the two IDL
> accounts and fees: **5.73 SOL** (payer 13.998 → 8.269). Budget ~7 SOL for margin.
>
> Earlier revisions of this guide said `~7.8` and then `~13.4 peak`. The first was a guess; the second
> came from a "ProgramData is 2× the .so" claim that the on-chain `Data Length` disproves. On mainnet
> that would have meant procuring more than twice what is needed.

### The decision that unblocks everything else

**Do we mint new program IDs?** Answer that and most of the rest follows. Be aware it is code work,
not a config flip: the program ID is a member of **every signature preimage**
(`crate::ID.as_ref()` in `with_deposit/reserve/release/refund_preimage`), so changing `declare_id!`
changes every digest. Baseline `cargo test -p escrow` is 31/31 green; after repointing `declare_id!`,
**8 tests fail — and that count is a trap.** Fix `PROGRAM_ID_BYTES` too and it is **still 8, a
different 8** (two go green, two new ones redden). The real surface is **10 tests across 13 anchor
constants**. Work "until 8 → 0" and you watch the number sit at 8 and conclude nothing changed.
Re-derive them with `scripts/anchors/derive_anchors.py` — never by copying what the new code prints,
which `signatures.rs` calls out as a silent wire-format break — and move every off-chain signer in
lockstep.

---

## STEP 1 — Source and toolchain

```bash
cd the protocol checkout && git checkout main && git rev-parse HEAD
cd "$(git rev-parse --show-toplevel)/contracts/svm/source"
pnpm install --ignore-workspace --frozen-lockfile
atum-verify-all svm   # anchor build + IDL parity + 21 program-sourced tests
```

> **`--ignore-workspace` is mandatory here, exactly as it is for EVM and TVM, and this step was
> missing it.** protocol has a `pnpm-workspace.yaml` at its root, so without the flag pnpm installs
> into the ROOT `node_modules` and `contracts/svm/source/node_modules` is never created. Nothing
> errors: pnpm prints `Done in 7.5s` and exits 0. The failure arrives later and points elsewhere —
> `pnpm run typecheck` and `pnpm run deploy` both die with
> `sh: tsc: command not found` followed by
> `WARN Local package.json exists, but node_modules missing, did you mean to install?`,
> which is the tool suggesting you do the thing you just did.

> **Why this gate asserts a test count.** It used to filter `cargo test` on `parity_golden`, a name no
> test has — so cargo reported *"0 passed; 0 failed; 31 filtered out"* and **exited 0**. The stage was
> a green light that verified nothing. It now runs the modules that exist
> (`hash_anchor_tests`, `cross_vm_fee_parity_tests`) and **fails when a filter matches no tests**, so a
> rename upstream surfaces as a failure instead of a silent pass. The same reasoning is why
> `atum-verify-all` exits `2` rather than `0` when a stage could not run.

Pinned in `Anchor.toml`: anchor **0.32.1**, solana **2.3.0**, pnpm. Confirm your toolchain matches —
a different anchor version changes the build and therefore the deployed bytecode.

Confirm the on-main constants before trusting anything downstream:

```bash
SVM="$(git rev-parse --show-toplevel)/contracts/svm/source"
grep -rnE 'CURRENT_SIGNATURE_DOMAIN_VERSION|pub const (SIZE|LEN)|MAX_AUTHORIZED_SETTLERS' "$SVM/programs"
```

`signature_domain_version` lives **inside the deposit preimage**, so a stale off-chain value fails
every deposit. Read the live value; never assume it (the repo shows 2, 3→4 and 5 in different places).

---

## STEP 2 — Keys

`scripts/deploy.ts` takes the deployer one of two ways, and **there is no interactive prompt**:

```bash
export DEPLOYER_KEYPAIR=/absolute/path/deployer.json   # JSON array of the 64-byte secret key
# or
export DEPLOYER_PRIVATE_KEY=<base58 secret key>        # wins if both are set
```

Default if neither is set: `contracts/svm/source/.anchor/deployer.json` (`deploy.ts:38-41`) — **not**
`~/.config/solana/id.json`. No ledger, no Squads support.

### 2a. From a mnemonic — `atum-svm-import-deployer`

```bash
atum-svm-import-deployer --self-test           # prove the derivation first, no phrase needed
atum-svm-import-deployer                       # sweep paths, print addresses, write nothing

# then ONE of these — see "which path" below
EXPECT=<pubkey> atum-svm-import-deployer --write                        # recover an existing key
DERIVATION_PATH="m/44'/501'/0'/0'" atum-svm-import-deployer --write     # choose one for a NEW deployer
```

**Already have the key, rather than a seed phrase?** A different deployer — a mainnet key, say —
need not come from the same mnemonic, so there is nothing to sweep. `--private-key` takes the key
directly. It is a **dry check** by default: it derives the address, prints it, and writes nothing.
Add `--write` to import for real.

```bash
atum-svm-import-deployer --private-key                  # print the pubkey, write nothing
EXPECT=<pubkey> atum-svm-import-deployer --private-key   # and verify it matches
atum-svm-import-deployer --private-key --write
```

The key is entered hidden, never appears in argv or shell history, and a dry check leaves no file
behind. `--write` refuses to overwrite an existing key rather than replacing a deployer silently.

`--write` refuses when a key is already in place, so an existing deployer is never replaced by
accident. Add `--force` to replace it deliberately:

```bash
atum-svm-import-deployer --private-key --write --force
```

It names what is being replaced first. The two kinds of key are treated differently on purpose: the
plaintext TVM and SVM key files are **shredded**, since leaving copies of a bare secret around is
itself the risk, while a foundry keystore is encrypted at rest and is **moved aside** to
`<account>.replaced-<timestamp>` — a mistaken `--force` there would otherwise destroy a key that was
still recoverable. Delete that backup once you are satisfied.


It accepts the four shapes an operator actually holds: base58 (64 or 32 bytes) or a JSON array (64 or
32).

### One secret across all three VMs — `--from-secp256k1`

EVM and Tron share a key because Tron reuses secp256k1 and re-encodes the same 20 bytes. Solana
cannot join that: it is ed25519, and no function maps one curve's address to the other's. What *is*
possible is using the 32-byte **private key** as the ed25519 **seed**, since both are 32 bytes:

```bash
atum-svm-import-deployer --from-secp256k1                  # print the pubkey, write nothing
atum-svm-import-deployer --from-secp256k1 --write          # write the keypair
```

Confirmed with `solana-keygen verify`, and covered by `--self-test` two ways: a pinned address for
the published wallet-core test key, plus `solana-keygen` verifying the keypair we would write. The pin
alone would not catch curve maths that is wrong self-consistently.

Understand the trade before choosing it:

| | |
|---|---|
| The Solana address looks unrelated to the EVM one | Expected. Only the 32 bytes are shared; neither address derives from the other |
| **No seed phrase or wallet recovers it** | Phantom, Ledger and `solana-keygen recover` all expect a BIP44 path. Recovery means still holding the raw key |
| One secret signs under two algorithms | No known attack crosses between them, but it is outside what either curve's analysis covers |

**The mnemonic path is the default for a reason** — `m/44'/501'/0'/0'` is standard, any wallet
recovers it, and no key material is shared across curves. Reach for `--from-secp256k1` only when
one-secret-for-everything is a deliberate decision. For a 64-byte secret the trailing 32 bytes are a *claimed* public key; it re-derives from the seed
and **refuses on mismatch**, because such a file is accepted by some tools and then signs as the
derived key while every UI shows the embedded one.


Also on `PATH`, so it works from anywhere. `--write` needs one of `EXPECT` or `DERIVATION_PATH`:
every path in the sweep yields a valid keypair, so picking one silently would be a guess. Use
`EXPECT` when the key exists somewhere already (it deletes the file if the pubkey disagrees) and
`DERIVATION_PATH` when you are creating the deployer.

It prompts for the phrase and an optional BIP39 passphrase with input hidden. Neither ever reaches
shell history, argv (visible in `ps`) or the environment — they live in one 0600 temp file, wiped on
exit including Ctrl-C. `--write` produces the `DEPLOYER_KEYPAIR` JSON at `"${ATUM_HOME:-$HOME/.atum}/keys/svm-deployer.json"`
(0600); the base58 `DEPLOYER_PRIVATE_KEY` form is deliberately a separate explicit command
(`python3 derive.py --show-base58 <file>`) rather than something printed into your scrollback.

**42 candidates** by default (`SCAN=` controls the depth), in this priority order:

| Family | Who uses it |
|---|---|
| **`bare-seed`** | `seed[:32]` used directly, **no HD derivation**. What `solana-keygen new` produces with no `--derivation-path`, and `solana-keygen recover ASK`. **Highest prior for a deployer key**, because that is how deployer keys are usually made. |
| `m/44'/501'/i'/0'` | Phantom, Solflare, Backpack, Ledger; `'prompt:?key=i/0'`. Also agave's own `DEFAULT_DERIVATION_PATH` at `i=0`. |
| `m/44'/501'/i'` | 3-level; `'prompt:?key=i'`. Phantom bip44, Ledger Live, Trust Wallet. |
| `m/44'/501'` | the 2-level BIP-44 base — what bare `prompt:` actually resolves to. |
| `m/44'/501'/0'/i'` | change-level sweep; `'prompt:?key=0/i'`. |
| `m/44'/501'/0'/0'/i'` · `m/44'/501'/i'/0'/0'` | depth-5: Backpack "Legacy" and Backpack "Ledger Live". |
| `m` | SLIP-0010 master. **No Solana tool produces this by default** — kept last as a long shot only. |

> **Two corrections to an earlier version of this table, both found by testing rather than reading.**
> It listed `m` as "the bare seed, the legacy form". Both halves were wrong: `m` is SLIP-0010's master
> key, which nothing in the Solana ecosystem generates, while the real bare seed is `seed[:32]` — a
> *different key*, and the most likely one. And bare `prompt:` is not the legacy form at all; it
> resolves to `m/44'/501'`. Verified against published values for the public test mnemonic:
> bare seed → `EHqmfkN8…`, `m/44'/501'` → `D2PPQSYF…`, `?key=0` → `GjJyeC1r…`,
> `?key=0/0` → `HAgk14Jp…`. All four are pinned in `--self-test`.
>
> Paths are **force-hardened on input**, matching agave and `ed25519-hd-key`, so `m/44/501/0/0` and
> `m/44'/501'/0'/0'` are the same key rather than a missed match.
>
> **Known gap:** Sollet's deprecated `m/501'/i'/0/0` needs a BIP-32/secp256k1 engine whose output is
> reinterpreted as an ed25519 seed. It is not expressible in SLIP-0010 ed25519, so no sweep here can
> find a key that came from old Sollet.

**SLIP-0010 ed25519 permits HARDENED components only**, so a path with any non-hardened level is not
a representable Solana path at all — which usefully bounds the search space. Coin type 501 per
SLIP-0044.

`--write` **refuses without `EXPECT`**, on purpose: every path above yields a perfectly valid keypair,
so with nothing to match against there is no way to tell the deployer from nine other good addresses.
It also re-reads the file it just wrote and deletes it if the pubkey disagrees.

> **Why this doesn't use `solana-keygen recover`.** That command needs a real TTY for its seed-phrase
> prompt and dies with `Error: Device not configured` on a pipe, so it cannot be swept over candidate
> paths without prompting once per path. `derive.py` implements BIP39 + SLIP-0010(ed25519) directly,
> and `--self-test` checks it against the **BIP39 spec vector**, **SLIP-0010's official ed25519 test
> vector 1** at three depths, and — for the curve maths — a throwaway `solana-keygen new` keypair,
> recomputing its public key from its own seed. Verified: the written file's pubkey matches
> `solana-keygen pubkey`, and the base58 form round-trips to the same 64 bytes.
>
> A caution earned the hard way: when that self-test first failed on one nibble, the bug was my
> hardcoded *expectation*, not the derivation — HMAC-SHA512 avalanches, so a real algorithmic error
> scrambles all 32 bytes rather than one. I confirmed against the SLIP-0010 spec before changing
> anything. If it ever fails for you, check the expectation with the same suspicion.

### 2a-bis. Holding devnet AND mainnet authorities at the same time

The single `svm-deployer.json` path above is fine while you are deploying one cluster. It is a
hazard the moment you need both keys present — an upgrade, or a verified-build registration, touches
devnet and mainnet in the same sitting, and re-importing over one path silently replaces the other
key with no warning. Pointing the wrong key at the wrong cluster is the failure that follows.

Use per-cluster filenames in the same directory instead. Same `0700` dir, same `0600` files, same
import command; only the destination differs:

`atum-svm-import-deployer` takes an explicit destination in `OUTF`, so write each key straight to
its own file. Do NOT import to the default path and move it afterwards: when a legacy
`~/.atum-svm-deployer.json` exists that path WINS over `$ATUM_HOME/keys/svm-deployer.json`
(`import-deployer.sh:48`), so the move would rename the wrong file, or nothing, and leave you
believing a key was saved that was not. `OUTF` takes precedence over both.

The two authorities do not have to arrive the same way -- one may be a recovery phrase and the
other a raw secret -- so `OUTF` combines with either import form. Both are recoveries of keys that
already exist, so use `EXPECT`: `--write` requires `EXPECT` or `DERIVATION_PATH` because every path
in the sweep yields a valid keypair and choosing silently would be a guess, and `EXPECT` deletes the
file rather than leaving the wrong key on disk if the pubkey disagrees (`import-deployer.sh:123`).

```bash
: "${ATUM_HOME:=$HOME/.atum}"

# from a RECOVERY PHRASE -- sweep first, writes nothing, then recover the known address
atum-svm-import-deployer --self-test              # prove the derivation, no phrase needed
atum-svm-import-deployer                          # print candidate addresses
EXPECT=6jbdyQZcMm8AsgpNCQnEKHNzb2fqbV84JqeAabUqQ1bS \
OUTF="$ATUM_HOME/keys/svm-authority-devnet.json" \
  atum-svm-import-deployer --write

# from a RAW SECRET -- nothing to sweep, the key is the key
EXPECT=FVt14Ru5WvzRgy64qDBxCSPf815wUnrSsR4p58eaitBW \
OUTF="$ATUM_HOME/keys/svm-authority-mainnet.json" \
  atum-svm-import-deployer --private-key --write

chmod 600 "$ATUM_HOME"/keys/svm-authority-*.json
ls -l "$ATUM_HOME"/keys/svm-authority-*.json      # expect -rw-------
```

Confirm each file holds the authority you expect, against the record rather than from memory:

```bash
solana-keygen pubkey "$ATUM_HOME/keys/svm-authority-devnet.json"    # expect 6jbdyQZcMm8AsgpNCQnEKHNzb2fqbV84JqeAabUqQ1bS
solana-keygen pubkey "$ATUM_HOME/keys/svm-authority-mainnet.json"   # expect FVt14Ru5WvzRgy64qDBxCSPf815wUnrSsR4p58eaitBW
```

Those two values are the `upgradeAuthority` fields in `../deployments-v4.json`; if a pubkey does not
match, the key is not the authority and nothing downstream will sign. `upgrade-verified.sh` reads
whichever path `SVM_AUTHORITY_KEYPAIR` names, so point it per run:

```bash
SVM_AUTHORITY_KEYPAIR="$ATUM_HOME/keys/svm-authority-devnet.json" \
  ./upgrade-verified.sh --cluster devnet --apply
```

Never commit these, and never place them inside the repo — `$ATUM_HOME` is outside the worktree by
design, so a `git add -A` cannot reach them.

### 2b. Confirm what you have

```bash
solana-keygen pubkey "$DEPLOYER_KEYPAIR"
```

Check the balance on the cluster you are targeting, rather than assuming; `readiness.sh` does this
and gates on it:

```bash
CLUSTER=devnet       atum-svm-readiness
CLUSTER=mainnet-beta atum-svm-readiness
```

Budget ~**7 SOL** on a testnet, where an airdrop tops it up. **Mainnet is funded and gated at 6 SOL**
— the payer holds 7.0187 SOL, above the 5.73 measured for both programs plus IDLs — on the explicit
condition below.

Measured from the live mainnet pair, whose ProgramData accounts hold 3.3607 SOL (482,680 B) and 1.9999
SOL (287,176 B). Rent is ~6.96e-6 SOL/byte and the v4 builds are larger — escrow 495,536 B, proxy
307,920 B:

| | rent |
|---|---|
| escrow ProgramData | ~3.45 SOL |
| fulfillment_proxy ProgramData | ~2.14 SOL |
| plus IDLs and fees | ~5.73 SOL total, as measured |

> **This balance covers ONE clean run and no more, so the run must not need a second attempt.** A
> program deploy uploads into a temporary buffer first; if it fails partway, that buffer keeps its
> rent — ~3.45 SOL for the escrow — leaving ~3.5 SOL, short of the 5.59 a fresh attempt needs, with no
> airdrop on mainnet. The decision is to run at this balance rather than top up, which makes the
> procedure below mandatory rather than advisory.
>
> **Deploy with an explicit buffer, so an interruption resumes instead of restarting.**
> `solana program deploy --buffer` is documented as *"can be used to resume a failed deploy"*: re-running
> with the same buffer keypair continues into the same account and pays no second rent. That is what
> removes the need for retry headroom.
>
> ```bash
> # once: a buffer keypair you keep for the duration of the deploy
> solana-keygen new --no-bip39-passphrase -o "$ATUM_HOME/keys/svm-deploy-buffer.json"
>
> export SOLANA_DEPLOY_ARGS="--buffer $ATUM_HOME/keys/svm-deploy-buffer.json \
>   --use-rpc --with-compute-unit-price 50000 --max-sign-attempts 100"
> ```
>
> `deploy.ts` forwards `SOLANA_DEPLOY_ARGS` to `solana program deploy` after `anchor deploy --`, and
> **warns if you deploy to mainnet without it**. Each flag earns its place:
>
> | flag | why |
> |---|---|
> | `--buffer <keypair>` | makes a failed upload resumable at no extra rent; the whole basis for running at 6 SOL |
> | `--use-rpc` | sends write transactions through the configured RPC instead of validator TPUs, which commonly fail from a laptop |
> | `--with-compute-unit-price` | priority fee; without one the upload may never land under congestion |
> | `--max-sign-attempts` | blockhash expiry mid-upload is the usual failure, and the default gives up early |
>
> **If it fails anyway**, resume by re-running the identical command. Only if you abandon the attempt,
> reclaim the rent before trying again:
>
> ```bash
> solana program show --buffers --keypair "$DEPLOYER_KEYPAIR" --url "$SOLANA_RPC_URL"
> solana program close --buffers --keypair "$DEPLOYER_KEYPAIR" --url "$SOLANA_RPC_URL"
> ```
>
> Buffers, priority fees and resumption were not mentioned anywhere in this guide before. The expected payer is per cluster: on a testnet it
defaults to the known devnet payer, and on mainnet it is deliberately **unset** — Solana is ed25519, so
the mainnet payer cannot be derived from the EVM/Tron deployer and has to be chosen. The gate reports
that the decision is missing rather than comparing your key against an empty expectation.

> **Three roles, and conflating two of them is destructive.**
>
> | Role | What it is | Set by |
> |---|---|---|
> | **payer / deployer** | pays the deploy fee, becomes the new upgrade authority | `DEPLOYER_KEYPAIR` / `DEPLOYER_PRIVATE_KEY` |
> | **program keypairs ×2** | their **pubkeys become the program addresses** | `target/deploy/*-keypair.json` (Step 2c) |
> | **authorities** | `default_admin` / `token_config_authority` / `treasurer` / `pauser` | plain pubkey **arguments** to `initialize_protocol` — no key needed at deploy time |
>
> **Never reuse the payer key as a program keypair.** Deploying to address X makes that account
> BPFLoaderUpgradeable-owned and **executable**, so it can never hold lamports or pay a fee again —
> using the payer as a program ID destroys the payer. You need two program IDs anyway, so one key
> cannot serve both.
>
> The recorded decision *"same keypair as the EVM/TVM deployer"* applies to the **payer**, and means
> same custody / same operator identity — not the same key bytes. EVM and TVM are secp256k1, Solana is
> ed25519; the bytes are not interchangeable. A Solana keypair still has to exist.
>
> `deploy.ts` **defaults every authority to the deployer** when the env vars are absent. Set
> `default_admin` explicitly to a key you actually hold rather than inheriting anything.

---

### 2c. Program keypairs — the two program IDs

A Solana program's ID *is* the public key of a keypair, so "mint fresh program IDs" means generating
keypairs. Generate them **once** per deployment and custody them; every ID propagated downstream
depends on them.

**`declare_id!` is a single compile-time constant, so a build serves exactly one program ID.** Every
set of IDs has to be propagated through Step 8, including the 13 hash anchors, so custody the
keypairs from first generation.

The v4 programs are deployed with a separate pair per cluster (`../deployments-v4.json`). The source
tree declares the pre-v4 pair, which Step 8 replaces:

| Program | devnet (v4) | mainnet (v4) | declared in the source tree |
|---|---|---|---|
| `escrow` | `2MHznjRgbc4AbXkYaq69CiL4ZmnvBShg8QmyLxniwMkf` | `5BD9UAUCRCg6Chv6CS5k4sBHGd7CciWpng9u7iJxJFjx` | `44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs` |
| `fulfillment_proxy` | `FGMSseEvfdXHWnYwDcSyCorqJr3pT83zuasdy8ve8KmS` | `CMxMPzpmeJPJbyUK4DDSDEhEYdCCAUt7w5cr5SWEHoNJ` | `77AqGeSh3GLFcBwSxdTnefgv92Cosi9o6NsK992TZsRe` |

Record both new IDs in `${ATUM_HOME:-$HOME/.atum}/env/svm.env` as `ESCROW_ID` / `FP_ID` — every later step reads
them from there.

**Check the new addresses before adopting them.** A freshly generated address must be
**unoccupied** on every cluster you will deploy to:

```bash
for id in "$ESCROW_ID" "$FP_ID"; do
  echo "== $id"
  solana account "$id" --url "$SOLANA_RPC_URL" 2>&1 | grep -iE 'Length|Error' || echo "  unoccupied"
done
```

Keypairs live at **`${ATUM_HOME:-$HOME/.atum}/keys/`**, mode `0700` on the directory and `0600` on each file,
deliberately **outside** the repo and outside `/private/tmp`:

```
"${ATUM_HOME:-$HOME/.atum}/keys/escrow-keypair.json"
"${ATUM_HOME:-$HOME/.atum}/keys/fulfillment_proxy-keypair.json"
```

**Back these up now.** They were generated with `--silent`, so no BIP39 seed phrase was ever printed
— which keeps the phrase out of any log or transcript, but also means **the JSON file is the only
copy and there is no recovery phrase**. If you would rather have a recoverable mnemonic, regenerate
them yourself in your own terminal without `--silent` and record the phrase somewhere custodied; the
IDs then change, and `ESCROW_ID` / `FP_ID` with them.

To reproduce the generation:

```bash
mkdir -p "${ATUM_HOME:-$HOME/.atum}/keys" && chmod 700 "${ATUM_HOME:-$HOME/.atum}/keys"
solana-keygen new --silent --no-bip39-passphrase -o "${ATUM_HOME:-$HOME/.atum}/keys/escrow-keypair.json"
solana-keygen new --silent --no-bip39-passphrase -o "${ATUM_HOME:-$HOME/.atum}/keys/fulfillment_proxy-keypair.json"
chmod 600 "$ATUM_HOME"/keys/*.json
solana-keygen pubkey "${ATUM_HOME:-$HOME/.atum}/keys/escrow-keypair.json"
```

> **⚠️ `target/deploy/` already contains throwaway keypairs, and they are a trap.** `anchor build`
> silently generates a random keypair for any program that lacks one. This tree picked up
> `6Kj4cbGs…` (escrow) and `GbuP1DW1…` (proxy) that way — neither matches `declare_id!`.
> Deploying with a keypair whose pubkey disagrees with the program's own `crate::ID` does **not**
> fail at upload: the program lands at the keypair's address and then rejects instructions, because
> Anchor checks `crate::ID` against the executing `program_id`. Copy the custodied keypairs over the
> generated ones before building:
>
> ```bash
> cp "${ATUM_HOME:-$HOME/.atum}/keys/escrow-keypair.json"            target/deploy/escrow-keypair.json
> cp "${ATUM_HOME:-$HOME/.atum}/keys/fulfillment_proxy-keypair.json" target/deploy/fulfillment_proxy-keypair.json
> solana-keygen pubkey target/deploy/escrow-keypair.json             # must equal $ESCROW_ID
> solana-keygen pubkey target/deploy/fulfillment_proxy-keypair.json  # must equal $FP_ID
> ```
>
> `target/` is gitignored, so nothing there is ever committed — which is also why it is not a
> custody location. `cargo clean` deletes it.
>
> **There is a second contaminated tree.** `/tmp/protocol-v4/contracts/svm/source/target/deploy` holds
> a *different* pair of auto-minted keys (`yGcWLP7w…`, `7jCAkxok…`) from a build there. Two trees, two
> sets of junk. Check whichever tree you are about to build in, and prefer passing
> `--program-keypair` explicitly over trusting what is on disk.

#### These edits must NOT be committed

`declare_id!` is a single value in the Rust source, not a per-cluster table. Setting it to the mainnet
ids makes this tree describe **mainnet only** — the devnet build then declares a program id that is
not what devnet runs, so `cargo test` and every devnet admin script disagree with the chain. There is
no way to hold both at once.

So Step 2c is a deploy-time edit with a defined lifetime:

```bash
SVM="$(git rev-parse --show-toplevel)/contracts/svm/source"
cd "$SVM"

git status --short Anchor.toml programs/ scripts/     # 1. start from a clean tree
#    ... propagate (below), build, deploy, verify ...
git checkout -- Anchor.toml programs/ && rm -f **/*.bak   # 2. revert when done
```

| | |
|---|---|
| **Start clean.** | An already-dirty tree means you cannot tell your edits from someone else's, and `git checkout --` at the end would discard both. |
| **Do not commit.** | A committed `declare_id!` pointing at mainnet breaks devnet for everyone who pulls, and CI runs the devnet tests. |
| **Revert after deploying.** | The deployed bytecode is what matters and it is already on chain; the source edit has no further job. Leaving it makes the next person's `cargo test` fail for reasons that have nothing to do with their change. |
| **Record, don't retain.** | The ids belong in `deployments-v4.json` and `svm.<network>.env`, both of which are per-cluster and *are* committed. That is the durable record; the `declare_id!` edit is scaffolding. |

`readiness.sh` gates `declare_id!` against the id you are deploying at, so forgetting the propagation
is loud rather than silent — and reverting afterwards makes that gate go red again, which is correct
and expected once the deploy is done.

> **Do not try to make this permanent with a feature flag or a build script.** `declare_id!` is
> consumed at compile time by the Anchor macro and feeds PDA derivation and the signature domain; a
> conditional id means two divergent binaries and two sets of PDAs from one source tree. The
> deploy-time edit is the simpler and more honest arrangement.

#### Propagating the IDs — two scripted steps; do not use `anchor keys sync` or `keys list`

Verified against anchor-cli **0.32.1**, both by reading `cli/src/lib.rs` and by running the commands
on throwaway copies. The real tree was not modified.

**`anchor keys list` is not read-only.** It resolves each ID through `Program::pubkey()` →
`keypair_file()`, which is documented to *"lazily initialize the keypair file with a new key if it
doesn't exist"*. Run in a workspace with an empty `target/deploy`, it **invented three keypairs and
wrote them to disk at mode 0644** — confirmed by experiment. So for a program with no keypair its
output is a freshly-minted key, not a fact. Use `solana-keygen pubkey <file>` to inspect IDs.

**`anchor keys sync` is worse than a blunt tool here — it is destructive on first use in this tree.**

- It rewrites `declare_id!` for **every** program, cluster-independent (the loop at `lib.rs:4162`
  has no cluster condition), but rewrites **only the `[programs.<current-cluster>]` table** — the
  guard is explicit at `lib.rs:4207`: `if cluster != &cfg_cluster { continue; }`. It also only
  updates keys that already exist in that table; it never adds one.
- **`anchor deploy` takes the program ID from the keypair file, not from `Anchor.toml`**
  (`--program-id target/deploy/<lib>-keypair.json`, `lib.rs:3576`), and `declare_id!` is what emits
  the address into the built IDL. So the failure mode is not a visible bad diff — it is that
  **`Anchor.toml` becomes a lie about the artifact**. The file you would inspect still reads
  correctly while the `.so` and the IDL carry a different key. Strictly harder to catch.
- **A missing keypair is silently fabricated**, same `keypair_file()` path, at mode 0644. `target/`
  is gitignored and therefore always absent on a clean checkout or CI runner — so there, `keys sync`
  mints three throwaway program identities and writes them into the source. No warning, exit 0.
- **It is destructive in this tree today**, without needing anything to go wrong: `target/deploy`
  already holds the build-artifact keys (`6Kj4cbGs…`, `GbuP1DW1…`, `6RVVwWBK…`), so a sync rewrites
  all three `declare_id!` to *those* junk values.
- It does not converge in one pass. First run updated `mock_transfer_hook` and `fulfillment_proxy`
  and exited 0 with no error; `escrow` was untouched. A second run did escrow and printed
  `All program id declarations are synced.` **That line is the only success signal.**
- `mock_transfer_hook` diverges asymmetrically: with `cluster = devnet`, its `declare_id!` is
  rewritten but `[programs.localnet].mock_transfer_hook` is not, silently breaking `anchor test`.
- The whole `Anchor.toml` is re-serialised: **all comments are dropped** and cluster tables are
  re-sorted alphabetically.

So do it yourself, in two commands: a `sed` over a named file list for every textual site,
then `derive.py --sync-id-bytes` for the byte array a sed cannot reach. Run the first from
`contracts/svm/source`:

```bash
SVM="$(git rev-parse --show-toplevel)/contracts/svm/source"
cd "$SVM"

OLD_E=44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs
OLD_P=77AqGeSh3GLFcBwSxdTnefgv92Cosi9o6NsK992TZsRe
# Read the new ids from the keypairs themselves — a hand-copied id that disagrees with the
# artifact is exactly the DeclaredProgramIdMismatch this step exists to prevent.
KP="${ATUM_HOME:-$HOME/.atum}/keys/svm-mainnet-programs"
NEW_E=$(solana-keygen pubkey "$KP/escrow-keypair.json")
NEW_P=$(solana-keygen pubkey "$KP/fulfillment_proxy-keypair.json")

# A NAMED LIST, deliberately not `grep -rl`. The encoding goldens under bindings/, conformance/ and the
# *_test.go / *.test.ts fixtures also contain these ids and must be REGENERATED, never hand-edited —
# a sweep that "helpfully" rewrites them silently changes expected digests.
FILES=(
  Anchor.toml
  programs/escrow/src/lib.rs
  programs/fulfillment_proxy/src/lib.rs
  programs/escrow/src/utils/signatures.rs
)

# Validate the whole list BEFORE editing any of it. The earlier version edited as it
# went and `break`-ed on the first missing file, so a stale entry left five files
# rewritten under a message that read like a failure.
missing=0
for f in "${FILES[@]}"; do [ -f "$f" ] || { echo "MISSING $f"; missing=1; }; done
[ "$missing" -eq 0 ] || { echo "refusing to edit anything until the list is correct"; return 1; }

for f in "${FILES[@]}"; do
  sed -i.bak -e "s/$OLD_E/$NEW_E/g" -e "s/$OLD_P/$NEW_P/g" "$f"
done

# expect ZERO in the edited files
grep -rn "$OLD_E\|$OLD_P" "${FILES[@]}" | grep -v '\.bak:'
grep -A3 '^\[programs\.' Anchor.toml     # all four tables must show the new ids
```

> **`scripts/deploy.ts` is deliberately NOT in that list, and adding it back would break the deploy.**
> Its program ids are no longer hardcoded — they come from `ESCROW_ID` / `FP_ID`. The only occurrences
> of the old ids left in it are the `RETIRED_PROGRAM_IDS` map that *refuses* them, so a sed would
> rewrite that map to hold the NEW ids and `deploy.ts` would then refuse the very ids you are
> deploying at. Three further entries the list used to carry — `scripts/anchors/derive_anchors.py`,
> `validate_encoder_fixtures.py` and `anchors/README.md` — do not exist in this tree at all.


`scripts/deploy.ts` is in that list because its program IDs are `const` at `deploy.ts:46-53` with no
env override — leave them and `initializeProtocol` targets the **old** program and demands the old
authority, while `verifyDeployment` checks the old ids and reports a false green.

Remove the `.bak` files once you have reviewed the diff: `rm -f **/*.bak` (or `git diff` then
`find . -name '*.bak' -delete`).

### `PROGRAM_ID_BYTES` — a second command, not a hand-edit

`programs/escrow/src/utils/signatures.rs:377-381` spells the program ID as **raw bytes**, on purpose
— *"so no base58 decoder sits in the derivation path"* — so no textual substitution can reach it.
Don't retype hex. Run:

```bash
SVM="$(git rev-parse --show-toplevel)/contracts/svm/source"
# checks first, writes nothing
python3 "$SVM/../deploy/derive.py" --sync-id-bytes "$SVM" --check

# then apply (leaves signatures.rs.bak)
python3 "$SVM/../deploy/derive.py" --sync-id-bytes "$SVM"
```

It reads `declare_id!` out of `programs/escrow/src/lib.rs`, decodes that base58 to 32 bytes, and
rewrites the array to match — preserving the file's own indentation and 15/15/2 line shape. The bytes
are therefore **derived from the ID that is actually in the file**, so the two cannot drift and there
is no hex to transcribe. It re-reads what it wrote and re-encodes it before reporting success.

```
declare_id!      : <the new escrow program id>
PROGRAM_ID_BYTES : <the stale id the array still encodes>
rewrote ../source/programs/escrow/src/utils/signatures.rs (backup .bak) -> <new id>
verified: the bytes now decode to declare_id!
```

`--check` exits **1** when the two disagree and **0** when they match, so it works as a pre-commit or
CI gate. Re-running after a successful sync prints `already in sync — nothing to do`; it is
idempotent. Because it derives from `declare_id!` rather than taking an ID argument, it stays correct
if the program ID ever changes again.

> **Between the sed and this command there is a deliberate tripwire, and that is the point.** The sed
> updates the assert at `signatures.rs:540` to the NEW base58 while `PROGRAM_ID_BYTES` still holds the
> OLD bytes, so `anchors_use_the_real_program_id` fails with *"anchors were derived for a different
> program ID than declare_id!"*. That test exists precisely to tie the bytes to the text. Do not
> silence it — and note that `--sync-id-bytes` only fixes the **byte array**. The 13 hash anchors
> still have to be re-derived, out of band, with `scripts/anchors/derive_anchors.py`.

Then rebuild:

```bash
cd "$(git rev-parse --show-toplevel)/contracts/svm/source" && anchor build
```

Anchor tells you to rebuild itself — *"Please rebuild the program to update the generated
artifacts."* The IDL carries the program ID, so a stale `target/idl/*.json` re-introduces the old one
into every admin script that calls `Program.fetchIdl`.

**Expect `cargo test -p escrow` to break here, and that is correct.** The program ID is a member of
every signature preimage (`crate::ID.as_ref()`), so changing `declare_id!` changes every digest.
Baseline is 31/31 green; after repointing, 8 golden-vector tests fail. They must be regenerated, and
every off-chain signer must move in lockstep. Do not paper over them.

---

## STEP 3 — Preflight

```bash
atum-svm-readiness                          # devnet
CLUSTER=mainnet-beta atum-svm-readiness
ROUTE=in-place atum-svm-readiness           # score the in-place gates instead
```

**`atum-svm-readiness` is on `PATH`**, so it runs from any directory — including
`contracts/svm/source`, which is where you actually want it, because from there it finds the source
tree via the cwd and can report the two source-dependent gates instead of skipping them. The
relative `./readiness.sh` still works from this directory if you prefer it.

Also confirm the RPC you think you are on, because a cluster **name** can be overridden by config:

```bash
solana genesis-hash --url "$SOLANA_RPC_URL"
solana cluster-version --url "$SOLANA_RPC_URL"
```

Genesis prefixes: devnet `EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, testnet `4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z`,
mainnet `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`.

> **Atum's `testnet` environment runs on Solana DEVNET.** The testnet profile maps
> `Solana: solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` — devnet's genesis prefix.
> `config/tokens/testnet.yaml:88` even warns not to confuse the two.
>
> **Solana's actual testnet cluster is not a viable target.** Its config block copy-pasted devnet's
> mint addresses, and mints are cluster-local: USDC `4zMMC9srt…` is a real 82-byte SPL mint on devnet
> but **0 bytes / System-owned on testnet**, and its settler program IDs are placeholder `1111…`.
> Deploying there means standing up a token environment first. (Separate live defect worth a ticket:
> the configured USDT mint `BQcdHdAQ…` exists on **neither** cluster.)

---

## STEP 4 — Drain (NOT a gate on the fresh-ID route)

A deposit belongs to the program that created it. The v4 programs have their own PDA namespace and
never read a pre-v4 `DepositInfo`, so a fresh-ID deploy strands nothing. A pre-v4 deposit settles
only against the pre-v4 program, with a signature over a preimage carrying that program's ID *and*
its domain version (2, not 5). Settle one with a tool that takes both as parameters.

> **A deposit whose releaser key is gone is undrainable by anyone.** Both release and refund verify a
> signature by `deposit.releaser` (`escrow.rs:570` / `:685`); there is **no admin force-refund and no
> deadline** on `DepositInfo` (`expiration` belongs to `EscrowDelegate`).

Enumerate open deposits with `getProgramAccounts` on the program ID, filtered on the `DepositInfo`
size (313 bytes in v4, 217 bytes pre-v4), and spot-check individual accounts:

```bash
solana account <pda> --url "$SOLANA_RPC_URL"
```

On any in-place route open deposits are fatal: a 217-byte `DepositInfo` cannot be deserialized by a
program expecting 313, and the deposit becomes neither releasable nor refundable with no rescue
instruction.

---

## STEP 5 — Deploy (once the decision in Step 0 is made)

Fresh program IDs are the only route that yields fresh PDAs. **Use the keypairs from Step 2c; do not
generate new ones here, or every ID you have already propagated goes stale.**

### Use the driver

```bash
atum-svm-deploy --check        # read-only: env, keypairs vs declare_id!, id-bytes, balance, chain state
atum-svm-deploy                # dry: preflight + anchor build + artifact checks. Spends nothing.
atum-svm-deploy --broadcast    # deploy both programs, then initialize (prompts for the cluster id)
```

It sequences what the rest of this step describes by hand, and refuses rather than proceeding when a
precondition is wrong. Specifically it will not let you:

| | |
|---|---|
| deploy with the obsolete `SKIP_REVOKE_AUTHORITY` set | `deploy.ts` refuses it; revoking is opt-in through `REVOKE_UPGRADE_AUTHORITY=true` |
| deploy a keypair whose pubkey ≠ `declare_id!` | which is `DeclaredProgramIdMismatch` (4100) on the first instruction, after you have paid |
| deploy with a stale `PROGRAM_ID_BYTES` | which **succeeds**, then disagrees with every off-chain signer |
| let `ESCROW_CLUSTER_ID` be inferred | it is write-once with no setter |
| deploy into an id you do not control | it reads the on-chain upgrade authority and compares it to your payer |
| redeploy over a recorded deployment | unless you pass `FORCE=1` |

Two things it does differently from `scripts/deploy.ts`, and both matter:

- **It deploys one program at a time, with `-p`.** `deploy.ts` runs a bare `anchor deploy`, and
  anchor's default is *"deploys each program in the workspace"* — which here includes
  `mock_transfer_hook`, a test-only program whose `declare_id!` does not match the keypair anchor
  auto-mints for it. On any non-localnet cluster that aborts the run **after** you have spent SOL.
- **It passes `--program-keypair`**, so the deployed id comes from the keypair you custodied. Anchor
  takes the id from that file, *not* from `Anchor.toml`, so a stale `target/deploy/` keypair
  otherwise deploys to the wrong id while `Anchor.toml` still claims the right one.

Initialization is still `deploy.ts` — the driver calls it with `SKIP_BUILD` and `SKIP_DEPLOY` set, so
the phase that is worth reusing is reused and the phase that is dangerous is not.

Deployment records go to `$OUT` (default `~/atum-v4-svm-deploy/`), never into the source tree.

The rest of this step is the manual equivalent, and the reference for what the driver is doing.

### ⚠️ Two ways to brick this permanently — read before running anything

**1. Revoking the upgrade authority is permanent.** `deploy.ts` keeps the authority unless
`REVOKE_UPGRADE_AUTHORITY=true` is set, which makes the program **permanently unpatchable**. Leave it
unset, and do not set the obsolete `SKIP_REVOKE_AUTHORITY`: `deploy.ts` refuses to run with it.

**2. The hash anchors must be re-derived OUT OF BAND, by hand.** The module doc in `signatures.rs`
says it outright: *"NEVER regenerate these from code output … a 'fix' that copies the new computed
value in is a silent wire-format break."* Copying whatever the new code prints makes the tests green
while the wire format silently diverges from every off-chain signer. Derive them independently.

```bash
cp "${ATUM_HOME:-$HOME/.atum}/keys/escrow-keypair.json"            target/deploy/escrow-keypair.json
cp "${ATUM_HOME:-$HOME/.atum}/keys/fulfillment_proxy-keypair.json" target/deploy/fulfillment_proxy-keypair.json
solana-keygen pubkey target/deploy/escrow-keypair.json             # must equal $ESCROW_ID
solana-keygen pubkey target/deploy/fulfillment_proxy-keypair.json  # must equal $FP_ID
# NB not `anchor keys list` — it is not read-only (Step 2c)
# propagate the IDs per Step 2c — NOT a single `anchor keys sync`
# and update PROGRAM_ID_BYTES (signatures.rs:377-381) — raw bytes, not base58
cd "$(git rev-parse --show-toplevel)/contracts/svm/source"                     # anchor and cargo both need the source tree
cargo test -p escrow        # see the count trap below
anchor build
```

> **The "8 failing tests" figure is a trap.** Repointing `declare_id!` fails 8 tests; fixing
> `PROGRAM_ID_BYTES` as well still fails 8, but a different 8. The real surface is **10 tests
> across 13 anchor constants**. An operator working "until 8 → 0" watches the number sit at 8 and
> reasonably concludes nothing changed.
>
> `PROGRAM_ID_BYTES` (`signatures.rs:377-381`) is deliberately spelled as **raw bytes** so no base58
> decoder sits in the derivation path — which means it cannot be authored before the keypair exists,
> and all 13 anchors depend on that byte value. Deploying first is therefore the correct order.

Then either the scripted path:

**Devnet, filled in for the current setup.** Copy-pasteable:

```bash
cd "$(git rev-parse --show-toplevel)/contracts/svm/source"

source "${ATUM_HOME:-$HOME/.atum}/env/svm.env"     # see "Set the environment" above

# Fail loudly rather than deploying against an empty variable.
for v in SOLANA_RPC_URL ESCROW_CLUSTER_ID DEPLOYER_KEYPAIR DEFAULT_ADMIN \
         TOKEN_CONFIG_AUTHORITY TREASURER PAUSER; do
  eval ": \"\${$v:?not set — fill in \${ATUM_HOME:-$HOME/.atum}/env/svm.env}\""
done
[ -z "${SKIP_REVOKE_AUTHORITY+x}" ] || { echo "unset SKIP_REVOKE_AUTHORITY: deploy.ts refuses it"; return 1; }
[ "${REVOKE_UPGRADE_AUTHORITY:-}" != "true" ] || { echo "REVOKE_UPGRADE_AUTHORITY=true would freeze the programs"; return 1; }

npx ts-node scripts/deploy.ts
```

### Every variable `deploy.ts` reads

Enumerated from `scripts/deploy.ts` itself, not from its header comment — the header omits three.

| Variable | Typical value | Where it comes from / how to get it | If you omit it |
|---|---|---|---|
| `SOLANA_RPC_URL` | the cluster endpoint | cluster endpoint; `ANCHOR_PROVIDER_URL` is accepted as a fallback (`:240`) | **required** — no default |
| `ESCROW_CLUSTER_ID` | `devnet` / `mainnet` | the 32-byte cluster tag written into `ProtocolConfig` (`:287`) | `detectCluster(rpcUrl)` — **see the trap below** |
| `DEPLOYER_KEYPAIR` | `"${ATUM_HOME:-$HOME/.atum}/keys/svm-deployer.json"` | what `atum-svm-import-deployer --write` produced (Step 2a) | `<repo>/.anchor/deployer.json` (`:247`) |
| `DEPLOYER_PRIVATE_KEY` | *(unset)* | base58 alternative; **wins over the keypair path** if both are set (`:248`) | unused |
| `DEFAULT_ADMIN` | `$ADMIN` | any pubkey — a plain argument, no key needed at deploy time | **the deployer** (`:271`) |
| `TOKEN_CONFIG_AUTHORITY` | `$ADMIN` | ditto | **the deployer** (`:276`) |
| `TREASURER` | `$ADMIN` | ditto | **the deployer** (`:281`) |
| `PAUSER` | `$ADMIN` | ditto | **the deployer** (`:285`) |
| `DEFAULT_ADMIN_DELAY_SECONDS` | `0` | seconds for the two-step admin transfer | **`"0"`** (`:291`) — see below |
| `REVOKE_UPGRADE_AUTHORITY` | *(unset)* | `"true"` permanently revokes the upgrade authority | the authority is kept |
| `SKIP_REVOKE_AUTHORITY` | *(never set)* | obsolete | `deploy.ts` refuses to run if it is set |
| `SKIP_BUILD` / `SKIP_DEPLOY` | *(unset)* | `"true"` to skip those phases (`:300-301`) | both run |
| `SOLANA_WS_URL` | *(unset)* | websocket endpoint (`:154`) | derived from the RPC URL |

### All four authorities may be the deployer

On a testnet, pointing `DEFAULT_ADMIN`, `TOKEN_CONFIG_AUTHORITY`, `TREASURER` and `PAUSER` at the
deployer mirrors the EVM and TVM testnet precedent, keeps the three VMs consistent, and is what the
defaults would give you anyway. Set them **explicitly** regardless: it makes the intent reviewable
and stops a silent inheritance if the deployer ever changes.

**On mainnet, split them.** One key holding all four means a single compromise drains fee revenue
and pauses the protocol; see the EVM guide's note on admin-threshold risk for the same argument.

They are **plain pubkey arguments**, not signers, so they can name a key you do not hold — a Safe, a
Squads vault, a colleague. `DEFAULT_ADMIN` is the one to think hardest about, because it is the role
that can rotate the other three.

> **`ESCROW_CLUSTER_ID` is write-once and there is no setter.** Omit it and `detectCluster`
> (`deploy.ts:407-416`) string-matches the RPC URL: it looks for `mainnet`, `devnet`, `testnet`,
> `127.0.0.1`/`localhost` — and **falls through to `"devnet"` for anything unrecognised**. So a
> private or aliased mainnet endpoint whose hostname lacks the word "mainnet" silently stamps
> `cluster_id = "devnet"` into `ProtocolConfig`. That value is a member of every signature preimage,
> so every deposit would then fail — permanently, because the next phase of the same script revokes
> upgrade authority. Set it explicitly. (Verified: the live devnet config's tag reads `devnet`.)

> **`DEFAULT_ADMIN_DELAY_SECONDS` defaults to `0`, and this is your chance not to repeat the EVM/TVM mistake.**
> EVM and TVM both went live with a **1-second** admin-transfer delay, which is effectively no delay
> and is still open as a concern on all 9 live contracts. SVM takes the value as a deploy-time
> argument, so a real delay costs nothing here. `0` on devnet is defensible for iteration speed —
> but make it a decision, not an inherited default, and use a genuine delay (e.g. `86400`) for
> anything production-facing.

For mainnet, do it by hand instead — `anchor deploy -p <prog> --program-keypair … --provider.cluster …`
then `initialize_protocol` — because the mainnet authority is an off-curve Squads PDA that no TS
script can sign for.

`anchor deploy` in 0.32.1 uploads the IDL automatically. Do not skip it: `solana-admin-utils`
calls `Program.fetchIdl` and every admin script aborts without an on-chain IDL.

---

## STEP 6 — Post-deploy, in order

Every command below is runnable as written **once you have sourced the environment** — see
[Set the environment](#set-the-environment) near the top. A fresh shell has none of these set.

### 6a. `initialize_protocol`

Run by `deploy.ts` phase 3. Verified on-chain rather than taken from the script's own report:

| What to assert | Expected |
|---|---|
| escrow `ProtocolConfig` PDA | **216 B**, and `cluster_id` reads back the value you set |
| fulfillment_proxy `ProtocolConfig` PDA | **636 B** — the v4 layout the readiness gate looks for |
| IDL accounts | present for both programs (escrow ~11.5 KB, proxy ~6.5 KB) |
| all four roles | the authorities you passed, not the defaults |
| `signature_domain_version` | **5** |
| upgrade authority | **RETAINED** (unless you deliberately revoked) |

Assert the sizes rather than reading the script's own report — a wrong-but-plausible size is the
failure this table exists to catch.

Re-run initialization without redeploying — idempotent via `init_if_needed`:

```bash
SKIP_BUILD=true SKIP_DEPLOY=true npx ts-node scripts/deploy.ts
```

Read the state back independently:

```bash
npx ts-node scripts/read-state.ts --rpc "$SOLANA_RPC_URL"
```

Or without any repo tooling — assert the sizes directly, which is the check that matters:

```bash
solana program show "$ESCROW_ID" --url "$SOLANA_RPC_URL" | grep -E 'Program Id|Authority'
solana program show "$FP_ID"     --url "$SOLANA_RPC_URL" | grep -E 'Program Id|Authority'
```

> **`verifyDeployment` runs before initialization and will stop you** with
> `Escrow program not found or not executable at <id>` if the programs are not deployed. That is
> correct, not a bug: `SKIP_DEPLOY=true` deploys nothing, so they must already exist. Deploy first
> (Step 5), then re-run with both skips.

The authorities and `default_admin_delay_seconds` are plain Pubkey **arguments**.
`signature_domain_version = 5` is stamped here and there is **no setter** — getting it wrong means
redeploying at yet another program ID.

### 6b. Create the per-cluster ALT — exactly one

> **One table per cluster. Never a second one.** The settler holds a **single**
> `addressLookupTable` per cluster — `schema.ts` types it as
> `z.union([solanaAddress, "@<path>"]).optional()` and `instance.ts`'s `lookupTables()` returns
> `this.addressLookupTable ? [it] : []`. A second table therefore **cannot be wired**, so every
> mint that lives only in it is silently unserved. When you need to cover another mint, you
> **extend** the existing table — see "Later: adding a mint" below.
>
> This is not hypothetical. Mainnet shipped with **two** single-mint tables,
> `9p8MkwJ9weNq2SjT6XW31wC6tkBzdAtcKeShSCg4Li1Z` (USDC) and
> `7EDbzZDzr7XD4yDDfUwNYYpP8qZ2H7g16uQnBry52Lei` (USDT), whose indices 0–6 were byte-identical
> and which differed **only** at the mint and its `mint_fee_config` PDA. Whichever one was
> configured, the other token's deposit lost two tabled entries — 64 bytes against a handful of
> bytes of headroom — and failed as an opaque `RangeError`. It was resolved on 2026-08-28 by
> extending the USDC table to 11 entries, **not** by adding a third table. The USDT
> table is now redundant and still active.

**Ordering matters and nothing enforces it.** `create-address-lookup-table.ts` resolves the escrow ID
from `Anchor.toml` per cluster and tables `getProtocolConfigAddress(escrowProgramId)`. Run it *before*
Step 2c's ID propagation and the table holds the **old** `protocol_config` PDA — a plausible-looking
table that is silently wrong on every deposit. Run it only after the flip, i.e. now.

`--measure` is fully offline and reports the size of deposit + reserve in one transaction, with the
deposit signed in its longest accepted form (`v0` envelope) and the reserve bare. Measured: with one
signature it is **1373 bytes** without the table (141 over the 1232 limit) and **1192 bytes** with it
(40 bytes of headroom). The settler is the only signer, so the two-signature row is a what-if. A
deposit alone fits a legacy transaction. That is why the ALT is required rather than an optimisation.

`staticAddresses()` tables the accounts that are identical on every deposit — the escrow's
`protocol_config` PDA, the instructions sysvar, and the per-mint accounts — so each 32-byte key
becomes a 1-byte index and buys back the room the combined transaction needs. That is why it
needs to know which mints you will transact.

Measure first, then rehearse, then create:

```bash
# 1. what the transaction actually costs on this cluster, rather than the doc's estimates
npx ts-node scripts/create-address-lookup-table.ts --measure

# 2. rehearse — no transaction. --mint is the SPL mint you will transact ($MINT above,
#    repeat the flag for more than one mint.
npx ts-node scripts/create-address-lookup-table.ts --dry-run --mint "$MINT"

# 3. create and extend it
npx ts-node scripts/create-address-lookup-table.ts \
  --keypair "$DEPLOYER_KEYPAIR" --mint "$MINT" --rpc "$SOLANA_RPC_URL" --send
```

`--keypair` alone is a rehearsal and says so; `--send` is what broadcasts. That matches
`fp-settler-allowlist.ts`, and the two deliberately agree — an admin script where `--keypair` sends and
a sibling where it does not is how someone broadcasts by accident after learning the other one.

Capture the printed address and verify it resolves:

```bash
export SOLANA_DEVNET_ADDRESS_LOOKUP_TABLE=<table-address-from-step-3>
solana address-lookup-table get "$SOLANA_DEVNET_ADDRESS_LOOKUP_TABLE" --url "$SOLANA_RPC_URL"
```

#### Later: adding a mint to an existing ALT

The whole step, for a cluster that already has a table. **Extend it — do not create a second one**,
for the reason in the callout above.

**Two gates before you write anything.**

1. **The mint must exist and be token-owned.** Run the "Verify a mint exists before configuring it"
   check. `create-address-lookup-table.ts` refuses an absent or non-token-owned mint, which is the
   backstop, but by then you have already committed to a value. The devnet USDT row in "Which mint"
   is the live counter-example: `BQcdHdAQW1hczDbBi9hiegXAR7A98Q9jx3X3iBBBDiq4` is System-owned with
   0 bytes of data — a wallet, not a mint — and `spl-token display` reports
   `AccountNotParsable(SplToken)`. Tabling it would be *safe* (a tabled address is inert) but
   useless, and it would make a coverage check pass while the token still cannot be transacted.
2. **Tabling makes a deposit *fit*; 6c makes the token *work*.** The two are independent. You may
   table before allowlisting — the `mint_fee_config` address is seed-derived and does not depend on
   the allowlisting having happened — but do not read a successful extend as "the token is live".
   Confirm the mint's `mint_fee_config` is initialised, or schedule 6c.

> **You are almost certainly in a fresh shell.** This is the subsection people reach months later,
> so the Step-"Set the environment" exports are gone. `ESCROW_ID` in particular is **required and
> has no default** — the script refuses to fall back to `Anchor.toml`, because that would silently
> table the retired v1/v3 program. Re-source your per-network env file first. Verified: without it
> the run dies with `ESCROW_ID is not set, and there is no default`, before touching the network.

**Preferred route — the script.** It derives the `mint_fee_config` PDA for you, so there is no
hand-copied address to get wrong, and it reports the delta against the existing table:

```bash
# rehearse: reports the existing table, how many of your addresses are missing from it,
# and the measured byte savings. Broadcasts nothing, and needs no keypair.
npx ts-node scripts/create-address-lookup-table.ts \
  --table "$SOLANA_DEVNET_ADDRESS_LOOKUP_TABLE" --mint <new-mint> --dry-run --rpc "$SOLANA_RPC_URL"

# append them
npx ts-node scripts/create-address-lookup-table.ts \
  --keypair "$DEPLOYER_KEYPAIR" --table "$SOLANA_DEVNET_ADDRESS_LOOKUP_TABLE" --mint <new-mint> --send
```

The rehearsal ends with the two lines that decide whether you need to do anything at all:

```
Existing table <address>: N addresses, authority <pubkey>
Missing from it: M
```

If `M` is 0 the mint is already covered — stop. `M` can also be **larger than the two per-mint
entries** you expected: devnet's table omits the escrow and fulfillment-proxy program ids that
mainnet's table carries, so a rehearsal there reports 2 missing even for a mint already tabled.
That is a real shape difference between the clusters, not a rehearsal bug — devnet simply
compresses less. Decide deliberately whether to take those two as well.

Without `--keypair` the rehearsal **cannot** verify you hold the table's authority, and it says so;
that check happens only on the real run.

**Fallback route — the raw CLI**, when the script is not to hand. Take the two addresses from the
`--dry-run` above rather than deriving them by hand:

```bash
solana address-lookup-table extend "$SOLANA_DEVNET_ADDRESS_LOOKUP_TABLE" \
  --addresses <MINT>,<MINT_FEE_CONFIG_PDA> \
  -k "$DEPLOYER_KEYPAIR" \
  --authority "$DEPLOYER_KEYPAIR" \
  --payer "$DEPLOYER_KEYPAIR" \
  --url "$SOLANA_RPC_URL"
```

#### Retiring a table the cluster no longer names

A cluster names exactly one table, so extending one to cover every mint leaves any earlier
single-mint table orphaned. Mainnet went through this: two single-mint tables, USDC's extended
to carry both, and USDT's left holding rent for nothing. Retire the orphan rather than leaving
it, or someone later wires the wrong address and rediscovers the packet-limit failure.

**Check first that nothing names it.** Grep the plugin configs and the deploy tree for the
address; only the notes should mention it. Then deactivate, wait, and close:

```bash
# 1. deactivate — irreversible in the sense that the table can never be used again
solana address-lookup-table deactivate <ORPHAN_TABLE> \
  -k "$DEPLOYER_KEYPAIR" \
  --url "$SOLANA_RPC_URL" \
  --bypass-warning

# 2. wait out the cooldown, ~513 slots (about four minutes). `close` before it expires
#    fails with a distinct error; that is impatience, not a new problem.

# 3. close — returns the rent to the fee payer (or --recipient <ADDRESS>)
solana address-lookup-table close <ORPHAN_TABLE> \
  -k "$DEPLOYER_KEYPAIR" \
  --url "$SOLANA_RPC_URL"
```

**`deactivate` and `close` take no payer flag, unlike `extend`.** `extend` has `--payer` because
a longer table costs more rent; these two add no rent, so the fee comes from the default
configured keypair and there is no option to redirect it. `--fee-payer` is not accepted here
either — it exists on other `solana` subcommands, which is exactly why reaching for it is the
easy mistake.

That matters because **`--authority` alone is not enough**. It changes who authorises the table
change; the fee payer stays as whatever `solana config get` reports. If that keypair holds no
SOL the CLI fails with a bare:

```
Error: Deactivate failed: RPC response error -32002: Transaction simulation failed;
```

The underlying error is `AccountNotFound`, and it refers to the **fee payer**, not the table or
the authority: a zero-lamport account does not exist on Solana, so the runtime rejects the
transaction before reaching the instruction. Changing the RPC URL will not help, and the CLI's
message does not say which account it could not find. `-k "$DEPLOYER_KEYPAIR"` fixes it in one
flag, because `--authority` already defaults to the keypair `-k` names.

**`--url` is not optional on any of these.** `solana config` on a machine that has run a
localnet points at `http://127.0.0.1:8899`, and every command above will silently talk to it
and report something confidently wrong about mainnet.

> **`-k` is the load-bearing flag, and omitting it fails in a way that names nothing.** The
> subcommand has three roles: `--authority` is the table's authority signer, `--payer` is **only the
> rent payer** for the enlarged account, and `-k` / the config keypair is the **transaction fee
> payer**. Pass `--authority` and `--payer` but leave `-k` unset and the fee payer stays whatever
> `~/.config/solana/cli/config.yml` names. If that account has never been funded it does not exist
> on chain, and the RPC rejects preflight with a bare
> `-32002: Transaction simulation failed;` — no reason attached, and indistinguishable from an
> authority error. That cost two failed mainnet attempts on 2026-08-28. Simulating the instruction
> with `sigVerify: false` and varying only the fee payer gives `AccountNotFound` for the unfunded
> key and `null` for the funded one; that is the fastest way to tell the two apart.
>
> Note also that `solana config get` on a fresh machine points at `http://127.0.0.1:8899`, so an
> omitted `--url` silently targets a local validator.

**Verify, with arithmetic rather than a glance:**

```bash
solana address-lookup-table get "$SOLANA_DEVNET_ADDRESS_LOOKUP_TABLE" --url "$SOLANA_RPC_URL"
```

- **Entry count** rose by exactly 2 per mint added.
- **Account size** is `56 + 32 × entries` bytes, exactly. The mainnet extend went 9 → 11 entries and
  344 → 408 bytes, and cost `0.000445440 SOL` in additional rent.
- **The existing prefix is unchanged** — appended entries go on the end, so every index the settler
  already resolved keeps its meaning. If an earlier index moved, something other than an extend
  happened.
- **`Last Extended Slot` advanced**, and appended addresses are not usable **within that same slot**.
  Sub-second in practice, but do not read an immediate failure as the extend not having landed.
- Re-derive the PDA independently and confirm it is present, rather than trusting that the address
  you passed is the one you meant.

**Do not create a second table** to "keep tokens separate", and do not deactivate the table you
just extended. If a redundant single-mint table already exists (mainnet's
`7EDbzZDzr7XD4yDDfUwNYYpP8qZ2H7g16uQnBry52Lei`), leave it active until the config change naming the
combined table has shipped and been observed working — it is the rollback target. Deactivation has a
cooldown and is irreversible, so closing it is a deliberate decision, not cleanup.

> **An unset table variable is indistinguishable from "this cluster has no table yet".** The settler
> reads `SOLANA_ADDRESS_LOOKUP_TABLE` / `SOLANA_DEVNET_ADDRESS_LOOKUP_TABLE`; `${VAR:-}` expands to
> the empty **string**, which is coerced to `undefined`, so the settler boots happily and the deposit
> transaction overruns at runtime — surfacing as `RangeError: encoding overruns Uint8Array` thrown
> inside `simulateTransaction`, naming neither the size limit nor the field that grew. Nothing in
> your settler or service configuration carries the address yet; that is still unowned.

### 6c. Allowed mints + fee config

Fresh PDAs under a new program ID, so **every mint must be re-seeded** — nothing from the old
allowlist carries over. Same policy as EVM and TVM: `20000` = 2 bps, `250000000` = the $250 cap,
6-decimal tokens only.

```bash
npx ts-node scripts/configure-token.ts \
  --keypair "$DEPLOYER_KEYPAIR" \
  --mint "$MINT" \
  --fee-percentage 20000 --min-fee 0 --max-fee 250000000 \
  --rpc "$SOLANA_RPC_URL"
```

Verify the fee config landed:

```bash
npx ts-node scripts/read-state.ts --rpc "$SOLANA_RPC_URL" | grep -A6 -i 'mint\|fee'
```

Safe to re-run: it skips `allowMint` when the mint is already allowlisted and only updates fees —
unlike the EVM/TVM pair, where allow and set-fee are exact inverses and the wrong one always reverts.

> **Only USDC is seedable on devnet.** `config/tokens/testnet.yaml:89-95` lists two mints for
> `solana:EtWTRABZ…`: USDC `4zMMC9srt…` (verified — a real 82-byte Tokenkeg mint) and USDT
> `EJwZgeZrdC8TXTQbQBoL6bfuAnFUQW8NuAQ73B3KFdsg` (verified — **0 bytes, System-owned; it does not
> exist**). Configuring the second will fail. That is a config defect worth a ticket, not something to
> work around here.
>
> `--max-fee` must equal the cap the offchain signer uses, for the same reason as TVM: a mismatch
> reverts on both release and refund above the cap threshold and agrees below it, so it survives
> testing.

### 6d. Settler allowlist — provision nothing, leave dormant

The settler allowlist ships **dormant** and that is the intended state for this deploy. Tooling now exists —
`scripts/fp-settler-allowlist.ts`, named for the `fp-*` convention the other fulfillment_proxy admin
scripts use — so it *can* be provisioned when a cutover calls for it. Confirm it is dormant and stop
there:

```bash
npx ts-node scripts/read-state.ts --rpc "$SOLANA_RPC_URL" | grep -i 'enforce\|settler'
# expect enforce_settler_allowlist = false
```

When the time comes, the order is not optional — **add settlers first, enable second**:

```bash
# DO NOT RUN AS PART OF THIS DEPLOY
# Dry by default; --send is what broadcasts, matching create-address-lookup-table.ts.
npx ts-node scripts/fp-settler-allowlist.ts add --keypair "$DEPLOYER_KEYPAIR" \
  --settler <settler-pubkey> --rpc "$SOLANA_RPC_URL" --send      # 1. populate
npx ts-node scripts/fp-settler-allowlist.ts enforce-on --keypair "$DEPLOYER_KEYPAIR" \
  --rpc "$SOLANA_RPC_URL" --send                                 # 2. only then enable
```

The script enforces that order itself: `enforce-on` refuses against an empty allowlist, and it
rejects the default pubkey, the System program and the clock sysvar as settlers — allowlisting one of
those would satisfy the emptiness check without authorising anything.

> Enabling enforcement against an **empty** allowlist makes `strict_fulfill` revert
> `UnauthorizedSettler` for *every* settler, including the real ones. The allowlist is readable, so
> the script's `assertSafeOrdering` refuses that rather than warning about it — but do not rely on a
> guard you could have avoided tripping.
>
> Note the flip side: dormant `strict_fulfill` is **permissionless**, so any funded caller can strict-fulfill
> a quote. Since CORE-2515 the idempotency marker is seeded by the settler as well, so such a caller
> only marks its own slot and cannot block the legitimate settler; it costs the caller its own funds.
> The allowlist is no longer what protects the marker.

*(Earlier revisions of this step said no allowlist tooling existed. True before `scripts/fp-settler-allowlist.ts` landed.)*

---

## STEP 6e — Verified builds on explorers (decide BEFORE you freeze)

A "verified build" is what makes Solana Explorer, Solscan and SolanaFM show a program as verified.
All three read the same registry (`verify.osec.io`), and that registry's flag is set by **osec
rebuilding your source inside a standardised Linux container and matching the hash on chain**. The
on-chain verification PDA records who claims what; it does not set the flag. There is no second
registry and no way to assert the result.

**This means `anchor build` is not enough.** A native build and a container build of the same commit
are not the same bytes. Measured on the v4 deploy, at identical `solana-cargo-build-sbf 2.3.0`,
`platform-tools v1.48`, `rustc 1.84.1`:

| section | native (macOS) | container | |
| -- | -- | -- | -- |
| `.rodata` | 20971 | 20967 | the embedded `/Users/runner` vs `/home/runner` stdlib paths |
| `.text` | 422760 | 423256 | **+496 bytes of generated code** |

It is not version drift; the macOS and Linux distributions of platform-tools ship stdlibs compiled on
different hosts. There is no version to pin that makes them agree.

### ⚠️ If you revoke the upgrade authority, you get exactly ONE chance

Revoking is the right end state — a program nobody can rewrite is the point. But revocation and
verification interact, and the order is unforgiving:

> **A frozen program can never be re-deployed. If it was not built in the container, it can never be
> verified. Not "later", not "when someone gets to it" — never.**

So when the intent is to freeze (`REVOKE_UPGRADE_AUTHORITY=true`, or freezing later), the **initial
deploy must use the container-built artifact**. Build with `solana-verify build`, deploy *that*
artifact, register the verified build, confirm `is_verified`, and only then revoke.

Deploying natively and planning to "fix verification afterwards" works only while the authority is
still held. That is the position the v4 programs are in today: they are reproducible byte-for-byte
from `svm-v4-deployed`, but they were built natively, so they can only become verified by being
upgraded to container-built bytes first — which is possible solely because the authority was kept.

### The order that works

```bash
# 1. build in the container, not with a bare `anchor build`
solana-verify build --library-name escrow

# 2. deploy THAT artifact (the normal Step 5 driver, or `solana program deploy` for an upgrade)
# 3. register, which writes the on-chain PDA and submits the remote build
solana-verify verify-from-repo https://github.com/Atum-Labs/protocol   --commit-hash <sha> --program-id "$ESCROW_ID" --library-name escrow   --mount-path contracts/svm/source --url "$SOLANA_RPC_URL"

# 4. confirm, then and only then consider freezing
curl -s "https://verify.osec.io/status/$ESCROW_ID"
```

**The commit you register must be reachable from a branch or tag**, not merely exist. osec *clones*
the repo, and a clone cannot see what no ref points at — while GitHub's API happily serves orphaned
commits, so "it exists" is not the test. Tag it.

For upgrading the programs already deployed, the tooling and the full runbook are in
[`../UPGRADE-VERIFIED-BUILDS.md`](../UPGRADE-VERIFIED-BUILDS.md) and
[`upgrade-verified.sh`](upgrade-verified.sh).

---

## STEP 7 — Verify

**Derive the PDAs, do not paste them.** `protocol_config` is a PDA seeded `["protocol_config"]` under
each program ID, with no program ID among the seeds — so it moves whenever the program ID does, and a
hardcoded address silently goes stale. The CLI derives it:

```bash
: "${ESCROW_ID:?run: source "${ATUM_HOME:-$HOME/.atum}/env/svm.env"}"
: "${FP_ID:?run: source "${ATUM_HOME:-$HOME/.atum}/env/svm.env"}"

ESCROW_CONFIG_PDA=$(solana find-program-derived-address "$ESCROW_ID" string:protocol_config)
FP_CONFIG_PDA=$(solana find-program-derived-address "$FP_ID"     string:protocol_config)
echo "escrow protocol_config: $ESCROW_CONFIG_PDA"
echo "proxy  protocol_config: $FP_CONFIG_PDA"

solana account "$ESCROW_CONFIG_PDA" --url "$SOLANA_RPC_URL"
solana account "$FP_CONFIG_PDA"     --url "$SOLANA_RPC_URL"

npx ts-node scripts/read-state.ts --rpc "$SOLANA_RPC_URL"
```

The addresses are program-ID-derived, so they differ per deployment. What must **not** differ is the
size:

| PDA | Expected size |
|---|---|
| escrow `protocol_config` | **216 B** |
| fulfillment_proxy `protocol_config` | **636 B** |

**Detect layout by byte length, never by assumption.** A mismatched Anchor IDL does not fail — it
*fabricates* trailing fields from adjacent bytes, so a 119-byte account decoded with the v4 IDL reads
as plausible-looking wrong state. The size is the load-bearing assertion:

```bash
solana account "$FP_CONFIG_PDA" --url "$SOLANA_RPC_URL" | grep Length   # must be 636
```

**636** is the v4 proxy layout; the old V1 accounts are **119**. The escrow's own config is 216 B —
don't confuse the two programs' sizes.

A one-liner that asserts rather than prints:

```bash
for pair in "$ESCROW_ID:216" "$FP_ID:636"; do
  id=${pair%%:*}; want=${pair##*:}
  pda=$(solana find-program-derived-address "$id" string:protocol_config)
  got=$(solana account "$pda" --url "$SOLANA_RPC_URL" 2>/dev/null | awk '/Length:/{print $2}')
  [ "$got" = "$want" ] && echo "  ok   $id  $pda  $got B" \
                       || echo "  FAIL $id  $pda  got ${got:-nothing}, want $want B"
done
```

---

## STEP 8 — Record the addresses

Under a new program ID **everything** changes. A sweep for the two old IDs across both repos
(excluding `node_modules`, `target`, `.git`, lockfiles) returns **23 files in protocol and 34 in
atum-core**. Triage matters more than the count, and it splits the same way as the TVM cutover: an
address that code **calls** must change; an address a test **hashes** must be *regenerated*, never
hand-edited.

**Must change — protocol**

| Path | Note |
|---|---|
| `contracts/svm/source/Anchor.toml` | all four cluster tables |
| `contracts/svm/source/programs/{escrow,fulfillment_proxy}/src/lib.rs` | `declare_id!` |
| `contracts/svm/source/programs/escrow/src/utils/signatures.rs:540` | base58 literal `keys sync` does not scan (doc comment at `:374`) |
| `contracts/svm/source/scripts/deploy.ts` | |
| `contracts/svm/deployments-v*.json` | add a **v4** file; keys are truncated 32-char genesis prefixes |
| `contracts/svm/deploy/readiness.sh:13-14` | **this guide's own tool** hardcodes the old IDs, so it would check the wrong programs after cutover |
| `key-management/.../{settler,sender}-testnet.example.yaml` | Turnkey policy templates: `allowedPrograms` pins the escrow and proxy, and these *are* enforced for transactions |

**Must change — the consumer side**

New program IDs have to reach every service, agent and environment that talks to the escrow, and
that inventory is infrastructure-specific: service config, the monitor's chain files, the settler
agents and their vendored copies of this tree, the per-environment infrastructure definitions, and
the deployment registries. It lives with the infrastructure, in `atum-core`, because the paths and
environment names are only meaningful there.

> **Atum operators:** the cutover inventory and its ordering live in `atum-core`. Work from that
> list rather than this guide for anything outside this repository -- it is the one that is kept
> current with the environments.

What matters from this side, and what the list cannot tell you, is that several of those consumers
hold **derived** values rather than the program ID itself. See the next two subsections.

**Regenerate, do NOT hand-edit** — the program ID is inside every signature preimage
(`crate::ID.as_ref()`), so these are *derived* values:

`contracts/svm/conformance/parity-golden.json` (it has a literal `"program_id"` field),
`bindings/go/escrow-encoding/encoding/*_test.go`, `bindings/typescript/escrow-encoding/src/*.test.ts`, and
`bindings/typescript/escrow-encoding/src/generated/*` (generated from the IDL). Same for atum-core's
`contracts/svm/bindings/**` and the various `*_test.go` / `*.test.ts` fixtures. This is the same set
as the 8 failing `cargo test -p escrow` cases — one cause, two surfaces.

Also re-check `svm_signature_domain_version` in payment-gw config against the live value: it sits
**inside** the deposit preimage, so a stale off-chain value fails every deposit independently of the
program ID.

**Four sites no grep of `src/` will find, all verified:**

- **`programs/escrow/src/utils/signatures.rs:377-381` — `PROGRAM_ID_BYTES`, spelled as raw bytes**, so
  a base58 grep misses it entirely and `anchor keys sync` never touches it. This is the load-bearing
  one: all 13 hash anchors derive from it.
Three more sit on the consumer side and are documented with the cutover inventory in `atum-core`,
because each depends on how a service is built and deployed rather than on this repository. In
outline, so you know to ask for them: a built artifact that ships its own copy of the config and so
ignores edits to source until it is rebuilt; settlement rows that persist the escrow address per
settlement, so a pre-cutover row retried after cutover builds against the retired program; and one
deployment path that supplies no program-ID override at all and therefore falls back to a compiled-in
literal.

---

## What needs writing before this can run

1. ~~A decision on new program IDs~~ — **done** (Step 2c). What remains is propagating them:
   `declare_id!` ×2, four `Anchor.toml` tables, `PROGRAM_ID_BYTES`, and the consumer configs in Step 8.
2. **Hash anchors re-derived out of band** — 10 tests / 13 constants, never copied from code output.
3. ~~ALT creation tooling~~ — **shipped** as `scripts/create-address-lookup-table.ts`; it and its
   settler-side counterpart both need **review**, plus a config home for the ALT address on the
   consumer side.
4. ~~Settler-allowlist provisioning~~ — **shipped** as `scripts/fp-settler-allowlist.ts`; needs review.
5. An SVM equivalent of the widened-witness assertion. Note `verify.sh` is a false green (Step 1).
6. A Squads path for mainnet admin operations (not built), since no TS script can sign for
   an off-curve authority. Mainnet's payer is already funded: 7.0187 SOL, above the 5.73 measured.
7. ~~An SVM section in the escrow-cutover runbook~~ — **written**, in `atum-core`, alongside the
   runbook split that moved the consumer inventory there. The document the cutover is executed from
   now covers this route; work from it rather than from this list.
