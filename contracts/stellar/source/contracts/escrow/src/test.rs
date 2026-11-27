//! Lifecycle and policy tests against the compiled contract in the host-native test environment.

use std::boxed::Box;

use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    address_payload::AddressPayload,
    contract, contractimpl,
    testutils::{
        storage::{Instance as _, Persistent as _},
        Address as _, Events as _, Ledger as _,
    },
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, Event as _, String,
};

use crate::signatures::{self, Domain};
use crate::storage::{DataKey, BUMP_WINDOW};
use crate::*;

const T0: u64 = 1_700_000_000;
const SEQ0: u32 = 1_000;
/// sha256("Test SDF Network ; September 2015")
const NETWORK_TESTNET: [u8; 32] = [
    0xce, 0xe0, 0x30, 0x2d, 0x59, 0x84, 0x4d, 0x32, 0xbd, 0xca, 0x91, 0x5c, 0x82, 0x03, 0xdd, 0x44,
    0xb3, 0x3f, 0xbb, 0x7e, 0xdc, 0x19, 0x05, 0x1e, 0xa3, 0x7a, 0xbe, 0xdf, 0x28, 0xec, 0xd4, 0x72,
];
const DESTINATION: &str = "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@0xc0ffee254729296a45a3885639ac7e10f9d54979";
const USDC: i128 = 10_000_000; // 7 decimals, as on Stellar
const DAY: u64 = 24 * 60 * 60;

/// A token that keeps 1% of every transfer, to exercise the exact-transfer check.
#[contract]
struct FeeOnTransferToken;

#[contractimpl]
impl FeeOnTransferToken {
    pub fn decimals(_e: Env) -> u32 {
        7
    }
    pub fn balance(e: Env, id: Address) -> i128 {
        e.storage().persistent().get(&id).unwrap_or(0)
    }
    pub fn mint(e: Env, to: Address, amount: i128) {
        let b = Self::balance(e.clone(), to.clone());
        e.storage().persistent().set(&to, &(b + amount));
    }
    pub fn transfer_from(e: Env, _spender: Address, from: Address, to: Address, amount: i128) {
        Self::move_funds(e, from, to, amount);
    }
    pub fn transfer(e: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        Self::move_funds(e, from, to, amount);
    }
    fn move_funds(e: Env, from: Address, to: Address, amount: i128) {
        let f = Self::balance(e.clone(), from.clone());
        e.storage().persistent().set(&from, &(f - amount));
        let t = Self::balance(e.clone(), to.clone());
        e.storage()
            .persistent()
            .set(&to, &(t + amount - amount / 100));
    }
}

struct Fx<'a> {
    env: Env,
    escrow: EscrowClient<'a>,
    admin: Address,
    pauser: Address,
    treasurer: Address,
    token_cfg: Address,
    token: Address,
    depositor: Address,
    settler: Address,
    reserver: SigningKey,
    releaser: SigningKey,
    delegate: SigningKey,
}

/// What a deposit signs and states; every field can be overridden before it is built.
#[derive(Clone)]
struct Params {
    depositor: Address,
    token: Address,
    amount: i128,
    source_amount: i128,
    nonce: u64,
    issued_at: u64,
    deadline: u64,
    destination: &'static str,
    /// Epoch of the delegate record the deposit is signed under
    epoch: u64,
    /// Fill byte of the quote hash the reserver signs
    quote: u8,
}

fn pubkey(env: &Env, sk: &SigningKey) -> BytesN<32> {
    BytesN::from_array(env, &sk.verifying_key().to_bytes())
}

fn sign(env: &Env, sk: &SigningKey, digest: &BytesN<32>) -> BytesN<64> {
    BytesN::from_array(env, &sk.sign(&digest.to_array()).to_bytes())
}

fn domain_for(env: &Env, escrow: &Address) -> Domain {
    let contract_id = match escrow.to_payload() {
        Some(AddressPayload::ContractIdHash(h)) => h,
        _ => unreachable!(),
    };
    Domain {
        network_id: BytesN::from_array(env, &NETWORK_TESTNET),
        contract_id,
    }
}

impl<'a> Fx<'a> {
    /// A SAC allowed with a 0.02% fee, a $0.10 floor and a $250 cap (6-decimal scaled bounds).
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(T0);
        env.ledger().set_sequence_number(SEQ0);
        env.ledger().set_network_id(NETWORK_TESTNET);

        let admin = Address::generate(&env);
        let pauser = Address::generate(&env);
        let treasurer = Address::generate(&env);
        let token_cfg = Address::generate(&env);
        let depositor = Address::generate(&env);
        let settler = Address::generate(&env);

        let escrow_id = env.register(Escrow, (&admin, 1u32));
        let escrow = EscrowClient::new(&env, &escrow_id);
        escrow.grant_role(&Role::Pauser, &pauser);
        escrow.grant_role(&Role::Treasurer, &treasurer);
        escrow.grant_role(&Role::TokenConfig, &token_cfg);

        let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
        let token = sac.address();
        StellarAssetClient::new(&env, &token).mint(&depositor, &(1_000_000 * USDC));
        escrow.allow_token_and_set_fee_config(
            &token_cfg,
            &token,
            &7,
            &20_000,
            &100_000,
            &250_000_000,
        );

        let f = Self {
            env,
            escrow,
            admin,
            pauser,
            treasurer,
            token_cfg,
            token,
            depositor,
            settler,
            reserver: SigningKey::from_bytes(&[0x55; 32]),
            releaser: SigningKey::from_bytes(&[0x66; 32]),
            delegate: SigningKey::from_bytes(&[0x77; 32]),
        };
        f.enroll(&f.depositor, &f.token);
        f
    }

    /// The depositor's one-time setup: a delegate record (100k cap, 5k per transfer, 30 days) and the
    /// SEP-41 allowance to the escrow, both done before any auction.
    fn enroll(&self, depositor: &Address, token: &Address) {
        self.create_delegate(depositor, token);
        self.approve(depositor, token, 100_000 * USDC);
    }

    /// The delegate record alone (the first half of `enroll`), for re-enrolling a signer whose
    /// allowance is still in place.
    fn create_delegate(&self, depositor: &Address, token: &Address) {
        self.escrow.create_delegate(
            depositor,
            token,
            &pubkey(&self.env, &self.delegate),
            &(100_000 * USDC),
            &(5_000 * USDC),
            &(T0 + 30 * DAY),
        );
    }

    fn approve(&self, depositor: &Address, token: &Address, amount: i128) {
        let expiry = self.env.ledger().sequence() + 1_000_000;
        TokenClient::new(&self.env, token).approve(
            depositor,
            &self.escrow.address,
            &amount,
            &expiry,
        );
    }

    fn params(&self) -> Params {
        Params {
            depositor: self.depositor.clone(),
            token: self.token.clone(),
            amount: 1_250 * USDC,
            source_amount: 1_000 * USDC,
            nonce: 7,
            issued_at: T0,
            deadline: T0 + 128,
            destination: DESTINATION,
            epoch: self
                .escrow
                .get_delegate(&self.depositor, &self.token)
                .map_or(1, |d| d.epoch),
            quote: 0x33,
        }
    }

    fn domain(&self) -> Domain {
        domain_for(&self.env, &self.escrow.address)
    }

    fn b32(&self, v: u8) -> BytesN<32> {
        BytesN::from_array(&self.env, &[v; 32])
    }

    fn deposit_id(&self, domain: &Domain, p: &Params) -> BytesN<32> {
        let dest = String::from_str(&self.env, p.destination);
        signatures::compute_deposit_hash(
            &self.env,
            domain,
            &self.b32(0x44),
            &signatures::destination_hash(&self.env, &dest),
            &p.depositor,
            &p.token,
            p.epoch,
            p.amount,
            &pubkey(&self.env, &self.reserver),
            &pubkey(&self.env, &self.releaser),
            p.nonce,
            p.issued_at,
            p.deadline,
        )
    }

    fn build(&self, p: &Params) -> DepositInput {
        self.build_signed_by(p, &self.reserver, &self.delegate)
    }

    fn build_signed_by(
        &self,
        p: &Params,
        reserve_signer: &SigningKey,
        delegate_signer: &SigningKey,
    ) -> DepositInput {
        let id = self.deposit_id(&self.domain(), p);
        let quote_hash = self.b32(p.quote);
        let digest = signatures::compute_reserve_hash(
            &self.env,
            &self.domain(),
            &id,
            &quote_hash,
            &self.settler,
            p.source_amount,
        );
        DepositInput {
            depositor: p.depositor.clone(),
            token: p.token.clone(),
            amount: p.amount,
            deposit_witness: DepositWitness {
                deposit_request_hash: self.b32(0x44),
                destination: String::from_str(&self.env, p.destination),
                reserver: pubkey(&self.env, &self.reserver),
                releaser: pubkey(&self.env, &self.releaser),
            },
            nonce: p.nonce,
            issued_at: p.issued_at,
            deadline: p.deadline,
            delegate_signature: sign(&self.env, delegate_signer, &id),
            reserve_witness: ReserveWitness {
                deposit_id: id,
                quote_hash,
                settler: self.settler.clone(),
                source_amount: p.source_amount,
            },
            reserve_signature: sign(&self.env, reserve_signer, &digest),
        }
    }

    fn deposit(&self, p: &Params) -> (DepositInput, BytesN<32>) {
        let input = self.build(p);
        let id = self.escrow.deposit(&input);
        (input, id)
    }

    fn active(&self, input: &DepositInput, fee: i128) -> ActiveDeposit {
        let w = &input.deposit_witness;
        ActiveDeposit {
            depositor: input.depositor.clone(),
            quote_hash: input.reserve_witness.quote_hash.clone(),
            deposit_request_hash: w.deposit_request_hash.clone(),
            destination_hash: signatures::destination_hash(&self.env, &w.destination),
            token: input.token.clone(),
            amount: input.reserve_witness.source_amount,
            fee_amount: fee,
            reserver: w.reserver.clone(),
            releaser: w.releaser.clone(),
            settler: input.reserve_witness.settler.clone(),
        }
    }

    fn release_witness(&self, input: &DepositInput, fee: i128) -> ReleaseWitness {
        let a = self.active(input, fee);
        ReleaseWitness {
            deposit_id: input.reserve_witness.deposit_id.clone(),
            quote_hash: a.quote_hash,
            deposit_request_hash: a.deposit_request_hash,
            destination_hash: a.destination_hash,
            depositor: a.depositor,
            token: a.token,
            amount: a.amount,
            fee_amount: a.fee_amount,
            reserver: a.reserver,
            releaser: a.releaser,
            settler: a.settler,
        }
    }

    fn refund_witness(&self, input: &DepositInput, fee: i128) -> RefundWitness {
        let w = self.release_witness(input, fee);
        RefundWitness {
            deposit_id: w.deposit_id,
            quote_hash: w.quote_hash,
            deposit_request_hash: w.deposit_request_hash,
            destination_hash: w.destination_hash,
            depositor: w.depositor,
            token: w.token,
            amount: w.amount,
            fee_amount: w.fee_amount,
            reserver: w.reserver,
            releaser: w.releaser,
            settler: w.settler,
        }
    }

    fn release_sig(&self, w: &ReleaseWitness, signer: &SigningKey) -> BytesN<64> {
        let digest = signatures::compute_release_hash(
            &self.env,
            &self.domain(),
            &w.deposit_id,
            &ActiveDeposit::from(w),
        );
        sign(&self.env, signer, &digest)
    }

    fn refund_sig(&self, w: &RefundWitness, signer: &SigningKey) -> BytesN<64> {
        let digest = signatures::compute_refund_hash(
            &self.env,
            &self.domain(),
            &w.deposit_id,
            &ActiveDeposit::from(w),
        );
        sign(&self.env, signer, &digest)
    }

    fn bal(&self, who: &Address) -> i128 {
        TokenClient::new(&self.env, &self.token).balance(who)
    }

    fn fee_for(&self, source: i128) -> i128 {
        let cfg = self.escrow.get_token_config(&self.token).unwrap();
        self.escrow.determine_fee(&source, &cfg)
    }

    fn max_ttl(&self) -> u32 {
        self.env
            .as_contract(&self.escrow.address, || self.env.storage().max_ttl())
    }

    fn ttl(&self, key: &DataKey) -> u32 {
        self.env.as_contract(&self.escrow.address, || {
            self.env.storage().persistent().get_ttl(key)
        })
    }

    fn deposit_ttl(&self, id: &BytesN<32>) -> u32 {
        self.ttl(&DataKey::ActiveDeposit(id.clone()))
    }
}

/// A host-level trap (failed signature, failed auth) as opposed to a contract error code.
fn is_trap<T, A, B>(r: &Result<T, Result<A, B>>) -> bool {
    matches!(r, Err(Err(_)))
}

// ------------------------------------------------------------------ lifecycles

#[test]
fn deposit_then_release() {
    let f = Fx::new();
    let p = f.params();
    let start = f.bal(&f.depositor);
    let (input, id) = f.deposit(&p);

    // 0.02% of 1000 USDC is 0.2 USDC, above the $0.10 floor and far under the $250 cap
    let fee = f.fee_for(p.source_amount);
    assert_eq!(fee, 2_000_000);
    assert_eq!(f.bal(&f.depositor), start - p.source_amount);
    assert_eq!(f.bal(&f.escrow.address), p.source_amount);
    let stored = f.escrow.get_deposit_hash(&id).unwrap();
    let expected = signatures::compute_active_deposit_hash(&f.env, &f.active(&input, fee));
    assert_eq!(stored, expected);

    let w = f.release_witness(&input, fee);
    f.escrow.release(&w, &f.release_sig(&w, &f.releaser));

    assert_eq!(f.bal(&f.settler), p.source_amount - fee);
    assert_eq!(f.escrow.get_fee_revenue(&f.token), fee);
    assert_eq!(f.bal(&f.escrow.address), fee);
    assert_eq!(f.escrow.get_deposit_hash(&id), None);

    // The treasurer takes the accrued fee; it cannot be taken twice
    let treasury = Address::generate(&f.env);
    f.escrow
        .withdraw_fee_revenue(&f.treasurer, &f.token, &treasury);
    assert_eq!(f.bal(&treasury), fee);
    assert_eq!(f.bal(&f.escrow.address), 0);
    assert_eq!(f.escrow.get_fee_revenue(&f.token), 0);
    assert_eq!(
        f.escrow
            .try_withdraw_fee_revenue(&f.treasurer, &f.token, &treasury),
        Err(Ok(Error::NoFeesToWithdraw))
    );
}

