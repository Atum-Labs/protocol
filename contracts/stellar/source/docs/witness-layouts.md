# Escrow witness layouts (Soroban)

Byte-exact layouts of every digest the Stellar escrow computes, and the contract for the encoders
(`contracts/stellar/bindings/{go,typescript}/escrow-encoding/`). The implementation is
`contracts/escrow/src/signatures.rs`; the golden vectors below are pinned by
`contracts/escrow/src/test_anchors.rs`. Process and failure handling: `contracts/encoding-parity.md`.

Signature domain version: **2** (`SIGNATURE_DOMAIN_VERSION`). It is a hash input of every digest, so
changing it makes every signature issued under the old version fail. Change it when an existing layout
keeps its bytes but changes its meaning, or to retire all old signatures at once. Changing the bytes of
one digest (for example a member added to its preimage) already makes old signatures over that digest
fail and needs no bump; re-derive that digest's vectors out of band and update the encoders in lockstep.

## Who signs what

| Digest | Signed by | How | Verified by |
|---|---|---|---|
| Deposit (= the deposit id) | the depositor's `delegate_signer` | ed25519 over the 32-byte digest, once, before the auction | `ed25519_verify` in `deposit`, before funds move |
| Reserve | the reserver | ed25519 over the 32-byte digest | `ed25519_verify` in `deposit` |
| Release | the releaser | ed25519 over the 32-byte digest | `ed25519_verify` in `release` |
| Refund | the releaser | ed25519 over the 32-byte digest | `ed25519_verify` in `refund` |
| Renounce | the depositor's `delegate_signer` | ed25519 over the 32-byte digest | `ed25519_verify` in `renounce_delegate` |

The depositor does not sign any escrow digest and `deposit` does not call the depositor's
`require_auth`. Authority is two things set up once, before any auction (Solana's `EscrowDelegate`
model):

1. `create_delegate(depositor, token, delegate_signer, capacity, max_transfer_size, expiration)`, a
   Soroban-authorised call by the depositor, and
