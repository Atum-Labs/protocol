use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use std::str::FromStr;

use crate::errors::ErrorCode;
use crate::events::{
    DefaultAdminDelayUpdated, DefaultAdminTransferBegun, DefaultAdminTransferred, Paused,
    PauserUpdated, ProtocolInitialized, TokenConfigAuthorityUpdated, TreasurerUpdated, Unpaused,
};
use crate::state::ProtocolConfig;

// ============================================================================
// Initialize Protocol
// ============================================================================

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init_if_needed,
        payer = authority,
        space = ProtocolConfig::SIZE,
        seeds = [ProtocolConfig::SEED],
        bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// The escrow program executable account
    /// CHECK: Validated via constraint
    #[account(
        executable,
        address = crate::ID
    )]
    pub program: AccountInfo<'info>,

    /// The program metadata account. For loader-v3 this is ProgramData PDA; for
    /// loader-v4 this is the executable program account itself.
    /// CHECK: Validated in `verify_upgrade_authority`.
    pub program_data: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_protocol(
    ctx: Context<InitializeProtocol>,
    default_admin: Pubkey,
    token_config_authority: Pubkey,
    treasurer: Pubkey,
    pauser: Pubkey,
    cluster_id: [u8; 32],
    default_admin_delay_seconds: u32,
) -> Result<()> {
    // Check if already initialized (non-default admin means already set up)
    let config = &ctx.accounts.protocol_config;
    if config.default_admin != Pubkey::default() {
        return Err(ErrorCode::AlreadyInitialized.into());
    }

    verify_upgrade_authority(
        &ctx.accounts.program,
        &ctx.accounts.program_data,
        ctx.accounts.authority.key(),
    )?;

    // Initialize config
    let config = &mut ctx.accounts.protocol_config;
    config.default_admin = default_admin;
    config.token_config_authority = token_config_authority;
    config.treasurer = treasurer;
    config.pauser = pauser;
    config.paused = false;
    config.cluster_id = cluster_id;
    config.signature_domain_version = ProtocolConfig::CURRENT_SIGNATURE_DOMAIN_VERSION;
    config.default_admin_delay_seconds = default_admin_delay_seconds;
    config.pending_default_admin = None;
    config.pending_default_admin_accept_after_ts = None;

    emit!(ProtocolInitialized {
        default_admin,
        token_config_authority,
        treasurer,
        pauser,
        cluster_id,
        signature_domain_version: config.signature_domain_version,
        default_admin_delay_seconds,
    });

    Ok(())
}

fn verify_upgrade_authority(
    program: &AccountInfo,
    program_data: &AccountInfo,
    authority: Pubkey,
) -> Result<()> {
    let loader_v4_program_id = Pubkey::from_str("LoaderV411111111111111111111111111111111111")
        .map_err(|_| ErrorCode::Unauthorized)?;

    if program.owner == &bpf_loader_upgradeable::ID {
        let (expected_program_data, _) =
            Pubkey::find_program_address(&[program.key().as_ref()], &bpf_loader_upgradeable::ID);
        require!(
            program_data.key() == expected_program_data
                && program_data.owner == &bpf_loader_upgradeable::ID,
            ErrorCode::Unauthorized
        );

        let data = program_data.data.borrow();
        if data.len() < 45 {
            return Err(ErrorCode::Unauthorized.into());
        }

        let tag = u32::from_le_bytes(data[0..4].try_into().map_err(|_| ErrorCode::Unauthorized)?);
        if tag != 3 || data[12] != 1 {
            return Err(ErrorCode::Unauthorized.into());
        }

        let key_bytes: [u8; 32] = data[13..45]
            .try_into()
            .map_err(|_| ErrorCode::Unauthorized)?;
        let upgrade_authority = Pubkey::new_from_array(key_bytes);
        drop(data);

        require!(authority == upgrade_authority, ErrorCode::Unauthorized);
        return Ok(());
    }

    if program.owner == &loader_v4_program_id {
        require!(
            program_data.key() == program.key() && program_data.owner == &loader_v4_program_id,
            ErrorCode::Unauthorized
        );

        // Loader-v4 state layout:
        // slot (0..8), authority (8..40), status enum u64 (40..48).
        let data = program_data.data.borrow();
        if data.len() < 48 {
            return Err(ErrorCode::Unauthorized.into());
        }

        let status = u64::from_le_bytes(
            data[40..48]
                .try_into()
                .map_err(|_| ErrorCode::Unauthorized)?,
        );
        if status == 2 {
            // Finalized programs no longer carry an authority signer.
            return Err(ErrorCode::Unauthorized.into());
        }

        let key_bytes: [u8; 32] = data[8..40]
            .try_into()
            .map_err(|_| ErrorCode::Unauthorized)?;
        let upgrade_authority = Pubkey::new_from_array(key_bytes);
        drop(data);

        require!(authority == upgrade_authority, ErrorCode::Unauthorized);
        return Ok(());
    }

    Err(ErrorCode::Unauthorized.into())
}

