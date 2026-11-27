use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Not authorized: the signer, a supplied account, or the program's authority state is not what this instruction requires")]
    Unauthorized,
    #[msg("Recipient has already been set")]
    RecipientAlreadySet,
    #[msg("Offchain quote hash cannot be empty")]
    QuoteHashCannotBeEmpty,
    #[msg("Recipient has not been set")]
    RecipientNotSet,
    #[msg("Missing Ed25519 signature verification instruction")]
    MissingSignatureVerification,
    #[msg("The preceding instruction is not a single-signature Ed25519 verification with in-instruction data")]
    InvalidVerificationInstruction,
    #[msg("The public key is unset or does not match the signer this check expects")]
    InvalidPublicKey,
    #[msg("The signed message does not match the message this check expects")]
    InvalidMessage,
    /// Reserved. Nothing raises this any more: every condition that used to share it now has its
    /// own variant, appended at the end of this enum. Kept declared so the codes after it do not
    /// move, and so a client decoding an older transaction still resolves the name.
    #[msg("Reserved, not raised")]
    InvalidData,
    /// Reserved. No instruction raises this; `Unauthorized` covers authority mismatches. Kept so the
    /// discriminants after it do not move.
    #[msg("Reserved, not raised")]
    InvalidAuthority,
    /// Reserved. No instruction raises this; `Unauthorized` covers caller mismatches.
    #[msg("Reserved, not raised")]
    InvalidCaller,
    #[msg("The delegate expiration is in the past")]
    Expired,
    #[msg("The requested amount exceeds the delegate's remaining capacity")]
    CapacityExceeded,
    #[msg("Invalid mint address")]
    InvalidMint,
    #[msg("The authorization deadline has passed")]
    DeadlineExpired,
    #[msg("The requested amount exceeds the delegate's per-transfer maximum")]
    TransferSizeExceeded,
    /// Reserved. No instruction raises this; delegate revocation authorizes through `Unauthorized`.
    #[msg("Reserved, not raised")]
    InvalidRevoker,
    #[msg("The deposit amount must be greater than zero")]
    AmountMustBeGreaterThanZero,
    #[msg("The authorization deadline is beyond the replay window")]
    DeadlineTooFarInFuture,
    #[msg("The authorization is stamped in the future")]
    FutureTransaction,
    #[msg("The authorization is older than the replay window, so nonce reuse can no longer be detected")]
    ExpiredTransaction,
    #[msg("The nonce maps to a slot outside the replay bitmap")]
    InvalidSlot,
    #[msg("This nonce has already been used inside the replay window")]
    DuplicateTransaction,
    #[msg("Protocol already initialized")]
    AlreadyInitialized,
    #[msg("Protocol is paused")]
    ProtocolPaused,
    #[msg("Admin transfer not ready - delay not elapsed")]
    AdminTransferNotReady,
    #[msg("Mint not in allowlist")]
    MintNotAllowed,
    #[msg("Transfer-fee mints are not allowed")]
    TransferFeeMintNotAllowed,
    #[msg("Fee percentage exceeds 100%")]
    FeePercentageTooHigh,
    #[msg("Minimum fee cannot exceed maximum fee")]
    MinFeeGreaterThanMaxFee,
    #[msg("Maximum fee requires non-zero percentage")]
    MaxFeeSetButPercentageZero,
    #[msg("Computed fee exceeds deposit amount")]
    FeeExceedsAmount,
    #[msg("Transfer amount mismatch - exact transfer required")]
    NonExactTransfer,
    #[msg("Escrow balance insufficient for intended release amount")]
    InsufficientEscrowBalance,
    #[msg("The depositor-signed deposit-request commitment cannot be zero")]
    DepositRequestHashCannotBeEmpty,
    #[msg("The committed destination cannot be empty")]
    DestinationEmpty,
    #[msg("The committed destination exceeds 256 bytes")]
    DestinationTooLong,
    #[msg("The reserved source amount cannot be zero")]
    AmountCannotBeZero,
    #[msg("The reserved source amount exceeds the amount the depositor authorized")]
    SourceAmountExceedsDeposit,

    // APPENDED, NOT INSERTED. Anchor assigns error codes by declaration order, so adding a variant
    // mid-enum renumbers every later one — a silent ABI break for any offchain matcher keyed on the
    // numeric code. New variants go at the end.
    /// min_fee_6 truncates to zero atoms at this mint's decimals, so the configured floor would
    /// silently not exist. Mirrors EVM/TVM `MinFeeNotRepresentable`.
    #[msg("Minimum fee is not representable in this mint's decimals")]
    MinFeeNotRepresentable,

    /// max_fee_6 truncates to zero atoms at this mint's decimals, so the cap would clamp every fee
    /// to zero. Mirrors EVM/TVM `MaxFeeNotRepresentable`.
    #[msg("Maximum fee is not representable in this mint's decimals")]
    MaxFeeNotRepresentable,

    /// The Ed25519 verification instruction's offset or length fields do not describe a structure
    /// that fits inside its own data. Distinct from `InvalidVerificationInstruction`, which rejects
    /// the instruction's shape, and from `InvalidPublicKey` / `InvalidMessage`, which reject a
    /// well-formed instruction whose contents are the wrong ones.
    #[msg("The signature verification instruction's offsets or lengths fall outside its data")]
    MalformedSignatureData,

    /// Fee rescaling could not produce a value: a zero deposit amount (which would divide by zero),
    /// a multiplication that overflows u128, or a result that does not fit back into u64.
    #[msg(
        "The fee could not be rescaled: the deposit amount was zero, or the arithmetic overflowed"
    )]
    FeeArithmeticFailed,

    /// A role account the instruction binds — reserver, releaser or recipient — was left at the
    /// default pubkey. Distinct from `RecipientNotSet`, which is about escrow state rather than a
    /// supplied argument.
    #[msg("A required role account was left unset")]
    RoleAccountNotSet,

    /// The stored deposit hash does not equal the one recomputed from the arguments this
    /// instruction was given. Raised before any signature is checked, so the fault is in the
    /// deposit arguments rather than in the signer.
    #[msg("The recomputed deposit hash does not match the one this deposit was created with")]
    DepositHashMismatch,

    /// The delegate's capacity or per-transfer limits are not a usable pair: either is zero, or the
    /// per-transfer maximum exceeds the remaining capacity.
    #[msg("The delegate's capacity and per-transfer limits are zero or inconsistent")]
    DelegateLimitsInvalid,

    /// `deadline < issued_at`, or the replay horizon overflows. Mirrors
    /// `replay::ReplayError::InconsistentTimestamps`.
    #[msg("The authorization's deadline is before its issued_at, or its replay horizon overflows")]
    InconsistentTimestamps,

    /// A checked timestamp addition overflowed. Its own variant because the sites that raise it
    /// have no amount and no capacity, so `CapacityExceeded` was false for them.
    #[msg("A timestamp calculation overflowed")]
    TimestampOverflow,

    /// The Ed25519 instruction is well formed and its signature verifies, but the message it signed
    /// is not the 32 bytes this program hashes. Split from `MalformedSignatureData` because nothing
    /// here falls outside the instruction's data — the instruction is intact and simply signed the
    /// wrong shape, which points at the caller's message construction rather than at the signer.
    #[msg("The signed message is not 32 bytes")]
    SignatureMessageSizeInvalid,

    /// `depositor_ata` is not the depositor's associated token account for this mint and token
    /// program. Checked by address, not by token owner, so the depositor cannot block settlement
    /// by reassigning a classic SPL account.
    #[msg("Depositor token account is not the depositor's associated token account")]
    InvalidDepositorAta,

    /// The mint carries Token-2022's PermanentDelegate extension. Its delegate can transfer or burn
    /// from any token account of the mint, the escrow's included, without the escrow's say-so, so a
    /// credited deposit could be emptied and neither release nor refund could pay it out.
    #[msg("Mints with a permanent delegate are not allowed")]
    PermanentDelegateMintNotAllowed,
}
