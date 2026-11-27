// SPDX-License-Identifier: MIT
//! Release and refund anchors shared with the Go and TypeScript encoders.
//!
//! The Go `TestSolanaV2QuoteHashLayout` and the TypeScript `v4-destination.test.ts` assert these
//! same literals for these same inputs, so an encoder that drifts from the program fails on its own
//! side. The literals were derived out of band with an independent keccak-256 from the documented
//! layout: "escrow" | version | cluster_id | program_id | tag | deposit_hash | quote_hash.

mod hash_anchor_tests {
    use anchor_lang::prelude::Pubkey;
    use escrow::state::ProtocolConfig;
    use escrow::utils::signatures::{compute_refund_hash, compute_release_hash};

    /// `44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs`, the program id the encoders' fixture uses.
    const PROGRAM_ID_BYTES: [u8; 32] = [
        0x2d, 0x66, 0x32, 0x5a, 0x15, 0x9b, 0x21, 0x43, 0x3c, 0xa8, 0x18, 0xab, 0x4b, 0x70, 0x51,
        0x9d, 0x16, 0x6c, 0x8c, 0x96, 0x84, 0xdd, 0xd2, 0x18, 0x63, 0x71, 0x47, 0x89, 0x6c, 0x01,
        0x22, 0x38,
    ];
    const DEPOSIT_HASH: [u8; 32] = [0x11; 32];
    const QUOTE_HASH: [u8; 32] = [0x33; 32];

    /// (domain version, release, refund). Version 3 is where this layout began; version 5 is the
    /// one the program stamps today. Each release and refund preimage writes its own version byte,
    /// so both are pinned.
    const ANCHORS: [(u8, &str, &str); 2] = [
        (
            3,
            "f36c58efe96114e152ea68242ae176d6d0915155db834596b437ff90403b422d",
            "749ed0f68c7e49b52dca8479aa0dfb9a61d355754fb6ed2ff432a2367175f594",
        ),
        (
            5,
            "64d43a5fa2dd3cfa93bb47fb00affffb3dfaa1597174d3de2b646f34ae5c57fe",
            "584a935d3088e3f30b1a47a4ac453f9a15f190b0a069781f69804af5a0995123",
        ),
    ];

    fn test_cluster_config(version: u8) -> ProtocolConfig {
        let mut cluster_id = [0u8; 32];
        cluster_id[..4].copy_from_slice(b"test");
        ProtocolConfig {
            default_admin: Pubkey::default(),
            token_config_authority: Pubkey::default(),
            treasurer: Pubkey::default(),
            pauser: Pubkey::default(),
            paused: false,
            cluster_id,
            signature_domain_version: version,
            default_admin_delay_seconds: 0,
            pending_default_admin: None,
            pending_default_admin_accept_after_ts: None,
        }
    }

    fn hex32(bytes: [u8; 32]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn fixture_uses_the_declared_program_id_and_current_version() {
        assert_eq!(
            escrow::ID,
            Pubkey::new_from_array(PROGRAM_ID_BYTES),
            "the shared anchors were derived for a different program id than declare_id!"
        );
        assert!(
            ANCHORS
                .iter()
                .any(|(v, _, _)| *v == ProtocolConfig::CURRENT_SIGNATURE_DOMAIN_VERSION),
            "no shared release/refund anchor at the current domain version; derive one out of band \
             and add it to the Rust, Go and TypeScript suites together"
        );
    }

    #[test]
    fn release_hash_matches_the_shared_encoder_anchor() {
        for (version, release, _) in ANCHORS {
            assert_eq!(
                hex32(compute_release_hash(
                    &test_cluster_config(version),
                    DEPOSIT_HASH,
                    QUOTE_HASH
                )),
                release,
                "the program and the encoders disagree on the release hash at domain version \
                 {version}; re-derive out of band, never copy the computed value in"
            );
        }
    }

    #[test]
    fn refund_hash_matches_the_shared_encoder_anchor() {
        for (version, _, refund) in ANCHORS {
            assert_eq!(
                hex32(compute_refund_hash(
                    &test_cluster_config(version),
                    DEPOSIT_HASH,
                    QUOTE_HASH
                )),
                refund,
                "the program and the encoders disagree on the refund hash at domain version \
                 {version}; re-derive out of band, never copy the computed value in"
            );
        }
    }
}
