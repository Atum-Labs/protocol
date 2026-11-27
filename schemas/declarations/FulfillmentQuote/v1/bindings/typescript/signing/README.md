# @atum-labs/ld-signing

Signs FulfillmentQuotes with W3C Data Integrity proofs
(`EcdsaSecp256k1RecoverySignature2020`, detached ES256K-R JWS, or
`Ed25519Signature2020`, multibase z-base58btc proofValue).

## API

### `signQuote(quote, privateKeyHex, opts)` — EVM / secp256k1 recovery

```ts
import { signQuote } from "@atum-labs/ld-signing";

const signed = await signQuote(quote, privateKeyHex, { chainId: 1 });
// signed.proof.jws is the detached ES256K-R signature
// signed["@context"] is set; signed.verifiableCredential is []
```

The recovered address (used in `verificationMethod` DID) is
`new Wallet(privateKey).address.toLowerCase()`.

### `signQuoteEd25519(quote, secretKey, opts)` — Solana / Ed25519

64-byte ed25519 secret key (the Solana `Keypair.secretKey` shape) +
caller-supplied `verificationMethod`.

### `hashQuote(quote, opts)` — shared signing-input construction

`hashQuote` produces the W3C Data Integrity signing input (the bytes a
signer signs, and a verifier reconstructs to check the signature). Both
`signQuote` and `signQuoteEd25519` delegate here; the Go verifier in
`schemas/declarations/FulfillmentQuote/v1/signing/go`
has a byte-for-byte twin (`HashQuote` in `hash.go`). Expose this when
you need the canonical hash without holding a signing key — e.g.
audit, off-chain attestation, or wiring up a verifier in a third
language. Returns `{ signingInput, cryptosuite, docHash, proofHash }`
so callers can pin intermediate hashes for cross-language fixture
parity.

```ts
import { hashQuote } from "@atum-labs/ld-signing";

const { signingInput } = await hashQuote(quote, {
  cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
  proofOptions: {
    type: "EcdsaSecp256k1RecoverySignature2020",
    created: new Date().toISOString(),
    verificationMethod: "did:pkh:eip155:1:0x…#blockchainAccountId",
    proofPurpose: "assertionMethod",
  },
});
```

## Embedded context

The FulfillmentQuote JSON-LD `@context` is bundled into `dist/contexts/`
at build time from a snapshot of `schemas/declarations/FulfillmentQuote/v1/context.jsonld`.
The runtime canonicalizer is strict — there is no network fallback —
so context changes require a rebuild of consumers. `npm run verify-context`
fails if the snapshot is stale; CI runs it to detect drift.

## CLI

`sign-quote <private-key>` generates a sample quote, signs it, and prints
the signed document to stdout. Intended for ad-hoc debugging.