#[test]
fn deposit_then_refund_returns_the_full_amount_and_takes_no_fee() {
    let f = Fx::new();
    let p = f.params();
    let start = f.bal(&f.depositor);
    let (input, id) = f.deposit(&p);
    let fee = f.fee_for(p.source_amount);

    let w = f.refund_witness(&input, fee);
    f.escrow.refund(&w, &f.refund_sig(&w, &f.releaser));

    assert_eq!(f.bal(&f.depositor), start);
    assert_eq!(f.bal(&f.escrow.address), 0);
    assert_eq!(f.escrow.get_fee_revenue(&f.token), 0);
    assert_eq!(f.escrow.get_deposit_hash(&id), None);
}

#[test]
fn only_the_source_amount_is_charged_not_the_ceiling() {
    let f = Fx::new();
    let p = f.params();
    let start = f.bal(&f.depositor);
    f.deposit(&p);
    assert_eq!(start - f.bal(&f.depositor), p.source_amount);
    assert!(p.source_amount < p.amount);
}

#[test]
fn a_contract_address_can_be_the_settler() {
    let f = Fx::new();
    let contract_settler = f
        .env
        .register_stellar_asset_contract_v2(Address::generate(&f.env))
        .address();
    let mut input = f.build(&f.params());
    // The settler is inside the reserve digest: re-sign for the new one
    input.reserve_witness.settler = contract_settler.clone();
    let digest = signatures::compute_reserve_hash(
        &f.env,
        &f.domain(),
        &input.reserve_witness.deposit_id,
        &input.reserve_witness.quote_hash,
        &contract_settler,
        input.reserve_witness.source_amount,
    );
    input.reserve_signature = sign(&f.env, &f.reserver, &digest);
    f.escrow.deposit(&input);

    let fee = f.fee_for(input.reserve_witness.source_amount);
    let w = f.release_witness(&input, fee);
    f.escrow.release(&w, &f.release_sig(&w, &f.releaser));
    assert_eq!(
        f.bal(&contract_settler),
        input.reserve_witness.source_amount - fee
    );
}

#[test]
fn the_escrow_cannot_be_the_settler() {
    let f = Fx::new();
    let mut input = f.build(&f.params());
    // The settler is inside the reserve digest: re-sign for the escrow's own address
    input.reserve_witness.settler = f.escrow.address.clone();
    let digest = signatures::compute_reserve_hash(
        &f.env,
        &f.domain(),
        &input.reserve_witness.deposit_id,
        &input.reserve_witness.quote_hash,
        &f.escrow.address,
        input.reserve_witness.source_amount,
    );
    input.reserve_signature = sign(&f.env, &f.reserver, &digest);
    assert_eq!(
        f.escrow.try_deposit(&input),
        Err(Ok(Error::SettlerCannotBeSelf))
    );
    // Nothing moved and the nonce was not spent
    assert_eq!(f.bal(&f.escrow.address), 0);
    assert_eq!(f.bal(&f.depositor), 1_000_000 * USDC);
    // The same deposit naming an ordinary settler lands under the same nonce
    f.deposit(&f.params());
}

#[test]
fn deposit_publishes_events() {
    let f = Fx::new();
    f.deposit(&f.params());
    // The token's transfer event plus Deposited and DepositCommitments, all from the escrow call
    assert!(f.env.events().all().events().len() >= 3);
}

// ------------------------------------------------------------- replay and time

#[test]
fn release_cannot_be_replayed_nor_followed_by_a_refund() {
    let f = Fx::new();
    let (input, _) = f.deposit(&f.params());
    let fee = f.fee_for(input.reserve_witness.source_amount);
    let w = f.release_witness(&input, fee);
    let sig = f.release_sig(&w, &f.releaser);
    f.escrow.release(&w, &sig);
    assert_eq!(
        f.escrow.try_release(&w, &sig),
        Err(Ok(Error::DepositNotFound))
    );

    let rw = f.refund_witness(&input, fee);
    assert_eq!(
        f.escrow.try_refund(&rw, &f.refund_sig(&rw, &f.releaser)),
        Err(Ok(Error::DepositNotFound))
    );
}

#[test]
fn refund_cannot_be_replayed_nor_followed_by_a_release() {
    let f = Fx::new();
    let (input, _) = f.deposit(&f.params());
    let fee = f.fee_for(input.reserve_witness.source_amount);
    let rw = f.refund_witness(&input, fee);
    let sig = f.refund_sig(&rw, &f.releaser);
    f.escrow.refund(&rw, &sig);
    assert_eq!(
        f.escrow.try_refund(&rw, &sig),
        Err(Ok(Error::DepositNotFound))
    );
    let w = f.release_witness(&input, fee);
    assert_eq!(
        f.escrow.try_release(&w, &f.release_sig(&w, &f.releaser)),
        Err(Ok(Error::DepositNotFound))
    );
}

#[test]
fn a_nonce_is_single_use_even_after_the_deposit_completes() {
    let f = Fx::new();
    let p = f.params();
    let (input, _) = f.deposit(&p);
    // Live duplicate: the same input again
    assert_eq!(
        f.escrow.try_deposit(&input),
        Err(Ok(Error::NonceAlreadyUsed))
    );

    // Completed duplicate: same id, deposit already released
    let fee = f.fee_for(p.source_amount);
    let w = f.release_witness(&input, fee);
    f.escrow.release(&w, &f.release_sig(&w, &f.releaser));
    assert_eq!(
        f.escrow.try_deposit(&input),
        Err(Ok(Error::NonceAlreadyUsed))
    );

    // A different nonce in the same 128-nonce word is independent, and so is one in another word
    let mut p2 = p.clone();
    p2.nonce = 8;
    p2.quote = 0x34;
    f.deposit(&p2);
    let mut p3 = p;
    p3.nonce = 7 + 128;
    p3.quote = 0x35;
    f.deposit(&p3);
}

#[test]
fn nonces_are_per_depositor() {
    let f = Fx::new();
    let p = f.params();
    f.deposit(&p);
    let other = Address::generate(&f.env);
    StellarAssetClient::new(&f.env, &f.token).mint(&other, &(10_000 * USDC));
    f.enroll(&other, &f.token);
    let mut p2 = p;
    p2.depositor = other;
    p2.quote = 0x34;
    f.deposit(&p2);
}

/// A second allowed token for the fixture's depositor, with its own delegate signer, so one token's
/// signer and another's can be told apart.
fn enroll_second_token(f: &Fx) -> (Address, SigningKey) {
    let token_b = f
        .env
        .register_stellar_asset_contract_v2(Address::generate(&f.env))
        .address();
    StellarAssetClient::new(&f.env, &token_b).mint(&f.depositor, &(1_000_000 * USDC));
    f.escrow.allow_token_and_set_fee_config(
        &f.token_cfg,
        &token_b,
        &7,
        &20_000,
        &100_000,
        &250_000_000,
    );
    let signer_b = SigningKey::from_bytes(&[0x88; 32]);
    f.escrow.create_delegate(
        &f.depositor,
        &token_b,
        &pubkey(&f.env, &signer_b),
        &(100_000 * USDC),
        &(5_000 * USDC),
        &(T0 + 30 * DAY),
    );
    f.approve(&f.depositor, &token_b, 100_000 * USDC);
    (token_b, signer_b)
}

#[test]
fn a_nonce_spent_by_one_tokens_signer_does_not_block_another_tokens_deposit() {
    let f = Fx::new();
    let (token_b, signer_b) = enroll_second_token(&f);

    // Token A's signer deposits with nonce 7
    f.deposit(&f.params());

    // Token B's signer, a different key, deposits with the same nonce value: its own space
    let mut pb = f.params();
    pb.token = token_b.clone();
    pb.epoch = 1;
    pb.quote = 0x34;
    let input_b = f.build_signed_by(&pb, &f.reserver, &signer_b);
    f.escrow.deposit(&input_b);

    // Within one token the nonce is still single-use
    assert_eq!(
        f.escrow.try_deposit(&input_b),
        Err(Ok(Error::NonceAlreadyUsed))
    );
}

#[test]
fn a_renounce_by_one_tokens_signer_does_not_burn_a_nonce_of_another_token() {
    let f = Fx::new();
    let (token_b, signer_b) = enroll_second_token(&f);

    // Token A's signer renounces with nonce 900
    f.escrow.renounce_delegate(
        &f.depositor,
        &f.token,
        &900,
        &RENOUNCE_DEADLINE,
        &renounce_sig(&f, 1, 900, &f.delegate),
    );

    // The depositor's deposit in token B at nonce 900 is unaffected
    let mut pb = f.params();
    pb.token = token_b;
    pb.epoch = 1;
    pb.nonce = 900;
    f.escrow
        .deposit(&f.build_signed_by(&pb, &f.reserver, &signer_b));

    // The renounce nonce is spent in token A's space: a deposit in A at 900 is refused as used
    let mut pa = f.params();
    pa.nonce = 900;
    assert_eq!(
        f.escrow.try_deposit(&f.build(&pa)),
        Err(Ok(Error::NonceAlreadyUsed))
    );
}

#[test]
fn expired_deadline_is_refused() {
    let f = Fx::new();
    let p = f.params();
    let input = f.build(&p);
    f.env.ledger().set_timestamp(p.deadline + 1);
    assert_eq!(
        f.escrow.try_deposit(&input),
        Err(Ok(Error::DeadlineExpired))
    );
    // The deadline second itself is still valid
    f.env.ledger().set_timestamp(p.deadline);
    f.escrow.deposit(&input);
}

#[test]
fn timestamp_bounds() {
    let f = Fx::new();
    let mut p = f.params();

    p.issued_at = T0 + 1;
    p.deadline = T0 + 100;
    assert_eq!(
        f.escrow.try_deposit(&f.build(&p)),
        Err(Ok(Error::FutureDeposit))
    );

    p.issued_at = T0;
    p.deadline = T0 - 1;
    assert_eq!(
        f.escrow.try_deposit(&f.build(&p)),
        Err(Ok(Error::InconsistentTimestamps))
    );

    p.deadline = T0 + DAY + 1;
    assert_eq!(
        f.escrow.try_deposit(&f.build(&p)),
        Err(Ok(Error::DeadlineTooFarInFuture))
    );
    p.deadline = T0 + DAY;
    f.deposit(&p);
}

// ---------------------------------------------------------------- signatures

#[test]
fn a_reserve_signature_from_the_wrong_key_traps() {
    let f = Fx::new();
    let imposter = SigningKey::from_bytes(&[0x99; 32]);
    let input = f.build_signed_by(&f.params(), &imposter, &f.delegate);
    let r = f.escrow.try_deposit(&input);
    assert!(is_trap(&r), "{r:?}");
    assert_eq!(f.bal(&f.escrow.address), 0);
}

#[test]
fn a_reserve_signature_does_not_cover_a_different_charge() {
    let f = Fx::new();
    let mut input = f.build(&f.params());
    // The settler cannot raise the charge: source_amount is inside the reserver's signature
    input.reserve_witness.source_amount += 1;
    let r = f.escrow.try_deposit(&input);
    assert!(is_trap(&r), "{r:?}");
}

#[test]
fn a_release_signature_from_the_wrong_key_traps_and_leaves_the_deposit_live() {
    let f = Fx::new();
    let (input, id) = f.deposit(&f.params());
    let fee = f.fee_for(input.reserve_witness.source_amount);
    let w = f.release_witness(&input, fee);
    let r = f.escrow.try_release(&w, &f.release_sig(&w, &f.reserver));
    assert!(is_trap(&r), "{r:?}");
    assert!(f.escrow.get_deposit_hash(&id).is_some());
    // The right signer still can
    f.escrow.release(&w, &f.release_sig(&w, &f.releaser));
}

#[test]
fn a_release_signature_cannot_be_used_as_a_refund() {
    let f = Fx::new();
    let (input, _) = f.deposit(&f.params());
    let fee = f.fee_for(input.reserve_witness.source_amount);
    let w = f.release_witness(&input, fee);
    let release_sig = f.release_sig(&w, &f.releaser);
    let rw = f.refund_witness(&input, fee);
    let r = f.escrow.try_refund(&rw, &release_sig);
    assert!(is_trap(&r), "{r:?}");
}

#[test]
fn a_witness_that_differs_from_the_stored_deposit_is_refused() {
    let f = Fx::new();
    let (input, _) = f.deposit(&f.params());
    let fee = f.fee_for(input.reserve_witness.source_amount);

    // Each tampered witness carries a signature that is genuine FOR THAT WITNESS: the stored-hash
    // check, not the signature, is what refuses it.
    type Tamper = fn(&mut ReleaseWitness, &Env);
    let tampered: [(&str, Tamper); 3] = [
        ("settler swapped", |w, e| w.settler = Address::generate(e)),
        ("fee lowered", |w, _| w.fee_amount = 0),
        ("amount raised", |w, _| w.amount += 1),
    ];
    for (name, mutate) in tampered {
        let mut w = f.release_witness(&input, fee);
        mutate(&mut w, &f.env);
        assert_eq!(
            f.escrow.try_release(&w, &f.release_sig(&w, &f.releaser)),
            Err(Ok(Error::InvalidWitnessValues)),
            "{name}"
        );
    }

    let mut w = f.release_witness(&input, fee);
    w.deposit_id = f.b32(0x01);
    assert_eq!(
        f.escrow.try_release(&w, &f.release_sig(&w, &f.releaser)),
        Err(Ok(Error::DepositNotFound))
    );

    let mut w = f.release_witness(&input, fee);
    w.quote_hash = f.b32(0);
    assert_eq!(
        f.escrow.try_release(&w, &f.release_sig(&w, &f.releaser)),
        Err(Ok(Error::QuoteHashCannotBeEmpty))
    );
    let mut rw = f.refund_witness(&input, fee);
    rw.quote_hash = f.b32(0);
    assert_eq!(
        f.escrow.try_refund(&rw, &f.refund_sig(&rw, &f.releaser)),
        Err(Ok(Error::QuoteHashCannotBeEmpty))
    );
}

