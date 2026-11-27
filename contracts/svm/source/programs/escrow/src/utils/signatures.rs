use crate::errors::ErrorCode;
use crate::state::ProtocolConfig;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::Instruction as SolanaInstruction,
    sysvar::instructions::{load_current_index_checked, load_instruction_at_checked},
};
use sha3::{Digest, Keccak256};

/// Ed25519 native program ID
/// Base58: Ed25519SigVerify111111111111111111111111111
const ED25519_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0x03, 0x7d, 0x46, 0xd6, 0x7c, 0x93, 0xfb, 0xbe, 0x12, 0xf9, 0x42, 0x8f, 0x83, 0x8d, 0x40, 0xff,
    0x05, 0x70, 0x74, 0x49, 0x27, 0xf4, 0x8a, 0x64, 0xfc, 0xca, 0x70, 0x44, 0x80, 0x00, 0x00, 0x00,
]);

/// Keccak256 hash helper for multiple inputs
fn keccak_hashv(inputs: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    for input in inputs {
        hasher.update(input);
    }
    hasher.finalize().into()
}

// Hashing Functions

/// keccak256 of the depositor-committed destination string.
///
/// The single place the destination is turned into bytes for hashing. It exists so the hash-first rule
/// has one home and one explanation: `keccak_hashv` concatenates its inputs with NO length prefixes, so
/// preimage injectivity depends on every hashed field being fixed-width. A variable-length destination
/// fed straight into `compute_deposit_hash` would make injectivity conditional on the surrounding
/// fields' widths — it survives today only because there would be exactly one variable-length member,
/// and it becomes unsound the moment a second is added. EVM has no such exposure because EIP-712 hashes
/// a dynamic `string` member as keccak256(bytes(value)); this mirrors that.
///
/// `raw_destination_feed_is_rejected` pins the distinction.
pub fn compute_destination_hash(destination: &str) -> [u8; 32] {
    keccak_hashv(&[destination.as_bytes()])
}

// Preimage builders
//
// Each `with_*_preimage` owns the byte layout of exactly one signed message and hands the resulting
// slice sequence to a caller-supplied `consume`. Production passes `keccak_hashv`; the test module
// passes `measure`, which is how `preimage_lengths_are_pinned` sizes the bytes that are really
// hashed instead of restating the layout as literals. It used to restate it, and both sides of that
// assertion were compile-time constants, so the layout drifted out from under it without anything
// going red.
//
// WHY A CALLBACK RATHER THAN A RETURNED SLICE. The parts borrow locals that live only for the
// duration of the call — the one-byte version array and the little-endian integer buffers — so they
// cannot outlive the builder, and materialising them into a `Vec` would put a heap allocation on the
// on-chain path to serve a test. Handing the borrowed slice to `consume` keeps production
// zero-allocation while leaving one source of truth per layout.

#[allow(clippy::too_many_arguments)]
fn with_deposit_preimage<R>(
    protocol_config: &ProtocolConfig,
    deposit_request_hash: [u8; 32],
    // Already keccak256 of the destination string — see `compute_deposit_hash`, which is where the
    // fixed-width requirement is spelled out and where callers are held to it.
    destination_hash: [u8; 32],
    depositor: Pubkey,
    mint: Pubkey,
    amount: u64,
    reserver: Pubkey,
    releaser: Pubkey,
    nonce: u64,
    issued_at: u64,
    deadline: u64,
    consume: impl FnOnce(&[&[u8]]) -> R,
) -> R {
    let version = [protocol_config.signature_domain_version];
    let amount_le = amount.to_le_bytes();
    let nonce_le = nonce.to_le_bytes();
    let issued_at_le = issued_at.to_le_bytes();
    let deadline_le = deadline.to_le_bytes();
    consume(&[
        b"escrow",
        &version,
        protocol_config.cluster_id.as_ref(),
        crate::ID.as_ref(),
        b"deposit",
        &deposit_request_hash,
        &destination_hash,
        depositor.as_ref(),
        mint.as_ref(),
        &amount_le,
        reserver.as_ref(),
        releaser.as_ref(),
        &nonce_le,
        &issued_at_le,
        &deadline_le,
    ])
}

fn with_reserve_preimage<R>(
    protocol_config: &ProtocolConfig,
    recipient: Pubkey,
    deposit_hash: [u8; 32],
    quote_hash: [u8; 32],
    source_amount: u64,
    consume: impl FnOnce(&[&[u8]]) -> R,
) -> R {
    let version = [protocol_config.signature_domain_version];
    let source_amount_le = source_amount.to_le_bytes();
    consume(&[
        b"escrow",
        &version,
        protocol_config.cluster_id.as_ref(),
        crate::ID.as_ref(),
        b"reserve",
        recipient.as_ref(),
        &deposit_hash,
        &quote_hash,
        // CORE-2022: the reserve attestation binds the winning source amount, so a reserve
        // signature cannot be replayed against a different charge. Added here rather than at the
        // call site so the length test measures the same bytes the hash commits to.
        &source_amount_le,
    ])
}

fn with_release_preimage<R>(
    protocol_config: &ProtocolConfig,
    deposit_hash: [u8; 32],
    quote_hash: [u8; 32],
    consume: impl FnOnce(&[&[u8]]) -> R,
) -> R {
    let version = [protocol_config.signature_domain_version];
    consume(&[
        b"escrow",
        &version,
        protocol_config.cluster_id.as_ref(),
        crate::ID.as_ref(),
        b"release",
        &deposit_hash,
        &quote_hash,
    ])
}

fn with_refund_preimage<R>(
    protocol_config: &ProtocolConfig,
    deposit_hash: [u8; 32],
    quote_hash: [u8; 32],
    consume: impl FnOnce(&[&[u8]]) -> R,
) -> R {
    let version = [protocol_config.signature_domain_version];
    consume(&[
        b"escrow",
        &version,
        protocol_config.cluster_id.as_ref(),
        crate::ID.as_ref(),
        b"refund",
        &deposit_hash,
        &quote_hash,
    ])
}

