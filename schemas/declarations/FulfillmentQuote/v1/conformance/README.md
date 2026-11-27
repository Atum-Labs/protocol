# FulfillmentQuote/v1 cross-language conformance

This directory pins the Go ↔ TypeScript interoperability contract for
the FulfillmentQuote LD signing/verification libraries:

- `signing/go` (signer + verifier, Go)
- `signing/typescript` (signer + verifier, TS)

The contract is: **a quote (or VP envelope) signed in one language MUST
verify in the other**, byte-for-byte, under both supported cryptosuites
(`EcdsaSecp256k1RecoverySignature2020` and `Ed25519Signature2020`).

`fixtures/` holds committed JSON files — one signed payload per
(cryptosuite × signing language × declaration), plus the VC-proof
fixtures and JWK sidecars — generated against a fixed key set and a fixed
`created` timestamp so the cross-verification test is deterministic and
bisectable.

## FulfillmentQuote fixtures

| File | Cryptosuite | Signed by |
|---|---|---|
| `secp256k1-go-signed.json` | `EcdsaSecp256k1RecoverySignature2020` | Go (`Sign`) |
| `secp256k1-ts-signed.json` | `EcdsaSecp256k1RecoverySignature2020` | TS (`signQuote`) |
| `ed25519-go-signed.json` | `Ed25519Signature2020` | Go (`SignEd25519`) |
| `ed25519-ts-signed.json` | `Ed25519Signature2020` | TS (`signQuoteEd25519`) |

## FulfillmentQuoteEnvelope fixtures

| File | Cryptosuite | Signed by |
|---|---|---|
| `secp256k1-go-vp.json` | `EcdsaSecp256k1RecoverySignature2020` | Go (`SignVP`) |
| `secp256k1-ts-vp.json` | `EcdsaSecp256k1RecoverySignature2020` | TS (`signVP`) |
| `ed25519-go-vp.json` | `Ed25519Signature2020` | Go (`SignVPEd25519`) |
| `ed25519-ts-vp.json` | `Ed25519Signature2020` | TS (`signVPEd25519`) |

## Refused FulfillmentQuoteEnvelope fixtures

The envelopes above with the embedded credential's `issuanceDate` set to JSON
`null`. The holder signature verifies, and both verifiers must refuse the
credential: Go with `ErrVPVCMissingIssuanceDate`, TypeScript with its
missing-or-non-string `issuanceDate` error. JSON-LD drops a null member, so the
canonical form, and with it the signature, is the same as for a credential with
no `issuanceDate` at all; the verifiers refuse on the wire value. Each suite
also asserts the member is present and null, so a generator that dropped it
fails rather than testing an absent `issuanceDate` instead. The ed25519 pair is
byte-identical like the others.

| File | Cryptosuite | Signed by |
|---|---|---|
| `secp256k1-go-vp-null-issuance-date.json` | `EcdsaSecp256k1RecoverySignature2020` | Go (`SignVP`) |
| `secp256k1-ts-vp-null-issuance-date.json` | `EcdsaSecp256k1RecoverySignature2020` | TS (`signVP`) |
| `ed25519-go-vp-null-issuance-date.json` | `Ed25519Signature2020` | Go (`SignVPEd25519`) |
| `ed25519-ts-vp-null-issuance-date.json` | `Ed25519Signature2020` | TS (`signVPEd25519`) |

## PaymentRequestEnvelope fixtures

The same VP signer/verifier, exercised through the **envelope-context-overlay
seam** so a PaymentRequestEnvelope (PRE) — the originator-side holder VP —
signs/verifies under the PRE declaration `@context` with
`type: ["VerifiablePresentation", "PaymentRequestEnvelope"]` rather than the
FQE default. The generators thread `EnvelopeContextURL` + `ExtraEnvelopeContexts`
(the canonical PRE context overlaid onto the strict no-network loader) and
`DeclarationType`; the verifiers pass the matching `ExpectedDeclarationType` so
the `PaymentRequestEnvelope` `rdf:type` n-quad (covered by the holder signature)
is asserted. A negative case on each side confirms a valid PRE is rejected under
the wrong `ExpectedDeclarationType`.

| File | Cryptosuite | Signed by |
|---|---|---|
| `secp256k1-go-pre-vp.json` | `EcdsaSecp256k1RecoverySignature2020` | Go (`SignVP` + PRE seam) |
| `secp256k1-ts-pre-vp.json` | `EcdsaSecp256k1RecoverySignature2020` | TS (`signVP` + PRE seam) |
| `ed25519-go-pre-vp.json` | `Ed25519Signature2020` | Go (`SignVPEd25519` + PRE seam) |
| `ed25519-ts-pre-vp.json` | `Ed25519Signature2020` | TS (`signVPEd25519` + PRE seam) |