#[test]
fn deposit_needs_no_depositor_authorisation() {
    let f = Fx::new();
    let input = f.build(&f.params());
    // Nobody authorises anything: the delegate signature and the allowance are the authority
    f.env.set_auths(&[]);
    f.escrow.deposit(&input);
    assert_eq!(
        f.bal(&f.escrow.address),
        input.reserve_witness.source_amount
    );
}

#[test]
fn deposit_ids_bind_the_deployment() {
    // Same inputs under a second escrow instance: different contract id, different deposit id
    let f = Fx::new();
    let p = f.params();
    let other = f.env.register(Escrow, (&f.admin, 1u32));
    assert_ne!(
        f.deposit_id(&f.domain(), &p),
        f.deposit_id(&domain_for(&f.env, &other), &p)
    );
}

// ---------------------------------------------------------------- validation

#[test]
fn witness_and_amount_validation() {
    let f = Fx::new();
    let zero = f.b32(0);

    let mut i = f.build(&f.params());
    i.deposit_witness.reserver = zero.clone();
    assert_eq!(
        f.escrow.try_deposit(&i),
        Err(Ok(Error::ReserverCannotBeZero))
    );

    let mut i = f.build(&f.params());
    i.deposit_witness.releaser = zero.clone();
    assert_eq!(
        f.escrow.try_deposit(&i),
        Err(Ok(Error::ReleaserCannotBeZero))
    );

    let mut i = f.build(&f.params());
    i.deposit_witness.deposit_request_hash = zero.clone();
    assert_eq!(
        f.escrow.try_deposit(&i),
        Err(Ok(Error::DepositRequestHashCannotBeEmpty))
    );

    let mut i = f.build(&f.params());
    i.reserve_witness.quote_hash = zero;
    assert_eq!(
        f.escrow.try_deposit(&i),
        Err(Ok(Error::QuoteHashCannotBeEmpty))
    );

    let mut i = f.build(&f.params());
    i.deposit_witness.destination = String::from_str(&f.env, "");
    assert_eq!(
        f.escrow.try_deposit(&i),
        Err(Ok(Error::DestinationCannotBeEmpty))
    );

    let long = "x".repeat(257);
    let mut i = f.build(&f.params());
    i.deposit_witness.destination = String::from_str(&f.env, &long);
    assert_eq!(f.escrow.try_deposit(&i), Err(Ok(Error::DestinationTooLong)));

    // 256 bytes is the inclusive bound
    let max: &'static str = Box::leak("y".repeat(256).into_boxed_str());
    let mut p = f.params();
    p.destination = max;
    f.deposit(&p);

    let mut p = f.params();
    p.nonce = 20;
    p.amount = 0;
    assert_eq!(
        f.escrow.try_deposit(&f.build(&p)),
        Err(Ok(Error::InvalidAmount))
    );

    let mut p = f.params();
    p.nonce = 21;
    p.source_amount = p.amount + 1;
    assert_eq!(
        f.escrow.try_deposit(&f.build(&p)),
        Err(Ok(Error::InvalidSourceAmount))
    );
    p.source_amount = 0;
    assert_eq!(
        f.escrow.try_deposit(&f.build(&p)),
        Err(Ok(Error::InvalidSourceAmount))
    );

    // The id the caller states must be the one the contract derives
    let mut p = f.params();
    p.nonce = 30;
    let mut i = f.build(&p);
    i.reserve_witness.deposit_id = f.b32(0x02);
    assert_eq!(f.escrow.try_deposit(&i), Err(Ok(Error::DepositIdMismatch)));

    // Token not on the allowlist
    let other_token = f
        .env
        .register_stellar_asset_contract_v2(Address::generate(&f.env))
        .address();
    let mut p = f.params();
    p.token = other_token;
    p.nonce = 22;
    assert_eq!(
        f.escrow.try_deposit(&f.build(&p)),
        Err(Ok(Error::TokenNotAllowed))
    );
}

#[test]
fn a_fee_that_reaches_the_amount_blocks_the_deposit() {
    let f = Fx::new();
    // The $0.10 floor is 1_000_000 atoms at 7 decimals: a charge of exactly that has fee == amount
    let mut p = f.params();
    p.amount = 1_000_000;
    p.source_amount = 1_000_000;
    assert_eq!(
        f.escrow.try_deposit(&f.build(&p)),
        Err(Ok(Error::FeeExceedsDepositAmount))
    );
    p.source_amount = 1_000_001;
    p.amount = 1_000_001;
    p.nonce = 8;
    f.deposit(&p);
}

#[test]
fn a_fee_on_transfer_token_is_refused_by_the_exact_transfer_check() {
    let f = Fx::new();
    let fot = f.env.register(FeeOnTransferToken, ());
    f.escrow.allow_token(&f.token_cfg, &fot, &7);
    // The mock has no allowance bookkeeping, so only the delegate record is needed
    f.escrow.create_delegate(
        &f.depositor,
        &fot,
        &pubkey(&f.env, &f.delegate),
        &(100_000 * USDC),
        &(5_000 * USDC),
        &(T0 + DAY),
    );
    FeeOnTransferTokenClient::new(&f.env, &fot).mint(&f.depositor, &(100 * USDC));
    let mut p = f.params();
    p.token = fot;
    assert_eq!(
        f.escrow.try_deposit(&f.build(&p)),
        Err(Ok(Error::NonExactTransfer))
    );
}

// ------------------------------------------------------------------- fees

#[test]
fn the_stored_fee_is_fixed_at_deposit_time() {
    let f = Fx::new();
    let p = f.params();
    let (input, id) = f.deposit(&p);
    let old_fee = f.fee_for(p.source_amount);
    // Reconfigure after the deposit: the fee in the stored deposit was fixed at funding
    f.escrow
        .set_token_fee_config(&f.token_cfg, &f.token, &1_000_000, &0, &0);
    let w = f.release_witness(&input, old_fee);
    f.escrow.release(&w, &f.release_sig(&w, &f.releaser));
    assert_eq!(f.escrow.get_fee_revenue(&f.token), old_fee);
    assert_eq!(f.escrow.get_deposit_hash(&id), None);

    // A new deposit pays the new 1% rate
    let mut p2 = p;
    p2.nonce = 9;
    p2.quote = 0x34;
    f.deposit(&p2);
    assert_eq!(f.fee_for(p2.source_amount), p2.source_amount / 100);
}

/// Characterization: this pins documented behaviour that already holds, so it passes before and
/// after the documentation change. `allow_token` opens a token at a zero fee schedule, a re-allowed
/// token does not get its old schedule back, and a deposit accepted at zero fee keeps it.
#[test]
fn allow_token_opens_deposits_at_zero_fee_and_re_allowing_discards_the_schedule() {
    let f = Fx::new();
    let scheduled = f.escrow.get_token_config(&f.token).unwrap();
    assert_ne!(scheduled.fee_percentage_6, 0);

    // Disallow and allow again with the standalone entrypoint: the schedule is gone
    f.escrow.disallow_token(&f.token_cfg, &f.token);
    f.escrow.allow_token(&f.token_cfg, &f.token, &7);
    assert_eq!(
        f.escrow.get_token_config(&f.token).unwrap(),
        TokenConfig {
            fee_percentage_6: 0,
            max_fee_6: 0,
            min_fee_6: 0,
            token_decimals: 7
        }
    );

    // The token is open for deposits at once, at zero fee
    let p = f.params();
    let (input, id) = f.deposit(&p);
    assert_eq!(f.fee_for(p.source_amount), 0);

    // Configuring the fee afterwards does not reach the deposit already accepted
    f.escrow.set_token_fee_config(
        &f.token_cfg,
        &f.token,
        &scheduled.fee_percentage_6,
        &scheduled.min_fee_6,
        &scheduled.max_fee_6,
    );
    let w = f.release_witness(&input, 0);
    f.escrow.release(&w, &f.release_sig(&w, &f.releaser));
    assert_eq!(f.escrow.get_deposit_hash(&id), None);
    assert_eq!(f.escrow.get_fee_revenue(&f.token), 0);
    assert_eq!(f.bal(&f.settler), p.source_amount);

    // A deposit accepted after the fee is configured pays it
    let mut p2 = p;
    p2.nonce = 8;
    p2.quote = 0x34;
    let (input2, _) = f.deposit(&p2);
    let fee = f.fee_for(p2.source_amount);
    assert!(fee > 0);
    let w2 = f.release_witness(&input2, fee);
    f.escrow.release(&w2, &f.release_sig(&w2, &f.releaser));
    assert_eq!(f.escrow.get_fee_revenue(&f.token), fee);
}

#[test]
fn the_cap_and_floor_apply_through_the_contract() {
    let f = Fx::new();
    // 0.02% of 2_000_000 USDC would be 400 USDC; the cap is 250
    assert_eq!(f.fee_for(2_000_000 * USDC), 250 * USDC);
    // The floor: 0.02% of 1 USDC is 0.0002 USDC, the floor is 0.10 USDC
    assert_eq!(f.fee_for(USDC), 1_000_000);
}

#[test]
fn an_in_flight_deposit_survives_its_token_being_disallowed() {
    let f = Fx::new();
    let (input, _) = f.deposit(&f.params());
    let fee = f.fee_for(input.reserve_witness.source_amount);
    f.escrow.disallow_token(&f.token_cfg, &f.token);
    assert!(!f.escrow.is_token_allowed(&f.token));
    assert_eq!(f.escrow.get_allowed_tokens().len(), 0);

    let mut p = f.params();
    p.nonce = 99;
    assert_eq!(
        f.escrow.try_deposit(&f.build(&p)),
        Err(Ok(Error::TokenNotAllowed))
    );

    let w = f.release_witness(&input, fee);
    f.escrow.release(&w, &f.release_sig(&w, &f.releaser));
    assert_eq!(f.bal(&f.settler), input.reserve_witness.source_amount - fee);
}

#[test]
fn token_config_administration() {
    let f = Fx::new();
    let t = f
        .env
        .register_stellar_asset_contract_v2(Address::generate(&f.env))
        .address();

    // Decimals are checked against the token's own answer (a SAC reports 7)
    assert_eq!(
        f.escrow.try_allow_token(&f.token_cfg, &t, &6),
        Err(Ok(Error::TokenDecimalsMismatch))
    );
    assert_eq!(
        f.escrow.try_allow_token(&f.token_cfg, &t, &0),
        Err(Ok(Error::TokenDecimalsCannotBeZero))
    );
    assert_eq!(
        f.escrow.try_allow_token(&f.token_cfg, &t, &19),
        Err(Ok(Error::TokenDecimalsExceedMaximum))
    );
    f.escrow.allow_token(&f.token_cfg, &t, &7);
    assert_eq!(
        f.escrow.try_allow_token(&f.token_cfg, &t, &7),
        Err(Ok(Error::TokenAlreadyAllowed))
    );
    assert_eq!(f.escrow.get_allowed_tokens().len(), 2);
    assert_eq!(
        f.escrow.get_token_config(&t).unwrap(),
        TokenConfig {
            fee_percentage_6: 0,
            max_fee_6: 0,
            min_fee_6: 0,
            token_decimals: 7
        }
    );

    f.escrow
        .set_token_fee_config(&f.token_cfg, &t, &20_000, &0, &0);
    assert_eq!(
        f.escrow.get_token_config(&t).unwrap().fee_percentage_6,
        20_000
    );
    f.escrow.clear_token_fee_config(&f.token_cfg, &t);
    assert_eq!(f.escrow.get_token_config(&t).unwrap().fee_percentage_6, 0);

    f.escrow.disallow_token(&f.token_cfg, &t);
    assert_eq!(
        f.escrow.try_disallow_token(&f.token_cfg, &t),
        Err(Ok(Error::TokenNotAllowed))
    );
    assert_eq!(
        f.escrow
            .try_set_token_fee_config(&f.token_cfg, &t, &1, &0, &0),
        Err(Ok(Error::TokenNotAllowed))
    );
    assert_eq!(f.escrow.get_allowed_tokens().len(), 1);

    assert_eq!(
        f.escrow
            .try_set_token_fee_config(&f.token_cfg, &f.token, &100_000_001, &0, &0),
        Err(Ok(Error::FeePercentageExceedsMaximum))
    );
}

#[test]
fn fee_revenue_withdrawal_guards() {
    let f = Fx::new();
    let treasury = Address::generate(&f.env);
    assert_eq!(
        f.escrow
            .try_withdraw_fee_revenue(&f.treasurer, &f.token, &f.escrow.address),
        Err(Ok(Error::RecipientCannotBeSelf))
    );
    assert_eq!(
        f.escrow
            .try_withdraw_fee_revenue(&f.pauser, &f.token, &treasury),
        Err(Ok(Error::MissingRole))
    );
}

// -------------------------------------------------------------------- pause

#[test]
fn pause_blocks_deposit_release_and_refund_and_unpause_restores_them() {
    let f = Fx::new();
    let (input, _) = f.deposit(&f.params());
    let fee = f.fee_for(input.reserve_witness.source_amount);

    f.escrow.pause(&f.pauser);
    assert!(f.escrow.paused());
    assert_eq!(f.escrow.try_pause(&f.pauser), Err(Ok(Error::Paused)));

    let mut p = f.params();
    p.nonce = 50;
    assert_eq!(f.escrow.try_deposit(&f.build(&p)), Err(Ok(Error::Paused)));
    let w = f.release_witness(&input, fee);
    assert_eq!(
        f.escrow.try_release(&w, &f.release_sig(&w, &f.releaser)),
        Err(Ok(Error::Paused))
    );
    let rw = f.refund_witness(&input, fee);
    assert_eq!(
        f.escrow.try_refund(&rw, &f.refund_sig(&rw, &f.releaser)),
        Err(Ok(Error::Paused))
    );

    f.escrow.unpause(&f.pauser);
    assert_eq!(f.escrow.try_unpause(&f.pauser), Err(Ok(Error::NotPaused)));
    f.escrow.release(&w, &f.release_sig(&w, &f.releaser));
}

