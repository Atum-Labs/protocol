# ld-data-integrity (Go)

Shared Go primitives for W3C Data Integrity 1.0 signing + verification.

## What this lib owns

- **URDNA2015 canonicalization** with a strict no-network document loader.
  Callers register vendored JSON-LD contexts; unknown URLs fail-closed
  (SSRF defense on pre-auth verification paths).
- **Generic W3C contexts** vendored byte-identical: W3C VC v1,
  EcdsaSecp256k1RecoverySignature2020 v2, and Ed25519Signature2020 v1.
- **Atum credential contexts**: known-to-atum v1 and v2, kyc v1 and
  sender-compliance v1, each under `https://schemas.atum.xyz/credentials/`.
  known-to-atum v2 defines every v1 term as v1 does and adds the
  `quoteAwarder` and `merchant` roles. v1 is `@protected`, so a role can
  only be added in a new context. v2 keeps v1's vocabulary, so a credential
  using only v1-defined terms signs the same N-Quads under either. A
  `quoteAwarder` or `merchant` credential does not: v1 leaves its role out
  of the signed N-Quads, which is why those roles are issued under v2.
- **Cryptosuite primitives** for EcdsaSecp256k1RecoverySignature2020
  (detached JWS) + Ed25519Signature2020 (multibase proofValue).
- **Ed25519 proof message**: `Ed25519ProofMessage(SigningInput)` =
  `"atum ld-proof v1 "` + base64url without padding of the 64-byte
  SigningInput (103 ASCII bytes). FulfillmentQuote quote and VP proofs
  (PaymentRequestEnvelope VPs included) and PaymentRequest proofs sign the raw
  SigningInput by default and this text with the off by default text proof
  option; `VerifyEd25519Proof` accepts either. VC proofs sign the raw SigningInput.
  `conformance/ed25519-proof-message.json` pins it for Go and TS.
- **Combined-hash** construction (`SigningInput = H(proofHash || docHash)`
  per W3C Data Integrity §4.4) with the cryptosuite-specific hash
  algorithm (keccak256 for secp256k1, sha-256 for ed25519).
- **Signature recovery** for secp256k1 (returns the EVM address recovered
  from the JWS + signing input).

## What this lib does NOT own

- **Schema-specific contexts** (FulfillmentQuote, FulfillmentQuoteEnvelope,
  PaymentRequest, BidAward, etc.) — those stay in each declaration's
  `bindings/go/ld-verification/contexts/` directory. Callers pass them
  to `NewDocumentLoader` via the `Extra` field.
- **High-level sign/verify wrappers** (`Sign`, `Verify`, `SignVP`,
  `VerifyVP`) — those live in each schema's own bindings package and
  delegate to this lib's primitives. The wrappers know about schema-
  specific shape (e.g. FQ's `proof` field placement, VP's `holder` +
  `verifiableCredential[]` shape).
- **TypeScript signing** — see
  `schemas/declarations/common/ld-data-integrity/typescript/`.
  This lib is Go-only; cross-language conformance fixtures pin the two
  sides to byte-equal output.

## Layout