#[allow(clippy::too_many_arguments)]
pub fn compute_deposit_hash(
    protocol_config: &ProtocolConfig,
    deposit_request_hash: [u8; 32],
    // keccak256 of the destination string, NOT the string itself.
    //
    // THIS IS A CORRECTNESS REQUIREMENT, NOT A STYLE CHOICE. `keccak_hashv` concatenates its inputs
    // with NO length prefixes, so injectivity of the preimage depends on every field being
    // fixed-width. Feeding a variable-length `&str` here would make injectivity conditional on the
    // surrounding fields' widths - it happens to survive today with exactly one variable-length
    // member, but it is silently fragile the moment a second one is added, and it diverges from EVM,
    // where EIP-712 hashes a dynamic `string` member as keccak256(bytes(value)). Hash first, always.
    // `raw_destination_feed_is_rejected` pins this.
    destination_hash: [u8; 32],
    depositor: Pubkey,
    mint: Pubkey,
    amount: u64,
    reserver: Pubkey,
    releaser: Pubkey,
    nonce: u64,
    issued_at: u64,
    deadline: u64,
) -> [u8; 32] {
    with_deposit_preimage(
        protocol_config,
        deposit_request_hash,
        destination_hash,
        depositor,
        mint,
        amount,
        reserver,
        releaser,
        nonce,
        issued_at,
        deadline,
        keccak_hashv,
    )
}

/// CORE-2022: `source_amount` is part of the preimage, not a loose argument.
///
/// It is the amount the payer is ACTUALLY charged, and it is necessarily lower than the amount
/// they signed at deposit — the depositor authorizes a ceiling before the auction runs, so the
/// winning quote's charge can only be known later. Whoever states that charge is therefore
/// asserting how much of the payer's authorization to consume, and that has to be the RESERVER
/// (the quote selector), whose signature this hash is verified against.
///
/// Leaving it out of the preimage and taking it as a bare instruction argument would let the
/// settler — the party being paid — choose what the payer is charged, bounded only by the
/// ceiling. This mirrors EVM, where `sourceAmount` sits inside the reserver-signed
/// `ReserveWitness` rather than beside it.
pub fn compute_reserve_hash(
    protocol_config: &ProtocolConfig,
    recipient: Pubkey,
    deposit_hash: [u8; 32],
    quote_hash: [u8; 32],
    source_amount: u64,
) -> [u8; 32] {
    with_reserve_preimage(
        protocol_config,
        recipient,
        deposit_hash,
        quote_hash,
        source_amount,
        keccak_hashv,
    )
}

pub fn compute_release_hash(
    protocol_config: &ProtocolConfig,
    deposit_hash: [u8; 32],
    quote_hash: [u8; 32],
) -> [u8; 32] {
    with_release_preimage(protocol_config, deposit_hash, quote_hash, keccak_hashv)
}

pub fn compute_refund_hash(
    protocol_config: &ProtocolConfig,
    deposit_hash: [u8; 32],
    quote_hash: [u8; 32],
) -> [u8; 32] {
    with_refund_preimage(protocol_config, deposit_hash, quote_hash, keccak_hashv)
}

// Signature Verification Helpers

// Helper to verify a single Ed25519 instruction (Optimized parsing)
fn check_sig_ix(
    ix: &SolanaInstruction,
    expected_public_key: &Pubkey,
    expected_message: &[u8; 32],
) -> Result<()> {
    if ix.program_id != ED25519_PROGRAM_ID {
        return err!(ErrorCode::InvalidVerificationInstruction);
    }
    let data = &ix.data;
    // Check signature count (must be 1) and minimum length for offsets
    if data.len() < 16 || data[0] != 1 {
        return err!(ErrorCode::InvalidVerificationInstruction);
    }

    // Optimized offset parsing (as per Ed25519 program spec).
    let sig_offset = u16::from_le_bytes(
        data[2..4]
            .try_into()
            .map_err(|_| ErrorCode::MalformedSignatureData)?,
    ) as usize;
    let sig_ix = u16::from_le_bytes(
        data[4..6]
            .try_into()
            .map_err(|_| ErrorCode::MalformedSignatureData)?,
    );
    let pk_offset = u16::from_le_bytes(
        data[6..8]
            .try_into()
            .map_err(|_| ErrorCode::MalformedSignatureData)?,
    ) as usize;
    let pk_ix = u16::from_le_bytes(
        data[8..10]
            .try_into()
            .map_err(|_| ErrorCode::MalformedSignatureData)?,
    );
    let msg_offset = u16::from_le_bytes(
        data[10..12]
            .try_into()
            .map_err(|_| ErrorCode::MalformedSignatureData)?,
    ) as usize;
    let msg_size = u16::from_le_bytes(
        data[12..14]
            .try_into()
            .map_err(|_| ErrorCode::MalformedSignatureData)?,
    ) as usize;
    let msg_ix = u16::from_le_bytes(
        data[14..16]
            .try_into()
            .map_err(|_| ErrorCode::MalformedSignatureData)?,
    );

    // Enforce in-instruction data only to prevent cross-instruction confusion
    if sig_ix != u16::MAX || pk_ix != u16::MAX || msg_ix != u16::MAX {
        return err!(ErrorCode::InvalidVerificationInstruction);
    }

    // Validate Public Key
    let pk_end = pk_offset + 32;
    if pk_end > data.len() {
        return err!(ErrorCode::MalformedSignatureData);
    }
    let pk_bytes: [u8; 32] = data[pk_offset..pk_end]
        .try_into()
        .map_err(|_| ErrorCode::MalformedSignatureData)?;
    if Pubkey::new_from_array(pk_bytes) != *expected_public_key {
        return err!(ErrorCode::InvalidPublicKey);
    }

    // Validate Signature length
    let sig_end = sig_offset + 64;
    if sig_end > data.len() {
        return err!(ErrorCode::MalformedSignatureData);
    }

    // Validate Message
    let msg_end = msg_offset + msg_size;
    if msg_end > data.len() {
        return err!(ErrorCode::MalformedSignatureData);
    }
    if msg_size != 32 {
        return err!(ErrorCode::SignatureMessageSizeInvalid);
    }
    if &data[msg_offset..msg_end] != expected_message.as_ref() {
        return err!(ErrorCode::InvalidMessage);
    }

    Ok(())
}

