// Code generated from apis/decline/v1/catalog.json by make generate-decline. DO NOT EDIT.
package atumdecline

const catalogJSON = `{
  "version": 1,
  "docs_base_url": "https://docs.atum.xyz/decline-reasons#",
  "fallback": {
    "public_code": "OTHER",
    "public_message": "A settler declined for a reason this gateway does not recognise.",
    "retry_classification": "CONTACT_SUPPORT",
    "docs_slug": "other"
  },
  "entries": {
    "UNSPECIFIED": {
      "public_code": "OTHER",
      "public_message": "A settler declined without naming a reason.",
      "retry_classification": "CONTACT_SUPPORT",
      "docs_slug": "other"
    },
    "DEADLINE_TOO_SHORT": {
      "public_code": "DEADLINE_TOO_SHORT",
      "public_message": "The time left to fulfill this payment was below the settler's minimum for this corridor.",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "docs_slug": "deadline-too-short"
    },
    "NO_SETTLEMENT_HORIZON": {
      "public_code": "NO_SETTLEMENT_HORIZON",
      "public_message": "The request carried no usable fulfillment deadline, so the settler had no refund path.",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "docs_slug": "no-settlement-horizon"
    },
    "AUCTION_CLOSED": {
      "public_code": "AUCTION_CLOSED",
      "public_message": "The quote collection or award window had already closed when the settler evaluated the request.",
      "retry_classification": "RETRY_AFTER_DELAY",
      "docs_slug": "auction-closed"
    },
    "QUOTE_INVALID": {
      "public_code": "QUOTE_INVALID",
      "public_message": "The request the settler was asked to quote on failed validation.",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "docs_slug": "quote-invalid"
    },
    "DRAINING": {
      "public_code": "DRAINING",
      "public_message": "The settler is draining in-flight work and is not accepting new payments.",
      "retry_classification": "RETRY_AFTER_DELAY",
      "docs_slug": "draining"
    },
    "HOOK_DECLINED": {
      "public_code": "OTHER",
      "public_message": "A settler declined for a reason of its own.",
      "retry_classification": "CONTACT_SUPPORT",
      "docs_slug": "other"
    },
    "INTERNAL": {
      "public_code": "INTERNAL",
      "public_message": "The settler hit an unexpected error while evaluating the request.",
      "retry_classification": "RETRY_AFTER_DELAY",
      "docs_slug": "internal"
    },
    "INSUFFICIENT_LIQUIDITY": {
      "public_code": "INSUFFICIENT_LIQUIDITY",
      "public_message": "The settler could not fund the payout on the destination chain.",
      "retry_classification": "RETRY_AFTER_DELAY",
      "docs_slug": "insufficient-liquidity"
    },
    "UNTRUSTED_VERIFIER": {
      "public_code": "UNTRUSTED_VERIFIER",
      "public_message": "The request named a fulfillment verifier the settler does not trust, or named none at all.",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "docs_slug": "untrusted-verifier"
    },
    "AGENT_NOT_READY": {
      "public_code": "AGENT_NOT_READY",
      "public_message": "The settler had not finished registering when the request arrived.",
      "retry_classification": "RETRY_AFTER_DELAY",
      "docs_slug": "agent-not-ready"
    },
    "UNSUPPORTED_DESTINATION_ASSET": {
      "public_code": "UNSUPPORTED_DESTINATION_ASSET",
      "public_message": "The settler does not serve the requested destination asset.",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "docs_slug": "unsupported-destination-asset"
    },
    "QUOTE_GENERATION_FAILED": {
      "public_code": "QUOTE_GENERATION_FAILED",
      "public_message": "The settler could not produce a valid quote for this request.",
      "retry_classification": "RETRY_AFTER_DELAY",
      "docs_slug": "quote-generation-failed"
    },
    "AWARD_WINDOW_TOO_SHORT": {
      "public_code": "AWARD_WINDOW_TOO_SHORT",
      "public_message": "The settler's award_deadline, the time it holds its quoted price until, left too little time to produce a quote. A settler ends its award_deadline early enough to still meet the request's fulfillment_deadline, so reissue the request with a later fulfillment_deadline.",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "docs_slug": "award-window-too-short"
    },
    "QUOTE_WINDOW_TOO_LONG": {
      "public_code": "QUOTE_WINDOW_TOO_LONG",
      "public_message": "The request's quote_deadline was further out than the settler's price hold, so any quote it gave would have expired before the award.",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "docs_slug": "quote-window-too-long"
    },
    "SETTLER_UNSUPPORTED_ESCROW": {
      "public_code": "SETTLER_UNSUPPORTED_ESCROW",
      "public_message": "The request named an escrow the settler does not deposit into.",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "docs_slug": "settler-unsupported-escrow"
    },
    "VERIFIER_UNSUPPORTED_ESCROW": {
      "public_code": "VERIFIER_UNSUPPORTED_ESCROW",
      "public_message": "The request named an escrow the payment's verifier does not sign refunds for.",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "docs_slug": "verifier-unsupported-escrow"
    },
    "MAX_SOURCE_AMOUNT_TOO_LOW": {
      "public_code": "MAX_SOURCE_AMOUNT_TOO_LOW",
      "public_message": "The maximum source amount on the request was below the price the settler would quote for this payment.",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "docs_slug": "max-source-amount-too-low"
    },
    "QUOTE_WINDOW_TOO_SHORT": {
      "public_code": "QUOTE_WINDOW_TOO_SHORT",
      "public_message": "The request's quote_deadline left the settler too little time to produce a quote. Reissue the request with a longer quote_deadline.",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "docs_slug": "quote-window-too-short"
    },
    "ASSET_PAUSED": {
      "public_code": "ASSET_PAUSED",
      "public_message": "The token issuer has paused transfers of the source or destination asset. Retry the request once the issuer resumes transfers.",
      "retry_classification": "RETRY_AFTER_DELAY",
      "docs_slug": "asset-paused"
    },
    "DESTINATION_ACCOUNT_RESTRICTED": {
      "public_code": "DESTINATION_ACCOUNT_RESTRICTED",
      "public_message": "The destination account cannot receive this asset, for example because it is frozen or blocked by the issuer or only accepts certain transfers. Use a destination account that can receive this asset, or have the recipient or the issuer lift the restriction first.",
      "retry_classification": "NOT_RETRYABLE_FIX_REQUEST",
      "docs_slug": "destination-account-restricted"
    }
  }
}
`
