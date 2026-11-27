// SPDX-License-Identifier: MIT
use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions;
use anchor_lang::AccountDeserialize;
use anchor_spl::{
    associated_token::{self, get_associated_token_address_with_program_id, AssociatedToken},
    memo::{self, BuildMemo, Memo},
    token_interface::{self as token, CloseAccount, Mint, TokenAccount, TokenInterface},
};

use crate::constants::MAX_DESTINATION_LEN;
use crate::errors::ErrorCode;
use crate::events::{Deposited, Refunded, Released, Reserved};
use crate::state::{DepositInfo, EscrowDelegate, MintFeeConfig, ProtocolConfig, ReplayBucket};
use crate::utils::{
    fees::{compute_fee, rescale_reserved_fee},
    mint::{accepts_plain_credit, check_escrowable_mint},
    replay::check_replay,
    signatures::*,
    transfer,
};

#[derive(Accounts)]
#[instruction(
    deposit_request_hash: [u8; 32],
    // MUST stay in lockstep with the handler's parameter order. Anchor deserializes these positionally
    // to evaluate the seeds constraints, so a missing or misordered entry silently reads the wrong bytes
    // for every later argument. Omitting destination here made replay_bucket's nonce seed resolve from
    // the destination's bytes and failed 49 integration tests with ConstraintSeeds.
    destination: String,
    amount: u64,
    reserver: Pubkey,
    releaser: Pubkey,
    nonce: u64,
    issued_at: u64,
    deadline: u64,
    deposit_hash: [u8; 32]
)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [
            b"escrow_delegate",
            authority.key().as_ref(),
            escrow_delegate.allowed_mint.as_ref(),
        ],
        bump
    )]
    pub escrow_delegate: Account<'info, EscrowDelegate>,
    /// CHECK: Verified via delegation and constrained to match the delegate's authority
    #[account(address = escrow_delegate.authority)]
    pub authority: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = ReplayBucket::LEN,
        // Bucket uses the upper 4 bytes of the 8-byte LE nonce
        seeds = [b"replay", escrow_delegate.authority.as_ref(), &nonce.to_le_bytes()[4..]],
        bump
    )]
    pub replay_bucket: Account<'info, ReplayBucket>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = authority,
        associated_token::token_program = token_program,
    )]
    pub authority_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = payer,
        space = DepositInfo::LEN,
        // Use the deposit_hash as the unique seed for the deposit PDA
        seeds = [b"deposit", deposit_hash.as_ref()],
        bump
    )]
    // Boxed to keep `try_accounts` inside the 4 KiB SBF stack frame. CORE-2120 grew DepositInfo from
    // 249 to 313 bytes (deposit_request_hash + destination_hash), which pushed this frame 8 bytes over
    // the limit; the SBF linker reports that as possible undefined behaviour at runtime, not a warning to
    // carry. Boxing moves the deserialized account to the heap and costs one allocation.
    pub deposit: Box<Account<'info, DepositInfo>>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = deposit,
        associated_token::token_program = token_program,
    )]
    pub escrow_ata: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// Protocol configuration - required for pause check
    #[account(
        seeds = [ProtocolConfig::SEED],
        bump,
        constraint = !protocol_config.paused @ ErrorCode::ProtocolPaused
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    /// Mint fee configuration - must exist for allowlist
    /// CHECK: Validated manually in handler to return MintNotAllowed error
    #[account(
        seeds = [MintFeeConfig::SEED, mint.key().as_ref()],
        bump
    )]
    pub mint_fee_config: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: The instructions sysvar is required for ed25519 signature verification.
    #[account(address = instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Reserve<'info> {
    #[account(mut, seeds = [b"deposit", deposit.deposit_hash.as_ref()], bump)]
    pub deposit: Account<'info, DepositInfo>,
    /// Protocol configuration - required for pause check
    #[account(
        seeds = [ProtocolConfig::SEED],
        bump,
        constraint = !protocol_config.paused @ ErrorCode::ProtocolPaused
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    // No mint / mint_fee_config here: scaling the deposit-time fee needs neither the mint's
    // decimals nor the live fee schedule, so reserve keeps the account list it always had. An
    // earlier cut recomputed the fee from the live config and did need both — which also made the
    // fee config-sensitive between deposit and reserve, the very thing the snapshot guarantee
    // exists to prevent.
    /// CHECK: The instructions sysvar is required for ed25519 signature verification.
    #[account(address = instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    /// Protocol configuration - required for pause check
    #[account(
        seeds = [ProtocolConfig::SEED],
        bump,
        constraint = !protocol_config.paused @ ErrorCode::ProtocolPaused
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, seeds = [b"deposit", deposit.deposit_hash.as_ref()], bump, close = payer)]
    pub deposit: Box<Account<'info, DepositInfo>>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = deposit,
        associated_token::token_program = token_program,
    )]
    pub escrow_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The recipient from deposit.recipient
    /// CHECK: Validated to match deposit.recipient
    #[account(
        constraint = recipient.key() == deposit.recipient.ok_or(ErrorCode::RecipientNotSet)? @ ErrorCode::Unauthorized
    )]
    pub recipient: UncheckedAccount<'info>,
    /// Recipient's ATA - created if missing
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program,
    )]
    pub recipient_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The original depositor receiving any surplus tokens left in escrow.
    /// CHECK: Validated to match deposit.depositor
    #[account(address = deposit.depositor)]
    pub depositor: UncheckedAccount<'info>,
    /// Depositor ATA used to return surplus tokens. Checked by address in the handler and created if
    /// missing. Not typed as a token account: a classic SPL owner change by the depositor would
    /// otherwise fail account validation and block the release.
    /// CHECK: Address checked against the depositor's ATA in `prepare_depositor_ata`.
    #[account(mut)]
    pub depositor_ata: UncheckedAccount<'info>,
    /// The treasurer from protocol_config
    /// CHECK: Validated to match protocol_config.treasurer
    #[account(
        constraint = treasurer.key() == protocol_config.treasurer @ ErrorCode::Unauthorized
    )]
    pub treasurer: UncheckedAccount<'info>,
    /// Treasury ATA - created if missing (even for fee=0)
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = treasurer,
        associated_token::token_program = token_program,
    )]
    pub treasury_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(constraint = mint.key() == deposit.mint @ ErrorCode::InvalidMint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: The instructions sysvar is required for ed25519 signature verification.
    #[account(address = instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    /// Sends the memo a depositor ATA that requires incoming memos needs before each credit.
    pub memo_program: Program<'info, Memo>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    /// Protocol configuration - required for pause check
    #[account(
        seeds = [ProtocolConfig::SEED],
        bump,
        constraint = !protocol_config.paused @ ErrorCode::ProtocolPaused
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds = [b"deposit", deposit.deposit_hash.as_ref()], bump, close = payer)]
    pub deposit: Account<'info, DepositInfo>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = deposit,
        associated_token::token_program = token_program,
    )]
    pub escrow_ata: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: Depositor is validated via deposit.depositor constraint
    #[account(address = deposit.depositor)]
    pub depositor: UncheckedAccount<'info>,
    /// Depositor's ATA, created if missing to prevent stuck funds. Checked by address in the
    /// handler, for the same reason as in `Release`.
    /// CHECK: Address checked against the depositor's ATA in `prepare_depositor_ata`.
    #[account(mut)]
    pub depositor_ata: UncheckedAccount<'info>,
    #[account(constraint = mint.key() == deposit.mint @ ErrorCode::InvalidMint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: The instructions sysvar is required for ed25519 signature verification.
    #[account(address = instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    /// Sends the memo a depositor ATA that requires incoming memos needs before each credit.
    pub memo_program: Program<'info, Memo>,
}