// Verifies the immediately preceding instruction (Index N-1)
pub fn verify_single_ed25519_instruction(
    instructions: &AccountInfo,
    expected_public_key: &Pubkey,
    expected_message: &[u8; 32],
) -> Result<()> {
    let current_index = load_current_index_checked(instructions)? as usize;
    if current_index == 0 {
        return err!(ErrorCode::MissingSignatureVerification);
    }
    let verify_ix = load_instruction_at_checked(current_index - 1, instructions)?;
    check_sig_ix(&verify_ix, expected_public_key, expected_message)
}

#[cfg(test)]
mod hash_anchor_tests {
    //! Encoder-independent anchors for every signed escrow hash.
    //!
    //! WHY THIS EXISTS
    //! ---------------
    //! The off-chain signers live in another repository (atum-core:
    //! contracts/svm/bindings/{go,typescript}). Historically the only thing
    //! pinning those encoders was a *documented* byte layout transcribed into a
    //! Go test. That makes the documentation the terminus of the trust chain: if
    //! the doc and this file ever diverge, every off-chain side happily agrees on
    //! a hash the program rejects.
    //!
    //! The constants below terminate that chain HERE, in the program that
    //! actually runs. Every one was hand-derived out of band (an independent
    //! Keccak-256 implementation fed the byte layout by hand — not by running any
    //! encoder, on either side) and is asserted against the real
    //! `compute_*_hash` below.
    //!
    //! CROSS-SIDE BINDING. The off-chain encoders now live in THIS repository at
    //! `contracts/svm/bindings/{go,typescript}/escrow-encoding` (they moved in with the
    //! contract sources), so "another repository" no longer applies. More
    //! importantly, the anchors here and the encoders' own V2 anchors were derived
    //! from DIFFERENT fixture inputs, so for a long time nothing actually checked
    //! that the two sides agree on the same input — each merely pinned its own.
    //! `go_encoder_v2_reserve_anchor_is_reproduced_by_this_program` below closes
    //! that: it feeds the encoder's exact V2 fixture through the real
    //! `compute_reserve_hash` and requires the encoder's published constant.
    //!
    //! NEVER regenerate these from code output. If a test here fails, either the
    //! preimage layout changed on purpose (bump
    //! `ProtocolConfig::CURRENT_SIGNATURE_DOMAIN_VERSION`, re-derive out of band,
    //! and update atum-core in lockstep) or something is broken. A "fix" that
    //! copies the new computed value in is a silent wire-format break.

    use super::*;
    use crate::state::ProtocolConfig;

    // ---------------------------------------------------------------- fixtures

    /// `44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs` — the real `declare_id!`.
    /// Spelled as raw bytes so no base58 decoder sits in the derivation path;
    /// `anchors_use_the_real_program_id` ties the bytes back to the base58 text.
    const PROGRAM_ID_BYTES: [u8; 32] = [
        0x2d, 0x66, 0x32, 0x5a, 0x15, 0x9b, 0x21, 0x43, 0x3c, 0xa8, 0x18, 0xab, 0x4b, 0x70, 0x51,
        0x9d, 0x16, 0x6c, 0x8c, 0x96, 0x84, 0xdd, 0xd2, 0x18, 0x63, 0x71, 0x47, 0x89, 0x6c, 0x01,
        0x22, 0x38,
    ];

    /// `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (USDC mint) — recipient/mint.
    const RECIPIENT_BYTES: [u8; 32] = [
        0xc6, 0xfa, 0x7a, 0xf3, 0xbe, 0xdb, 0xad, 0x3a, 0x3d, 0x65, 0xf3, 0x6a, 0xab, 0xc9, 0x74,
        0x31, 0xb1, 0xbb, 0xe4, 0xc2, 0xd2, 0xf6, 0xe0, 0xe4, 0x7c, 0xa6, 0x02, 0x03, 0x45, 0x2f,
        0x5d, 0x61,
    ];

    /// `So11111111111111111111111111111111111111112` (wSOL) — depositor.
    const DEPOSITOR_BYTES: [u8; 32] = [
        0x06, 0x9b, 0x88, 0x57, 0xfe, 0xab, 0x81, 0x84, 0xfb, 0x68, 0x7f, 0x63, 0x46, 0x18, 0xc0,
        0x35, 0xda, 0xc4, 0x39, 0xdc, 0x1a, 0xeb, 0x3b, 0x55, 0x98, 0xa0, 0xf0, 0x00, 0x00, 0x00,
        0x00, 0x01,
    ];

    const DEPOSIT_HASH: [u8; 32] = [0x11; 32];
    const QUOTE_HASH: [u8; 32] = [0x33; 32];
    const DEPOSIT_REQUEST_HASH: [u8; 32] = [0x44; 32];
    /// The ratified canonical destination form: `<CAIP-19 asset>@<account>`, lowercase throughout for
    /// an eip155 namespace. 103 bytes — comfortably inside both MAX_DESTINATION_LEN and the ~152-byte
    /// legacy-transaction ceiling documented on that constant.
    const DESTINATION: &str = "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@0xc0ffee254729296a45a3885639ac7e10f9d54979";
    /// keccak256(DESTINATION), derived out of band. Byte-identical to the value EVM pins for the same
    /// canonical string, which is what makes the destination commitment comparable across chains.
    const DESTINATION_HASH_HEX: &str =
        "7e096a6d1abcfc4daab28cec3f3d3a458c3facbfa0f3493284bb891bdc9807ef";

