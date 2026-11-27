# PaymentRequest Schema v1

## Overview

The `PaymentRequest` schema defines the structure for payment requests in the
Atum payment network. It is the request body for the Payment Gateway API's
`POST /v1/payments` endpoint, used to describe and authorize a payment and to
validate the request.

## Purpose

This schema is a **declaration** type in the Atum schema system — a
purpose-specific business object describing a payment the originator wants
settled. It encapsulates:

- **Payment details**: source and destination assets, the amount to fulfill, and
  timing constraints (`quote_deadline`, `fulfillment_deadline`).
- **Sender authorization**: signed message(s) that authorize the on-chain
  transfer of the sender's assets.
- **Settler selection policy**: optional requirements and allow/deny lists that
  constrain which settlers may participate.
- **Originator authentication**: optional identity verification for the request
  originator.

## Schema Structure

### Required Fields

- **`version`**: Declaration version (`MAJOR.MINOR`); producers emit the value
  exported by the bindings' version constant.
- **`request_id`**: Unique identifier for this payment request (used for idempotency).
- **`source`**: The source asset and the account that owns it — a single
  `OwnedAsset` object.
- **`destination`**: One or more destination assets — an array of `OwnedAsset` holding between 1 and 16 entries.
- **`fulfillment_amount`**: The exact amount to be fulfilled, in the smallest unit.
- **`sender_auth`**: Authorization from the asset owner to execute the payment.
- **`fulfillment_verifier`**: Service that verifies delivery before the escrow
  releases. Take it from the gateway's `/v1/defaults`.
- **`escrow_contract_address`**: Escrow contract on the source chain. Take it from
  the gateway's `/v1/defaults`.
- **`quote_deadline`**: Deadline for accepting new quotes.
- **`fulfillment_deadline`**: The time by which the payout must be mined on the
  destination chain. It does not have to be final by then.

### Optional Fields

- **`max_source_amount`**: Maximum amount willing to be spent from the source.
- **`settler_auth_required`**: Policy requirements for settler authentication.
- **`settler_requirements`**: Optional settler `whitelist` / `blacklist` (DIDs).
- **`quote_selector`**: The account that picks the settler and signs the reserve. When set, it must be
  the reserver that the payer's signed authorization names.
