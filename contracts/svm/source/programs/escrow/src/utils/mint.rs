use anchor_lang::prelude::*;
use spl_token_2022::extension::confidential_transfer::ConfidentialTransferAccount;
use spl_token_2022::extension::permanent_delegate::PermanentDelegate;
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

/// What the escrow can hold: a mint whose extensions are all accepted and whose fee can never
/// charge. Returns the mint's live permanent delegate, `None` when the mint has no PermanentDelegate
/// extension or its issuer cleared the delegate.
pub fn check_escrowable_mint(mint: &AccountInfo) -> Result<Option<Pubkey>> {
    check_escrowable_mint_data(&mint.try_borrow_data()?, Clock::get()?.epoch)
}

fn check_escrowable_mint_data(data: &[u8], epoch: u64) -> Result<Option<Pubkey>> {
    // One parse serves every check, and each extension read rescans the short TLV list. This runs
    // on every deposit, and a hooked deposit has almost no compute headroom. Fail closed: a mint or
    // extension list this crate cannot read is never treated as safe.
    let state = StateWithExtensions::<Mint2022>::unpack(data)?;
    let types = state.get_extension_types()?;
    for ext in &types {
        check_mint_extension(*ext)?;
    }
    check_fee_in_force(&state, &types, epoch)?;
    if !types.contains(&ExtensionType::PermanentDelegate) {
        return Ok(None);
    }
    // An entry that is not exactly one key fails here, so an unreadable delegate is never `None`.
    let delegate = state.get_extension::<PermanentDelegate>()?.delegate;
    Ok(Option::<Pubkey>::from(delegate))
}

/// Deposit rule: refuses a live permanent delegate other than the pinned key. A cleared delegate
/// passes, since Token-2022 cannot set one again, so no key holds the power.
pub fn check_pinned_delegate(live: Option<Pubkey>, pinned: &Pubkey) -> Result<()> {
    if let Some(live) = live {
        require_keys_eq!(live, *pinned, ErrorCode::PermanentDelegateChanged);
    }
    Ok(())
}

/// Pin rule: the live delegate, as stored (`Pubkey::default()` for none or cleared), only when it
/// is exactly the key the caller reviewed. Stricter than the deposit rule, so a pin always records
/// what is live.
pub fn check_expected_delegate(live: Option<Pubkey>, expected: Pubkey) -> Result<Pubkey> {
    let live = live.unwrap_or_default();
    require_keys_eq!(live, expected, ErrorCode::PermanentDelegateChanged);
    Ok(live)
}