// Checks `depositor_ata` is the depositor's ATA and creates it when missing. The address is the check,
// not the token owner, which a depositor can reassign on a classic SPL account.
#[allow(clippy::too_many_arguments)]
fn prepare_depositor_ata<'info>(
    depositor_ata: &UncheckedAccount<'info>,
    depositor: &UncheckedAccount<'info>,
    mint: &InterfaceAccount<'info, Mint>,
    payer: &Signer<'info>,
    token_program: &Interface<'info, TokenInterface>,
    associated_token_program: &Program<'info, AssociatedToken>,
    system_program: &Program<'info, System>,
) -> Result<()> {
    let expected =
        get_associated_token_address_with_program_id(depositor.key, &mint.key(), token_program.key);
    require_keys_eq!(
        depositor_ata.key(),
        expected,
        ErrorCode::InvalidDepositorAta
    );
    if depositor_ata.owner == &System::id() {
        associated_token::create(CpiContext::new(
            associated_token_program.to_account_info(),
            associated_token::Create {
                payer: payer.to_account_info(),
                associated_token: depositor_ata.to_account_info(),
                authority: depositor.to_account_info(),
                mint: mint.to_account_info(),
                system_program: system_program.to_account_info(),
                token_program: token_program.to_account_info(),
            },
        ))?;
    }
    // Only the ATA program can create an account at this address, and it assigns it to the token program.
    require_keys_eq!(
        *depositor_ata.owner,
        token_program.key(),
        ErrorCode::InvalidDepositorAta
    );
    Ok(())
}

