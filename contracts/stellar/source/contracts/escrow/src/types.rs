// SPDX-License-Identifier: MIT
use soroban_sdk::{contracttype, Address, BytesN, String};

/// Operational roles. The default admin is deliberately not a member: it has its own delayed
/// two-step transfer and cannot be granted, revoked or renounced like these.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Role {
    Pauser,
    Treasurer,
    TokenConfig,
}

/// Per-token fee terms; mirrors `ITokenConfig.TokenConfig`. All `*_6` values are scaled to six
/// decimals regardless of the token's own decimals.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenConfig {
    /// 1_000_000 = 1%, max 100_000_000 = 100%, 0 = disabled. Fits u32, EVM's uint88 is wider than
    /// it ever needs to be.
    pub fee_percentage_6: u32,
    /// 0 = uncapped
    pub max_fee_6: u64,
    /// 0 = no floor
    pub min_fee_6: u64,
    pub token_decimals: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingAdmin {
    pub new_admin: Address,
    /// Ledger timestamp after which the new admin may accept.
    pub accept_after: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingDelay {
    pub new_delay: u32,
    /// Ledger timestamp from which `new_delay` is the current delay.
    pub effective_at: u64,
}

/// Per (depositor, token) pre-authorisation, the model of Solana's `EscrowDelegate`. The depositor
/// creates it once (`require_auth`) and grants the escrow a SEP-41 allowance; `deposit` then needs no
/// depositor authorisation, only a signature by `delegate_signer` over the deposit digest.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Delegate {
    /// 1 for the first record of a (depositor, token), +1 for each re-creation; binds renounce
    /// signatures to this record
    pub epoch: u64,
    /// Raw ed25519 public key that signs deposit digests on the depositor's behalf
    pub delegate_signer: BytesN<32>,
    /// Total still spendable; decremented by each deposit's charged amount
    pub remaining_capacity: i128,
    pub max_transfer_size: i128,
    /// Ledger timestamp; the delegate is usable while `now < expiration`
    pub expiration: u64,
}

/// What the depositor commits to, besides the funds. Reserver and releaser are raw ed25519 public
/// keys (the 32 bytes behind a G... address), not addresses: the contract verifies their
/// signatures itself rather than through `require_auth`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DepositWitness {
    pub deposit_request_hash: BytesN<32>,
    pub destination: String,
    pub reserver: BytesN<32>,
    pub releaser: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReserveWitness {
    pub deposit_id: BytesN<32>,
    pub quote_hash: BytesN<32>,
    pub settler: Address,
    pub source_amount: i128,
}

/// `amount` is the ceiling the depositor authorises; `reserve_witness.source_amount` is what is
/// charged. `delegate_signature` is the depositor's delegate signing the deposit digest before the
/// auction (Permit2's witness signature on EVM); nothing here needs the depositor's `require_auth`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DepositInput {
    pub depositor: Address,
    pub token: Address,
    pub amount: i128,
    pub deposit_witness: DepositWitness,
    pub nonce: u64,
    pub issued_at: u64,
    pub deadline: u64,
    pub delegate_signature: BytesN<64>,
    pub reserve_witness: ReserveWitness,
    pub reserve_signature: BytesN<64>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReleaseWitness {
    pub deposit_id: BytesN<32>,
    pub quote_hash: BytesN<32>,
    pub deposit_request_hash: BytesN<32>,
    pub destination_hash: BytesN<32>,
    pub depositor: Address,
    pub token: Address,
    pub amount: i128,
    pub fee_amount: i128,
    pub reserver: BytesN<32>,
    pub releaser: BytesN<32>,
    pub settler: Address,
}

/// Same eleven members as `ReleaseWitness`; a distinct type so a release signature can never be
/// presented as a refund (the digest tag differs as well).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RefundWitness {
    pub deposit_id: BytesN<32>,
    pub quote_hash: BytesN<32>,
    pub deposit_request_hash: BytesN<32>,
    pub destination_hash: BytesN<32>,
    pub depositor: Address,
    pub token: Address,
    pub amount: i128,
    pub fee_amount: i128,
    pub reserver: BytesN<32>,
    pub releaser: BytesN<32>,
    pub settler: Address,
}

/// The tuple whose hash is stored per live deposit; mirrors `IEscrow.ActiveDeposit`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActiveDeposit {
    pub depositor: Address,
    pub quote_hash: BytesN<32>,
    pub deposit_request_hash: BytesN<32>,
    pub destination_hash: BytesN<32>,
    pub token: Address,
    pub amount: i128,
    pub fee_amount: i128,
    pub reserver: BytesN<32>,
    pub releaser: BytesN<32>,
    pub settler: Address,
}

impl From<&ReleaseWitness> for ActiveDeposit {
    fn from(w: &ReleaseWitness) -> Self {
        Self {
            depositor: w.depositor.clone(),
            quote_hash: w.quote_hash.clone(),
            deposit_request_hash: w.deposit_request_hash.clone(),
            destination_hash: w.destination_hash.clone(),
            token: w.token.clone(),
            amount: w.amount,
            fee_amount: w.fee_amount,
            reserver: w.reserver.clone(),
            releaser: w.releaser.clone(),
            settler: w.settler.clone(),
        }
    }
}

impl From<&RefundWitness> for ActiveDeposit {
    fn from(w: &RefundWitness) -> Self {
        Self {
            depositor: w.depositor.clone(),
            quote_hash: w.quote_hash.clone(),
            deposit_request_hash: w.deposit_request_hash.clone(),
            destination_hash: w.destination_hash.clone(),
            token: w.token.clone(),
            amount: w.amount,
            fee_amount: w.fee_amount,
            reserver: w.reserver.clone(),
            releaser: w.releaser.clone(),
            settler: w.settler.clone(),
        }
    }
}