2. the depositor's SEP-41 allowance to the escrow, `token.approve(depositor, escrow, amount,
   expiration_ledger)`, a separate transaction the contract does not make for them.

`deposit` then pulls with `transfer_from(escrow, depositor, escrow, source_amount)`. The delegate's
signature over the deposit digest binds the depositor, token, delegate epoch, ceiling, destination,
request hash, reserver, releaser, nonce and time window, so a relayer cannot change any of them. The deposit digest
is also the deposit id.

A signature is the raw 64-byte ed25519 signature (RFC 8032) over exactly the 32 digest bytes, with no
prefix, no SEP-53 framing and no Soroban `HashIdPreimage` wrapping. `delegate_signer`, `reserver` and
`releaser` are raw 32-byte ed25519 public keys, the bytes behind a `G...` strkey. They are not
`Address` values: the contract verifies the signature itself and never calls `require_auth` for them.

## Primitive encodings

All fields are fixed width and concatenated with no length prefixes, no separators and no padding.
Injectivity depends on that, so a variable-length member must be hashed first (destination).

| Name | Width | Encoding |
|---|---|---|
| `b32` | 32 | raw bytes |
| `key32` | 32 | raw ed25519 public key |
| `addr33` | 33 | 1 type byte then 32 bytes. Type `0x00` = account (`G...`, the ed25519 key), `0x01` = contract (`C...`, the contract id hash). These are the XDR `ScAddressType` values. Muxed (`M...`) and claimable-balance addresses are not representable and are rejected by the contract (`UnsupportedAddress`). |
| `amt16` | 16 | non-negative `i128` as an unsigned 128-bit **little-endian** integer (SEP-41 amounts are `i128`; endianness follows the Solana port's little-endian) |
| `u64le` | 8 | unsigned 64-bit little-endian |
| `destination_hash` | 32 | `keccak256(UTF-8 bytes of destination)`. The destination is 1 to 256 bytes. Identical to EVM, TVM and SVM for the same string. |

Hash function: **keccak-256** (the original Keccak padding, as Ethereum and the Solana port use; NOT
NIST SHA3-256). In the contract it is `env.crypto().keccak256`.

## Common prefix (71 bytes)

```
"escrow"        6   ASCII
version         1   0x02
network_id     32   sha256(network passphrase)
contract_id    32   the escrow's own contract id (the 32-byte hash behind its C... strkey)
```

`network_id` is the host's `ledger().network_id()`:

| Network | Passphrase | network_id |
|---|---|---|
| testnet | `Test SDF Network ; September 2015` | `cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472` |
| public | `Public Global Stellar Network ; September 2015` | `7ac33997544e3175d266bd022439b22cdb16508c01163f26e5cb2a3e1045a979` |

Unlike the Solana port there is no configurable cluster id: the network and the deployment are read
from the ledger, so nothing has to be initialised and nothing can be mis-set. A signature cannot be
replayed on another network or against another escrow deployment.

Every digest below is `keccak256(prefix || tag || fields)`. Tags: `"deposit"`, `"reserve"`,
`"release"`, `"refund"`, `"renounce"`.

## Deposit digest (= deposit id), 320 bytes

| # | Field | Width | Type | Source |
|---|---|---|---|---|
| | prefix | 71 | | |
| | tag `"deposit"` | 7 | ASCII | |
| 1 | `deposit_request_hash` | 32 | b32 | `DepositWitness.deposit_request_hash` |
| 2 | `destination_hash` | 32 | b32 | keccak256 of `DepositWitness.destination` |
| 3 | `depositor` | 33 | addr33 | `DepositInput.depositor` |
| 4 | `token` | 33 | addr33 | `DepositInput.token` |
| 5 | `epoch` | 8 | u64le | `epoch` of the delegate record the deposit is signed under (`get_delegate`, or the value `create_delegate` returned, which `DelegateCreated`, `DelegateRevoked` and `DelegateRenounced` carry as their trailing `epoch` field): 1 for the first record of the (depositor, token), +1 for each re-creation, kept across revokes. `deposit` derives the digest from the record's current epoch, so a deposit signed before a revoke cannot be used after the same signer key is enrolled again |
| 6 | `amount` | 16 | amt16 | `DepositInput.amount`, the ceiling the depositor authorises (not the charge); signed by the delegate signer over this digest before the auction, so it commits to the ceiling, not the final charge |
| 7 | `reserver` | 32 | key32 | `DepositWitness.reserver` |
| 8 | `releaser` | 32 | key32 | `DepositWitness.releaser` |
| 9 | `nonce` | 8 | u64le | `DepositInput.nonce`, unordered, per depositor and token, never reusable |
| 10 | `issued_at` | 8 | u64le | seconds, must be <= ledger time |
| 11 | `deadline` | 8 | u64le | seconds, must be >= ledger time and <= `issued_at` + 86400 |

Total 71 + 7 + 32 + 32 + 33 + 33 + 8 + 16 + 32 + 32 + 8 + 8 + 8 = 320.

`deposit_request_hash` is defined by the off-chain protocol layer; the contract only requires it to
be non-zero. The deposit digest carries no `quote_hash`: the quote enters at the reserve witness, as
on Solana.

## Reserve digest, 191 bytes

| # | Field | Width | Type |
|---|---|---|---|
| | prefix | 71 | |
| | tag `"reserve"` | 7 | ASCII |
| 1 | `deposit_id` | 32 | b32 (the deposit digest above) |
| 2 | `quote_hash` | 32 | b32, non-zero |
| 3 | `settler` | 33 | addr33 |
| 4 | `source_amount` | 16 | amt16, the amount actually charged, `0 < source_amount <= amount` |

`source_amount` is inside the reserver's signature so the settler, who is paid, cannot choose what the
depositor is charged. The settler is named by the reserver, not the depositor.

## Release digest, 401 bytes, and refund digest, 400 bytes

Eleven members in the EVM `ReleaseWitness` / `RefundWitness` order. Release and refund differ only in
the tag, so a release signature can never validate as a refund.

| # | Field | Width | Type |
|---|---|---|---|
| | prefix | 71 | |
| | tag `"release"` (7) or `"refund"` (6) | 7 / 6 | ASCII |
| 1 | `deposit_id` | 32 | b32 |
| 2 | `quote_hash` | 32 | b32 |
| 3 | `deposit_request_hash` | 32 | b32 |
| 4 | `destination_hash` | 32 | b32 |
| 5 | `depositor` | 33 | addr33 |
| 6 | `token` | 33 | addr33 |
| 7 | `amount` | 16 | amt16, the stored amount (= the reserve `source_amount`) |
| 8 | `fee_amount` | 16 | amt16, the fee fixed at deposit |
| 9 | `reserver` | 32 | key32 |
| 10 | `releaser` | 32 | key32 |
| 11 | `settler` | 33 | addr33 |

The members after the tag total 323 bytes. The signing key is member 10, `releaser`, as on EVM.

## Renounce digest, 169 bytes

What the `delegate_signer` signs to give up its authority (`renounce_delegate`).

| # | Field | Width | Type |
|---|---|---|---|
| | prefix | 71 | |
| | tag `"renounce"` | 8 | ASCII |
| 1 | `depositor` | 33 | addr33 |
| 2 | `token` | 33 | addr33 |
| 3 | `epoch` | 8 | u64le, the `epoch` of the delegate record being renounced: 1 for the first record of the (depositor, token), +1 for each re-creation, kept across revokes |
| 4 | `nonce` | 8 | u64le, from the nonce bitmap of the depositor and token, so single-use |
| 5 | `deadline` | 8 | u64le, seconds. `renounce_delegate` refuses the call with `DeadlineExpired` once the ledger time is past it, so a signature that leaks unused stops working. The signer picks it; it is not tied to an issue time or bounded above |

## Active-deposit hash, 291 bytes (stored, not signed)

What `get_deposit_hash(deposit_id)` returns and what release and refund recompute from their witness.
No prefix and no tag: it never leaves the contract's storage.

```
keccak256( depositor addr33 || quote_hash b32 || deposit_request_hash b32 || destination_hash b32 ||
           token addr33 || amount amt16 || fee_amount amt16 || reserver key32 || releaser key32 ||
           settler addr33 )
