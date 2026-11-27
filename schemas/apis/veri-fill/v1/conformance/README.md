# Verdict conformance vectors

One preimage file per attestation kind, each the cross-language anchor for that kind's signing
preimage as defined in `../openapi.yaml`, and one file of real signatures across every scheme:

| File | Kind | Tag | Chain it attests |
| --- | --- | --- | --- |
| `verdict-preimage-vectors.json` | `FulfillmentVerdict` | `atum-verdict/fulfillment/1` | destination |
| `deposit-verdict-preimage-vectors.json` | `DepositVerdict` | `atum-verdict/deposit/1` | source |
| `verdict-signature-vectors.json` | both | see below | both |

The preimage is what `tip191-secp256k1` (`tron:*`) and `ed25519-raw` (`solana:*`) sign. An
`eip155:*` verdict is signed as EIP-712 typed data under `eip712-secp256k1`, so the eip155
vectors in the two preimage files pin the framing, which renders identically on every chain, and
are not a signing input.

They are kept apart so each kind's expectations move independently, and so neither file's tag
can be mistaken for the other's. The tag is the first line of the preimage and is what stops a
signature over one kind satisfying a verifier of the other, which matters because on a corridor
whose source and destination are the same chain, both kinds can be signed by the same key.

## Why it is frozen

Changing the preimage invalidates every verdict signature ever issued. An expectation in this
file may therefore only change when every implementation changes with it, in the same commit.
There is no regeneration target on purpose: the expectations are not derived from any one
implementation, and a value that needs updating is a signal to stop and check why.

## What it pins

Each `accept` vector in either file carries the verdict object, the rendered preimage as `preimageHex`, its
`byteLength` and its `sha256`. The hex is the authority, because it is the only form that shows
the trailing LF and the `key=0:` lines for empty members, which a rendered string in a source
file cannot.

Each `reject` vector names one member and a value that MUST be refused before rendering, with
the reason. Together they cover the framing bytes, control bytes, and non-ASCII, which is the
class that would otherwise make a Go renderer (byte length) and a JavaScript renderer (UTF-16
code units) sign different preimages for the same verdict.

Signatures are out of scope in the preimage files. `signature` is present only so each verdict
is complete against the component's required list, and is a placeholder of the right length.

## Signature vectors

`verdict-signature-vectors.json` carries one verdict per case below, each with a real signature
from a signer independent of every binding in this repository, under fixed TEST keys that are
public and must never sign anything else:

| Case | Scheme | Independent signer |
| --- | --- | --- |
| eip155 fulfillment, delivered | `eip712-secp256k1` | ethers `Wallet.signTypedData` |
| eip155 fulfillment, not_delivered | `eip712-secp256k1` | ethers `Wallet.signTypedData` |
| eip155 deposit, held | `eip712-secp256k1` | ethers `Wallet.signTypedData` |
| tron fulfillment, delivered | `tip191-secp256k1` | TronWeb `Trx.signMessageV2` |
| tron deposit, held | `tip191-secp256k1` | TronWeb `Trx.signMessageV2` |
| solana fulfillment, delivered | `ed25519-raw` | `node:crypto` ed25519 |
| solana deposit, held | `ed25519-raw` | `node:crypto` ed25519 |

Each vector pins the verdict, `signingInputHex` (the EIP-712 digest, the TRON-prefixed keccak256
of the preimage, or the preimage bytes for ed25519), the `signer` address and, for EIP-712, the
`typedData` payload a typed-data signer receives. The file also pins the EIP-712 domain and both
type strings as the independent library encodes them. `generatedWith` records the exact tools
and versions. The generator is not kept in this repository, for the same reason the preimage
files have no regeneration target.

## Who asserts it

Both language bindings assert the preimage files and Go asserts the signature file, each against
these same files rather than against fixtures of their own:

* **Go** — `../bindings/go/verdict_test.go` and `../bindings/go/deposit_verdict_test.go` assert
  every preimage vector, and `../bindings/go/verdict_signature_vectors_test.go` asserts every
  signature vector: the derived signing input, the typed data, and that the binding accepts the
  independent signature and refuses it once a signed member changes. The preimage tests also
  check the member order against the implementation, and validate each accept vector against
  the patterns and the per-family encodings declared in the schema. A further
  test renders both kinds over identical common members and requires the bytes to differ, so the
  domain separation is a property of the framing rather than of the two member lists happening
  to differ today.
* **TypeScript** — `../bindings/typescript/test/verdict-preimage.test.js`, run by
  `make test-veri-fill-ts`. This side is not optional garnish: the framing counts bytes because
  Go counts bytes, while a naive JavaScript renderer counts UTF-16 code units, and an omitted
  member interpolates as the literal text `undefined`. The non-ASCII reject vectors and the
  `key=0:` accept vectors exist for those two failures specifically, so with only one language
  asserting them nothing exercised the case they were written for.

  The renderer lives in `../bindings/typescript/src/verdict.ts` and is imported by that subpath.
  It is deliberately NOT re-exported from `index.ts`, which the generator overwrites on every
  run, so an export added there is silently lost.

Any other implementation that signs or verifies a verdict MUST assert against these same files
rather than against fixtures of its own. That is the whole point of them existing.