    const RESERVER_BYTES: [u8; 32] = [0x55; 32];
    const RELEASER_BYTES: [u8; 32] = [0x66; 32];
    const AMOUNT: u64 = 1_000_000;
    const NONCE: u64 = 0x0000_0001_0000_0007; // bucket 1, slot 7
    const ISSUED_AT: u64 = 1_700_000_000;
    const DEADLINE: u64 = ISSUED_AT + 128; // + REPLAY_HORIZON_SECS

    // ----------------------------------------------------------- v3 anchors

    /// keccak256("escrow" ‖ 3 ‖ cluster ‖ program ‖ "reserve" ‖ recipient ‖ deposit_hash ‖ quote_hash)
    const ANCHOR_RESERVE_V3_DEVNET: &str =
        "922ef2935d61990f5a40fbc3d1d9ac0d0bcd7da26350748bd9ceb9c2acfdc864";
    /// keccak256("escrow" ‖ 3 ‖ cluster ‖ program ‖ "release" ‖ deposit_hash ‖ quote_hash)
    const ANCHOR_RELEASE_V3_DEVNET: &str =
        "755726672b73097ae1200c9e2879f40253939b3ec662f01c54db59a7c724ba44";
    /// keccak256("escrow" ‖ 3 ‖ cluster ‖ program ‖ "refund" ‖ deposit_hash ‖ quote_hash)
    const ANCHOR_REFUND_V3_DEVNET: &str =
        "d01edf7a1e754e693cb49db1d2a5d2d5078a7f141d6c93da0182bc1dc7766399";
    /// keccak256("escrow" ‖ 3 ‖ cluster ‖ program ‖ "deposit" ‖ deposit_request_hash ‖ depositor ‖ mint ‖
    ///           amount_le ‖ reserver ‖ releaser ‖ nonce_le ‖ issued_at_le ‖ deadline_le).
    /// The deposit preimage does NOT carry quote_hash — quote_hash enters at reserve.
    /// Deposit anchor for domain version 4, WITH destination_hash in the preimage. Derived out of band
    /// with an independent keccak-256 from the documented layout — not by running this code.
    const ANCHOR_DEPOSIT_V4_DEVNET: &str =
        "434c316fefd017642e55c0c037c8848d753ccb5449fac1292b15752c3f34b5f8";
    /// The same inputs with the destination fed in RAW instead of hashed. Also derived out of band.
    /// This is the value an unsound implementation would produce; `raw_destination_feed_is_rejected`
    /// requires the real one to differ from it.
    const ANCHOR_DEPOSIT_V4_RAW_DESTINATION_FED: &str =
        "d36b4a6aaacb3ba72c68039cccef9977ff2f231aa5608b9f1a7ab9ff2eeca4ed";

    const ANCHOR_DEPOSIT_V3_DEVNET: &str =
        "785494f106cd59a9ac74872d33083850fc50c114f608fde41383edfef0b409a6";

    // Extra v3 vectors: mainnet cluster, saturated quote_hash, zero quote_hash
    // (the never-reserved refund case).
    const ANCHOR_RESERVE_V3_MAINNET: &str =
        "83ea308afb61fa6b899a61bb2712a1b9faacb269246a04cb2290900a54a07541";
    const ANCHOR_RESERVE_V3_MAX_QUOTE: &str =
        "d9ed7d308b83202c6b192a030054a9f8ba2ffc63fc17d73734e614d5e8d120b5";
    const ANCHOR_RELEASE_V3_MAX_QUOTE: &str =
        "040b9bb44fdab88ab715da51d8c0028fa0e47f2d1d0a9f31a75a170023ceb747";
    const ANCHOR_REFUND_V3_ZERO_QUOTE: &str =
        "1acf97bb476546feddcd265dbe907ad74908a735edf1a81a15837222737f4c7d";

    // -------------------------------------------------- pre-v3 historical anchors

    /// Reserve under the RETIRED pre-quote_hash layout
    /// ("escrow" ‖ version ‖ cluster ‖ program ‖ "reserve" ‖ recipient ‖ deposit_hash).
    /// These document what versions 1 and 2 signed. `compute_reserve_hash` can no
    /// longer produce them — that is the point. Do not delete and do not "update".
    const HISTORICAL_RESERVE_V2_DEVNET: &str =
        "5241b6fea2b7ba0b3c0dd7a489967aab8a225c71a153c5a9552df51b1f198550";
    const HISTORICAL_RESERVE_V1_DEVNET: &str =
        "c8b9df667022b28dc63b845b893e85d3c2231aa6843c19de01bbdef0857ea5a7";

    // ----------------------------------------------------------------- helpers

    fn cluster_id(name: &str) -> [u8; 32] {
        // ProtocolConfig.cluster_id: UTF-8 name right-padded with zeros.
        let mut out = [0u8; 32];
        let bytes = name.as_bytes();
        assert!(bytes.len() <= 32, "cluster name too long");
        out[..bytes.len()].copy_from_slice(bytes);
        out
    }

    fn config(cluster: &str, version: u8) -> ProtocolConfig {
        ProtocolConfig {
            default_admin: Pubkey::default(),
            token_config_authority: Pubkey::default(),
            treasurer: Pubkey::default(),
            pauser: Pubkey::default(),
            paused: false,
            cluster_id: cluster_id(cluster),
            signature_domain_version: version,
            default_admin_delay_seconds: 0,
            pending_default_admin: None,
            pending_default_admin_accept_after_ts: None,
        }
    }

    /// Historical: pinned to version 3 EXPLICITLY rather than tracking
    /// CURRENT_SIGNATURE_DOMAIN_VERSION, so the v3 anchors keep asserting what v3 actually produced
    /// after the constant moved to 4. Tracking the constant would have silently re-pointed every
    /// historical anchor at the new version and destroyed the regression evidence.
    fn devnet_v3() -> ProtocolConfig {
        config("devnet", 3)
    }