// Token-2022 refuses a credit to an account that requires memos unless the previous sibling
// instruction is a memo, so this must run immediately before the transfer it covers.
fn memo_before_credit(memo_program: &Program<Memo>, memo: &[u8]) -> Result<()> {
    memo::build_memo(
        CpiContext::new(memo_program.to_account_info(), BuildMemo {}),
        memo,
    )
}

#[derive(Debug, PartialEq, Eq)]
struct ReleaseSettlement {
    gross_amount: u64,
    intended_amount: u64,
    fee_amount: u64,
    net_amount: u64,
    surplus_amount: u64,
}

fn compute_release_settlement(
    gross_amount: u64,
    intended_amount: u64,
    fee_amount: u64,
) -> Result<ReleaseSettlement> {
    require!(
        gross_amount >= intended_amount,
        ErrorCode::InsufficientEscrowBalance
    );

    let net_amount = intended_amount
        .checked_sub(fee_amount)
        .ok_or(ErrorCode::FeeExceedsAmount)?;
    let surplus_amount = gross_amount
        .checked_sub(intended_amount)
        .ok_or(ErrorCode::InsufficientEscrowBalance)?;

    Ok(ReleaseSettlement {
        gross_amount,
        intended_amount,
        fee_amount,
        net_amount,
        surplus_amount,
    })
}

// Handlers