#[test]
fn only_the_pauser_can_pause() {
    let f = Fx::new();
    assert_eq!(
        f.escrow.try_pause(&f.treasurer),
        Err(Ok(Error::MissingRole))
    );
    assert_eq!(f.escrow.try_pause(&f.admin), Err(Ok(Error::MissingRole)));
}

// -------------------------------------------------------------------- roles

#[test]
fn role_gates_and_changes() {
    let f = Fx::new();
    let nobody = Address::generate(&f.env);
    let t = f
        .env
        .register_stellar_asset_contract_v2(Address::generate(&f.env))
        .address();

    assert_eq!(
        f.escrow.try_allow_token(&nobody, &t, &7),
        Err(Ok(Error::MissingRole))
    );
    // The admin has no operational role by default, as on EVM
    assert_eq!(
        f.escrow.try_allow_token(&f.admin, &t, &7),
        Err(Ok(Error::MissingRole))
    );

    f.escrow.grant_role(&Role::TokenConfig, &nobody);
    assert!(f.escrow.has_role(&Role::TokenConfig, &nobody));
    f.escrow.allow_token(&nobody, &t, &7);
    f.escrow.revoke_role(&Role::TokenConfig, &nobody);
    assert!(!f.escrow.has_role(&Role::TokenConfig, &nobody));
    assert_eq!(
        f.escrow.try_disallow_token(&nobody, &t),
        Err(Ok(Error::MissingRole))
    );

    // A role holder can renounce its own role
    f.escrow.renounce_role(&Role::Pauser, &f.pauser);
    assert_eq!(f.escrow.try_pause(&f.pauser), Err(Ok(Error::MissingRole)));

    // Roles are independent
    assert!(f.escrow.has_role(&Role::Treasurer, &f.treasurer));
    assert!(!f.escrow.has_role(&Role::Pauser, &f.treasurer));
}

#[test]
fn granting_a_role_requires_the_default_admin() {
    let f = Fx::new();
    f.env.set_auths(&[]);
    let nobody = Address::generate(&f.env);
    let r = f.escrow.try_grant_role(&Role::Pauser, &nobody);
    assert!(r.is_err(), "{r:?}");
}

#[test]
fn default_admin_transfer_is_delayed_and_two_step() {
    let f = Fx::new();
    f.escrow.change_default_admin_delay(&3600);
    // An increase takes effect after min(new delay, 5 days) = 1 hour
    assert_eq!(f.escrow.default_admin_delay(), 1);
    assert!(f.escrow.pending_default_admin_delay().is_some());
    f.env.ledger().set_timestamp(T0 + 3601);
    assert_eq!(f.escrow.default_admin_delay(), 3600);
    assert!(f.escrow.pending_default_admin_delay().is_none());

    let new_admin = Address::generate(&f.env);
    assert_eq!(
        f.escrow.try_accept_default_admin_transfer(),
        Err(Ok(Error::NoPendingAdminTransfer))
    );
    f.escrow.begin_default_admin_transfer(&new_admin);
    let pending = f.escrow.pending_default_admin().unwrap();
    assert_eq!(pending.new_admin, new_admin);
    assert_eq!(pending.accept_after, T0 + 3601 + 3600);

    // Too early, including at the boundary second
    assert_eq!(
        f.escrow.try_accept_default_admin_transfer(),
        Err(Ok(Error::AdminTransferNotReady))
    );
    f.env.ledger().set_timestamp(pending.accept_after);
    assert_eq!(
        f.escrow.try_accept_default_admin_transfer(),
        Err(Ok(Error::AdminTransferNotReady))
    );
    f.env.ledger().set_timestamp(pending.accept_after + 1);
    f.escrow.accept_default_admin_transfer();

    assert_eq!(f.escrow.default_admin(), new_admin);
    assert!(f.escrow.pending_default_admin().is_none());
}

#[test]
fn the_pending_admin_must_authorise_acceptance() {
    let f = Fx::new();
    let new_admin = Address::generate(&f.env);
    f.escrow.begin_default_admin_transfer(&new_admin);
    f.env.ledger().set_timestamp(T0 + 10);
    f.env.set_auths(&[]);
    let r = f.escrow.try_accept_default_admin_transfer();
    assert!(is_trap(&r), "{r:?}");
}

#[test]
fn a_pending_transfer_can_be_cancelled_and_a_delay_change_rolled_back() {
    let f = Fx::new();
    let new_admin = Address::generate(&f.env);
    f.escrow.begin_default_admin_transfer(&new_admin);
    f.escrow.cancel_default_admin_transfer();
    assert!(f.escrow.pending_default_admin().is_none());
    assert_eq!(
        f.escrow.try_cancel_default_admin_transfer(),
        Err(Ok(Error::NoPendingAdminTransfer))
    );
    f.env.ledger().set_timestamp(T0 + 10);
    assert_eq!(
        f.escrow.try_accept_default_admin_transfer(),
        Err(Ok(Error::NoPendingAdminTransfer))
    );

    f.escrow.change_default_admin_delay(&(10 * DAY as u32));
    // The increase wait is capped at 5 days
    let pending = f.escrow.pending_default_admin_delay().unwrap();
    assert_eq!(pending.effective_at, T0 + 10 + 5 * DAY);
    f.escrow.rollback_default_admin_delay();
    assert!(f.escrow.pending_default_admin_delay().is_none());
    assert_eq!(f.escrow.default_admin_delay(), 1);
    assert_eq!(
        f.escrow.try_rollback_default_admin_delay(),
        Err(Ok(Error::NoPendingDelayChange))
    );
}

#[test]
fn after_a_transfer_the_new_admin_manages_roles() {
    let f = Fx::new();
    let new_admin = Address::generate(&f.env);
    f.escrow.begin_default_admin_transfer(&new_admin);
    f.env.ledger().set_timestamp(T0 + 10);
    f.escrow.accept_default_admin_transfer();
    assert_eq!(f.escrow.default_admin(), new_admin);

    // Only the new admin's authorisation is requested now
    let nobody = Address::generate(&f.env);
    f.escrow.grant_role(&Role::Pauser, &nobody);
    let auths = f.env.auths();
    assert_eq!(auths.last().unwrap().0, new_admin);
    assert_ne!(auths.last().unwrap().0, f.admin);
}

// ---------------------------------------------------------------- TTL policy

#[test]
fn a_deposit_is_extended_to_the_maximum_ttl_when_stored() {
    let f = Fx::new();
    let (_, id) = f.deposit(&f.params());
    let max = f.max_ttl();
    assert_eq!(f.deposit_ttl(&id), max);
    // The instance (config, roles, pause flag) is kept alive by the same call
    let inst = f
        .env
        .as_contract(&f.escrow.address, || f.env.storage().instance().get_ttl());
    assert_eq!(inst, max);
}

#[test]
fn a_new_nonce_word_keeps_the_network_minimum_ttl_and_is_not_prepaid() {
    let f = Fx::new();
    let (_, id) = f.deposit(&f.params());
    let max = f.max_ttl();
    let min = f.env.ledger().get().min_persistent_entry_ttl;
    assert!(
        min < max,
        "the test needs a gap between minimum and maximum TTL"
    );

    // A new nonce word is created at the minimum persistent TTL (live until seq + min - 1) and is
    // not extended: nothing needs it once the deposit's own deadline (at most 24 h) has passed
    let word = f.ttl(&DataKey::Nonce(f.depositor.clone(), f.token.clone(), 0));
    assert_eq!(word, min - 1);

    // The records a live deposit depends on are still extended to the maximum
    assert_eq!(f.deposit_ttl(&id), max);
    assert_eq!(f.ttl(&DataKey::TokenConfig(f.token.clone())), max);
    assert_eq!(
        f.ttl(&DataKey::Delegate(f.depositor.clone(), f.token.clone())),
        max
    );

    // A second nonce in the same word sets its bit without extending the word
    let mut p = f.params();
    p.nonce = 8;
    p.quote = 0x34;
    f.deposit(&p);
    assert_eq!(
        f.ttl(&DataKey::Nonce(f.depositor.clone(), f.token.clone(), 0)),
        min - 1
    );

    // The bit is still set: the same nonce is refused
    p.nonce = 7;
    assert_eq!(
        f.escrow.try_deposit(&f.build(&p)),
        Err(Ok(Error::NonceAlreadyUsed))
    );

    // A renounce spends a nonce word the same way
    let sig = renounce_sig(&f, 1, 1_028, &f.delegate);
    f.escrow
        .renounce_delegate(&f.depositor, &f.token, &1_028, &RENOUNCE_DEADLINE, &sig);
    assert_eq!(
        f.ttl(&DataKey::Nonce(
            f.depositor.clone(),
            f.token.clone(),
            1_028 >> 7
        )),
        min - 1
    );
}

#[test]
fn a_live_deposit_is_settleable_at_the_last_ledger_of_its_ttl_and_a_keepalive_pushes_it_out() {
    let f = Fx::new();
    let (input, id) = f.deposit(&f.params());
    let fee = f.fee_for(input.reserve_witness.source_amount);
    let max = f.deposit_ttl(&id);

    // TTL counts ledgers after the current one: this is the last ledger the entry can be read at
    f.env.ledger().set_sequence_number(SEQ0 + max);
    assert_eq!(f.deposit_ttl(&id), 0);

    // Anyone can keep it alive, with no authorisation at all
    f.env.set_auths(&[]);
    f.escrow.extend_deposit_ttl(&id);
    assert_eq!(f.deposit_ttl(&id), f.max_ttl());

    // Walk well past the ORIGINAL expiry: the deposit is still releasable
    f.env.ledger().set_sequence_number(SEQ0 + max + 10);
    f.env.mock_all_auths();
    let w = f.release_witness(&input, fee);
    f.escrow.release(&w, &f.release_sig(&w, &f.releaser));
    assert_eq!(f.bal(&f.settler), input.reserve_witness.source_amount - fee);
}

#[test]
fn without_a_keepalive_the_entry_runs_out_of_ttl_at_a_known_ledger() {
    // The host-native environment does NOT enforce archival: it silently restores an expired
    // persistent entry with the minimum persistent TTL (`Storage::handle_maybe_expired_entry`
    // in soroban-env-host). So "release fails once archived" cannot be asserted here. What can be
    // pinned is the accounting the policy relies on: the entry's last readable ledger is
    // `deposit ledger + max TTL`, and it is only moved by a touch. Enforcement is a testnet check
    // (see docs/DECISIONS.md, TTL policy).
    let f = Fx::new();
    let (_, id) = f.deposit(&f.params());
    let max = f.deposit_ttl(&id);
    let last_readable = SEQ0 + max;

    f.env.ledger().set_sequence_number(last_readable);
    assert_eq!(f.deposit_ttl(&id), 0);

    // One ledger later the host reports the lapse as an auto-restore at the minimum TTL, which on
    // a network would have been an archived entry needing RestoreFootprint
    f.env.ledger().set_sequence_number(last_readable + 1);
    let min = f.env.ledger().get().min_persistent_entry_ttl;
    assert!(f.escrow.get_deposit_hash(&id).is_some());
    assert_eq!(f.deposit_ttl(&id), min - 1);
    assert!(min < max);
}

#[test]
fn touching_entries_after_the_bump_window_extends_them_again() {
    let f = Fx::new();
    f.deposit(&f.params());
    let max = f.max_ttl();
    // Close enough to expiry that the threshold is crossed
    f.env
        .ledger()
        .set_sequence_number(SEQ0 + max - BUMP_WINDOW + 5);
    f.approve(&f.depositor, &f.token, 100_000 * USDC); // the old allowance has lapsed by now
    let mut p = f.params();
    p.nonce = 8; // same nonce word as 7
    p.quote = 0x34;
    let (_, id) = f.deposit(&p);
    let new_max = f.max_ttl();
    // The nonce word is the one entry a deposit does not extend
    assert!(f.ttl(&DataKey::Nonce(f.depositor.clone(), f.token.clone(), 0)) < new_max);
    assert_eq!(
        f.ttl(&DataKey::TokenConfig(f.token.clone())),
        new_max,
        "an entry that a deposit reads is kept alive by it"
    );
    assert_eq!(f.deposit_ttl(&id), new_max);
}

/// Walks to where every entry written at the start has crossed the bump window, checks `key` is
/// below the maximum, runs `call`, and checks `key` is back at the maximum.
fn extends_after_the_window(f: &Fx, key: &DataKey, call: impl FnOnce()) {
    let max = f.max_ttl();
    f.env
        .ledger()
        .set_sequence_number(SEQ0 + max - BUMP_WINDOW + 5);
    assert!(f.ttl(key) < max);
    call();
    assert_eq!(f.ttl(key), f.max_ttl());
}

// Each state-changing path that reads an entry and writes it back extends it once, at the write:
// the read does not extend it as well, and the final TTL is the maximum either way.

#[test]
fn release_and_withdraw_leave_the_fee_revenue_entry_at_the_maximum_ttl() {
    let f = Fx::new();
    let fee = f.fee_for(f.params().source_amount);
    let (i1, _) = f.deposit(&f.params());
    let mut p = f.params();
    p.nonce = 8;
    p.quote = 0x34;
    let (i2, _) = f.deposit(&p);
    let w = f.release_witness(&i1, fee);
    f.escrow.release(&w, &f.release_sig(&w, &f.releaser));
    let key = DataKey::FeeRevenue(f.token.clone());
    extends_after_the_window(&f, &key, || {
        let w = f.release_witness(&i2, fee);
        f.escrow.release(&w, &f.release_sig(&w, &f.releaser));
    });

    let f = Fx::new();
    let fee = f.fee_for(f.params().source_amount);
    let (i1, _) = f.deposit(&f.params());
    let w = f.release_witness(&i1, fee);
    f.escrow.release(&w, &f.release_sig(&w, &f.releaser));
    extends_after_the_window(&f, &key, || {
        let to = Address::generate(&f.env);
        f.escrow.withdraw_fee_revenue(&f.treasurer, &f.token, &to);
    });
}

