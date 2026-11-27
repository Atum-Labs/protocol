# Encoder parity

Every escrow signature (deposit, reserve, release, refund, and on Stellar the delegate renounce) is
made over a digest that an off-chain encoder computes and the contract recomputes on-chain. This repo ships that encoder in
Go and in TypeScript for each VM. A one-byte difference from the contract yields a signature over
a digest the contract never rebuilds, so the tests below pin each encoder to the contract itself
wherever the contract can serve as the oracle, and otherwise to one literal shared by every
implementation.

Witness shapes covered:

| Witness | Members |
|---|---|
| Deposit | `depositRequestHash`, `destination`, `reserver`, `releaser` |
| Reserve | `depositId`, `quoteHash`, `settler`, `sourceAmount` |
| Release, Refund | eleven members, including `quoteHash`, `depositRequestHash` and `destinationHash` |

The deployed Solana programs verify at `signature_domain_version` 5.

## EVM and TVM

The oracle is the contract source, `contracts/{evm,tvm}/source`, read at test time. No expected
typehash is transcribed into a test, and every source scanner fails on a missing, duplicated or
commented-out declaration instead of skipping.

| What is pinned | Go (`bindings/go/escrow-encoding/encoding/`) | TypeScript (`bindings/typescript/escrow-encoding/src/`) |
|---|---|---|
| Witness typehashes vs `*_WITNESS_TYPE_HASH` in `Escrow.sol` | EVM `escrow_source_typehash_test.go`, TVM `witness_v2_typehash_test.go` | `witness-typehash.test.ts` |
| Permit2 deposit type string vs `FULL_DEPOSIT_WITNESS_TYPE_STRING` | same files | `witness-typehash.test.ts` |
| Digest composition: every member bound, in the contract's order | EVM `witness_quotehash_conflict_test.go`, TVM `witness_v2_binding_test.go` | `witness-typehash.test.ts` |
| Deposit digest with destination: one literal shared by Go and TS | `TestDepositWithDestinationGolden` (EVM `deposit_witness_v2_test.go`, TVM `deposit_encoder_test.go`) | `deposit-encoder.test.ts` |
| Signing domain vs the `EIP712(...)` constructor call; Permit2 domain for deposits; TVM chain-id mask | `v2_domain_test.go` | TVM mask: `witness-typehash.test.ts`, `deposit-encoder.test.ts` |
| Destination byte bound vs the contract constant | TVM `witness_v2_binding_test.go` | `witness-typehash.test.ts` |
| Witness structs and ABI fragments vs the compiler-emitted ABI | EVM `escrow_source_typehash_test.go` | EVM `escrow-abi.test.ts` |
| Event topic0s vs the source ABI | `event_topic0_test.go` with `testdata/event_topic0_golden.json` | n/a |
| Reserve signature verification: the escrow's signature rule, one signed reserve per chain and a refusal per witness member | sender-auth `reserve_auth_test.go` | sender-auth `reserve-auth.test.ts` |
| SDK-built awards: the deposit (`sender_auth`) verifies with the reserve's signer as reserver and the fulfillment verifier as releaser, the reserve verifies, a reserve for another settler or amount is refused, the payment id is the deposit id | sender-auth `award_sdk_vectors_test.go` | sender-auth `award-sdk-vectors.test.ts` |

The reserve signature vectors are `schemas/declarations/PaymentRequest/v1/conformance/reserve-auth-vectors.json`.
Their EVM anchor is the reserve signature in `evm/conformance/direct-deposit-vectors.json`, which
`evm/source/test/Escrow.directDepositVectors.t.sol` runs through the real escrow.

The SDK award vectors are `schemas/declarations/PaymentRequest/v1/conformance/award-sdk-vectors.json`,
written by payment-gateway-client `award-sdk-vectors.test.ts`, which fails when the SDK builds
anything else. `evm/source/test/Escrow.awardSdkVectors.t.sol` submits their EVM awards, signatures
unchanged, to the real escrow and Permit2: each deposit clears with the SDK's payment id, and a
witness with another settler or a lower source amount reverts.

On Tron, `tvm/source/test/EscrowReserveSdk.test.js` builds the award at run time, because the
escrow's address changes with every deployment. It builds the deposit and its payment id with the
`tvm-escrow-encoding` builder the SDK uses, and the reserve with the SDK; both are signed through the
SDK's signer. The deposit and the reserve, with the settler given in base58, clear the escrow on a
local TRON node, and a witness with another settler or a lower source amount reverts
`InvalidSignature`. The SDK's own Tron deposit is covered by the `sender_auth` check in the vector
suites above.

## SVM

