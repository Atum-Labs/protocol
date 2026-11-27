// SPDX-License-Identifier: MIT
use anchor_lang::prelude::*;

use crate::errors::ErrorCode;

/// Fee calculation constants
pub const FEE_PERCENTAGE_SCALE: u128 = 100_000_000; // 100% = 100_000_000
pub const FEE_6_SCALE: u128 = 1_000_000; // 6-decimal normalization

/// Compute fee amount in token atomics given deposit amount and mint config
///
/// Algorithm:
/// 1. If amount == 0 → reject (AmountMustBeGreaterThanZero)
/// 2. Percentage fee: fee = ceil(amount * fee_percentage_6 / 100_000_000)
///    - Defense-in-depth: enforce fee_percentage_6 <= 100_000_000
/// 3. Min clamp: fee = max(fee, min_fee_atoms)
/// 4. Max clamp: fee = min(fee, max_fee_atoms)
/// 5. Validate: fee >= amount → FeeExceedsAmount
///
/// There is deliberately NO atomic fallback ("if pct > 0 and fee rounded to 0, charge 1"). EVM and
/// TVM have none, and under the step-2 ceiling the only way to reach a zero fee with a non-zero rate
/// is a max clamp that truncates to zero atoms — which needs 1 <= max_fee_6 < 10^(6 - decimals),
/// unreachable at 6 decimals and above. Below that, EVM/TVM refuse the CONFIG outright
/// (MaxFeeNotRepresentable), which `validate_mint_fee_config` now mirrors, so the state a fallback
/// would paper over cannot be stored in the first place.
///
/// CROSS-VM PARITY IS THE POINT OF STEPS 2 AND 5 (Cantina F1, Jayfromthe13th). Both used to
/// disagree with EVM/TVM's `Escrow.determineFee`, on the same inputs, in two ways:
///
///   * ROUNDING. This truncated where EVM/TVM take the ceiling
///     (`(amount * pct + 100_000_000 - 1) / 100_000_000`, documented there as "rounded up in the
///     protocol's favor"). Any amount whose product is not an exact multiple of the scale — i.e.
///     most real amounts — produced a fee one atom lower here than on the other two chains.
///
///   * THE BOUNDARY. This accepted `fee == amount` where EVM/TVM reject it (`>=` there). On SVM
///     `release` sends `amount - fee_amount` to `recipient_ata` and `fee_amount` to `treasury_ata`,
///     and the recipient at release is the SETTLER being reimbursed for having already paid out on
///     the destination chain. So a deposit with `fee == amount` was accepted, and then paid the
///     settler exactly zero while the treasury took the whole deposit — a configuration that the
///     other two VMs refuse at deposit time. Now it is refused here too.
///
/// Ceiling was chosen over truncation because it is what two of the three VMs already do, what the
/// EVM contract documents as intentional, and the direction that can never under-charge.
pub fn compute_fee(
    amount: u64,
    mint_decimals: u8,
    fee_percentage_6: u64,
    min_fee_6: u64,
    max_fee_6: u64,
) -> Result<u64> {
    // Step 1: Reject zero amount
    require!(amount > 0, ErrorCode::AmountMustBeGreaterThanZero);

    let amount_u128 = amount as u128;

    // Step 2: Calculate percentage fee
    let mut fee: u128 = if fee_percentage_6 > 0 {
        // Defense-in-depth: enforce fee_percentage_6 <= 100% even if validation was bypassed
        require!(
            fee_percentage_6 <= 100_000_000,
            ErrorCode::FeePercentageTooHigh
        );
        // ceil(amount * fee_percentage_6 / 100_000_000), as (a*b + c - 1) / c — the identical
        // formula EVM/TVM use. The `+ c - 1` cannot overflow u128 here: the product is at most
        // u64::MAX * 1e8 ~= 1.8e27, and u128::MAX ~= 3.4e38.
        amount_u128
            .checked_mul(fee_percentage_6 as u128)
            .ok_or(ErrorCode::FeeArithmeticFailed)?
            .checked_add(FEE_PERCENTAGE_SCALE - 1)
            .ok_or(ErrorCode::FeeArithmeticFailed)?
            / FEE_PERCENTAGE_SCALE
    } else {
        0
    };

    // Convert 6-decimal normalized values to atomics
    let decimals_factor = 10u128.pow(mint_decimals as u32);

    // Step 3: Min fee clamp
    let min_fee_atoms = if min_fee_6 > 0 {
        // floor(min_fee_6 * 10^decimals / 1_000_000)
        (min_fee_6 as u128)
            .checked_mul(decimals_factor)
            .ok_or(ErrorCode::FeeArithmeticFailed)?
            / FEE_6_SCALE
    } else {
        0
    };
    fee = fee.max(min_fee_atoms);

    // Step 4: Max fee clamp
    if max_fee_6 > 0 {
        let max_fee_atoms = (max_fee_6 as u128)
            .checked_mul(decimals_factor)
            .ok_or(ErrorCode::FeeArithmeticFailed)?
            / FEE_6_SCALE;
        fee = fee.min(max_fee_atoms);
    }

    // Convert back to u64
    let fee_u64 = u64::try_from(fee).map_err(|_| ErrorCode::FeeArithmeticFailed)?;

    // Step 5: Validate fee doesn't reach the amount.
    // STRICT `<`, matching EVM/TVM's `if (feeAmount >= amount) revert`. `<=` accepted a deposit
    // whose entire value was fee, leaving the settler with a zero release. See the note on this
    // function.
    require!(fee_u64 < amount, ErrorCode::FeeExceedsAmount);

    Ok(fee_u64)
}