#[test]
fn renounce_and_create_delegate_leave_their_entries_at_the_maximum_ttl() {
    let f = Fx::new();
    let record = DataKey::Delegate(f.depositor.clone(), f.token.clone());
    extends_after_the_window(&f, &record, || {
        f.escrow.renounce_delegate(
            &f.depositor,
            &f.token,
            &5_000,
            &RENOUNCE_DEADLINE,
            &renounce_sig(&f, 1, 5_000, &f.delegate),
        );
    });

    let f = Fx::new();
    f.escrow.revoke_delegate(&f.depositor, &f.token);
    let epoch = DataKey::DelegateEpoch(f.depositor.clone(), f.token.clone());
    extends_after_the_window(&f, &epoch, || f.create_delegate(&f.depositor, &f.token));
}

#[test]
fn the_token_config_paths_leave_their_entries_at_the_maximum_ttl() {
    let config = |f: &Fx| DataKey::TokenConfig(f.token.clone());

    let f = Fx::new();
    extends_after_the_window(&f, &config(&f), || {
        f.escrow
            .set_token_fee_config(&f.token_cfg, &f.token, &30_000, &100_000, &250_000_000);
    });

    let f = Fx::new();
    extends_after_the_window(&f, &config(&f), || {
        f.escrow.clear_token_fee_config(&f.token_cfg, &f.token);
    });

    // allow_token reads the list and writes it back
    let f = Fx::new();
    let other = f
        .env
        .register_stellar_asset_contract_v2(Address::generate(&f.env))
        .address();
    extends_after_the_window(&f, &DataKey::AllowedTokens, || {
        f.escrow.allow_token(&f.token_cfg, &other, &7);
    });

    // So does disallow_token
    let f = Fx::new();
    extends_after_the_window(&f, &DataKey::AllowedTokens, || {
        f.escrow.disallow_token(&f.token_cfg, &f.token);
    });
}

/// The redundant `extend_ttl` a read-then-write path used to pay is a host call of a few thousand
/// instructions. The ceilings sit above what each call costs now and below what it cost with the
/// extra call (the host-native budget is deterministic but not the wasm budget; re-base the numbers
/// when the SDK moves, they are a guard and not a measurement of the network).
#[test]
fn read_then_write_paths_extend_an_existing_entry_once() {
    let f = Fx::new();
    let cpu = |f: &Fx| f.env.cost_estimate().budget().cpu_instruction_cost();
    let fee = f.fee_for(f.params().source_amount);
    let sink = Address::generate(&f.env);

    let (i1, _) = f.deposit(&f.params());
    let mut p = f.params();
    p.nonce = 8; // the word of nonce 7 exists, and so does the delegate record
    p.quote = 0x34;
    let (i2, _) = f.deposit(&p);
    assert!(cpu(&f) < 1_790_000, "deposit: {}", cpu(&f));

    let w = f.release_witness(&i1, fee);
    f.escrow.release(&w, &f.release_sig(&w, &f.releaser));
    let w = f.release_witness(&i2, fee);
    f.escrow.release(&w, &f.release_sig(&w, &f.releaser));
    assert!(cpu(&f) < 892_000, "release: {}", cpu(&f));

    f.escrow.withdraw_fee_revenue(&f.treasurer, &f.token, &sink);
    assert!(cpu(&f) < 385_000, "withdraw: {}", cpu(&f));

    f.escrow.renounce_delegate(
        &f.depositor,
        &f.token,
        &5_001,
        &RENOUNCE_DEADLINE,
        &renounce_sig(&f, 1, 5_001, &f.delegate),
    );
    assert!(cpu(&f) < 640_000, "renounce: {}", cpu(&f));

    f.escrow.revoke_delegate(&f.depositor, &f.token);
    f.create_delegate(&f.depositor, &f.token);
    assert!(cpu(&f) < 226_000, "create_delegate: {}", cpu(&f));

    f.escrow
        .set_token_fee_config(&f.token_cfg, &f.token, &20_000, &100_000, &250_000_000);
    assert!(cpu(&f) < 177_000, "set_token_fee_config: {}", cpu(&f));

    f.escrow.clear_token_fee_config(&f.token_cfg, &f.token);
    assert!(cpu(&f) < 176_000, "clear_token_fee_config: {}", cpu(&f));

    let other = f
        .env
        .register_stellar_asset_contract_v2(Address::generate(&f.env))
        .address();
    f.escrow.allow_token(&f.token_cfg, &other, &7);
    assert!(cpu(&f) < 280_000, "allow_token: {}", cpu(&f));

    f.escrow.disallow_token(&f.token_cfg, &other);
    assert!(cpu(&f) < 198_000, "disallow_token: {}", cpu(&f));
}

#[test]
fn an_idle_role_and_the_allowed_token_list_are_extended_when_read() {
    let f = Fx::new();
    let max = f.max_ttl();
    let role = DataKey::Role(Role::Pauser, f.pauser.clone());
    // Both were last written at SEQ0; walk to where the bump window has been crossed
    f.env
        .ledger()
        .set_sequence_number(SEQ0 + max - BUMP_WINDOW + 5);
    assert!(f.ttl(&role) < max);
    assert!(f.ttl(&DataKey::AllowedTokens) < max);

    // A state-changing call that only reads the role extends it
    f.escrow.pause(&f.pauser);
    assert_eq!(f.ttl(&role), f.max_ttl());

    // Reading the list (a view; the SDK allows extending from one) extends it too
    assert_eq!(f.escrow.get_allowed_tokens().len(), 1);
    assert_eq!(f.ttl(&DataKey::AllowedTokens), f.max_ttl());
}

#[test]
fn entries_are_not_re_extended_inside_the_window() {
    let f = Fx::new();
    let (_, id) = f.deposit(&f.params());
    let before = f.deposit_ttl(&id);
    f.env.ledger().set_sequence_number(SEQ0 + 10);
    f.escrow.extend_deposit_ttl(&id);
    // Still the same absolute expiry: TTL shrank by the 10 ledgers that passed
    assert_eq!(f.deposit_ttl(&id), before - 10);
}

#[test]
fn keepalive_for_a_missing_deposit_is_refused() {
    let f = Fx::new();
    assert_eq!(
        f.escrow.try_extend_deposit_ttl(&f.b32(0x01)),
        Err(Ok(Error::DepositNotFound))
    );
}

// ------------------------------------------------------------------ delegate

fn delegate_of(f: &Fx) -> Delegate {
    f.escrow.get_delegate(&f.depositor, &f.token).unwrap()
}

#[test]
fn a_delegate_deposit_consumes_the_cap_by_the_charged_amount() {
    let f = Fx::new();
    let p = f.params();
    f.deposit(&p);
    assert_eq!(
        delegate_of(&f).remaining_capacity,
        100_000 * USDC - p.source_amount
    );
    // The allowance was spent too
    let left = TokenClient::new(&f.env, &f.token).allowance(&f.depositor, &f.escrow.address);
    assert_eq!(left, 100_000 * USDC - p.source_amount);
}

#[test]
fn the_deposit_must_be_signed_by_the_delegate_signer() {
    let f = Fx::new();
    let imposter = SigningKey::from_bytes(&[0x98; 32]);
    let input = f.build_signed_by(&f.params(), &f.reserver, &imposter);
    let r = f.escrow.try_deposit(&input);
    assert!(is_trap(&r), "{r:?}");
    assert_eq!(f.bal(&f.escrow.address), 0);
    // The reserver's key is not the delegate's either
    let input = f.build_signed_by(&f.params(), &f.reserver, &f.reserver);
    assert!(is_trap(&f.escrow.try_deposit(&input)));
}

#[test]
fn the_delegate_signature_binds_the_whole_deposit() {
    let f = Fx::new();
    // Each change keeps the reserver's signature valid by re-deriving the id, so only the delegate
    // signature (over the OLD id) can refuse it
    let p = f.params();
    let good = f.build(&p);
    for (name, mutate) in [
        (
            "amount",
            (|p: &mut Params| p.amount += 1) as fn(&mut Params),
        ),
        ("nonce", |p| p.nonce += 1),
        ("deadline", |p| p.deadline += 1),
        ("destination", |p| p.destination = "other"),
    ] {
        let mut p2 = p.clone();
        mutate(&mut p2);
        let mut input = f.build(&p2);
        input.delegate_signature = good.delegate_signature.clone();
        assert!(is_trap(&f.escrow.try_deposit(&input)), "{name}");
    }
}

#[test]
fn an_expired_delegate_is_refused() {
    let f = Fx::new();
    let mut p = f.params();
    let exp = delegate_of(&f).expiration;
    f.env.ledger().set_timestamp(exp);
    p.issued_at = exp;
    p.deadline = exp + 100;
    assert_eq!(
        f.escrow.try_deposit(&f.build(&p)),
        Err(Ok(Error::DelegateExpired))
    );
    f.env.ledger().set_timestamp(exp - 1);
    p.issued_at = exp - 1;
    p.deadline = exp + 100;
    f.deposit(&p);
}

#[test]
fn a_revoked_or_missing_delegate_is_refused() {
    let f = Fx::new();
    f.escrow.revoke_delegate(&f.depositor, &f.token);
    assert!(f.escrow.get_delegate(&f.depositor, &f.token).is_none());
    assert_eq!(
        f.escrow.try_deposit(&f.build(&f.params())),
        Err(Ok(Error::DelegateNotFound))
    );
    assert_eq!(
        f.escrow.try_revoke_delegate(&f.depositor, &f.token),
        Err(Ok(Error::DelegateNotFound))
    );
    // A fresh record can be created after a revoke
    f.escrow.create_delegate(
        &f.depositor,
        &f.token,
        &pubkey(&f.env, &f.delegate),
        &(10 * USDC),
        &(10 * USDC),
        &(T0 + DAY),
    );
}

#[test]
fn revoke_requires_the_depositor() {
    let f = Fx::new();
    f.env.set_auths(&[]);
    assert!(f
        .escrow
        .try_revoke_delegate(&f.depositor, &f.token)
        .is_err());
    assert!(f.escrow.get_delegate(&f.depositor, &f.token).is_some());
}

#[test]
fn caps_are_enforced_on_the_charged_amount() {
    let f = Fx::new();
    // Per-transfer max is 5_000 USDC
    let mut p = f.params();
    p.amount = 6_000 * USDC;
    p.source_amount = 5_001 * USDC;
    assert_eq!(
        f.escrow.try_deposit(&f.build(&p)),
        Err(Ok(Error::DelegateOverTransferMax))
    );
    // A ceiling above the max is fine while the charge is under it
    p.source_amount = 5_000 * USDC;
    p.nonce = 2;
    f.deposit(&p);

    // Total cap: 100_000 - 5_000 used; 19 more at 5_000 would pass 95_000 remaining
    for n in 0..19 {
        let mut q = f.params();
        q.amount = 5_000 * USDC;
        q.source_amount = 5_000 * USDC;
        q.nonce = 100 + n;
        q.quote = 0x40 + n as u8;
        f.deposit(&q);
    }
    assert_eq!(delegate_of(&f).remaining_capacity, 0);
    let mut q = f.params();
    q.nonce = 500;
    assert_eq!(
        f.escrow.try_deposit(&f.build(&q)),
        Err(Ok(Error::DelegateOverCapacity))
    );
}

#[test]
fn a_missing_or_short_allowance_reverts_the_deposit() {
    let f = Fx::new();
    let other = Address::generate(&f.env);
    StellarAssetClient::new(&f.env, &f.token).mint(&other, &(10_000 * USDC));
    // Delegate but no allowance
    f.escrow.create_delegate(
        &other,
        &f.token,
        &pubkey(&f.env, &f.delegate),
        &(100_000 * USDC),
        &(5_000 * USDC),
        &(T0 + DAY),
    );
    let mut p = f.params();
    p.depositor = other.clone();
    let r = f.escrow.try_deposit(&f.build(&p));
    assert!(r.is_err(), "{r:?}");

    // Allowance smaller than the charge
    f.approve(&other, &f.token, p.source_amount - 1);
    assert!(f.escrow.try_deposit(&f.build(&p)).is_err());
    // The failed attempts consumed neither cap nor nonce
    assert_eq!(
        f.escrow
            .get_delegate(&other, &f.token)
            .unwrap()
            .remaining_capacity,
        100_000 * USDC
    );
    f.approve(&other, &f.token, p.source_amount);
    f.deposit(&p);
}

#[test]
fn a_lapsed_allowance_reverts_the_deposit() {
    let f = Fx::new();
    f.env.ledger().set_sequence_number(SEQ0 + 1_000_001);
    assert!(f.escrow.try_deposit(&f.build(&f.params())).is_err());
}

#[test]
fn delegate_creation_validation() {
    let f = Fx::new();
    let other = Address::generate(&f.env);
    let key = pubkey(&f.env, &f.delegate);
    let create = |cap: i128, max: i128, exp: u64, signer: &BytesN<32>| {
        f.escrow
            .try_create_delegate(&other, &f.token, signer, &cap, &max, &exp)
    };
    assert_eq!(
        create(0, 0, T0 + DAY, &key),
        Err(Ok(Error::DelegateLimitsInvalid))
    );
    assert_eq!(
        create(10, 0, T0 + DAY, &key),
        Err(Ok(Error::DelegateLimitsInvalid))
    );
    assert_eq!(
        create(10, 11, T0 + DAY, &key),
        Err(Ok(Error::DelegateLimitsInvalid))
    );
    assert_eq!(create(10, 10, T0, &key), Err(Ok(Error::InvalidExpiration)));
    assert_eq!(
        create(10, 10, T0 + DAY, &f.b32(0)),
        Err(Ok(Error::InvalidDelegateSigner))
    );
    // Existing record for the pair
    assert_eq!(
        f.escrow
            .try_create_delegate(&f.depositor, &f.token, &key, &10, &10, &(T0 + DAY)),
        Err(Ok(Error::DelegateAlreadyExists))
    );
    // A token that is not allowlisted
    let t2 = f
        .env
        .register_stellar_asset_contract_v2(Address::generate(&f.env))
        .address();
    assert_eq!(
        f.escrow
            .try_create_delegate(&other, &t2, &key, &10, &10, &(T0 + DAY)),
        Err(Ok(Error::TokenNotAllowed))
    );
    // Paused: creation is blocked, revocation is not
    f.escrow.pause(&f.pauser);
    assert_eq!(create(10, 10, T0 + DAY, &key), Err(Ok(Error::Paused)));
    f.escrow.revoke_delegate(&f.depositor, &f.token);
}

