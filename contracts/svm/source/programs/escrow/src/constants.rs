pub const MINT_FEE_CONFIG_SEED: &[u8] = b"mint_fee_config";
pub const PROTOCOL_CONFIG_SEED: &[u8] = b"protocol_config";

/// Labels of the escrow signed text `<label> <base64url-nopad(hash)>`, one per signed instruction.
pub const DEPOSIT_SIGNING_LABEL: &[u8] = b"atum deposit v1";
pub const RESERVE_SIGNING_LABEL: &[u8] = b"atum reserve v1";
pub const RELEASE_SIGNING_LABEL: &[u8] = b"atum release v1";
pub const REFUND_SIGNING_LABEL: &[u8] = b"atum refund v1";

/// keccak256 of empty bytes, the destination hash of an empty destination string.
pub const EMPTY_DESTINATION_HASH: [u8; 32] = [
    0xc5, 0xd2, 0x46, 0x01, 0x86, 0xf7, 0x23, 0x3c, 0x92, 0x7e, 0x7d, 0xb2, 0xdc, 0xc7, 0x03, 0xc0,
    0xe5, 0x00, 0xb6, 0x53, 0xca, 0x82, 0x27, 0x3b, 0x7b, 0xfa, 0xd8, 0x04, 0x5d, 0x85, 0xa4, 0x70,
];
