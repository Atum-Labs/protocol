# Atum Auth Service API v1

## Overview

The auth service has two surfaces, both in [`openapi.yaml`](./openapi.yaml):

| Surface | Endpoints | Called by | Status |
| --- | --- | --- | --- |
| Payment authorization | `POST /v1/payment-request` | the payment gateway | Served |
| Session authentication | `POST /v1/auth/nonce`, `POST /v1/auth/token` | integrators | **Frozen**. Served where session authentication is enabled |

Payment authorization answers with the decision. When the per-payment amount limit is the
one check that declined the payment, the answer also carries `decline_reason`
`AMOUNT_LIMIT`, which the payment gateway returns to its caller as `AMOUNT_LIMIT_EXCEEDED`.
Every other decline carries no reason, including a compliance decline alongside the limit,
so a compliance decline is never reported as a limit.

Session authentication lets a caller that holds a `did:pkh` wallet key get a short-lived
bearer token for the API gateway without any new key material. The caller signs a
Verifiable Presentation (VP) over a single-use nonce and exchanges it for a session token,
using OAuth 2.0 Token Exchange ([RFC 8693](https://www.rfc-editor.org/rfc/rfc8693)).

The session contract, every path under `/v1/auth/`, is frozen: integrators and the API
gateway build against it, so a change to it must be backward compatible. CI enforces that
with `make -C schemas breaking-auth-session`, which compares only those paths against
`main`. The rest of this spec is internal and is not frozen.

The two endpoints are served together or not at all. A deployment that has not enabled
session authentication answers both with `404 NOT_FOUND`.

## Structure

| Path | What it is |
| --- | --- |
| `openapi.yaml` | The contract. Hand-written. |
| `bindings/go` | Package `auth`: request and response types, an HTTP client, and a gin `ServerInterface`. Generated. |

Regenerate the bindings with `make -C schemas/apis generate-go-bindings`. CI fails the
build if the committed bindings differ from what the spec generates
(`make -C schemas check-api-bindings`).

The bindings depend on `github.com/oapi-codegen/runtime` v1.4.1, which the generated client
uses to encode the `/token` form body, and on gin v1.10.1. Both are pinned, so regenerating
cannot float them. A consumer that picks up this version through its protocol pin has to
run `go mod tidy` in its own module and commit the resulting `go.mod` and `go.sum`. For
atum-core's `auth`, that adds `oapi-codegen/runtime` v1.4.1 and
`apapsch/go-jsonmerge/v2` v2.0.0 as indirect dependencies. Until it is committed, `go build`
there fails; the exact message depends on the Go version.

## The session flow

This spec defines the door for callers that build their own VP. A second door, where the
service prepares the presentation and the caller only signs it, will be added to this spec
separately; `/token` already reserves its token type.

1. **Get a nonce.** The request is a `POST` with no body.

   ```sh
   curl -s -X POST "$AUTH/v1/auth/nonce"
   ```

   ```json
   {
     "nonce": "PqjJ4-GGgFV6VHW8hkXE_yJPRKtTbH58ahbdCxSmZiE",
     "expected_domain": "did:web:auth.production-testnet.atum.xyz",
     "expires_in": 300
   }
   ```

   `nonce` is 32 random bytes, base64url without padding, so always 43 characters.
   `expected_domain` names the deployment, so a VP built for testnet is refused by mainnet.
   The response is `Cache-Control: no-store`.

   It is a `POST` because issuing a nonce creates state, and each caller may hold only a
   limited number of unused nonces. A `GET` can be sent without the caller asking for it, by
   a prefetcher, a crawler, or an HTTP client that retries an idempotent request on its own
   (Go's `http.Transport` does), and each of those would use up one of the caller's nonces.
   The OpenID4VCI nonce endpoint is also a `POST` with no body. Any body sent is ignored.

2. **Build and sign the VP** with the holder's key:

   ```json
   {
     "@context": ["https://www.w3.org/2018/credentials/v1", "..."],
     "type": ["VerifiablePresentation"],
     "holder": "did:pkh:eip155:1:<address>",
     "verifiableCredential": ["<a KnownToAtumVerifiableCredential issued to the holder>"],
     "proof": {
       "type": "EcdsaSecp256k1RecoverySignature2020",
       "created": "2026-10-01T09:00:00.000Z",
       "verificationMethod": "did:pkh:eip155:1:<address>#blockchainAccountId",
       "proofPurpose": "authentication",
       "challenge": "<nonce>",
       "domain": "<expected_domain>",
       "jws": "<signature>"
     }
   }
   ```

   `proof.challenge` is the nonce and `proof.domain` is `expected_domain`, both copied
   verbatim. The VP must carry an unexpired `KnownToAtumVerifiableCredential` whose subject
   is the holder, from an issuer the service trusts. The issuer is compared with the trusted
   issuers before anything about it is resolved, so an untrusted issuer is refused as
   `CREDENTIAL_UNTRUSTED` without its DID document being fetched.

3. **Exchange it** before `expires_in` runs out:

   ```sh
   curl -s "$AUTH/v1/auth/token" \
     --data-urlencode grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
     --data-urlencode subject_token_type=urn:atum:params:oauth:token-type:ldp_vp \
     --data-urlencode subject_token@vp.json
   ```

   ```json
   {
     "access_token": "<session token>",
     "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
     "token_type": "Bearer",
     "expires_in": 14400
   }
   ```

   Send `access_token` as `Authorization: Bearer <access_token>`.

The nonce is consumed as soon as `/token` reads the VP, before anything is verified, so a
refused attempt uses it up too. Get a new nonce for every attempt.

## `POST /v1/auth/token`

**Frozen.** The request and response shapes, the token-type URNs and the error codes below
are the contract, so clients and the API gateway can build against them. It is served
exactly where `/nonce` is, and answers `404 NOT_FOUND` where session authentication is off.

The body is `application/x-www-form-urlencoded`, as RFC 6749 requires of a token endpoint.

| Parameter | Required | Value |
| --- | --- | --- |
| `grant_type` | yes | `urn:ietf:params:oauth:grant-type:token-exchange` |
| `subject_token` | yes | See `subject_token_type`. At most 65536 bytes as UTF-8, before form encoding. |
| `subject_token_type` | yes | One of the three types below. |
| `requested_token_type` | no | `urn:ietf:params:oauth:token-type:access_token`, or omitted. |

`resource`, `audience`, `scope`, `actor_token` and `actor_token_type` are refused with
`400 INVALID_REQUEST` when sent with a value that is not empty: the token has one fixed
audience and scope, and there is no delegation or impersonation. The rest follows RFC 6749
section 3.2:

- A parameter sent with an empty value is treated as omitted, so `scope=` is accepted.
- One of the four parameters above sent more than once is refused with
  `400 INVALID_REQUEST`, even when the values agree.
- Any other parameter is ignored.

The body is at most 262144 bytes (256 KiB); a larger one gets `413 PAYLOAD_TOO_LARGE`. That
admits any request that sends only the accepted parameters with a `subject_token` within
its limit, even if every byte of it is percent-encoded.

### Token types

| `subject_token_type` | `subject_token` | Status |
| --- | --- | --- |
| `urn:atum:params:oauth:token-type:ldp_vp` | A VP the caller built, as JSON text. | Accepted. |
| `urn:ietf:params:oauth:token-type:access_token` | The current, unexpired session token, to refresh it. | Reserved: `400 INVALID_REQUEST` until refresh ships. |
| `urn:atum:params:oauth:token-type:prepared_vp` | The holder's signature over a VP the service prepared. | Reserved: `400 INVALID_REQUEST` until the server-prepared door ships. That change also defines this value's encoding. |

Why these values:

- **`ldp_vp`** is the [DIF claim format designation](https://identity.foundation/claim-format-registry/)
  for a W3C VP secured with an embedded Data Integrity (Linked Data) proof, which is exactly
  what this door takes. Naming the securing mechanism leaves room for a `jwt_vp` or SD-JWT
  type beside it, rather than having one generic `vp` type mean different things later.
- **`access_token` for refresh** is the RFC 8693 type for "an OAuth access token issued by
  this authorization server". The more general `urn:ietf:params:oauth:token-type:jwt` would
  also describe a JWT from any other issuer, which is not what a refresh accepts. The same
  URN is the response's `issued_token_type`, so a response can be exchanged again as it
  stands. `refresh_token` is not used because none is issued or stored.
- **URNs, not `https://` URLs.** RFC 8693 allows any URI. A URN does not depend on a DNS
  name, so a future move between Atum domains cannot change or break these values.
  `urn:atum:params:oauth:token-type:` mirrors the shape of the IETF prefix. `atum` is not an
  IANA-registered URN namespace (RFC 8141). That does not matter here, because the values
  are only ever compared as opaque strings. This is the first normative use of `urn:atum:`
  in this repository; until now it appeared only in an example credential id.

### Refresh

A refresh is a new exchange, not a refresh-token grant. The caller sends its current,
unexpired session token as `subject_token` with type
`urn:ietf:params:oauth:token-type:access_token` and gets a new one. Refresh is reserved: it
is refused with `400 INVALID_REQUEST` until it ships.

A refresh re-checks the denylist and re-reads the caller's tier records, as the first
exchange did. It carries no VP, so it cannot re-check the credential: the
`KnownToAtumVerifiableCredential`'s expiry, issuer and proof are checked only in the
exchange that began the session, and a refresh does not see a later change to them, such
as the issuer no longer being trusted. That is why the credential's expiry bounds the
session.

A session's absolute lifetime ends at the earlier of:

- 24 hours after the exchange of the VP that began it;
- the `expirationDate` of the `KnownToAtumVerifiableCredential` presented in that exchange.
  A credential with no `expirationDate` leaves only the 24-hour bound.

No token outlives the session, so a token issued close to its end, including a first token
whose credential expires soon, has a shorter `expires_in`. A refresh after the end is
refused with `TOKEN_EXPIRED`, and the caller then needs a new nonce and a new VP.

The per-token lifetime is configuration, not contract. The intended value is about 4 to 6
hours. Read `expires_in` rather than assuming it.

### Errors

Every error is the shared `ErrorResponse` from [`error/v1`](../../error/v1/README.md), with
a catalog code. It is not an RFC 6749 section 5.2 body: there is no `error` member, so
branch on `code`. The HTTP status follows the catalog, so a refused VP is a `401` or `403`
where an RFC 6749 server would send `400`. The spec's `POST /v1/auth/token` description
maps each code to its RFC 6749 or RFC 8693 equivalent.

A `401` carries no `WWW-Authenticate` header. RFC 9110 section 15.5.2 requires one, and this
is a deliberate deviation: the caller authenticates with the VP in the body, not with an
HTTP authentication scheme, so there is no scheme for a challenge to name.

A `429` can also come from the network edge in front of the service, and that response may
have no `ErrorResponse` body and no `Retry-After`. Treat every `429` the same way: wait for
`Retry-After` when it is sent, and otherwise back off.

After a `500` or `503` from `/token`, the nonce may have been consumed. Get a new nonce and
sign a new VP before sending again. That instruction overrides the response's
`retry_classification`, which describes the code in general rather than this endpoint.
Sending the same VP again does no harm: if its nonce was consumed, it is refused with
`CHALLENGE_REPLAYED` or `CHALLENGE_EXPIRED`.

| Code | Status | Endpoint | Meaning |
| --- | --- | --- | --- |
| `INVALID_REQUEST` | 400 | `/token` | A missing, repeated or disallowed parameter, a `subject_token` over its limit, or a reserved token type. No nonce was consumed. |
| `MALFORMED_REQUEST_BODY` | 400 | `/token` | The body could not be read as a form. No nonce was consumed. |
| `CHALLENGE_EXPIRED` | 401 | `/token` | The nonce has expired, or this service did not issue it. |
| `CHALLENGE_REPLAYED` | 401 | `/token` | The nonce was already consumed. A nonce consumed long enough ago reads as `CHALLENGE_EXPIRED` instead. |
| `INVALID_PRESENTATION` | 401 | `/token` | The VP could not be read or verified: signature, holder, `proof.domain`, or the proof of a credential from a trusted issuer. |
| `TOKEN_EXPIRED` | 401 | `/token` | On a refresh, once refresh ships: the session token is expired, was not issued by this service, or is past the session's absolute lifetime. Start a new session. |
| `CREDENTIAL_MISSING` | 403 | `/token` | No unexpired `KnownToAtumVerifiableCredential` whose subject is the holder. |
| `CREDENTIAL_UNTRUSTED` | 403 | `/token` | A required credential is from an issuer the service does not trust. The issuer is not resolved. |
| `IDENTITY_DENYLISTED` | 403 | `/token` | This identity may not authenticate. No reason is given. |
| `NOT_FOUND` | 404 | both | Session authentication is off on this deployment. |
| `PAYLOAD_TOO_LARGE` | 413 | `/token` | The body is over 262144 bytes. No nonce was consumed. |
| `RATE_LIMIT_EXCEEDED` | 429 | both | Too many requests from this caller, or on `/nonce` too many unused nonces. `Retry-After` is sent when the wait is known. |
| `INTERNAL_ERROR` | 500 | both | An unexpected failure. On `/token` the nonce may have been consumed. |
| `SERVICE_BUSY` | 503 | both | The service cannot serve the request now. `Retry-After` is sent when the wait is known. On `/token` the nonce may have been consumed. |

## Not fixed by this contract

These are settled when `/token` first ships, not here:

- The JSON-LD contexts and proof suites a VP may use. The example above shows the suite in
  use today.
- The session token's claims, signing algorithm and key id. The API gateway validates the
  token against the service's published JWKS.
- The per-token lifetime and the nonce lifetime. Both arrive as `expires_in`. The session's
  absolute lifetime is fixed above.
- The authorization server metadata (RFC 8414), which is also meant to publish
  `expected_domain`, and `/.well-known/jwks.json`, the JWKS the API gateway validates
  tokens against. Neither is in this spec yet.