#[test]
fn creating_a_delegate_requires_the_depositor() {
    let f = Fx::new();
    let other = Address::generate(&f.env);
    f.env.set_auths(&[]);
    let r = f.escrow.try_create_delegate(
        &other,
        &f.token,
        &pubkey(&f.env, &f.delegate),
        &10,
        &10,
        &(T0 + DAY),
    );
    assert!(r.is_err(), "{r:?}");
}

/// A renounce is signed to be submitted within a day, which is what these tests default to.
const RENOUNCE_DEADLINE: u64 = T0 + DAY;

fn renounce_sig(f: &Fx, epoch: u64, nonce: u64, signer: &SigningKey) -> BytesN<64> {
    renounce_sig_until(f, epoch, nonce, RENOUNCE_DEADLINE, signer)
}

fn renounce_sig_until(
    f: &Fx,
    epoch: u64,
    nonce: u64,
    deadline: u64,
    signer: &SigningKey,
) -> BytesN<64> {
    let digest = signatures::compute_renounce_hash(
        &f.env,
        &f.domain(),
        &f.depositor,
        &f.token,
        epoch,
        nonce,
        deadline,
    );
    sign(&f.env, signer, &digest)
}

#[test]
fn the_delegate_signer_can_renounce() {
    let f = Fx::new();
    // A signature by anyone else is refused
    let r = f.escrow.try_renounce_delegate(
        &f.depositor,
        &f.token,
        &900,
        &RENOUNCE_DEADLINE,
        &renounce_sig(&f, 1, 900, &f.reserver),
    );
    assert!(is_trap(&r), "{r:?}");

    let sig = renounce_sig(&f, 1, 900, &f.delegate);
    f.env.ledger().set_timestamp(T0 + 5);
    f.escrow
        .renounce_delegate(&f.depositor, &f.token, &900, &RENOUNCE_DEADLINE, &sig);
    let d = delegate_of(&f);
    assert_eq!(d.remaining_capacity, 0);
    assert_eq!(d.expiration, T0 + 5);

    // Deposits now fail, and the signature cannot be replayed
    let mut p = f.params();
    p.issued_at = T0 + 5;
    p.deadline = T0 + 100;
    assert_eq!(
        f.escrow.try_deposit(&f.build(&p)),
        Err(Ok(Error::DelegateExpired))
    );
    assert_eq!(
        f.escrow
            .try_renounce_delegate(&f.depositor, &f.token, &900, &RENOUNCE_DEADLINE, &sig),
        Err(Ok(Error::NonceAlreadyUsed))
    );

    assert_eq!(delegate_of(&f).epoch, 1);
}

#[test]
fn a_signed_renounce_is_refused_after_its_deadline() {
    let f = Fx::new();
    let deadline = T0 + 100;
    let sig = renounce_sig_until(&f, 1, 900, deadline, &f.delegate);

    // One second late: refused with the same error a late deposit gets, and nothing changed
    f.env.ledger().set_timestamp(deadline + 1);
    assert_eq!(
        f.escrow
            .try_renounce_delegate(&f.depositor, &f.token, &900, &deadline, &sig),
        Err(Ok(Error::DeadlineExpired))
    );
    assert!(delegate_of(&f).remaining_capacity > 0);

    // A year later too: this is the signature that used to stay executable indefinitely
    f.env.ledger().set_timestamp(T0 + 365 * DAY);
    assert_eq!(
        f.escrow
            .try_renounce_delegate(&f.depositor, &f.token, &900, &deadline, &sig),
        Err(Ok(Error::DeadlineExpired))
    );
    assert!(delegate_of(&f).remaining_capacity > 0);

    // The deadline second itself is still valid, and the refused attempts did not spend the nonce
    f.env.ledger().set_timestamp(deadline);
    f.escrow
        .renounce_delegate(&f.depositor, &f.token, &900, &deadline, &sig);
    assert_eq!(delegate_of(&f).remaining_capacity, 0);
}

#[test]
fn a_renounce_signature_commits_to_its_deadline() {
    let f = Fx::new();
    let deadline = T0 + 100;
    let sig = renounce_sig_until(&f, 1, 900, deadline, &f.delegate);

    // Neither a later deadline (to keep a lapsed signature alive) nor an earlier one verifies
    for other in [deadline + 1, deadline - 1, u64::MAX] {
        let r = f
            .escrow
            .try_renounce_delegate(&f.depositor, &f.token, &900, &other, &sig);
        assert!(is_trap(&r), "{other}: {r:?}");
    }
    assert!(delegate_of(&f).remaining_capacity > 0);
    f.escrow
        .renounce_delegate(&f.depositor, &f.token, &900, &deadline, &sig);
}

#[test]
fn a_replayed_deposit_input_is_refused_by_the_nonce() {
    let f = Fx::new();
    let (input, _) = f.deposit(&f.params());
    assert_eq!(
        f.escrow.try_deposit(&input),
        Err(Ok(Error::NonceAlreadyUsed))
    );
}

#[test]
fn a_renounce_signed_for_one_record_cannot_kill_the_next() {
    let f = Fx::new();
    assert_eq!(delegate_of(&f).epoch, 1);
    // The signer signs a renounce under epoch 1 and never submits it
    let old = renounce_sig(&f, 1, 901, &f.delegate);

    // The depositor revokes and re-enrols the SAME signer key: epoch 2, the counter survived the revoke
    f.escrow.revoke_delegate(&f.depositor, &f.token);
    f.create_delegate(&f.depositor, &f.token);
    assert_eq!(delegate_of(&f).epoch, 2);

    // The nonce is unspent, so only the epoch stands in the way: the host rejects the signature
    let r = f
        .escrow
        .try_renounce_delegate(&f.depositor, &f.token, &901, &RENOUNCE_DEADLINE, &old);
    assert!(is_trap(&r), "{r:?}");
    assert!(delegate_of(&f).remaining_capacity > 0);

    // The epoch-2 signature works
    let new = renounce_sig(&f, 2, 902, &f.delegate);
    f.escrow
        .renounce_delegate(&f.depositor, &f.token, &902, &RENOUNCE_DEADLINE, &new);
    assert_eq!(delegate_of(&f).remaining_capacity, 0);
}

#[test]
fn a_deposit_signed_under_a_revoked_record_is_dead_after_the_same_signer_is_enrolled_again() {
    let f = Fx::new();
    let p = f.params();
    assert_eq!(p.epoch, 1);
    // Signed (delegate and reserver) under epoch 1 and never submitted
    let old = f.build(&p);

    // The depositor revokes and re-enrols the SAME signer key: epoch 2, same limits, same allowance
    f.escrow.revoke_delegate(&f.depositor, &f.token);
    f.create_delegate(&f.depositor, &f.token);
    assert_eq!(delegate_of(&f).epoch, 2);

    // Submitted as signed: the id it names is the epoch-1 id, not what the contract now derives
    assert_eq!(
        f.escrow.try_deposit(&old),
        Err(Ok(Error::DepositIdMismatch))
    );

    // Pointed at the epoch-2 id, the epoch-1 delegate signature (over the old id) no longer verifies
    let mut q = p.clone();
    q.epoch = 2;
    let mut forged = old.clone();
    forged.reserve_witness.deposit_id = f.deposit_id(&f.domain(), &q);
    assert!(is_trap(&f.escrow.try_deposit(&forged)));

    // Nothing was charged, nothing recorded, and the nonce is still unspent
    assert_eq!(delegate_of(&f).remaining_capacity, 100_000 * USDC);
    assert!(f
        .escrow
        .get_deposit_hash(&old.reserve_witness.deposit_id)
        .is_none());
}

#[test]
fn a_deposit_signed_at_the_new_epoch_succeeds_after_re_enrolment() {
    let f = Fx::new();
    f.escrow.revoke_delegate(&f.depositor, &f.token);
    f.create_delegate(&f.depositor, &f.token);
    let p = f.params();
    assert_eq!(p.epoch, 2);
    let (input, id) = f.deposit(&p);
    assert_eq!(input.reserve_witness.deposit_id, id);
    assert!(f.escrow.get_deposit_hash(&id).is_some());
    assert_eq!(
        delegate_of(&f).remaining_capacity,
        100_000 * USDC - p.source_amount
    );
}

#[test]
fn a_delegate_signature_is_not_reusable_across_depositors_or_tokens() {
    let f = Fx::new();
    let p = f.params();
    let good = f.build(&p);

    // Another depositor with the same signer enrolled, same everything else: different id
    let other = Address::generate(&f.env);
    StellarAssetClient::new(&f.env, &f.token).mint(&other, &(10_000 * USDC));
    f.enroll(&other, &f.token);
    let mut p2 = p.clone();
    p2.depositor = other;
    let mut input = f.build(&p2);
    input.delegate_signature = good.delegate_signature.clone();
    assert!(is_trap(&f.escrow.try_deposit(&input)));

    // Another allowed token, same signer enrolled for it
    let t2 = f
        .env
        .register_stellar_asset_contract_v2(Address::generate(&f.env))
        .address();
    f.escrow
        .allow_token_and_set_fee_config(&f.token_cfg, &t2, &7, &20_000, &100_000, &250_000_000);
    StellarAssetClient::new(&f.env, &t2).mint(&f.depositor, &(10_000 * USDC));
    f.enroll(&f.depositor, &t2);
    let mut p3 = p;
    p3.token = t2;
    let mut input = f.build(&p3);
    input.delegate_signature = good.delegate_signature.clone();
    assert!(is_trap(&f.escrow.try_deposit(&input)));
    // Sanity: each is accepted with its own signature
    f.escrow.deposit(&f.build(&p3));
}

#[test]
fn the_delegate_signature_binds_reserver_releaser_issued_at_and_request_hash() {
    let f = Fx::new();
    let p = f.params();
    let good = f.build(&p);
    let reserver = pubkey(&f.env, &f.reserver);
    let releaser = pubkey(&f.env, &f.releaser);
    let other = pubkey(&f.env, &SigningKey::from_bytes(&[0x42; 32]));
    let dest = String::from_str(&f.env, p.destination);
    let dest_hash = signatures::destination_hash(&f.env, &dest);

    // Re-derive the id from one changed member, re-sign the reserve digest so that signature stays
    // valid, and attach the ORIGINAL delegate signature: only the delegate signature can refuse it.
    let id_with = |res: &BytesN<32>, rel: &BytesN<32>, issued: u64, drh: &BytesN<32>| {
        signatures::compute_deposit_hash(
            &f.env,
            &f.domain(),
            drh,
            &dest_hash,
            &p.depositor,
            &p.token,
            p.epoch,
            p.amount,
            res,
            rel,
            p.nonce,
            issued,
            p.deadline,
        )
    };
    let variants = [
        (
            "reserver",
            id_with(&other, &releaser, p.issued_at, &f.b32(0x44)),
            Some(other.clone()),
            None,
            p.issued_at,
            f.b32(0x44),
        ),
        (
            "releaser",
            id_with(&reserver, &other, p.issued_at, &f.b32(0x44)),
            None,
            Some(other.clone()),
            p.issued_at,
            f.b32(0x44),
        ),
        (
            "issued_at",
            id_with(&reserver, &releaser, p.issued_at - 1, &f.b32(0x44)),
            None,
            None,
            p.issued_at - 1,
            f.b32(0x44),
        ),
        (
            "request hash",
            id_with(&reserver, &releaser, p.issued_at, &f.b32(0x45)),
            None,
            None,
            p.issued_at,
            f.b32(0x45),
        ),
    ];
    for (name, id, res, rel, issued, drh) in variants {
        let mut input = good.clone();
        if let Some(r) = res {
            input.deposit_witness.reserver = r;
        }
        if let Some(r) = rel {
            input.deposit_witness.releaser = r;
        }
        input.issued_at = issued;
        input.deposit_witness.deposit_request_hash = drh;
        input.reserve_witness.deposit_id = id.clone();
        // Reserver key is the one the contract will check: sign with whichever key is now stored
        let rkey = if name == "reserver" {
            SigningKey::from_bytes(&[0x42; 32])
        } else {
            f.reserver.clone()
        };
        let digest = signatures::compute_reserve_hash(
            &f.env,
            &f.domain(),
            &id,
            &input.reserve_witness.quote_hash,
            &input.reserve_witness.settler,
            input.reserve_witness.source_amount,
        );
        input.reserve_signature = sign(&f.env, &rkey, &digest);
        // Everything else is consistent, so a trap here is the delegate signature (over the old id)
        assert!(is_trap(&f.escrow.try_deposit(&input)), "{name}");
    }
    f.escrow.deposit(&good);
}

// ------------------------------------------------------------ admin delay

const FIVE_DAYS: u64 = 5 * DAY;

fn escrow_events(f: &Fx) -> soroban_sdk::testutils::ContractEvents {
    f.env.events().all().filter_by_contract(&f.escrow.address)
}

fn pending_delay(f: &Fx) -> Option<(u32, u64)> {
    f.escrow
        .pending_default_admin_delay()
        .map(|p| (p.new_delay, p.effective_at))
}

/// Brings the in-force delay to `secs` (the fixture starts at 1) and leaves the clock just past the
/// change, so the tests below schedule from a known delay. Returns the new ledger time.
fn settle_delay_at(f: &Fx, secs: u32) -> u64 {
    f.escrow.change_default_admin_delay(&secs);
    let now = T0 + secs as u64 + 1;
    f.env.ledger().set_timestamp(now);
    assert_eq!(f.escrow.default_admin_delay(), secs);
    assert!(f.escrow.pending_default_admin_delay().is_none());
    now
}

