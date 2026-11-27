//! Byte layouts of every signed or stored digest. The normative description is
//! `docs/witness-layouts.md`; the golden digests are pinned in `test_anchors.rs`.
//!
//! The framing follows the Solana port (`programs/escrow/src/utils/signatures.rs`): a constant
//! prefix, a tag, then fixed-width fields concatenated with no length prefixes, hashed with
//! keccak-256. Injectivity depends on every field being fixed-width, so the one variable-length
//! member, the destination, enters as `keccak256(destination)`.
//!
//! Domain separation is `sha256(network passphrase)` (the host's `network_id`) and the escrow's
//! contract id, so a signature cannot cross networks or escrow deployments. Unlike Solana there is
//! no configurable cluster id to initialise.

use soroban_sdk::{
    address_payload::AddressPayload, panic_with_error, Address, Bytes, BytesN, Env, String,
};

use crate::errors::Error;
use crate::types::ActiveDeposit;

/// The version byte every digest commits to. It is a hash input, so changing it makes every signature
/// issued under the old version fail. Change it when an existing layout keeps its bytes but changes
/// its meaning, or to retire all old signatures at once. Changing the bytes of one digest (for example
/// a member added to its preimage) already makes old signatures over that digest fail and does not
/// need a bump: re-derive that digest's vectors and update the encoders in lockstep.
pub const SIGNATURE_DOMAIN_VERSION: u8 = 2;

const DOMAIN_TAG: &[u8] = b"escrow";
const TAG_DEPOSIT: &[u8] = b"deposit";
const TAG_RESERVE: &[u8] = b"reserve";
const TAG_RELEASE: &[u8] = b"release";
const TAG_REFUND: &[u8] = b"refund";
const TAG_RENOUNCE: &[u8] = b"renounce";

/// Maximum destination length in bytes; uniform across EVM, TVM and SVM.
pub const MAX_DESTINATION_BYTES: u32 = 256;

/// sha256(network passphrase) and the escrow's contract id.
pub struct Domain {
    pub network_id: BytesN<32>,
    pub contract_id: BytesN<32>,
}

impl Domain {
    pub fn current(env: &Env) -> Self {
        let contract_id = match env.current_contract_address().to_payload() {
            Some(AddressPayload::ContractIdHash(h)) => h,
            _ => panic_with_error!(env, Error::UnsupportedAddress),
        };
        Self {
            network_id: env.ledger().network_id(),
            contract_id,
        }
    }
}

/// An address as 33 bytes: one type byte (the XDR `ScAddressType`: 0 = account G..., 1 = contract
/// C...) then the 32-byte key or contract hash. Fixed width, so it is safe to concatenate.
fn address33(env: &Env, a: &Address) -> [u8; 33] {
    let (kind, key) = match a.to_payload() {
        Some(AddressPayload::AccountIdPublicKeyEd25519(k)) => (0u8, k),
        Some(AddressPayload::ContractIdHash(k)) => (1u8, k),
        // Muxed or otherwise non-32-byte-payload addresses have no fixed-width form
        None => panic_with_error!(env, Error::UnsupportedAddress),
    };
    let mut out = [0u8; 33];
    out[0] = kind;
    out[1..].copy_from_slice(&key.to_array());
    out
}

/// Accumulates a preimage. Amounts are non-negative i128 (SEP-41) written as 16 little-endian
/// bytes, the same endianness the Solana port uses for its u64 amounts.
struct Preimage<'a> {
    env: &'a Env,
    buf: Bytes,
}

impl<'a> Preimage<'a> {
    fn new(env: &'a Env, domain: &Domain, tag: &[u8]) -> Self {
        let mut p = Self {
            env,
            buf: Bytes::new(env),
        };
        p.raw(DOMAIN_TAG);
        p.raw(&[SIGNATURE_DOMAIN_VERSION]);
        p.b32(&domain.network_id);
        p.b32(&domain.contract_id);
        p.raw(tag);
        p
    }

    fn raw(&mut self, v: &[u8]) {
        self.buf.extend_from_slice(v);
    }

    fn b32(&mut self, v: &BytesN<32>) {
        self.raw(&v.to_array());
    }

    fn addr(&mut self, a: &Address) {
        let b = address33(self.env, a);
        self.raw(&b);
    }

    fn amount(&mut self, v: i128) {
        // Callers have validated v >= 0; a negative value would still encode deterministically
        self.raw(&(v as u128).to_le_bytes());
    }

    fn u64(&mut self, v: u64) {
        self.raw(&v.to_le_bytes());
    }

    fn hash(self) -> BytesN<32> {
        self.env.crypto().keccak256(&self.buf).to_bytes()
    }
}

/// keccak256 of the UTF-8 destination, identical to EVM and TVM for the same string.
/// The caller bounds the length (<= `MAX_DESTINATION_BYTES`) first.
pub fn destination_hash(env: &Env, destination: &String) -> BytesN<32> {
    let mut buf = [0u8; MAX_DESTINATION_BYTES as usize];
    let len = destination.len() as usize;
    destination.copy_into_slice(&mut buf[..len]);
    env.crypto()
        .keccak256(&Bytes::from_slice(env, &buf[..len]))
        .to_bytes()
}