#[allow(clippy::too_many_arguments)]
pub fn deposit<'a>(
    ctx: Context<'_, '_, 'a, 'a, Deposit<'a>>,
    deposit_request_hash: [u8; 32],
    destination: String,
    amount: u64,
    reserver: Pubkey,
    releaser: Pubkey,
    nonce: u64,
    issued_at: u64,
    deadline: u64,
    deposit_hash: [u8; 32],
) -> Result<()> {
    let delegate = &mut ctx.accounts.escrow_delegate;
    let now = Clock::get()?.unix_timestamp as u64;

    // 1. Simple Validations
    require!(amount > 0, ErrorCode::AmountMustBeGreaterThanZero);
    // CORE-2120 commitments. Validated on the DEPOSIT path only: the destination and request hash are
    // folded into deposit_hash, which every settlement instruction already checks against the stored
    // account, so a settlement-side re-check would be pure compute for no additional binding.
    require!(
        deposit_request_hash != [0u8; 32],
        ErrorCode::DepositRequestHashCannotBeEmpty
    );
    require!(!destination.is_empty(), ErrorCode::DestinationEmpty);
    require!(
        destination.len() <= MAX_DESTINATION_LEN,
        ErrorCode::DestinationTooLong
    );
    // Hash first: compute_deposit_hash takes fixed-width bytes, never the string. See its doc comment.
    let destination_hash = compute_destination_hash(&destination);
    require!(reserver != Pubkey::default(), ErrorCode::RoleAccountNotSet);
    require!(releaser != Pubkey::default(), ErrorCode::RoleAccountNotSet);
    require!(
        amount <= delegate.remaining_capacity,
        ErrorCode::CapacityExceeded
    );
    require!(
        amount <= delegate.max_transfer_size,
        ErrorCode::TransferSizeExceeded
    );

    // 2. Delegate Checks
    require!(now < delegate.expiration, ErrorCode::Expired);
    require_keys_eq!(
        ctx.accounts.mint.key(),
        delegate.allowed_mint,
        ErrorCode::InvalidMint
    );
    // Catches a fee scheduled for a later epoch, which NonExactTransfer below cannot see yet, and a
    // mint that carries a permanent delegate
    check_escrowable_mint(&ctx.accounts.mint.to_account_info())?;

    // 3. Replay Check (time window, deadline gating, and duplicate)
    check_replay(
        &mut ctx.accounts.replay_bucket,
        nonce,
        issued_at,
        deadline,
        now,
    )?;

    // 4. Signature Verification
    let message = compute_deposit_hash(
        &ctx.accounts.protocol_config,
        deposit_request_hash,
        destination_hash,
        delegate.authority,
        delegate.allowed_mint,
        amount,
        reserver,
        releaser,
        nonce,
        issued_at,
        deadline,
    );

    // Ensure the provided deposit_hash matches the computed one
    require!(deposit_hash == message, ErrorCode::DepositHashMismatch);
    verify_single_ed25519_instruction(
        &ctx.accounts.instructions,
        &delegate.delegate_signer,
        &message,
    )?;

    // 5. Fee Calculation - mint_fee_config must exist (allowlist check)
    // Manually deserialize to return MintNotAllowed when account doesn't exist
    let mint_fee_config_info = &ctx.accounts.mint_fee_config;
    require!(
        !mint_fee_config_info.data_is_empty(),
        ErrorCode::MintNotAllowed
    );
    let mint_fee_config_data = mint_fee_config_info.try_borrow_data()?;
    let mint_fee_config = MintFeeConfig::try_deserialize(&mut &mint_fee_config_data[..])
        .map_err(|_| ErrorCode::MintNotAllowed)?;
    let mint_decimals = ctx.accounts.mint.decimals;
    let fee_amount = compute_fee(
        amount,
        mint_decimals,
        mint_fee_config.fee_percentage_6,
        mint_fee_config.min_fee_6,
        mint_fee_config.max_fee_6,
    )?;

    // 6. State Updates
    delegate.remaining_capacity -= amount;

    let deposit = &mut ctx.accounts.deposit;
    deposit.depositor = delegate.authority;
    deposit.mint = delegate.allowed_mint;
    deposit.amount = amount;
    deposit.reserver = reserver;
    deposit.releaser = releaser;
    deposit.recipient = None;
    deposit.deposit_hash = message;
    deposit.quote_hash = [0u8; 32]; // set by the reserver at reserve time
    deposit.deposit_request_hash = deposit_request_hash;
    deposit.destination_hash = destination_hash;
    deposit.fee_amount = fee_amount;

    let depositor = delegate.authority;
    let delegate_bump = ctx.bumps.escrow_delegate;

    let mint_key = ctx.accounts.mint.key();
    let seeds = &[
        b"escrow_delegate".as_ref(),
        depositor.as_ref(),
        mint_key.as_ref(),
        &[delegate_bump],
    ];
    let signer_seeds = &[&seeds[..]];
    let decimals = ctx.accounts.mint.decimals;

    // 7. Exact transfer enforcement
    // Record balance before transfer
    let escrow_balance_before = ctx.accounts.escrow_ata.amount;

    transfer::transfer_checked(
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.authority_ata.to_account_info(),
        ctx.accounts.mint.to_account_info(),
        ctx.accounts.escrow_ata.to_account_info(),
        ctx.accounts.escrow_delegate.to_account_info(),
        ctx.remaining_accounts,
        amount,
        decimals,
        signer_seeds,
    )?;

    // Reload escrow_ata to get updated balance after transfer
    ctx.accounts.escrow_ata.reload()?;
    let escrow_balance_after = ctx.accounts.escrow_ata.amount;

    // Enforce exact transfer: received amount must equal requested amount
    // This rejects TransferFee mints that would deduct fees from the transfer
    let received = escrow_balance_after
        .checked_sub(escrow_balance_before)
        .ok_or(ErrorCode::NonExactTransfer)?;
    require!(received == amount, ErrorCode::NonExactTransfer);

    emit!(Deposited {
        deposit_hash: message,
        depositor,
        reserver,
        releaser,
        amount,
        fee_amount,
        nonce,
        issued_at,
        deadline,
    });
    Ok(())
}

