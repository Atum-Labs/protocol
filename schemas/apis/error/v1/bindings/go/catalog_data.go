// Code generated from apis/error/v1/catalog.json by make generate-error. DO NOT EDIT.
package atumerror

const catalogJSON = `{
  "version": 1,
  "docs_base_url": "https://docs.atum.xyz/errors#",
  "fallback": {
    "public_code": "INTERNAL_ERROR",
    "public_message": "Something went wrong on our side. Quote the request id if you contact support, and check the payment before submitting a new request.",
    "http_status": 500,
    "docs_slug": "internal-error"
  },
  "entries": {
    "TX_REVERTED": {
      "public_code": "SETTLEMENT_FAILED",
      "public_message": "We couldn't complete the settlement for this payment. The on-chain outcome is not guaranteed, so reconcile by payment id before retrying.",
      "http_status": 502,
      "docs_slug": "settlement-failed",
      "retry_classification": "RECONCILE_THEN_DECIDE",
      "request_id_reusable": false
    },
    "NONCE_TOO_LOW": {
      "public_code": "SETTLEMENT_FAILED",
      "public_message": "We couldn't complete the settlement for this payment. The on-chain outcome is not guaranteed, so reconcile by payment id before retrying.",
      "http_status": 502,
      "docs_slug": "settlement-failed",
      "retry_classification": "RECONCILE_THEN_DECIDE",
      "request_id_reusable": false
    },
    "BROADCAST_REJECTED": {
      "public_code": "SETTLEMENT_FAILED",
      "public_message": "We couldn't complete the settlement for this payment. The on-chain outcome is not guaranteed, so reconcile by payment id before retrying.",
      "http_status": 502,
      "docs_slug": "settlement-failed",
      "retry_classification": "RECONCILE_THEN_DECIDE",
      "request_id_reusable": false
    },
    "DEPOSIT_INSUFFICIENT_FUNDS": {
      "public_code": "INSUFFICIENT_FUNDS",
      "public_message": "The paying account held less of the source token than this payment needs, so the deposit could not be funded and no funds were moved.",
      "http_status": 422,
      "docs_slug": "insufficient-funds",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": false
    },
    "DEPOSIT_MISSING_TOKEN_APPROVAL": {
      "public_code": "MISSING_TOKEN_APPROVAL",
      "public_message": "The paying account had not approved the Permit2 contract to transfer enough of the source token, so the deposit could not be funded and no funds were moved.",
      "http_status": 422,
      "docs_slug": "missing-token-approval",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": false
    },
    "QUOTE_DEADLINE_EXPIRED": {
      "public_code": "NO_QUOTES_RECEIVED",
      "public_message": "No settlement quotes were received within the auction window. This request_id is spent, so a new attempt needs a new one.",
      "http_status": 422,
      "docs_slug": "no-quotes-received",
      "retry_classification": "RETRY_WITH_NEW_IDENTIFIER",
      "request_id_reusable": false
    },
    "NO_SETTLER_FOR_CORRIDOR": {
      "public_code": "NO_SETTLER_FOR_CORRIDOR",
      "public_message": "No settlement provider currently serves this source and destination pair. This request_id is spent, so a new attempt needs a new one, and it will not succeed until a provider covers the pair.",
      "http_status": 422,
      "docs_slug": "no-settler-for-corridor",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": false
    },
    "QUOTE_SELECTION_FAILED": {
      "public_code": "QUOTES_EXPIRED",
      "public_message": "No settlement quote could be selected for this payment. Either the quotes received had expired by the award moment, or none was acceptable. This request_id is spent, so a new attempt needs a new one.",
      "http_status": 422,
      "docs_slug": "quotes-expired",
      "retry_classification": "RETRY_WITH_NEW_IDENTIFIER",
      "request_id_reusable": false
    },
    "SETTLER_GATEWAY_AT_CAPACITY": {
      "public_code": "SERVICE_BUSY",
      "public_message": "No capacity was available to start an auction for this request. This request_id is spent, so a new attempt needs a new one.",
      "http_status": 503,
      "docs_slug": "service-busy",
      "retry_classification": "RETRY_WITH_NEW_IDENTIFIER",
      "request_id_reusable": false
    },
    "INTERNAL_ERROR": {
      "public_code": "INTERNAL_ERROR",
      "public_message": "Something went wrong on our side, not with your request. Contact support and quote the request_id: https://discord.com/channels/1546918135892803724/1546951586348277841",
      "http_status": 500,
      "docs_slug": "internal-error",
      "retry_classification": "CONTACT_SUPPORT"
    },
    "SETTLER_GATEWAY_INTERNAL_ERROR": {
      "public_code": "SETTLEMENT_OUTCOME_UNKNOWN",
      "public_message": "Something went wrong on our side after settlement had started, so we cannot confirm whether funds moved. Reconcile this payment by payment id before submitting a new request.",
      "retry_classification": "RECONCILE_THEN_DECIDE",
      "http_status": 500,
      "docs_slug": "settlement-outcome-unknown",
      "request_id_reusable": false
    },
    "FULFILLMENT_DEADLINE_EXPIRED": {
      "public_code": "SETTLEMENT_FAILED",
      "public_message": "We couldn't complete the settlement for this payment. The on-chain outcome is not guaranteed, so reconcile by payment id before retrying.",
      "http_status": 502,
      "docs_slug": "settlement-failed",
      "retry_classification": "RECONCILE_THEN_DECIDE",
      "request_id_reusable": false
    },
    "INVALID_REQUEST": {
      "public_code": "INVALID_REQUEST",
      "public_message": "The request was malformed or missing required fields.",
      "http_status": 400,
      "docs_slug": "invalid-request",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "PAYLOAD_TOO_LARGE": {
      "public_code": "PAYLOAD_TOO_LARGE",
      "public_message": "The request body is too large.",
      "http_status": 413,
      "docs_slug": "payload-too-large",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "UNAUTHENTICATED": {
      "public_code": "UNAUTHENTICATED",
      "public_message": "Authentication is required, or the provided credentials are invalid.",
      "http_status": 401,
      "docs_slug": "unauthenticated",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "FORBIDDEN": {
      "public_code": "FORBIDDEN",
      "public_message": "You do not have permission to perform this action.",
      "http_status": 403,
      "docs_slug": "forbidden",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "RATE_LIMIT_EXCEEDED": {
      "public_code": "RATE_LIMIT_EXCEEDED",
      "public_message": "Too many requests from this caller, or too many unused nonces outstanding. Wait before trying again.",
      "http_status": 429,
      "docs_slug": "rate-limit-exceeded",
      "retry_classification": "RETRY_AFTER_DELAY",
      "request_id_reusable": true
    },
    "CHALLENGE_EXPIRED": {
      "public_code": "CHALLENGE_EXPIRED",
      "public_message": "The nonce or challenge in this presentation has expired or was not issued by this service. Sign a new presentation over a new one.",
      "http_status": 401,
      "docs_slug": "challenge-expired",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "CHALLENGE_REPLAYED": {
      "public_code": "CHALLENGE_REPLAYED",
      "public_message": "The nonce or challenge in this presentation was already used. Each one is accepted at most once, including by an attempt that was refused.",
      "http_status": 401,
      "docs_slug": "challenge-replayed",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "INVALID_PRESENTATION": {
      "public_code": "INVALID_PRESENTATION",
      "public_message": "The presentation could not be verified. It must be signed by its holder over the issued nonce or challenge and the expected domain.",
      "http_status": 401,
      "docs_slug": "invalid-presentation",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "TOKEN_EXPIRED": {
      "public_code": "TOKEN_EXPIRED",
      "public_message": "The session token has expired, was not issued by this service, or is past the session's time limit. Sign a new presentation to start a new session.",
      "http_status": 401,
      "docs_slug": "token-expired",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "CREDENTIAL_MISSING": {
      "public_code": "CREDENTIAL_MISSING",
      "public_message": "The presentation does not include a credential this endpoint requires, issued to the presentation's holder.",
      "http_status": 403,
      "docs_slug": "credential-missing",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "CREDENTIAL_UNTRUSTED": {
      "public_code": "CREDENTIAL_UNTRUSTED",
      "public_message": "A credential in the presentation was not issued by an issuer this service trusts.",
      "http_status": 403,
      "docs_slug": "credential-untrusted",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "IDENTITY_DENYLISTED": {
      "public_code": "IDENTITY_DENYLISTED",
      "public_message": "This identity is not permitted to authenticate. Authenticating again with this identity will be refused. Contact support and quote the request_id: https://discord.com/channels/1546918135892803724/1546951586348277841",
      "http_status": 403,
      "docs_slug": "identity-denylisted",
      "retry_classification": "CONTACT_SUPPORT",
      "request_id_reusable": true
    },
    "NOT_FOUND": {
      "public_code": "NOT_FOUND",
      "public_message": "The requested resource was not found.",
      "http_status": 404,
      "docs_slug": "not-found",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "CONFLICT": {
      "public_code": "CONFLICT",
      "public_message": "The request conflicts with the current state of the resource.",
      "http_status": 409,
      "docs_slug": "conflict",
      "retry_classification": "RECONCILE_THEN_DECIDE"
    },
    "NOT_YET_IMPLEMENTED": {
      "public_code": "NOT_IMPLEMENTED",
      "public_message": "This operation is not supported for this request. Contact support to find a supported way to make it: https://discord.com/channels/1546918135892803724/1546951586348277841",
      "http_status": 501,
      "docs_slug": "not-implemented",
      "retry_classification": "CONTACT_SUPPORT",
      "request_id_reusable": true
    },
    "MALFORMED_REQUEST_BODY": {
      "public_code": "MALFORMED_REQUEST_BODY",
      "public_message": "The request body could not be read or did not match the required schema. Check the JSON and required fields.",
      "http_status": 400,
      "docs_slug": "malformed-request-body",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "IDEMPOTENCY_TERMS_MISMATCH": {
      "public_code": "IDEMPOTENCY_TERMS_MISMATCH",
      "public_message": "This request_id was already used for a different request (accounts, assets, or amounts differ). Re-submitting a request_id retries the original, so each new request needs its own request_id.",
      "http_status": 409,
      "docs_slug": "idempotency-terms-mismatch",
      "retry_classification": "RETRY_WITH_NEW_IDENTIFIER",
      "request_id_reusable": false
    },
    "QUOTE_DEADLINE_NOT_FUTURE": {
      "public_code": "QUOTE_DEADLINE_NOT_FUTURE",
      "public_message": "quote_deadline must be a timestamp in the future.",
      "http_status": 400,
      "docs_slug": "quote-deadline-not-future",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "FULFILLMENT_DEADLINE_NOT_FUTURE": {
      "public_code": "FULFILLMENT_DEADLINE_NOT_FUTURE",
      "public_message": "fulfillment_deadline must be a timestamp in the future.",
      "http_status": 400,
      "docs_slug": "fulfillment-deadline-not-future",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "FULFILLMENT_DEADLINE_ORDER": {
      "public_code": "FULFILLMENT_DEADLINE_ORDER",
      "public_message": "fulfillment_deadline must be after quote_deadline.",
      "http_status": 400,
      "docs_slug": "fulfillment-deadline-order",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "INVALID_FULFILLMENT_AMOUNT": {
      "public_code": "INVALID_FULFILLMENT_AMOUNT",
      "public_message": "fulfillment_amount must be a positive integer in the asset smallest unit.",
      "http_status": 400,
      "docs_slug": "invalid-fulfillment-amount",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "INVALID_REQUEST_ID": {
      "public_code": "INVALID_REQUEST_ID",
      "public_message": "request_id may contain only letters, digits, underscore, hyphen, and dot.",
      "http_status": 400,
      "docs_slug": "invalid-request-id",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "INVALID_SOURCE_ASSET": {
      "public_code": "INVALID_SOURCE_ASSET",
      "public_message": "The source asset identifier is not a valid CAIP-19 asset.",
      "http_status": 400,
      "docs_slug": "invalid-source-asset",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "UNSUPPORTED_SOURCE_CHAIN": {
      "public_code": "UNSUPPORTED_SOURCE_CHAIN",
      "public_message": "The source chain is not supported.",
      "http_status": 400,
      "docs_slug": "unsupported-source-chain",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "INVALID_DESTINATION_ASSET": {
      "public_code": "INVALID_DESTINATION_ASSET",
      "public_message": "A destination asset identifier is not a valid CAIP-19 asset.",
      "http_status": 400,
      "docs_slug": "invalid-destination-asset",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "UNSUPPORTED_DESTINATION_CHAIN": {
      "public_code": "UNSUPPORTED_DESTINATION_CHAIN",
      "public_message": "A destination chain is not supported.",
      "http_status": 400,
      "docs_slug": "unsupported-destination-chain",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "UNSUPPORTED_SOURCE_ASSET": {
      "public_code": "UNSUPPORTED_SOURCE_ASSET",
      "public_message": "The source asset is not a supported token on its chain, so no settler can be offered this payment.",
      "http_status": 400,
      "docs_slug": "unsupported-source-asset",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "UNSUPPORTED_DESTINATION_ASSET": {
      "public_code": "UNSUPPORTED_DESTINATION_ASSET",
      "public_message": "A destination asset is not a supported token on its chain, or the payment gives fulfill to the originator and the destination token does not implement EIP-3009 transferWithAuthorization. No settler can be offered this payment.",
      "http_status": 400,
      "docs_slug": "unsupported-destination-asset",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "INVALID_DESTINATION_ACCOUNT": {
      "public_code": "INVALID_DESTINATION_ACCOUNT",
      "public_message": "A destination account is not a payable address on its destination chain. It must parse for that chain, carry a valid EIP-55 checksum when mixed-case, have no surrounding whitespace, and not be the zero address.",
      "http_status": 400,
      "docs_slug": "invalid-destination-account",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "INVALID_SOURCE_ACCOUNT": {
      "public_code": "INVALID_SOURCE_ACCOUNT",
      "public_message": "source.account is required and must not be empty or padded with whitespace.",
      "http_status": 400,
      "docs_slug": "invalid-source-account",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "MISSING_SENDER_AUTH": {
      "public_code": "MISSING_SENDER_AUTH",
      "public_message": "sender_auth is required for this endpoint.",
      "http_status": 400,
      "docs_slug": "missing-sender-auth",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "PAYMENT_ID_DERIVATION_FAILED": {
      "public_code": "PAYMENT_ID_DERIVATION_FAILED",
      "public_message": "The payment could not be identified from the request. Check sender_auth and its signed message.",
      "http_status": 400,
      "docs_slug": "payment-id-derivation-failed",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "MISSING_MESSAGE_PREHASH": {
      "public_code": "MISSING_MESSAGE_PREHASH",
      "public_message": "Every sender_auth signed message must carry its message_prehash.",
      "http_status": 400,
      "docs_slug": "missing-message-prehash",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "INVALID_FULFILLMENT_VERIFIER": {
      "public_code": "INVALID_FULFILLMENT_VERIFIER",
      "public_message": "fulfillment_verifier is required, with a non-empty account and an absolute endpoint URL. Use the value served by /v1/defaults.",
      "http_status": 400,
      "docs_slug": "invalid-fulfillment-verifier",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "INVALID_ESCROW_CONTRACT_ADDRESS": {
      "public_code": "INVALID_ESCROW_CONTRACT_ADDRESS",
      "public_message": "escrow_contract_address is required and must be the escrow served by /v1/defaults for the source chain.",
      "http_status": 400,
      "docs_slug": "invalid-escrow-contract-address",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "SENDER_AUTH_NOT_ALLOWED": {
      "public_code": "SENDER_AUTH_NOT_ALLOWED",
      "public_message": "sender_auth must be omitted on a quote request. It is supplied at award time.",
      "http_status": 400,
      "docs_slug": "sender-auth-not-allowed",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "AWARD_SENDER_AUTH_NOT_ALLOWED": {
      "public_code": "SENDER_AUTH_NOT_ALLOWED",
      "public_message": "sender_auth must be omitted on an award for a deposit the payer made directly.",
      "http_status": 400,
      "docs_slug": "sender-auth-not-allowed",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "MISSING_RESERVE_AUTH": {
      "public_code": "MISSING_RESERVE_AUTH",
      "public_message": "An award needs reserve_auth: the reserve message naming the chosen settler, signed by the reserver the deposit authorization names.",
      "http_status": 400,
      "docs_slug": "missing-reserve-auth",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "RESERVE_AUTH_NOT_ALLOWED": {
      "public_code": "RESERVE_AUTH_NOT_ALLOWED",
      "public_message": "reserve_auth must be omitted on an award for a deposit the payer made directly.",
      "http_status": 400,
      "docs_slug": "reserve-auth-not-allowed",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "RESERVE_AUTH_INVALID": {
      "public_code": "RESERVE_AUTH_INVALID",
      "public_message": "reserve_auth does not describe this award. Its message must name this deposit and the chosen quote's hash, settler and source_amount.",
      "http_status": 400,
      "docs_slug": "reserve-auth-invalid",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "AWARD_SIGNER_MISMATCH": {
      "public_code": "AWARD_SIGNER_MISMATCH",
      "public_message": "reserve_auth is not signed by the reserver the deposit authorization names.",
      "http_status": 401,
      "docs_slug": "award-signer-mismatch",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "RESERVER_MISMATCH": {
      "public_code": "RESERVER_MISMATCH",
      "public_message": "The deposit authorization names a reserver other than the quote request's quote_selector.",
      "http_status": 400,
      "docs_slug": "reserver-mismatch",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "PERMIT_AMOUNT_MISMATCH": {
      "public_code": "PERMIT_AMOUNT_MISMATCH",
      "public_message": "The deposit authorization's amount must equal the chosen quote's source_amount.",
      "http_status": 400,
      "docs_slug": "permit-amount-mismatch",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "PERMIT_TOKEN_MISMATCH": {
      "public_code": "PERMIT_TOKEN_MISMATCH",
      "public_message": "The deposit authorization's token must be the quote request's source asset.",
      "http_status": 400,
      "docs_slug": "permit-token-mismatch",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "AWARD_PRESENTATION_INVALID": {
      "public_code": "UNAUTHENTICATED",
      "public_message": "The award presentation could not be verified. It must be signed by the originator and bound to this award.",
      "http_status": 401,
      "docs_slug": "unauthenticated",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "AWARD_PRESENTATION_REQUIRED": {
      "public_code": "UNAUTHENTICATED",
      "public_message": "This award needs a presentation signed by the originator and bound to this award.",
      "http_status": 401,
      "docs_slug": "unauthenticated",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "QUOTE_REQUEST_NOT_FOUND": {
      "public_code": "QUOTE_REQUEST_NOT_FOUND",
      "public_message": "No quote request with this quote_request_id exists for this originator.",
      "http_status": 404,
      "docs_slug": "quote-request-not-found",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "QUOTE_NOT_FOUND": {
      "public_code": "QUOTE_NOT_FOUND",
      "public_message": "The quote request holds no quote with this quote_id.",
      "http_status": 404,
      "docs_slug": "quote-not-found",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "QUOTE_REQUEST_ALREADY_AWARDED": {
      "public_code": "QUOTE_REQUEST_ALREADY_AWARDED",
      "public_message": "A quote from this quote request has already been awarded, and a quote request accepts one award. Its payment is listed on the quote request's status.",
      "http_status": 409,
      "docs_slug": "quote-request-already-awarded",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "AWARD_QUOTE_EXPIRED": {
      "public_code": "QUOTES_EXPIRED",
      "public_message": "The chosen quote's award_deadline has passed, or is too close to award the quote before it does. Award a quote that is still open, or open a new quote request.",
      "http_status": 422,
      "docs_slug": "quotes-expired",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "AWARD_IDEMPOTENCY_TERMS_MISMATCH": {
      "public_code": "IDEMPOTENCY_TERMS_MISMATCH",
      "public_message": "This request_id was already used for a different award or payment (quote_request_id or quote_id differ). Re-sending a request_id returns the original, so each new award needs its own request_id.",
      "http_status": 409,
      "docs_slug": "idempotency-terms-mismatch",
      "retry_classification": "RETRY_WITH_NEW_IDENTIFIER",
      "request_id_reusable": false
    },
    "QUOTE_SELECTOR_NOT_ALLOWED": {
      "public_code": "QUOTE_SELECTOR_NOT_ALLOWED",
      "public_message": "quote_selector must not name the gateway's own selector. Name the account that signs the reserve, normally source.account.",
      "http_status": 400,
      "docs_slug": "quote-selector-not-allowed",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "MISSING_QUOTE_SELECTOR": {
      "public_code": "MISSING_QUOTE_SELECTOR",
      "public_message": "A quote request needs quote_selector: the account that signs the award's reserve, normally source.account.",
      "http_status": 400,
      "docs_slug": "missing-quote-selector",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "MISSING_DESTINATION": {
      "public_code": "MISSING_DESTINATION",
      "public_message": "At least one destination is required.",
      "http_status": 400,
      "docs_slug": "missing-destination",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "MISSING_REQUEST_ID_PARAM": {
      "public_code": "MISSING_REQUEST_ID_PARAM",
      "public_message": "The request_id query parameter is required.",
      "http_status": 400,
      "docs_slug": "missing-request-id-param",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "AUTHORIZATION_DECLINED": {
      "public_code": "AUTHORIZATION_DECLINED",
      "public_message": "This payment was declined during authorization. The reason is not included in this response. Contact support and quote the request_id: https://discord.com/channels/1546918135892803724/1546951586348277841",
      "http_status": 403,
      "docs_slug": "authorization-declined",
      "retry_classification": "CONTACT_SUPPORT"
    },
    "AMOUNT_LIMIT_EXCEEDED": {
      "public_code": "AMOUNT_LIMIT_EXCEEDED",
      "public_message": "This payment is over the per-payment amount limit for the paying account. Sending the same payment again will be refused. Contact support to ask about a higher limit: https://discord.com/channels/1546918135892803724/1546951586348277841",
      "http_status": 403,
      "docs_slug": "amount-limit-exceeded",
      "retry_classification": "CONTACT_SUPPORT"
    },
    "VOLUME_LIMIT_EXCEEDED": {
      "public_code": "VOLUME_LIMIT_EXCEEDED",
      "public_message": "This payment would take the paying account over its daily limit. The daily total resets at 00:00 UTC. Submit a new payment for this transfer after 00:00 UTC.",
      "http_status": 403,
      "docs_slug": "volume-limit-exceeded",
      "retry_classification": "RETRY_AFTER_DELAY"
    },
    "AUTHORIZATION_UNAVAILABLE": {
      "public_code": "AUTHORIZATION_UNAVAILABLE",
      "public_message": "This payment could not be authorized because a check could not be completed. It was not declined.",
      "http_status": 503,
      "docs_slug": "authorization-unavailable",
      "retry_classification": "RETRY_AFTER_DELAY",
      "request_id_reusable": true
    },
    "PAYMENT_EXPIRED": {
      "public_code": "PAYMENT_EXPIRED",
      "public_message": "This payment has expired and is no longer available.",
      "http_status": 404,
      "docs_slug": "payment-expired",
      "retry_classification": "RECONCILE_THEN_DECIDE",
      "request_id_reusable": false
    },
    "AUTH_SERVICE_UNAVAILABLE": {
      "public_code": "SERVICE_BUSY",
      "public_message": "The service is temporarily busy.",
      "http_status": 503,
      "docs_slug": "service-busy",
      "retry_classification": "RETRY_AFTER_DELAY",
      "request_id_reusable": true
    },
    "FULFILLMENT_VERIFIER_UNAVAILABLE": {
      "public_code": "SERVICE_BUSY",
      "public_message": "The service is temporarily busy.",
      "http_status": 503,
      "docs_slug": "service-busy",
      "retry_classification": "RETRY_AFTER_DELAY"
    },
    "SERVICE_PAUSED": {
      "public_code": "SERVICE_PAUSED",
      "public_message": "This operation is temporarily paused. Nothing was signed or submitted for this request.",
      "retry_classification": "RETRY_AFTER_DELAY",
      "http_status": 503,
      "docs_slug": "service-paused",
      "request_id_reusable": true
    },
    "SERVICE_UNAVAILABLE": {
      "public_code": "SERVICE_BUSY",
      "public_message": "The service is temporarily busy.",
      "http_status": 503,
      "docs_slug": "service-busy",
      "retry_classification": "RETRY_AFTER_DELAY",
      "request_id_reusable": true
    },
    "WALLET_INVALID_CONFIGURATION": {
      "public_code": "INTERNAL_ERROR",
      "public_message": "Something went wrong on our side, not with your request. Contact support and quote the request_id: https://discord.com/channels/1546918135892803724/1546951586348277841",
      "http_status": 500,
      "docs_slug": "internal-error",
      "retry_classification": "CONTACT_SUPPORT",
      "request_id_reusable": true
    },
    "WALLET_BLOCKCHAIN_SIGNER_ERROR": {
      "public_code": "INTERNAL_ERROR",
      "public_message": "Something went wrong on our side, not with your request. Contact support and quote the request_id: https://discord.com/channels/1546918135892803724/1546951586348277841",
      "http_status": 500,
      "docs_slug": "internal-error",
      "retry_classification": "CONTACT_SUPPORT"
    },
    "WALLET_IDENTITY_PROVIDER_ERROR": {
      "public_code": "INTERNAL_ERROR",
      "public_message": "Something went wrong on our side, not with your request. Contact support and quote the request_id: https://discord.com/channels/1546918135892803724/1546951586348277841",
      "http_status": 500,
      "docs_slug": "internal-error",
      "retry_classification": "CONTACT_SUPPORT",
      "request_id_reusable": true
    },
    "WALLET_KMS_ERROR": {
      "public_code": "INTERNAL_ERROR",
      "public_message": "Something went wrong on our side, not with your request. Contact support and quote the request_id: https://discord.com/channels/1546918135892803724/1546951586348277841",
      "http_status": 500,
      "docs_slug": "internal-error",
      "retry_classification": "CONTACT_SUPPORT"
    },
    "WALLET_PAYMENT_GATEWAY_ERROR": {
      "public_code": "INTERNAL_ERROR",
      "public_message": "Something went wrong on our side, not with your request. Contact support and quote the request_id: https://discord.com/channels/1546918135892803724/1546951586348277841",
      "http_status": 500,
      "docs_slug": "internal-error",
      "retry_classification": "CONTACT_SUPPORT"
    },
    "WALLET_DATABASE_ERROR": {
      "public_code": "INTERNAL_ERROR",
      "public_message": "Something went wrong on our side, not with your request. Contact support and quote the request_id: https://discord.com/channels/1546918135892803724/1546951586348277841",
      "http_status": 500,
      "docs_slug": "internal-error",
      "retry_classification": "CONTACT_SUPPORT"
    },
    "INVALID_AMOUNT": {
      "public_code": "INVALID_REQUEST",
      "public_message": "An amount in this request is not valid. It must be a positive integer expressed in the chain's smallest unit.",
      "http_status": 400,
      "docs_slug": "invalid-request",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "CHAIN_NOT_SUPPORTED": {
      "public_code": "NOT_FOUND",
      "public_message": "The requested chain is not supported.",
      "http_status": 404,
      "docs_slug": "not-found",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "PUBLIC_KEY_DERIVATION_FAILED": {
      "public_code": "INTERNAL_ERROR",
      "public_message": "Something went wrong on our side, not with your request. Contact support and quote the request_id: https://discord.com/channels/1546918135892803724/1546951586348277841",
      "http_status": 500,
      "docs_slug": "internal-error",
      "retry_classification": "CONTACT_SUPPORT",
      "request_id_reusable": true
    },
    "FULFILLMENT_VERIFICATION_UNAVAILABLE": {
      "public_code": "INTERNAL_ERROR",
      "public_message": "Fulfillment verification is temporarily unavailable for this chain.",
      "retry_classification": "RETRY_AFTER_DELAY",
      "http_status": 500,
      "docs_slug": "internal-error",
      "request_id_reusable": true
    },
    "SIGNATURE_GENERATION_FAILED": {
      "public_code": "SIGNATURE_GENERATION_FAILED",
      "public_message": "We could not sign this request on our side. It was not caused by your request. Contact support and quote the request_id: https://discord.com/channels/1546918135892803724/1546951586348277841",
      "http_status": 500,
      "docs_slug": "signature-generation-failed",
      "retry_classification": "CONTACT_SUPPORT",
      "request_id_reusable": true
    },
    "EVENT_NOT_FOUND": {
      "public_code": "EVENT_NOT_FOUND",
      "public_message": "No matching on-chain event has been observed yet.",
      "http_status": 425,
      "docs_slug": "event-not-found",
      "retry_classification": "POLL_FOR_COMPLETION",
      "request_id_reusable": true
    },
    "INSUFFICIENT_CONFIRMATIONS": {
      "public_code": "INSUFFICIENT_CONFIRMATIONS",
      "public_message": "The transaction does not yet have enough confirmations.",
      "http_status": 400,
      "docs_slug": "insufficient-confirmations",
      "retry_classification": "POLL_FOR_COMPLETION",
      "request_id_reusable": true
    },
    "AMOUNT_MISMATCH": {
      "public_code": "AMOUNT_MISMATCH",
      "public_message": "The on-chain amount does not match the expected amount.",
      "http_status": 400,
      "docs_slug": "amount-mismatch",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "TRANSACTION_NOT_FOUND": {
      "public_code": "TRANSACTION_NOT_FOUND",
      "public_message": "The transaction could not be found on-chain.",
      "http_status": 400,
      "docs_slug": "transaction-not-found",
      "retry_classification": "RETRY_AFTER_DELAY",
      "request_id_reusable": true
    },
    "VERIFICATION_TIMEOUT": {
      "public_code": "VERIFICATION_TIMEOUT",
      "public_message": "On-chain verification timed out before a result was available.",
      "http_status": 400,
      "docs_slug": "verification-timeout",
      "retry_classification": "RETRY_AFTER_DELAY",
      "request_id_reusable": true
    },
    "COUNTERPARTY_NOT_FOUND": {
      "public_code": "COUNTERPARTY_NOT_FOUND",
      "public_message": "No counterparty is registered to authorize this payment.",
      "http_status": 404,
      "docs_slug": "counterparty-not-found",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "COUNTERPARTY_TIMEOUT": {
      "public_code": "COUNTERPARTY_TIMEOUT",
      "public_message": "The counterparty did not respond within the timeout window.",
      "http_status": 504,
      "docs_slug": "counterparty-timeout",
      "retry_classification": "RECONCILE_THEN_DECIDE"
    },
    "COUNTERPARTY_WEBHOOK_ERROR": {
      "public_code": "WEBHOOK_ERROR",
      "public_message": "The counterparty's webhook returned an unexpected status while processing this authorization. That is not a decline, and it does not tell us whether they acted on the request.",
      "http_status": 502,
      "docs_slug": "webhook-error",
      "retry_classification": "RECONCILE_THEN_DECIDE"
    },
    "COUNTERPARTY_WEBHOOK_CONNECTION_ERROR": {
      "public_code": "WEBHOOK_CONNECTION_ERROR",
      "public_message": "The counterparty could not be reached.",
      "http_status": 502,
      "docs_slug": "webhook-connection-error",
      "retry_classification": "RECONCILE_THEN_DECIDE"
    },
    "CONFLICT_REQUEST_ID_OWNED": {
      "public_code": "REQUEST_ID_TAKEN",
      "public_message": "This request_id is already in use by another account. Submit this payment with a new request_id.",
      "http_status": 409,
      "docs_slug": "request-id-taken",
      "retry_classification": "RETRY_WITH_NEW_IDENTIFIER",
      "request_id_reusable": false
    },
    "CONFLICT_IN_PROGRESS": {
      "public_code": "PAYMENT_IN_PROGRESS",
      "public_message": "This payment is still being processed. Poll its status until it reaches a terminal state rather than submitting again.",
      "http_status": 409,
      "docs_slug": "payment-in-progress",
      "retry_classification": "POLL_FOR_COMPLETION",
      "request_id_reusable": false
    },
    "CONFLICT_ALREADY_SETTLED": {
      "public_code": "ALREADY_SETTLED",
      "public_message": "This payment has already settled. Read its status rather than submitting it again.",
      "http_status": 409,
      "docs_slug": "already-settled",
      "retry_classification": "ALREADY_DONE",
      "request_id_reusable": false
    },
    "CONFLICT_DUPLICATE_INTENT": {
      "public_code": "DUPLICATE_INTENT",
      "public_message": "This request duplicates a payment that is already being processed. The outcome of that payment is not guaranteed, so reconcile by payment id before retrying.",
      "http_status": 409,
      "docs_slug": "duplicate-intent",
      "retry_classification": "RECONCILE_THEN_DECIDE",
      "request_id_reusable": false
    },
    "CONFLICT_DUPLICATE_INTENT_RECOVERY": {
      "public_code": "DUPLICATE_INTENT",
      "public_message": "This request duplicates an already-processed payment. The on-chain outcome is not guaranteed, so reconcile by payment id before retrying.",
      "http_status": 409,
      "docs_slug": "duplicate-intent",
      "retry_classification": "RECONCILE_THEN_DECIDE",
      "request_id_reusable": false
    },
    "SETTLER_REPORTED_ERROR": {
      "public_code": "SETTLEMENT_FAILED",
      "public_message": "We couldn't complete the settlement for this payment. The on-chain outcome is not guaranteed, so reconcile by payment id before retrying.",
      "http_status": 502,
      "docs_slug": "settlement-failed",
      "retry_classification": "RECONCILE_THEN_DECIDE",
      "request_id_reusable": false
    },
    "METHOD_NOT_ALLOWED": {
      "public_code": "METHOD_NOT_ALLOWED",
      "public_message": "That HTTP method is not allowed on this path. The path exists, so check the method rather than the URL.",
      "http_status": 405,
      "docs_slug": "method-not-allowed",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "request_id_reusable": true
    },
    "VERDICT_ALREADY_FINAL": {
      "public_code": "VERDICT_ALREADY_FINAL",
      "public_message": "The opposite outcome for this payment was already authorized and is final. Read the payment's status rather than asking again.",
      "http_status": 409,
      "docs_slug": "verdict-already-final",
      "retry_classification": "ALREADY_DONE",
      "request_id_reusable": false
    }
  }
}
`