// ============================================================================
// Pause Control
// ============================================================================

#[derive(Accounts)]
pub struct PauseControl<'info> {
    pub pauser: Signer<'info>,

    #[account(
        mut,
        seeds = [ProtocolConfig::SEED],
        bump,
        constraint = protocol_config.pauser == pauser.key() @ ErrorCode::Unauthorized
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
}

pub fn pause(ctx: Context<PauseControl>) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    config.paused = true;

    emit!(Paused {
        by: ctx.accounts.pauser.key(),
    });

    Ok(())
}

pub fn unpause(ctx: Context<PauseControl>) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    config.paused = false;

    emit!(Unpaused {
        by: ctx.accounts.pauser.key(),
    });

    Ok(())
}

/// Shared context for all role key updates - only default_admin can update
#[derive(Accounts)]
pub struct SetRoleKey<'info> {
    pub default_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [ProtocolConfig::SEED],
        bump,
        constraint = protocol_config.default_admin == default_admin.key()
            @ ErrorCode::Unauthorized
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
}

pub fn set_token_config_authority(ctx: Context<SetRoleKey>, new_authority: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    let old_authority = config.token_config_authority;
    config.token_config_authority = new_authority;

    emit!(TokenConfigAuthorityUpdated {
        old_authority,
        new_authority,
    });

    Ok(())
}

pub fn set_treasurer(ctx: Context<SetRoleKey>, new_treasurer: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    let old_treasurer = config.treasurer;
    config.treasurer = new_treasurer;

    emit!(TreasurerUpdated {
        old_treasurer,
        new_treasurer,
    });

    Ok(())
}

pub fn set_pauser(ctx: Context<SetRoleKey>, new_pauser: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    let old_pauser = config.pauser;
    config.pauser = new_pauser;

    emit!(PauserUpdated {
        old_pauser,
        new_pauser,
    });

    Ok(())
}

// ============================================================================
// Begin Default Admin Transfer
// ============================================================================

#[derive(Accounts)]
pub struct BeginDefaultAdminTransfer<'info> {
    pub default_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [ProtocolConfig::SEED],
        bump,
        constraint = protocol_config.default_admin == default_admin.key()
            @ ErrorCode::Unauthorized
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
}

pub fn begin_default_admin_transfer(
    ctx: Context<BeginDefaultAdminTransfer>,
    new_admin: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    let clock = Clock::get()?;

    let accept_after_ts = clock
        .unix_timestamp
        .checked_add(config.default_admin_delay_seconds as i64)
        .ok_or(ErrorCode::TimestampOverflow)?;

    config.pending_default_admin = Some(new_admin);
    config.pending_default_admin_accept_after_ts = Some(accept_after_ts);

    emit!(DefaultAdminTransferBegun {
        current_admin: config.default_admin,
        pending_admin: new_admin,
        accept_after_ts,
    });

    Ok(())
}

// ============================================================================
// Accept Default Admin Transfer
// ============================================================================

#[derive(Accounts)]
pub struct AcceptDefaultAdminTransfer<'info> {
    pub pending_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [ProtocolConfig::SEED],
        bump,
        constraint = protocol_config.pending_default_admin == Some(pending_admin.key())
            @ ErrorCode::Unauthorized
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
}

pub fn accept_default_admin_transfer(ctx: Context<AcceptDefaultAdminTransfer>) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    let clock = Clock::get()?;

    let accept_after = config
        .pending_default_admin_accept_after_ts
        .ok_or(ErrorCode::Unauthorized)?;

    require!(
        clock.unix_timestamp >= accept_after,
        ErrorCode::AdminTransferNotReady
    );

    let old_admin = config.default_admin;
    let new_admin = ctx.accounts.pending_admin.key();

    config.default_admin = new_admin;
    config.pending_default_admin = None;
    config.pending_default_admin_accept_after_ts = None;

    emit!(DefaultAdminTransferred {
        old_admin,
        new_admin,
    });

    Ok(())
}

// ============================================================================
// Set Default Admin Delay
// ============================================================================

#[derive(Accounts)]
pub struct SetDefaultAdminDelay<'info> {
    pub default_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [ProtocolConfig::SEED],
        bump,
        constraint = protocol_config.default_admin == default_admin.key()
            @ ErrorCode::Unauthorized
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
}

pub fn set_default_admin_delay_seconds(
    ctx: Context<SetDefaultAdminDelay>,
    new_delay_seconds: u32,
) -> Result<()> {
    let old_delay_seconds = ctx.accounts.protocol_config.default_admin_delay_seconds;
    ctx.accounts.protocol_config.default_admin_delay_seconds = new_delay_seconds;

    emit!(DefaultAdminDelayUpdated {
        old_delay_seconds,
        new_delay_seconds,
    });

    Ok(())
}
