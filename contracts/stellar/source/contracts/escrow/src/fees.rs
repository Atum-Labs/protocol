use crate::errors::Error;
use crate::types::TokenConfig;

pub const FEE_PERCENTAGE_SCALE: u128 = 100_000_000; // 100% = 100_000_000
pub const FEE_6_SCALE: u128 = 1_000_000; // 6-decimal normalisation

/// EVM allows 30 because its arithmetic is uint256. Here the widest intermediate is u128:
/// `max_fee_6 (u64) * 10^decimals` must stay below 3.4e38, so 18 decimals is the ceiling
/// (1.8e19 * 1e18 = 1.8e37). Stellar tokens use 7.
pub const MAX_TOKEN_DECIMALS: u32 = 18;

/// `Escrow.determineFee` (EVM, `EscrowReserveLib.fee`), same steps in the same order: ceiling
/// percentage, scaled min floor, scaled max cap, then `fee >= amount` rejects.
///
/// Differences that are about the integer width, not the algorithm: amounts are i128 (SEP-41), and
/// the `amount * pct` product is a checked u128, so an amount above ~3.4e30 atoms returns
/// `FeeArithmeticFailed` where EVM's uint256 would keep going. No real token supply is near that.
/// A zero amount returns 0 as on EVM (Solana rejects it).
pub fn determine_fee(amount: i128, config: &TokenConfig) -> Result<i128, Error> {
    if amount < 0 {
        return Err(Error::InvalidAmount);
    }
    if amount == 0 {
        return Ok(0);
    }
    let amount_u = amount as u128;
    let mut fee: u128 = 0;

    // ceil(a * b / c) = (a * b + c - 1) / c; rounds in the protocol's favour
    if config.fee_percentage_6 > 0 {
        fee = amount_u
            .checked_mul(config.fee_percentage_6 as u128)
            .and_then(|p| p.checked_add(FEE_PERCENTAGE_SCALE - 1))
            .ok_or(Error::FeeArithmeticFailed)?
            / FEE_PERCENTAGE_SCALE;
    }

    if config.min_fee_6 > 0 {
        let min_fee = scale_fee_6(config.min_fee_6, config.token_decimals)?;
        if fee < min_fee {
            fee = min_fee;
        }
    }
    if config.max_fee_6 > 0 {
        let max_fee = scale_fee_6(config.max_fee_6, config.token_decimals)?;
        if fee > max_fee {
            fee = max_fee;
        }
    }

    if fee >= amount_u {
        return Err(Error::FeeExceedsDepositAmount);
    }
    // fee < amount <= i128::MAX
    Ok(fee as i128)
}

/// floor(fee_6 * 10^decimals / 1_000_000): a 6-decimal fee bound in the token's atoms.
pub fn scale_fee_6(fee_6: u64, decimals: u32) -> Result<u128, Error> {
    let factor = 10u128
        .checked_pow(decimals)
        .ok_or(Error::FeeArithmeticFailed)?;
    Ok((fee_6 as u128)
        .checked_mul(factor)
        .ok_or(Error::FeeArithmeticFailed)?
        / FEE_6_SCALE)
}

/// `Escrow._setTokenFeeConfig` validation, in EVM's order.
pub fn validate_fee_config(
    fee_percentage_6: u32,
    min_fee_6: u64,
    max_fee_6: u64,
    decimals: u32,
) -> Result<(), Error> {
    if fee_percentage_6 as u128 > FEE_PERCENTAGE_SCALE {
        return Err(Error::FeePercentageExceedsMaximum);
    }
    if min_fee_6 > 0 && max_fee_6 > 0 && min_fee_6 > max_fee_6 {
        return Err(Error::MinFeeCannotBeGreaterThanMaxFee);
    }
    if max_fee_6 > 0 && fee_percentage_6 == 0 {
        return Err(Error::FeePercentageCannotBeZeroWhenMaxFeeIsSet);
    }
    // A bound that truncates to zero atoms would silently mean "no bound" at low decimals.
    if min_fee_6 > 0 && scale_fee_6(min_fee_6, decimals)? == 0 {
        return Err(Error::MinFeeNotRepresentable);
    }
    if max_fee_6 > 0 && scale_fee_6(max_fee_6, decimals)? == 0 {
        return Err(Error::MaxFeeNotRepresentable);
    }
    Ok(())
}