    /// v4 (CORE-2120 put destination_hash in the deposit preimage). FROZEN to the literal for the
    /// same reason `devnet_v3` is: this used to track `CURRENT_SIGNATURE_DOMAIN_VERSION`, so when
    /// CORE-2022 moved the constant to 5 every "v4" anchor silently started computing at v5 and
    /// failed against its pinned value — making it look as though the deposit and destination
    /// layouts had been invalidated when neither had changed at all. Only the version byte, which
    /// is a hash input, moved. Pinning the literal keeps these anchors as v4 regression evidence.
    fn devnet_v4() -> ProtocolConfig {
        config("devnet", 4)
    }

    /// Current domain version (5 after CORE-2022 put source_amount in the reserve preimage).
    fn devnet_current() -> ProtocolConfig {
        config("devnet", ProtocolConfig::CURRENT_SIGNATURE_DOMAIN_VERSION)
    }

    fn hex32(bytes: [u8; 32]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The consumer `preimage_lengths_are_pinned` hands to the `with_*_preimage` builders where
    /// production hands `keccak_hashv`. Same parts, so the numbers it returns are the real preimage's.
    ///
    /// Returns (total bytes, number of parts). The part count is not redundant with the total: a
    /// field dropped while a neighbour widens by the same amount leaves the total untouched.
    fn measure(parts: &[&[u8]]) -> (usize, usize) {
        (parts.iter().map(|p| p.len()).sum(), parts.len())
    }

    // ------------------------------------------------------------------- tests

    /// The anchors are only meaningful if they were derived against this
    /// program's real ID and the version the program actually stamps.
    #[test]
    fn anchors_use_the_real_program_id_and_version() {
        assert_eq!(
            crate::ID,
            Pubkey::new_from_array(PROGRAM_ID_BYTES),
            "anchors were derived for a different program ID than declare_id!"
        );
        assert_eq!(
            crate::ID.to_string(),
            "44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs",
            "declare_id! changed; every anchor below must be re-derived out of band"
        );
        assert_eq!(
            Pubkey::new_from_array(RECIPIENT_BYTES).to_string(),
            "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
        );
        assert_eq!(
            Pubkey::new_from_array(DEPOSITOR_BYTES).to_string(),
            "So11111111111111111111111111111111111111112"
        );
        assert_eq!(
            ProtocolConfig::CURRENT_SIGNATURE_DOMAIN_VERSION,
            5,
            "the current anchors are v5; bumping the domain version again requires re-deriving them \
             out of band and updating the off-chain encoders under \
             contracts/svm/bindings in LOCKSTEP. This assertion is the reminder: it fired when \
             CORE-2120 moved 3 -> 4 and again when CORE-2022 moved 4 -> 5, which is what it is for. \
             When it fires, FREEZE the outgoing version's helper to its literal (see devnet_v3 / \
             devnet_v4) rather than letting its anchors follow the constant — otherwise every \
             historical anchor silently re-points at the new version and stops being evidence."
        );
    }

    #[test]
    fn reserve_hash_matches_v3_anchor() {
        // Retired layout: CORE-2022 added source_amount, so compute_reserve_hash cannot produce
        // this value any more. Spelled out rather than deleted — it stays live documentation of
        // what v3 signed, and re-deriving it here proves the pinned literal is really the old
        // layout of this same domain rather than an opaque blob.
        assert_eq!(
            hex32(keccak_hashv(&[
                b"escrow",
                &[3u8],
                &cluster_id("devnet"),
                &PROGRAM_ID_BYTES,
                b"reserve",
                &RECIPIENT_BYTES,
                &DEPOSIT_HASH,
                &QUOTE_HASH,
            ])),
            ANCHOR_RESERVE_V3_DEVNET
        );
    }

    #[test]
    fn release_hash_matches_v3_anchor() {
        assert_eq!(
            hex32(compute_release_hash(&devnet_v3(), DEPOSIT_HASH, QUOTE_HASH)),
            ANCHOR_RELEASE_V3_DEVNET
        );
    }

    #[test]
    fn refund_hash_matches_v3_anchor() {
        assert_eq!(
            hex32(compute_refund_hash(&devnet_v3(), DEPOSIT_HASH, QUOTE_HASH)),
            ANCHOR_REFUND_V3_DEVNET
        );
    }

    /// The deposit preimage LAYOUT is untouched by CORE-2022 — only the version byte moved, and it
    /// is a hash input, so the deposit hash still changes. Freezing `devnet_v4` to its literal
    /// keeps the v4 anchor as history but leaves nothing pinning the version the program actually
    /// stamps today, which is the anchor that would catch a real deposit-layout regression.
    ///
    /// Expected value is spelled out field by field rather than taken from `compute_deposit_hash`,
    /// so this still fails if a field is reordered, dropped or re-encoded.
    #[test]
    fn deposit_hash_matches_the_current_version_layout() {
        let expected = keccak_hashv(&[
            b"escrow",
            &[ProtocolConfig::CURRENT_SIGNATURE_DOMAIN_VERSION],
            &cluster_id("devnet"),
            &PROGRAM_ID_BYTES,
            b"deposit",
            &DEPOSIT_REQUEST_HASH,
            &compute_destination_hash(DESTINATION),
            &DEPOSITOR_BYTES,
            &RECIPIENT_BYTES, // mint = USDC
            &AMOUNT.to_le_bytes(),
            &RESERVER_BYTES,
            &RELEASER_BYTES,
            &NONCE.to_le_bytes(),
            &ISSUED_AT.to_le_bytes(),
            &DEADLINE.to_le_bytes(),
        ]);

        let got = compute_deposit_hash(
            &devnet_current(),
            DEPOSIT_REQUEST_HASH,
            compute_destination_hash(DESTINATION),
            Pubkey::new_from_array(DEPOSITOR_BYTES),
            Pubkey::new_from_array(RECIPIENT_BYTES),
            AMOUNT,
            Pubkey::new_from_array(RESERVER_BYTES),
            Pubkey::new_from_array(RELEASER_BYTES),
            NONCE,
            ISSUED_AT,
            DEADLINE,
        );

        assert_eq!(
            hex32(got),
            hex32(expected),
            "the deposit preimage layout drifted at the current domain version"
        );
    }

    #[test]
    fn deposit_hash_matches_v4_anchor() {
        assert_eq!(
            hex32(compute_deposit_hash(
                &devnet_v4(),
                DEPOSIT_REQUEST_HASH,
                compute_destination_hash(DESTINATION),
                Pubkey::new_from_array(DEPOSITOR_BYTES),
                Pubkey::new_from_array(RECIPIENT_BYTES), // mint = USDC
                AMOUNT,
                Pubkey::new_from_array(RESERVER_BYTES),
                Pubkey::new_from_array(RELEASER_BYTES),
                NONCE,
                ISSUED_AT,
                DEADLINE,
            )),
            ANCHOR_DEPOSIT_V4_DEVNET
        );
    }

    /// The destination MUST be hashed to fixed width before entering the preimage.
    ///
    /// `keccak_hashv` concatenates without length prefixes, so a variable-length member makes
    /// injectivity conditional on the widths around it. This test pins the distinction two ways: the
    /// real implementation must produce the hashed-form anchor, and it must NOT produce the value an
    /// implementation that fed the raw string would produce. Both constants were derived out of band.
    #[test]
    fn raw_destination_feed_is_rejected() {
        let real = hex32(compute_deposit_hash(
            &devnet_v4(),
            DEPOSIT_REQUEST_HASH,
            compute_destination_hash(DESTINATION),
            Pubkey::new_from_array(DEPOSITOR_BYTES),
            Pubkey::new_from_array(RECIPIENT_BYTES),
            AMOUNT,
            Pubkey::new_from_array(RESERVER_BYTES),
            Pubkey::new_from_array(RELEASER_BYTES),
            NONCE,
            ISSUED_AT,
            DEADLINE,
        ));
        assert_eq!(
            real, ANCHOR_DEPOSIT_V4_DEVNET,
            "the deposit preimage no longer matches the hashed-destination anchor"
        );
        assert_ne!(
            real, ANCHOR_DEPOSIT_V4_RAW_DESTINATION_FED,
            "compute_deposit_hash is feeding the RAW destination string into keccak_hashv instead of \
             its 32-byte hash. keccak_hashv has no length prefixes, so this makes preimage injectivity \
             conditional on the surrounding field widths. Hash it first."
        );
    }

    /// compute_destination_hash must be plain keccak256 of the UTF-8 bytes, matching what EVM commits
    /// for the same canonical string. Pinned to an out-of-band literal.
    #[test]
    fn destination_hash_matches_the_cross_chain_value() {
        assert_eq!(
            hex32(compute_destination_hash(DESTINATION)),
            DESTINATION_HASH_HEX,
            "compute_destination_hash diverged from the value EVM commits for the same string"
        );
    }

    #[test]
    fn edge_case_anchors_match() {
        assert_eq!(
            hex32(keccak_hashv(&[
                b"escrow",
                &[3u8],
                &cluster_id("mainnet"),
                &PROGRAM_ID_BYTES,
                b"reserve",
                &RECIPIENT_BYTES,
                &DEPOSIT_HASH,
                &QUOTE_HASH,
            ])),
            ANCHOR_RESERVE_V3_MAINNET,
            "cluster_id must be the UTF-8 name right-padded with zeros"
        );
        assert_eq!(
            hex32(keccak_hashv(&[
                b"escrow",
                &[3u8],
                &cluster_id("devnet"),
                &PROGRAM_ID_BYTES,
                b"reserve",
                &RECIPIENT_BYTES,
                &DEPOSIT_HASH,
                &[0xff; 32],
            ])),
            ANCHOR_RESERVE_V3_MAX_QUOTE
        );
        assert_eq!(
            hex32(compute_release_hash(&devnet_v3(), DEPOSIT_HASH, [0xff; 32])),
            ANCHOR_RELEASE_V3_MAX_QUOTE
        );
        assert_eq!(
            hex32(compute_refund_hash(&devnet_v3(), DEPOSIT_HASH, [0u8; 32])),
            ANCHOR_REFUND_V3_ZERO_QUOTE,
            "a never-reserved deposit refunds with quote_hash = 0"
        );
    }

    /// quote_hash must be a real input to all three legs, positioned LAST.
    /// Without this, an encoder could ignore quote_hash and still pass anything
    /// that only checks one fixed vector.
    #[test]
    fn quote_hash_is_bound_and_positioned_last() {
        let cfg = devnet_v3();
        let recipient = Pubkey::new_from_array(RECIPIENT_BYTES);

        // Changing quote_hash alone must change every hash.
        assert_ne!(
            compute_reserve_hash(&cfg, recipient, DEPOSIT_HASH, QUOTE_HASH, 90_000),
            compute_reserve_hash(&cfg, recipient, DEPOSIT_HASH, [0x34; 32], 90_000)
        );
        assert_ne!(
            compute_release_hash(&cfg, DEPOSIT_HASH, QUOTE_HASH),
            compute_release_hash(&cfg, DEPOSIT_HASH, [0x34; 32])
        );
        assert_ne!(
            compute_refund_hash(&cfg, DEPOSIT_HASH, QUOTE_HASH),
            compute_refund_hash(&cfg, DEPOSIT_HASH, [0x34; 32])
        );

        // Swapping deposit_hash and quote_hash must change the digest, i.e. the
        // two 32-byte fields are ordered, not merely concatenated as a set.
        assert_ne!(
            compute_release_hash(&cfg, DEPOSIT_HASH, QUOTE_HASH),
            compute_release_hash(&cfg, QUOTE_HASH, DEPOSIT_HASH)
        );

        // The three operation tags must not collide with one another.
        let r = compute_release_hash(&cfg, DEPOSIT_HASH, QUOTE_HASH);
        let f = compute_refund_hash(&cfg, DEPOSIT_HASH, QUOTE_HASH);
        assert_ne!(r, f, "release and refund must be domain-separated");
    }

    /// The pre-v3 reserve layout is retired: the current function cannot
    /// reproduce the historical anchors at any version byte. This is what makes
    /// "just regenerate the goldens" the wrong response to a red anchor test.
    #[test]
    fn historical_pre_v3_anchors_are_unreachable_from_the_current_layout() {
        let recipient = Pubkey::new_from_array(RECIPIENT_BYTES);
        for (version, historical) in [
            (2u8, HISTORICAL_RESERVE_V2_DEVNET),
            (1u8, HISTORICAL_RESERVE_V1_DEVNET),
        ] {
            let cfg = config("devnet", version);
            for quote in [QUOTE_HASH, [0u8; 32], [0xff; 32]] {
                assert_ne!(
                    hex32(compute_reserve_hash(
                        &cfg,
                        recipient,
                        DEPOSIT_HASH,
                        quote,
                        90_000
                    )),
                    historical,
                    "v{version} historical anchor must not be reachable from the current layout"
                );
            }
        }

        // CORE-2120: the v3 DEPOSIT anchor is likewise unreachable, because destination_hash entered
        // the preimage and the domain version moved 3 -> 4. This is the replay property the version
        // bump exists for: a signature produced under v3 can never be replayed against v4. Sweeping
        // the destination_hash argument (including the empty-string hash and all-zeroes, the two values
        // an implementation might accidentally pass) shows the old value is not reachable by any of
        // them, rather than merely differing for the one fixture we happened to pick.
        for dh in [
            compute_destination_hash(DESTINATION),
            compute_destination_hash(""),
            [0u8; 32],
        ] {
            for cfg in [devnet_v3(), devnet_v4()] {
                assert_ne!(
                    hex32(compute_deposit_hash(
                        &cfg,
                        DEPOSIT_REQUEST_HASH,
                        dh,
                        Pubkey::new_from_array(DEPOSITOR_BYTES),
                        recipient,
                        AMOUNT,
                        Pubkey::new_from_array(RESERVER_BYTES),
                        Pubkey::new_from_array(RELEASER_BYTES),
                        NONCE,
                        ISSUED_AT,
                        DEADLINE,
                    )),
                    ANCHOR_DEPOSIT_V3_DEVNET,
                    "the pre-CORE-2120 v3 deposit anchor must not be reachable from the current layout"
                );
            }
        }
    }

    /// Cross-side anchor: the SAME fixture the Go and TypeScript encoders pin, fed
    /// through the real on-chain `compute_reserve_hash`.
    ///
    /// The other anchors in this module and the encoders' V2 anchors use different
    /// fixture inputs, so each side only ever pinned its own derivation. This test
    /// is the one place where the program and the off-chain encoders are required to
    /// agree on an IDENTICAL input, which is what actually rules out a silent
    /// wire-format split between them.
    ///
    /// Inputs are the encoder's V2 fixture verbatim
    /// (`contracts/svm/bindings/go/escrow-encoding/encoding/v2_quotehash_test.go`):
    /// cluster_id `b"test"` zero-padded, domain version 3, the real program id,
    /// deposit_hash `0x11..`, recipient `0x22..`, quote_hash `0x33..`.
    ///
    /// If this fails, the program and the encoders have diverged. Fix whichever side
    /// drifted from the documented layout — do NOT copy the computed value in.
    ///
    /// CORE-2022 widened this preimage with `source_amount`, so the V2 literal this test
    /// pinned (`c9eaa290…`, which covered recipient|deposit_hash|quote_hash only) can no longer
    /// be produced and has been retired rather than silently replaced with the new output —
    /// pasting in whatever the program now returns would have turned the cross-side check into a
    /// tautology.
    ///
    /// The cross-side literal is restored: the Go encoder pins the same value for the same
    /// fixture in `TestComputeReserveHashV3_CrossSideAnchor`
    /// (`contracts/svm/bindings/go/escrow-encoding/encoding/v3_sourceamount_test.go`), so a drift on
    /// either side fails on both. The expected value is ALSO spelled out field by field below,
    /// independently of `compute_reserve_hash`'s own ordering, so a reordered or re-encoded field
    /// is caught even if both sides were changed together.
    #[test]
    fn reserve_hash_matches_the_documented_v5_layout() {
        /// Same fixture and value the Go encoder pins. Derived out of band, not copied from this
        /// function's output.
        const GO_ENCODER_V3_RESERVE_ANCHOR: &str =
            "d9f194eb2cdbbb060453ee08633a736adbbdb5efd7bf680de0997b18b145daf4";

        let cfg = config("test", 5);
        let recipient = Pubkey::new_from_array([0x22; 32]);
        const SOURCE_AMOUNT: u64 = 90_000;

        let expected = keccak_hashv(&[
            b"escrow",
            &[5u8],
            &cluster_id("test"),
            &PROGRAM_ID_BYTES,
            b"reserve",
            &[0x22; 32],
            &[0x11; 32],
            &[0x33; 32],
            &SOURCE_AMOUNT.to_le_bytes(),
        ]);

        let got = compute_reserve_hash(&cfg, recipient, [0x11; 32], [0x33; 32], SOURCE_AMOUNT);

        assert_eq!(
            hex32(got),
            hex32(expected),
            "compute_reserve_hash no longer matches the documented preimage layout \
             escrow|version|cluster_id|program_id|\"reserve\"|recipient|deposit_hash|\
             quote_hash|source_amount(LE)"
        );

        assert_eq!(
            hex32(got),
            GO_ENCODER_V3_RESERVE_ANCHOR,
            "the program and the off-chain encoders disagree on the reserve hash for an \
             IDENTICAL input. One side has drifted from the documented preimage layout; \
             re-derive out of band rather than copying the computed value in."
        );
    }

    /// `source_amount` is genuinely bound: two otherwise-identical reserves that differ only in
    /// the charge must not share a signature. Without this, the field could be accepted into the
    /// function and dropped on the floor before hashing and every other test here would pass.
    #[test]
    fn reserve_hash_changes_with_source_amount() {
        let cfg = config("test", 5);
        let recipient = Pubkey::new_from_array([0x22; 32]);

        assert_ne!(
            compute_reserve_hash(&cfg, recipient, DEPOSIT_HASH, QUOTE_HASH, 90_000),
            compute_reserve_hash(&cfg, recipient, DEPOSIT_HASH, QUOTE_HASH, 100_000),
            "source_amount is not bound into the reserve preimage — a reserver signature for one \
             charge would authorize any other"
        );
    }

    /// Re-derives the two historical anchors from the RETIRED preimage, spelled
    /// out here rather than by calling `compute_reserve_hash`. Proves the pinned
    /// historical values really are the old layout of this same domain, so they
    /// stay meaningful documentation instead of two opaque hex blobs.
    #[test]
    fn historical_pre_v3_anchors_match_the_retired_layout() {
        let devnet = cluster_id("devnet");
        for (version, historical) in [
            (2u8, HISTORICAL_RESERVE_V2_DEVNET),
            (1u8, HISTORICAL_RESERVE_V1_DEVNET),
        ] {
            let got = keccak_hashv(&[
                b"escrow",
                &[version],
                &devnet,
                &PROGRAM_ID_BYTES,
                b"reserve",
                &RECIPIENT_BYTES,
                &DEPOSIT_HASH,
                // no quote_hash: this is the retired layout
            ]);
            assert_eq!(hex32(got), historical, "retired v{version} reserve layout");
        }
    }

    /// Exact preimage shape — total bytes and field count — MEASURED on what production hashes.
    ///
    /// A field silently widened, dropped or padded changes one of these even if some other test's
    /// fixture happens to alias.
    ///
    /// WHY IT NO LONGER RESTATES THE LAYOUT. This test used to assert one sum of integer literals
    /// against another integer literal. Both sides were compile-time constants, so no change to
    /// `compute_*_hash` could ever redden it — only editing the test could — and it had duly gone
    /// stale, still claiming the pre-CORE-2120 deposit length of 270 after `destination_hash` widened
    /// that preimage to 302. It now runs `measure` through the same `with_*_preimage` builders that
    /// `compute_*_hash` runs `keccak_hashv` through, so the left-hand side moves when production does.
    ///
    /// WHY THE FIELD COUNT IS HERE AND NOT REDUNDANT. It catches the one class of drift the hash
    /// anchors above structurally cannot see. `keccak_hashv` concatenates, so pre-joining two adjacent
    /// parts — say `nonce_le ‖ issued_at_le` into a single 16-byte buffer — yields a BYTE-IDENTICAL
    /// digest and an identical total; every anchor stays green while the preimage stops being a
    /// sequence of named fixed-width fields, which is the property the encoders in
    /// `contracts/svm/bindings` are written against. Verified by doing exactly that: all four
    /// anchor tests passed and only this one failed, on `(302, 14)` vs `(302, 15)`.
    #[test]
    fn preimage_lengths_are_pinned() {
        let cfg = devnet_v4();
        let recipient = Pubkey::new_from_array(RECIPIENT_BYTES);

        assert_eq!(
            with_reserve_preimage(&cfg, recipient, DEPOSIT_HASH, QUOTE_HASH, AMOUNT, measure),
            (182, 9),
            r#"reserve = "escrow"(6) + version(1) + cluster_id(32) + program_id(32) + "reserve"(7)
               + recipient(32) + deposit_hash(32) + quote_hash(32) + source_amount(8). 182, not the
               174 of the pre-CORE-2022 layout: source_amount is the 8 bytes that were added, and it
               is the ninth slice rather than the eighth"#
        );
        assert_eq!(
            with_release_preimage(&cfg, DEPOSIT_HASH, QUOTE_HASH, measure),
            (142, 7),
            r#"release = the 71-byte prefix + "release"(7) + deposit_hash(32) + quote_hash(32)"#
        );
        assert_eq!(
            with_refund_preimage(&cfg, DEPOSIT_HASH, QUOTE_HASH, measure),
            (141, 7),
            r#"refund = the 71-byte prefix + "refund"(6) + deposit_hash(32) + quote_hash(32). One
               byte shorter than release because b"refund" is 6 bytes where b"reserve"/b"release"
               are 7 — not a typo"#
        );
        assert_eq!(
            with_deposit_preimage(
                &cfg,
                DEPOSIT_REQUEST_HASH,
                compute_destination_hash(DESTINATION),
                Pubkey::new_from_array(DEPOSITOR_BYTES),
                Pubkey::new_from_array(RECIPIENT_BYTES),
                AMOUNT,
                Pubkey::new_from_array(RESERVER_BYTES),
                Pubkey::new_from_array(RELEASER_BYTES),
                NONCE,
                ISSUED_AT,
                DEADLINE,
                measure,
            ),
            (302, 15),
            r#"deposit = the 71-byte prefix + "deposit"(7) + deposit_request_hash(32)
               + destination_hash(32) + depositor(32) + mint(32) + amount(8) + reserver(32)
               + releaser(32) + nonce(8) + issued_at(8) + deadline(8). 302, not the 270 of the
               pre-CORE-2120 layout: destination_hash is the 32 bytes that were added"#
        );
    }
}
