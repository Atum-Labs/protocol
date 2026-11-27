//! Replays `contracts/stellar/conformance/vectors.json` through the contract's own digest functions.
//!
//! The same file is asserted by the Go encoder (`encoding/conformance_test.go`) and the TypeScript
//! encoder (`src/conformance.test.ts`), so one implementation drifting from the layout fails its own
//! suite and nobody else's has to be edited to notice. The vectors are NOT produced by this crate:
//! `conformance/regenerate_vectors.py` derives them from `docs/witness-layouts.md` with its own
//! keccak-256. When this test fails, either the layout changed on purpose (update the doc and the
//! script, regenerate, review the diff, update the Go and TypeScript encoders, and bump
//! `SIGNATURE_DOMAIN_VERSION` only if the rule in `docs/witness-layouts.md` calls for it) or the
//! contract broke. Never paste a computed digest into the file.

use std::{format, string::ToString, vec::Vec};

use serde_json::Value;
use soroban_sdk::{address_payload::AddressPayload, Address, Bytes, BytesN, Env, String};

use crate::signatures::*;
use crate::types::ActiveDeposit;

const REGEN: &str =
    "run contracts/stellar/conformance/regenerate_vectors.py only for an intended layout change";

fn vectors() -> Value {
    serde_json::from_str(include_str!("../../../../conformance/vectors.json"))
        .expect("vectors.json parses")
}

fn unhex(s: &str) -> Vec<u8> {
    assert!(s.len().is_multiple_of(2), "odd-length hex {s}");
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap())
        .collect()
}

fn hex(b: &[u8]) -> std::string::String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key]
        .as_str()
        .unwrap_or_else(|| panic!("missing string field {key} in {v}"))
}

fn n128(v: &Value, key: &str) -> i128 {
    s(v, key).parse().unwrap()
}

fn n64(v: &Value, key: &str) -> u64 {
    s(v, key).parse().unwrap()
}

fn b32(env: &Env, v: &Value, key: &str) -> BytesN<32> {
    let b = unhex(s(v, key));
    BytesN::from_array(env, b.as_slice().try_into().expect("32 bytes"))
}

fn addr(env: &Env, v: &Value, key: &str) -> Address {
    Address::from_str(env, s(v, key))
}

fn domain(env: &Env, root: &Value, case: &Value) -> Domain {
    let network = &root["networks"][s(case, "network")];
    let contract_id = match addr(env, case, "contractId").to_payload() {
        Some(AddressPayload::ContractIdHash(h)) => h,
        _ => panic!("contractId must be a C address"),
    };
    Domain {
        network_id: b32(env, network, "networkId"),
        contract_id,
    }
}

fn active(env: &Env, i: &Value) -> ActiveDeposit {
    ActiveDeposit {
        depositor: addr(env, i, "depositor"),
        quote_hash: b32(env, i, "quoteHash"),
        deposit_request_hash: b32(env, i, "depositRequestHash"),
        destination_hash: b32(env, i, "destinationHash"),
        token: addr(env, i, "token"),
        amount: n128(i, "amount"),
        fee_amount: n128(i, "feeAmount"),
        reserver: b32(env, i, "reserver"),
        releaser: b32(env, i, "releaser"),
        settler: addr(env, i, "settler"),
    }
}

fn digest(env: &Env, root: &Value, case: &Value) -> BytesN<32> {
    let i = &case["input"];
    match s(case, "kind") {
        "destinationHash" => destination_hash(env, &String::from_str(env, s(i, "destination"))),
        "deposit" => {
            let dest = destination_hash(env, &String::from_str(env, s(i, "destination")));
            compute_deposit_hash(
                env,
                &domain(env, root, case),
                &b32(env, i, "depositRequestHash"),
                &dest,
                &addr(env, i, "depositor"),
                &addr(env, i, "token"),
                n64(i, "epoch"),
                n128(i, "amount"),
                &b32(env, i, "reserver"),
                &b32(env, i, "releaser"),
                n64(i, "nonce"),
                n64(i, "issuedAt"),
                n64(i, "deadline"),
            )
        }
        "reserve" => compute_reserve_hash(
            env,
            &domain(env, root, case),
            &b32(env, i, "depositId"),
            &b32(env, i, "quoteHash"),
            &addr(env, i, "settler"),
            n128(i, "sourceAmount"),
        ),
        "release" => compute_release_hash(
            env,
            &domain(env, root, case),
            &b32(env, i, "depositId"),
            &active(env, i),
        ),
        "refund" => compute_refund_hash(
            env,
            &domain(env, root, case),
            &b32(env, i, "depositId"),
            &active(env, i),
        ),
        "renounce" => compute_renounce_hash(
            env,
            &domain(env, root, case),
            &addr(env, i, "depositor"),
            &addr(env, i, "token"),
            n64(i, "epoch"),
            n64(i, "nonce"),
            n64(i, "deadline"),
        ),
        "activeDeposit" => compute_active_deposit_hash(env, &active(env, i)),
        // A new kind in the fixture must be taught to every implementation, so it fails loudly here
        other => panic!("vectors.json has kind {other:?} this test does not implement"),
    }
}

