# Contracts

On-chain contract sources and their language bindings for the three chain families
the protocol settles on (EVM, TVM, SVM).

## Layout

Each `<chain>/` holds:

- `source/`: the contract source. This is the source of truth. It used to be
  imported from a dedicated per-VM repo (`evm-contracts`, `tvm-contracts`,
  `solana-escrow`) at a pinned commit; those repos are retired and their open PRs
  were closed as superseded, so do not look for a pin here or change contracts there.
- `bindings/{go,typescript}/escrow-encoding`: the hand-written signing-input encoders
  (deposit, reserve, release, refund) that the off-chain sides and the program must
  agree on byte for byte, with cross-language parity tests, plus the generated
  contract bindings.
- `conformance/`: the frozen cross-language parity vectors those encoders are
  checked against.
- `docker/`: the local-stack setup for that chain.
- `deployments-v*.json`: deployed contract addresses per environment.

## Contract versions

**v4 is the current generation.** The source in each `<chain>/source/` is what shipped;
there is no external pin to reconcile against.

Deployed addresses per generation live in `<chain>/deployments-v*.json`. v4 covers the first three rows:

| Chain | Record | Networks |
|---|---|---|
| EVM | `evm/deployments-v4.json` | 8 mainnet chains, 8 testnet chains |
| TVM | `tvm/deployments-v4.json` | mainnet, shasta |
| SVM | `svm/deployments-v4.json` | devnet and mainnet both deployed (record lands with the SVM deploy tooling) |
| EVM v5 (the library generation) | `evm/deployments-v5.json` | Tempo Moderato (42431) and Tempo Mainnet (4217), so far |

The EVM library generation (CORE-3048, CORE-3055), called v5 here, is recorded separately in
`evm/deployments-v5.json`, so `deployments-v4.json` keeps describing the v4 escrow that every v4 chain still
serves. Each chain entry carries the escrow, its library, the reused proxy, the initcode hash, salt,
source commit and the deploy and token-config transactions.

EVM is one address pair per *network* rather than per chain: CREATE2 with a fixed salt
gives the same address on every chain, and mainnet differs from testnet only because the
constructor args differ, so the initcode hash differs. Tron has no CREATE2, so its
addresses derive from the deploy txID and the two networks are unrelated. SVM records
program ids keyed by truncated genesis hash, and devnet and mainnet deliberately differ.

### EVM preview FulfillmentProxy

Each EVM entry also records `FulfillmentProxyPreview`, the proxy with `authorizeFulfillment`
(originator fulfill, CORE-2676). It is a second, separately deployed proxy beside
`FulfillmentProxy`; the Escrow is unchanged, and services move to it per environment.