pub fn reserve(
    ctx: Context<Reserve>,
    recipient: Pubkey,
    quote_hash: [u8; 32],
    source_amount: u64,
) -> Result<()> {
    let deposit = &mut ctx.accounts.deposit;

    // 1. State Check
    require!(deposit.recipient.is_none(), ErrorCode::RecipientAlreadySet);

    // Recipient Validation
    require!(recipient != Pubkey::default(), ErrorCode::RoleAccountNotSet);

    // Offchain quote hash must be set
    require!(quote_hash != [0u8; 32], ErrorCode::QuoteHashCannotBeEmpty);

    // CORE-2022: the charge must be positive and within what the payer authorized. `deposit.amount`
    // is still the signed ceiling at this point, so this is the same `0 < sourceAmount <= permitted`
    // bound Escrow.sol enforces.
    require!(source_amount > 0, ErrorCode::AmountCannotBeZero);
    require!(
        source_amount <= deposit.amount,
        ErrorCode::SourceAmountExceedsDeposit
    );

    // 2. Signature Verification (the reserver attests the recipient, the offchain quote hash, and
    //    how much of the payer's authorization that quote consumes).
    let expected_message = compute_reserve_hash(
        &ctx.accounts.protocol_config,
        recipient,
        deposit.deposit_hash,
        quote_hash,
        source_amount,
    );
    verify_single_ed25519_instruction(
        &ctx.accounts.instructions,
        &deposit.reserver,
        &expected_message,
    )?;

    // 3. Update State
    //
    // Narrowing `amount` to the charge is the whole fix, and it needs no token movement here: the
    // escrow ATA keeps holding the ceiling, and `release` already returns
    // `escrow_ata.amount - deposit.amount` to the depositor as surplus, while `refund` returns the
    // entire ATA balance. So the ceiling-minus-charge difference goes back to the payer down paths
    // that already exist and are already tested, and nothing can strand.
    //
    // The fee must follow the charge — `release` pays the settler `deposit.amount -
    // deposit.fee_amount`, so a fee left computed over the ceiling would silently underpay them.
    //
    // It is SCALED from the deposit-time fee rather than recomputed from the live MintFeeConfig,
    // which would have been the closer analogue of Escrow.sol's `determineFee(sourceAmount)`.
    // Recomputing reads the CURRENT config, so a fee-config change landing between deposit and
    // reserve would move a fee the depositor had already been quoted — and this program
    // deliberately guarantees the opposite (test 10.6, "fee snapshot is stable across config
    // changes"). Scaling keeps that guarantee: the RATE is frozen at deposit and only the amount
    // it applies to changes.
    //
    // Known divergence: a min/max clamp is not re-evaluated against the smaller amount, so a
    // clamped deposit yields a proportionally-scaled fee rather than the clamp recomputed at the
    // charge. Accepted deliberately — preserving the snapshot guarantee was judged worth more than
    // exact clamp parity, and the alternative needs the rate itself stored on DepositInfo, which
    // is an account-layout change.
    //
    // Multiply before divide, with the product WIDENED TO u128 inside rescale_reserved_fee.
    // source_amount <= deposit.amount is enforced above, so the QUOTIENT can never exceed the
    // original fee — but the PRODUCT formed before the divide is not bounded by that, and in u64
    // it overflowed and reverted for ordinary deposit sizes. See rescale_reserved_fee.
    let fee_amount = rescale_reserved_fee(deposit.fee_amount, source_amount, deposit.amount)?;

    // Same boundary compute_fee enforces at deposit (fees.rs step 5) and EVM/TVM enforce for
    // determineFee(sourceAmount): a fee that reaches the charge leaves the settler a zero release.
    // Flooring the rescale made this unreachable — floor(fee * r / d) >= r needs fee >= d, which
    // compute_fee already rejects — but ceiling it does not: a one-atom charge scales to a one-atom
    // fee for any non-zero snapshot.
    require!(fee_amount < source_amount, ErrorCode::FeeExceedsAmount);

    deposit.recipient = Some(recipient);
    deposit.quote_hash = quote_hash;
    deposit.amount = source_amount;
    deposit.fee_amount = fee_amount;
    emit!(Reserved {
        deposit_hash: deposit.deposit_hash,
        recipient,
        quote_hash,
        source_amount,
        fee_amount,
    });
    Ok(())
}

