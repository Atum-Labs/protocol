# Solana: upgrading to container-built programs so explorers show them verified

This is the runbook for making the four deployed SVM programs registerable as **verified builds**.
It exists because the programs currently deployed cannot be verified as they stand, and the reason
is not a gap in the source.

Tooling: [`deploy/upgrade-verified.sh`](deploy/upgrade-verified.sh).

---

## Why an upgrade is required at all

The deployed programs **are** reproducible. That was measured, not assumed:

| cluster | program | deployed hash | reproduced from source |
| -- | -- | -- | -- |
| mainnet | escrow | `1c4631b269b3c83d…` | yes |
| mainnet | fulfillment_proxy | `4e851528acde6233…` | yes |
| devnet | escrow | `651cfe20e5254883…` | yes |
| devnet | fulfillment_proxy | `4abceddc0530697c…` | yes |

All four come from commit **`59fb32065`** with `declare_id!` set to the cluster's own program id,
built with `anchor build` on **macOS**, anchor 0.32.1 / solana 2.3.0. One commit covers both
clusters; only the embedded id differs.

So provenance is already established. What is missing is the *badge*, and the badge is not an
assertion anyone can make — it is a hash comparison:

- Solana Explorer, Solscan and SolanaFM all read the same registry (`verify.osec.io`); there is no
  second registry to submit to.
- The registry's hash comes from **osec rebuilding the source in a standardised Linux container**.
  The on-chain verification PDA records *who claims what*, and does not set the flag.
- A native macOS build and a container build of the same commit differ:

  | section | macOS (deployed) | container | |
  | -- | -- | -- | -- |
  | `.rodata` | 20971 | 20967 | the four `/Users/runner` vs `/home/runner` stdlib paths |
  | `.text` | 422760 | 423256 | **+496 bytes of generated code** |

  This is **not** version drift. Both report `solana-cargo-build-sbf 2.3.0`, `platform-tools v1.48`,
  `rustc 1.84.1`. The macOS and Linux distributions of platform-tools ship stdlibs compiled on
  different hosts, and they generate different SBF code at the same nominal version. There is no
  version to pin that makes the container match.

Therefore: **badge ⇒ container-reproducible bytes ⇒ the deployed bytes must change.** The only
route is to upgrade each program to its container-built artifact.

### What the upgrade does and does not change

| | |
| -- | -- |
| program id / address | **unchanged** |
| every PDA derived from it | **unchanged** |
| program state accounts | **unchanged** |
| source code | **unchanged** — same commit, same logic |
| compiled machine code | **changes** — `.text` differs by ~496 bytes |

The last row is the one that matters operationally. This is a real deploy of differently-compiled
code, not a cosmetic re-registration. It earns a full test pass.

---

## Environment mapping — read this before scheduling

Solana has **two** deployments, not four. The service environments map onto them two-to-one:

| environment | cluster | programs |
| -- | -- | -- |
| staging-testnet | Solana **devnet** | `2MHznjRg…` / `FGMSseEv…` |
| prod-testnet | Solana **devnet** | *the same two* |
| staging-mainnet | Solana **mainnet** | `5BD9UAUC…` / `CMxMPzpm…` |
| prod-mainnet | Solana **mainnet** | *the same two* |

**There is no independent staging soak on SVM.** Upgrading devnet moves staging-testnet and
prod-testnet at the same instant, because they are the same program accounts. The only isolation
available is devnet-before-mainnet.

Plan accordingly: devnet first, exercise it, then mainnet — and treat the devnet upgrade as
affecting prod-testnet from the moment it lands.

---

## Prerequisites

- Docker running. The container build is x86_64 and is emulated on Apple Silicon, so it is slow.
- The **upgrade authority keypair** for the cluster. Both are ordinary on-curve keypairs; no
  multisig ceremony is involved.
  - devnet `6jbdyQZcMm8AsgpNCQnEKHNzb2fqbV84JqeAabUqQ1bS`
  - mainnet `FVt14Ru5WvzRgy64qDBxCSPf815wUnrSsR4p58eaitBW`
- The **program keypairs are not needed**. An upgrade is signed by the authority, not the program
  key — `deployments-v4.json` records this explicitly.
- SOL for the buffer account on the cluster being upgraded.

### Which commit to register — decide this deliberately

Two defensible choices, and they ship different things:

| register | upgrade ships | notes |
| -- | -- | -- |
| **`59fb32065`** (default) | the compiler change only | the deployed source; minimal blast radius |
| `HEAD` or later | the compiler change **plus** all source drift since the deploy | includes `aeec9420`, which rewrote the Anchor error messages |

The script defaults to `59fb32065` so the upgrade is as close to a pure re-compile as it can be.
Passing `COMMIT=` anything newer is legitimate, but it is a decision: the script prints a warning
naming the range, and you should read it first:

```
git log --oneline 59fb32065..<your-commit> -- contracts/svm/source/programs/
```

### The commit you register must be reachable

`solana-verify` hands osec a repo URL and a commit, and osec **clones** the repo. A clone can only
see what a ref points at. GitHub's API happily serves unreachable commits, so checking that the
commit "exists" is not sufficient.

This is not hypothetical: `59fb32065`, the commit that reproduces the *currently* deployed bytes,
is unreachable from any branch or tag. `git fetch` refuses it with `not our ref`. Tag it before it
is garbage-collected, because it is the only proof of what is deployed today.

