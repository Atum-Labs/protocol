// SPDX-License-Identifier: MIT
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::errors::ErrorCode;
use crate::events::{MintAllowed, MintDisallowed, MintFeesCleared, MintFeesUpdated};
use crate::state::{MintFeeConfig, ProtocolConfig};
use crate::utils::fees::validate_mint_fee_config;
use crate::utils::mint::check_escrowable_mint;

#[derive(Accounts)]
pub struct AllowMint<'info> {
    #[account(mut)]
    pub token_config_authority: Signer<'info>,

    #[account(
        seeds = [ProtocolConfig::SEED],
        bump,
        constraint = protocol_config.token_config_authority == token_config_authority.key()
            @ ErrorCode::Unauthorized
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// The mint to allowlist
    pub mint_account: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = token_config_authority,
        space = MintFeeConfig::SIZE,
        seeds = [MintFeeConfig::SEED, mint_account.key().as_ref()],
        bump
    )]
    pub mint_fee_config: Account<'info, MintFeeConfig>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn allow_mint(ctx: Context<AllowMint>) -> Result<()> {
    check_escrowable_mint(&ctx.accounts.mint_account.to_account_info())?;

    let config = &mut ctx.accounts.mint_fee_config;
    config.mint = ctx.accounts.mint_account.key();
    config.fee_percentage_6 = 0;
    config.min_fee_6 = 0;
    config.max_fee_6 = 0;

    emit!(MintAllowed { mint: config.mint });

    Ok(())
}

#[derive(Accounts)]
pub struct DisallowMint<'info> {
    #[account(mut)]
    pub token_config_authority: Signer<'info>,

    #[account(
        seeds = [ProtocolConfig::SEED],
        bump,
        constraint = protocol_config.token_config_authority == token_config_authority.key()
            @ ErrorCode::Unauthorized
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        close = token_config_authority,
        seeds = [MintFeeConfig::SEED, mint_fee_config.mint.as_ref()],
        bump
    )]
    pub mint_fee_config: Account<'info, MintFeeConfig>,
}

pub fn disallow_mint(ctx: Context<DisallowMint>) -> Result<()> {
    emit!(MintDisallowed {
        mint: ctx.accounts.mint_fee_config.mint
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetMintFeeConfig<'info> {
    pub token_config_authority: Signer<'info>,

    #[account(
        seeds = [ProtocolConfig::SEED],
        bump,
        constraint = protocol_config.token_config_authority == token_config_authority.key()
            @ ErrorCode::Unauthorized
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// The mint (for Token-2022 validation)
    pub mint_account: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [MintFeeConfig::SEED, mint_fee_config.mint.as_ref()],
        bump,
        constraint = mint_fee_config.mint == mint_account.key() @ ErrorCode::InvalidMint
    )]
    pub mint_fee_config: Account<'info, MintFeeConfig>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn set_mint_fee_config(
    ctx: Context<SetMintFeeConfig>,
    fee_percentage_6: u64,
    min_fee_6: u64,
    max_fee_6: u64,
) -> Result<()> {
    // Defense in depth: the mint's transfer fee may have changed since allow_mint
    check_escrowable_mint(&ctx.accounts.mint_account.to_account_info())?;

    // Validate fee config using utility
    validate_mint_fee_config(
        fee_percentage_6,
        min_fee_6,
        max_fee_6,
        ctx.accounts.mint_account.decimals,
    )?;

    let config = &mut ctx.accounts.mint_fee_config;
    config.fee_percentage_6 = fee_percentage_6;
    config.min_fee_6 = min_fee_6;
    config.max_fee_6 = max_fee_6;

    emit!(MintFeesUpdated {
        mint: config.mint,
        fee_percentage_6,
        min_fee_6,
        max_fee_6,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ClearMintFeeConfig<'info> {
    pub token_config_authority: Signer<'info>,

    #[account(
        seeds = [ProtocolConfig::SEED],
        bump,
        constraint = protocol_config.token_config_authority == token_config_authority.key()
            @ ErrorCode::Unauthorized
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [MintFeeConfig::SEED, mint_fee_config.mint.as_ref()],
        bump
    )]
    pub mint_fee_config: Account<'info, MintFeeConfig>,
}

pub fn clear_mint_fee_config(ctx: Context<ClearMintFeeConfig>) -> Result<()> {
    let config = &mut ctx.accounts.mint_fee_config;
    let mint = config.mint;

    config.fee_percentage_6 = 0;
    config.min_fee_6 = 0;
    config.max_fee_6 = 0;

    emit!(MintFeesCleared { mint });

    Ok(())
}
