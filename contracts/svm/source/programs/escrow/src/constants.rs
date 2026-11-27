// SPDX-License-Identifier: MIT
pub const MINT_FEE_CONFIG_SEED: &[u8] = b"mint_fee_config";
pub const PROTOCOL_CONFIG_SEED: &[u8] = b"protocol_config";

/// Maximum byte length of the depositor-committed destination string.
///
/// 256 is uniform across EVM, TVM and SVM so one client signing-policy rule covers every chain.
///
/// SOLANA-SPECIFIC CEILING, READ THIS BEFORE RAISING IT. A legacy Solana transaction caps at 1232
/// bytes. The deposit transaction is roughly 1080 + destination_len at the current 17-key /
/// 2-signature shape, so a LEGACY transaction only admits about 152 bytes of destination; one
/// signature reaches about 248, still short of 256. A destination above the legacy ceiling therefore
/// requires a v0 transaction with an address lookup table (net about -213 bytes, admitting ~365).
/// Real destinations measure ~103 bytes (eip155) and ~135 bytes (solana:.../token:...@account), so
/// normal traffic never approaches this - which is exactly why the ceiling is written down here
/// rather than discovered as a transaction-too-large failure in production.
pub const MAX_DESTINATION_LEN: usize = 256;
