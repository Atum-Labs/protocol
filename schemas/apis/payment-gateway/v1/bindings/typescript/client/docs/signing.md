# Signing a PaymentRequest

A PaymentRequest carries **three unrelated signatures**. They are produced by different calls,
cover different things, and none substitutes for another. Choosing the wrong one is the mistake
this page exists to prevent.

| What you are signing | Call | What it authorizes |
|---|---|---|
| `sender_auth.signed_messages[]` | `signPaymentRequest` | the on-chain **transfer** |
| the document's `proof` | `signDeclaration` | that the **document** came from its signer |
| `presentation` | `buildEnvelope` | the **originator's identity** |

A request with a valid `sender_auth` and no identity envelope authorizes a transfer by an
unidentified originator. The reverse identifies an originator who has authorized nothing. Most
integrations need the first two; the third applies once the originator holds credentials about
itself.

An award of a quote (`awardQuote`) signs `sender_auth` the same way, for the quote's
`source_amount`, and adds `reserve_auth`, which the quote request's `quote_selector` signs. See
[Awarding a quote](awarding.md).

> The underlying declaration library also names its document signer `signPaymentRequest`. This
> package exports it as `signDeclaration`, matching `SignDeclaration` in the Go client, so the two
> cannot be confused.

## Keys never reach this package

Every signing surface takes a **signer**, not a private key:

```ts
export interface DeclarationSigner {
  getAddress(): Promise<string> | string;
  signDigest(digest: Uint8Array): Promise<Uint8Array> | Uint8Array;
}
```

That is deliberate. A hex key forces raw key material into a JavaScript string, which cannot be
zeroized, is copied on assignment, and lands in heap snapshots and any log line that stringifies
the surrounding object. It also excludes every custodian: a holder whose key sits in a KMS, an
HSM, or a provider like Turnkey has no key to hand over.

For a local key, use ethers — a library built to hold keys:

```ts
import { Wallet } from 'ethers';
import { signerFromEthersWallet } from '@atum-labs/payment-gateway-client/signing';

const signer = signerFromEthersWallet(new Wallet(process.env.PRIVATE_KEY!));
```

For a custodian, implement the interface over its own digest-signing call — `buildEnvelope`
needs only `signDigest`. Two details the implementation must get right:

- **Sign the raw digest.** Not `signMessage` — that applies the EIP-191 prefix, and the
  resulting signature will not verify as a Data Integrity proof.
- **Return `v ∈ {0, 1}`.** The `+27` alignment is applied once downstream. A signature whose `v`
  is already 27 or 28 is **refused**, because applying it twice recovers a *different* address:
  a well-formed signature that verifies as somebody else.

## Signing both surfaces

```ts
import { Wallet } from 'ethers';
import {
  PaymentGatewayClient,
  signPaymentRequest,     // transfer authorization — lives at the package root
  createSenderSigner,
} from '@atum-labs/payment-gateway-client';
import {
  signDeclaration,        // document proof — the signing surface is its own subpath
  signerFromEthersWallet,
} from '@atum-labs/payment-gateway-client/signing';

const wallet = new Wallet(process.env.PRIVATE_KEY!);

// 1. Authorize the transfer. Fills every sender_auth.signed_messages[] entry, and attaches
//    payload.delegate_signer on chains whose signatures are not recoverable (Solana).
const authorized = await signPaymentRequest(request, createSenderSigner(/* ... */));

// 2. Attest the document.
const signed = await signDeclaration(authorized, signerFromEthersWallet(wallet), { chainId: 1 });

// 3. Submit.
await new PaymentGatewayClient({ BASE: gateway }).payments.submitPayment({ requestBody: signed });
```

## Check what you are signing

`signPaymentRequest` signs **every** entry in `sender_auth.signed_messages[]` as given, in both
the TypeScript and Go clients. The permit's spender, escrow and amounts come from the gateway's
chain defaults, and the signer has no notion of what you intended.

A Stellar message is the exception: a Stellar key signs 32 bytes with plain ed25519, which is also how
a transaction is signed (over its hash), so signing a message a requester chose could hand over a
transaction signature for the payer's account. `signPaymentRequest` therefore signs a Stellar message
only when it is the deposit digest of its own `message_prehash` under the request's source network and
`escrow_contract_address`, and refuses a Stellar key for a request whose source is another network
(`assertRequestSignable`). That proves the bytes are a deposit for the escrow the request names; it
does not decide that the escrow is the one you meant, which is what `verifyPaymentRequest` below is for.

Bind the signed permit to the terms **you** agreed before the request leaves your process.
`verifyPaymentRequest` recovers every `signed_messages[]` entry and checks the terms it commits
to:

```ts
import { verifyPaymentRequest } from '@atum-labs/payment-gateway-client/signing';

// Sign locally, then bind the result to your own terms before submitting.
const { recoveredAccount } = verifyPaymentRequest(signed, {
  sourceAsset: agreedTokenAddress,
  network: 'eip155:1',
  maxSourceAmount: agreedMaxAmount,
});
```

`sourceAsset` is the **bare token address**, not the CAIP-19 identifier used in the request's
`source.asset_identifier`. Passing the CAIP form fails to match.

**Pass those three fields.** Without them, `verifyPaymentRequest` takes the token, network and
amount from the request itself, which proves only that the signatures are consistent with the
request's own fields.

It always checks the payee: the deposit must commit to the request's own `destination` and
`request_id`, so a request whose payee or request id was changed after signing is refused.

If you hold the request as JSON text, call `verifyPaymentRequestJSON(json, expected)` instead. It
also refuses a repeated member name, including names that differ only in letter case, where it is
read: any top-level name, or inside `source`, `destination`, `request_id` or `sender_auth`.
On a refusal, `commitmentResultOf(error)` returns the outcome (for example
`destination_mismatch`) and both copies of the payee, ready to log. A verified entry carries the
same result as `results[i].commitment`.

**Contract-account payers.** `verifyPaymentRequest` recovers each signer, so it refuses a payer
that is a contract account (ERC-1271, such as a Safe): its signature comes from an owner key, never
from the account itself. For such a payer, call `verifyRequestCommitment(json)`. It checks the
payee and request id the deposit commits to without recovering the signer; Permit2 checks the
signature on chain when the deposit is made.

Every entry must be a bindable permit; a malformed entry throws. A caller with mixed messages
(for example an EVM setup approval alongside the permit) composes the per-entry adapter calls
itself.

In Go, `senderauth.VerifyRequestCommitment(raw, solanaDomain)` is the payee check alone,
`senderauth.VerifyPaymentRequestJSON(raw, expected)` and
`senderauth.VerifyPaymentRequest(request, expected)` run the same checks,
`senderauth.CommitmentResultOf(err)` reads the outcome from an error, and
`senderauth.GetChainAdapter(caip2).RecoverAndVerify(signed, source, commitment, expected)` checks
one signed message against a `CommitmentExpectation` built from the request's `destination` and
`request_id`.

A custodial signer is the natural place to enforce this: it is the component that can refuse.

## Verifying

`verifyDeclaration` **throws** on an invalid proof rather than returning a flag — a boolean can
be ignored by accident, an exception cannot. It also refuses a document whose signature recovers
a signer other than the one the document claims, which is what makes a tampered document fail
rather than verify as its original signer.

It returns a **discriminated** signer:

```ts
const { signer } = await verifyDeclaration(signed);

if (signer.kind === 'recovered-secp256k1') {
  // The address was recovered FROM the signature: self-evident proof of which key signed.
  console.log(signer.address);
} else {
  // Self-asserted: the ed25519 key came from the document itself. A successful verify proves
  // the signature matches that key — NOT that the key belongs to anyone in particular. Bind it
  // to a trusted source before relying on it.
}
```

## What the proof does and does not cover

The proof is computed over the **URDNA2015-canonicalized** document, so it is stable across key
reordering and whitespace, and it excludes signing artifacts and the deprecated credential
carriers.

One consequence worth knowing: **canonicalization drops terms the declaration `@context` does not
define.** A field this client's types do not model travels inside the signed document without
being covered by the proof, and can be altered without invalidating it. Making a new field
tamper-evident means adding it to the declaration context, not just to the payload.

Any `@context` on the input is **replaced** before hashing, so a caller-supplied one cannot
influence what gets signed.

## Contexts are local, always

JSON-LD contexts are compiled into the bundle. **Nothing is fetched over the network** — there is
no HTTP client in the signing libraries, and the JSON-LD processor is always handed the local
loader in place of its built-in fetcher. A document whose `@context` names an unregistered URL is
refused rather than resolved, since an attacker-served context could otherwise change what each
term means, and therefore what the signature covers.

For development against a modified snapshot, an environment variable can override the embedded
copies. It reads from local disk only, and the library reports it on first use when it is set.

## The identity envelope

**Prerequisite: at least one issuer-signed credential about the originator.** The schema rejects
an envelope without one.

`buildEnvelope` wraps the originator's issuer-signed credentials in a holder-signed
PaymentRequestEnvelope. It takes the same kind of signer as the other surfaces, so a custodial
key works here too.

```ts
import { buildEnvelopeForAccount, computeRequestHash, signerFromEthersWallet } from '@atum-labs/payment-gateway-client/signing';

const envelope = await buildEnvelopeForAccount('eip155:1', wallet.address.toLowerCase(), {
  holderVCs: [knownToAtumCredential],
  signer: signerFromEthersWallet(wallet),
  // The challenge is the request's content hash, which the gateway recomputes.
  challenge: await computeRequestHash(request),
  // The domain the gateway you are calling expects. It is compared exactly, so an envelope built
  // for one environment is rejected by another, and it is NOT derived from the gateway URL —
  // take it from that environment's configuration rather than assuming it.
  domain: envelopeDomainForYourEnvironment,
});
```