| Network | Address | Built from | Pause | `PAUSER_ROLE` |
|---|---|---|---|---|
| mainnet (8) | `0x1FaF7640110Fb09BaD288dBEf5B4f676b0eC1932` | `a58ff7c0` contract code (includes #217, CORE-2710) | `authorizeFulfillment` pauses with the rest | deployer |
| testnet (8) | `0xd1254EF0f2bc75AD577FE48fC5CC9c3ec13B0144` | `a58ff7c0` contract code, the commit Cantina audited (includes #217, CORE-2710) | `authorizeFulfillment` pauses with the rest | deployer (granted in the deploy broadcast) |

Both were deployed through the CREATE2 factory with the network's v4 salt and deployer, which is
also the `defaultAdmin` (delay 1 second); the settler allowlist is dormant. The broadcasts are
recorded under `evm/source/broadcast/DeployFulfillmentProxy.s.sol/<chain id>/`: the mainnet ones
since #218, and the testnet ones with the redeploy from `a58ff7c0` (CORE-2902). The runner
(`evm/deploy/deploy-fulfillment-proxy.sh`, protocol#178) grants `PAUSER_ROLE` in the same broadcast
and refuses a run that leaves a chain without it.

The testnet proxy was deployed on 2026-10-25 from the runner at `97b53580` (Ethereum Sepolia by `forge script`
directly from the same commit), whose contract source equals `a58ff7c0`, by the testnet deployer (`0x11121EECf186b5365C3E65A7B16BfD231eAC76B5`). On all 8 testnets it
has runtime code keccak `0xb24c5fdb848ad5942ebbd6c14166c5b70b84f8ee9d48736b39ff96570e8dce66`, the same as
the mainnet proxy; the deployer is `defaultAdmin` (delay 1 second) and holds `PAUSER_ROLE`; and it is
not paused. Each chain's record holds two transactions, the CREATE2 deploy and the `grantRole`. Deploy
gas was 1,783,183 on five chains, 1,793,263 on Polygon Amoy, 12,435,319 on Ethereum Sepolia and 9,096,583 on
Tempo Moderato. A first Ethereum Sepolia attempt ran out of gas and is not recorded here.

The testnet proxy it replaces, `0x3f2F4Fa9EA195028f534851ddFd26994e4e3700c`, was deployed before #217,
so `authorizeFulfillment` does not pause on it. It stays in the services' trust lists until the
last payment created on it has finished, then comes out in a follow-up. Its deployer holds
`PAUSER_ROLE` on all 8 testnets since CORE-2817 (a direct `grantRole`, because the runner refuses an
address the current tree doesn't build). The mainnet cutover and what adopting a new address takes
(settler Turnkey policies, and a cutover that scans both proxies for the refund window) are in
protocol#178's `evm/deploy/README.md` section "Bytecode-only FulfillmentProxy redeploy".

Two chains present in v3 have no v4 entry: BNB Chain Testnet (97) has no v4 bytecode
deployed, and Celo Alfajores (44787) could not be verified
because its public RPC endpoints are no longer reachable.

Tempo Mainnet (4217) and Tempo Moderato (42431) are recorded in v4 since #91 (CORE-2284).

## Submodules

The third-party Foundry dependencies stay as git submodules (`forge-std`,
`permit2`). After cloning, initialize them:

```
git submodule update --init --recursive
```

Without this the Foundry projects under `evm/source` and `tvm/source` do not build.

## Local dev keypairs

`svm/accounts/` and `tvm/docker/accounts.json` hold intentionally-public,
disposable local-development keys, the Solana and Tron equivalent of the well-known
Anvil and Hardhat accounts. They have never held funds on any real network and must
never be used outside a local test cluster. See `svm/accounts/README.md`.

## Encoder parity and IDL drift

See `encoding-parity.md`. The escrow-encoding deposit, reserve, release, and refund
hashes are checked cross-language between Go and TypeScript. For SVM they are also
anchored to the program via `svm/conformance/parity-golden.json`, and
`svm/bindings/typescript/escrow-encoding/scripts/check-idl.sh` keeps the vendored Anchor IDL
in sync with the program. The Go decoders in `svm/bindings/go/escrow-encoding/events`, for the
fulfillment proxy's `Fulfilled` and `StrictFulfilled` events and the escrow's `Refunded` and
`Released` events, are pinned to those IDLs' discriminators and field layouts.

## Generated bindings and their guards

Every generated artifact is committed, and CI regenerates it and fails on any diff.

| Artifact | Generated from | Regenerate | Guard |
|---|---|---|---|
| `{evm,tvm}/source/generated/abi/*.json` | the Solidity in `source/` | `make -C <chain>/source generate-abi` | `make check-abi` in the evm-/tvm-contracts lanes |
| `{evm,tvm}/bindings/go/escrow-encoding/generated/*.go` | those ABIs (abigen) | `make -C <chain>/bindings/go/escrow-encoding generate` | `make check-generate` in the go lane |
| `evm/bindings/typescript/escrow-encoding/src/generated/abi.ts` | `evm/source/generated/abi/{Escrow,FulfillmentProxy}.json` | `pnpm run generate:abi` | `generated-abi.test.ts` |
| `svm/bindings/typescript/escrow-encoding/src/generated/*` | the Anchor build | `pnpm run sync-idl` | `check-idl.sh` in the svm-contracts lane |

`evm/bindings/go/escrow-encoding/generated/IERC20Errors.go` is the one exception: it has no ABI
source here, so it is maintained by hand and no regenerate-and-diff covers it.

These guards prove the committed bindings match the committed source. They cannot see
what is actually deployed. For SVM, `pnpm run check:deployed-events` in
`svm/bindings/typescript/escrow-encoding` reads transactions of each program in
`svm/deployments-v4.json` and checks the committed IDL against what the programs emitted:

- **Layout.** Every emitted event's discriminator is in the IDL and its payload length is
  the IDL's.
- **Values.** The money events (`Deposited`, `Reserved`, `Released`, `Refunded`,
  `Fulfilled`, `StrictFulfilled`) are decoded with the IDL and each field is compared with
  what the transaction shows on its own: the token transfers the instruction made, the
  escrow balance before a release, the deposit PDA, and the instruction's args and
  accounts. Fields no single transaction shows (`Deposited.fee_amount`,
  `Reserved.fee_amount`, the `quote_hash` on `Released` and `Refunded`) are checked
  against the same deposit's other events when those are in the scan. A matching length
  alone would pass two swapped `u64` fields.
- **Coverage.** It reports every event the IDL declares, with `UNVERIFIED` for one the
  transactions read did not contain, and lists any money-event field it could not
  value-check as length-only. The other events are checked for layout only.

It fails on any layout or value mismatch, an unknown discriminator, or a required event
left unverified. By default the required events are the ones v4 mainnet has emitted:
`Deposited`, `Reserved`, `Released` and `StrictFulfilled`. v4 mainnet has never emitted
`Refunded` or `Fulfilled`, so a mainnet run reports both as unverified, and their value
rules are tested only against hand-built transactions in the IDL's instruction shape. When
the first one lands, pass its signature with `--signature` (it must be on the cluster being
checked; one the RPC cannot find fails the run). It needs network access, so it is run by
hand, not in CI.

## Decoding escrow events

- **EVM / TVM, Go:** the abigen bindings in `<chain>/bindings/go/escrow-encoding/generated`
  (`IEscrowFilterer`, `IFulfillmentProxyFilterer`).
- **EVM / TVM, TypeScript:** `ESCROW_ABI` and `FULFILLMENT_PROXY_ABI`, the full ABIs of the
  deployed EVM contracts, including the batch events (`DepositedMany`, `ReleasedMany`,
  `RefundedMany`, `FulfilledMany`) and the inherited `ITokenConfig` events. TVM emits a
  subset of the same events with identical shapes, so they decode Tron logs too, but they
  do not carry TVM-only functions or errors. Import them by
  path, `@atum-labs/evm-escrow-encoding/dist/generated/abi`. They are kept out of the
  package index so the packages that bundle it do not ship them.
- **SVM:** `svm/bindings/typescript/escrow-encoding/src/generated/{escrow,fulfillment_proxy}.json`
  describe the v4 programs. Events emitted by the pre-v4 programs have a different layout;
  decode them with `svm/bindings/typescript/escrow-encoding/idl-history/pre-v4/`. The IDLs' `address`
  is the crate's `declare_id!`, not a served program id. Take program ids from
  `svm/deployments-v*.json`.
