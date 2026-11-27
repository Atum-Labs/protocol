# Turnkey scripts

This folder holds two groups of operator scripts:

- **Provisioning / policy CLIs** — stand up and lock down a Turnkey sub-organization
  for an Atum agent. Read **[PROVISIONING.md](./PROVISIONING.md)** before running any.
- **Signing scripts** — build, sign, and broadcast a transfer or Permit2 approval
  from an existing wallet, split by VM (`evm/`, `tvm/`).

## Prerequisites

- `pnpm install` at the repo root, so the scripts' dependencies resolve.
- A Turnkey API key pair with signing access to the wallet.

## Provisioning / policy CLIs

Operator CLIs that wrap the shared admin library (`../src/admin`) to create and lock down a
Turnkey sub-organization. They create real resources against the live Turnkey API.

| Script | pnpm alias | Purpose |
| --- | --- | --- |
| `create-sub-organization.ts` | `turnkey:create-sub-org` | New sub-org + inline EVM/Tron/Solana wallet + root user. Prints sub-org ID, wallet ID, addresses, root keys. |
| `create-api-key.ts` | `turnkey:create-api-key` | Non-human machine API-key user for the agent to sign with. Creates a **new user** each run, so use `rotate-api-key.ts` to replace a key. |
| `rotate-api-key.ts` | `turnkey:rotate-api-key` | Rotate the API key on an existing user, root or agent. Two phases: `--add` registers the new key, `--revoke` deletes the old one. See [Rotating an API key](#rotating-an-api-key). |
| `approve-activity.ts` | `turnkey:approve-activity` | Approve (or `--list`) activities waiting on root-quorum consensus. Needed whenever the threshold is above 1. See [Root quorum](#root-quorum-and-consensus). |
| `apply-policies.ts` | `turnkey:apply-policies` | Push the server-side policy set from a YAML config; `type: settler` or `type: sender`. |
| `test-policies.ts` | `turnkey:test-policies` | Send real sign requests with the agent key and check each is denied/allowed as expected (`--dry-run` previews the matrix). Run last. |
| `delete-sub-organization.ts` | `turnkey:delete-sub-org` | Delete a sub-org, signed with that sub-org's own root key. Destructive; requires `--confirm <id>`, and `--force` to skip the export check. `--api-public-key-env` / `--api-private-key-env` read the root key from other var names. |
| `delete-policies.ts` | `turnkey:delete-policies` | Delete policies from a sub-org (all, or `--grep <substr>`), signed with the sub-org root key. Destructive; requires `--confirm <id>`; `--dry-run` previews. Use before re-applying a corrected config. |

Config examples live in `scripts/config/` (pass them as `--config ./scripts/config/<file>` from the
package root). Credentials go in a gitignored `scripts/.env` (see `.env.example`), which every
script in this directory loads on startup.
Generated `*.suborg.json` / `*.apikey.json` hold private keys and are gitignored.

### Rotating an API key

`rotate-api-key.ts` replaces the key material on a user that already exists, for both the sub-org
**root** user and the non-root **agent** user. One script covers both: the underlying activities are
the same (`CREATE_API_KEYS_V2`, then `DELETE_API_KEYS` against a stable `userId`), and `--target
root|agent` selects what changes — which identity gets rotated, and how much the script refuses to
do without proof that the replacement works.

Rotating key material does **not** touch the root quorum, which is defined by `userIds` rather than
by keys. Nothing needs `UPDATE_ROOT_QUORUM`, and the root user's identity is unchanged.

Both phases stamp with the sub-org root key (`TURNKEY_SUBORG_ROOT_API_*`). Root is what can edit the
agent user, and for the root user itself the key being rotated is its own.

**Phase 1 — `--add`.** Mints a P-256 keypair, registers the public half, and leaves the old key
working. Nothing is interrupted.

```bash
# agent
pnpm turnkey:rotate-api-key -- --sub-org <uuid> --target agent --user-name settler-agent --add
# root (defaults to the user the credentials belong to)
pnpm turnkey:rotate-api-key -- --sub-org <uuid> --target root --add
```

Then deploy the new private key, restart the consumer, and verify. For an agent key that means
`turnkey:test-policies` with the new credential in the env, which also re-confirms the key is
non-root.

**Phase 2 — `--revoke`.** Deletes the keys named by `--key-id`. Requires `--confirm <sub-org-id>`, and
`--dry-run` previews.

`--key-id` is **mandatory** and nothing is inferred. There is deliberately no "delete the old one"
shorthand: any rule of the form *everything except the key I am stamping with* resolves the victim
from the environment rather than from the command, so the identical line deletes the old key or the
replacement depending on which credential `.env` currently holds. Naming ids means a wrong command
fails instead of deleting the wrong key.

You never have to look the id up. `--add` prints the ready-made revoke command with the ids of the
keys it supersedes already filled in, and every run prints the user's current key list with ids.

```bash
# agent: --verify-public-key is optional and asserts the new key survives
pnpm turnkey:rotate-api-key -- --sub-org <uuid> --target agent --user-name settler-agent \
  --revoke --confirm <uuid> --key-id <old-id> --verify-public-key <new-pub-hex> --dry-run

# root: put the NEW key in TURNKEY_SUBORG_ROOT_API_* first, then revoke the old one
pnpm turnkey:rotate-api-key -- --sub-org <uuid> --target root --revoke --confirm <uuid> \
  --key-id <old-id>
```

For the root case the credential you run with **must already be the new key**, because deleting the
key stamping the request is refused outright. That refusal is the point: it means a root rotation
cannot complete until the replacement has proven it can authorize a root action, so a bad new key
fails the rotation instead of locking you out.

So the root flow is: `--add`, replace the value of `TURNKEY_SUBORG_ROOT_API_PUBLIC_KEY` and
`_PRIVATE_KEY` with the new key, then revoke. No extra variables are involved.

`--api-public-key-env` / `--api-private-key-env` are **optional** and only change which variable names
are read. Two cases where they help:

- you want the old key still readable in `.env` during the overlap, so a mistyped new key does not
  leave you digging for the working one. Add your own pair (any names) and point the flags at them.
- one `.env` holds several sub-orgs' credentials and the names cannot collide.

`delete-sub-organization` takes the same two flags for the same reason.

There is deliberately no single-shot mode. A sub-org root credential has no break-glass above it: a
parent organization has read-only visibility into its sub-orgs and cannot add users, add keys, or
change the root quorum inside one, so revoking before the replacement is proven can leave the sub-org
unreachable.

What the script refuses to do:

| Refusal | Why |
| --- | --- |
| Revoke without `--key-id` | The victim must be named, never inferred from which credential is loaded. |
| Revoke the key stamping the request | That key is the proof the rotation worked. On the root path it makes a lockout unreachable even with `--force`. |
| Revoke a key created *after* the one stamping the request (unless `--force`) | Stamping with the old key deletes the replacement and keeps the key being replaced, and every survivor check still passes, so the run would report success while the old key stays live. |
| Revoke when no surviving key would work | An expired key still shows up in the API response, so counting rows is not enough. |
| Revoke when every surviving key has a TTL (unless `--force`) | It schedules a lockout for whenever the TTL lapses instead of causing one now. |
| `--add --expiration-seconds` on `--target root` | Same reason, caught at the point the time bomb would be created. |
| Revoke when the stamping key is absent from the target user on a self-rotation | Means the public-key comparison the other guards rely on came up empty, so those guards are silently inert. |
| `--target agent` resolving to the root user the credentials belong to | Rotating the root key while believing you are touching the agent's. |

Other flags: `--key-id a,b` revokes several at once, `--key-name <name>` (defaults to
`<userName>-<yyyymmdd>`), `--expiration-seconds <n>` for a TTL'd key (agent only), `--user-id <uuid>`
instead of `--user-name`, `--out <path>` for the written `*.apikey.json`. Turnkey caps a user at 10 API keys, so `--add` refuses before minting once
the user is full.

`--add` writes the keypair to the out file **before** submitting, because a completed activity whose
response is lost to a timeout looks identical to a failure. If `--add` errors, check whether the key
landed (the printed message says how) before re-running, otherwise the retry spends another key slot.

### Root quorum and consensus

Whether a rotation needs approvals depends on **whose** credentials change, not on the threshold
alone. Verified live against a 2-of-2 sub-org:

| operation | 2-of-2 result |
| --- | --- |
| a user adds a key to **its own** user | `COMPLETED` on one vote |
| a user deletes a key from **its own** user | `COMPLETED` on one vote |
| a user adds a key to **another** user | `CONSENSUS_NEEDED` |

So **`--target root` self-rotation needs no approvals at any threshold**, while **`--target agent`
does** whenever the threshold is above 1, in both phases. `rotate-api-key` reads the quorum and prints
which case applies before submitting anything, and also lists activities already pending, since a
pending change has not applied yet and so is invisible in the key list.

When a run does come back pending it exits 2 (not a failure) and prints the activity id and the intent
fingerprint. Approve with a **different** root user's key:

```bash
pnpm turnkey:approve-activity -- --sub-org <uuid> --list
pnpm turnkey:approve-activity -- --sub-org <uuid> --activity <id> \
  --api-public-key-env OTHER_ROOT_PUB --api-private-key-env OTHER_ROOT_PRIV
```

Notes worth knowing:

- Approval takes the intent **fingerprint** (`sha256:…`), not the activity id. It is a digest of the
  exact submitted request, so an approver cannot ratify something other than what was submitted.
  `--activity <id>` resolves it and prints the intent first.
- A user cannot approve its own submission, and the script checks this against the activity's **votes**
  rather than its `canApprove` flag. That flag is unreliable: for one submitter on one activity it
  reads `false` on the submit response but `true` from both `get_activity` and `list_activities`.
- Counts shown are **distinct approvers**, not raw votes, because the threshold counts unique users.
- A console-only approval is not always possible: root users that are API keys with no passkey cannot
  log into the Turnkey dashboard, so for a machine-managed sub-org this script is the only route.
- While a revoke is pending, do not revoke anything else on that user. The guards were evaluated
  against the key set at submit time, and approval applies the deletion whenever it arrives.

## Signing scripts

The Turnkey signer only signs, so each script builds the transaction, signs it
with Turnkey, and broadcasts it (the EVM scripts also wait for one confirmation).

### Turnkey / wallet env (all signing scripts)

These come from the gitignored `scripts/.env` (see `.env.example`), loaded on startup like the
provisioning CLIs. A variable already exported in the shell takes precedence over the file, so a
one-off `RPC_URL=… npx tsx …` still overrides it. `RPC_URL` is usually given that way, since it is
what picks the chain.

| Variable | Required | Notes |
| --- | --- | --- |
| `RPC_URL` | yes | Endpoint to broadcast on, and the thing that selects the chain: an ethers JSON-RPC url under `evm/`, a Solana JSON-RPC url under `svm/`, a Tron full-node HTTP base under `tvm/` |
| `TURNKEY_ORGANIZATION_ID` | yes | Turnkey (sub-)organization id |
| `TURNKEY_API_PUBLIC_KEY` | yes | Turnkey API key (public) |
| `TURNKEY_API_PRIVATE_KEY` | yes | Turnkey API key (private) |
| `TURNKEY_WALLET_ID` | one of | Wallet id holding the account |
| `TURNKEY_WALLET_ADDRESS` | one of | Address to send from (`0x…` on EVM, base58 `T…` on Tron); the wallet id is discovered from it and it is pinned as the expected address |
| `TURNKEY_API_URL` | no | Defaults to `https://api.turnkey.com` |
| `TURNKEY_PINNED_ADDRESS` | no | Assert the wallet resolves to this exact address (ignored when `TURNKEY_WALLET_ADDRESS` is set) |

Provide **either** `TURNKEY_WALLET_ID` or `TURNKEY_WALLET_ADDRESS`. If only the
address is given, the script scans the org's wallets to find the one holding it.

### EVM (`evm/`)

Set `RPC_URL` to the JSON-RPC endpoint to broadcast on.

#### `evm/transfer.ts` — send a transfer

Sends a **native** or **token** transfer FROM the wallet TO any address.

```bash
# native coin, amount in whole units
npx tsx scripts/evm/transfer.ts <recipient> 0.01

# token, amount in whole units (decimals fetched on-chain)
npx tsx scripts/evm/transfer.ts <recipient> 25 <tokenAddress>
```

- **No recipient allowlist** — it sends to whatever address you pass. What the
  wallet is allowed to sign is still enforced by Turnkey-side policies.

#### `evm/approve-permit2.ts` — approve Permit2 to move a token

Grants the **Permit2** contract a spending allowance on a token. This is the
on-chain approval the payment flow needs from a sender wallet: token movement is
relayed through Permit2, so it must hold an allowance on the token first. Use
`max` for an unlimited allowance (what the payment flow uses), or an exact amount.

```bash
npx tsx scripts/evm/approve-permit2.ts <tokenAddress> max
npx tsx scripts/evm/approve-permit2.ts <tokenAddress> 100
```

Spender defaults to the canonical Permit2 address; override with `PERMIT2_ADDRESS`.

#### `evm/set-tempo-fee-token.ts` — change the Tempo fee token

Tempo pays network fees in a stablecoin swapped via an on-chain FeeAMM. If the chosen fee
token's pool lacks liquidity, the wallet's transactions are rejected (a liquidity condition,
not a balance one). This sets the wallet's fee token (an account-level preference on Tempo's
`FeeManager`) by calling `setUserToken(token)`, so you can point it at a more liquid token
such as pathUSD. Point `RPC_URL` at a Tempo endpoint.

```bash
npx tsx scripts/evm/set-tempo-fee-token.ts <feeTokenAddress>
# e.g. switch fees to pathUSD
npx tsx scripts/evm/set-tempo-fee-token.ts 0x20C0000000000000000000000000000000000000
```

The FeeManager defaults to `0xfeEC000000000000000000000000000000000000`; override with `FEE_MANAGER_ADDRESS`.

### Tron (`tvm/`)

Set `RPC_URL` to a full-node HTTP base (for example
`https://api.shasta.trongrid.io` for Shasta, `https://api.trongrid.io` for mainnet).

#### `tvm/approve-permit2.ts` — approve Permit2 to move a token

The Tron sibling of the EVM approval, for the same reason (the sender's token
moves via Permit2). It builds the `approve()` call through the full-node HTTP
API, signs it with the Turnkey Tron signer, and broadcasts it.

```bash
npx tsx scripts/tvm/approve-permit2.ts <tokenBase58> max
npx tsx scripts/tvm/approve-permit2.ts <tokenBase58> 100
```

| Variable | Required | Notes |
| --- | --- | --- |
| `RPC_URL` | yes | Tron full-node HTTP base |
| `TRON_NETWORK` | no | `mainnet` (default) or `shasta` — selects the default Permit2 |
| `PERMIT2_ADDRESS` | no | Permit2 contract to approve, base58 (overrides the `TRON_NETWORK` default) |
| `FEE_LIMIT_SUN` | no | `fee_limit` in SUN (default `100000000` = 100 TRX) |

## Notes

- Never commit the API private key. Keep it in the untracked `scripts/.env`, or export it in the
  shell, not in the repo.
