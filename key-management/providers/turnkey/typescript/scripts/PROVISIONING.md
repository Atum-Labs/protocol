# Turnkey sub-organization provisioning

This guide walks through standing up a new Turnkey **sub-organization** for an Atum agent and
locking it down with server-side policies. Everything here runs from the scripts in this
directory, which are thin wrappers over the shared admin library in `../src/admin`. Because the
scripts and the agent runtime share that one library, the policies you push server-side mirror
exactly what the agent enforces client-side (defense in depth).

There are four steps, in order:

1. **Create the sub-organization** — a fresh org with its own wallet (EVM + Tron + Solana) and a
   root user. → `create-sub-organization.ts`
2. **Create the machine API key** — a non-human API-key user the agent process signs with. →
   `create-api-key.ts`
3. **Apply policies** — the server-side rule set, which differs for a **settler**, a **sender** and
   a **verifier** sub-organization. → `apply-policies.ts`
4. **Test the policies** — send real sign requests with the agent key and confirm each is denied or
   allowed as expected. → `test-policies.ts`

> You run these from an operator machine. Each step authenticates with its own key set (parent for
> Step 1, sub-org root for Steps 2 and 3, the non-root agent key for Step 4, see Prerequisites).
> They talk to the live Turnkey API and create real, billable resources. Do a `--dry-run` of the
> policy step first, and treat every printed private key as a production secret.

---

## Concepts (read once)

- **Parent organization** — your top-level Turnkey org. Its root key is used only to create the
  sub-org in Step 1. After that, the sub-org's own root key manages users and policies inside it,
  and the non-root user key is what signs at runtime. Keeping the three key sets separate limits
  what each one can do.
- **Sub-organization** — an isolated org per deployment (e.g. settler-testnet, sender-mainnet)
  with its own root quorum, wallet, and policy namespace. Compromising one never touches another.
- **Root user vs machine API key** — the *root user* (created in step 1) is the break-glass owner
  of the sub-org. The *machine API key* (step 2) is a separate user with an API key only and no
  human authenticator; it is what the unattended agent uses to sign. Keep them distinct so you can
  rotate the agent key without touching the root credential.
- **Settler vs sender** — two different threat models, so two different policy sets:
  - A **settler** wallet moves inventory: it calls allowlisted contracts, transfers tokens to
    allowlisted recipients, and needs a cancel/replace-by-fee nonce-burn carve-out. Its policies
    come from a per-chain allowlist plus recipient/cap extras.
  - A **sender** wallet only authorizes Permit2 pulls: it signs `approve(Permit2, …)` and Permit2
    typed data on EVM/Tron, and one raw ed25519 digest for the Solana deposit's inner signature —
    nothing else. Its typed-data allow is scoped to `PAYLOAD_ENCODING_EIP712` and binds the
    domain, the verifying contract, `spender`, the token, both witness roles and the payment
    destination; the broad `NOT_APPLICABLE` allow it keeps is scoped to the encodings only its
    ed25519 account can use.

---

## Prerequisites

- Node 20+ and pnpm (this package is part of the `@atum-labs/protocol` pnpm workspace).
- Install workspace dependencies from the repo root: `pnpm install`.
- Credentials. Copy `.env.example` to `.env` in this directory. There are **three separate key
  sets**, each used only for the steps noted below; never reuse one slot for another:

  ```
  # create-sub-org (parent org root)
  TURNKEY_PARENT_ORG_ID=...
  TURNKEY_PARENT_API_PUBLIC_KEY=...
  TURNKEY_PARENT_API_PRIVATE_KEY=...
  # create-api-key + apply-policies (sub-org root key, produced by create-sub-org)
  TURNKEY_SUBORG_ROOT_API_PUBLIC_KEY=...
  TURNKEY_SUBORG_ROOT_API_PRIVATE_KEY=...
  # test-policies (sub-org non-root agent key, produced by create-api-key)
  TURNKEY_SUBORG_USER_API_PUBLIC_KEY=...
  TURNKEY_SUBORG_USER_API_PRIVATE_KEY=...
  ```

  You fill these in as you go: the parent keys up front, the sub-org root key after Step 1, and the
  agent key after Step 2. `.env`, `*.suborg.json`, and `*.apikey.json` are gitignored. The private
  keys the scripts generate are written to disk with `0600` permissions and printed once — never
  commit them.

All commands below are run from this directory (`key-management/providers/turnkey/typescript`).

---

## Step 1 — Create the sub-organization

Creates the sub-org, an inline wallet with EVM/Tron/Solana accounts, and one root user whose API
keypair is generated locally. The name is passed to Turnkey **verbatim** — there are no naming
restrictions, so use whatever your deployment convention is.

```
pnpm turnkey:create-sub-org -- \
  --name "settler-testnet" \
  --root-user-name ops \
  --root-user-email ops@example.com \
  --out ./settler-testnet.suborg.json
```

Prints and saves:

- `subOrganizationId` — pin this in the agent's signer config.
- `walletId` — the wallet holding all three chain accounts.
- `addresses` — the derived EVM, Tron, and Solana addresses (fund these).
- the **root user's** API public + private key (the break-glass credential for this sub-org).

The wallet is created *inline* with the sub-org on purpose: the parent key has no membership
inside the brand-new sub-org, so a separate wallet-creation call would fail authorization. This is
a run-once operation — running it twice creates two sub-orgs.

Now put this sub-org's root key into `TURNKEY_SUBORG_ROOT_API_PUBLIC_KEY` / `TURNKEY_SUBORG_ROOT_API_PRIVATE_KEY`
in your `.env` — Steps 2 and 3 authenticate with it.

## Step 2 — Create the machine API key

Adds a non-human user (API key only, no passkey) to the sub-org and prints its generated P-256
keypair. This is the credential the agent authenticates with at runtime. It runs with the sub-org
root key (`TURNKEY_SUBORG_ROOT_API_*`) from Step 1.