/// Rescale the deposit-time fee snapshot to the amount actually reserved.
///
/// `reserve` narrows `deposit.amount` from the signed ceiling to the winning `source_amount`, and
/// the fee has to follow it: `release` pays the settler `amount - fee_amount`, so a fee still
/// computed over the ceiling would silently underpay them.
///
/// THE INTERMEDIATE PRODUCT IS WIDENED TO u128 AND THAT IS THE ENTIRE POINT. Every input is a
/// u64, and `fee * reserved` overflows u64::MAX (~1.845e19) long before the divide can bring it
/// back under the original fee. The u64 version of this returned None from `checked_mul` and the
/// handler mapped that to a revert — and because `reserve` is the only writer of
/// `deposit.recipient` and is guarded by `require!(deposit.recipient.is_none())`, it could not be
/// retried or split. The deposit could then only ever be refunded, never released: a live
/// settlement path lost at ~135k USDC for a 6-decimal token at 0.1%, lower as the fee rate or
/// the token's decimals rise (Cantina F23, Jayfromthe13th).
///
/// The earlier code reasoned that "the result can never exceed the original fee". That is true of
/// the QUOTIENT and false of the PRODUCT formed before the division — which is the value that
/// overflowed. Widening matches what `compute_fee` above already does for the same reason.
///
/// ROUNDING IS UP, MATCHING `compute_fee`. Callers enforce `0 < reserved <= deposit_amount`
/// (instructions/escrow.rs:483-487), so `ceil(fee_amount * reserved / deposit_amount)` is always
/// <= `fee_amount`, with equality exactly at a full reserve: the ceiling cannot invent fee the payer
/// was not quoted, and the narrowing back to u64 cannot fail for in-range inputs (it is still
/// checked rather than cast).
///
/// THIS IS NOT `determineFee(reserved)` PARITY AND DOES NOT CLAIM TO BE. Scaling a snapshot cannot
/// reproduce it: the snapshot already absorbed a ceiling taken against the CEILING amount, and that
/// residue is not recoverable from the smaller denominator. What does hold, for every in-range
/// input, is
///
/// ```text
/// floor(fee*r/d) <= determineFee(r) <= ceil(fee*r/d) <= fee_amount
/// ```
///
/// so the two roundings sit one atom either side of EVM/TVM and NEITHER is exact — ceiling is not
/// chosen because it matches. It is chosen because flooring put SVM one atom BELOW the fee on every
/// charge that does not divide exactly, which is the direction `compute_fee` above explicitly rules
/// out ("the direction that can never under-charge"). Same principle, same money, same deposit.
/// Where the snapshot itself divides exactly, ceiling happens to be `determineFee(reserved)` on the
/// nose; that is a coincidence of those inputs, not a guarantee.
///
/// Note the min/max clamp is separately and deliberately NOT re-evaluated against the smaller
/// amount — see `reserve` — so a clamped deposit diverges from `determineFee(reserved)` by far more
/// than a rounding step, in a way no rounding choice here can address.
///
/// Ceiling also makes `fee == reserved` REACHABLE, which flooring did not: `floor(fee*r/d) >= r`
/// needs `fee >= d`, which `compute_fee` already rejects at deposit, whereas `ceil(fee*1/d)` is 1
/// for any non-zero snapshot. `reserve` re-checks the `fee < amount` boundary for that reason.
pub fn rescale_reserved_fee(fee_amount: u64, reserved: u64, deposit_amount: u64) -> Result<u64> {
    // Guarded BEFORE div_ceil: u128::div_ceil PANICS on a zero divisor where checked_div returned
    // None, and a panic is a failed transaction rather than a mapped revert.
    require!(deposit_amount > 0, ErrorCode::FeeArithmeticFailed);

    let scaled = (fee_amount as u128)
        .checked_mul(reserved as u128)
        .ok_or(ErrorCode::FeeArithmeticFailed)?
        .div_ceil(deposit_amount as u128);

    u64::try_from(scaled).map_err(|_| ErrorCode::FeeArithmeticFailed.into())
}

