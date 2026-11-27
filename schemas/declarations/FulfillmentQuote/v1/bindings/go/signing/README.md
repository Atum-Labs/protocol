# ld-verification-go

Verifies W3C Data Integrity proofs on JSON-LD-canonicalized
FulfillmentQuotes. Dispatches by cryptosuite:

- `EcdsaSecp256k1RecoverySignature2020` — detached ES256K-R JWS,
  Keccak256 hash construction, EVM-style address recovery.
- `Ed25519Signature2020` — multibase z-base58btc `proofValue`, SHA-256
  hash construction, ed25519 signature verification against the pubkey
  embedded in the `did:pkh:solana:…` or `did:pkh:stellar:…` (a `G…` account strkey)
  verificationMethod.

## API

### `Verify` — full verify path

```go
import ldverification "github.com/atum-labs/protocol/schemas/declarations/FulfillmentQuote/v1/bindings/go/signing"

res, err := ldverification.Verify(signedQuoteJSON)
if err != nil {
    return err
}
// res.Signer is a sealed type. Type-switch it:
//   RecoveredSecp256k1Signer.Address is the recovered EVM address
//   SelfAssertedEd25519Signer carries the caller-asserted ed25519 key:
//     PublicKey    is the ed25519 key named in the verificationMethod
//     DIDNamespace is the did:pkh namespace, lower-case ("solana" or "stellar")
//     DIDNetwork   is the network segment after it, as written in the DID: the
//                  genesis-hash reference for Solana ("EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
//                  is devnet), "pubnet" or "testnet" for Stellar
// res.Created is proof.created, so the caller applies the freshness window
switch signer := res.Signer.(type) {
case ldverification.SelfAssertedEd25519Signer:
    // Bind the key to the quote's source chain BEFORE trusting PublicKey.
    if err := signer.MatchesChain(sourceChainCAIP2); err != nil { // e.g. "stellar:pubnet"
        return err // errors.Is(err, ldverification.ErrSignerChainMismatch)
    }
    // Only now compare signer.PublicKey with the whitelist.
case ldverification.RecoveredSecp256k1Signer:
    // The address is recovered from the signature and names no chain, so there is
    // no MatchesChain here. Map signer.Address to the source chain's form, then
    // compare it with that chain's whitelist:
    //   EVM:  strings.ToLower(signer.Address.Hex())
    //   Tron: base58check of 0x41 followed by signer.Address.Bytes() (this package
    //         does not export a helper for it)
}
```

The caller is responsible for freshness, whitelist, and per-request
authorization. Beyond cryptographic recovery, the library gives you
`MatchesChain` for one of those checks: the chain binding of an ed25519
signer (below).

#### Check the signer's chain before trusting `PublicKey`

For `Ed25519Signature2020` the key is read from the quote's own
`verificationMethod`, so a valid signature proves only that the signature
matches that key. It does not bind the key to the chain the quote was
issued for. Call `SelfAssertedEd25519Signer.MatchesChain(caip2)` with the
CAIP-2 identifier of the quote's source chain (for example
`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` or `stellar:pubnet`) before you
trust `PublicKey`.

`MatchesChain` splits `caip2` at the first `:` and requires both halves to
equal the signer's: the namespace against `DIDNamespace` and the reference
against `DIDNetwork`. Each compare is case-insensitive, as for the DID. It
returns `nil` on a match. Otherwise it returns an error that wraps
`ErrSignerChainMismatch`, so test it with `errors.Is`. That happens when:

- `caip2` is not a CAIP-2 identifier: no `:`, or an empty namespace or
  empty reference (`devnet`, `stellar:`).
- the namespace differs (a `did:pkh:stellar:…` key against `solana:…`).
- the reference differs (`did:pkh:stellar:testnet:…` against `stellar:pubnet`).

`ErrSignerChainMismatch` is an authorization refusal, not a malformed
document, so it does not wrap `ErrMalformedProof`.

The reference is compared as written, never translated. A settler builds its
Solana DID from the chain's genesis-hash id (`did:pkh:solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:…`),
so pass that same form. A label such as `solana:devnet` does not match it and
every such quote is refused with `ErrSignerChainMismatch`.

Why both halves: a network reference is not unique to one namespace, so
comparing `DIDNetwork` alone would let a quote signed under one namespace pass
a check for a chain in another that uses the same reference text. Checking the
namespace too closes that. `MatchesChain` exists only on
`SelfAssertedEd25519Signer`; a `RecoveredSecp256k1Signer` has no such method.

### `HashQuote` — shared signing-input construction

`HashQuote` produces the W3C Data Integrity signing input (the bytes a
signer signs, and a verifier reconstructs). `Verify`'s internal
secp256k1 / ed25519 paths delegate here so the hash construction has
one implementation; expose it directly when you need the canonical hash
without verifying a signature (audit, off-chain attestation, etc.).
Mirrors `hashQuote` in
[`@atum-labs/ld-signing`](../typescript/ld-signing/) byte-for-byte —
both sides MUST stay in lock-step.

```go
hash, err := ldverification.HashQuote(doc, ldverification.HashQuoteOptions{
    Cryptosuite: ldverification.ProofTypeSecp256k1Recovery2020,
    ProofOptions: ldverification.HashableProofOptions{
        Type:               ldverification.ProofTypeSecp256k1Recovery2020,
        Created:            "2026-04-01T00:00:00.000Z",
        VerificationMethod: "did:pkh:eip155:1:0x…#blockchainAccountId",
        ProofPurpose:       "assertionMethod",
    },
})
// hash.SigningInput is the keccak256(proofHash || docHash) for secp256k1,
// or proofHash || docHash (raw concat) for ed25519.
```

`doc` MUST be the quote with its proof block stripped. `HashQuote`
strips `proof` + `verifiableCredential` defensively, but callers should
do the work explicitly so re-sign paths can't carry stale proof
predicates into the hash.

## Embedded context

The FulfillmentQuote JSON-LD `@context` is embedded into the binary at
build time from `contexts/fulfillment-quote-context.jsonld`, a snapshot
of the canonical schema. Run `make update-context` (or `go generate
./...`) after editing the schema. CI runs `make verify-context` to catch
drift.

The strict document loader has no network fallback — context changes
require a rebuild of consumers.
