// SPDX-License-Identifier: MIT
use soroban_sdk::{contractevent, Address, BytesN};

use crate::types::Role;

// The EVM events, in the EVM field order. Topic fields mirror EVM's `indexed` members.

#[contractevent]
pub struct Deposited {
    #[topic]
    pub deposit_id: BytesN<32>,
    #[topic]
    pub quote_hash: BytesN<32>,
    #[topic]
    pub depositor: Address,
    pub settler: Address,
    pub token: Address,
    pub amount: i128,
    pub fee_amount: i128,
    pub reserver: BytesN<32>,
    pub releaser: BytesN<32>,
}

/// The two ActiveDeposit members `Deposited` does not carry, so a log-only consumer can rebuild a
/// Release/RefundWitness. Refund is the escape hatch and there is no rescue function.
#[contractevent]
pub struct DepositCommitments {
    #[topic]
    pub deposit_id: BytesN<32>,
    pub deposit_request_hash: BytesN<32>,
    pub destination_hash: BytesN<32>,
}

#[contractevent]
pub struct Released {
    #[topic]
    pub deposit_id: BytesN<32>,
    #[topic]
    pub settler: Address,
    pub token: Address,
    pub amount: i128,
    pub fee_amount: i128,
}

#[contractevent]
pub struct Refunded {
    #[topic]
    pub deposit_id: BytesN<32>,
    #[topic]
    pub depositor: Address,
    pub token: Address,
    pub amount: i128,
}

#[contractevent]
pub struct TokenAllowed {
    #[topic]
    pub token: Address,
    pub decimals: u32,
}

#[contractevent]
pub struct TokenDisallowed {
    #[topic]
    pub token: Address,
}

#[contractevent]
pub struct TokenFeesUpdated {
    #[topic]
    pub token: Address,
    pub fee_percentage_6: u32,
    pub min_fee_6: u64,
    pub max_fee_6: u64,
}

#[contractevent]
pub struct TokenFeesCleared {
    #[topic]
    pub token: Address,
}

#[contractevent]
pub struct FeeRevenueWithdrawn {
    #[topic]
    pub token: Address,
    #[topic]
    pub recipient: Address,
    pub amount: i128,
}

#[contractevent]
pub struct Paused {
    #[topic]
    pub by: Address,
}

#[contractevent]
pub struct Unpaused {
    #[topic]
    pub by: Address,
}

#[contractevent]
pub struct RoleGranted {
    #[topic]
    pub role: Role,
    #[topic]
    pub account: Address,
    pub sender: Address,
}

#[contractevent]
pub struct RoleRevoked {
    #[topic]
    pub role: Role,
    #[topic]
    pub account: Address,
    pub sender: Address,
}

#[contractevent]
pub struct DefaultAdminTransferScheduled {
    #[topic]
    pub new_admin: Address,
    pub accept_after: u64,
}

#[contractevent]
pub struct DefaultAdminTransferCanceled {
    #[topic]
    pub admin: Address,
}

#[contractevent]
pub struct DefaultAdminTransferred {
    #[topic]
    pub old_admin: Address,
    #[topic]
    pub new_admin: Address,
}

#[contractevent]
pub struct AdminDelayChangeScheduled {
    pub new_delay: u32,
    pub effective_at: u64,
}

#[contractevent]
pub struct AdminDelayChangeCanceled {
    #[topic]
    pub admin: Address,
}

#[contractevent]
pub struct DelegateCreated {
    #[topic]
    pub depositor: Address,
    #[topic]
    pub token: Address,
    pub delegate_signer: BytesN<32>,
    pub capacity: i128,
    pub max_transfer_size: i128,
    pub expiration: u64,
    pub epoch: u64,
}

#[contractevent]
pub struct DelegateRevoked {
    #[topic]
    pub depositor: Address,
    #[topic]
    pub token: Address,
    pub delegate_signer: BytesN<32>,
    pub epoch: u64,
}

#[contractevent]
pub struct DelegateRenounced {
    #[topic]
    pub depositor: Address,
    #[topic]
    pub token: Address,
    pub delegate_signer: BytesN<32>,
    pub epoch: u64,
}

/// The genesis entry of the event stream: the constructor's default admin and admin delay
#[contractevent]
pub struct Initialized {
    #[topic]
    pub default_admin: Address,
    pub admin_delay_secs: u32,
}
