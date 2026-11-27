use anchor_lang::prelude::*;

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
