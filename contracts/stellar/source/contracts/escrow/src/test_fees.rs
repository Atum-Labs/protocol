//! Fee parity with the EVM `determineFee`.
//!
//! The cases are the ones `contracts/svm/source/programs/escrow/src/utils/fees.rs`
//! (`cross_vm_fee_parity_tests`) walks, so a divergence between the three VMs surfaces as a failure
//! in one suite. The expected values come from `evm_determine_fee`, a line-by-line transcription of
//! `EscrowReserveLib.fee` that shares no code with `fees::determine_fee`; do not derive an expected
//! value from the function under test.

use crate::errors::Error;
use crate::fees::{determine_fee, validate_fee_config};
use crate::types::TokenConfig;

/// Returns None where Solidity reverts with `FeeExceedsDepositAmount`. Written in the shape of the
/// Solidity so it can be diffed by eye, hence the allowed `manual_div_ceil`.
#[allow(clippy::manual_div_ceil)]
fn evm_determine_fee(
    amount: u128,
    fee_percentage_6: u128,
    min_fee_6: u128,
    max_fee_6: u128,
    decimals: u32,
) -> Option<u128> {
    if amount == 0 {
        return Some(0);
    }
    let mut fee: u128 = 0;
    if fee_percentage_6 > 0 {
        fee = (amount * fee_percentage_6 + 100_000_000 - 1) / 100_000_000;
    }
    let decimals_factor = 10u128.pow(decimals);
    if min_fee_6 > 0 {
        let min_fee = (min_fee_6 * decimals_factor) / 1_000_000;
        if fee < min_fee {
            fee = min_fee;
        }
    }
    if max_fee_6 > 0 {
        let max_fee = (max_fee_6 * decimals_factor) / 1_000_000;
        if fee > max_fee {
            fee = max_fee;
        }
    }
    if fee >= amount {
        return None;
    }
    Some(fee)
}

fn cfg(pct: u32, min6: u64, max6: u64, decimals: u32) -> TokenConfig {
    TokenConfig {
        fee_percentage_6: pct,
        max_fee_6: max6,
        min_fee_6: min6,
        token_decimals: decimals,
    }
}

/// The Solana vector: 7 configs x 12 amounts x 2 decimals settings, plus the 7-decimal setting
/// Stellar tokens actually use.
pub const CONFIGS: [(u32, u64, u64); 7] = [
    (20_000, 0, 0),                // 0.02%, no clamps
    (100_000, 0, 0),               // 0.1%
    (1, 0, 0),                     // the smallest non-zero rate
    (20_000, 0, 25_000_000),       // 0.02% capped at $25
    (20_000, 500_000, 0),          // 0.02% with a $0.50 floor
    (20_000, 500_000, 25_000_000), // both clamps
    (20_000, 0, 5_000),            // a $0.005 cap: ZERO atoms below 6 decimals
];
pub const AMOUNTS: [u64; 12] = [
    1,
    2,
    3,
    999,
    1_000_000,
    1_000_001,
    50_000_000,
    100_000_000,
    100_000_001,
    123_456_789,
    999_999_999,
    140_000_000_000,
];

#[test]
fn determine_fee_matches_evm_across_the_shared_vector() {
    let mut compared = 0;
    for decimals in [6u32, 2, 7] {
        for (pct, min6, max6) in CONFIGS {
            for amount in AMOUNTS {
                let expected = evm_determine_fee(
                    amount as u128,
                    pct as u128,
                    min6 as u128,
                    max6 as u128,
                    decimals,
                );
                let actual = determine_fee(amount as i128, &cfg(pct, min6, max6, decimals));
                match expected {
                    Some(fee) => assert_eq!(
                        actual,
                        Ok(fee as i128),
                        "decimals={decimals} amount={amount} pct={pct} min6={min6} max6={max6}"
                    ),
                    None => assert_eq!(
                        actual,
                        Err(Error::FeeExceedsDepositAmount),
                        "decimals={decimals} amount={amount} pct={pct} min6={min6} max6={max6}"
                    ),
                }
                compared += 1;
            }
        }
    }
    // 168 are the Solana vector; the 7-decimal pass adds 84
    assert_eq!(compared, 252);
}

#[test]
fn ceiling_not_truncation() {
    // 0.02% of 100.000001 USDC: the product is not a multiple of 1e8
    assert_eq!(
        determine_fee(100_000_001, &cfg(20_000, 0, 0, 6)),
        Ok(20_001)
    );
}

#[test]
fn a_fee_equal_to_the_amount_is_rejected() {
    assert_eq!(
        determine_fee(1, &cfg(100_000_000, 0, 0, 6)),
        Err(Error::FeeExceedsDepositAmount)
    );
    // 10 ppm of one atom ceils to one atom, which equals the amount
    assert_eq!(
        determine_fee(1, &cfg(10, 0, 0, 6)),
        Err(Error::FeeExceedsDepositAmount)
    );
    assert_eq!(determine_fee(2, &cfg(10, 0, 0, 6)), Ok(1));
}

#[test]
fn a_fee_one_atom_below_the_amount_is_accepted() {
    // min_fee_6 is 1_000_000 on purpose: at 0 decimals a value of 1 would truncate to no floor
    assert_eq!(determine_fee(2, &cfg(0, 1_000_000, 0, 0)), Ok(1));
}

#[test]
fn zero_amount_is_free_as_on_evm_and_negative_is_refused() {
    assert_eq!(determine_fee(0, &cfg(20_000, 0, 0, 7)), Ok(0));
    assert_eq!(
        determine_fee(-1, &cfg(20_000, 0, 0, 7)),
        Err(Error::InvalidAmount)
    );
}

#[test]
fn an_amount_beyond_the_u128_product_fails_closed() {
    assert_eq!(
        determine_fee(i128::MAX, &cfg(100_000_000, 0, 0, 7)),
        Err(Error::FeeArithmeticFailed)
    );
}

#[test]
fn config_validation_matches_set_token_fee_config() {
    // Unrepresentable bounds at low decimals: 5_000 * 10^2 / 1e6 = 0 atoms
    assert_eq!(
        validate_fee_config(20_000, 0, 5_000, 2),
        Err(Error::MaxFeeNotRepresentable)
    );
    assert_eq!(validate_fee_config(20_000, 0, 5_000, 6), Ok(()));
    assert_eq!(
        validate_fee_config(0, 1, 0, 0),
        Err(Error::MinFeeNotRepresentable)
    );
    assert_eq!(validate_fee_config(0, 1_000_000, 0, 0), Ok(()));
    // The production shape: 0.02% with a $250 cap
    assert_eq!(validate_fee_config(20_000, 0, 250_000_000, 7), Ok(()));
    assert_eq!(
        validate_fee_config(100_000_001, 0, 0, 7),
        Err(Error::FeePercentageExceedsMaximum)
    );
    assert_eq!(
        validate_fee_config(20_000, 2_000_000, 1_000_000, 7),
        Err(Error::MinFeeCannotBeGreaterThanMaxFee)
    );
    assert_eq!(
        validate_fee_config(0, 0, 1_000_000, 7),
        Err(Error::FeePercentageCannotBeZeroWhenMaxFeeIsSet)
    );
    // min above max is fine when one side is unset
    assert_eq!(validate_fee_config(20_000, 2_000_000, 0, 7), Ok(()));
}