```
schemas/declarations/common/ld-data-integrity/go/
  go.mod
  go.sum
  README.md                — this file
  Makefile                 — test + lint
  contexts/                — vendored generic JSON-LD contexts
    credentials-v1.jsonld
    secp256k1recovery-2020-v2.jsonld
    ed25519-2020-v1.jsonld
    known-to-atum-v1.jsonld
    known-to-atum-v2.jsonld
    kyc-v1.jsonld
    sender-compliance-v1.jsonld
  document_loader.go       — strict-no-network loader; registers generic contexts
  canonicalize.go          — URDNA2015 entry point; admission runs first
  admission.go             — CheckCanonicalizable, AdmissionError, rule ids
  dataset_admission.go     — expanded-dataset rules: blank-node budget,
                              indistinguishable blank nodes
  hash.go                  — combined-hash construction + cryptosuite dispatch
  content_hash.go          — ComputeContentHash: a declaration's content hash, the
                              proof.challenge its envelope binds
  jws.go                   — Secp256k1 detached JWS (build + parse)
  recovery.go              — Secp256k1 signer recovery → EVM address
  ed25519.go               — Ed25519 sign + verify + multibase proofValue
                              + Ed25519ProofMessage, VerifyEd25519Proof
  errors.go                — sentinel errors (ErrMalformedProof,
                              ErrUnsupportedProofType, ErrUnknownContext,
                              ErrSignatureRecovery, ErrCanonicalizationFailed)
  *_test.go                — unit tests + vector pins
../conformance/
  admission-vectors.json   — admit/refuse vectors, intended to be shared with the TypeScript lib
  ed25519-proof-message.json — Ed25519ProofMessage vectors read by the Go and TS tests
                              (regenerate: REGEN_LD_PROOF_MESSAGE=1 go test -run TestEd25519ProofMessageConformance)
```

## Threat model notes

- **Strict-no-network loader**: any unknown JSON-LD `@context` URL fails
  closed with `ErrUnknownContext`. A default loader that HTTP GETs unknown
  URLs with no timeout would turn any pre-auth verification path into an
  SSRF + slow-loris amplifier (consumer's container network namespace,
  including cloud metadata endpoints). Vendoring is the contract; signers
  MUST rebuild against the bundled context set.
- **Admission before canonicalization**: `Canonicalize` refuses, with an
  `*AdmissionError` matching `ErrNotCanonicalizable`, any document over the
  value or byte budget, or one that defines its own terms (`@context` that
  is not a URL or list of URLs, keys containing `:`) or names its own blank
  nodes (keywords other than `@context` as keys, `_:` strings), that
  holds a key or string that is not valid UTF-8, that nests objects or
  arrays more than 32 deep (JSON-LD processors recurse over the document),
  or that holds a TAB in a string value (json-gold and rdf-canonize write
  a TAB differently in an N-Quads literal). URDNA2015's
  cost is not bounded by input size and json-gold offers no work limit, so
  the refusal happens before json-gold is called. The expanded dataset is
  then refused if it holds more than 1024 blank nodes, if its canonical
  output would exceed 128 KiB (one long IRI shared by many statements
  multiplies into the output, and json-gold copies the output built so far for
  every statement it appends), or if it holds two blank nodes whose first-degree quads (RDFC-1.0 Hash First Degree Quads) coincide.
  URDNA2015 runs its permutation search, Hash N-Degree Quads, only for
  blank nodes whose first-degree hashes collide, so every admitted
  document canonicalizes without it. The cost of that guarantee is that
  documents holding interchangeable anonymous nodes, such as two identical
  entries of one array, or two embedded credentials without an `id` whose
  own fields agree, are refused. Admitted documents canonicalize byte-identically to json-gold's
  own `Normalize`. The vectors in
  `../conformance/admission-vectors.json` are intended to be shared with the
  TypeScript lib.
- **Errors say whose fault a failure is.** An admission refusal matches
  `ErrNotCanonicalizable` and names its rule. A document json-gold cannot
  process (it panics, or refuses the document while converting it to a
  dataset) matches `ErrCanonicalizationFailed`, and an unregistered context
  matches `ErrUnknownContext`: all three are the caller's document. A failure
  to load or read one of the registered contexts carries none of them, since
  it is a fault on this side. The TypeScript lib has no counterpart to
  `ErrCanonicalizationFailed`: jsonld.js errors reach its callers as they are.
- **Context drift discipline**: the vendored snapshots are byte-identical
  to the signer side. CI tests pin canonical n-quad output to catch drift
  the moment any vendored context is rebuilt.

## Public API stability

This lib's surface is consumed by the schema bindings. Breaking changes
ripple. Bump the module version when changing exported signatures.