/// Deny by default. No wildcard arm, so a crate bump that adds a type does not build until it is
/// reviewed here.
fn check_mint_extension(ext: ExtensionType) -> Result<()> {
    use ExtensionType::*;
    match ext {
        // Accepted issuer powers, with the risk of each recorded in docs/architecture/security.md.
        // A TransferFeeConfig passes here and is then checked by `check_fee_in_force`. A
        // PermanentDelegate is pinned by key at `allow_mint` and compared on every deposit.
        TransferFeeConfig | TransferHook | Pausable | MintCloseAuthority | DefaultAccountState
        | ConfidentialTransferMint | ConfidentialTransferFeeConfig | MetadataPointer
        | TokenMetadata | PermanentDelegate => Ok(()),
        Uninitialized | NonTransferable | InterestBearingConfig | GroupPointer | TokenGroup
        | GroupMemberPointer | TokenGroupMember | ConfidentialMintBurn | ScaledUiAmount
        // Account extensions, which Token-2022 never writes on a mint.
        | TransferFeeAmount | ConfidentialTransferAccount | ImmutableOwner | MemoTransfer
        | CpiGuard | NonTransferableAccount | TransferHookAccount
        | ConfidentialTransferFeeAmount | PausableAccount => {
            err!(ErrorCode::MintExtensionNotAllowed)
        }
    }
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

    fn is_extension_rejection<T: std::fmt::Debug>(result: Result<T>) -> bool {
        result.unwrap_err() == ErrorCode::MintExtensionNotAllowed.into()
    }

    // The policy, restated so a change to `check_mint_extension` has to change a test too.
    const ACCEPTED: [ExtensionType; 10] = [
        ExtensionType::TransferFeeConfig,
        ExtensionType::TransferHook,
        ExtensionType::Pausable,
        ExtensionType::MintCloseAuthority,
        ExtensionType::DefaultAccountState,
        ExtensionType::ConfidentialTransferMint,
        ExtensionType::ConfidentialTransferFeeConfig,
        ExtensionType::MetadataPointer,
        ExtensionType::TokenMetadata,
        ExtensionType::PermanentDelegate,
    ];

    // A mint listing `extensions` in order. The extension walk reads only type and length, so every
    // entry is empty except TransferFeeConfig, which the fee check reads and gets the given fee, and
    // PermanentDelegate, which is read and gets a cleared (all zero) delegate.
    fn mint_listing(extensions: &[ExtensionType], transfer_fee: TransferFee) -> Vec<u8> {
        let mut data = legacy_mint();
        data.resize(Mint2022::LEN.max(165), 0);
        data.push(AccountType::Mint as u8);
        for ext in extensions {
            if *ext == ExtensionType::TransferFeeConfig {
                data.extend_from_slice(&fee_mint(transfer_fee, transfer_fee)[166..]);
            } else if *ext == ExtensionType::PermanentDelegate {
                data.extend_from_slice(&u16::from(*ext).to_le_bytes());
                data.extend_from_slice(&32u16.to_le_bytes());
                data.extend_from_slice(&[0u8; 32]);
            } else {
                data.extend_from_slice(&u16::from(*ext).to_le_bytes());
                data.extend_from_slice(&0u16.to_le_bytes());
            }
        }
        data
    }

    // Byte offset of the first TLV entry of type `ext` in a mint account.
    fn tlv_offset(data: &[u8], ext: ExtensionType) -> usize {
        let mut at = 166;
        loop {
            let ty = u16::from_le_bytes([data[at], data[at + 1]]);
            if ty == u16::from(ext) {
                return at;
            }
            at += 4 + u16::from_le_bytes([data[at + 2], data[at + 3]]) as usize;
        }
    }

    #[test]
    fn refuses_every_extension_outside_the_accepted_set() {
        let mut refused = 0;
        for n in 1..=u16::MAX {
            let Ok(ext) = ExtensionType::try_from(n) else {
                continue;
            };
            if ACCEPTED.contains(&ext) {
                continue;
            }
            let data = mint_listing(&[ext], fee(0, 0));
            assert!(
                is_extension_rejection(check_escrowable_mint_data(&data, LATE)),
                "{ext:?}"
            );
            refused += 1;
        }
        // 27 known types past Uninitialized, less the 10 accepted.
        assert_eq!(refused, 17);
    }

    #[test]
    fn accepts_every_accepted_extension_together() {
        let data = mint_listing(&ACCEPTED, fee(0, 0));
        assert_eq!(check_escrowable_mint_data(&data, LATE).unwrap(), None);
        let charging = mint_listing(&ACCEPTED, fee(100, 1_000_000));
        assert!(is_fee_rejection(check_escrowable_mint_data(
            &charging, LATE
        )));
        // The extension walk runs before the fee check.
        let refused_and_charging = mint_listing(
            &[
                ExtensionType::TransferFeeConfig,
                ExtensionType::NonTransferable,
            ],
            fee(100, 1_000_000),
        );
        assert!(is_extension_rejection(check_escrowable_mint_data(
            &refused_and_charging,
            LATE
        )));
    }

    #[test]
    fn refuses_a_refused_extension_next_to_a_permanent_delegate() {
        let data = mint_listing(
            &[
                ExtensionType::MintCloseAuthority,
                ExtensionType::PermanentDelegate,
                ExtensionType::Pausable,
                ExtensionType::NonTransferable,
            ],
            fee(0, 0),
        );
        assert!(is_extension_rejection(check_escrowable_mint_data(
            &data, LATE
        )));
    }

    #[test]
    fn refuses_unknown_and_truncated_extension_lists() {
        let unknown = fee_mint_behind_unknown_extension(fee(0, 0));
        assert_eq!(
            check_escrowable_mint_data(&unknown, LATE).unwrap_err(),
            ProgramError::InvalidAccountData.into()
        );
        let mut truncated = mint_listing(&[ExtensionType::MetadataPointer], fee(0, 0));
        truncated[168..170].copy_from_slice(&8u16.to_le_bytes());
        assert_eq!(
            check_escrowable_mint_data(&truncated, LATE).unwrap_err(),
            ProgramError::InvalidAccountData.into()
        );
    }

    #[test]
    fn mainnet_stablecoin_mints_are_accepted_with_their_permanent_delegate() {
        // Delegates read from Solana mainnet on 2026-11-25, matching these fixtures.
        for (name, data, delegate) in [
            (
                "PYUSD",
                &include_bytes!("fixtures/pyusd.bin")[..],
                "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk",
            ),
            (
                "USDG",
                &include_bytes!("fixtures/usdg.bin")[..],
                "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk",
            ),
            (
                "AUSD",
                &include_bytes!("fixtures/ausd.bin")[..],
                "6HAFLav8Qn2QfeSRVPLwtmPKHMm8f93uWSQMp2n1MyoU",
            ),
            (
                "GBPA",
                &include_bytes!("fixtures/gbpa.bin")[..],
                "AkRcEoab3ECQ4GoDgVb9jE9wVMVeSksR3TwGCmdNEtB8",
            ),
            // DefaultAccountState and Pausable, and no TransferFeeConfig.
            (
                "OUSD",
                &include_bytes!("fixtures/ousd.bin")[..],
                "Aj2gxCSQ7A7eTnUL2VnyT3KQa79AcZi5x15rPRSnw6RA",
            ),
        ] {
            let expected: Pubkey = delegate.parse().unwrap();
            assert_eq!(
                check_escrowable_mint_data(data, LATE).unwrap(),
                Some(expected),
                "{name}"
            );
        }
        for (name, data) in [
            ("USDC", &include_bytes!("fixtures/usdc.bin")[..]),
            ("USDT", &include_bytes!("fixtures/usdt.bin")[..]),
        ] {
            assert_eq!(
                check_escrowable_mint_data(data, LATE).unwrap(),
                None,
                "{name}"
            );
        }
    }

    #[test]
    fn returns_the_permanent_delegate_of_a_mint() {
        let delegate = Pubkey::new_unique();
        let data = mint_with(&[ExtensionType::PermanentDelegate], Some(delegate));
        assert_eq!(
            check_escrowable_mint_data(&data, LATE).unwrap(),
            Some(delegate)
        );
    }

    #[test]
    fn returns_the_permanent_delegate_on_a_mint_whose_fees_compute_to_zero() {
        // The shape of PYUSD and USDG: a zero-fee TransferFeeConfig next to a PermanentDelegate.
        let delegate = Pubkey::new_unique();
        let data = mint_with(
            &[
                ExtensionType::TransferFeeConfig,
                ExtensionType::PermanentDelegate,
            ],
            Some(delegate),
        );
        assert_eq!(
            check_escrowable_mint_data(&data, LATE).unwrap(),
            Some(delegate)
        );
    }

    #[test]
    fn a_cleared_permanent_delegate_reads_as_none() {
        let data = mint_with(&[ExtensionType::PermanentDelegate], None);
        assert_eq!(check_escrowable_mint_data(&data, LATE).unwrap(), None);
    }

    #[test]
    fn the_fee_check_still_refuses_a_permanent_delegate_mint() {
        let mut data = mint_listing(
            &[
                ExtensionType::TransferFeeConfig,
                ExtensionType::PermanentDelegate,
            ],
            fee(100, 1_000_000),
        );
        assert!(is_fee_rejection(check_escrowable_mint_data(&data, LATE)));
        // An unreadable delegate next to a charging fee reports the fee, which is checked first.
        let at = tlv_offset(&data, ExtensionType::PermanentDelegate);
        data[at + 2..at + 4].copy_from_slice(&31u16.to_le_bytes());
        data.truncate(at + 4 + 31);
        assert!(is_fee_rejection(check_escrowable_mint_data(&data, LATE)));
    }

    #[test]
    fn refuses_an_unreadable_permanent_delegate() {
        // A listed delegate entry that is not exactly one key must never read as "no delegate".
        for len in [0u16, 31, 33] {
            let mut data = legacy_mint();
            data.resize(Mint2022::LEN.max(165), 0);
            data.push(AccountType::Mint as u8);
            data.extend_from_slice(&u16::from(ExtensionType::PermanentDelegate).to_le_bytes());
            data.extend_from_slice(&len.to_le_bytes());
            data.extend(std::iter::repeat_n(7u8, len as usize));
            // Token-2022 refuses the wrong length when it reads the delegate, never earlier.
            assert_eq!(
                check_escrowable_mint_data(&data, LATE).unwrap_err(),
                ProgramError::InvalidArgument.into(),
                "{len}"
            );
        }
    }

    #[test]
    fn pinned_delegate_check() {
        let pinned = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        let none = Pubkey::default();
        for (live, stored, ok) in [
            // The pinned key, including after a rotation away and back.
            (Some(pinned), pinned, true),
            // Cleared: no key holds the power, whatever was pinned.
            (None, pinned, true),
            (None, none, true),
            // Rotated to a key nobody reviewed.
            (Some(other), pinned, false),
            // A delegate on a mint pinned without one, e.g. closed and re-created at the address.
            (Some(other), none, false),
        ] {
            let result = check_pinned_delegate(live, &stored);
            if ok {
                assert!(result.is_ok(), "{live:?} {stored}");
            } else {
                assert_eq!(
                    result.unwrap_err(),
                    ErrorCode::PermanentDelegateChanged.into(),
                    "{live:?} {stored}"
                );
            }
        }
    }

    #[test]
    fn expected_delegate_check() {
        let key = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        let none = Pubkey::default();
        assert_eq!(check_expected_delegate(Some(key), key).unwrap(), key);
        assert_eq!(check_expected_delegate(None, none).unwrap(), none);
        for (live, expected) in [(Some(key), other), (Some(key), none), (None, key)] {
            assert_eq!(
                check_expected_delegate(live, expected).unwrap_err(),
                ErrorCode::PermanentDelegateChanged.into(),
                "{live:?} {expected}"
            );
        }
    }

    #[test]
    fn still_allows_mints_without_a_permanent_delegate() {
        assert_eq!(
            check_escrowable_mint_data(&legacy_mint(), LATE).unwrap(),
            None
        );
        assert_eq!(
            check_escrowable_mint_data(&fee_mint(fee(0, 0), fee(0, 0)), LATE).unwrap(),
            None
        );
    }

    #[test]
    fn refuses_a_mint_that_does_not_parse() {
        assert!(check_escrowable_mint_data(&[], LATE).is_err());
    }

    fn is_fee_rejection<T: std::fmt::Debug>(result: Result<T>) -> bool {
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
