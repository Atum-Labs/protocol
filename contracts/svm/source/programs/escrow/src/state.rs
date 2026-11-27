use anchor_lang::prelude::*;

#[account]
pub struct ReplayBucket {
    pub bitmaps: [[u64; 4]; 2],
}

impl ReplayBucket {
    // 8 (discriminator) + (4 * 8 bytes) * 2 = 72 bytes
    pub const LEN: usize = 72;
}

#[account]
pub struct EscrowDelegate {
    pub authority: Pubkey,
    pub delegate_signer: Pubkey,
    pub max_transfer_size: u64,
    pub remaining_capacity: u64,
    pub expiration: u64,
    pub allowed_mint: Pubkey,
}

impl EscrowDelegate {
    // 8 + 32*3 + 8*3 = 128 bytes
    pub const LEN: usize = 128;
}

/// Per-deposit escrow record.
///
/// v3 grew this struct 217 -> 249 bytes by adding `quote_hash`. There is intentionally NO `realloc`
/// and NO migration instruction: the layout change is not in-place-migratable, so an in-place program
/// upgrade would leave existing 217-byte deposits undeserializable. v3 ships as a fresh redeploy with
/// all in-flight deposits drained to a terminal state first, so there are no legacy accounts to
/// migrate. See `docs/operations/deployment.md`, which owns the drain, redeploy and re-init
/// sequence.
#[account]
pub struct DepositInfo {
    pub depositor: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub reserver: Pubkey,
    pub releaser: Pubkey,
    pub recipient: Option<Pubkey>,
    // Binds post-deposit signatures to this specific deposit instance.
    // This is the keccak-256 hash of the deposit message
    // computed in `compute_deposit_hash`.
    pub deposit_hash: [u8; 32],
    // Offchain quote hash, attested by the reserver at reserve time (zero until reserved).
    pub quote_hash: [u8; 32],
    // Depositor-signed commitment to the offchain deposit request. Formerly `payment_id`; renamed for
    // parity with EVM and TVM, which call the same value `depositRequestHash`. Its derivation is
    // defined by the offchain protocol layer, not by this program.
    pub deposit_request_hash: [u8; 32],
    // keccak256 of the depositor-committed destination string. Only the hash is stored: it keeps
    // this account fixed-width. See MAX_DESTINATION_LEN for the transaction-size ceiling.
    //
    // RECOVERING THE PLAINTEXT: the deposit INSTRUCTION DATA is the only source. This program emits
    // no event carrying either commitment -- `Deposited` (events.rs) carries neither
    // `deposit_request_hash` nor `destination_hash`, and there is no sibling commitments event. An
    // earlier revision of this comment pointed at a `DepositCommitments` event; that event exists on
    // EVM and TVM and was never ported here, so the reference was unresolvable.
    //
    // WHY THE ASYMMETRY WITH EVM IS DEFENSIBLE, not merely unported. On EVM both commitments are
    // members of the eleven-member Release/RefundWitness, so a log-only releaser cannot assemble a
    // settlement signature without them -- that is what EVM's separate commitments event exists for,
    // and refund is the escape hatch with no rescue function behind it. On SVM the settlement
    // preimages bind only (deposit_hash, quote_hash): see `compute_release_hash` /
    // `compute_refund_hash` in utils/signatures.rs, whose preimages are 142 and 141 bytes -- the
    // 71-byte domain prefix, the tag, and exactly two 32-byte fields. Neither commitment appears. So
    // no SVM settlement participant needs to recover them, and the observability gap costs an
    // external ANALYTICS consumer rather than the funds-recovery path.
    //
    // Note these two fields are write-only after deposit: `release`/`refund` never read them back.
    // They are bound into `deposit_hash` at deposit time, which is what makes them tamper-evident.
    // Revisit emitting them if an external indexer ever has to reconstruct a Solana deposit's intent
    // from logs alone -- as an APPENDED field on `Deposited` or a sibling event, per the append-only
    // note on `Released`.
    pub destination_hash: [u8; 32],
    // Fee amount snapshotted at deposit time
    pub fee_amount: u64,
}

