use anchor_lang::prelude::*;

use crate::errors::ErrorCode;

/// transfer_checked through Token-2022's hook aware helper. It resolves a transfer hook's extra
/// accounts from `remaining_accounts` and forwards them, where anchor-spl's transfer_checked passes
/// only the four base accounts and the hook never sees them. Classic SPL mints and mints without a
/// hook program need no remaining accounts.
#[allow(clippy::too_many_arguments)]
pub fn transfer_checked<'a>(
    token_program: AccountInfo<'a>,
    from: AccountInfo<'a>,
    mint: AccountInfo<'a>,
    to: AccountInfo<'a>,
    authority: AccountInfo<'a>,
    remaining_accounts: &[AccountInfo<'a>],
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    require_no_hook_signer(remaining_accounts, authority.key)?;
    spl_token_2022::onchain::invoke_transfer_checked(
        token_program.key,
        from,
        mint,
        to,
        authority,
        remaining_accounts,
        amount,
        decimals,
        signer_seeds,
    )
    .map_err(Into::into)
}

/// Refuses a signer in `remaining_accounts` other than the transfer authority. Token-2022 hands a hook
/// every account its extra-account list names with the list's flags, and strips the signer flag only
/// from the source, mint, destination and authority. A hook naming the fee payer would otherwise get
/// the payer's signature, since a transaction marks its fee payer a signer whatever the client sets.
fn require_no_hook_signer(remaining_accounts: &[AccountInfo], authority: &Pubkey) -> Result<()> {
    require!(
        remaining_accounts
            .iter()
            .all(|account| !account.is_signer || account.key == authority),
        ErrorCode::HookAccountSignerNotAllowed
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(accounts: &[(Pubkey, bool)], authority: &Pubkey) -> Result<()> {
        let owner = Pubkey::new_unique();
        let mut lamports: Vec<u64> = vec![0; accounts.len()];
        let mut data: Vec<Vec<u8>> = vec![vec![]; accounts.len()];
        let infos: Vec<AccountInfo> = accounts
            .iter()
            .zip(lamports.iter_mut())
            .zip(data.iter_mut())
            .map(|(((key, is_signer), lamports), data)| {
                AccountInfo::new(key, *is_signer, true, lamports, data, &owner, false, 0)
            })
            .collect();
        require_no_hook_signer(&infos, authority)
    }

    #[test]
    fn accepts_hook_accounts_that_do_not_sign() {
        let authority = Pubkey::new_unique();
        assert!(check(&[], &authority).is_ok());
        assert!(check(
            &[(Pubkey::new_unique(), false), (Pubkey::new_unique(), false)],
            &authority
        )
        .is_ok());
    }

    #[test]
    fn accepts_the_signing_authority_named_by_the_hook() {
        let authority = Pubkey::new_unique();
        assert!(check(
            &[(Pubkey::new_unique(), false), (authority, true)],
            &authority
        )
        .is_ok());
    }

    #[test]
    fn refuses_any_other_signer_wherever_it_sits() {
        let authority = Pubkey::new_unique();
        let payer = Pubkey::new_unique();
        for accounts in [
            vec![(payer, true)],
            vec![(Pubkey::new_unique(), false), (payer, true)],
            vec![(authority, true), (payer, true)],
        ] {
            assert_eq!(
                check(&accounts, &authority).unwrap_err(),
                ErrorCode::HookAccountSignerNotAllowed.into()
            );
        }
    }
}
