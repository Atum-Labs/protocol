use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;
pub mod utils;

use instructions::*;

declare_id!("44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs");

#[program]
pub mod escrow {
    use super::*;

    // Delegate instructions
    pub fn create_delegate(
        ctx: Context<CreateDelegate>,
        delegate_signer: Pubkey,
        remaining_capacity: u64,
        max_transfer_size: u64,
        expiration: u64,
    ) -> Result<()> {
        instructions::delegate::create_delegate(
            ctx,
            delegate_signer,
            remaining_capacity,
            max_transfer_size,
            expiration,
        )
    }

    pub fn revoke_delegate(ctx: Context<RevokeDelegate>) -> Result<()> {
        instructions::delegate::revoke_delegate(ctx)
    }

    pub fn renounce_delegate(ctx: Context<RenounceDelegate>) -> Result<()> {
        instructions::delegate::renounce_delegate(ctx)
    }

    // Escrow instructions
    #[allow(clippy::too_many_arguments)]
    pub fn deposit<'a>(
        ctx: Context<'_, '_, 'a, 'a, Deposit<'a>>,
        deposit_request_hash: [u8; 32],
        destination_hash: [u8; 32],
        amount: u64,
        reserver: Pubkey,
        releaser: Pubkey,
        nonce: u64,
        issued_at: u64,
        deadline: u64,
        deposit_hash: [u8; 32],
    ) -> Result<()> {
        instructions::escrow::deposit(
            ctx,
            deposit_request_hash,
            destination_hash,
            amount,
            reserver,
            releaser,
            nonce,
            issued_at,
            deadline,
            deposit_hash,
        )
    }

    pub fn reserve(
        ctx: Context<Reserve>,
        recipient: Pubkey,
        quote_hash: [u8; 32],
        source_amount: u64,
    ) -> Result<()> {
        instructions::escrow::reserve(ctx, recipient, quote_hash, source_amount)
    }

    pub fn release<'a>(ctx: Context<'_, '_, 'a, 'a, Release<'a>>) -> Result<()> {
        instructions::escrow::release(ctx)
    }

    pub fn refund<'a>(ctx: Context<'_, '_, 'a, 'a, Refund<'a>>) -> Result<()> {
        instructions::escrow::refund(ctx)
    }

    // Protocol administration instructions
    #[allow(clippy::too_many_arguments)]
    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        default_admin: Pubkey,
        token_config_authority: Pubkey,
        treasurer: Pubkey,
        pauser: Pubkey,
        cluster_id: [u8; 32],
        default_admin_delay_seconds: u32,
    ) -> Result<()> {
        instructions::protocol::initialize_protocol(
            ctx,
            default_admin,
            token_config_authority,
            treasurer,
            pauser,
            cluster_id,
            default_admin_delay_seconds,
        )
    }

    pub fn pause(ctx: Context<PauseControl>) -> Result<()> {
        instructions::protocol::pause(ctx)
    }

    pub fn unpause(ctx: Context<PauseControl>) -> Result<()> {
        instructions::protocol::unpause(ctx)
    }

    pub fn set_token_config_authority(
        ctx: Context<SetRoleKey>,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::protocol::set_token_config_authority(ctx, new_authority)
    }

    pub fn set_treasurer(ctx: Context<SetRoleKey>, new_treasurer: Pubkey) -> Result<()> {
        instructions::protocol::set_treasurer(ctx, new_treasurer)
    }

    pub fn set_pauser(ctx: Context<SetRoleKey>, new_pauser: Pubkey) -> Result<()> {
        instructions::protocol::set_pauser(ctx, new_pauser)
    }

    pub fn begin_default_admin_transfer(
        ctx: Context<BeginDefaultAdminTransfer>,
        new_admin: Pubkey,
    ) -> Result<()> {
        instructions::protocol::begin_default_admin_transfer(ctx, new_admin)
    }

    pub fn accept_default_admin_transfer(ctx: Context<AcceptDefaultAdminTransfer>) -> Result<()> {
        instructions::protocol::accept_default_admin_transfer(ctx)
    }

    pub fn set_default_admin_delay_seconds(
        ctx: Context<SetDefaultAdminDelay>,
        new_delay_seconds: u32,
    ) -> Result<()> {
        instructions::protocol::set_default_admin_delay_seconds(ctx, new_delay_seconds)
    }

    // Mint configuration instructions
    pub fn allow_mint(ctx: Context<AllowMint>, expected_permanent_delegate: Pubkey) -> Result<()> {
        instructions::mint_config::allow_mint(ctx, expected_permanent_delegate)
    }

    pub fn disallow_mint(ctx: Context<DisallowMint>) -> Result<()> {
        instructions::mint_config::disallow_mint(ctx)
    }

    pub fn set_mint_fee_config(
        ctx: Context<SetMintFeeConfig>,
        fee_percentage_6: u64,
        min_fee_6: u64,
        max_fee_6: u64,
    ) -> Result<()> {
        instructions::mint_config::set_mint_fee_config(ctx, fee_percentage_6, min_fee_6, max_fee_6)
    }

    pub fn clear_mint_fee_config(ctx: Context<ClearMintFeeConfig>) -> Result<()> {
        instructions::mint_config::clear_mint_fee_config(ctx)
    }

    pub fn pin_mint_permanent_delegate(
        ctx: Context<SetMintFeeConfig>,
        expected_permanent_delegate: Pubkey,
    ) -> Result<()> {
        instructions::mint_config::pin_mint_permanent_delegate(ctx, expected_permanent_delegate)
    }
}