/// Validate mint fee config parameters
/// `mint_decimals` is required, not optional: a fee expressed in 6-decimal normalized units can
/// truncate to ZERO atoms on a low-decimal mint, and `compute_fee` would then either lose a
/// configured floor or clamp every fee to nothing. EVM and TVM refuse such a config outright
/// (`MinFeeNotRepresentable` / `MaxFeeNotRepresentable` in `Escrow.setTokenConfig`, commented there
/// as "This prevents silent rounding to zero for low-decimal tokens"); this is that guard ported, so
/// the unrepresentable state cannot be STORED rather than being papered over at compute time.
///
/// The zeroing window is `1 <= fee_6 < 10^(6 - decimals)`, which is empty at 6 decimals and above —
/// so this rejects nothing on USDC/USDT and is purely a low-decimal guard.
pub fn validate_mint_fee_config(
    fee_percentage_6: u64,
    min_fee_6: u64,
    max_fee_6: u64,
    mint_decimals: u8,
) -> Result<()> {
    // If fee_percentage_6 > 0 → require <= 100%
    if fee_percentage_6 > 0 {
        require!(
            fee_percentage_6 <= 100_000_000,
            ErrorCode::FeePercentageTooHigh
        );
    }

    // If both min and max set → require min <= max
    if min_fee_6 > 0 && max_fee_6 > 0 {
        require!(min_fee_6 <= max_fee_6, ErrorCode::MinFeeGreaterThanMaxFee);
    }

    // If max_fee_6 > 0 → require fee_percentage_6 > 0
    if max_fee_6 > 0 {
        require!(fee_percentage_6 > 0, ErrorCode::MaxFeeSetButPercentageZero);
    }

    // Representability, mirroring Escrow.setTokenConfig. Same truncating conversion compute_fee
    // uses, so a config that passes here cannot round to zero atoms there.
    let decimals_factor = 10u128.pow(mint_decimals as u32);
    if min_fee_6 > 0 {
        let min_fee_atoms = (min_fee_6 as u128)
            .checked_mul(decimals_factor)
            .ok_or(ErrorCode::FeeArithmeticFailed)?
            / FEE_6_SCALE;
        require!(min_fee_atoms > 0, ErrorCode::MinFeeNotRepresentable);
    }
    if max_fee_6 > 0 {
        let max_fee_atoms = (max_fee_6 as u128)
            .checked_mul(decimals_factor)
            .ok_or(ErrorCode::FeeArithmeticFailed)?
            / FEE_6_SCALE;
        require!(max_fee_atoms > 0, ErrorCode::MaxFeeNotRepresentable);
    }

    Ok(())
}