#[test]
fn delay_increase_waits_min_of_new_delay_and_five_days() {
    let f = Fx::new();
    // Small increase: waits the new delay itself.
    f.escrow.change_default_admin_delay(&500);
    assert_eq!(
        escrow_events(&f),
        [events::AdminDelayChangeScheduled {
            new_delay: 500,
            effective_at: T0 + 500
        }
        .to_xdr(&f.env, &f.escrow.address)]
    );
    assert_eq!(pending_delay(&f), Some((500, T0 + 500)));
    // Large increase: capped at five days; it replaces the pending change.
    f.escrow.change_default_admin_delay(&(FIVE_DAYS as u32 * 3));
    assert_eq!(
        pending_delay(&f),
        Some((FIVE_DAYS as u32 * 3, T0 + FIVE_DAYS))
    );
}

#[test]
fn delay_decrease_waits_the_difference() {
    let f = Fx::new();
    let now = settle_delay_at(&f, 100);
    f.escrow.change_default_admin_delay(&40);
    assert_eq!(pending_delay(&f), Some((40, now + 60)));
    // Until then the old delay governs.
    f.env.ledger().set_timestamp(now + 60);
    assert_eq!(f.escrow.default_admin_delay(), 100);
    f.env.ledger().set_timestamp(now + 61);
    assert_eq!(f.escrow.default_admin_delay(), 40);
    // Decrease to zero waits the whole current delay.
    f.escrow.change_default_admin_delay(&0);
    assert_eq!(pending_delay(&f), Some((0, now + 61 + 40)));
}

#[test]
fn scheduled_delay_is_not_effective_early_and_applies_lazily() {
    let f = Fx::new();
    f.escrow.change_default_admin_delay(&500);
    // At and before the effective time the old delay governs (strictly after).
    f.env.ledger().set_timestamp(T0 + 500);
    assert_eq!(f.escrow.default_admin_delay(), 1);
    assert_eq!(pending_delay(&f), Some((500, T0 + 500)));
    f.escrow
        .begin_default_admin_transfer(&Address::generate(&f.env));
    assert_eq!(
        f.escrow.pending_default_admin().unwrap().accept_after,
        T0 + 500 + 1
    );
    // After it, the new delay is in force with no transaction needed, and governs new transfers.
    f.env.ledger().set_timestamp(T0 + 501);
    assert_eq!(f.escrow.default_admin_delay(), 500);
    assert_eq!(pending_delay(&f), None);
    f.escrow
        .begin_default_admin_transfer(&Address::generate(&f.env));
    assert_eq!(
        f.escrow.pending_default_admin().unwrap().accept_after,
        T0 + 501 + 500
    );
}

#[test]
fn delay_change_rollback_cancels_the_schedule_and_emits_the_event() {
    let f = Fx::new();
    f.escrow.change_default_admin_delay(&500);
    let _ = escrow_events(&f);
    f.escrow.rollback_default_admin_delay();
    assert_eq!(
        escrow_events(&f),
        [events::AdminDelayChangeCanceled {
            admin: f.admin.clone()
        }
        .to_xdr(&f.env, &f.escrow.address)]
    );
    assert_eq!(pending_delay(&f), None);
    f.env.ledger().set_timestamp(T0 + 10_000);
    assert_eq!(f.escrow.default_admin_delay(), 1);
    // An already-elapsed change cannot be rolled back.
    f.escrow.change_default_admin_delay(&500);
    f.env.ledger().set_timestamp(T0 + 20_000);
    assert_eq!(
        f.escrow.try_rollback_default_admin_delay(),
        Err(Ok(Error::NoPendingDelayChange))
    );
    assert_eq!(f.escrow.default_admin_delay(), 500);
}

#[test]
fn admin_transfer_events_carry_the_new_admin_topic_and_the_cancelling_admin() {
    let f = Fx::new();
    let new_admin = Address::generate(&f.env);
    f.escrow.begin_default_admin_transfer(&new_admin);
    assert_eq!(
        escrow_events(&f),
        [events::DefaultAdminTransferScheduled {
            new_admin: new_admin.clone(),
            accept_after: T0 + 1
        }
        .to_xdr(&f.env, &f.escrow.address)]
    );
    f.escrow.cancel_default_admin_transfer();
    assert_eq!(
        escrow_events(&f),
        [events::DefaultAdminTransferCanceled {
            admin: f.admin.clone()
        }
        .to_xdr(&f.env, &f.escrow.address)]
    );
}

#[test]
fn compromised_admin_cannot_zero_the_delay_and_transfer_in_one_ledger() {
    let f = Fx::new();
    let now = settle_delay_at(&f, 100);
    f.escrow.change_default_admin_delay(&0);
    f.escrow
        .begin_default_admin_transfer(&Address::generate(&f.env));
    // The old delay still governs the transfer, so it is not acceptable yet, even a ledger later.
    assert_eq!(
        f.escrow.pending_default_admin().unwrap().accept_after,
        now + 100
    );
    assert_eq!(
        f.escrow.try_accept_default_admin_transfer(),
        Err(Ok(Error::AdminTransferNotReady))
    );
    f.env.ledger().set_timestamp(now + 1);
    assert_eq!(
        f.escrow.try_accept_default_admin_transfer(),
        Err(Ok(Error::AdminTransferNotReady))
    );
}

#[test]
fn delay_change_overflow_is_an_error() {
    let f = Fx::new();
    f.env.ledger().set_timestamp(u64::MAX);
    assert_eq!(
        f.escrow.try_change_default_admin_delay(&500),
        Err(Ok(Error::TimestampOverflow))
    );
}

#[test]
fn begin_transfer_overflow_is_an_error() {
    let f = Fx::new();
    f.env.ledger().set_timestamp(u64::MAX);
    assert_eq!(
        f.escrow
            .try_begin_default_admin_transfer(&Address::generate(&f.env)),
        Err(Ok(Error::TimestampOverflow))
    );
}

// ------------------------------------------------- escrow + proxy in one Env

/// The full lifecycle across both contracts: deposit on the escrow, the settler pays the recipient
/// through the fulfillment proxy on the "destination chain" (a second token in the same Env), then
/// the releaser's signature releases the escrowed funds to the settler.
#[test]
fn deposit_fulfill_release_across_escrow_and_proxy() {
    use fulfillment_proxy::{FulfillmentProxy, FulfillmentProxyClient};
    use soroban_sdk::token::StellarAssetClient;

    let f = Fx::new();
    let proxy_id = f.env.register(
        FulfillmentProxy,
        (
            &Address::generate(&f.env),
            &Address::generate(&f.env),
            100u32,
        ),
    );
    let proxy = FulfillmentProxyClient::new(&f.env, &proxy_id);
    let dest_token = f
        .env
        .register_stellar_asset_contract_v2(Address::generate(&f.env))
        .address();
    let recipient = Address::generate(&f.env);
    let payout = 900 * USDC;
    StellarAssetClient::new(&f.env, &dest_token).mint(&f.settler, &payout);

    // 1. deposit on the escrow
    let p = f.params();
    let (input, id) = f.deposit(&p);
    let quote_hash = input.reserve_witness.quote_hash.clone();
    assert_eq!(f.bal(&f.escrow.address), p.source_amount);

    // 2. fulfil on the proxy, bound to the escrow's quote hash
    proxy.strict_fulfill(
        &f.settler,
        &quote_hash,
        &recipient,
        &dest_token,
        &payout,
        &(T0 + 60),
        &0,
    );
    assert_eq!(
        f.env
            .events()
            .all()
            .filter_by_contract(&proxy_id)
            .events()
            .len(),
        1
    );
    let dest = TokenClient::new(&f.env, &dest_token);
    assert_eq!(dest.balance(&recipient), payout);
    assert_eq!(dest.balance(&f.settler), 0);
    assert!(proxy.is_strictly_fulfilled(&quote_hash, &recipient, &dest_token, &payout));
    // Fulfilling moved nothing on the escrow
    assert_eq!(f.bal(&f.escrow.address), p.source_amount);
    assert!(f.escrow.get_deposit_hash(&id).is_some());

    // 3. release on the escrow
    let fee = f.fee_for(p.source_amount);
    let w = f.release_witness(&input, fee);
    f.escrow.release(&w, &f.release_sig(&w, &f.releaser));
    assert_eq!(f.bal(&f.settler), p.source_amount - fee);
    assert_eq!(f.bal(&f.escrow.address), fee);
    assert_eq!(f.escrow.get_deposit_hash(&id), None);
}

#[test]
fn a_token_that_does_not_answer_decimals_is_refused() {
    let f = Fx::new();
    // A contract with no `decimals` entry point stands in for a token that does not answer: it is
    // either not deployed yet or not a token, so the stated value cannot be checked and is refused.
    let silent = f.env.register(Escrow, (&f.admin, 1u32));
    assert_eq!(
        f.escrow.try_allow_token(&f.token_cfg, &silent, &9),
        Err(Ok(Error::TokenDecimalsMismatch))
    );
    assert_eq!(
        f.escrow.try_allow_token_and_set_fee_config(
            &f.token_cfg,
            &silent,
            &9,
            &20_000,
            &100_000,
            &250_000_000
        ),
        Err(Ok(Error::TokenDecimalsMismatch))
    );
    assert_eq!(f.escrow.get_token_config(&silent), None);
    assert_eq!(f.escrow.get_allowed_tokens().len(), 1);
    // An address with no contract behind it does not answer either
    let nothing = Address::generate(&f.env);
    assert_eq!(
        f.escrow.try_allow_token(&f.token_cfg, &nothing, &7),
        Err(Ok(Error::TokenDecimalsMismatch))
    );
}

use std::rc::Rc;

use soroban_sdk::{
    xdr::{self, WriteXdr},
    Bytes,
};

/// A classic asset whose asset contract nobody has deployed yet: the deployer handle and the
/// address the contract will have.
fn undeployed_sac(f: &Fx, seed: u8) -> (soroban_sdk::deploy::DeployerWithAsset, Address) {
    let issuer = xdr::AccountId(xdr::PublicKey::PublicKeyTypeEd25519(xdr::Uint256(
        [seed; 32],
    )));
    let key = Rc::new(xdr::LedgerKey::Account(xdr::LedgerKeyAccount {
        account_id: issuer.clone(),
    }));
    let entry = Rc::new(xdr::LedgerEntry {
        data: xdr::LedgerEntryData::Account(xdr::AccountEntry {
            account_id: issuer.clone(),
            balance: 1_000_000_000_000,
            flags: 0,
            home_domain: Default::default(),
            inflation_dest: None,
            num_sub_entries: 0,
            seq_num: xdr::SequenceNumber(0),
            thresholds: xdr::Thresholds([1; 4]),
            signers: xdr::VecM::default(),
            ext: xdr::AccountEntryExt::V0,
        }),
        last_modified_ledger_seq: 0,
        ext: xdr::LedgerEntryExt::V0,
    });
    f.env.host().add_ledger_entry(&key, &entry, None).unwrap();
    let asset = xdr::Asset::CreditAlphanum4(xdr::AlphaNum4 {
        asset_code: xdr::AssetCode4(*b"USDX"),
        issuer,
    });
    let bytes = Bytes::from_slice(&f.env, &asset.to_xdr(xdr::Limits::none()).unwrap());
    let deployer = f.env.deployer().with_stellar_asset(bytes);
    let address = deployer.deployed_address();
    (deployer, address)
}

#[test]
fn an_asset_contract_is_admitted_only_after_it_is_deployed() {
    let f = Fx::new();
    // An asset whose contract nobody has deployed yet: its address is known in advance, but it does
    // not answer `decimals`, so the allowlist refuses it whatever value is stated.
    let (deployer, token) = undeployed_sac(&f, 0xb7);
    for stated in [6u32, 7] {
        assert_eq!(
            f.escrow.try_allow_token_and_set_fee_config(
                &f.token_cfg,
                &token,
                &stated,
                &20_000,
                &100_000,
                &250_000_000
            ),
            Err(Ok(Error::TokenDecimalsMismatch))
        );
    }
    assert_eq!(f.escrow.get_token_config(&token), None);

    // Once deployed it answers 7: a wrong value is refused, the right one is admitted
    assert_eq!(deployer.deploy(), token);
    assert_eq!(
        f.escrow.try_allow_token_and_set_fee_config(
            &f.token_cfg,
            &token,
            &6,
            &20_000,
            &100_000,
            &250_000_000
        ),
        Err(Ok(Error::TokenDecimalsMismatch))
    );
    f.escrow.allow_token_and_set_fee_config(
        &f.token_cfg,
        &token,
        &7,
        &20_000,
        &100_000,
        &250_000_000,
    );
    assert_eq!(f.escrow.get_token_config(&token).unwrap().token_decimals, 7);
}

#[test]
fn an_active_record_under_the_id_refuses_a_deposit_even_when_its_nonce_is_unspent() {
    let f = Fx::new();
    let p = f.params();
    let id = f.deposit_id(&f.domain(), &p);
    // The nonce bitmap and the active record cannot disagree through the public entry points: the
    // id commits to the nonce, which is spent first. Seed the record directly to prove the guard
    // holds on its own if they ever do.
    f.env.as_contract(&f.escrow.address, || {
        storage::set_persistent(&f.env, &DataKey::ActiveDeposit(id.clone()), &f.b32(0x99));
    });
    assert_eq!(
        f.escrow.try_deposit(&f.build(&p)),
        Err(Ok(Error::DepositAlreadyExists))
    );
    // The refused call spent nothing: no tokens moved, and once the stray record is gone the same
    // deposit goes through, so its nonce was not consumed by the refusal.
    assert_eq!(f.bal(&f.escrow.address), 0);
    f.env.as_contract(&f.escrow.address, || {
        f.env
            .storage()
            .persistent()
            .remove(&DataKey::ActiveDeposit(id.clone()));
    });
    assert_eq!(f.escrow.deposit(&f.build(&p)), id);
}

#[test]
fn a_state_changing_call_extends_the_code_entry_with_the_instance() {
    use soroban_sdk::testutils::Deployer as _;
    let f = Fx::new();
    // Past the bump window the next call extends both, so the code entry is rented by that caller.
    f.env
        .ledger()
        .set_sequence_number(SEQ0 + f.env.storage().max_ttl().saturating_sub(BUMP_WINDOW) + 5);
    let code_before = f.env.deployer().get_contract_code_ttl(&f.escrow.address);
    f.escrow.pause(&f.pauser);
    let code = f.env.deployer().get_contract_code_ttl(&f.escrow.address);
    let instance = f
        .env
        .deployer()
        .get_contract_instance_ttl(&f.escrow.address);
    assert!(code > code_before);
    assert_eq!(code, instance);
}