## Typed (wallet-signed) fixtures

A payer's wallet cannot sign the raw 32-byte digest an `EcdsaSecp256k1RecoverySignature2020` proof
signs; it signs EIP-712 typed data (`eth_signTypedData_v4`). So the two proofs a payer makes, the
inner PaymentRequest proof and the PaymentRequestEnvelope holder proof, also come in a typed form:
the same proof options and the same detached JWS framing, with the signature over the EIP-712
digest of `{proofHash, docHash}` instead of over `keccak256(proofHash || docHash)`. Both commit the
same two Data Integrity hashes, so the typed form binds exactly what the raw form binds.

Domain `{name: "Atum Payment Request", version: "1", verifyingContract: 0x520A20100F01165e806D6d239d9D287a109Ce456}`
(no chainId; the sentinel is the last 20 bytes of `keccak256("atum.payment-request.v1")`), with
`PaymentRequestProof(bytes32 proofHash,bytes32 docHash)` for the inner request and
`PaymentRequestEnvelopeProof(bytes32 proofHash,bytes32 docHash)` for the envelope. A verifier tells
the forms apart by which digest recovers the signer the proof names: the inner request's
`verificationMethod`, the envelope's `holder`.

Both typed forms are accepted only where the verifier opts in, and both are off by default
(`AcceptPaymentRequestTypedProof` / `acceptPaymentRequestTypedProof` for the inner request,
`AcceptPaymentRequestEnvelopeTypedProof` / `acceptPaymentRequestEnvelopeTypedProof` for the
envelope). A wallet shows the typed data as two opaque hashes, so a page that asks a payer to sign
it obtains a valid proof over whatever document it hashed: only a verifier of the originator's own
payment request opts in. The envelope's form is taken only for an envelope that declares
`PaymentRequestEnvelope`, and such an envelope never takes the settler identity form
(`SettlerProof`), which every other envelope still may. That rule covers the envelope's holder proof
only. Holder-issued credentials inside it are verified by `VerifyVCProof`, in the raw form or as
`SettlerProof`, as before.

| File | Declaration | Signed by |
|---|---|---|
| `PaymentRequest/v1/conformance/fixtures/secp256k1-typed-go-signed.json` | PaymentRequest | Go (`SignPaymentRequestTypedWithSignerAndCreatedString`) |
| `PaymentRequest/v1/conformance/fixtures/secp256k1-typed-ts-signed.json` | PaymentRequest | TS (`signPaymentRequestWithTypedDataSigner`, ethers `Wallet.signTypedData`) |
| `secp256k1-typed-go-pre-vp.json` | PaymentRequestEnvelope | Go (`SignVPTypedWithSignerAndCreatedString`) |
| `secp256k1-typed-ts-pre-vp.json` | PaymentRequestEnvelope | TS (`signVPWithTypedDataSigner`, ethers `Wallet.signTypedData`) |

Each language verifies the other's. The EIP-712 encoding is hand-written in Go and ethers'
`TypedDataEncoder` in TS, and both pin the same digest vectors (`payment_request_proof_test.go`,
`payment-request-proof.test.ts`).

## Known-to-atum v2 credential fixtures

Credentials issued under `https://schemas.atum.xyz/credentials/known-to-atum/v2`,
one per role that v2 adds to v1. The v1 context does not define these roles, so
under v1 a credential's signature does not cover them. Each is signed by the
pinned issuer keys in both languages, and each language verifies the other's.
Both suites also check that the role is in the signed bytes: the credential
with its role changed, or naming the v1 context instead, must fail on the
signature.

| File | Role | Cryptosuite | Signed by |
|---|---|---|---|
| `secp256k1-{go,ts}-vc-proof-kta-v2-quote-awarder.json` | `quoteAwarder` | `EcdsaSecp256k1RecoverySignature2020` | Go / TS (`SignVCProofSecp256k1WithCreatedString` / `signVCProofSecp256k1`) |
| `ed25519-{go,ts}-vc-proof-kta-v2-quote-awarder.json` | `quoteAwarder` | `Ed25519Signature2020` | Go / TS (`SignVCProofEd25519WithCreatedString` / `signVCProofEd25519`) |
| `secp256k1-{go,ts}-vc-proof-kta-v2-merchant.json` | `merchant` | `EcdsaSecp256k1RecoverySignature2020` | Go / TS |
| `ed25519-{go,ts}-vc-proof-kta-v2-merchant.json` | `merchant` | `Ed25519Signature2020` | Go / TS |