/// `delegate_epoch` is the epoch of the delegate record that authorises the deposit. Epochs only
/// rise (see `create_delegate`), so a signature made under a revoked record cannot verify against a
/// later record of the same pair, even when the same signer key is enrolled again.
#[allow(clippy::too_many_arguments)]
pub fn compute_deposit_hash(
    env: &Env,
    domain: &Domain,
    deposit_request_hash: &BytesN<32>,
    destination_hash: &BytesN<32>,
    depositor: &Address,
    token: &Address,
    delegate_epoch: u64,
    amount: i128,
    reserver: &BytesN<32>,
    releaser: &BytesN<32>,
    nonce: u64,
    issued_at: u64,
    deadline: u64,
) -> BytesN<32> {
    let mut p = Preimage::new(env, domain, TAG_DEPOSIT);
    p.b32(deposit_request_hash);
    p.b32(destination_hash);
    p.addr(depositor);
    p.addr(token);
    p.u64(delegate_epoch);
    p.amount(amount);
    p.b32(reserver);
    p.b32(releaser);
    p.u64(nonce);
    p.u64(issued_at);
    p.u64(deadline);
    p.hash()
}

/// What the delegate signer signs to renounce. The epoch binds it to one delegate record, so a
/// signature the signer did not submit cannot kill a later record of the same pair; the nonce, from
/// the depositor's bitmap, makes it single-use; the deadline (seconds, ledger time) bounds how long a
/// signature that was disclosed but not submitted stays executable.
pub fn compute_renounce_hash(
    env: &Env,
    domain: &Domain,
    depositor: &Address,
    token: &Address,
    epoch: u64,
    nonce: u64,
    deadline: u64,
) -> BytesN<32> {
    let mut p = Preimage::new(env, domain, TAG_RENOUNCE);
    p.addr(depositor);
    p.addr(token);
    p.u64(epoch);
    p.u64(nonce);
    p.u64(deadline);
    p.hash()
}

/// `source_amount` is inside the reserver's signature so the settler, who is paid, cannot pick
/// what the depositor is charged (as on Solana; `ReserveWitness.sourceAmount` on EVM).
pub fn compute_reserve_hash(
    env: &Env,
    domain: &Domain,
    deposit_id: &BytesN<32>,
    quote_hash: &BytesN<32>,
    settler: &Address,
    source_amount: i128,
) -> BytesN<32> {
    let mut p = Preimage::new(env, domain, TAG_RESERVE);
    p.b32(deposit_id);
    p.b32(quote_hash);
    p.addr(settler);
    p.amount(source_amount);
    p.hash()
}

fn settlement_hash(
    env: &Env,
    domain: &Domain,
    tag: &[u8],
    d: &ActiveDeposit,
    deposit_id: &BytesN<32>,
) -> BytesN<32> {
    // Eleven members in the EVM Release/RefundWitness order
    let mut p = Preimage::new(env, domain, tag);
    p.b32(deposit_id);
    p.b32(&d.quote_hash);
    p.b32(&d.deposit_request_hash);
    p.b32(&d.destination_hash);
    p.addr(&d.depositor);
    p.addr(&d.token);
    p.amount(d.amount);
    p.amount(d.fee_amount);
    p.b32(&d.reserver);
    p.b32(&d.releaser);
    p.addr(&d.settler);
    p.hash()
}

pub fn compute_release_hash(
    env: &Env,
    domain: &Domain,
    deposit_id: &BytesN<32>,
    d: &ActiveDeposit,
) -> BytesN<32> {
    settlement_hash(env, domain, TAG_RELEASE, d, deposit_id)
}

pub fn compute_refund_hash(
    env: &Env,
    domain: &Domain,
    deposit_id: &BytesN<32>,
    d: &ActiveDeposit,
) -> BytesN<32> {
    settlement_hash(env, domain, TAG_REFUND, d, deposit_id)
}

/// The value stored under a deposit id while it is live: keccak256 of the ten `ActiveDeposit`
/// members in EVM's struct order, fixed-width, with no domain prefix (it never leaves this
/// contract's storage and `get_deposit_hash`).
pub fn compute_active_deposit_hash(env: &Env, d: &ActiveDeposit) -> BytesN<32> {
    let mut buf = Bytes::new(env);
    let mut push = |v: &[u8]| buf.extend_from_slice(v);
    push(&address33(env, &d.depositor));
    push(&d.quote_hash.to_array());
    push(&d.deposit_request_hash.to_array());
    push(&d.destination_hash.to_array());
    push(&address33(env, &d.token));
    push(&(d.amount as u128).to_le_bytes());
    push(&(d.fee_amount as u128).to_le_bytes());
    push(&d.reserver.to_array());
    push(&d.releaser.to_array());
    push(&address33(env, &d.settler));
    env.crypto().keccak256(&buf).to_bytes()
}

/// Verifies `signature` over the 32-byte digest. Traps on failure (see `Error`).
pub fn verify(env: &Env, public_key: &BytesN<32>, digest: &BytesN<32>, signature: &BytesN<64>) {
    env.crypto().ed25519_verify(
        public_key,
        &Bytes::from_array(env, &digest.to_array()),
        signature,
    );
}