#[cfg(test)]
mod reserve_fee_rescale_tests {
    //! Cantina F23 (Jayfromthe13th): the reserve-time fee rescale overflowed u64 and forced
    //! large-but-ordinary deposits onto the refund-only path.
    //!
    //! `reserve` is the only writer of `deposit.recipient` and is guarded by
    //! `require!(deposit.recipient.is_none())`, so a revert there cannot be retried or split into
    //! partial reserves. Nothing is stolen and nothing is frozen — `refund` still returns the whole
    //! balance — but the settlement the payer actually asked for can never complete. That makes a
    //! silent arithmetic overflow a permanent loss of the happy path, and a cross-VM parity break:
    //! EVM and TVM take `sourceAmount` at deposit and compute the fee once in uint256, so the same
    //! payment settles there and reverted only on Solana.

    use super::*;

    /// 6-decimal token (USDC). FEE_PERCENTAGE_SCALE is 1e8, so 0.1% is 100_000.
    const USDC_DECIMALS: u8 = 6;
    const FEE_0_1_PCT_6: u64 = 100_000;

    /// The exact arithmetic the handler used before the fix: the product is formed in u64.
    /// Kept so the regression is demonstrated rather than asserted — without it these tests
    /// would pass just as happily against code that never had the bug.
    fn pre_fix_u64_rescale(fee_amount: u64, reserved: u64, deposit_amount: u64) -> Option<u64> {
        fee_amount
            .checked_mul(reserved)
            .and_then(|product| product.checked_div(deposit_amount))
    }

    #[test]
    fn pre_fix_u64_rescale_overflows_on_a_large_full_reserve() {
        // 140,000 USDC => 140_000_000_000 atoms. compute_fee widens to u128 already, so the
        // SNAPSHOT is fine at 140_000_000 atoms; only the rescale was exposed.
        let amount: u64 = 140_000 * 1_000_000;
        let fee = compute_fee(amount, USDC_DECIMALS, FEE_0_1_PCT_6, 0, 0).unwrap();
        assert_eq!(fee, 140_000_000);

        // fee * amount = 1.96e19 > u64::MAX = 1.845e19. checked_mul returns None, which the
        // handler mapped to InvalidData and a revert.
        assert_eq!(
            pre_fix_u64_rescale(fee, amount, amount),
            None,
            "documents the bug: the pre-divide product overflows u64 on a full reserve"
        );
    }

    #[test]
    fn rescale_preserves_the_fee_on_the_deposit_that_used_to_revert() {
        let amount: u64 = 140_000 * 1_000_000;
        let fee = compute_fee(amount, USDC_DECIMALS, FEE_0_1_PCT_6, 0, 0).unwrap();

        assert_eq!(
            rescale_reserved_fee(fee, amount, amount).unwrap(),
            fee,
            "a full reserve must return the deposit-time snapshot unchanged"
        );
    }

    #[test]
    fn rescale_is_proportional_for_a_partial_reserve() {
        let amount: u64 = 140_000 * 1_000_000;
        let fee = compute_fee(amount, USDC_DECIMALS, FEE_0_1_PCT_6, 0, 0).unwrap();

        let half = amount / 2;
        let rescaled = rescale_reserved_fee(fee, half, amount).unwrap();
        assert_eq!(rescaled, fee / 2);
        assert!(
            rescaled <= fee,
            "the rescale must never exceed the quoted snapshot"
        );
    }

    #[test]
    fn rescale_survives_extreme_u64_inputs() {
        // The whole u64 range stays inside u128 for the intermediate product.
        let max = u64::MAX;
        assert_eq!(rescale_reserved_fee(max, max, max).unwrap(), max);
    }

    /// The rounding the rescale used before this change: plain floor division. Kept so the
    /// direction is demonstrated rather than asserted — every other input in this module divides
    /// exactly, where floor and ceiling agree, so a test written only against the production
    /// function would pass under either convention.
    fn pre_fix_flooring_rescale(fee_amount: u64, reserved: u64, deposit_amount: u64) -> u128 {
        (fee_amount as u128) * (reserved as u128) / (deposit_amount as u128)
    }