```

Order is EVM's `ActiveDeposit` struct order. 33 + 32 + 32 + 32 + 33 + 16 + 16 + 32 + 32 + 33 = 291.

## Golden vectors

Derived out of band: the layout above was transcribed into a script and hashed with `cast keccak`
(foundry), an implementation independent of this crate and of the Soroban SDK. They are not outputs of
the code under test.

Fixture:

| Input | Value |
|---|---|
| network | testnet (`cee0302d...d472`), and public for the separation vector |
| `contract_id` | `c0` repeated 32 times |
| `depositor` | account `d1` x 32, i.e. `addr33` = `00` + `d1` x 32 |
| `token` | contract `e1` x 32, i.e. `01` + `e1` x 32 |
| `settler` | account `a5` x 32 |
| `reserver` / `releaser` | `55` x 32 / `66` x 32 |
| `deposit_request_hash` | `44` x 32 |
| `quote_hash` | `33` x 32 |
| `destination` | `eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@0xc0ffee254729296a45a3885639ac7e10f9d54979` (103 bytes; the same string Solana and EVM pin) |
| `amount` (ceiling) | 1250000 |
| `source_amount` | 1000000 |
| `fee_amount` | 200 |
| `nonce` | `0x0000000100000007` |
| `issued_at` / `deadline` | 1700000000 / 1700000128 |

| Digest | Network | keccak-256 |
|---|---|---|
| `destination_hash` | n/a | `7e096a6d1abcfc4daab28cec3f3d3a458c3facbfa0f3493284bb891bdc9807ef` |
| deposit | testnet | `d28667e7c40efa69ab7ba45db817a82044cb10840fe95a45425e7b99556f6a65` |
| deposit | public | `708f97942322b3d027730af1dc8359655b638e06cf2abbaa35f155189a64a6df` |
| deposit with the destination fed RAW (unsound; must differ) | testnet | `a27e5b952663bace502540b5a9f2d6d0ec8e414639741daa9cfdfa3b3abe7fdd` |
| reserve | testnet | `827560933bcd171fc0ac5eb23d176b7fc5f0b2e5fbb7e84fd1d10acb99fb146f` |
| release | testnet | `1e047d0a87c1ed7a0d380b2c2d89f9484ccc18b4e2e56651b7c85e21117abaa4` |
| refund | testnet | `1a4f68fa5ba5f3e57a942fd0b6260e97e64b9e399635e454a144e3cf04b8b43c` |
| active-deposit hash | n/a | `f1c27186532d82e2c3bf509335bcac128d234e8c3537188e9b13681cf8b710e6` |

Delegate signatures use seed `77` x 32 (ed25519 is deterministic, so these are exact), public key
`c853ad0f0cd2b619aea92ceec4fd56a24d6499d584ce79257e45cfd8139b60a7`, derived with Python's
`cryptography` package:

| What | Value |
|---|---|
| renounce digest (testnet, epoch 1, nonce 900, deadline 1700000128, same depositor and token) | `99e54f1290c5bd5d79f2d9c502ea157fbbfa2745776cef4be1f82c4643c43589` |
| signature over the testnet deposit digest | `ec48e2d9cc0bff07e1d6c5fb9820fd8cc7a269fe3d3cc752afd46809472076d45327cc4482b64e91990cde344c545a667304692261d9fa526eddf8e6cd12fe0b` |
| signature over the renounce digest | `3b49fc8c1bd76acedb29ae5896f01384e364d3cd6d112ac06f431cefe7b66aa04a9def71623f490e8fbc070eff05b79c621254298e561291372b6202e232bf06` |

The deposit digest is signed by the delegate signer, not the depositor, and carries the delegate epoch
(layout version 2); `epoch` = 1 in the vectors above.

Reserve, release and refund use the testnet deposit digest as `deposit_id`, and `amount` = 1000000
(the `source_amount`) in the release and refund witness.

## Checks the encoders must mirror

The contract enforces these in `deposit`; an encoder that produces a witness violating them yields a
transaction that reverts:

- `reserver`, `releaser`, `deposit_request_hash`, `quote_hash` are not all-zero.
- `reserve_witness.settler` is not the escrow's own address (`SettlerCannotBeSelf`): a release to the
  escrow would be a self-transfer and strand the payout.
- `destination` is 1 to 256 bytes.
- `0 < source_amount <= amount`.
- `issued_at <= deadline`, `deadline >= ledger time`, `issued_at <= ledger time`,
  `deadline - issued_at <= 86400`. Take `issued_at` from the latest closed ledger's close time, not the
  local clock.
- `reserve_witness.deposit_id` equals the digest the contract derives.
- `(reserver, quote_hash)` has not been used by an earlier deposit, live or completed
  (`QuoteAlreadyUsed`). A retry after a refund needs a new quote hash.
- A delegate record exists for (depositor, token), is unexpired (`ledger time < expiration`), and the
  charged `source_amount` is within its per-transfer max and remaining capacity.
- The delegate signature verifies and the depositor's SEP-41 allowance to the escrow covers
  `source_amount`.

## Not covered by the hash anchors

- The Soroban authorization entry for `create_delegate` and the SEP-41 `approve` transaction
  (depositor): built by the Stellar SDK, not escrow digests.
- The XDR shape of the contract call arguments (`DepositInput`, `ReleaseWitness`, `RefundWitness`):
  the contract spec is the authority; field names there are snake_case versions of the names above.