impl DepositInfo {
    // 8 + 32*5 + 8 + (1 + 32) + 32 + 32 + 32 + 8 = 313 bytes
    // Grew by 64 from 249 when the two CORE-2120 commitments were added, and by 32 from 217 before
    // that when `quote_hash` was added.
    //
    // A pre-change account is NOT readable after the upgrade. Anchor deserializes a `DepositInfo`
    // by this layout, so a 217- or 249-byte account fails to deserialize once the program expects
    // 313 — it is neither releasable nor refundable, and there is no rescue instruction. The
    // "closed when it settles" argument only holds for deposits that settle BEFORE the upgrade;
    // it says nothing about accounts still open when the new program takes over.
    //
    // That is why there is deliberately no `realloc` and no migration instruction, and why the
    // struct doc above requires v3 to ship as a FRESH REDEPLOY with in-flight deposits drained
    // first. Preserving the program id turns this into an in-place upgrade and re-introduces
    // exactly the case this comment used to claim was safe.
    pub const LEN: usize = 313;
}

/// Per-mint fee configuration and allowlist entry
/// Seeds: ["mint_fee_config", mint_pubkey]
/// Existence of this PDA = mint is allowlisted
#[account]
pub struct MintFeeConfig {
    /// The mint this config applies to
    pub mint: Pubkey,
    /// Fee percentage scaled by 1e6 (1_000_000 = 1%, max 100_000_000 = 100%)
    pub fee_percentage_6: u64,
    /// Minimum fee in 6-decimal normalized units
    pub min_fee_6: u64,
    /// Maximum fee in 6-decimal normalized units (0 = disabled)
    pub max_fee_6: u64,
}

impl MintFeeConfig {
    pub const SEED: &'static [u8] = b"mint_fee_config";

    // Size calculation:
    // discriminator: 8
    // mint: 32
    // fee_percentage_6: 8
    // min_fee_6: 8
    // max_fee_6: 8
    // Total: 8 + 32 + 8 + 8 + 8 = 64
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 8;
}

/// Global protocol configuration PDA
/// Seeds: ["protocol_config"]
#[account]
pub struct ProtocolConfig {
    /// The default admin with full role management authority
    pub default_admin: Pubkey,
    /// Authority for mint allowlist and fee configuration
    pub token_config_authority: Pubkey,
    /// Fee recipient (treasury owner)
    pub treasurer: Pubkey,
    /// Authority for pause/unpause operations
    pub pauser: Pubkey,
    /// Whether protocol operations are paused
    pub paused: bool,
    /// Cluster-specific domain separator for signed escrow messages
    pub cluster_id: [u8; 32],
    /// Version byte for the escrow signature message schema
    pub signature_domain_version: u8,
    /// Delay in seconds for default admin transfer
    pub default_admin_delay_seconds: u32,
    /// Pending new default admin (two-step transfer)
    pub pending_default_admin: Option<Pubkey>,
    /// Timestamp after which pending admin can accept transfer
    pub pending_default_admin_accept_after_ts: Option<i64>,
}

impl ProtocolConfig {
    pub const SEED: &'static [u8] = b"protocol_config";
    // Bump whenever the signature preimage layout changes. v3 adds `quote_hash` to the
    // reserve/release/refund preimages. Read only at initialize_protocol (no setter), so a bump
    // takes effect only on a fresh config init, not an in-place program upgrade.
    // Bumped 3 -> 4 by CORE-2120: destination_hash enters the deposit preimage, so every deposit hash
    // changes. The version is part of the preimage, so a v3 signature can never be replayed against v4.
    // Bumped 4 -> 5 by CORE-2022 (Solana parity): source_amount enters the RESERVE preimage. Without
    // the bump a v4 reserve signature — which attests recipient+quote_hash but says nothing about how
    // much of the payer's authorization to consume — would still verify against the widened preimage
    // for whichever source_amount made the hash match, so the bump is what makes the old signature
    // unusable rather than merely under-specified.
    pub const CURRENT_SIGNATURE_DOMAIN_VERSION: u8 = 5;

    // Size calculation:
    // discriminator: 8
    // default_admin: 32
    // token_config_authority: 32
    // treasurer: 32
    // pauser: 32
    // paused: 1
    // cluster_id: 32
    // signature_domain_version: 1
    // default_admin_delay_seconds: 4
    // pending_default_admin: 1 + 32 = 33
    // pending_default_admin_accept_after_ts: 1 + 8 = 9
    // Total: 8 + 32 + 32 + 32 + 32 + 1 + 32 + 1 + 4 + 33 + 9 = 216
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 32 + 1 + 32 + 1 + 4 + 33 + 9;
}
