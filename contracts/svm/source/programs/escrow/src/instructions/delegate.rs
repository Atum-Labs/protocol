use crate::errors::ErrorCode;
use crate::events::{DelegateRenounced, DelegateRevoked};
use crate::state::{EscrowDelegate, MintFeeConfig, ProtocolConfig};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{self as token, ApproveChecked, Mint, TokenAccount, TokenInterface},
};

#[derive(Accounts)]
pub struct CreateDelegate<'info> {
    /// Protocol configuration - required for pause check
    #[account(
        seeds = [ProtocolConfig::SEED],
        bump,
        constraint = !protocol_config.paused @ ErrorCode::ProtocolPaused
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    pub authority: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// Mint fee configuration - must exist for allowlist
    /// CHECK: Seeds, owner, and non-empty data ensure the allowlist entry exists
    #[account(
        seeds = [MintFeeConfig::SEED, mint.key().as_ref()],
        bump,
        constraint = mint_fee_config.owner == &crate::ID @ ErrorCode::MintNotAllowed,
        constraint = !mint_fee_config.data_is_empty() @ ErrorCode::MintNotAllowed
    )]
    pub mint_fee_config: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = EscrowDelegate::LEN,
        seeds = [b"escrow_delegate", authority.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub escrow_delegate: Account<'info, EscrowDelegate>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = authority,
        associated_token::token_program = token_program,
    )]
    pub authority_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeDelegate<'info> {
    /// Protocol configuration - required for pause check
    #[account(
        seeds = [ProtocolConfig::SEED],
        bump,
        constraint = !protocol_config.paused @ ErrorCode::ProtocolPaused
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(
        mut,
        close = payer,
        seeds = [
            b"escrow_delegate",
            escrow_delegate.authority.as_ref(),
            escrow_delegate.allowed_mint.as_ref(),
        ],
        bump
    )]
    pub escrow_delegate: Account<'info, EscrowDelegate>,
    #[account(address = escrow_delegate.authority)]
    pub authority: Signer<'info>,
    /// The authority's token account where delegation was approved
    #[account(
        mut,
        associated_token::mint = escrow_delegate.allowed_mint,
        associated_token::authority = authority,
        associated_token::token_program = token_program,
    )]
    pub authority_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RenounceDelegate<'info> {
    /// Protocol configuration - required for pause check
    #[account(
        seeds = [ProtocolConfig::SEED],
        bump,
        constraint = !protocol_config.paused @ ErrorCode::ProtocolPaused
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(
        mut,
        seeds = [
            b"escrow_delegate",
            escrow_delegate.authority.as_ref(),
            escrow_delegate.allowed_mint.as_ref(),
        ],
        bump
    )]
    pub escrow_delegate: Account<'info, EscrowDelegate>,
    pub delegate_signer: Signer<'info>,
}

// Handlers

pub fn create_delegate(
    ctx: Context<CreateDelegate>,
    delegate_signer: Pubkey,
    remaining_capacity: u64,
    max_transfer_size: u64,
    expiration: u64,
) -> Result<()> {
    // Basic input validation
    require!(remaining_capacity > 0, ErrorCode::DelegateLimitsInvalid);
    require!(max_transfer_size > 0, ErrorCode::DelegateLimitsInvalid);
    require!(
        max_transfer_size <= remaining_capacity,
        ErrorCode::DelegateLimitsInvalid
    );
    require!(
        delegate_signer != Pubkey::default(),
        ErrorCode::InvalidPublicKey
    );

    // Only check expiration after basic validation succeeds
    let now = Clock::get()?.unix_timestamp as u64;
    require!(expiration > now, ErrorCode::Expired);

    let delegate = &mut ctx.accounts.escrow_delegate;
    delegate.authority = ctx.accounts.authority.key();
    delegate.delegate_signer = delegate_signer;
    delegate.max_transfer_size = max_transfer_size;
    delegate.remaining_capacity = remaining_capacity;
    delegate.expiration = expiration;
    delegate.allowed_mint = ctx.accounts.mint.key();

    // Delegate SPL tokens to Delegation PDA
    let decimals = ctx.accounts.mint.decimals;
    token::approve_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            ApproveChecked {
                to: ctx.accounts.authority_ata.to_account_info(),
                delegate: ctx.accounts.escrow_delegate.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
            },
        ),
        remaining_capacity,
        decimals,
    )?;

    Ok(())
}

pub fn revoke_delegate(ctx: Context<RevokeDelegate>) -> Result<()> {
    let delegate = &ctx.accounts.escrow_delegate;

    // ATA validation is now enforced via account constraints

    // Revoke SPL token delegation from the authority's ATA
    token::revoke(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        token::Revoke {
            source: ctx.accounts.authority_ata.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        },
    ))?;

    emit!(DelegateRevoked {
        authority: delegate.authority,
        delegate: delegate.key(),
        delegate_signer: delegate.delegate_signer
    });

    Ok(())
}

pub fn renounce_delegate(ctx: Context<RenounceDelegate>) -> Result<()> {
    let d = &mut ctx.accounts.escrow_delegate;
    require_keys_eq!(
        ctx.accounts.delegate_signer.key(),
        d.delegate_signer,
        ErrorCode::Unauthorized
    );
    d.remaining_capacity = 0;
    d.expiration = Clock::get()?.unix_timestamp as u64;

    emit!(DelegateRenounced {
        authority: d.authority,
        delegate: d.key(),
        delegate_signer: d.delegate_signer
    });
    Ok(())
}
