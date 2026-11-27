// SPDX-License-Identifier: MIT
use anchor_lang::prelude::*;
use spl_token_2022::extension::confidential_transfer::ConfidentialTransferAccount;
use spl_token_2022::extension::transfer_fee::{TransferFee, TransferFeeConfig};
use spl_token_2022::extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions};
use spl_token_2022::state::{Account as Account2022, Mint as Mint2022};

use crate::errors::ErrorCode;

/// Rejects a mint whose TransferFeeConfig charges, or has scheduled, a nonzero fee. Escrow accounting
/// assumes transfers move exact amounts, so no slot that is or will be in force may charge.
pub fn check_zero_transfer_fee(mint: &AccountInfo) -> Result<()> {
    check_zero_transfer_fee_data(&mint.try_borrow_data()?, Clock::get()?.epoch)
}

fn check_zero_transfer_fee_data(data: &[u8], epoch: u64) -> Result<()> {
    // Fail closed: a mint or extension list this crate cannot read is never treated as fee-free.
    let state = StateWithExtensions::<Mint2022>::unpack(data)?;
    let types = state.get_extension_types()?;
    check_fee_in_force(&state, &types, epoch)
}

fn check_fee_in_force(
    state: &StateWithExtensions<Mint2022>,
    types: &[ExtensionType],
    epoch: u64,
) -> Result<()> {
    if types.contains(&ExtensionType::TransferFeeConfig) {
        let cfg = state.get_extension::<TransferFeeConfig>()?;
        // Token-2022 charges older only while epoch < newer.epoch, and newer from then on.
        let older_in_force = epoch < u64::from(cfg.newer_transfer_fee.epoch);
        let charges = can_charge(&cfg.newer_transfer_fee)
            || (older_in_force && can_charge(&cfg.older_transfer_fee));
        require!(!charges, ErrorCode::TransferFeeMintNotAllowed);
    }
    Ok(())
}

// Token-2022 charges min(amount * bps, maximum_fee), so a slot with either at zero charges nothing.
fn can_charge(fee: &TransferFee) -> bool {
    u16::from(fee.transfer_fee_basis_points) != 0 && u64::from(fee.maximum_fee) != 0
}

/// What the escrow can hold: a mint whose issuer has no permanent delegate over the escrow's token
/// account, and whose fee can never charge.
pub fn check_escrowable_mint(mint: &AccountInfo) -> Result<()> {
    check_escrowable_mint_data(&mint.try_borrow_data()?, Clock::get()?.epoch)
}

fn check_escrowable_mint_data(data: &[u8], epoch: u64) -> Result<()> {
    // One parse and one walk of the extension list serve both checks. This runs on every deposit,
    // and a hooked deposit has almost no compute headroom, so it must cost what the fee check alone
    // did. Fail closed: a mint or extension list this crate cannot read is never treated as safe.
    let state = StateWithExtensions::<Mint2022>::unpack(data)?;
    let types = state.get_extension_types()?;
    // A permanent delegate can transfer or burn from every token account of the mint, the escrow's
    // included, and `DepositInfo.amount` never moves with it: `release` then fails on an underfunded
    // account and `refund` pays back only what is left. Refused by the extension's presence, not by
    // who the delegate is, because the extension is the issuer's standing power over the account.
    require!(
        !types.contains(&ExtensionType::PermanentDelegate),
        ErrorCode::PermanentDelegateMintNotAllowed
    );
    check_fee_in_force(&state, &types, epoch)
}
/// Whether a plain transfer_checked into this token account can succeed once a memo precedes it.
/// The depositor controls these states on their own account, so release must not depend on them.
pub fn accepts_plain_credit(token_account: &AccountInfo) -> Result<bool> {
    accepts_plain_credit_data(&token_account.try_borrow_data()?)
}