```
pnpm turnkey:create-api-key -- \
  --sub-org <subOrganizationId-from-step-1> \
  --user-name settler-agent \
  --out ./settler-agent.apikey.json
```

- Put the printed user id and name in the settler config's `agentUser`. Apply refuses any other
  non-root user that `cowswapHook.users` does not list, whatever its name, since every non-root user
  holds every settler ALLOW unless a deny fences it. `--user-name` has no default. User ids differ
  per sub-org, so keep one settler config per sub-org.
- The key has no expiry. To replace it later use `rotate-api-key.ts` (see
  [Rotating keys](#rotating-keys)), which swaps the key on this same user. Running `create-api-key`
  again creates a **second user** instead, which is not a rotation.
- The private key is shown **once**. Put it in your secret manager immediately; the agent reads it
  from there, not from the JSON file.
- Then put this agent key into `TURNKEY_SUBORG_USER_API_PUBLIC_KEY` / `TURNKEY_SUBORG_USER_API_PRIVATE_KEY` for
  Step 4.

## Step 3 — Apply policies

Assembles the policy set from a self-contained YAML config and pushes it to the sub-org. The
config's `type` field (`settler` or `sender`) selects the whole assembly. All configs live in
`scripts/config/`, and paths are given relative to this package root (where the pnpm alias runs).
Starting points:

- `scripts/config/settler-testnet.example.yaml`, `scripts/config/sender-testnet.example.yaml` (templates)
- `scripts/config/settler-mainnet.yaml`, `scripts/config/sender-mainnet.yaml` (real mainnet values)

Copy a template (or edit a ready mainnet config in place), fill in your real values, then **dry-run
first**:

```
cp scripts/config/settler-testnet.example.yaml scripts/config/settler-testnet.yaml
# edit scripts/config/settler-testnet.yaml with your real values, then:
pnpm turnkey:apply-policies -- \
  --config ./scripts/config/settler-testnet.yaml \
  --sub-org <subOrganizationId> \
  --dry-run
```

Real `config/*.yaml` files are gitignored; only the `*.example.yaml` files are tracked. So your
filled-in `settler-mainnet.yaml` / `sender-mainnet.yaml` stay out of the repo by default. They
hold allowlists and addresses (not private keys), so keep them in your config store or pass them
in at apply time.

Review the printed list, then apply for real by dropping `--dry-run`:

```
pnpm turnkey:apply-policies -- \
  --config ./scripts/config/settler-testnet.yaml \
  --sub-org <subOrganizationId>
```

Behavior:

- **Idempotent by policy name.** A policy whose name already exists with the *same* effect,
  condition, and consensus is skipped.
- **Drift is loud.** If a policy of the same name exists with a *different* condition, the run
  fails and prints the diff before anything changes. Re-run with `--update` to replace the
  drifted policies through a temporary copy, so no policy is ever absent.
- **Credentials.** Applies with the sub-org root key (`TURNKEY_SUBORG_ROOT_API_*`). To read different
  env var names, add `--api-public-key-env NAME --api-private-key-env NAME`.

### What each type emits

**settler** (`buildSettlerPolicies` in `apply-policies.ts`) assembles:

- the raw-payload set (`buildSettlerRawPayloadPolicies`, see "Settler raw-payload rules" below):
  `allowSettlerIdentityTypedData`, per EVM chain `allowTransferWithAuthorizationTypedData` from
  the required `transferWithAuthorizationTokens` block, `allowEd25519RawPayload` when a Solana
  chain is listed, and the `denyNonTypedDataHashFunctions` (NO_OP, SHA256, KECCAK256),
  `denyAccountDelegationEncoding` (EIP-7702) and `denyBatchRawPayloads` denies;
- per chain, `derivePoliciesFromAllowlist`: the `allowedTo` allow (with `allowedSelectorsByTo`
  set, each address bound to its own selectors; see below) or an `allowedSelectors` allow,
  `maxNativeValue` / `maxGasLimit` / `maxFeePerGasWei` (EVM) and `maxFeeLimitSun` (Tron) denies,
  `denyNoOpHash`, Solana `allowedPrograms` + anchor-discriminator denies, and — for every EVM
  chain — the `allowSelfSendNonceBurn` carve-out for cancel / replace-by-fee;
- optional `denyApproveToNonAllowedSpender` (EVM + Tron) from the `approveDeny` block, which denies
  `approve`, `increaseAllowance`, `increaseApproval` and `approveAndCall` to a spender outside
  `allowedSpendersHex`;
- optional recipient allowlists and gas/fee caps from the `extras` block (`buildExtrasPolicies`).

`allowedSelectorsByTo` (EVM and Tron) maps each `allowedTo` address to the 4-byte selectors it may be
called with, or `'any'`. Without it an allowlisted token accepts every selector. Once a chain has the
map, every `allowedTo` entry needs a key, and the chain may not also set `allowedSelectors` (that
allow would admit its selectors on any address). Quote addresses and selectors: unquoted `0x` values
are read as numbers and refused. A selector the settler signs that is missing from the map is a 403
on that call, so dry-run first and run `turnkey:test-policies` after the apply. Adding or changing
the map drifts `allowedTo (<chain>)`; `--update` replaces it through a temporary copy, so the chain
always has an allow. apply-policies refuses a map that lets an address be called with an allowance
grant (approve, increaseAllowance, increaseApproval, approveAndCall, or `'any'`) unless that address
is a token in the chain's `approveDeny` entry, since the grant could otherwise name any spender.

> Note: the self-send nonce-burn allow, which lets the agent cancel a stuck nonce, is always
> emitted for EVM chains. apply-policies resolves the settler's own EVM EOA from the sub-org's
> Turnkey wallet. Pass `--wallet-id` if the sub-org holds more than one wallet.

### Stellar

Source and date: Turnkey's wallet docs list Stellar as `ADDRESS_FORMAT_XLM` on `CURVE_ED25519`, and
its raw payload docs say to use `HASH_FUNCTION_NOT_APPLICABLE` for ed25519 (checked 2026-11-10; the
findings with URLs are in CORE-3095). They list transaction parsing and policies (tier 4) for no
Stellar entry, and the `sign_transaction` type enum has no Stellar value. What that means here:

- A Stellar sub-org signs **raw payloads only**: transaction hashes (SHA-256 of the signature
  payload) and messages. `TurnkeyStellarSigner` sends exactly that.
- The policy language has no Stellar fields. The one emitted rule is `allowStellarEd25519RawPayload`
  (encoding, `NOT_APPLICABLE`, `wallet_account.address in [...]`), from the `stellarSigners` block of
  the settler, sender or verifier config. It binds **nothing about the transaction**: a credential
  that can sign through it can sign any Stellar transaction for those accounts. The destination,
  asset, amount and contract call are enforced only by the settler's client-side signing policy.
- `allowlists` entries for a Stellar chain are refused (`allowedTo`, `allowedSelectors`, ...) because
  nothing would enforce them. List the chain under `chains` and give it no `allowlists` entry.
- An unscoped `allowEd25519RawPayload` in the same sub-org (emitted for Solana) also covers the
  Stellar account. A sub-org that must fence Stellar to its listed accounts should not carry a Solana
  chain.
- To add the account to a sub-org's wallet, append `STELLAR_WALLET_ACCOUNT` (from `src/admin`) to the
  wallet's accounts. The default three-account wallet is unchanged.
- **Not live-verified.** Open: that `wallet_account.address` matches a Stellar account in
  `SIGN_RAW_PAYLOAD_V2`, that `TEXT_UTF8` plus `NOT_APPLICABLE` is accepted on the XLM account, and
  that Turnkey returns the address as a `G...` strkey. `turnkey:test-policies` rows
  (`--stellar-address <G...>`, or `stellarSigners` in the config) probe all three; the positive
  control runs first and the deny rows mean nothing until it passes.

### Settler raw-payload rules

Every settler secp256k1 signature that is not a transaction is EIP-712 typed data, sent as
`PAYLOAD_ENCODING_EIP712` + `HASH_FUNCTION_NOT_APPLICABLE`. KECCAK256 raw signing is denied: it
signs a caller-chosen preimage, and both an unsigned transaction and `0x1901 ‖ domainSeparator ‖
hashStruct` are one, so it would yield a valid transaction or EIP-712 signature while every
`eth.tx.*` and `eth.eip_712.*` condition sits unevaluated.

- **`allowSettlerIdentityTypedData`** binds `eth.eip_712.domain.verifying_contract` to the
  identity sentinel `0x1238944d14f50709cc27101b2746fdefce08b37e` (the last 20 bytes of
  `keccak256("atum.settler.identity.v1")`, no code). The domain is `{name: "Atum Settler
  Identity", version: "1", verifyingContract}` with no chainId, so EVM and Tron sign the same
  digest. It carries `SettlerProof {bytes32 proofHash; bytes32 docHash}` (W3C quote, VP and
  fulfillment authorization proofs) and `WalletProof {bytes32 digest}` (gateway handshake).
- **`allowTransferWithAuthorizationTypedData`** (per EVM chain with
  `transferWithAuthorizationTokens`) binds the domain verifying contract to the configured tokens,
  the domain chain id, `eth.eip_712.primary_type == 'TransferWithAuthorization'` and
  `eth.eip_712.message['from']` to the settler's EVM EOA. Recipient and amount are not bound by the
  policy. A chain left out of the block cannot sign EIP-3009 at all. The key is required in every
  settler config: apply-policies fails before any Turnkey call when it is absent or malformed, and `{}` states
  that the settler does no EIP-3009. Only EVM chains are accepted; a Tron or Solana key fails.
- **`allowEd25519RawPayload`** keeps NOT_APPLICABLE with HEXADECIMAL or TEXT_UTF8 for Solana
  ed25519 raw signing. Turnkey refuses that pairing on secp256k1 at the API, which the policy test
  asserts.
- The settler never uses `ACTIVITY_TYPE_SIGN_RAW_PAYLOADS`, so the batch form is denied.

**Probes required before apply.** These selectors and shapes are not live-verified. Run each
against a non-production sub-org with the agent (non-root) key and confirm the outcome first:

1. `eth.eip_712.primary_type` enforces on a TransferWithAuthorization allow: a
   `ReceiveWithAuthorization` from the settler on an allowlisted token (same fields, only the
   primary type differs) is denied, the TransferWithAuthorization is allowed.
2. `eth.eip_712.message['from']` compares against the lowercase settler address: a foreign
   `from` is denied, the settler's own is allowed.
3. A sentinel domain without chainId parses: identity-domain SettlerProof and WalletProof are
   allowed, and the EIP-712 probe on an arbitrary domain is denied.
4. The settler never sends `SIGN_RAW_PAYLOADS`: confirm in the settler's Turnkey activity history
   before the batch deny lands.

`test-policies` covers probes 1 to 3 once `transferWithAuthorizationTokens` is set in the config.

**Rollout order.** (1) protocol: verifiers dual-accept (legacy digest first, SettlerProof typed
digest when the legacy signer does not match), signers, these builders. (2) atum-core pin bump
and solver-gateway dual-accept, deployed. (3) settler-agent pin bump with typed signing,
deployed everywhere. (4) set `transferWithAuthorizationTokens` in each settler YAML (the EIP-3009
token contracts per EVM chain, or `{}`). (5) check probe 4, then apply the settler set to a
non-production sub-org and run `test-policies` for probes 1 to 3. (6) apply on testnet, then
mainnet, with `--update --prune`: the retired `allowSignRawPayload` (KECCAK256 + NOT_APPLICABLE)
must be deleted, not left live.

**Rollback floor.** After rollout step 6, a settler image from before rollout step 3 cannot sign
quotes, VPs, fulfillment authorizations or the gateway handshake, since each of those is a
KECCAK256 raw signature the policy now denies. Rolling a settler back past rollout step 3 first
needs `apply-policies --update --prune` run from a protocol checkout older than these builders,
which restores `allowSignRawPayload` and prunes the new denies. Verifiers must keep dual-accept
for as long as any legacy-signed proof can still arrive.

### The CoW Swap hook user (optional, settler sub-orgs)

The CoW Swap hook (`cowswap-hook` in settler-agent) signs CoW Protocol orders from the settler's
own wallet, so its API user lives in the settler sub-org. So does any other order signer, such as a
swap CLI, that must never hold the agent's key. No settler policy is scoped to a user, so a new user
there inherits every settler ALLOW, including transactions to the fulfillment proxy, whose recipient
no policy binds. The `cowswapHook` block fences every such user in:

```yaml
cowswapHook:
  users:                                   # every fenced user
    - { userId: '<id from create-api-key>', userName: cowswap-hook }
  chains:                                  # keys into `chains`, EVM only
    Ethereum:
      pairs:                               # sell token -> buy token, at most 16 per chain
        - { sell: '0xdac17f958d2ee523a2206206994597c13d831ec7', buy: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' } # USDT -> USDC
```

The pairs are shared by every fenced user (and the agent): the order ALLOW carries no consensus, so
it cannot differ per user, and every listed user can sign an order on every listed pair of every
listed chain. **Keep one fenced purpose per sub-org** (the hook, or a swap CLI, not both) and list
only the directions that purpose trades. A second purpose in the same sub-org widens what each key
can sign, and trimming pairs for one silently drops pairs the other needs. For the hook the pairs
are its working capital token to each payout token it fills on that chain. The hook declines any
pair missing from its own `COW_ORDER_PAIRS_EIP155_<chainId>` before bidding, so keep that list
equal to these pairs: **apply a new pair here before adding it to the hook**, or Turnkey denies the
order after the payer has deposited and the payment refunds.

With the block, the settler set also emits:

- **Three DENYs scoped to each fenced user** by `consensus: approvers.any(user, user.id == '<id>')`,
  emitted first so a fresh apply creates them before any ALLOW:
  - `denyCowswapHookActivity (<id>)`: any activity other than a single raw-payload signature;
  - `denyCowswapHookPayloadEncoding (<id>)`: a raw payload that is not unhashed EIP-712;
  - `denyCowswapHookTypedDataDomain (<id>)`: typed data for any contract but GPv2Settlement.

  Each one tests only fields that exist for every request it can match, so none depends on how
  Turnkey evaluates a field a request lacks.
- **`allowCowswapHookGpv2Order (<chainId>)`**, one per listed chain, with no consensus. It allows a
  fill-or-kill, zero-fee CoW buy or sell order paying the settler wallet on one of the chain's
  pairs: the GPv2 domain and chain, primary type `Order`, `receiver`, `kind` (`buy` or `sell`),
  `partiallyFillable`, both token balances, `feeAmount == '0'` and the (sell, buy) pair bound. The pairs are one parenthesised
  group, so no pair can skip the other bindings. Every message-field selector sits here, so one
  that does not evaluate as written denies the order. Token addresses are compared lower-cased,
  the form ethers `TypedDataEncoder.getPayload` sends; a signer must build its payload that way
  (km-core's Turnkey signer does). The settler key can sign the same order; that is all the block
  adds for it.

Without the block the set is unchanged.

**What keeps the order's fields bound.** The hook's denies pin the activity, the encoding and the
GPv2Settlement domain; the order's fields (receiver, kind, chain, fill-or-kill, balances, zero fee,
token pair) are bound only by `allowCowswapHookGpv2Order` plus Turnkey's default deny. That holds
only while **no other settler ALLOW admits GPv2Settlement typed data**: one that did would be
inherited by the hook user and admit any order it allows. A test in `settler-policies.test.ts`
fails if the settler set grows such an ALLOW; give any future one a consensus clause that excludes
the hook user.

What the hook set does NOT bind: the amounts, validTo and appData of the order. A stolen fenced key
can sign a buy or sell order on a listed pair paying the wallet at a bad price, and an order once
signed is only revocable on chain (`GPv2Settlement.invalidateOrder`) or by revoking the GPv2VaultRelayer
allowance. Grant that allowance with the sub-org root key, not through a settler policy: an
`approveDeny` spender entry would let the agent key approve the relayer on every listed token.

**Order of operations.** From step 1 until step 2 has applied, the new key holds every settler
right (no fence exists yet). Apply has to come second, because it checks that the user exists.

1. `pnpm turnkey:create-api-key -- --sub-org <id> --user-name <name>` (sub-org root key), for
   example `cowswap-hook`.
   Put the printed private key straight into the secret store and delete the generated
   `*.apikey.json`. Note the user id. Never use a root user: apply refuses one, because root
   bypasses policies.
2. Add the user to `cowswapHook.users` with that exact name and apply the settler set. Apply checks
   `agentUser` and every listed user before building anything: each exists, is not root, has the
   configured name, and is the only user with that name. It also refuses any other non-root user,
   whatever its name and with or without the block, since that user would hold every settler right.
3. Run the matrix with **that user's** key (below), once per listed user, and keep the output. Hand
   a key to its signer only when its run passes.

**If step 2 fails or any matrix row fails, delete the hook user (or its API key) before you
investigate.** A failing row can mean the fence is down while a working key exists.

**The hook matrix.** `--as` takes the user's name from `cowswapHook.users`. After any change to
the hook policy, run it on a non-production sub-org before re-applying policies to any other.

```
pnpm turnkey:test-policies -- --config <settler config with cowswapHook> --as cowswap-hook \
  --sub-org <id> --evm-address <settler wallet> [--solana-address <settler Solana account>] \
  --api-public-key-env TURNKEY_HOOK_API_PUBLIC_KEY --api-private-key-env TURNKEY_HOOK_API_PRIVATE_KEY
```

It refuses to run unless the credentials authenticate as the listed user of that name, so one fenced
user's key cannot stand in for another's. When the config
lists a Solana chain it also refuses to run without `--solana-address` (or a `--suborg-file` naming
it): the ed25519 rows are the only proof of the encoding deny. The rows:

- **ALLOW** for the buy order and for the sell order on every listed pair of every hook chain, so
  a mistyped pair fails here rather than as a refunded payment. The orders expired long ago, so
  the signatures cannot be used.
- **DENY, proving the fence.** These are requests a settler ALLOW the hook user inherits would
  admit, so only the hook's denies can refuse them:
  - the settler identity typed data (`denyCowswapHookTypedDataDomain`);
  - the self-send nonce burn on the first hook chain (`denyCowswapHookActivity`; the chain needs
    an `allowlists` entry, which every settler chain has);
  - with a Solana address, ed25519 hex and UTF-8 payloads (`denyCowswapHookPayloadEncoding`).
- **DENY, proving the order's bindings.** Each one-field change of the buy order: receiver, a kind
  other than buy or sell, partiallyFillable, either balance, an unlisted chain, another contract,
  another domain name or version, another primary type, an unlisted sell or buy token, a nonzero
  `feeAmount`. Plus a sell order with another receiver, so the sell kind stays inside the other
  bindings.
- **DENY, proving the pairs.** Each only when the config does not list it, otherwise skipped with
  the reason printed: the first pair reversed; the first pair's sell token with another pair's buy
  token; the last pair with another receiver (a pair outside the parenthesised group would pass it);
  the first chain's first pair on a hook chain that does not list it.
- **Defence in depth.** These are refused for every non-root user anyway:
  - KECCAK256 and NO_OP raw payloads, DENY;
  - an EVM hex payload, REFUSED;
  - creating API keys and creating an (inert) policy, DENY;
  - approving an activity, REFUSED.

Probes this run settles, which nothing else has verified against live Turnkey:
- that a consensus clause on a DENY applies to the requesting user. If it does not, the
  fence rows above come back ALLOW;
- that `eth.eip_712.domain.chain_id` matches the hex quantity ethers sends (`0xaa36a7`). If it
  does not, the order rows come back DENY;
- that `partiallyFillable == false` compares a bool. If it does not, the order rows come back DENY;
- that `feeAmount == '0'` matches the decimal string ethers sends for a uint256, and that the token
  fields compare as the lower-cased strings sent. If not, the order rows come back DENY.

Run the settler's own matrix again too: if the consensus applied to every user, the settler would
be denied everything but CoW orders.

Policies govern activities, not reads: a stolen hook key can still query the sub-org, including the
activity history (the settler's identity proofs and EIP-3009 authorisations, and the hook's own
orders, signed or abandoned). Treat the hook key as able to read everything the settler has signed.

**If a fenced key is stolen.** Revoking the key stops new signatures, but every order it already
signed stays valid until its `validTo`, and the relayer allowance is unlimited.

1. Delete the user's API key (or the user) with the sub-org root key. If you delete the user, also
   drop it from `cowswapHook.users`, or apply refuses because the listed user no longer exists.
2. Stop the settler agent (or turn on the payments kill switch) first: the next step sends from the
   settler wallet, and a transaction the agent did not send takes a nonce it has reserved. Then list
   the orders it signed from the sub-org's Turnkey activity history (its sign raw payload
   activities) and call `GPv2Settlement.invalidateOrder` on each from the settler wallet, signed with
   the root key, or revoke the GPv2VaultRelayer allowance on every listed sell token the same way if
   that is faster. Restart the agent once those transactions are mined.
3. Before giving the purpose a new key, create a new user and fence it as in the steps above.

**Changing or removing a fenced user.** To change a key, rotate the API key on the same user
(`turnkey:rotate-api-key … --user-name <name>`); the fence names the user, not the key, so
it stays in place. Never re-create the user instead. Replacing the user itself means a new fence:
the DENY names carry the user id, so a new id adds a fence and leaves the old one stale. Apply
refuses while two users share a listed name, or while the old user still exists unlisted, so delete
the old user, and its API key, before applying the new id. `--prune`
refuses to delete a hook user's denies while `list_users` still lists that user, and refuses on any
failed lookup, since that proves nothing.

`--update` replaces a drifted policy, ALLOW or DENY, through a temporary copy named
`<name> [replacing]`: it creates that copy, deletes the old one, creates the new one under the real
name, then deletes the copy, so a copy of the policy is live at every step (Turnkey refuses two
policies with one name). A missing DENY admits what it fenced, and a missing ALLOW refuses live
signatures, which the settler treats as terminal. An interrupted run can leave the `[replacing]`
copy. The next apply that goes through deletes it by itself, never while it is the only copy: it
first makes sure the real copy is live (with `--update` if the old copy is still live and drifted).
A live policy named `<emitted name> [replacing]` is treated as such a copy and deleted without
`--prune`. Each replacement briefly holds one extra policy, and Turnkey refuses a create past 100
policies per org ("Exceeded maximum number of policies: 100"). Stale policies are deleted last, so
they count too. Apply works out the most policies live at once before writing and refuses a run
that would pass 100, and the dry run prints that number beside the live count. Free slots with
`turnkey:delete-policies` first. Never delete a `[replacing]` copy by hand, since it may be the
only live copy of that policy, and never run two applies against one sub-org at once.

### The sender set

**sender** (`buildSenderPolicies`) assembles the Permit2-bounded set from `senderExtras`:

- per EVM/Tron chain, `allowPermit2DepositTypedData` — the sender's only fund-moving signature,
  scoped to `PAYLOAD_ENCODING_EIP712` and binding the primary type, the Permit2 domain and
  verifying contract, the domain chain id, `spender`, `permitted.token`, the witness roles and
  `witness.destination`;
- `allowEd25519RawPayload`, emitted only when the sub-org holds a Solana chain;
- three universal raw-signing denies: `denyNonTypedDataHashFunctions` (NO_OP, SHA256, KECCAK256),
  `denyAccountDelegationEncoding` (EIP-7702) and `denyBatchRawPayloads`;
- per-chain `allowApproveToPermit2` allow, zero-native-value deny, gas/fee caps, and the Solana
  program allowlist (system + SPL + escrow programs).

Notes on this set:

- **`spender` is the funds-destination binding.** Permit2 leaves the transfer recipient unsigned,
  so the escrow named as spender is who can pull the allowance. Permit2 pulls only under a
  signature, and the typed-data allow bounds that signature.
- **`witness.destination` binds the payee.** Destinations are configured as their two CAIP
  components and joined by `buildEscrowDestination`, never written out by hand: the escrow stores
  only `keccak256(bytes(destination))`, and casing is per-segment (eip155 hex folds to lowercase,
  base58 segments keep their exact case). Address members of the struct are hex on Tron, since the
  TIP-712 message strips the `0x41` prefix, so the emitter converts the base58 you configure.
- **`allowedDestinations` is a funds-custody decision.** List only destinations you control.
- **`eth.eip_712.primary_type` restricts signing to the deposit type**, which excludes Permit2's
  `PermitSingle` / `PermitBatch` allowance modes and a bare `PermitTransferFrom`. Do not widen it.
- **`HASH_FUNCTION_KECCAK256` is denied**, as on the settler. A raw keccak signature over an
  assembled EIP-712 preimage (`0x1901 ‖ domainSeparator ‖ hashStruct`) would not be evaluated
  against the `eth.eip_712.*` conditions, and the sender's secp256k1 accounts only call
  `signTypedData`.

### Preconditions before applying the sender set

A misconfiguration here fails closed: Turnkey refuses to sign with a 403, which can look like a
credential error.

1. **Every corridor the sender uses has its destination configured.** Take the destination asset
   identifier from the gateway's response for the corridor rather than composing it by hand. The
   commitment covers the exact bytes, including the asset namespace, so a different spelling of
   the same asset is denied.
2. **`escrows` matches `escrow_contract` from `GET /v1/defaults`** per chain, on the deployment the
   sender points at.

### What the sender set does NOT bind

`permitted.amount`, `nonce`, `deadline` and `witness.depositRequestHash` are unbound, so a stolen
key can still authorize deposits for the wallet's full balance. Those funds move into an
allowlisted escrow addressed to an allowlisted destination, so this is a forced-payment and
lockup risk rather than theft, but only while every entry in `allowedDestinations` is an address
Atum controls. Nothing enforces that, so treat the destination list as a funds-custody decision,
not a routing convenience.

`eth.eip_712.primary_type` carries more weight than it looks: it is what shuts out Permit2's
`PermitSingle` / `PermitBatch` allowance modes and a bare `PermitTransferFrom`, each of which would
turn the standing unlimited approve into a direct drain. Widening it is not a small change.

The Solana account is not bounded against a stolen key at all, and its `solana.tx.*` policies
should not be read as if it were. A Solana transaction signature is raw ed25519 over the
serialized message, so anyone holding the API key can produce one through the raw-payload allow
without calling `signTransaction`, which is where those policies apply. They constrain honest
software. Bounding the balance on this account, or moving it to its own sub-org, is the control
that applies.

`HASH_FUNCTION_KECCAK256` is denied here, as on the settler. It signs a caller-supplied
preimage, and an EIP-712 digest is one: `0x1901 ‖ domainSeparator ‖ hashStruct` is 66 bytes an
attacker can assemble, reproducing any Permit2 signature while every `eth.eip_712.*` condition
sits unevaluated. The sender does not need it: its secp256k1 accounts only call `signTypedData`.
Solana is the one path that cannot be narrowed further: its deposit signature is raw ed25519 over
a digest that already has the destination hashed into it, so no field-level policy, including
`allowedDestinations`, can reach the payee there.

### The verifier set

**verifier** (`buildVerifierPolicies`) assembles the escrow-witness set from `verifierExtras`:

- per EVM/Tron chain, `allowReleaseWitness` and `allowRefundWitness`, each scoped to
  `PAYLOAD_ENCODING_EIP712` + `HASH_FUNCTION_NOT_APPLICABLE` and binding
  `eth.eip_712.primary_type`, the `Escrow` / `3` domain, the domain chain id (Tron masked to 32
  bits), `domain.verifying_contract` in `escrows` and `message['releaser']` in `releasers`;
- per EVM chain, `allowFulfillmentVerdict` and `allowDepositVerdict`: veri-fill's verdicts,
  `PAYLOAD_ENCODING_EIP712` + `HASH_FUNCTION_NOT_APPLICABLE` under the `Atum Verdict` / `1` domain
  and the chain id. No witness or Permit2 shares that domain name, so a verdict cannot pass for one;
- `allowEd25519RawPayload` (HEXADECIMAL only), scoped with `wallet_account.address` to the
  verifier's Solana account in `solanaSigners`, emitted only when the sub-org holds a Solana chain;
- `denyNonTypedDataHashFunctions`, `denyAccountDelegationEncoding`, `denyBatchRawPayloads`,
  `denySignTransaction` (the verifier never signs a transaction) and `denyCredentialChanges`.

Notes on this set:

- **`primary_type` is the only thing that separates release from refund.** The two witnesses are
  field identical under the same domain, so each rule names its type.
- **`escrows` must list every escrow a live deposit can still sit on**, not only the one the
  gateway currently returns. A release or refund on an escrow missing here is denied, and the
  verifier reports that as a permanent failure. **Before a new escrow takes its first deposit,
  add it to `escrows` and re-apply this set.**
- **`releasers` are the verifier's own addresses, per chain.** The zero address is refused.
- **`denyCredentialChanges` stops the verifier user managing its own credentials.** Turnkey lets
  every user change its own credentials unless a policy denies it, so without this a stolen
  verifier credential could add its own API key and survive revocation. It applies to every user
  in the sub-org, and only a root quorum bypasses it, so keep the root quorum threshold at 1 or
  approve root credential changes with the full quorum.
- **The policy never emits a consensus clause.** A non-root request is allowed or denied, never
  left pending. Never approve a pending verifier activity: the verifier has already failed that
  request, and a signature it did not record would bypass its audit trail.

What the verifier set does NOT bind: which deposit a witness names, its amount and its settler.
A stolen credential can sign a release or refund for any deposit on an allowlisted escrow, the same
power the raw key had. What the set removes is everything else: the verifier's API user cannot
export the keys, and on secp256k1 only typed data named `ReleaseWitness` or `RefundWitness` under an
allowlisted Escrow v3 domain, or a verdict under the `Atum Verdict` domain, can be signed. A verdict's
payment, outcome and block are unbound too, so a stolen credential can sign a verdict for any
payment on a listed EVM chain. Its consumers check the signer, and no contract
trusts the `Atum Verdict` domain. Keep it that way: a contract that accepted it would accept any
verdict this credential signs. The Solana account is custody only. Its signature is raw
ed25519 over an opaque digest and the policy language exposes no payload field, so a stolen
credential can sign any bytes with it, a serialized transaction message included. Keep that account
at zero balance and give it no authority anywhere.

### Securing the verifier sub-org root

The root quorum bypasses every policy, and Step 1 leaves one root user whose only credential is a
local API key, printed to the terminal and written to `*.suborg.json` and `.env`. Whoever holds that
key can export or sign with every verifier key. Once Steps 1 to 4 are done, before the verifier
signs with the sub-org:

1. Add two root users on hardware authenticators to the root quorum (`UPDATE_ROOT_QUORUM`) and
   confirm each can act. With one device, losing it locks the sub-org for good.
2. Remove the Step 1 user from the root quorum and delete its API key, then destroy every copy of
   that key: `*.suborg.json`, `.env`, terminal scrollback and any log that captured it.

The scripts here stamp with an API key, so a later `apply-policies` or `rotate-api-key` run needs a
temporary root API key added by a hardware root user and deleted straight afterwards.

### Switching the verifier to Turnkey

Every deposit fixes its releaser address on chain, and both release and refund need that address's
signature. The switch therefore happens with no payment in flight, which lets each environment use
fresh keys generated in its own sub-org instead of carrying the old ones over.

1. **Create the sub-org and its non-root API key, apply and test** (Steps 1 to 4, `type: verifier`,
   with the new addresses as `releasers` and `solanaSigners`), then **secure its root** (above).
2. **Add the new addresses wherever the verifier's releaser is allowlisted**, for example the
   sender set's `releasers`, so new deposits naming them are not refused.
3. **Stop new payments and wait until none is in flight**, including deposits still waiting on a
   refund or on their deadline, so no open deposit names an old address.
4. **Switch the verifier to the Turnkey backend** with the new public keys, and remove its raw keys
   in the same change.
5. **Confirm the gateway publishes the new addresses** (update its configuration if it pins them),
   then resume payments.
6. **Remove the old addresses from every releaser allowlist** and re-apply, so nothing can name them.
7. **Delete the old keys everywhere they are stored.** Nothing depends on them any more.

Rollback is possible only before step 5: revert step 4 while payments are still stopped. Once
payments resume, new deposits name the new addresses, so going back means stopping and draining
again first.

**Emergency revocation.** As root, delete the verifier user, or every API key and authenticator on
it, then list its credentials to confirm none remain. Every signature fails closed at once. Signing
resumes when a new verifier user or key is issued.

**Rotating the API key.** As root, register the new key on the verifier user, deploy it, then delete
the old one (`rotate-api-key.ts --target agent`). Rotating the signing keys themselves repeats the
switch above with another set of fresh accounts.

## Step 4 — Test the policies (run this last)

> **Re-applying to an already-provisioned sub-org:** `apply-policies` reconciles both ways and
> fails if a live policy is absent from the emitted set, naming each one. Pass `--prune` to delete
> them. Both checks run before anything is written, so a run that ends in either error has changed
> nothing. With the sub-org credentials set, `--dry-run` lists exactly which policies `--prune`
> would delete.
>
> `--prune` is sub-org wide: it deletes every live policy this config does not emit, including any
> added by hand. Read the printed list before passing it. A policy set is only as tight as its
> widest allow, so a broad allow left live overrides the narrower ones the config emits.

After applying, verify the sub-org actually enforces the set by sending real sign requests with the
**agent (non-root)** credentials and checking each is denied or allowed as expected. Positive
controls are signed but never broadcast, so there are no on-chain side effects. This also detects a
root-credential mistake: root bypasses policies, so if root keys were installed by accident, every
"expect DENY" case reports ALLOW.

Credentials come from `TURNKEY_SUBORG_USER_API_PUBLIC_KEY` / `TURNKEY_SUBORG_USER_API_PRIVATE_KEY`, the sub-org's
**agent (non-root)** key from Step 2. It must be non-root — root bypasses policies, so a root key
would make every "expect DENY" case pass. (If you keep several agent keys in one `.env`, name the
vars with `--api-public-key-env` / `--api-private-key-env`.)

The test needs the **sub-org id** and the **wallet addresses**. Provide them one of two ways:

- Explicit flags (most reliable): `--sub-org <id>` plus `--evm-address <0x…>` (required for every
  run), `--solana-address <…>` (for the Solana cases), and `--tron-address <T…>` (settler Tron cases).
- `--suborg-file <path>`: reads the id and addresses from the JSON `create-sub-org` wrote, but
  **only a COMPLETED record has those fields**. A `PENDING_CONSENSUS` file (sub-org not yet
  approved) has neither, and a sub-org you approved in the Turnkey dashboard never produced a file,
  so in both of those cases use the explicit flags instead and read the id and addresses from the
  dashboard.

Preview the matrix offline first (nothing is sent):

```
pnpm turnkey:test-policies -- \
  --config ./scripts/config/settler-mainnet.yaml \
  --sub-org <subOrganizationId> \
  --evm-address <0x…> --solana-address <…> --tron-address <T…> \
  --dry-run
```

Then run it for real by dropping `--dry-run`. If you do have the completed `create-sub-org` JSON,
pass `--suborg-file ./<name>.suborg.json` in place of the id and address flags.

- EVM address is always required. Add `--solana-address` for the Solana cases and, for a settler,
  `--tron-address`. A sender needs `--evm-address`, `--solana-address`, and `--tron-address` if
  its config carries a Tron chain, since the Tron typed-data cases sign with the Tron account the
  way the runtime does.
- Building Tron and Solana test transactions needs RPC access. Override with `--tron-fullhost` and
  `--solana-rpc` (they default to public mainnet endpoints). The configs carry no Tron token
  contract, so pass `--tron-token <base58>` to run the Tron TRC-20 cases.
- The command exits non-zero if any case fails. An "expect DENY" that reports ALLOW means a
  misconfigured policy or root credentials.

For a **sender** sub-org, point `--config` at the sender YAML and use the sender's agent key. The
matrix switches automatically: approve-to-Permit2 allowed, transfer / other-spender / non-zero
value denied, and the Solana SOL and top-level SPL drain paths denied.

---

## Rotating keys

Both credentials created above are rotatable in place with `rotate-api-key.ts`, and neither needs the
sub-org rebuilt. Turnkey attaches credentials to a **user**, and a user holds up to 10 API keys, so a
rotation is: register the new key, prove it works, delete the old one. The root quorum is defined by
`userIds` and not by key material, so rotating the root key leaves the quorum untouched — no
`UPDATE_ROOT_QUORUM`, and the root user keeps its identity.

The script has two phases and will not run them together. `--revoke` requires `--key-id`, which the
`--add` phase prints for you: nothing about which key dies is ever inferred.

```
# 1. register the new key — the old one keeps working
pnpm turnkey:rotate-api-key -- --sub-org <uuid> --target root --add
pnpm turnkey:rotate-api-key -- --sub-org <uuid> --target agent --user-name settler-agent --add

# 2. after the consumer is running on the new key, delete the old one
# for root: put the NEW key into TURNKEY_SUBORG_ROOT_API_* before this line
pnpm turnkey:rotate-api-key -- --sub-org <uuid> --target root --revoke --confirm <uuid> \
  --key-id <old-apiKeyId>
pnpm turnkey:rotate-api-key -- --sub-org <uuid> --target agent --user-name settler-agent \
  --revoke --confirm <uuid> --key-id <old-apiKeyId> --verify-public-key <new-pub-hex>
```

Deleting the key you are stamping with is refused, and no flag overrides it: you cannot revoke the
old key until you are running on the new one, so a bad replacement fails the rotation instead of
locking you out. Replace the value of `TURNKEY_SUBORG_ROOT_API_PUBLIC_KEY` / `_PRIVATE_KEY` with the
new key between the two phases.

Order matters most for root. The sub-org root key is the only way in: the parent org has
**read-only** visibility into its sub-orgs and cannot add users, add keys, or change the root quorum
inside one, and `DELETE_SUB_ORGANIZATION` must itself be initiated by a root user in the sub-org.
Lose every root credential and there is no self-service recovery. Revoking while stamping with the
**new** key proves the new key is live and is root.

Never give a root key a TTL. An expiring root key becomes the only credential once the old one is
revoked, and nothing outside the sub-org can mint a replacement after it lapses, so the lockout is on
a timer rather than dependent on a mistake. The script refuses `--expiration-seconds` on
`--target root` and refuses a revoke whose only survivors are expiring or already expired.

For the agent key the blast radius is smaller (root can always mint it another key), but verify the
same way: restart the agent on the new key, then re-run Step 4 with it before revoking. Full flag
reference is in [README.md](./README.md#rotating-an-api-key).

If the sub-org's root quorum threshold is above 1, what needs approving depends on whose credentials
change. A user changing its **own** credentials completes on one vote at any threshold, so root
self-rotation is unaffected. Rotating the **agent's** key is root editing a different user, so both
phases come back `CONSENSUS_NEEDED` and exit 2 with an activity id and fingerprint. Approve with
another root user's key via `turnkey:approve-activity` (details in
[README.md](./README.md#root-quorum-and-consensus)). This matters most for a machine-managed sub-org:
root users that hold only an API key cannot log into the dashboard, so the CLI is the only way to vote.

If you need a different root **user** rather than new key material for the existing one, that is a
separate flow this script does not cover: `CREATE_USERS`, then `UPDATE_ROOT_QUORUM` to add the new
user, verify it, then `UPDATE_ROOT_QUORUM` again to drop the old one, then `DELETE_USERS`. Never
delete before the quorum update completes.

## Verifying the result

- In the Turnkey console, open the sub-org and confirm the wallet addresses, the machine user's
  API key, and the policy list.
- Re-running `apply-policies` without `--update` is a safe way to confirm the live set matches your
  config — everything should report as skipped/unchanged.

## Security notes

- The parent-org key creates sub-orgs. The sub-org root key manages users and policies inside a
  sub-org. Guard both like root credentials, and prefer short-lived operator sessions over
  long-lived keys on disk.
- Every generated private key (root user, machine API key) is a bearer secret. Move it into your
  secret manager and delete the local `*.json` files once stored.
- Policies are defense-in-depth, not the only defense: the agent enforces the same allowlist
  client-side. Both layers should be configured from the same source values.
