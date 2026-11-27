// Code generated from apis/decline/v1/catalog.json by make generate-decline. DO NOT EDIT.
package atumdecline

const (
	ReasonAgentNotReady               ReasonCode = "AGENT_NOT_READY"
	ReasonAuctionClosed               ReasonCode = "AUCTION_CLOSED"
	ReasonAwardWindowTooShort         ReasonCode = "AWARD_WINDOW_TOO_SHORT"
	ReasonDeadlineTooShort            ReasonCode = "DEADLINE_TOO_SHORT"
	ReasonDraining                    ReasonCode = "DRAINING"
	ReasonHookDeclined                ReasonCode = "HOOK_DECLINED"
	ReasonInsufficientLiquidity       ReasonCode = "INSUFFICIENT_LIQUIDITY"
	ReasonInternal                    ReasonCode = "INTERNAL"
	ReasonMaxSourceAmountTooLow       ReasonCode = "MAX_SOURCE_AMOUNT_TOO_LOW"
	ReasonNoSettlementHorizon         ReasonCode = "NO_SETTLEMENT_HORIZON"
	ReasonQuoteGenerationFailed       ReasonCode = "QUOTE_GENERATION_FAILED"
	ReasonQuoteInvalid                ReasonCode = "QUOTE_INVALID"
	ReasonQuoteWindowTooLong          ReasonCode = "QUOTE_WINDOW_TOO_LONG"
	ReasonQuoteWindowTooShort         ReasonCode = "QUOTE_WINDOW_TOO_SHORT"
	ReasonSettlerUnsupportedEscrow    ReasonCode = "SETTLER_UNSUPPORTED_ESCROW"
	ReasonUnspecified                 ReasonCode = "UNSPECIFIED"
	ReasonUnsupportedDestinationAsset ReasonCode = "UNSUPPORTED_DESTINATION_ASSET"
	ReasonUntrustedVerifier           ReasonCode = "UNTRUSTED_VERIFIER"
	ReasonVerifierUnsupportedEscrow   ReasonCode = "VERIFIER_UNSUPPORTED_ESCROW"
)

// AllReasonCodes lists every reason the catalog names, sorted.
var AllReasonCodes = []ReasonCode{
	ReasonAgentNotReady,
	ReasonAuctionClosed,
	ReasonAwardWindowTooShort,
	ReasonDeadlineTooShort,
	ReasonDraining,
	ReasonHookDeclined,
	ReasonInsufficientLiquidity,
	ReasonInternal,
	ReasonMaxSourceAmountTooLow,
	ReasonNoSettlementHorizon,
	ReasonQuoteGenerationFailed,
	ReasonQuoteInvalid,
	ReasonQuoteWindowTooLong,
	ReasonQuoteWindowTooShort,
	ReasonSettlerUnsupportedEscrow,
	ReasonUnspecified,
	ReasonUnsupportedDestinationAsset,
	ReasonUntrustedVerifier,
	ReasonVerifierUnsupportedEscrow,
}