They carry an `expirationDate` of `2026-03-02T00:00:00Z`. The VC-proof check
covers the signature and not the dates, so they keep verifying after it passes.

## Determinism invariants

The conformance contract pins the secp256k1 fixtures by **cross-language
cryptographic verification + recovered signer**, NOT by byte-identity: ECDSA
gives no cross-implementation byte-equality guarantee (it hinges on the `k`
nonce, an implementation choice), so the suite verifies each side's
`EcdsaSecp256k1RecoverySignature2020` fixture on the other side and checks the
recovered address rather than diffing bytes. (In practice both libraries today
use RFC-6979 deterministic nonces — go-ethereum's `crypto.Sign` and ethers'
`SigningKey.sign` — so the committed go/ts secp256k1 pairs *happen* to be
byte-identical; the tests deliberately do not depend on that.)

The ed25519 signatures are deterministic per RFC 8032, so each
Go-signed / TS-signed pair MUST be byte-identical (modulo JSON key
ordering, which both serializers produce alphabetically). Both the Go
and TS conformance suites check this byte-equality directly as a
load-bearing determinism pin — drift means the canonicalization,
hash composition, proof-block assembly, or (VP-side) `keepVerifiableCredential`
strip behavior has silently disagreed across languages.

## VP fixture single-type caveat

The VP fixtures' embedded VC declares `type: ["VerifiableCredential"]`
only — NOT the realistic `["VerifiableCredential", "KnownToAtumVC"]`.
Reason: with `safe: false`, Go's json-gold and TS's jsonld.js diverge
on unmapped `@type` IRIs (json-gold emits a relative-IRI N-quad; jsonld.js
drops the term silently), which breaks the byte-identity invariant. The
fixture's job is to pin canonical round-trip and nothing else. The
multi-type form can be restored once `KnownToAtumVC` is bound to a real
IRI so both libraries expand it identically.

## Content-addressed `quote_hash` golden

`quote-hash-golden.json` pins the content-addressed `quote_hash` —
`"0x" + hex(keccak256(SigningInput))` — for each signed FulfillmentQuote
fixture. The Go `ComputeQuoteHash` and the TS `computeQuoteHash` each assert
their output equals this committed map (`TestConformance_QuoteHashMatchesGolden`
/ `"content-addressed quote_hash parity"`). Both matching one committed file is
what pins Go↔TS `quote_hash` parity, without a cross-process test.

The normalizing `keccak256` makes `quote_hash` a **uniform 32-byte (66-char)**
value for every cryptosuite — secp256k1's `SigningInput` is already 32 bytes,
ed25519's is a 64-byte `sha256` concat, and hashing both yields one width that
matches `payment_id` (also a 32-byte digest on all chains). It is a full digest,
not a truncation.

`quote_hash` is derived from the canonical signing input and **ignores the
non-deterministic JWS / `proofValue`**, so the `-go-signed` and `-ts-signed`
fixtures of a given cryptosuite share content + proof metadata and resolve to
the **same** hash.

## Regenerating

After any change to the signing or canonicalization implementation on
either side, regenerate both halves:

```
# Go side
make -C schemas/declarations/FulfillmentQuote/v1/signing/go gen-conformance-fixtures

# TS side
npm run gen-conformance-fixtures --workspace=@atum-labs/ld-signing
```

Then re-run the conformance tests on both sides:

```
make -C schemas/declarations/FulfillmentQuote/v1/signing/go test
npm test --workspace=@atum-labs/ld-signing
```

If a deliberate change shifts the signing input, `quote-hash-golden.json`
goes stale and the parity tests fail. Rebaseline it by recomputing
`ComputeQuoteHash` / `computeQuoteHash` over the regenerated fixtures and
committing the new values (the diff is small and reviewable).

## Pinned inputs

The generators use a fixed set so two runs produce the same fixtures (both
libraries' RFC-6979 nonces make the secp256k1 ones repeat too; see
"Determinism invariants" above):

- **secp256k1 private key**: `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` — Hardhat account #0 (`0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`).
- **ed25519 seed**: 32 bytes of `0x00` — RFC 8032 test-vector key.
- **`created`**: `2026-04-01T00:00:00.000Z`.
- **Asset identifiers**: `eip155:1/erc20:0xaaa` / `0xbbb` — shorter than a 20-byte address, so the payment-gateway client's parser refuses them, while the committed signatures cover these exact bytes. Copyable examples live in each declaration's `example.json`.
- **Document**: the fixture in `signing/go/sign_test.go` (`signFixtureDoc`) and `signing/typescript/src/verify.test.ts` (`fixtureQuote`), with `settler_address` set to the signer's public-key-derived identity.
