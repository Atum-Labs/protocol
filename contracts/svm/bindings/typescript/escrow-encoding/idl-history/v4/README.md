# v4 Solana escrow IDL

The Anchor IDL of the v4 escrow program served on devnet and mainnet (ids in
`../../../../../deployments-v4.json`). Use it to decode what that program emitted and the
`deposit` instructions it accepted.

`escrow.json` is `src/generated/escrow.json` as of `499bbeb5`, byte for byte. It is a snapshot,
not build output, so `sync-idl` does not touch it. The localnet image (`contracts/svm/docker`) builds v4 from
`56e374a0` and fails when its IDL differs from this file other than in the program id.

## What differs from `src/generated`

The `deposit` instruction: the served program takes `destination: string`, the current
source takes `destination_hash: [u8; 32]` in the same position. Events and accounts are the same.
Only the `DestinationEmpty` and `DestinationTooLong` messages differ.

The served programs were last deployed on 2026-09-16, before #271 and #272 merged (2026-10-20),
so they also lack what those two added, although this snapshot carries it: `InvalidDepositorAta`
(6049), `PermanentDelegateMintNotAllowed` (6050) and the `memo_program` account on `release` and
`refund`. `MintExtensionNotAllowed` (6051) is in neither, only the current source has it.

`scripts/check-deployed-events.mjs` decodes the escrow with this IDL by default, and
`event-values.test.ts` checks the `testdata/mainnet-v4-*.json` transactions against it.