// No transfer fee check here or in refund: blocking settlement on a fee scheduled after deposit
// would strand every open deposit of the mint. security.md has the runbook for a fee change.
pub fn release<'a>(ctx: Context<'_, '_, 'a, 'a, Release<'a>>) -> Result<()> {
    let deposit = &ctx.accounts.deposit;

    // 1. Recipient is validated by account constraint (deposit.recipient must be set)
    let recipient = ctx.accounts.recipient.key();

    // 2. Signature Verification (binds the offchain quote hash attested at reserve)
    let expected_message = compute_release_hash(
        &ctx.accounts.protocol_config,
        deposit.deposit_hash,
        deposit.quote_hash,
    );
    verify_single_ed25519_instruction(
        &ctx.accounts.instructions,
        &deposit.releaser,
        &expected_message,
    )?;

    prepare_depositor_ata(
        &ctx.accounts.depositor_ata,
        &ctx.accounts.depositor,
        &ctx.accounts.mint,
        &ctx.accounts.payer,
        &ctx.accounts.token_program,
        &ctx.accounts.associated_token_program,
        &ctx.accounts.system_program,
    )?;

    // 3. Exact settlement calculation
    let settlement = compute_release_settlement(
        ctx.accounts.escrow_ata.amount,
        deposit.amount,
        deposit.fee_amount,
    )?;

    // 4. Build signer seeds for PDA
    let bump = ctx.bumps.deposit;
    let bump_binding = [bump];
    let deposit_seeds = [
        b"deposit".as_ref(),
        deposit.deposit_hash.as_ref(),
        bump_binding.as_ref(),
    ];
    let signer_seeds = [&deposit_seeds[..]];
    let deposit_authority_info = ctx.accounts.deposit.to_account_info();
    let decimals = ctx.accounts.mint.decimals;

    // 5. Transfer net to recipient
    if settlement.net_amount > 0 {
        transfer::transfer_checked(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.escrow_ata.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.recipient_ata.to_account_info(),
            deposit_authority_info.clone(),
            ctx.remaining_accounts,
            settlement.net_amount,
            decimals,
            &signer_seeds,
        )?;
    }

    // 6. Transfer fee to treasury
    if settlement.fee_amount > 0 {
        transfer::transfer_checked(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.escrow_ata.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.treasury_ata.to_account_info(),
            deposit_authority_info.clone(),
            ctx.remaining_accounts,
            settlement.fee_amount,
            decimals,
            &signer_seeds,
        )?;
    }

    // 7. Return any surplus to the original depositor. The depositor controls their ATA's state, so a
    //    surplus it cannot take goes to the treasury instead of blocking the payout above.
    let surplus_to_treasury = settlement.surplus_amount > 0
        && !accepts_plain_credit(&ctx.accounts.depositor_ata.to_account_info())?;
    if settlement.surplus_amount > 0 {
        let surplus_to = if surplus_to_treasury {
            msg!("Surplus sent to the treasury: the depositor token account refuses plain credits");
            ctx.accounts.treasury_ata.to_account_info()
        } else {
            memo_before_credit(&ctx.accounts.memo_program, b"atum escrow surplus")?;
            ctx.accounts.depositor_ata.to_account_info()
        };
        transfer::transfer_checked(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.escrow_ata.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            surplus_to,
            deposit_authority_info.clone(),
            ctx.remaining_accounts,
            settlement.surplus_amount,
            decimals,
            &signer_seeds,
        )?;
    }

    // 8. Close Escrow ATA
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.escrow_ata.to_account_info(),
            destination: ctx.accounts.payer.to_account_info(),
            authority: deposit_authority_info,
        },
        &signer_seeds,
    ))?;

    emit!(Released {
        deposit_hash: deposit.deposit_hash,
        quote_hash: deposit.quote_hash,
        recipient,
        gross_amount: settlement.gross_amount,
        intended_amount: settlement.intended_amount,
        surplus_amount: settlement.surplus_amount,
        fee_amount: settlement.fee_amount,
        net_amount: settlement.net_amount,
    });
    Ok(())
}