The program hashes a documented byte layout with keccak-256
(`contracts/svm/source/programs/escrow/src/utils/signatures.rs`). Parity is pinned by anchors: one
set of inputs and one literal digest, derived out of band with an independent keccak-256 from that
layout, asserted by more than one implementation.

| Leg | Layout | Pinned by |
|---|---|---|
| Deposit | includes `deposit_request_hash` and `destination_hash` | Rust `ANCHOR_DEPOSIT_V4_DEVNET`, Go `v4_destination_test.go`, TS `v4-destination.test.ts` |
| Destination hash | `keccak256(destination)`, identical to EVM and TVM for the same string | same three files |
| Reserve | includes `quote_hash` and `source_amount` (LE u64) | Rust `reserve_hash_matches_the_documented_v5_layout`, Go `v3_sourceamount_test.go`, TS `v5-source-amount.test.ts` |
| Release, Refund | `deposit_hash` and `quote_hash` | one literal per leg at domain versions 3 and 5, shared by Rust `tests/encoder_anchors.rs`, Go `v2_quotehash_test.go` and TS `v4-destination.test.ts` |
| Reserve signature verification | the reserve anchor above, signed with ed25519 | sender-auth Go `reserve_auth_test.go` and TS `reserve-auth.test.ts`, reading `schemas/declarations/PaymentRequest/v1/conformance/reserve-auth-vectors.json` |

Further shared checks:

- `svm/conformance/guard-vectors.json`: rejection cases asserted by Go `guard_parity_test.go`
  and TS `guard-parity.test.ts`, so an input guard present in one language fails the other until
  it is mirrored.
- Go `compute_budget_parity_test.go` and `replay_buckets_parity_test.go` read the deposit
  compute-unit limit and the replay-bucket count from every other copy in the repo.
- `svm/bindings/typescript/escrow-encoding/scripts/check-idl.sh` diffs the vendored IDL against a fresh
  `anchor build`.

The anchors use the program id declared in the source tree. The program id is a preimage input,
so a signer must use the id of the program it targets: see `svm/deployments-v4.json`.

`svm/source/tests/16_reserve_sdk.ts` builds an award with the SDK at run time, because the deposit
hash binds each test's mint and keys, and `issued_at` is checked against the validator clock.
The SDK's deposit and reserve clear the program on a local validator, and a reserve naming another
recipient or a lower source amount fails `InvalidMessage`.

## Stellar

The Soroban escrow hashes a documented byte layout with keccak-256
(`contracts/stellar/source/contracts/escrow/src/signatures.rs`, specified in
`contracts/stellar/source/docs/witness-layouts.md`) at `SIGNATURE_DOMAIN_VERSION` 2. Parity is pinned by
one shared fixture, `stellar/conformance/vectors.json`, that three implementations reproduce: the
contract's own digest functions, the Go encoder and the TypeScript encoder. No implementation writes
the fixture. `stellar/conformance/regenerate_vectors.py` derives it from the layout doc with its own
keccak-256, strkey encoder and ed25519 signer.

| Leg | Layout | Pinned by |
|---|---|---|
| Deposit (= the deposit id) | includes `destination_hash`, `amount` ceiling (LE i128), `addr33` depositor and token | `vectors.json` kind `deposit`, read by Rust `test_conformance.rs`, Go `conformance_test.go`, TS `conformance.test.ts`; Rust also pins the doc anchors in `test_anchors.rs` |
| Destination hash | `keccak256(destination)`, identical to EVM, TVM and SVM for the same string | kind `destinationHash`, same three readers |
| Reserve | includes `quote_hash` and `source_amount` (LE i128) | kind `reserve`, same three readers |
| Release, Refund | eleven members; differ only in the tag | kinds `release` and `refund`, same three readers; a release and a refund of the same inputs must differ |
| Renounce | delegate signer's digest over `depositor`, `token`, `epoch`, `nonce`, `deadline` | kind `renounce`, same three readers |
| Active-deposit hash | stored, no prefix or tag: what `get_deposit_hash` returns | kind `activeDeposit`, same three readers |
| Network id, strkeys | `network_id = sha256(passphrase)`; G and C strkeys decode to `addr33` | `networks` and `addresses` tables in `vectors.json`, same three readers |
| Delegate signatures | raw ed25519 over the 32 digest bytes, seed `77` x 32 | `signature` on the deposit and renounce vectors: Rust `verify`, Go `crypto/ed25519`, TS `@noble/curves` |
| Every member bound | each field and each domain input changed once | the `mutates` cases in `vectors.json`: each digest must differ from its base, in all three |

Further shared checks:

- `stellar/conformance/guard-vectors.json`: rejection cases asserted by Go `guard_parity_test.go` and
  TS `guard-parity.test.ts`, in both directions: a case in the file that a language does not exercise
  fails it, and a guard a language exercises that the file does not list fails it too. The contract's
  own rejections (ledger-time checks, delegate limits, allowance) are covered by the escrow crate's
  tests, not here: an encoder cannot see the ledger.
- Release and refund reject a zero `quote_hash` on Stellar (`QuoteHashCannotBeEmpty`), unlike Solana.
- Digest and signature are separate steps: the encoders return the 32 digest bytes and never sign.

What CI runs for Stellar today, and what only runs locally:

| Check | In CI? |
|---|---|
| Go tests (`go build` and `go test` in every `go.mod`, which includes the Stellar module) | Yes, in the `go` lane when a path filter matches (`contracts/*/bindings/**`, `contracts/*/conformance/**`, `**/*.go`) |
| TypeScript tests (`pnpm -r test`, which includes the Stellar package through the workspace glob) | Yes, in the `typescript` lane, same filters |
| `node schemas/apis/payment-gateway/v1/bindings/go/client/scripts/flatten.mjs --check` (the SDK's copy of the Go encoder) | Yes |
| Stellar Rust tests incl. `test_conformance.rs` and `test_anchors.rs` (`cargo test --workspace`), clippy, `cargo fmt --check` | Yes, in the `stellar-contracts` lane (path filter `contracts/stellar/**`) |
| `python3 contracts/stellar/conformance/regenerate_vectors.py --check` (vectors match the layout doc) | Yes, same lane |
| Release wasm build (`stellar contract build`) | The `stellar-wasm` lane (same path filter) builds the wasm on Linux and publishes both files and their sha256s as a CI artifact (`hashes.txt`, plus the job summary). It does not compare against a recorded hash and does not gate merges: it is not in `ci-gate`. The Stellar CLI is built from the commit the deploy README pins. Deployment takes the wasm from that artifact |

So in CI, drift in the Go or TypeScript encoder fails against `vectors.json`, a change to the contract
that breaks the fixture fails the `stellar-contracts` lane, and so does a hand edit of `vectors.json`.
To run the same checks locally:

```sh
(cd contracts/stellar/source && cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace)
python3 contracts/stellar/conformance/regenerate_vectors.py --check
```

Unlike Solana, nothing in the fixture is frozen history: there is one layout. A layout change ships as
a new contract id (no `upgrade` entrypoint), so the vectors are re-derived, not appended to.

## Running it

```sh
for m in evm tvm svm stellar; do (cd contracts/$m/bindings/go/escrow-encoding && go test ./...); done
for m in evm tvm svm stellar; do (cd contracts/$m/bindings/typescript/escrow-encoding && pnpm test); done
(cd contracts/svm/source && cargo test -p escrow hash_anchor_tests)
(cd contracts/stellar/source && cargo test --workspace)   # also the stellar-contracts CI lane
python3 contracts/stellar/conformance/regenerate_vectors.py --check   # also the stellar-contracts CI lane
node schemas/apis/payment-gateway/v1/bindings/go/client/scripts/flatten.mjs --check
```

CI runs the Go and TypeScript suites for every chain, the SVM `cargo test --workspace` and the IDL diff, and
the Stellar Rust tests and vector check in the `stellar-contracts` lane: see the Stellar section.
`contracts/svm/verify.sh` runs the Anchor build, the IDL diff and the Rust anchors locally.

## If a check fails

An encoder no longer matches the contract. Fix the encoder. Change an expected value only when the
on-chain encoding changes intentionally, and then:

- EVM/TVM: land the contract source and the encoder change together; the oracle moves with the
  source. For an event change, reseed the topic0 golden with `UPDATE_TOPIC0_GOLDEN=1 go test ./...`
  and update any log decoder in the same change.
- SVM: re-derive each affected anchor out of band from the documented layout and update the Rust,
  Go and TypeScript literals together. Never copy a value from the output of the code under test.
- Stellar: a layout change is a reviewed vector bump, in this order. Change `signatures.rs` and bump
  `SIGNATURE_DOMAIN_VERSION`; change `witness-layouts.md` and the layout functions in
  `regenerate_vectors.py` in the same commit; run `python3 contracts/stellar/conformance/regenerate_vectors.py`
  and review the whole `vectors.json` diff, since the script, not an implementation, is the oracle (add
  `--cast` to cross-check every digest with foundry's `cast keccak`); then update the Go and TypeScript
  encoders and the doc anchors in `test_anchors.rs` until all three suites pass. `--check` fails if the
  file is stale. Never regenerate by pasting a digest from an implementation. After changing the Go
  encoder, run `node schemas/apis/payment-gateway/v1/bindings/go/client/scripts/flatten.mjs` to refresh the SDK's `internal/` copy.