    #[test]
    fn rescale_rounds_up_on_a_partial_reserve_that_does_not_divide_exactly() {
        // 0.02% of a 200.000000-unit ceiling is 40_000 atoms EXACTLY, so the snapshot carries no
        // rounding residue of its own and the only rounding left is the rescale's.
        let ceiling: u64 = 200_000_000;
        let snapshot = compute_fee(ceiling, USDC_DECIMALS, 20_000, 0, 0).unwrap();
        assert_eq!(snapshot, 40_000);

        // 40_000 * 100_000_001 = 4_000_000_040_000; / 200_000_000 = 20_000.0002.
        let charge: u64 = 100_000_001;
        assert_eq!(
            pre_fix_flooring_rescale(snapshot, charge, ceiling),
            20_000,
            "pre-fix SVM value: floor, one atom under what compute_fee would have charged"
        );
        assert_eq!(
            rescale_reserved_fee(snapshot, charge, ceiling).unwrap(),
            20_001,
            "the rescale must round the direction compute_fee rounds"
        );
        assert!(rescale_reserved_fee(snapshot, charge, ceiling).unwrap() <= snapshot);
        assert_eq!(
            rescale_reserved_fee(snapshot, ceiling, ceiling).unwrap(),
            snapshot,
            "a full reserve is still exactly the snapshot, not one atom more"
        );
    }

    #[test]
    fn rescale_can_reach_the_charge_on_a_one_atom_reserve() {
        // Ceiling makes `fee == source_amount` REACHABLE, where flooring could not:
        // floor(fee * r / d) >= r requires fee >= d, which compute_fee rejects at deposit.
        // compute_fee forbids that state, so `reserve` guards it too — see the require! there.
        let ceiling: u64 = 200_000_000;
        let snapshot = compute_fee(ceiling, USDC_DECIMALS, 20_000, 0, 0).unwrap();

        assert_eq!(pre_fix_flooring_rescale(snapshot, 1, ceiling), 0);
        assert_eq!(
            rescale_reserved_fee(snapshot, 1, ceiling).unwrap(),
            1,
            "a one-atom charge scales to a one-atom fee, i.e. the entire charge"
        );
    }

    #[test]
    fn rescale_rejects_a_zero_deposit_amount_instead_of_panicking() {
        // Not reachable today (deposit rejects amount == 0), but integer division by zero is a
        // panic rather than a revert, so it stays a checked error.
        assert!(rescale_reserved_fee(1, 0, 0).is_err());
    }
}

#[cfg(test)]
mod cross_vm_fee_parity_tests {
    //! Cantina F1 (Jayfromthe13th): `compute_fee` disagreed with EVM/TVM `Escrow.determineFee` on
    //! rounding direction and at the fee == amount boundary.
    //!
    //! These tests are written against an INDEPENDENT transcription of the Solidity, not against
    //! `compute_fee` — deriving the expected value from the function under test would make them
    //! pass no matter which convention either side used, which is exactly the bug they exist to
    //! catch. `evm_determine_fee` below is a line-by-line port of
    //! contracts/evm/source/src/Escrow.sol::determineFee; if that Solidity changes, this must
    //! change with it and these tests are what will notice.

    use super::*;