fn accepts_plain_credit_data(data: &[u8]) -> Result<bool> {
    let state = StateWithExtensions::<Account2022>::unpack(data)?;
    if state.base.is_frozen() {
        return Ok(false);
    }
    // An extension list this crate cannot read counts as refusing, so the payout never depends on it.
    let Ok(types) = state.get_extension_types() else {
        return Ok(false);
    };
    if types.contains(&ExtensionType::ConfidentialTransferAccount) {
        let Ok(ct) = state.get_extension::<ConfidentialTransferAccount>() else {
            return Ok(false);
        };
        return Ok(bool::from(ct.allow_non_confidential_credits));
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::program_pack::Pack;
    use spl_token_2022::extension::memo_transfer::MemoTransfer;
    use spl_token_2022::extension::permanent_delegate::PermanentDelegate;
    use spl_token_2022::extension::{
        AccountType, BaseStateWithExtensionsMut, Extension, StateWithExtensionsMut,
    };
    use spl_token_2022::state::AccountState;

    // An epoch far past any test schedule, where only the newer slot can be in force.
    const LATE: u64 = 1_000;

    fn base_mint() -> Mint2022 {
        Mint2022 {
            decimals: 6,
            is_initialized: true,
            ..Default::default()
        }
    }

    fn legacy_mint() -> Vec<u8> {
        let mut data = vec![0u8; Mint2022::LEN];
        Mint2022::pack(base_mint(), &mut data).unwrap();
        data
    }

    fn fee_at(bps: u16, max: u64, epoch: u64) -> TransferFee {
        TransferFee {
            epoch: epoch.into(),
            maximum_fee: max.into(),
            transfer_fee_basis_points: bps.into(),
        }
    }

    fn fee(bps: u16, max: u64) -> TransferFee {
        fee_at(bps, max, 0)
    }

    fn fee_mint(older: TransferFee, newer: TransferFee) -> Vec<u8> {
        let len = ExtensionType::try_calculate_account_len::<Mint2022>(&[
            ExtensionType::TransferFeeConfig,
        ])
        .unwrap();
        let mut data = vec![0u8; len];
        let mut state =
            StateWithExtensionsMut::<Mint2022>::unpack_uninitialized(&mut data).unwrap();
        let cfg = state.init_extension::<TransferFeeConfig>(true).unwrap();
        cfg.older_transfer_fee = older;
        cfg.newer_transfer_fee = newer;
        state.base = base_mint();
        state.pack_base();
        state.init_account_type().unwrap();
        data
    }

    // A TLV entry whose type number this crate does not know, placed before TransferFeeConfig.
    fn fee_mint_behind_unknown_extension(transfer_fee: TransferFee) -> Vec<u8> {
        let mut data = legacy_mint();
        data.resize(Mint2022::LEN.max(165), 0);
        data.push(AccountType::Mint as u8);
        data.extend_from_slice(&u16::MAX.to_le_bytes());
        data.extend_from_slice(&0u16.to_le_bytes());
        let cfg = fee_mint(transfer_fee, transfer_fee);
        data.extend_from_slice(&cfg[166..]);
        data
    }

    // A mint carrying the given extensions, each initialised: a zero-fee TransferFeeConfig where
    // listed, and a PermanentDelegate pointing at `delegate` where listed.
    fn mint_with(extensions: &[ExtensionType], delegate: Option<Pubkey>) -> Vec<u8> {
        let len = ExtensionType::try_calculate_account_len::<Mint2022>(extensions).unwrap();
        let mut data = vec![0u8; len];
        let mut state =
            StateWithExtensionsMut::<Mint2022>::unpack_uninitialized(&mut data).unwrap();
        for ext in extensions {
            match ext {
                ExtensionType::TransferFeeConfig => {
                    state.init_extension::<TransferFeeConfig>(true).unwrap();
                }
                ExtensionType::PermanentDelegate => {
                    let cfg = state.init_extension::<PermanentDelegate>(true).unwrap();
                    cfg.delegate = delegate.try_into().unwrap();
                }
                other => panic!("test helper does not build {other:?}"),
            }
        }
        state.base = base_mint();
        state.pack_base();
        state.init_account_type().unwrap();
        data
    }

    fn is_delegate_rejection(result: Result<()>) -> bool {
        result.unwrap_err() == ErrorCode::PermanentDelegateMintNotAllowed.into()
    }

    #[test]
    fn refuses_a_mint_with_a_permanent_delegate() {
        let data = mint_with(
            &[ExtensionType::PermanentDelegate],
            Some(Pubkey::new_unique()),
        );
        assert!(is_delegate_rejection(check_escrowable_mint_data(
            &data, LATE
        )));
    }

    #[test]
    fn refuses_a_permanent_delegate_on_a_mint_whose_fees_compute_to_zero() {
        // The shape of PYUSD and USDG: a zero-fee TransferFeeConfig next to a PermanentDelegate.
        let data = mint_with(
            &[
                ExtensionType::TransferFeeConfig,
                ExtensionType::PermanentDelegate,
            ],
            Some(Pubkey::new_unique()),
        );
        assert!(check_zero_transfer_fee_data(&data, LATE).is_ok());
        assert!(is_delegate_rejection(check_escrowable_mint_data(
            &data, LATE
        )));
    }

    #[test]
    fn refuses_a_permanent_delegate_extension_with_no_delegate_set() {
        // Presence is what is refused: the extension is the issuer's standing power over the account.
        let data = mint_with(&[ExtensionType::PermanentDelegate], None);
        assert!(is_delegate_rejection(check_escrowable_mint_data(
            &data, LATE
        )));
    }

    #[test]
    fn still_allows_mints_without_a_permanent_delegate() {
        assert!(check_escrowable_mint_data(&legacy_mint(), LATE).is_ok());
        assert!(check_escrowable_mint_data(&fee_mint(fee(0, 0), fee(0, 0)), LATE).is_ok());
    }

    #[test]
    fn refuses_a_mint_that_does_not_parse_when_checking_for_a_permanent_delegate() {
        assert!(check_escrowable_mint_data(&[], LATE).is_err());
    }

    fn is_fee_rejection(result: Result<()>) -> bool {
        result.unwrap_err() == ErrorCode::TransferFeeMintNotAllowed.into()
    }

    #[test]
    fn allows_legacy_mint_without_extensions() {
        assert!(check_zero_transfer_fee_data(&legacy_mint(), LATE).is_ok());
    }

    #[test]
    fn allows_zero_fee_in_both_slots() {
        assert!(check_zero_transfer_fee_data(&fee_mint(fee(0, 0), fee(0, 0)), LATE).is_ok());
    }

    #[test]
    fn rejects_chargeable_newer_slot_at_any_epoch() {
        // Covers a fee already in force and one scheduled for a later epoch.
        for newer in [fee_at(100, 1_000_000, 5), fee_at(1, 1, 5)] {
            for epoch in [0, 5, LATE] {
                let data = fee_mint(fee(0, 0), newer);
                assert!(is_fee_rejection(check_zero_transfer_fee_data(&data, epoch)));
            }
        }
    }

    #[test]
    fn rejects_chargeable_older_slot_only_while_in_force() {
        let data = fee_mint(fee_at(100, 1_000_000, 0), fee_at(0, 0, 5));
        for epoch in [0, 4] {
            assert!(is_fee_rejection(check_zero_transfer_fee_data(&data, epoch)));
        }
        // From newer.epoch on, Token-2022 charges the zero newer slot, so the stale older fee is dead.
        for epoch in [5, LATE] {
            assert!(check_zero_transfer_fee_data(&data, epoch).is_ok());
        }
    }

    #[test]
    fn allows_fee_that_computes_to_zero() {
        // AUSD on mainnet has 0 bps with a nonzero maximum_fee in both slots.
        for (older, newer) in [
            (fee(0, 1_000_000), fee(0, 1_000_000)),
            (fee(100, 0), fee(100, 0)),
            (fee(0, 1), fee(1, 0)),
        ] {
            for epoch in [0, LATE] {
                assert!(check_zero_transfer_fee_data(&fee_mint(older, newer), epoch).is_ok());
            }
        }
    }

    #[test]
    fn allows_mainnet_stablecoin_mints() {
        // Real mainnet bytes, so the multi-extension layouts of the target mints reach the parser.
        for (name, data) in [
            ("PYUSD", &include_bytes!("fixtures/pyusd.bin")[..]),
            ("USDG", &include_bytes!("fixtures/usdg.bin")[..]),
            ("AUSD", &include_bytes!("fixtures/ausd.bin")[..]),
            ("GBPA", &include_bytes!("fixtures/gbpa.bin")[..]),
            ("USDC", &include_bytes!("fixtures/usdc.bin")[..]),
            ("USDT", &include_bytes!("fixtures/usdt.bin")[..]),
        ] {
            for epoch in [0, LATE] {
                assert!(check_zero_transfer_fee_data(data, epoch).is_ok(), "{name}");
            }
        }
    }

    #[test]
    fn rejects_mint_that_does_not_parse() {
        assert!(check_zero_transfer_fee_data(&[], LATE).is_err());
        let mut uninitialized = legacy_mint();
        uninitialized[45] = 0;
        assert!(check_zero_transfer_fee_data(&uninitialized, LATE).is_err());
    }

    #[test]
    fn rejects_unreadable_transfer_fee_config() {
        // Shorten the TransferFeeConfig entry so it is still listed but cannot be read.
        let mut data = fee_mint(fee(0, 0), fee(0, 0));
        let short_len: u16 = 100;
        data[168..170].copy_from_slice(&short_len.to_le_bytes());
        data.truncate(170 + short_len as usize);
        let state = StateWithExtensions::<Mint2022>::unpack(&data).unwrap();
        assert!(state
            .get_extension_types()
            .unwrap()
            .contains(&ExtensionType::TransferFeeConfig));
        assert!(check_zero_transfer_fee_data(&data, LATE).is_err());
    }

    #[test]
    fn rejects_unreadable_extension_list() {
        for transfer_fee in [fee(100, 1_000_000), fee(0, 0)] {
            let data = fee_mint_behind_unknown_extension(transfer_fee);
            // The base mint parses and a plain fee lookup misses the config, so only the type list catches it.
            let state = StateWithExtensions::<Mint2022>::unpack(&data).unwrap();
            assert!(state.get_extension::<TransferFeeConfig>().is_err());
            assert_eq!(
                check_zero_transfer_fee_data(&data, LATE).unwrap_err(),
                ProgramError::InvalidAccountData.into()
            );
        }
    }

    // A Token-2022 account carrying one account extension, set up by `init`.
    macro_rules! token_account {
        ($ext:ty, $frozen:expr, $init:expr) => {{
            let len =
                ExtensionType::try_calculate_account_len::<Account2022>(&[<$ext>::TYPE]).unwrap();
            let mut data = vec![0u8; len];
            let mut state =
                StateWithExtensionsMut::<Account2022>::unpack_uninitialized(&mut data).unwrap();
            let init: fn(&mut $ext) = $init;
            init(state.init_extension::<$ext>(true).unwrap());
            state.base = Account2022 {
                state: if $frozen {
                    AccountState::Frozen
                } else {
                    AccountState::Initialized
                },
                ..Default::default()
            };
            state.pack_base();
            state.init_account_type().unwrap();
            data
        }};
    }

    fn plain_account(state: AccountState) -> Vec<u8> {
        let mut data = vec![0u8; Account2022::LEN];
        Account2022::pack(
            Account2022 {
                state,
                ..Default::default()
            },
            &mut data,
        )
        .unwrap();
        data
    }

    #[test]
    fn accepts_plain_credit_on_open_accounts() {
        assert!(accepts_plain_credit_data(&plain_account(AccountState::Initialized)).unwrap());
        // A memo requirement is met by the memo the escrow sends before each depositor credit.
        let memo = token_account!(MemoTransfer, false, |m| {
            m.require_incoming_transfer_memos = true.into()
        });
        assert!(accepts_plain_credit_data(&memo).unwrap());
        let ct_open = token_account!(ConfidentialTransferAccount, false, |ct| {
            ct.allow_non_confidential_credits = true.into()
        });
        assert!(accepts_plain_credit_data(&ct_open).unwrap());
    }

    #[test]
    fn accepts_plain_credit_on_mainnet_token_accounts() {
        // Real holder accounts, which carry ImmutableOwner or PausableAccount plus TransferFeeAmount and
        // TransferHookAccount. A false here would silently send every surplus to the treasury.
        for (name, data) in [
            ("PYUSD", &include_bytes!("fixtures/pyusd_account.bin")[..]),
            ("USDG", &include_bytes!("fixtures/usdg_account.bin")[..]),
            ("AUSD", &include_bytes!("fixtures/ausd_account.bin")[..]),
            ("GBPA", &include_bytes!("fixtures/gbpa_account.bin")[..]),
        ] {
            assert!(accepts_plain_credit_data(data).unwrap(), "{name}");
        }
    }

    #[test]
    fn refuses_plain_credit_on_blocked_accounts() {
        assert!(!accepts_plain_credit_data(&plain_account(AccountState::Frozen)).unwrap());
        let frozen_ext = token_account!(MemoTransfer, true, |m| {
            m.require_incoming_transfer_memos = true.into()
        });
        assert!(!accepts_plain_credit_data(&frozen_ext).unwrap());
        let ct_closed = token_account!(ConfidentialTransferAccount, false, |ct| {
            ct.allow_non_confidential_credits = false.into()
        });
        assert!(!accepts_plain_credit_data(&ct_closed).unwrap());
    }
}
