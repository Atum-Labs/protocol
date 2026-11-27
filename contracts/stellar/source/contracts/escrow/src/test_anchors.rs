//! Hash-anchor tests for every signed or stored digest.
//!
//! Every constant below was derived OUT OF BAND: the layout in `docs/witness-layouts.md` was
//! transcribed into a script (`cast keccak` as the independent keccak-256) and run on the fixture
//! below, not copied from this crate's output. If a test here fails, either the layout changed on
//! purpose (re-derive, update the off-chain encoders in lockstep, and bump
//! `SIGNATURE_DOMAIN_VERSION` only if the rule in `docs/witness-layouts.md` calls for it) or
//! something is broken. Copying the new computed value in is a silent wire-format
//! break.

use std::format;

use soroban_sdk::{address_payload::AddressPayload, Address, BytesN, Env, String};

use crate::signatures::*;
use crate::types::ActiveDeposit;

// sha256("Test SDF Network ; September 2015") and sha256("Public Global Stellar Network ; September 2015")
const NETWORK_TESTNET: &str = "cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472";
const NETWORK_PUBLIC: &str = "7ac33997544e3175d266bd022439b22cdb16508c01163f26e5cb2a3e1045a979";

const DESTINATION: &str = "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@0xc0ffee254729296a45a3885639ac7e10f9d54979";
const ANCHOR_DESTINATION_HASH: &str =
    "7e096a6d1abcfc4daab28cec3f3d3a458c3facbfa0f3493284bb891bdc9807ef";
const ANCHOR_DEPOSIT_TESTNET: &str =
    "d28667e7c40efa69ab7ba45db817a82044cb10840fe95a45425e7b99556f6a65";
const ANCHOR_DEPOSIT_PUBLIC: &str =
    "708f97942322b3d027730af1dc8359655b638e06cf2abbaa35f155189a64a6df";
/// Same inputs with the destination fed raw instead of hashed: what an unsound encoder produces.
const ANCHOR_DEPOSIT_RAW_DESTINATION: &str =
    "a27e5b952663bace502540b5a9f2d6d0ec8e414639741daa9cfdfa3b3abe7fdd";
const ANCHOR_RESERVE: &str = "827560933bcd171fc0ac5eb23d176b7fc5f0b2e5fbb7e84fd1d10acb99fb146f";
const ANCHOR_RELEASE: &str = "1e047d0a87c1ed7a0d380b2c2d89f9484ccc18b4e2e56651b7c85e21117abaa4";
const ANCHOR_REFUND: &str = "1a4f68fa5ba5f3e57a942fd0b6260e97e64b9e399635e454a144e3cf04b8b43c";
const ANCHOR_ACTIVE_DEPOSIT: &str =
    "f1c27186532d82e2c3bf509335bcac128d234e8c3537188e9b13681cf8b710e6";

const CEILING: i128 = 1_250_000;
const SOURCE_AMOUNT: i128 = 1_000_000;
const FEE: i128 = 200;
const EPOCH: u64 = 1;
const NONCE: u64 = 0x0000_0001_0000_0007;
const ISSUED_AT: u64 = 1_700_000_000;
const DEADLINE: u64 = ISSUED_AT + 128;