    /// Line-by-line port of EVM/TVM `Escrow.determineFee`. Returns None where Solidity reverts
    /// with `FeeExceedsDepositAmount`.
    ///
    /// Deliberately NOT sharing code with `compute_fee`: it is the independent oracle.
    ///
    /// `manual_div_ceil` is allowed on purpose. Clippy is right that `.div_ceil(100_000_000)` is
    /// the idiomatic Rust, and the production `compute_fee` is free to use whatever reads best —
    /// but this function's whole value is that it can be diffed BY EYE against the Solidity it
    /// mirrors, which is written `(amount * feePercentage6Decimals + 100_000_000 - 1) / 100_000_000`.
    /// Rewriting it into a different shape than the source of truth is what would make a future
    /// divergence hard to spot.
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
        // (amount * feePercentage6Decimals + 100_000_000 - 1) / 100_000_000
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
        // if (feeAmount >= amount) revert FeeExceedsDepositAmount
        if fee >= amount {
            return None;
        }
        Some(fee)
    }

    /// The percentage step exactly as it was BEFORE the fix, so the divergence is demonstrated
    /// rather than asserted. Without this, these tests would pass just as happily against code
    /// that never had the bug.
    fn pre_fix_truncating_percentage_fee(amount: u64, fee_percentage_6: u64) -> u128 {
        (amount as u128) * (fee_percentage_6 as u128) / FEE_PERCENTAGE_SCALE
    }

    const USDC_DECIMALS: u8 = 6;

    #[test]
    fn truncation_and_ceiling_really_did_disagree_on_non_exact_amounts() {
        // 0.02% on 100.000001 USDC: the product is NOT an exact multiple of 1e8, which is the
        // ordinary case, not a contrived one.
        let amount: u64 = 100_000_001;
        let pct: u64 = 20_000;

        let truncated = pre_fix_truncating_percentage_fee(amount, pct);
        let ceiled = evm_determine_fee(amount as u128, pct as u128, 0, 0, 6).unwrap();

        assert_eq!(truncated, 20_000, "pre-fix SVM value");
        assert_eq!(ceiled, 20_001, "EVM/TVM value");
        assert_eq!(
            ceiled - truncated,
            1,
            "the two VMs charged fees one atom apart for the same deposit"
        );
    }

    #[test]
    fn compute_fee_matches_evm_across_a_vector_of_amounts_and_configs() {
        // (fee_percentage_6, min_fee_6, max_fee_6)
        let configs: [(u64, u64, u64); 7] = [
            (20_000, 0, 0),                // 0.02%, no clamps
            (100_000, 0, 0),               // 0.1%
            (1, 0, 0),                     // the smallest non-zero rate
            (20_000, 0, 25_000_000),       // 0.02% capped at $25
            (20_000, 500_000, 0),          // 0.02% with a $0.50 floor
            (20_000, 500_000, 25_000_000), // both clamps
            (20_000, 0, 5_000),            // a $0.005 cap: ZERO atoms below 6 decimals
        ];

        // Deliberately mixes exact multiples of the scale with amounts that are not, plus the
        // small amounts where the clamps interact.
        let amounts: [u64; 12] = [
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

        let mut compared = 0usize;
        // The decimals axis is what reaches the clamp-truncates-to-zero class: max_fee_atoms is 0
        // exactly when 1 <= max_fee_6 < 10^(6 - decimals), which is EMPTY at 6 decimals. Both sides
        // must read the same `decimals` variable or this stops being a parity test.
        for decimals in [USDC_DECIMALS, 2u8] {
            for (pct, min6, max6) in configs {
                for amount in amounts {
                    let expected = evm_determine_fee(
                        amount as u128,
                        pct as u128,
                        min6 as u128,
                        max6 as u128,
                        decimals as u32,
                    );
                    let actual = compute_fee(amount, decimals, pct, min6, max6);

                    match expected {
                        Some(expected_fee) => {
                            let actual_fee = actual.unwrap_or_else(|_| {
                            panic!(
                                "SVM rejected a deposit EVM accepts: decimals={decimals} amount={amount} \
                                 pct={pct} min6={min6} max6={max6} (EVM fee={expected_fee})"
                            )
                        });
                            assert_eq!(
                            actual_fee as u128, expected_fee,
                            "fee mismatch: decimals={decimals} amount={amount} pct={pct} min6={min6} max6={max6}"
                        );
                        }
                        None => {
                            assert!(
                            actual.is_err(),
                            "EVM reverts FeeExceedsDepositAmount but SVM accepted: decimals={decimals} \
                             amount={amount} pct={pct} min6={min6} max6={max6} (SVM fee={:?})",
                            actual.ok()
                        );
                        }
                    }
                    compared += 1;
                }
            }
        }
        assert_eq!(compared, 168, "the vector must actually have been walked");
    }

    #[test]
    fn an_unrepresentable_clamp_is_refused_at_config_time_as_evm_refuses_it() {
        // EVM/TVM reject this config in setTokenConfig (MaxFeeNotRepresentable), commented there as
        // "This prevents silent rounding to zero for low-decimal tokens". Before this guard existed,
        // SVM STORED it and compute_fee then clamped every fee to zero — which the removed atomic
        // fallback turned into a silent 1-atom charge where EVM returns 0.
        //
        // 5_000 * 10^2 / 1_000_000 = 500_000 / 1_000_000 = 0 atoms.
        assert!(
            validate_mint_fee_config(20_000, 0, 5_000, 2).is_err(),
            "a max fee that truncates to zero atoms must be refused, not stored"
        );
        // The same numbers are fine at 6 decimals: 5_000 * 10^6 / 1e6 = 5_000 atoms.
        assert!(validate_mint_fee_config(20_000, 0, 5_000, 6).is_ok());

        // The min side too: 1 * 10^0 / 1e6 = 0.
        assert!(validate_mint_fee_config(0, 1, 0, 0).is_err());
        assert!(validate_mint_fee_config(0, 1_000_000, 0, 0).is_ok());

        // The production configs must keep passing: USDC/USDT at 6 decimals, 0.02%, $250 cap.
        assert!(validate_mint_fee_config(20_000, 0, 250_000_000, 6).is_ok());
    }

    #[test]
    fn a_fee_equal_to_the_amount_is_rejected_on_both_vms() {
        // 100% of 1 atom is 1 atom. EVM's `feeAmount >= amount` rejects it; SVM's `<=` accepted
        // it, minting a deposit whose entire value was fee and whose settler release was zero.
        let amount: u64 = 1;
        let pct: u64 = 100_000_000; // 100%

        assert_eq!(
            evm_determine_fee(amount as u128, pct as u128, 0, 0, 6),
            None,
            "EVM rejects fee == amount"
        );
        assert!(
            compute_fee(amount, USDC_DECIMALS, pct, 0, 0).is_err(),
            "SVM must now reject fee == amount too"
        );

        // The pre-fix comparator is what accepted it: the fee it computed was exactly the amount.
        assert_eq!(
            pre_fix_truncating_percentage_fee(amount, pct),
            amount as u128
        );
    }

    #[test]
    fn a_fee_of_one_atom_below_the_amount_is_still_accepted_on_both_vms() {
        // The guard must reject only the boundary, not everything near it: 100% of 2 atoms is 2,
        // which both reject, but a min-fee floor of 1 atom on a 2-atom deposit is legal.
        let amount: u64 = 2;
        // min_fee_6 must be 1_000_000, not 1: the conversion is min_fee_6 * 10^decimals / 1e6, so
        // at 0 decimals a min_fee_6 of 1 truncates to ZERO atoms and the "floor" this test claims to
        // exercise would not exist — the assertion would be 0 == 0 and would still pass with the
        // min clamp deleted from production entirely.
        assert_eq!(
            compute_fee(amount, 0, 0, 1_000_000, 0).unwrap() as u128,
            evm_determine_fee(amount as u128, 0, 1_000_000, 0, 0).unwrap()
        );
    }

    #[test]
    fn the_smallest_taxable_deposit_charges_one_atom_on_both_vms() {
        // Under truncation this needed the removed atomic fallback to avoid a zero fee. Under
        // ceiling it falls out of the arithmetic — and both VMs agree either way.
        let amount: u64 = 1;
        let pct: u64 = 10; // 0.00001%

        assert_eq!(pre_fix_truncating_percentage_fee(amount, pct), 0);
        assert_eq!(
            evm_determine_fee(amount as u128, pct as u128, 0, 0, 6),
            None
        );
        // EVM rejects because ceil() makes the fee 1, which is >= the 1-atom amount. SVM must
        // agree — this is the same boundary rule, reached from the other direction.
        assert!(compute_fee(amount, USDC_DECIMALS, pct, 0, 0).is_err());

        // One atom up, both charge exactly one atom.
        assert_eq!(compute_fee(2, USDC_DECIMALS, pct, 0, 0).unwrap(), 1);
        assert_eq!(evm_determine_fee(2, pct as u128, 0, 0, 6).unwrap(), 1);
    }
}
