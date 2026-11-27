// SPDX-License-Identifier: MIT
use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use std::str::FromStr;

use crate::errors::ErrorCode;
use crate::events::{
    AuthorizedSettlerAdded, AuthorizedSettlerRemoved, DefaultAdminDelayUpdated,
    DefaultAdminTransferBegun, DefaultAdminTransferred, Paused, PauserUpdated, ProtocolInitialized,
    SettlerAllowlistEnforcementSet, Unpaused,
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

    /// The fulfillment proxy program executable account.
    /// CHECK: Validated via constraint.
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
    pauser: Pubkey,
    default_admin_delay_seconds: u32,
) -> Result<()> {
    // Check if already initialized (non-default admin means already set up).
    let config = &ctx.accounts.protocol_config;
    if config.default_admin != Pubkey::default() {
        return Err(ErrorCode::AlreadyInitialized.into());
    }

    verify_upgrade_authority(
        &ctx.accounts.program,
        &ctx.accounts.program_data,
        ctx.accounts.authority.key(),
    )?;

    // Initialize config.
    let config = &mut ctx.accounts.protocol_config;
    config.default_admin = default_admin;
    config.pauser = pauser;
    config.paused = false;
    config.default_admin_delay_seconds = default_admin_delay_seconds;
    config.pending_default_admin = None;
    config.pending_default_admin_accept_after_ts = None;
    // CORE-2116: settler allowlist ships dormant + empty; the admin provisions + enables it later.
    config.enforce_settler_allowlist = false;
    config.authorized_settlers = Vec::new();

    emit!(ProtocolInitialized {
        default_admin,
        pauser,
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

// ============================================================================
// Role Key Updates
// ============================================================================

/// Shared context for all role key updates - only default_admin can update.
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
// Settler allowlist (CORE-2116)
// ============================================================================

/// Toggle whether strict_fulfill enforces the settler allowlist. Ships dormant (false); the admin
/// flips it on after the allowlist is provisioned, and can flip it back off for an instant rollback.
pub fn set_enforce_settler_allowlist(ctx: Context<SetRoleKey>, enforced: bool) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    config.enforce_settler_allowlist = enforced;

    emit!(SettlerAllowlistEnforcementSet { enforced });

    Ok(())
}

/// Add a settler to the strict_fulfill allowlist (idempotent; bounded by MAX_AUTHORIZED_SETTLERS).
pub fn add_authorized_settler(ctx: Context<SetRoleKey>, settler: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    if config.authorized_settlers.contains(&settler) {
        return Ok(());
    }
    require!(
        config.authorized_settlers.len() < ProtocolConfig::MAX_AUTHORIZED_SETTLERS,
        ErrorCode::AuthorizedSettlerListFull
    );
    config.authorized_settlers.push(settler);

    emit!(AuthorizedSettlerAdded { settler });

    Ok(())
}

/// Remove a settler from the strict_fulfill allowlist (idempotent). Mirrors add_authorized_settler:
/// AuthorizedSettlerRemoved is emitted ONLY when a settler was actually removed, so an off-chain
/// indexer tracking the authoritative set never sees a phantom removal for a no-op call (parity with
/// EVM/Tron OZ RoleRevoked, which emits only on a real state change).
pub fn remove_authorized_settler(ctx: Context<SetRoleKey>, settler: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    let len_before = config.authorized_settlers.len();
    config.authorized_settlers.retain(|s| s != &settler);
    if config.authorized_settlers.len() != len_before {
        emit!(AuthorizedSettlerRemoved { settler });
    }

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
        new_admin
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
