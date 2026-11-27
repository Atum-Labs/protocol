# FulfillmentAuthorization Schema v1

## Overview

A `FulfillmentAuthorization` lets the originator fulfill a payment itself. The settler produces
it when the payment request's executor includes `{ "deposit": "settler", "reserve": "settler",
"fulfill": "originator" }`: instead of paying the destination, the settler calls
`authorizeFulfillment(quoteHash, authorizationHash)` on the fulfillment proxy and returns this
declaration, which carries a signed transfer of the settler's own funds to the payment's
destination. A settler fulfill does not produce one.

The payment gateway returns it verbatim as `fulfillment_authorization` on
`GET /v1/payments/{paymentId}/status`.

## Wire shape

The settler identity-signs the declaration, so on the wire it carries `@context`, `type` and
`proof` beside the declaration fields. The schema describes the declaration fields only;
`schema.json` does not list the identity-proof members.

```json
{
  "@context": [
    "https://schemas.atum.network/declarations/FulfillmentAuthorization/v1/context.jsonld",
    "https://w3id.org/security/suites/secp256k1recovery-2020/v2"
  ],
  "type": "FulfillmentAuthorization",
  "version": "1.0",
  "scheme": "EIP-3009",
  "authorization": {
    "message": "0x…",
    "message_prehash": "{\"domain\":{…},\"types\":{…},\"primaryType\":\"TransferWithAuthorization\",\"message\":{…}}",
    "signature": "0x…"
  },
  "fulfillment_quote_json": "{…}",
  "evidence": { "transaction_id": "0x…", "log_index": 4 },
  "proof": { "type": "EcdsaSecp256k1RecoverySignature2020", "jws": "…" }
}
```

- **`scheme`**: the authorization scheme. `EIP-3009` is the only one the validators implement.
  `SOROBAN-AUTH` is reserved for Stellar destinations: the schema accepts it, and the validators
  refuse it as not implemented until its rules are written.
- **`authorization`**: the signed transfer. Its shape depends on the scheme; see below.
- **`fulfillment_quote_json`**: the settler's signed FulfillmentQuote as raw JSON, with its proof,
  so its quote hash can be recomputed. The payment request is inside it as
  `payment_request_json`.
- **`evidence`**: the `FulfillmentAuthorized` log the settler's `authorizeFulfillment` call
  emitted: the transaction and its log index.

## The EIP-3009 authorization

The transfer authorization is in `authorization.message_prehash`: for EVM chains, the EIP-712
`TransferWithAuthorization` typed data as a JSON string, exactly as the settler signed it. Parse
it to read the transfer.

```ts
const typed = JSON.parse(fa.authorization.message_prehash);
const { from, to, value, validAfter, validBefore, nonce } = typed.message;
```

| Member | Value |
|---|---|
| `domain` | The token's EIP-712 domain: `name`, `version`, `chainId`, `verifyingContract`. `verifyingContract` is the token, so the asset is `eip155:<chainId>/erc20:<verifyingContract>`. |
| `types` | `TransferWithAuthorization` only. |
| `primaryType` | `"TransferWithAuthorization"` |
| `message.from` | The settler, which pays the transfer. |
| `message.to` | The payment request's destination account. |
| `message.value` | The payment request's `fulfillment_amount`, as a decimal string. |
| `message.validAfter` | `"0"`. Required to be exactly that: see the rules below. |
| `message.validBefore` | The payment request's `fulfillment_deadline` in whole unix seconds (any fraction dropped), as a decimal string. |
| `message.nonce` | The fulfillment quote hash. It is also the `quoteHash` in the `FulfillmentAuthorized` event. |

`authorization.message` is the EIP-712 digest of that typed data, which is the
`authorizationHash` passed to `authorizeFulfillment`. `authorization.signature` is the settler's
65-byte signature over the digest: the signature an EIP-3009 token's
`transferWithAuthorization` takes. `authorization.payload` is not used by this scheme.

## Validation rules

`Validate` (Go) and `validateFulfillmentAuthorizationJSON` (TypeScript) apply the same rules and
run the same conformance vectors. Both run `schema.json` first, then these rules. Both accept the
declaration with or without the identity-proof members, and neither verifies the identity proof or
the embedded quote's proof.

Take the document's **bytes**, not a parsed object, wherever you have them. A document whose
sibling members fold to one name is only a document while it is still text: `JSON.parse` has
already collapsed it, and the two languages would otherwise read different payments out of the
same file. TypeScript's `validateFulfillmentAuthorization` takes a parsed object for callers that
only have one; it still scans the embedded quote, request and prehash, which are carried as
strings, but it cannot see a twin among the document's own members.

0. No object in the document, the embedded quote, the request inside it, or the signed prehash
   names two members that are equal under Unicode simple folding, exact duplicates included. Go's
   `encoding/json` matches member names case-insensitively and keeps the last match, while
   `JSON.parse` keeps each spelling apart, so such a document means different things to the two
   readers. The quote's canonicalization drops members its context does not define, so a twin
   changes neither the quote hash nor the settler's proof: only this scan refuses it. The scan is
   `jsonmembers.FirstAmbiguousMember`, the one the sender-auth bindings use.
1. `message_prehash` is exactly the typed data above. The authorization carries `message`,
   `message_prehash` and `signature` and nothing else: no `payload`, and no other member.
2. `message` is the EIP-712 digest of `message_prehash`.
3. `signature` is a low-s secp256k1 signature over that digest by `message.from`, with a recovery
   id of 27 or 28. FiatToken's `ECRecover` reverts on 0 and 1, so an authorization carrying one
   could never be executed. A signature that is not this 65-byte form is refused by default; see
   **What a pass proves** below.
4. `validAfter` is `0`. The settler signs `0`, and a later not-before only shortens the window the
   originator was quoted, or makes an authorization nobody can execute read as one that can.
   `domain.chainId` is the quote destination's chain reference and `domain.verifyingContract` its
   token address, compared as rules 6 to 9 compare accounts and assets (folded, so a checksummed
   and a lower-case spelling are one token). On chain the token already refuses a signature made
   under another domain, since both fields are in the EIP-712 domain separator; the rule is here so
   that a pass means the authorization is for this payment's token, and so a wrong chain or token
   is refused by name rather than as an asset mismatch or an on-chain revert. `domain.name` and
   `domain.version` are in the same separator and are not bound: they are only type-checked, so a
   pass does not prove the token will accept the signature, and an authorization signed under a
   name or version the token does not hash still reverts on chain.
5. `validBefore` equals the payment request's `fulfillment_deadline` in whole unix seconds. Later
   would let the originator spend the settler's funds after the escrow can refund the sender.
   Earlier would shorten the originator's window to fulfill.
6. `message.from` is the quote's `settler_address`.
7. `message.value` is the payment request's `fulfillment_amount`.
8. The asset is the quote's destination asset.
9. `message.to` and the asset match one of the payment request's destinations.
10. `message.nonce` is the quote hash of `fulfillment_quote_json`.

A new scheme supplies its own parser, which reads its authorization into the same transfer and
reports its own expiry field, and rules 5 to 10 apply to it unchanged. Rule 4 is the EIP-3009
parser's own: a scheme whose not-before is caller-chosen reports it as the transfer's not-before,
and the shared rules then require it to be earlier than the expiry; and a scheme whose signing
domain names something other than the token (Permit2's names the Permit2 contract) binds its
domain to the destination in its own terms.

## What a pass proves

By default a pass means **the settler signed**: the signature was recovered and matched
`message.from`. Any signature that is not the 65-byte EOA form is refused. Both validators are pure
and cannot tell an EOA settler from a contract one without an `eth_call`, so a non-65-byte
signature cannot be proved by them.

### Proving a contract signature: `ValidateWithChain`

Every token in the EIP-3009 list verifies through `SignatureChecker.isValidSignatureNow`, so a
settler that is a contract wallet (a Safe, say) can execute `transferWithAuthorization`. To prove
such an authorization rather than leave it to the token, give the validator a chain reader:
`ValidateWithChain(ctx, json, checker)` in Go, `{ signatureChecker }` in TypeScript. The chain is
read with the token's own rule: a signer with no code must have signed the digest with its key, and
a signer with code must answer ERC-1271 `isValidSignature(digest, signature)` with the magic value
`0x1626ba7e`, to a call whose `msg.sender` is the token (the domain's `verifyingContract`). The
code is read first and always, because the token tests it first: an EIP-7702 account that signed
with its own key is sent to its delegate on chain, and the same order reaches the same verdict.

- The chain is read **last**. Every offline rule above runs first, in the same order as without a
  checker, so a document that is wrong costs no read and an account the quote does not name is
  never asked about.
- A refusal is `ErrContractSignatureRejected` (Go) or `ContractSignatureRejectedError`
  (TypeScript) only when the contract answered: it reverted or returned anything but the magic
  word. A chain that could not be read is `ErrSignatureUnverifiable` or `SignatureUnverifiableError`
  instead. It is never returned for a document that is wrong.
- **Both are refusals.** Unverifiable is not a pass and not "the token decides": the only thing it
  licenses is a retry. Falling back to the token as the authority is `AllowContractSignature`'s
  semantics, which accepts a signature nobody proved. A settler can steer its own authorizations
  into unverifiable: a reader reports a failed `isValidSignature` call that is not a revert (out of
  gas, an invalid opcode) as an error, as atum-core's `evmclient.IsValidSignatureAs` does on
  purpose, so a wallet whose `isValidSignature` does that makes every proof of its authorizations
  unverifiable. Wherever a pass gates anything (releasing funds, publishing an authorization,
  accepting a counterparty's document), unverifiable must gate it shut, and the tests pin that no
  reader failure passes.
- The checker interface (`SettlerSignatureChecker`) has the shape of the depositor side's
  `senderauth.DepositorSignatureChecker`, so one chain reader can serve both. The answer depends on
  contract state, so a reader must not cache it, and a caller must not cache a verdict.
- Both chain reads are at the latest block by default, and they are two reads, so they can land on
  different blocks. `AtBlock(block)` in Go or `{ block }` in TypeScript reads both at one block, for
  example the block a transfer executed in. The reader methods take the block (nil or undefined is
  the latest), and a reader must return an error for a network it does not serve rather than answer
  from another chain.
- `Validate` and `validateFulfillmentAuthorizationJSON` without a checker are unchanged, so every
  existing caller keeps its strict verdict.

**EIP-7702 accounts, and where the tokens differ.** An EIP-7702 account is an EOA that delegated
to code, so it has code and can also sign with its own key. The tokens order the two checks
differently:

| SignatureChecker | Order | Used by | Source read |
| --- | --- | --- | --- |
| Circle's | code first: no code means recover a key, code means ERC-1271 | USDC (`FiatTokenV2_2`) | `circlefin/stablecoin-evm` `contracts/util/SignatureChecker.sol` on `master` |
| OpenZeppelin 4.9's | key first: `tryRecover`, then ERC-1271 only if that fails | PYUSD's two listed deployments | `openzeppelin-contracts` `v4.9.0`; that PYUSD uses it is from review, not checked against the deployed bytecode |
| not checked | — | USDT0 (`ArbitrumExtensionV2`), USDT Celo (`TetherTokenCeloExtension`) | — |

The proof follows the code-first order. For a delegated settler whose own key signed, a key-first
token executes the authorization even if the delegate would refuse the signature, and the proof
refuses it with `ErrContractSignatureRejected`. That is the safe direction, a refusal rather than a
pass, and the divergence is not closed: this binding holds no per-token table, and which ordering a
deployed implementation has cannot be shown offline. So `ErrContractSignatureRejected` means the
contract answered no at the block asked, not that the token would refuse. Both sources read
`result.length >= 32` and compare the first word, which is the rule used for the return data.
Every other account agrees with the token under both orderings: no code is a key check, and a
contract that is not delegated has no key that signs for it.

**What a chain-proved pass does not show.** It is the answer at the latest block, not the block
the transfer lands in. It does not show that the token accepts the authorization: the token still
checks the nonce, the balance, the validity window and its own domain name and version, and a
64-byte EIP-2098 signature from an account with no code, which FiatTokenV2_2 accepts, is refused
here because only the 65-byte form is. The token stays the authority.

### Without a chain reader: `AllowContractSignature`

A caller that knows its settler may be a contract wallet and cannot read the chain can opt out of
the strict default, with `AllowContractSignature()` in Go or `{ allowContractSignature: true }` in
TypeScript. A non-65-byte signature is then accepted after a byte-validity check and nothing more,
so **a pass under that option does not show the settler authorised the transfer** — the token
does, when the transfer executes. The option is deprecated in favour of the chain reader and has no
effect when one is given.

Strict is the default because the permissive branch is reachable for *any* settler, not only a
contract wallet. A false negative is a loud refusal the caller can opt out of; a false positive is
a silent bypass.

## Conformance vectors

`conformance/fixtures/vectors.json` lists every other document in `conformance/fixtures/`, whether
it is valid, and for an invalid one the phrase both validators' errors contain, matched without
regard to case because the two schema validators word the same refusal differently. The Go and
TypeScript tests both run every vector, and both also assert that the manifest lists every file in
the directory, so neither language can run a vector the other skips.

`conformance/fixtures/chain-vectors.json` is the second manifest: the same documents judged with a
chain reader. Each case names a fixture, what the chain says about its settler (`has_code`, or a
read that fails), a model of the wallet's answer, the verdict, the kind of refusal (`rejected`,
`unverifiable`, or `offline` for a rule that fires before the chain is read) and how many code reads
and `isValidSignature` calls it must cost. The Go and TypeScript tests both run every case, so a
verdict, a refusal kind or a read count either language gets wrong fails the suite. The wallet is a
model of what an ERC-1271 wallet answers, not a deployed one: see **What the tests cannot show**
below.

The vectors are made with settler-agent's own code (`packages/agent/src/fulfillment/eip3009.ts`,
the quote signer and the identity signer), with the public Hardhat development keys and a
pinned clock, so a rerun reproduces them. The committed vectors come from settler-agent
`357554de`. To regenerate, from `schemas/declarations`:

```bash
SETTLER_AGENT=/path/to/settler-agent /path/to/settler-agent/packages/agent/node_modules/.bin/tsx FulfillmentAuthorization/v1/conformance/generate-vectors.mts
```

## What the tests cannot show

The vectors and the unit tests run offline against a fake chain reader. They prove this validator's
branching and its wire shape to a chain reader: which fact it reads, in which order, with which
arguments (the signer, the digest, the document's signature, and the token as `msg.sender`), and
how it labels each outcome. They cannot show that a deployed wallet or token behaves as the model
does:

- that a real contract wallet's `isValidSignature` returns the magic value for the bytes a settler
  signed (a Safe's own signature encoding, for instance), or reverts as the model says;
- that a real token's deployed `SignatureChecker` agrees on the edges the model fixes: the ordering
  and the return-data rule above were read from the libraries' sources, not from each deployed
  implementation, and USDT0 and USDT Celo were not read at all;
- that a chain reader implementation reports `HasCode` for an EIP-7702 delegation and sets
  `msg.sender` on the call as this interface requires.

Those need chain state, such as a devnet with a deployed wallet and token, and belong in the
consumer that supplies the chain reader.
