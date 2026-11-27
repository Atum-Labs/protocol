use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;
pub mod utils;

use instructions::*;

declare_id!("77AqGeSh3GLFcBwSxdTnefgv92Cosi9o6NsK992TZsRe");

#[program]
pub mod fulfillment_proxy {
    use super::*;

    // Fulfillment instructions
    pub fn fulfill<'a>(
        ctx: Context<'_, '_, 'a, 'a, Fulfill<'a>>,
        quote_hash: [u8; 32],
        amount: u64,
    ) -> Result<()> {
        instructions::fulfillment::fulfill(ctx, quote_hash, amount)
    }

    pub fn strict_fulfill<'a>(
        ctx: Context<'_, '_, 'a, 'a, StrictFulfill<'a>>,
        quote_hash: [u8; 32],
        nonce: u64,
        issued_at: u64,
        amount: u64,
        deadline: u64,
    ) -> Result<()> {
        instructions::fulfillment::strict_fulfill(
            ctx, quote_hash, nonce, issued_at, amount, deadline,
        )
    }

    // Protocol administration instructions
    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        default_admin: Pubkey,
        pauser: Pubkey,
        default_admin_delay_seconds: u32,
    ) -> Result<()> {
        instructions::protocol::initialize_protocol(
            ctx,
            default_admin,
            pauser,
            default_admin_delay_seconds,
        )
    }

    pub fn pause(ctx: Context<PauseControl>) -> Result<()> {
        instructions::protocol::pause(ctx)
    }

    pub fn unpause(ctx: Context<PauseControl>) -> Result<()> {
        instructions::protocol::unpause(ctx)
    }

    pub fn set_pauser(ctx: Context<SetRoleKey>, new_pauser: Pubkey) -> Result<()> {
        instructions::protocol::set_pauser(ctx, new_pauser)
    }

    // CORE-2116: settler-allowlist admin instructions (default_admin-gated via SetRoleKey).
    pub fn set_enforce_settler_allowlist(ctx: Context<SetRoleKey>, enforced: bool) -> Result<()> {
        instructions::protocol::set_enforce_settler_allowlist(ctx, enforced)
    }

    pub fn add_authorized_settler(ctx: Context<SetRoleKey>, settler: Pubkey) -> Result<()> {
        instructions::protocol::add_authorized_settler(ctx, settler)
    }

    pub fn remove_authorized_settler(ctx: Context<SetRoleKey>, settler: Pubkey) -> Result<()> {
        instructions::protocol::remove_authorized_settler(ctx, settler)
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
}