#[test]
fn every_vector_is_reproduced_by_the_contract() {
    let env = Env::default();
    let root = vectors();
    let cases = root["cases"].as_array().expect("cases");
    assert!(cases.len() >= 90, "vector set shrank to {}", cases.len());
    assert_eq!(
        root["signatureDomainVersion"].as_u64(),
        Some(u64::from(SIGNATURE_DOMAIN_VERSION)),
        "SIGNATURE_DOMAIN_VERSION moved: {REGEN}"
    );
    let mut kinds = std::collections::BTreeSet::new();
    for case in cases {
        let name = s(case, "name");
        let got = hex(&digest(&env, &root, case).to_array());
        assert_eq!(
            got,
            s(case, "digest"),
            "{name}: the contract no longer reproduces the vector; {REGEN}"
        );
        kinds.insert(s(case, "kind").to_string());
    }
    assert_eq!(
        kinds.into_iter().collect::<Vec<_>>(),
        [
            "activeDeposit",
            "deposit",
            "destinationHash",
            "refund",
            "release",
            "renounce",
            "reserve"
        ]
    );
}

/// A case that claims to change one field must change the digest: the vectors themselves prove every
/// member is bound, in every layout.
#[test]
fn every_single_field_change_moves_the_digest() {
    let root = vectors();
    let cases = root["cases"].as_array().unwrap();
    let digest_of = |name: &str| {
        cases
            .iter()
            .find(|c| s(c, "name") == name)
            .unwrap_or_else(|| panic!("{name} is not in the vectors"))["digest"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let mut checked = 0;
    for case in cases {
        if let Some(base) = case.get("mutates").and_then(Value::as_str) {
            assert_ne!(
                s(case, "digest"),
                digest_of(base),
                "{} does not change the digest of {base}",
                s(case, "name")
            );
            checked += 1;
        }
    }
    assert!(checked >= 40, "only {checked} single-field cases");
}

#[test]
fn network_ids_are_the_passphrase_hashes() {
    let env = Env::default();
    let root = vectors();
    for (name, n) in root["networks"].as_object().unwrap() {
        let h = env
            .crypto()
            .sha256(&Bytes::from_slice(&env, s(n, "passphrase").as_bytes()))
            .to_bytes();
        assert_eq!(hex(&h.to_array()), s(n, "networkId"), "{name}");
    }
}

/// The strkey table, including two real-world contract addresses, decodes to the type byte and key
/// the layout hashes, so the vectors' address spelling cannot hide an addr33 mismatch.
#[test]
fn strkeys_decode_to_the_documented_address_bytes() {
    let env = Env::default();
    let root = vectors();
    for a in root["addresses"].as_array().unwrap() {
        let (kind, key) = match Address::from_str(&env, s(a, "strkey")).to_payload() {
            Some(AddressPayload::AccountIdPublicKeyEd25519(k)) => ("account", k),
            Some(AddressPayload::ContractIdHash(k)) => ("contract", k),
            None => panic!("{} has no fixed-width payload", s(a, "strkey")),
        };
        assert_eq!(kind, s(a, "type"));
        assert_eq!(hex(&key.to_array()), s(a, "key"), "{}", s(a, "strkey"));
    }
}

/// ed25519 is deterministic, so the signatures are exact: the contract's verifier accepts the one the
/// script produced, and the test signer reproduces it byte for byte.
#[test]
fn delegate_signatures_verify_and_are_what_the_signer_produces() {
    use ed25519_dalek::{Signer, SigningKey};
    let env = Env::default();
    let root = vectors();
    let seed: [u8; 32] = unhex(s(&root["delegate"], "seed")).try_into().unwrap();
    let sk = SigningKey::from_bytes(&seed);
    assert_eq!(
        hex(&sk.verifying_key().to_bytes()),
        s(&root["delegate"], "publicKey")
    );
    let pk = b32(&env, &root["delegate"], "publicKey");
    let mut signed = 0;
    for case in root["cases"].as_array().unwrap() {
        let Some(sig) = case.get("signature").and_then(Value::as_str) else {
            continue;
        };
        let d = unhex(s(case, "digest"));
        verify(
            &env,
            &pk,
            &BytesN::from_array(&env, d.as_slice().try_into().unwrap()),
            &BytesN::from_array(&env, unhex(sig).as_slice().try_into().unwrap()),
        );
        assert_eq!(hex(&sk.sign(&d).to_bytes()), sig, "{}", s(case, "name"));
        signed += 1;
    }
    assert_eq!(signed, 2, "deposit and renounce are the delegate's digests");
}

/// The vectors' rejected strkeys (muxed, claimable balance, secret seed) never become an `Address`: the
/// SDK's parser refuses all three, so the contract cannot be handed one, and the encoders' rejection of
/// them matches. A parser that started accepting muxed addresses would have to be answered by
/// `UnsupportedAddress` in `address33`, and this test would flag the change.
#[test]
fn rejected_strkeys_do_not_parse_as_addresses() {
    let env = Env::default();
    let root = vectors();
    let rejected = &root["rejectedAddresses"];
    for name in ["muxed", "claimableBalance", "secretSeed"] {
        let text = s(rejected, name).to_string();
        let parsed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            Address::from_str(&env, &text)
        }));
        assert!(parsed.is_err(), "{name} parsed as an address");
    }
}
