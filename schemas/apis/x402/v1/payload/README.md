# AtumEscrowPayload (v1)

The `PAYMENT-SIGNATURE` credential body for the `atum-escrow` x402 scheme — a v2
`PaymentPayload` whose `accepted` echoes the selected 402 requirement and whose
`payload.paymentRequest` is the signed payment request.

The inner `paymentRequest` conforms to the canonical `PaymentRequest` declaration
(`declarations/PaymentRequest/v1`); this schema constrains only the fields the
facilitator checks (`source`, `destination`, amounts, deadlines, the
`sender_auth`, and the `presentation`) and stays permissive about the rest, so a
full payment request validates without being restated here.

## Identity binding (PRE)

`payload.paymentRequest.presentation` is the **PaymentRequestEnvelope** (PRE): a
holder-signed W3C Verifiable Presentation carrying issuer-signed credentials about
the payer, conforming to `declarations/PaymentRequestEnvelope/v1`. It binds the
request to the payer's identity so no party can redirect the payment after signing:
the `sender_auth` alone commits only to the source side, while the PRE's
proof `challenge` is the request's `request_hash` (the content hash of the whole
request, including `destination`).

The PRE is **required for atum-escrow conformance**, and the facilitator re-verifies
it on `/verify`: `proofPurpose` is `authentication`, `proof.challenge` equals the
request's `request_hash`, `proof.domain` is the network-wide verifier identifier
(`did:web:<env>.atum.network`), and `holder` equals `source.account`. It is optional
at the JSON-Schema level so a request may be validated before the envelope is
attached; presence is enforced by the facilitator, not by the schema.

`schema.json` is the source of truth; `example.json` is validated against it.