Three things the verifier enforces, so they are not optional:

- **At least one credential.** An empty bag is rejected.
- **The challenge binds one request** and **the domain binds one environment**. Both are checked
  against the values the gateway expects, so an envelope cannot be replayed across either.
- **The declaration type is bound into the signature**, not merely present in the document —
  editing the `type` array does not make a PaymentRequestEnvelope pass where a FulfillmentQuoteEnvelope is expected.

Sign the inner document with the **same key**: the gateway asserts the document's signer is
the envelope's holder, and rejects the pair otherwise.

## Session tokens

A session token identifies your wallet to the Payment Gateway. It is not a signature on a
PaymentRequest: it moves no funds, authorizes no transfer and attests no document.

**Prerequisite: the Known to Atum credential issued to your wallet during onboarding.**

`requestSessionToken` fetches a single-use nonce from the authorization service, signs a
presentation of your credentials that answers it, and exchanges the presentation for a bearer
token:

```ts
import { requestSessionToken, signerFromEthersWallet } from '@atum-labs/payment-gateway-client/signing';

const session = await requestSessionToken({
  authUrl: 'https://auth.production-testnet.atum.xyz',
  credentials: [knownToAtumCredential],
  signer: signerFromEthersWallet(wallet),
});

// Send it on your Payment Gateway requests as: Authorization: Bearer <session.accessToken>
```

- **The holder is the wallet your credentials are issued to.** Every credential must name the
  same holder, and the signer must be that wallet, or the call throws before anything is signed.
  Holders are EVM wallets (`did:pkh:eip155:<chain>:<address>`).
- **There is no refresh.** Request a new token before `expiresAt`. Each call is a new session with
  a fresh nonce, so retrying is calling again; never resend a presentation.
- **A refusal throws `SessionTokenError`**, carrying the HTTP `status`, the error `code` from the
  response and, when the service sent one, `retryAfterSeconds`.
- **Each call to the service is abandoned after `timeoutMs`**, 10 seconds unless you set it.

### Keeping a token current

For a client that runs longer than a token lives, `createSessionTokenSource` keeps one current.
Pass it to the gateway client as `session`, and every request carries the session:

```ts
import { PaymentGatewayClient } from '@atum-labs/payment-gateway-client';
import { createSessionTokenSource, signerFromEthersWallet } from '@atum-labs/payment-gateway-client/signing';

const session = createSessionTokenSource({
  authUrl: 'https://auth.production-testnet.atum.xyz',
  credentials: [knownToAtumCredential],
  signer: signerFromEthersWallet(wallet),
  onError: (error) => console.warn('session renewal failed', error),
});

const client = new PaymentGatewayClient({ session });
```

- **The token is bound to a key the source holds** (RFC 9449 DPoP), so a copy of it is of no use
  without that key. The source creates the key with its first session; its private half never
  leaves the process. Every request then carries `Authorization: DPoP <token>` and a fresh `DPoP`
  proof for that request's method and URL. Where the authorization service does not bind tokens,
  the token is a `Bearer` token and is sent as one. Pass `dpop: false` to never bind.
- **Point the client at the gateway URL the token names.** A proof names the request's URL, and
  the gateway accepts it only for its own address, so use the gateway's URL for your environment,
  not another host that reaches it.
- **Renewal happens in the background**, two minutes before the token expires (halfway through a
  shorter-lived one). The held token is still sent while the new one is requested.
- **A failed renewal never fails a gateway call.** The held token is sent while it is valid. Once
  none is valid, the request goes without one, as an anonymous caller. The source tries again no
  sooner than the service's `Retry-After`, or 10 seconds when it named none, and reports each
  failure to `onError`.
- **Concurrent calls share one renewal.**
- **A call made with no valid token waits for the session, for at most `maxWaitMs`** (2 seconds by
  default), and then goes without one while the renewal carries on in the background. So a slow or
  hanging authorization service never holds a payment back. `await session.token()` once at
  startup takes even that wait off the first request.

Don't pass `() => session.token()` as `TOKEN`. The source binds its tokens by default, and `TOKEN`
always sends `Authorization: Bearer`, so the gateway serves every call as anonymous, with no error.
`TOKEN` works only with `dpop: false`. Use `session`.

`signSessionPresentation` is the signing step on its own, for a client that fetches the nonce and
exchanges the presentation itself. `createDPoPKey` and `createDPoPProof` are the binding on its
own: pass the key to `requestSessionToken` as `dpop`, then send each request with
`Authorization: DPoP <accessToken>` and a proof made for it.