fn unhex(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

fn hex(b: &BytesN<32>) -> std::string::String {
    b.to_array().iter().map(|x| format!("{x:02x}")).collect()
}

fn b32(env: &Env, v: u8) -> BytesN<32> {
    BytesN::from_array(env, &[v; 32])
}

struct Fx {
    env: Env,
    domain: Domain,
    depositor: Address,
    token: Address,
    settler: Address,
}

fn fx(network: &str) -> Fx {
    let env = Env::default();
    let domain = Domain {
        network_id: BytesN::from_array(&env, &unhex(network)),
        contract_id: b32(&env, 0xc0),
    };
    Fx {
        depositor: Address::from_payload(
            &env,
            AddressPayload::AccountIdPublicKeyEd25519(b32(&env, 0xd1)),
        ),
        token: Address::from_payload(&env, AddressPayload::ContractIdHash(b32(&env, 0xe1))),
        settler: Address::from_payload(
            &env,
            AddressPayload::AccountIdPublicKeyEd25519(b32(&env, 0xa5)),
        ),
        domain,
        env,
    }
}

fn deposit_hash(f: &Fx, destination_hash: &BytesN<32>) -> BytesN<32> {
    compute_deposit_hash(
        &f.env,
        &f.domain,
        &b32(&f.env, 0x44),
        destination_hash,
        &f.depositor,
        &f.token,
        EPOCH,
        CEILING,
        &b32(&f.env, 0x55),
        &b32(&f.env, 0x66),
        NONCE,
        ISSUED_AT,
        DEADLINE,
    )
}

fn active(f: &Fx) -> ActiveDeposit {
    ActiveDeposit {
        depositor: f.depositor.clone(),
        quote_hash: b32(&f.env, 0x33),
        deposit_request_hash: b32(&f.env, 0x44),
        destination_hash: destination_hash(&f.env, &String::from_str(&f.env, DESTINATION)),
        token: f.token.clone(),
        amount: SOURCE_AMOUNT,
        fee_amount: FEE,
        reserver: b32(&f.env, 0x55),
        releaser: b32(&f.env, 0x66),
        settler: f.settler.clone(),
    }
}

#[test]
fn network_id_constants_are_the_passphrase_hashes() {
    // Ties the anchors' domain bytes to the passphrases they claim to be, without a hash dependency
    let env = Env::default();
    let sha = |s: &str| {
        env.crypto()
            .sha256(&soroban_sdk::Bytes::from_slice(&env, s.as_bytes()))
            .to_bytes()
    };
    assert_eq!(
        hex(&sha("Test SDF Network ; September 2015")),
        NETWORK_TESTNET
    );
    assert_eq!(
        hex(&sha("Public Global Stellar Network ; September 2015")),
        NETWORK_PUBLIC
    );
}

#[test]
fn destination_hash_matches_the_value_evm_and_solana_pin() {
    let f = fx(NETWORK_TESTNET);
    assert_eq!(
        hex(&destination_hash(
            &f.env,
            &String::from_str(&f.env, DESTINATION)
        )),
        ANCHOR_DESTINATION_HASH
    );
}

#[test]
fn deposit_hash_matches_anchor() {
    let f = fx(NETWORK_TESTNET);
    let dh = destination_hash(&f.env, &String::from_str(&f.env, DESTINATION));
    assert_eq!(hex(&deposit_hash(&f, &dh)), ANCHOR_DEPOSIT_TESTNET);
}

#[test]
fn deposit_hash_is_network_separated() {
    let f = fx(NETWORK_PUBLIC);
    let dh = destination_hash(&f.env, &String::from_str(&f.env, DESTINATION));
    assert_eq!(hex(&deposit_hash(&f, &dh)), ANCHOR_DEPOSIT_PUBLIC);
    assert_ne!(ANCHOR_DEPOSIT_PUBLIC, ANCHOR_DEPOSIT_TESTNET);
}

/// The destination must enter hashed. Pins both the real value and that the raw-fed value differs.
#[test]
fn raw_destination_feed_is_not_what_the_contract_computes() {
    let f = fx(NETWORK_TESTNET);
    let dh = destination_hash(&f.env, &String::from_str(&f.env, DESTINATION));
    let real = hex(&deposit_hash(&f, &dh));
    assert_eq!(real, ANCHOR_DEPOSIT_TESTNET);
    assert_ne!(real, ANCHOR_DEPOSIT_RAW_DESTINATION);
}

#[test]
fn reserve_hash_matches_anchor() {
    let f = fx(NETWORK_TESTNET);
    let id = BytesN::from_array(&f.env, &unhex(ANCHOR_DEPOSIT_TESTNET));
    assert_eq!(
        hex(&compute_reserve_hash(
            &f.env,
            &f.domain,
            &id,
            &b32(&f.env, 0x33),
            &f.settler,
            SOURCE_AMOUNT
        )),
        ANCHOR_RESERVE
    );
}

#[test]
fn release_and_refund_hashes_match_anchors() {
    let f = fx(NETWORK_TESTNET);
    let id = BytesN::from_array(&f.env, &unhex(ANCHOR_DEPOSIT_TESTNET));
    let a = active(&f);
    assert_eq!(
        hex(&compute_release_hash(&f.env, &f.domain, &id, &a)),
        ANCHOR_RELEASE
    );
    assert_eq!(
        hex(&compute_refund_hash(&f.env, &f.domain, &id, &a)),
        ANCHOR_REFUND
    );
    assert_ne!(ANCHOR_RELEASE, ANCHOR_REFUND);
}

#[test]
fn active_deposit_hash_matches_anchor() {
    let f = fx(NETWORK_TESTNET);
    assert_eq!(
        hex(&compute_active_deposit_hash(&f.env, &active(&f))),
        ANCHOR_ACTIVE_DEPOSIT
    );
}

#[test]
fn every_member_of_the_release_witness_is_bound() {
    let f = fx(NETWORK_TESTNET);
    let id = BytesN::from_array(&f.env, &unhex(ANCHOR_DEPOSIT_TESTNET));
    let base = hex(&compute_release_hash(&f.env, &f.domain, &id, &active(&f)));
    let other_addr =
        Address::from_payload(&f.env, AddressPayload::ContractIdHash(b32(&f.env, 0x99)));
    type Mutation = fn(&mut ActiveDeposit, &Env, &Address);
    let mutations: [(&str, Mutation); 10] = [
        ("depositor", |a, _, o| a.depositor = o.clone()),
        ("quote_hash", |a, e, _| a.quote_hash = b32(e, 0x98)),
        ("deposit_request_hash", |a, e, _| {
            a.deposit_request_hash = b32(e, 0x98)
        }),
        ("destination_hash", |a, e, _| {
            a.destination_hash = b32(e, 0x98)
        }),
        ("token", |a, _, o| a.token = o.clone()),
        ("amount", |a, _, _| a.amount += 1),
        ("fee_amount", |a, _, _| a.fee_amount += 1),
        ("reserver", |a, e, _| a.reserver = b32(e, 0x98)),
        ("releaser", |a, e, _| a.releaser = b32(e, 0x98)),
        ("settler", |a, _, o| a.settler = o.clone()),
    ];
    for (name, mutate) in mutations {
        let mut a = active(&f);
        mutate(&mut a, &f.env, &other_addr);
        assert_ne!(
            hex(&compute_release_hash(&f.env, &f.domain, &id, &a)),
            base,
            "{name} is not bound"
        );
    }
    // The address TYPE byte is bound too: same 32 bytes as a G address instead of a C address
    let mut a = active(&f);
    a.token = Address::from_payload(
        &f.env,
        AddressPayload::AccountIdPublicKeyEd25519(b32(&f.env, 0xe1)),
    );
    assert_ne!(hex(&compute_release_hash(&f.env, &f.domain, &id, &a)), base);
}

/// Sizes the hashed bytes; the part count matters as much as the total. Mirrors Solana's
/// `preimage_lengths_are_pinned`. The lengths are also stated in witness-layouts.md.
#[test]
fn preimage_lengths_are_pinned() {
    // Recomputed here from the documented widths rather than read back from the builder
    let prefix = 6 + 1 + 32 + 32; // "escrow", version, network id, contract id
    assert_eq!(prefix, 71);
    let deposit = prefix + 7 + 32 + 32 + 33 + 33 + 8 + 16 + 32 + 32 + 8 + 8 + 8;
    let reserve = prefix + 7 + 32 + 32 + 33 + 16;
    let settle = 32 * 4 + 33 + 33 + 16 + 16 + 32 + 32 + 33;
    assert_eq!((deposit, reserve), (320, 191));
    assert_eq!((prefix + 7 + settle, prefix + 6 + settle), (401, 400));
    assert_eq!(settle, 323);
}

// ------------------------------------------------------- delegate signatures
// Derived out of band like the digests: the `cryptography` package's RFC 8032 ed25519 over the digest
// bytes, seed `77` x 32. ed25519 is deterministic, so these are exact signatures, not just valid ones.

const ANCHOR_RENOUNCE: &str = "99e54f1290c5bd5d79f2d9c502ea157fbbfa2745776cef4be1f82c4643c43589";
const DELEGATE_PUBKEY: &str = "c853ad0f0cd2b619aea92ceec4fd56a24d6499d584ce79257e45cfd8139b60a7";
const DELEGATE_SIG_DEPOSIT: &str = "ec48e2d9cc0bff07e1d6c5fb9820fd8cc7a269fe3d3cc752afd46809472076d45327cc4482b64e91990cde344c545a667304692261d9fa526eddf8e6cd12fe0b";
const DELEGATE_SIG_RENOUNCE: &str = "3b49fc8c1bd76acedb29ae5896f01384e364d3cd6d112ac06f431cefe7b66aa04a9def71623f490e8fbc070eff05b79c621254298e561291372b6202e232bf06";

fn unhex64(s: &str) -> [u8; 64] {
    let mut out = [0u8; 64];
    for i in 0..64 {
        out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

#[test]
fn renounce_hash_matches_anchor() {
    let f = fx(NETWORK_TESTNET);
    assert_eq!(
        hex(&compute_renounce_hash(
            &f.env,
            &f.domain,
            &f.depositor,
            &f.token,
            1,
            900,
            1_700_000_128
        )),
        ANCHOR_RENOUNCE
    );
}

#[test]
fn the_pinned_delegate_signatures_verify_and_are_what_the_signer_produces() {
    use ed25519_dalek::{Signer, SigningKey};
    let f = fx(NETWORK_TESTNET);
    let sk = SigningKey::from_bytes(&[0x77; 32]);
    assert_eq!(
        hex(&BytesN::from_array(&f.env, &sk.verifying_key().to_bytes())),
        DELEGATE_PUBKEY
    );
    let pk = BytesN::from_array(&f.env, &unhex(DELEGATE_PUBKEY));
    for (digest, sig) in [
        (ANCHOR_DEPOSIT_TESTNET, DELEGATE_SIG_DEPOSIT),
        (ANCHOR_RENOUNCE, DELEGATE_SIG_RENOUNCE),
    ] {
        let d = BytesN::from_array(&f.env, &unhex(digest));
        let sig_bytes = unhex64(sig);
        // The contract's verifier accepts the independently derived signature...
        verify(&f.env, &pk, &d, &BytesN::from_array(&f.env, &sig_bytes));
        // ...and the signer used by the tests produces exactly it
        assert_eq!(sk.sign(&d.to_array()).to_bytes(), sig_bytes);
    }
}
