// SPDX-License-Identifier: MIT
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::errors::ErrorCode;
use crate::events::{Fulfilled, StrictFulfilled};
use crate::state::{ProtocolConfig, ReplayBucket, StrictFulfillment};
use crate::utils::{replay::check_replay, transfer};
use replay::derive_replay_bucket_selector;

// The recipient must be credited exactly `amount`, since the event reports it. A Token-2022 transfer
// fee would otherwise credit less while the event, and verification built on it, say full payment.
fn require_exact_credit(
    to_ata: &mut InterfaceAccount<TokenAccount>,
    balance_before: u64,
    amount: u64,
) -> Result<()> {
    to_ata.reload()?;
    let received = to_ata
        .amount
        .checked_sub(balance_before)
        .ok_or(ErrorCode::NonExactTransfer)?;
    require!(received == amount, ErrorCode::NonExactTransfer);
    Ok(())
}

pub fn fulfill<'a>(
    ctx: Context<'_, '_, 'a, 'a, Fulfill<'a>>,
    quote_hash: [u8; 32],
    amount: u64,
) -> Result<()> {
    require!(amount > 0, ErrorCode::AmountCannotBeZero);

    let to_balance_before = ctx.accounts.to_ata.amount;
    transfer::transfer_checked(
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.from_ata.to_account_info(),
        ctx.accounts.mint.to_account_info(),
        ctx.accounts.to_ata.to_account_info(),
        ctx.accounts.settler.to_account_info(),
        ctx.remaining_accounts,
        amount,
        ctx.accounts.mint.decimals,
        &[],
    )?;
    require_exact_credit(&mut ctx.accounts.to_ata, to_balance_before, amount)?;

    emit!(Fulfilled {
        quote_hash,
        to: ctx.accounts.to.key(),
        token: ctx.accounts.mint.key(),
        amount,
    });

    Ok(())
}

pub fn strict_fulfill<'a>(
    ctx: Context<'_, '_, 'a, 'a, StrictFulfill<'a>>,
    quote_hash: [u8; 32],
    nonce: u64,
    issued_at: u64,
    amount: u64,
    deadline: u64,
) -> Result<()> {
    // CORE-2116: settler-allowlist enforcement is toggled — dormant on a fresh redeploy
    // (permissionless, as before), enforced once the admin flips it on. When enforced, the signing
    // settler must be on the allowlist. It is not what stops a stranger blocking a quote's marker:
    // that is the per-settler marker seeds below (CORE-2515), which hold with the allowlist off.
    // Evaluated BEFORE the amount/quote_hash guards so an unauthorized caller uniformly reverts with
    // UnauthorizedSettler regardless of the other args — matching EVM/Tron, which run the SETTLER_ROLE
    // check first (the pause guard already runs ahead of this via the account constraint).
    if ctx.accounts.protocol_config.enforce_settler_allowlist {
        require!(
            ctx.accounts
                .protocol_config
                .authorized_settlers
                .contains(&ctx.accounts.settler.key()),
            ErrorCode::UnauthorizedSettler
        );
    }

    require!(amount > 0, ErrorCode::AmountCannotBeZero);
    // CORE-2116: reject an empty quote hash so the zero-slot strict marker can't be consumed.
    require!(quote_hash != [0u8; 32], ErrorCode::QuoteHashCannotBeEmpty);

    // A quote strictly fulfilled before the settler joined the marker's seeds left its marker at
    // [strict_fulfilled, quote_hash]. Nothing creates an account there any more, so it is empty
    // unless the quote was paid under the old build, which makes it a set marker. This settler's own
    // marker is absent for such a quote even though it paid, so without this check it could pay the
    // quote a second time at a fresh nonce. Prefunding the address does not matter: only a program
    // owned account has data.
    require!(
        ctx.accounts.legacy_strict_fulfillment.data_is_empty(),
        ErrorCode::AlreadyFulfilled
    );

    // Idempotency per settler: one strict fulfillment per (quote_hash, settler), across any nonce.
    // The marker's seeds include the settler, so another account that strict-fulfills the same
    // public quote_hash sets only its own marker and cannot block this settler.
    require!(
        !ctx.accounts.strict_fulfillment.fulfilled,
        ErrorCode::AlreadyFulfilled
    );
    ctx.accounts.strict_fulfillment.fulfilled = true;

    let clock = Clock::get()?;
    let now = clock.unix_timestamp.max(0) as u64;

    check_replay(
        &mut ctx.accounts.replay_bucket,
        nonce,
        issued_at,
        deadline,
        now,
    )?;

    let to_balance_before = ctx.accounts.to_ata.amount;
    transfer::transfer_checked(
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.from_ata.to_account_info(),
        ctx.accounts.mint.to_account_info(),
        ctx.accounts.to_ata.to_account_info(),
        ctx.accounts.settler.to_account_info(),
        ctx.remaining_accounts,
        amount,
        ctx.accounts.mint.decimals,
        &[],
    )?;
    require_exact_credit(&mut ctx.accounts.to_ata, to_balance_before, amount)?;

    emit!(StrictFulfilled {
        quote_hash,
        to: ctx.accounts.to.key(),
        token: ctx.accounts.mint.key(),
        amount,
        nonce,
        issued_at,
        deadline,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct Fulfill<'info> {
    #[account(
        seeds = [ProtocolConfig::SEED],
        bump,
        constraint = !protocol_config.paused @ ErrorCode::ProtocolPaused
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub settler: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = settler,
        associated_token::token_program = token_program,
    )]
    pub from_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = to,
        associated_token::token_program = token_program,
    )]
    pub to_ata: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: The recipient account.
    pub to: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(quote_hash: [u8; 32], nonce: u64, issued_at: u64, amount: u64, deadline: u64)]
pub struct StrictFulfill<'info> {
    #[account(
        seeds = [ProtocolConfig::SEED],
        bump,
        constraint = !protocol_config.paused @ ErrorCode::ProtocolPaused
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub settler: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        space = ReplayBucket::LEN,
        seeds = [
            b"replay",
            settler.key().as_ref(),
            &derive_replay_bucket_selector(nonce),
        ],
        bump
    )]
    pub replay_bucket: Account<'info, ReplayBucket>,

    #[account(
        init_if_needed,
        payer = payer,
        space = StrictFulfillment::LEN,
        seeds = [b"strict_fulfilled", quote_hash.as_ref(), settler.key().as_ref()],
        bump
    )]
    pub strict_fulfillment: Account<'info, StrictFulfillment>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = settler,
        associated_token::token_program = token_program,
    )]
    pub from_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = to,
        associated_token::token_program = token_program,
    )]
    pub to_ata: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: The recipient account.
    pub to: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// CHECK: The strict-fulfillment marker address from before the settler joined the seeds,
    /// `[b"strict_fulfilled", quote_hash]`. Read-only and only its emptiness is checked; the seeds
    /// constraint pins the address. Drop it in a later upgrade once no old marker matters.
    #[account(seeds = [b"strict_fulfilled", quote_hash.as_ref()], bump)]
    pub legacy_strict_fulfillment: UncheckedAccount<'info>,
}