// ---- the escrow's balance entry inside the token contract ----

mod token_balance_ttl {
    use super::*;
    use soroban_sdk::{vec as svec, IntoVal, Symbol, Val, Vec as SVec};

    const DAY_IN_LEDGERS: u32 = 17_280;
    /// The Stellar Asset Contract extends a balance to 30 days once fewer than 29 remain.
    const SAC_BALANCE_EXTEND: u32 = 30 * DAY_IN_LEDGERS;

    /// The key of `holder`'s balance in a Stellar Asset Contract: persistent `Balance(holder)` in the
    /// token contract's own data, which the escrow's keep-alive does not touch.
    fn balance_key(f: &Fx, holder: &Address) -> SVec<Val> {
        svec![
            &f.env,
            Symbol::new(&f.env, "Balance").into_val(&f.env),
            holder.into_val(&f.env)
        ]
    }

    fn balance_ttl(f: &Fx, holder: &Address) -> u32 {
        let key = balance_key(f, holder);
        f.env
            .as_contract(&f.token, || f.env.storage().persistent().get_ttl(&key))
    }

    #[test]
    fn the_keep_alive_does_not_extend_the_escrows_balance_entry() {
        let f = Fx::new();
        let (_, id) = f.deposit(&f.params());
        // The token extended the entry itself, to 30 days, when the deposit credited the escrow.
        assert_eq!(balance_ttl(&f, &f.escrow.address), SAC_BALANCE_EXTEND);

        // Ten days pass with no activity in this token: the balance entry runs down, and the
        // escrow's keep-alive moves the deposit and the instance to the maximum but not the balance.
        f.env
            .ledger()
            .set_sequence_number(SEQ0 + 10 * DAY_IN_LEDGERS);
        let before = balance_ttl(&f, &f.escrow.address);
        assert_eq!(before, SAC_BALANCE_EXTEND - 10 * DAY_IN_LEDGERS);
        f.escrow.extend_deposit_ttl(&id);
        assert_eq!(f.deposit_ttl(&id), f.max_ttl());
        assert_eq!(balance_ttl(&f, &f.escrow.address), before);
    }

    #[test]
    fn other_holders_transfers_do_not_extend_the_escrows_balance_entry() {
        let f = Fx::new();
        f.deposit(&f.params());
        f.env
            .ledger()
            .set_sequence_number(SEQ0 + 10 * DAY_IN_LEDGERS);
        let before = balance_ttl(&f, &f.escrow.address);
        let other = Address::generate(&f.env);
        TokenClient::new(&f.env, &f.token).transfer(&f.depositor, &other, &1);
        assert_eq!(balance_ttl(&f, &f.escrow.address), before);
        // The holder's own entries are touched by it, which is the contrast.
        assert_eq!(balance_ttl(&f, &other), SAC_BALANCE_EXTEND);
    }
}

// ------------------------------------------- replacing a pending schedule says so (OZ-style)

#[test]
fn replacing_a_pending_admin_transfer_emits_canceled_before_the_new_schedule() {
    let f = Fx::new();
    let first = Address::generate(&f.env);
    let second = Address::generate(&f.env);
    f.escrow.begin_default_admin_transfer(&first);
    // Nothing pending yet: only the schedule
    assert_eq!(
        escrow_events(&f),
        [events::DefaultAdminTransferScheduled {
            new_admin: first.clone(),
            accept_after: T0 + 1
        }
        .to_xdr(&f.env, &f.escrow.address)]
    );
    f.env.ledger().set_timestamp(T0 + 50);
    f.escrow.begin_default_admin_transfer(&second);
    assert_eq!(
        escrow_events(&f),
        [
            events::DefaultAdminTransferCanceled {
                admin: f.admin.clone()
            }
            .to_xdr(&f.env, &f.escrow.address),
            events::DefaultAdminTransferScheduled {
                new_admin: second.clone(),
                accept_after: T0 + 51
            }
            .to_xdr(&f.env, &f.escrow.address)
        ]
    );
    assert_eq!(f.escrow.pending_default_admin().unwrap().new_admin, second);
    // After an explicit cancel nothing is pending, so a new schedule is not a replacement
    f.escrow.cancel_default_admin_transfer();
    f.escrow.begin_default_admin_transfer(&first);
    assert_eq!(escrow_events(&f).events().len(), 1);
}

#[test]
fn replacing_a_pending_delay_change_emits_canceled_before_the_new_schedule() {
    let f = Fx::new();
    f.escrow.change_default_admin_delay(&500);
    assert_eq!(
        escrow_events(&f),
        [events::AdminDelayChangeScheduled {
            new_delay: 500,
            effective_at: T0 + 500
        }
        .to_xdr(&f.env, &f.escrow.address)]
    );
    // Still pending: the second change replaces it
    f.escrow.change_default_admin_delay(&800);
    assert_eq!(
        escrow_events(&f),
        [
            events::AdminDelayChangeCanceled {
                admin: f.admin.clone()
            }
            .to_xdr(&f.env, &f.escrow.address),
            events::AdminDelayChangeScheduled {
                new_delay: 800,
                effective_at: T0 + 800
            }
            .to_xdr(&f.env, &f.escrow.address)
        ]
    );
    // A change that has already taken effect is folded into the current delay, not replaced
    f.env.ledger().set_timestamp(T0 + 801);
    f.escrow.change_default_admin_delay(&900);
    assert_eq!(escrow_events(&f).events().len(), 1);
    // After a rollback nothing is pending
    f.escrow.rollback_default_admin_delay();
    f.escrow.change_default_admin_delay(&950);
    assert_eq!(escrow_events(&f).events().len(), 1);
}

// ---------------------------------------------------------------- genesis event

fn topic_names(
    events: &soroban_sdk::testutils::ContractEvents,
) -> std::vec::Vec<std::string::String> {
    use soroban_sdk::xdr::{ContractEventBody, ScVal};
    events
        .events()
        .iter()
        .map(|e| {
            let ContractEventBody::V0(v0) = &e.body;
            match v0.topics.first() {
                Some(ScVal::Symbol(s)) => s.to_utf8_string_lossy(),
                other => panic!("first topic {other:?}"),
            }
        })
        .collect()
}

#[test]
fn deployment_publishes_one_genesis_event() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let id = env.register(Escrow, (&admin, 3_600u32));
    let events = env.events().all().filter_by_contract(&id);
    assert_eq!(topic_names(&events), ["initialized"]);
}

// ---- typed: compiles only once the event exists

#[test]
fn the_genesis_event_carries_the_default_admin_and_the_delay() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let id = env.register(Escrow, (&admin, 3_600u32));
    assert_eq!(
        env.events().all().filter_by_contract(&id),
        [events::Initialized {
            default_admin: admin,
            admin_delay_secs: 3_600
        }
        .to_xdr(&env, &id)]
    );
}

#[test]
fn one_quote_hash_backs_at_most_one_deposit_per_reserver() {
    let f = Fx::new();
    let p1 = f.params();
    let (i1, id1) = f.deposit(&p1);
    // A second deposit with another nonce under the same quote hash, signed by the same reserver
    let mut p2 = f.params();
    p2.nonce = 8;
    let i2 = f.build(&p2);
    assert_eq!(f.escrow.try_deposit(&i2), Err(Ok(Error::QuoteAlreadyUsed)));
    // Nothing moved and the nonce was not spent: the same deposit under a fresh quote lands
    assert_eq!(f.bal(&f.escrow.address), p1.source_amount);
    p2.quote = 0x34;
    let (_, id2) = f.deposit(&p2);
    assert_ne!(id1, id2);
    // The marker outlives the deposit: a released quote cannot be reserved again
    let w = f.release_witness(&i1, f.fee_for(p1.source_amount));
    f.escrow.release(&w, &f.release_sig(&w, &f.releaser));
    let mut p3 = f.params();
    p3.nonce = 9;
    assert_eq!(
        f.escrow.try_deposit(&f.build(&p3)),
        Err(Ok(Error::QuoteAlreadyUsed))
    );
}

#[test]
fn the_same_quote_hash_under_another_reserver_is_a_separate_quote() {
    let f = Fx::new();
    f.deposit(&f.params());
    // A second reserver key signs the same quote hash: it does not collide with the first's marker
    let other = SigningKey::from_bytes(&[0x61; 32]);
    let mut p = f.params();
    p.nonce = 8;
    let mut input = f.build(&p);
    input.deposit_witness.reserver = pubkey(&f.env, &other);
    let dest = String::from_str(&f.env, p.destination);
    let id = signatures::compute_deposit_hash(
        &f.env,
        &f.domain(),
        &f.b32(0x44),
        &signatures::destination_hash(&f.env, &dest),
        &p.depositor,
        &p.token,
        p.epoch,
        p.amount,
        &pubkey(&f.env, &other),
        &pubkey(&f.env, &f.releaser),
        p.nonce,
        p.issued_at,
        p.deadline,
    );
    input.reserve_witness.deposit_id = id.clone();
    input.delegate_signature = sign(&f.env, &f.delegate, &id);
    let digest = signatures::compute_reserve_hash(
        &f.env,
        &f.domain(),
        &id,
        &input.reserve_witness.quote_hash,
        &f.settler,
        p.source_amount,
    );
    input.reserve_signature = sign(&f.env, &other, &digest);
    f.escrow.deposit(&input);
}

// ------------------------------------------------- delegate epoch in the result and the events

/// The data field names of the last event named `name` that the escrow published
fn event_fields(f: &Fx, name: &str) -> std::vec::Vec<std::string::String> {
    use soroban_sdk::xdr::{ContractEventBody, ScVal};
    for e in escrow_events(f).events() {
        let ContractEventBody::V0(v0) = &e.body;
        let is_named =
            matches!(v0.topics.first(), Some(ScVal::Symbol(s)) if s.to_utf8_string_lossy() == name);
        if !is_named {
            continue;
        }
        let ScVal::Map(Some(map)) = &v0.data else {
            panic!("{name}: data is not a map");
        };
        return map
            .iter()
            .map(|entry| match &entry.key {
                ScVal::Symbol(s) => s.to_utf8_string_lossy(),
                other => panic!("{name}: key {other:?}"),
            })
            .collect();
    }
    panic!("{name}: no such event");
}

#[test]
fn the_delegate_events_carry_the_epoch_field() {
    let f = Fx::new();
    let sk = pubkey(&f.env, &f.delegate);
    f.escrow.revoke_delegate(&f.depositor, &f.token);
    assert!(event_fields(&f, "delegate_revoked").contains(&"epoch".into()));
    f.escrow
        .create_delegate(&f.depositor, &f.token, &sk, &10, &10, &(T0 + DAY));
    assert!(event_fields(&f, "delegate_created").contains(&"epoch".into()));
    let sig = renounce_sig(&f, 2, 900, &f.delegate);
    f.escrow
        .renounce_delegate(&f.depositor, &f.token, &900, &RENOUNCE_DEADLINE, &sig);
    assert!(event_fields(&f, "delegate_renounced").contains(&"epoch".into()));
}

#[test]
fn create_delegate_returns_the_epoch_it_assigned() {
    let f = Fx::new();
    let sk = pubkey(&f.env, &f.delegate);
    f.escrow.revoke_delegate(&f.depositor, &f.token);
    // The result is read as a u64 through the raw invoke path, so a `()` return fails here
    let epoch: u64 = f.env.invoke_contract(
        &f.escrow.address,
        &soroban_sdk::Symbol::new(&f.env, "create_delegate"),
        soroban_sdk::vec![
            &f.env,
            soroban_sdk::IntoVal::into_val(&f.depositor, &f.env),
            soroban_sdk::IntoVal::into_val(&f.token, &f.env),
            soroban_sdk::IntoVal::into_val(&sk, &f.env),
            soroban_sdk::IntoVal::into_val(&10i128, &f.env),
            soroban_sdk::IntoVal::into_val(&10i128, &f.env),
            soroban_sdk::IntoVal::into_val(&(T0 + DAY), &f.env),
        ],
    );
    assert_eq!(epoch, 2);
    assert_eq!(delegate_of(&f).epoch, epoch);
}

// ---- typed: compiles only once the result and the events carry the epoch

#[test]
fn the_epoch_is_in_the_create_revoke_and_renounce_events_and_the_create_result() {
    let f = Fx::new();
    let sk = pubkey(&f.env, &f.delegate);
    let rec = delegate_of(&f);
    assert_eq!(rec.epoch, 1);
    f.escrow.revoke_delegate(&f.depositor, &f.token);
    assert_eq!(
        escrow_events(&f),
        [events::DelegateRevoked {
            depositor: f.depositor.clone(),
            token: f.token.clone(),
            delegate_signer: sk.clone(),
            epoch: 1,
        }
        .to_xdr(&f.env, &f.escrow.address)]
    );
    // Epochs survive a revoke: the second record is epoch 2, and the call returns it
    let epoch = f
        .escrow
        .create_delegate(&f.depositor, &f.token, &sk, &10, &10, &(T0 + DAY));
    assert_eq!(epoch, 2);
    assert_eq!(
        escrow_events(&f),
        [events::DelegateCreated {
            depositor: f.depositor.clone(),
            token: f.token.clone(),
            delegate_signer: sk.clone(),
            capacity: 10,
            max_transfer_size: 10,
            expiration: T0 + DAY,
            epoch: 2,
        }
        .to_xdr(&f.env, &f.escrow.address)]
    );
    let sig = renounce_sig(&f, 2, 900, &f.delegate);
    f.escrow
        .renounce_delegate(&f.depositor, &f.token, &900, &RENOUNCE_DEADLINE, &sig);
    assert_eq!(
        escrow_events(&f),
        [events::DelegateRenounced {
            depositor: f.depositor.clone(),
            token: f.token.clone(),
            delegate_signer: sk,
            epoch: 2,
        }
        .to_xdr(&f.env, &f.escrow.address)]
    );
}