pub fn refund<'a>(ctx: Context<'_, '_, 'a, 'a, Refund<'a>>) -> Result<()> {
    let deposit = &ctx.accounts.deposit;
    // 1. Signature Verification. Binds the offchain quote hash (matches EVM/Tron); it is zero for a
    //    deposit that was never reserved.
    let expected_message = compute_refund_hash(
        &ctx.accounts.protocol_config,
        deposit.deposit_hash,
        deposit.quote_hash,
    );
    verify_single_ed25519_instruction(
        &ctx.accounts.instructions,
        &deposit.releaser,
        &expected_message,
    )?;

    // 2. Account Validations
    // Escrow ATA constraints are on the accounts struct, the depositor ATA is checked by address here.
    prepare_depositor_ata(
        &ctx.accounts.depositor_ata,
        &ctx.accounts.depositor,
        &ctx.accounts.mint,
        &ctx.accounts.payer,
        &ctx.accounts.token_program,
        &ctx.accounts.associated_token_program,
        &ctx.accounts.system_program,
    )?;

    // 3. Transfer and Closure
    // Transfer the entire escrow ATA balance to ensure the account can be
    // closed even if extra tokens were sent to it.
    let deposit_amount = ctx.accounts.escrow_ata.amount;

    let bump = ctx.bumps.deposit;
    let bump_binding = [bump];
    let deposit_seeds = [
        b"deposit".as_ref(),
        deposit.deposit_hash.as_ref(),
        bump_binding.as_ref(),
    ];
    let signer_seeds = [&deposit_seeds[..]];
    let deposit_authority_info = ctx.accounts.deposit.to_account_info();

    memo_before_credit(&ctx.accounts.memo_program, b"atum escrow refund")?;
    transfer::transfer_checked(
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.escrow_ata.to_account_info(),
        ctx.accounts.mint.to_account_info(),
        ctx.accounts.depositor_ata.to_account_info(),
        deposit_authority_info.clone(),
        ctx.remaining_accounts,
        deposit_amount,
        ctx.accounts.mint.decimals,
        &signer_seeds,
    )?;

    // Close Escrow ATA
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.escrow_ata.to_account_info(),
            destination: ctx.accounts.payer.to_account_info(),
            authority: deposit_authority_info,
        },
        &signer_seeds,
    ))?;

    emit!(Refunded {
        deposit_hash: deposit.deposit_hash,
        quote_hash: deposit.quote_hash,
        depositor: deposit.depositor,
        amount: deposit_amount,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_release_settlement_returns_surplus_and_net() {
        let settlement = compute_release_settlement(125, 100, 5).unwrap();

        assert_eq!(
            settlement,
            ReleaseSettlement {
                gross_amount: 125,
                intended_amount: 100,
                fee_amount: 5,
                net_amount: 95,
                surplus_amount: 25,
            }
        );
    }

    #[test]
    fn compute_release_settlement_rejects_underfunded_escrow() {
        let err = compute_release_settlement(99, 100, 5).unwrap_err();

        assert!(err
            .to_string()
            .contains("Escrow balance insufficient for intended release amount"));
    }
}