`upgrade-verified.sh` checks reachability in preflight and refuses to continue without it.

---

## Procedure

Dry run first. It reads the on-chain hashes, performs the container build, and prints the exact
commands it would run, without writing anything:

```
contracts/svm/deploy/upgrade-verified.sh --cluster devnet
```

Then apply, one cluster at a time:

```
export SVM_AUTHORITY_KEYPAIR=/path/to/devnet-authority.json
contracts/svm/deploy/upgrade-verified.sh --cluster devnet --apply
```

For each program the script will:

1. read the current on-chain hash;
2. set `declare_id!` to that cluster's program id — **temporarily**, restored on every exit path
   including Ctrl-C;
3. build in the container and report the hash;
4. write a buffer, then `solana program deploy --program-id …` to upgrade in place;
5. confirm the new on-chain hash equals the container build;
6. run `verify-from-repo`, which writes the on-chain PDA and submits the remote job;
7. poll `verify.osec.io/status/<id>`.

Step 7 is asynchronous. `is_verified` may still be false when the script exits; re-check with
`curl -s https://verify.osec.io/status/<program-id>`.

After both clusters are done, confirm through the audit rather than the tool's own report — on the
EVM run the submitter reported a false failure for a contract the explorer had already accepted:

```
node contracts/deploy/check-explorer-verification.mjs --write
```

The four SVM rows should move from `unverified` to `verified`. Commit the regenerated record.

### Never run `anchor keys sync`

It fabricates missing program keypairs and rewrites `declare_id!` globally while updating only the
current cluster's `Anchor.toml` table. The in-tree `declare_id!` naming the v1/v3 pair is
deliberate; a committed cluster-specific id breaks every other cluster for anyone who pulls.

`PROGRAM_ID_BYTES` in `programs/escrow/src/utils/signatures.rs` sits inside `#[cfg(test)]` and does
**not** affect the compiled artifact. Keep it in sync for the tests' sake via
`deploy/derive.py --sync-id-bytes`, but it is not part of the propagation a verified build needs.

---

## What the devnet run actually taught us (2026-09-16)

Devnet was executed end to end. Both programs now run container-built bytes and hold a valid,
locally-verified PDA. Every item below cost a failed attempt to find, and every one applies to
mainnet identically.

**Remote verification is MAINNET-ONLY.** The Solana docs state it plainly and the CLI refuses
elsewhere: *"Remote verification will only work on mainnet."* A devnet program can be upgraded to
container-built bytes, pass `verify-from-repo` with `Program hash matches`, and have its PDA
uploaded — and still never show a badge, because no attestation job can be queued for it. Devnet
is therefore a rehearsal, never a demonstration. Do not wait on `is_verified` there.

**Uploading the PDA and queueing the build are two different steps.** `verify-from-repo` rebuilds,
compares and uploads. `remote submit-job --program-id <id> --uploader <authority-pubkey>` queues
osec's own build, and only that sets `is_verified`. A clean `verify-from-repo` is not "done".

**`solana program deploy` pays from the CLI config keypair.** `--upgrade-authority` supplies the
signature, not the money. The failure names an account nobody recognises
(`~/.config/solana/id.json`) while the funded authority sits unused, and the config may even point
at localhost. Pass `--keypair` AND `--fee-payer`.

**The container build is LARGER, so ProgramData must be extended first.** Same toolchain
difference that makes the upgrade necessary: escrow went 495536 → 496320 bytes. Without an extend
the deploy fails with `account data too small for instruction` / `ProgramData account not large
enough`. `solana program extend` takes `--keypair` only — passing `--fee-payer` is a usage error
that silently does nothing — and the loader enforces a **10240-byte minimum** per extend.

**The post-deploy hash read lags, and `solana confirm` is not enough.** A single read after a
successful deploy returns the PREVIOUS hash, because it can land on a node that has not caught up.
This reported two successful upgrades as failures and skipped their registration. Poll.

**Verification refs must be signed.** Every branch in this repo is under `required_signatures`,
including one that exists only to be verified against.

**Do not read `status-all` returning `[]` as "no PDA".** It is not a reliable signal; run
`verify-from-repo` and read what it actually says.

## Rollback

The previous bytes are reproducible, which is what makes rollback safe: rebuild `59fb32065` on
macOS with the cluster's `declare_id!` and deploy that artifact to the same program id. The address
and all state are unaffected in both directions.

Keep the pre-upgrade hashes from the table above; they are the rollback target.

---

## This should become a CI job — but not yet

The procedure is deterministic and scriptable, and the obvious end state is a workflow that
rebuilds in the container, upgrades, and registers on a tag. It is **deliberately manual for now**:

- **It signs with a program upgrade authority.** Putting a key that can rewrite mainnet program
  bytes into CI is a much larger decision than verification, and should be taken on its own terms
  rather than inherited from this change.
- **Devnet is not a staging environment for SVM.** As above, a devnet upgrade hits prod-testnet
  immediately, so an automated pipeline would need an approval gate that the current environment
  layout does not express.
- **The remote verification step is asynchronous and third-party.** A job that fails because osec's
  build farm is slow is a job people learn to re-run without reading, which is how a real failure
  gets waved through.
- **It has run exactly zero times.** Automating a procedure before it has been executed once by
  hand encodes assumptions nobody has tested.

The sensible sequencing is: run it manually for devnet, then mainnet, record what actually happened
here, and only then lift it into a workflow — with the authority key question settled separately.
