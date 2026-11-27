use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};
use spl_discriminator::SplDiscriminate;
use spl_tlv_account_resolution::{account::ExtraAccountMeta, state::ExtraAccountMetaList};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

declare_id!("HekWAieNQ7T8xa1Wtq3tn3T8a7obiWusq6kXmWHLBmR1");

#[program]
pub mod mock_transfer_hook {
    use super::*;

    /// Execute the transfer hook. Token-2022 calls it with the transfer hook interface's Execute
    /// discriminator, so it is bound to that instead of Anchor's, and the `Execute` accounts require
    /// the validation PDA. A caller that drops the hook's extra accounts therefore fails here.
    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn execute(_ctx: Context<Execute>, amount: u64) -> Result<()> {
        msg!("Mock TransferHook: execute called with amount: {}", amount);

        // This is a mock implementation - just log and succeed
        // In a real transfer hook, you could implement custom logic here:
        // - Fee collection
        // - Transfer restrictions
        // - Compliance checks
        // - etc.

        Ok(())
    }

    /// Initialize extra account metas for the transfer hook
    /// This defines which additional accounts the transfer hook needs
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        msg!("Mock TransferHook: initialize_extra_account_meta_list called");

        // Calculate the space needed for an empty ExtraAccountMetaList
        // For this mock, we don't need any extra accounts beyond the standard ones
        let account_size =
            ExtraAccountMetaList::size_of(0).map_err(|_| ProgramError::InvalidAccountData)?;

        // Calculate rent
        let lamports = Rent::get()?.minimum_balance(account_size);

        // Derive PDA seeds
        let mint_key = ctx.accounts.mint.key();
        let seeds: &[&[u8]] = &[b"extra-account-metas", mint_key.as_ref()];
        let (pda, bump) = Pubkey::find_program_address(seeds, ctx.program_id);

        // Verify the derived PDA matches the provided account
        require_keys_eq!(
            pda,
            ctx.accounts.extra_account_meta_list.key(),
            ErrorCode::InvalidExtraAccountMetaListPDA
        );

        // Create the account using invoke_signed since extra_account_meta_list is a PDA
        let signer_seeds: &[&[&[u8]]] = &[&[b"extra-account-metas", mint_key.as_ref(), &[bump]]];
        invoke_signed(
            &system_instruction::create_account(
                ctx.accounts.payer.key,
                ctx.accounts.extra_account_meta_list.key,
                lamports,
                account_size as u64,
                ctx.program_id,
            ),
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.extra_account_meta_list.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer_seeds,
        )?;

        // Initialize the ExtraAccountMetaList with no extra accounts
        let account_info = ctx.accounts.extra_account_meta_list.to_account_info();
        let mut data = account_info.try_borrow_mut_data()?;
        let extra_account_metas: Vec<ExtraAccountMeta> = vec![];
        ExtraAccountMetaList::init::<spl_transfer_hook_interface::instruction::ExecuteInstruction>(
            &mut data,
            &extra_account_metas,
        )
        .map_err(|_| ProgramError::InvalidAccountData)?;

        msg!("ExtraAccountMetaList initialized successfully with 0 extra accounts");

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: The source token account (validated by Token-2022 program)
    pub source: UncheckedAccount<'info>,

    /// CHECK: The mint account (validated by Token-2022 program)
    pub mint: UncheckedAccount<'info>,

    /// CHECK: The destination token account (validated by Token-2022 program)
    pub destination: UncheckedAccount<'info>,

    /// CHECK: The owner of the source token account (validated by Token-2022 program)
    pub owner: UncheckedAccount<'info>,

    /// CHECK: The validation PDA Token-2022 forwards only when the caller passed it.
    #[account(seeds = [b"extra-account-metas", mint.key().as_ref()], bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    /// CHECK: The extra account meta list account to initialize
    #[account(mut)]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// CHECK: The mint account
    pub mint: UncheckedAccount<'info>,

    /// The payer for account initialization
    #[account(mut)]
    pub payer: Signer<'info>,

    /// System program
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid ExtraAccountMetaList PDA")]
    InvalidExtraAccountMetaListPDA,
}