- **`deposit_nonce`**: The nonce the payer passed to `directDeposit`, as a decimal uint256. Only on
  an originator-executed deposit, where it is required (see
  [Originator-executed deposits](#originator-executed-deposits)).
- **`fulfillment_proxy`**: Advanced routing override.
- **`originator_auth`**: Verifiable Credential authentication for the originator
  (recommended for KYC/compliance).
- **`@context`**, **`proof`**, **`verifiableCredential`**: Optional W3C Data
  Integrity / Verifiable Credential fields for document-level signing and
  identity attestation.

## Key Components

### OwnedAsset

Identifies an asset and the wallet that holds it:

- **`asset_identifier`**: CAIP-19 asset identifier (see below).
- **`account`**: The owning wallet address (format depends on the chain; on Stellar a `G...`
  account or `C...` contract strkey).

### SenderAuth

Authorization from the asset owner to execute the payment; the exact format
depends on the source chain's authorization mechanism:

- **`message_scheme`**: Authorization method — one of `EVM_PERMIT2`,
  `EVM_PERMIT2_ESCROW`, `SOLANA`, `TRON`, `STELLAR`.
- **`signed_messages`**: Array of signed messages (at least one required). Each
  message carries:
  - **`message`**: The signed data, hex-encoded with a 0x prefix. For the deposit it is
    the hash of `message_prehash`.
  - **`message_prehash`**: The original data that `message` is the hash of.
  - **`signature`**: Cryptographic signature authorizing the transfer.
  - **`payload`**: Optional chain-specific signing context.
- **`verifiable_credential`**: Optional additional identity verification for the sender.

### VerifiableCredentialAuth

W3C standards-compliant identity authentication for the originator:

- **`verifiable_credential`**: VC issued by a trusted KYC/KYB provider.
- **`verification_method_id`**: Reference to the signing key in the DID document.
- **`signature`**: Cryptographic proof of credential ownership.

### DataIntegrityProof

W3C Data Integrity proof for optional document-level signing — when present,
attests that the document was emitted by the signer in `verificationMethod`.

## Usage Flow

1. **Collect authorization**: Have the sender sign the required message(s) with
   their wallet to produce `sender_auth`.
2. **Submit request**: Submit the `PaymentRequest` with the payment details and
   the sender's authorization.

## CAIP-19 Asset Identifiers

All assets use [CAIP-19](https://github.com/ChainAgnostic/CAIPs/blob/master/CAIPs/caip-19.md) format:

- **Ethereum USDC**: `eip155:1/erc20:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
- **Solana USDC**: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- **Native ETH**: `eip155:1/slip44:60`

Copy `example.json`, not a fixture. The fixtures under `conformance/fixtures/` use
asset identifiers the payment gateway client will not build (`eip155:1/erc20:0xbbb`,
and a token address with an invalid EIP-55 checksum); they stay as they are because their
signatures and `conformance/request-hash-golden.json` cover those exact bytes.

## Validation Rules

### Array Constraints
- `source` is a single object; `destination` is an array with at least one item and at most 16.
- `sender_auth.signed_messages` contains at least one item.
- `settler_requirements.whitelist` / `blacklist`, when present, contain unique DIDs.

### Format Requirements
- `version` matches `^1\.[0-9]+$`.
- `fulfillment_amount` is a non-empty, non-negative integer string (`^[0-9]+$`).
  `max_source_amount`, when present, is an amount string (smallest unit; no
  pattern enforced).
- All timestamps use ISO 8601 (`date-time`) format.
- `asset_identifier` follows the CAIP-19 pattern; `account` is a non-empty string.
- Settler DIDs follow the W3C DID format.

## Security Considerations

1. **Signature verification**: `sender_auth` signatures must be cryptographically
   verified before the transfer is executed.
2. **Idempotency / replay**: `request_id` provides idempotency and prevents
   duplicate processing of the same request.
3. **Credential validation**: when `originator_auth` or document-level proofs are
   present, verifiable credentials must be validated against issuer DIDs.

## Destination commitment

A `PaymentRequest` names the payee twice. The unsigned copy is `destination[0]` and
`request_id`. The signed copy is inside the deposit in `sender_auth.signed_messages[0]`: its
`destination` and its request hash (`depositRequestHash` on EVM and Tron,
`deposit_request_hash` on Solana). Only the signed copy is protected by the payer's signature,
so a verifier must confirm the two copies agree before acting on a payment.

The sender-auth library performs this check in Go (`senderauth`) and TypeScript
(`@atum-labs/payment-request-sender-auth`). Both return identical results, pinned by
`conformance/commitment-vectors.json` and, for the bid-time entry point below,
`conformance/required-commitment-vectors.json`.

| Entry point | Use it when |
|---|---|
| `VerifyRequestCommitment` / `verifyRequestCommitment` | You hold the request as received (bytes, or a string in TypeScript). Preferred. |
| `VerifyPaymentRequestJSON` / `verifyPaymentRequestJSON` | As above, and you also want every signature recovered and bound to your terms. Key-account payers only. |
| `VerifyCommitment` / `verifyCommitment` | Deprecated. You have already parsed the request. It sees only the values you extracted, accepts v2 only if you derive it, and refuses any v2 mode, `retire` included, as `verifier_misconfigured`. |
| `CompareCommitment` / `compareCommitment` | Deprecated. The signed values come from your own deposit builder. |
| `RequiredCommitmentOf` / `requiredCommitmentOf` | You quote or bid, before a deposit exists, whether or not the request is signed yet. With a `message_prehash` it runs the full check; without one it only returns what a deposit must commit. Never the gate on a deposit. |
| `VerifyQuoteRequestBinding` / `verifyQuoteRequestBinding` | You store a payment request and receive a settler's quote for it. Always strict; see depositRequestHash v1 and v2 below. |

`RequiredCommitmentOf` / `requiredCommitmentOf` return the commitment any deposit for the
request must carry: the source namespace, the destination and the depositRequestHash. They read
the request as `VerifyRequestCommitment` does (rule 1). If `signed_messages[0]` carries a
`message_prehash`, even a blank one, they then run every rule below exactly as
`VerifyRequestCommitment` does, with the Solana domain and Tron chain ids you pass, and refuse
with its outcome and detail; on success they return the commitment it compared. As rule 9 says,
on EVM and Tron that check binds the prehash to the signed message but verifies no signature; on
Solana it verifies it.
Otherwise no signed commitment can be read (`sender_auth` or `signed_messages` is absent, or
`signed_messages[0]` has no `message_prehash`, absent or null), and they apply only the request's
side of the rules: the supported source chain of rule 3 and the
request halves of rules 7 and 8, with the same outcomes and details. That path reads no Solana
domain, does not require `sender_auth`, never compares `message_scheme` and verifies no
signature. It is not verification: it refuses only requests no deposit could satisfy, and a signed
request whose `message_prehash`, or whole `sender_auth`, was removed takes it with whatever payee
the request names. Once the deposit is signed into the request, judge it with
`VerifyRequestCommitment` / `verifyRequestCommitment` on the request as received.

`VerifyPaymentRequest` / `verifyPaymentRequest` run the same check on a parsed request, which
cannot show repeated member names, and accept only depositRequestHash v1. They are deprecated: use
`VerifyPaymentRequestJSON` / `verifyPaymentRequestJSON` with the request as received. `RecoverAndVerify` / `recoverAndVerify` check one
signed message and also require its commitment to match; the result is returned as
`Commitment` / `commitment`, and a refusal carries it. Both recover the signer, so they refuse a
contract-account payer (ERC-1271, such as a Safe); verify such a payment with
`VerifyRequestCommitment` / `verifyRequestCommitment`, and its signature with
`VerifyDepositorSignature` / `verifyDepositorSignature` (see Depositor signature below).

### Rules

Checked in this order; the first failure is the result.

1. The request is one JSON document with no repeated member names, including names that differ
   only in letter case, among its top-level members and inside the members the check reads
   (`source`, `destination`, `request_id`, `sender_auth`), and every field the check reads has its
   schema type (`VerifyRequestCommitment` and `RequiredCommitmentOf` only).
2. `sender_auth.signed_messages` has an entry. `signed_messages[0]` is the deposit; no other
   entry is examined.
3. The namespace of `source.asset_identifier` selects the rules, and `message_scheme` must be
   one it permits: `eip155` permits `EVM_PERMIT2` and `EVM_PERMIT2_ESCROW`; `tron` permits
   those and `TRON`; `solana` permits `SOLANA`; `stellar` permits `STELLAR`. The source chain must be
   supported: a canonical `eip155:<id>`, any `solana:<cluster>`, a `tron:<cluster>` whose TIP-712
   chain id is known, or `stellar:pubnet`, `stellar:testnet`, `stellar:futurenet` or
   `stellar:standalone`.
   The library knows `tron:mainnet` and `tron:shasta`. For any other Tron cluster, such as a
   local node's, the verifier may supply the id from its own configuration
   (`WithTronChainIDs` / `tronChainIds`); only the entry for the source's own cluster is read, and
   none is read for another namespace. The built-in ids stay authoritative: an entry for
   `mainnet` or `shasta` must repeat the built-in id, an entry for any other cluster must not
   repeat a built-in id (the chain id is all that tells one Tron network's signature domain from
   another's, so a repeated id would make that cluster an alias of the built-in network), and an
   entry must be an integer from 1 to 4294967295 (TIP712.sol refuses a larger chain id), or the
   payment is refused as `verifier_misconfigured`. Any other cluster, including `nile`, becomes
   verifiable once the verifier supplies its id. The source chain is checked before
   `message_scheme`.
4. Solana: the escrow's signature domain (program id, cluster, domain version 4 or later) comes
   from the verifier's configuration, never from the payment. Stellar: the escrow contract (a `C...`
   strkey) comes from the verifier's configuration (`WithStellarEscrow` / `stellarEscrow`, or the
   `EscrowContract` / `escrowContract` of the expectations), and the network id from the payment's
   own `stellar:<reference>` source chain.
5. The deposit carries a `message_prehash` that is one JSON document with no repeated member
   names. On Solana and Stellar, no member may be spelled two ways (`issued_at` and `issuedAt`).
6. The prehash commits a destination and a request hash, the hash as 32 bytes of hex.
7. The request has exactly one destination, and the signed destination equals
   `BuildEscrowDestination(destination[0].asset_identifier, destination[0].account)` byte for
   byte. Both parts must be printable ASCII.
8. The signed request hash equals `keccak256(request_id)` (depositRequestHash v1), and
   `request_id` is not empty. Once the check is opted into v2 (see depositRequestHash v1 and v2
   below), it may instead equal the request's depositRequestHash v2.
9. The prehash is exactly the canonical deposit (Permit2 typed data on EVM and Tron, the escrow
   deposit record on Solana) and hashes to `signed_messages[0].message`. On Solana the ed25519
   signature must also verify against `source.account` as the program's strict check does (a
   canonical `S`, and neither the key nor `R` a point of small order); a `delegate_signer`, when
   present, must equal it, and a separately approved delegate signer is not supported. On EVM and
   Tron, Permit2 checks the signature on chain, for key accounts and for contract accounts
   (ERC-1271, such as a Safe) whose signature comes from an owner key; `RecoverAndVerify` also
   checks it off chain, for key accounts only. On Stellar the payer's delegate signer signs the escrow's deposit digest with
   ed25519, checked as the Soroban host checks it (`verify_strict`: a canonical `S`, and neither the
   key nor `R` a point of small order), and `payload.delegate_signer` (a `G...` strkey) is required:
   the signature must verify against it, the record's `depositor` must be `source.account`, the
   delegate signer must be `source.account` too (the payer's own key registered as its own delegate;
   a signature that verifies under any other key is refused as `ErrDelegateUnverified`, in
   TypeScript `DelegateUnverifiedError`, after every other check has held, by both `RecoverSigner`
   and `RecoverAndVerify`), and `depositor` and `token` must be `G...` or `C...` strkeys (a muxed `M...` or `W...` address is
   refused). The record also carries the `epoch` of the delegate record the deposit is signed under
   (`get_delegate(depositor, token).epoch`, a decimal integer from 1 to 2^64-1): the digest commits
   to it (signature domain version 2), so a deposit signed under one record is void under a later
   one, and a builder must be given the current epoch rather than guess it. The window must satisfy
   `issued_at < deadline <= issued_at + 86400`, as the contract requires. **A verified Stellar result
   does not prove the payer consented.** `payload.delegate_signer` is supplied by the requester, so a
   payer whose delegate is a separate key is refused: a pass would prove only that some key signed.
   A payer whose own key signs is admitted, but whether that key is registered for the depositor and
   token (`create_delegate`, plus the depositor's SEP-41 `approve`) is on-chain state no offline check
   reads, and is not established by `recoveredAccount`. The verified permit therefore carries `delegateSigner`, `delegateEpoch` and the marker
   `delegateOnchainUnverified: true` (`DelegateSigner`, `DelegateEpoch`, `DelegateOnchainUnverified`
   in Go). The gateway applies only this offline verdict and reads no chain; the party that does
   (veri-fill, or the settler before it deposits) compares `delegateSigner` and `delegateEpoch` with
   the escrow's `get_delegate` for (depositor, token) before the payment is treated as consented. The
   marker is set on every Stellar permit, so it says no more than the scheme and does not enforce the
   check. On Stellar the
   verifier must also be given the expected reserver and releaser, and refuses as
   `verifier_misconfigured` when either is absent: deliberately stricter than EVM and Solana, where
   omitting them skips the check, because both are free members of the signed record.

### Outcomes

Only `verified` admits a payment.

| Outcome | Meaning |
|---|---|
| `verified` | The deposit commits to this payment's destination and request id. |
| `scheme_mismatch` | Unsupported source chain, or a `message_scheme` the chain does not permit. |
| `commitment_absent` | No signed deposit, no prehash, a deposit that commits no destination or request hash, or a Solana domain below version 4. |
| `prehash_mismatch` | The prehash is ambiguous or not canonical, or does not hash to the signed message. |
| `signer_mismatch` | The deposit is not signed by, or not made out to, the payment's `source.account`. The payee check reports it on Solana; `RecoverAndVerify` reports it on every chain. |
| `destination_mismatch` | The payer signed a different payee, or the request does not name exactly one valid destination. |
| `request_hash_mismatch` | The payer signed a different request id, or the request id is empty. Opted into v2: the signed hash is neither the request's v1 nor its v2. In `retire` mode: the signed hash is the request's v1, which `retire` no longer accepts. |
| `request_malformed` | The request is unreadable, has repeated member names where the check reads (rule 1), or has a field of the wrong type. In `enforce` and `retire` mode, also a request the strict reader refuses. |
| `quote_request_mismatch` | `VerifyQuoteRequestBinding` only: the quote's `payment_request_json` does not commit the same terms as the stored payment request. |
| `verifier_misconfigured` | The verifier did not supply a valid Solana escrow domain or Stellar escrow contract, or supplied a Tron chain id that is out of range, contradicts the built-in one, or repeats a built-in id under another cluster (rule 3). Or it set a depositRequestHash v2 mode the entry point does not read. |

### What the commitment does not cover

The deposit signs the payee, the request hash, the reserver and releaser, and the source-side
amount cap and deadline. A v1 request hash covers only `request_id`, so a v1 deposit signs nothing
else in the request, including `fulfillment_amount`, `fulfillment_deadline`, `quote_deadline`,
`fulfillment_proxy`, `fulfillment_verifier` and `executor`. A v2 request hash covers every member
its preimage lists below. Neither covers `settler_requirements`, `settler_auth_required`,
`sender_auth`, `originator_auth`, `presentation`, `proof` or `@context`. A verifier that acts on
any member the deposit does not sign must check it against terms it trusts, such as its own quote
or the merchant's configuration, or take it from the stored payment, and not from the request
alone.

### Logging

The library does not log. Every commitment check yields a `CommitmentResult`, admissions included. Go
returns it together with a `*CommitmentError` on refusal; TypeScript returns it when verified and
otherwise throws a `CommitmentError` whose `result` carries it. `RequiredCommitmentOf` /
`requiredCommitmentOf` return the required commitment instead when they accept; their refusals
carry a result like any other. From any entry point,
`CommitmentResultOf(err)` / `commitmentResultOf(error)` reads the result a refusal carries,
including an unreadable prehash (`ErrMalformedPrehash` / `MalformedPrehashError`).
`RecoverAndVerify` checks the token, amount, freshness and roles before the commitment; those
refusals carry no result, so count them separately. `LogFields()` (Go) and
`commitmentLogFields()` (TypeScript) give the same keys in both languages. Count every call by
`sender_auth_result`, and log refusals with all fields. A check opted into v2 adds
`deposit_request_hash_version` (`v1` or `v2`, the label of the `deposit_request_hash.match`
metric), `request_deposit_request_hash_v2` and, in `audit` mode, `strict_detail`; an unopted check
logs exactly the keys it did before.

```go
result, err := senderauth.VerifyRequestCommitment(body, solanaDomain)
metrics.Count("sender_auth_commitment", result.LogFields()["sender_auth_result"])
if err != nil {
	logger.Error("payment refused", "commitment", result.LogFields())
	return err
}
```

Build the deposit you execute from `signed_messages[0]`, the message this check verified.

## depositRequestHash v1 and v2

The request hash a deposit commits comes in two versions. The escrow treats either as an opaque
non-zero 32 bytes, so both settle the same way. They differ in what the payer's signature covers.

- **v1** is `keccak256(request_id)`. It pins the request id and nothing else.
- **v2** is `keccak256` of a preimage of the payment terms, so the signature also covers the
  amounts, the deadlines, the executor and the corridor addresses. It excludes `sender_auth`, so
  it does not change when the request is signed.

### The v2 preimage

A *field* is its UTF-8 byte length as a big-endian uint32, followed by the bytes. An *optional
field* is the byte `0x00` when the member is absent or null, or `0x01` followed by the field. The
preimage is, in order:

1. The byte `0xFF`, then the field `atum:deposit-request:v2`. `0xFF` never occurs in UTF-8, so no
   v1 value can equal a v2 value.
2. `request_id`, which must match `^[A-Za-z0-9._-]{1,128}$`.
3. `source.asset_identifier`, then `source.account`, verbatim.
4. The destination. The request must have exactly one leg, hashed as the field
   `BuildEscrowDestination(asset_identifier, account)`.
5. `fulfillment_amount`, then the optional field `max_source_amount`. Each must match `^[0-9]+$`,
   must not exceed the uint256 maximum, and is hashed with leading zeros stripped (`0` for zero).
6. `quote_deadline`, then `fulfillment_deadline`, each as the big-endian uint64 of its Unix
   seconds, with no length prefix. Each must match
   `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$` with a real calendar date,
   hour 00-23, minute and second 00-59 and offset 00:00-23:59, and `-00:00` is refused. The instant
   is converted to UTC and floored to whole seconds.
7. `executor`, as three bytes for the deposit, reserve and fulfill legs: `0x00` for `settler`, `0x01`
   for `originator`. Absent and null are `settler` on every leg, a string applies to every leg, and
   an object must name all three.
8. The optional field `fulfillment_proxy`, the field `escrow_contract_address`, the optional field
   `quote_selector`, then `fulfillment_verifier.account` and `fulfillment_verifier.endpoint` as two
   fields. An empty string is present, not absent.

A lone UTF-16 surrogate in a hashed string is hashed as U+FFFD, as a Go reader decodes it.
`conformance/deposit-request-hash-v2-vectors.json` pins the preimage and the hash, the refusals
and the re-encodes that must keep v2 unchanged (a typed decode and re-encode, the settler's JSON
canonicalization, a Postgres JSONB round-trip).

### The strict reader

`ReadDepositRequest` / `readDepositRequest` read a request as received and return the terms v2
commits, with their v2 hash and the v1 hash. They refuse what the preimage cannot hash, and also:
repeated member names, including names that differ only in letter case, except inside
`sender_auth`, `presentation` and `verifiableCredential`; any member name that is not a
PaymentRequest property at its position, except inside the subtrees v2 never hashes
(`presentation`, `proof`, `verifiableCredential`, `originator_auth`, `sender_auth` and
`settler_auth_required`); a `version` not matching `^1\.[0-9]+$`;
and any `@`-member other than a top-level `@context` that is exactly the PaymentRequest context
list. Act on the terms it returns, never on another decode of the same bytes.

`deposit_nonce` is read and returned (`DepositNonce` / `depositNonce`) but never hashed: v1 and v2
of a request are the same with or without it, and the deposit id binds it instead. The reader
refuses it on any request whose deposit leg is not the originator's, as it did before the schema
had it.

Every top-level member name is checked, so a twin of `sender_auth` or `verifiableCredential` itself
is refused. Inside `sender_auth`, `presentation` and `verifiableCredential` the reader acts on
nothing, so a repeated name there is left to the code that reads it: the commitment check scans
`sender_auth` (rule 1), and `VerifyVP` and `VerifyVCProof` scan a presentation and its credentials.
The other subtrees v2 never hashes, `proof`, `originator_auth` and `settler_auth_required`, are
scanned by the strict reader, because the code that reads them does not scan them. Like any other
strict reader refusal, a twin there is only reported while the commitment check runs in audit, so
an ingress that refuses twins across the whole body keeps that scan until it enforces.

### Reading v2: off, audit, enforce and retire

The commitment checks read v2 only when asked, so a dependency upgrade alone changes nothing:

| Mode | Go `WithDepositRequestHashV2` / TS `depositRequestHashV2Mode` | Behaviour |
|---|---|---|
| off | absent, `""` or `null` | v1 only, exactly as before v2. |
| audit | `DepositRequestHashV2Audit` / `'audit'` | v1 or v2. A request the strict reader refuses is read as before v2 (v1 only) and the refusal is reported in `StrictDetail` / `strictDetail`. |
| enforce | `DepositRequestHashV2Enforce` / `'enforce'` | v1 or v2. A request the strict reader refuses is refused as `request_malformed`, before the destination is compared. |
| retire | `DepositRequestHashV2Retire` / `'retire'` | v2 only: enforce, with a deposit that commits v1 refused as `request_hash_mismatch`. `VerifyRequestCommitment` and `RequiredCommitmentOf` only. |

The option applies to `VerifyRequestCommitment` and `RequiredCommitmentOf`, and, as the
`DepositRequestHashV2Mode` member of its expectations, to `VerifyPaymentRequestJSON`, which then
returns the commitment result as `VerifyResult.Commitment` / `commitment`; it does not read
`retire`, and refuses it. Opted in, a result names the version the deposit matched in
`DepositRequestHashVersion` / `depositRequestHashVersion`, and `RequiredCommitmentOf` returns both
candidates, `DepositRequestHash` (v1) and `DepositRequestHashV2`. Any other mode is
`verifier_misconfigured`. The deprecated typed `VerifyPaymentRequest` refuses any mode.
`conformance/commitment-v2-vectors.json` pins `VerifyRequestCommitment`, `RequiredCommitmentOf` and
`VerifyPaymentRequestJSON` in each mode, with two unknown modes and with `null`, which Go decodes as
off and TypeScript reads as off too.

### Retiring v1

Once every producer signs v2, a verifier retires v1 with the `retire` mode:

- `VerifyRequestCommitment` admits only a deposit matched as v2. A deposit committing v1 is refused
  as `request_hash_mismatch`. A request the strict reader refuses is refused as `request_malformed`,
  as in enforce, since it has no v2 a deposit could commit.
- `RequiredCommitmentOf` names only v2: `DepositRequestHash` is the v2 too, so a consumer that admits
  either hash admits only v2.

### Producing a v2 deposit

Build the final request body first, with the defaults, deadlines and executor all fixed, and pass
it to the deposit builder as `BuildParams.PaymentRequestJSON` / `paymentRequestJSON`, with
`DepositRequestHashVersion` / `depositRequestHashVersion` set to `2`. Then add `sender_auth` and
post that body unchanged. The builder reads the body with the strict reader whatever version it
signs, takes the request id and destination it commits from that reading, and refuses a body the
reader refuses. Version 1 stays the default output. `RequestID` / `requestId` and the destination
params are deprecated; when set next to the body, they must agree with it. So must the params that
still drive the permit, where the body commits them: the source asset, the depositor, the max
source amount, and the escrow, quote selector and fulfillment verifier defaults. Addresses are
compared as the source chain spells them, so a Tron role given in base58 agrees with its hex
spelling in the body. Which version to sign
comes from the payee: the payment gateway's `/v1/defaults` (`deposit_request_hash_versions`, or
`deposit_request_hash_version` from a gateway that predates it, both read by TS
`depositRequestHashVersionsOf`) or an x402 or MPP challenge (`depositRequestHashVersions`). Sign v2
when the list has 2.

A v2 deposit signs `quote_deadline`, so stamp a quote window that covers the signing as well as the
auction. Keep it short: the auction runs until the deadline, and settlers decline a quote whose
deadline is too far past the moment they bid. The TS SDK's `DEFAULT_PAYMENT_QUOTE_DEADLINE_SECONDS`
is a good default for a signer that answers at once; pass a longer window for one that waits on a
person.

Whichever version its deposit signs, a client may also send the body's v2 in
`X-Atum-Deposit-Request-Hash-V2` and its name in `X-Atum-Producer` (TS `depositRequestHashShadowOf`),
so the gateway can check the client computes v2 the same way it does. Neither header changes the
payment.

### Binding a quote to its request

A settler's quote embeds its own copy of the payment request (`payment_request_json`). Before acting
on a quote, `VerifyQuoteRequestBinding` / `verifyQuoteRequestBinding` reads that copy and the stored
request with the strict reader and requires the same v2, or refuses with `quote_request_mismatch`. It
is always strict and returns the stored request's terms; act on those, never on the quote's copy. It
holds for a v1-signed payment too, because neither copy's v2 includes `sender_auth`.

Because it is always strict, a stored request the strict reader refuses can never be quoted, for
example one whose `request_id` is outside the strict reader's pattern. Where requests are admitted
by a reader in `audit`, such a request is admitted but every quote for it is refused, so it expires
with nothing moved, and the audit result reports it in `StrictDetail` / `strictDetail`. That is the
cost of binding quotes from the first release, on v1 and v2 payments alike, rather than once ingress
enforces: until a quote is bound, a settler acts on its own copy of the terms.

## Depositor signature

On EVM and Tron the commitment check verifies no signature: Permit2 does, on chain. To know
before the deposit whether Permit2 will accept `signed_messages[0].signature` for
`source.account`, use `VerifyDepositorSignature` (Go) or `verifyDepositorSignature`
(TypeScript). They apply Permit2's own rule, `SignatureVerification.verify`, which the Tron port
copies line for line:

1. The signature recovers to the account with Permit2's spelling: 65 bytes `r || s || v` with
   `v` 27 or 28, or the 64-byte EIP-2098 form. High-s is accepted; `v` 0 or 1 is not. This is
   `RecoverPermit2EOA` / `recoverPermit2EOA`, and it reads nothing.
2. Otherwise the account's code is read. With none, Permit2 refuses: `signer_mismatch`.
3. With code, including an EIP-7702 delegation designator, the account's `isValidSignature`
   (ERC-1271) is called from the chain's Permit2, since a contract may answer only callers it
   trusts. The magic value `0x1626ba7e` is valid; a revert or any other answer is
   `contract_signature_rejected`. The signature is passed through whole, of any length up to
   65536 characters with the `0x` (32767 bytes).

The chain reads go through a checker you supply (`HasCode`, `IsValidSignatureFrom`); the library
itself reads no chain. `signer_mismatch`, `contract_signature_rejected` and `malformed` are
refusals. `malformed` (an account, digest or signature that cannot be read, or a longer signature)
is a refusal because it breaks this schema's own spelling or the length bound, and is the
submitter's alone: admitting it would let a respelled or padded signature skip the check. A read
that fails is `signature_unverifiable`, which is not a refusal, and a checker must report a revert
as the contract's answer, not as a failed read. Without a checker the result is the offline
answer: valid when the account's key signed, otherwise unverifiable. Rule 1 runs before any read,
so one case differs from Permit2: an EIP-7702 account signing with its own key is valid here,
while Permit2 asks its delegate. The verdict describes the latest block and must not be cached;
Permit2 stays the authority.

`RecoverSigner` / `recoverSigner` are unchanged and are not this rule: they refuse every contract
account, require low-s, and accept `v` 0 or 1. Both implementations return identical results,
pinned by `conformance/depositor-signature-vectors.json`, which runs them against the same fake
checker and also pins every call they make to it.

## Reserve signature

A deposit that pays a chosen quote carries a second signature: the reserver that the deposit
witness names signs the escrow's reserve witness `{depositId, quoteHash, settler, sourceAmount}`,
naming the quote's settler and amount. Its permit must authorize exactly the quote's
`source_amount`: set `QuoteSourceAmount` / `quoteSourceAmount` in place of the max source amount.

To build the reserve, `buildReserveMessage` (TypeScript) takes the network, the escrow, the deposit
id, and the quote's hash, settler and source amount, and returns the `message` and
`message_prehash` the reserver signs. On EVM and Tron the prehash is the reserve typed data, so any
`SenderSigner`, including `localKeySigner`, signs it as it signs a permit. On Tron the addresses may
be base58 or 41-prefixed hex, and a local node's chain id comes from `tronChainIds`. On Solana the
message is the escrow's reserve hash, which the signer signs as bytes, and the prehash is the
reserve record `{deposit_hash, recipient, quote_hash, source_amount}`; the escrow's signature
domain comes from `svmSignatureClusterId` and `svmSignatureDomainVersion`, which must be 5 or later,
and the amount must fit in a u64. Input the escrow could never accept throws before anything is
signed.

To know before the deposit whether the escrow will accept the reserve signature, use
`VerifyReserveAuth` (Go) or `verifyReserveAuth` (TypeScript), with expectations taken from your own
records: the network, the escrow, the deposit id, the quote's hash, settler and source amount, and
the reserver from the verified deposit witness. They apply the escrow's own rule; on EVM and Tron
that is OpenZeppelin's `SignatureChecker.isValidSignatureNow`:

1. On EVM and Tron, `message_prehash` must be the reserve typed data for that escrow and chain,
   naming the expected values. A member that differs is refused with its own reason
   (`domain_mismatch`, `deposit_id_mismatch`, `quote_hash_mismatch`, `settler_mismatch`,
   `source_amount_mismatch`).
2. `message` must be the digest rebuilt from the expected values (`message_mismatch`).
3. The signature recovers to the reserver: exactly 65 bytes `r || s || v`, `v` 27 or 28, low-s.
   This is stricter than Permit2: the 64-byte form and high-s are refused.
4. Otherwise the reserver's code is read. With none: `signer_mismatch`. With code, its
   `isValidSignature` is called from the escrow, which is the contract that asks on chain.

The typed data's `domain.chainId` is 0x-prefixed hex without leading zeros, masked to 32 bits on
Tron, and `domain.salt`, if present, is empty. Step 3 runs before any read, so one case differs
from the escrow: an EIP-7702 account that signs with its own key is valid here, while the escrow
asks its delegate's `isValidSignature`. A contract's answer describes the block it was read at,
and the escrow asks again at deposit, so the escrow stays the authority.

On Solana the program checks the reserver's ed25519 signature over its reserve hash, which binds
the same four values from signature domain version 5. Supply the program id as the escrow and the
escrow's signature domain (`SvmSignatureClusterID` / `svmSignatureClusterId` and
`SvmSignatureDomainVersion` / `svmSignatureDomainVersion`). `message` must be the reserve hash
rebuilt from the expected values, and the signature must verify against the reserver's key as the
program's strict check does: a canonical `S`, and neither the key nor the signature's `R` a point of
small order. `message_prehash` is required: it is the reserve record
`{deposit_hash, recipient, quote_hash, source_amount}`, hashes as 0x-prefixed hex, the recipient in
base58 and the amount as a decimal string, and each member must name the expected value.

On Stellar the escrow checks the reserver's ed25519 signature over its reserve digest, the keccak-256
of the escrow's domain, the tag `"reserve"`, the deposit id, the quote hash, the settler and the
amount charged (`contracts/stellar/source/docs/witness-layouts.md`). `buildReserveMessage` returns that
digest as `message` and the record `{deposit_id, quote_hash, settler, source_amount}` as
`message_prehash`: the hashes as 0x-prefixed hex, the settler as a `G...` or `C...` strkey and the
amount as a decimal string. The domain comes from the network (`stellar:testnet`, `stellar:pubnet`)
and the escrow's `C...` contract id. The reserver is a raw ed25519 key, so the quote selector must be
a `G...` account. The deposit id is the deposit digest the delegate signer signs, so the reserve can be
signed before or after the deposit. `verifyReserveAuth` and `VerifyReserveAuth` do not read Stellar
reserves yet.

On EVM and Tron, the checker is the one the depositor signature uses, and the results follow the same rules:
`signature_unverifiable` is a failed read, not a refusal, and the verdict must not be cached.
`verifier_misconfigured` and `unsupported_chain` describe the expectations, not the signature.
Both implementations return identical results, pinned by `conformance/reserve-auth-vectors.json`.

## Originator fulfill and EIP-3009 destinations

When `executor` gives the fulfill leg to the originator (an object whose `fulfill` is
`"originator"`), the delivery is authorized with an EIP-3009 `transferWithAuthorization` signed on
the destination token. A destination without EIP-3009 cannot be fulfilled that way. The string
`"originator"` gives every leg to the originator, deposit and reserve included, and an
originator-executed deposit is reserved by the settler, so `Validate` refuses the string form, as
it does the all-originator object (see [Originator-executed deposits](#originator-executed-deposits)).

[`eip3009-tokens.json`](./eip3009-tokens.json) lists the tokens that qualify, by CAIP-2 chain.
Gateways, settlers and clients read this one list:

- Go: `SupportsEIP3009(chain, address)`, `EIP3009Tokens()` and `FulfillsAsOriginator(executor)`
  in the PaymentRequest bindings module.
- TypeScript: `supportsEip3009`, `EIP3009_TOKENS` and `fulfillsAsOriginator` from
  `@atum-labs/schema-declarations/PaymentRequest/v1/bindings/typescript`.

A token qualifies when, on that chain, `authorizationState(address,bytes32)` returns a bool and
`TRANSFER_WITH_AUTHORIZATION_TYPEHASH()` returns the EIP-3009 typehash. Edit the JSON only.
`make generate-go-bindings` and `make generate-ts-bindings` refresh the binding copies, and the
drift guards fail when they are stale.

## Originator-executed deposits

When the deposit leg is the originator's, the payer funds the escrow itself with `directDeposit`
before it submits the request, typically from a Tempo account through a scoped access key:

```json
"executor": { "deposit": "originator", "reserve": "settler", "fulfill": "originator" }
```

Nothing is signed off chain: the deposit on chain is the authorization, so the request carries no
`sender_auth`. A settler checks the deposit at the finalized block before it bids and submits
`reserve()` before it fulfills. Every value the deposit committed has to be on the request, so
payment-gw, the settler and veri-fill can derive the deposit from it alone:

| Deposit (`directDeposit` and its id) | Request member |
| --- | --- |
| owner (`msg.sender`) | `source.account`: the account that calls `directDeposit`, the Tempo root account and never the access key that signs the transaction |
| `token` | the ERC-20 in `source.asset_identifier` |
| `amount` | `max_source_amount`, fees included; reserve charges the winning quote and returns the rest |
| `nonce` | `deposit_nonce`, single use per owner, chain and escrow, forever |
| `depositWitness.depositRequestHash` | the request's depositRequestHash, v1 or v2 (see below) |
| `depositWitness.destination` | `destination[0]`, composed by `BuildEscrowDestination` |
| `depositWitness.reserver` | `quote_selector` |
| `depositWitness.releaser` | `fulfillment_verifier.account` |
| chain id, escrow | the source chain, `escrow_contract_address` |

Build the whole request first, deadlines included, run `Validate` / `validatePaymentRequestJSON`
on it, derive the deposit from it (below) and fund it with the `DirectDepositInput` the derivation
returns, never calldata of your own, then submit the same bytes. Retries resubmit the identical
request. Neither check implies the other. `Validate` checks the request; the derivation checks that
it names a deposit this chain and escrow can hold, and reads it as strictly as every other reader of
the deposit. A request `Validate` admits can still be refused by the derivation (a destination the
composer refuses, another chain or escrow, a case twin in a member the rules do not read), and a
request the derivation accepts can still fail the schema or the EIP-3009 destination rule. A
deposit funded for a request either one refuses only comes back through `refundUnreserved`. For the
same reason payment-gw admits a direct deposit with the derivation (or the reader) as well as
`Validate`, not with `Validate` alone.

The gateway does not authenticate the caller of a direct deposit. Under v1 the deposit id binds
the owner, token, nonce, `max_source_amount`, the destination, the reserver (`quote_selector`) and
the releaser (`fulfillment_verifier.account`), and the rest only through `keccak256(request_id)`:
`fulfillment_amount`, both deadlines, `executor.fulfill`, `fulfillment_proxy` and the verifier
endpoint are open. Keep the `request_id` unpredictable (random, not derived from the nonce or a
purchase number) and undisclosed until you submit it, under either version. Under v1 someone who
learns it first can submit your deposit with other terms, a lower `fulfillment_amount` for one.
Under v2, changing the terms listed above names another deposit, but a submission that takes
your `request_id` first still blocks yours, and your deposit then comes back only through
`refundUnreserved`.

The witness commits either depositRequestHash version, and the escrow treats it as opaque, so the
payer and every reader of the deposit must agree on it. The version is a deployment setting, so
derive a direct deposit at the version the gateway you submit to derives at. A gateway publishes
it, per source chain, as `direct_deposit_request_hash_version` in `GET /v1/defaults`
(`deposit_request_hash_versions` there describes Permit2 signatures only), and a client must not
make a direct deposit at a version it does not know. A gateway that predates that member publishes
none, so ask its operator. A deposit derived at the other version is accepted under another
payment id and never quoted. v2 commits the payment terms; v1 (`keccak256(request_id)`) binds the
terms the deposit id leaves open (above) only through the request id, and is deprecated for direct
deposits. The `request_id` must satisfy the v2 reader under either version.

The derivation is shared, so nobody re-implements the preimage:

- Go: `senderauth.DeriveDirectDeposit(request, chainID, escrow, version)`.
- TypeScript: `deriveDirectDeposit(requestJson, chainId, escrow, version)` from the sender-auth
  package.

Each returns the deposit id, the `DirectDepositInput` to call `directDeposit` with, and the stored
unreserved tuple with its hash (`getDepositHash(id)` until reserve). The chain id and escrow are
the caller's, never the request's claim: a request naming another chain or escrow, or a zero
escrow, is refused. Addresses are read case-insensitively, as the escrow does, so under v1 a wrong
EIP-55 checksum does not change the deposit. Under v2 the hash commits the address strings as
written, so another spelling of the same address is another deposit: v2 payers and readers use the
request's exact bytes. The derivation also refuses a request whose reserve leg is
not the settler's. A refusal is a `DirectDepositError` with a bounded `Reason`. Both are pinned to
[`conformance/direct-deposit-derivation-vectors.json`](./conformance/direct-deposit-derivation-vectors.json),
whose known-answer row is the escrow's own vector.

`Validate` / `validatePaymentRequestJSON` apply the request rules, after the EIP-3009 destination
rule: an originator-executed deposit must have reserve by the settler, no `sender_auth` (not even
`null`), a decimal uint256 `deposit_nonce`, `quote_selector` and `fulfillment_verifier.account` as
nonzero EVM addresses (the escrow refuses a zero reserver or releaser, and so does the derivation),
a positive uint256 `max_source_amount`, a `request_id` of 1 to 128 characters from
`A-Z a-z 0-9 . _ -`, a source that is an ERC-20 on an EVM chain other than the zero address held by
an EVM `source.account`, and exactly one destination whose composed form fits the escrow's 256
bytes. Any other request carries no `deposit_nonce`. A refusal is a `DirectDepositRuleError` naming
one of `executor`, `sender_auth`, `deposit_nonce`, `quote_selector`, `fulfillment_verifier`,
`max_source_amount`, `request_id`, `source` or `destination`, and matches
`ErrInvalidDirectDeposit`. Root members are read by their exact names in both languages. `Validate`
runs the schema first, and the schema already refuses a `deposit_nonce` that is not a decimal
string or is longer than 78 characters, and a `sender_auth` that is not a complete object, so those
reach the caller as schema errors rather than as a `DirectDepositRuleError`. The rules are pinned by
[`conformance/direct-deposit-rule-vectors.json`](./conformance/direct-deposit-rule-vectors.json).

The quote binding (`VerifyQuoteRequestBinding`) also requires the quote's request to carry the
stored `deposit_nonce`, byte for byte, which v2 does not commit. A mismatch is a
`quote_request_mismatch`, like any other difference between the two copies. Leading zeros are
admitted, so `"7"` and `"007"` name the same deposit; the quote has to carry the nonce exactly as
the request was submitted.

## Integration Notes

- A `PaymentRequest` is constructed by the originator (or their SDK) and submitted
  to the payments endpoint.
- Identity fields (`originator_auth`, `@context`, `proof`, `verifiableCredential`)
  are optional; include them when issuer-anchored identity or document signing is
  required by policy.
