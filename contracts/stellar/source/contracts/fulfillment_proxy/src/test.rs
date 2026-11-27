// SPDX-License-Identifier: MIT
#![cfg(test)]
extern crate std;

use soroban_sdk::{
    testutils::{
        storage::Persistent as _, Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke,
    },
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, Event as _, IntoVal,
};

use crate::{
    storage::DataKey, AdminDelayChangeCanceled, AdminDelayChangeScheduled, AuthorizedSettlerAdded,
    AuthorizedSettlerRemoved, DefaultAdminTransferCanceled, DefaultAdminTransferScheduled,
    DefaultAdminTransferred, Error, Fulfilled, FulfillmentAuthorized, FulfillmentProxy,
    FulfillmentProxyClient, PauserUpdated, ProxyPaused, ProxyUnpaused,
    SettlerAllowlistEnforcementSet,
};

const DELAY: u32 = 100;
const T0: u64 = 1_700_000_000;
/// A `fulfill` deadline far enough ahead that the tests that do not exercise it never meet it.
const DL: u64 = T0 + 1_000_000;

struct Fx<'a> {
    env: Env,
    proxy: FulfillmentProxyClient<'a>,
    token: TokenClient<'a>,
    admin: Address,
    pauser: Address,
    settler: Address,
    recipient: Address,
    /// Next unused settler nonce for the helpers below.
    nonce: core::cell::Cell<u64>,
}

fn setup<'a>() -> Fx<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let admin = Address::generate(&env);
    let pauser = Address::generate(&env);
    let id = env.register(FulfillmentProxy, (&admin, &pauser, DELAY));
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let settler = Address::generate(&env);
    StellarAssetClient::new(&env, &sac.address()).mint(&settler, &1_000_000);
    Fx {
        proxy: FulfillmentProxyClient::new(&env, &id),
        token: TokenClient::new(&env, &sac.address()),
        recipient: Address::generate(&env),
        admin,
        pauser,
        settler,
        nonce: core::cell::Cell::new(0),
        env,
    }
}

fn h(env: &Env, b: u8) -> BytesN<32> {
    BytesN::from_array(env, &[b; 32])
}

impl Fx<'_> {
    /// A fresh nonce, so repeated calls from the same settler do not collide.
    fn fresh_nonce(&self) -> u64 {
        let n = self.nonce.get();
        self.nonce.set(n + 1);
        n
    }

    fn fulfill(&self, quote: u8, amount: i128) -> Result<(), Error> {
        self.proxy
            .try_fulfill(
                &self.settler,
                &h(&self.env, quote),
                &self.recipient,
                &self.token.address,
                &amount,
                &DL,
                &self.fresh_nonce(),
            )
            .map_err(|e| e.unwrap())
            .map(|r| r.unwrap())
    }

    fn strict(&self, quote: u8, amount: i128, deadline: u64) -> Result<(), Error> {
        self.proxy
            .try_strict_fulfill(
                &self.settler,
                &h(&self.env, quote),
                &self.recipient,
                &self.token.address,
                &amount,
                &deadline,
                &self.fresh_nonce(),
            )
            .map_err(|e| e.unwrap())
            .map(|r| r.unwrap())
    }

    fn proxy_events(&self) -> soroban_sdk::testutils::ContractEvents {
        self.env
            .events()
            .all()
            .filter_by_contract(&self.proxy.address)
    }
}

// ---- fulfill ----

#[test]
fn fulfill_moves_tokens_and_emits_event() {
    let f = setup();
    f.fulfill(1, 250).unwrap();
    let events = f.proxy_events();
    assert_eq!(f.token.balance(&f.recipient), 250);
    assert_eq!(f.token.balance(&f.settler), 999_750);
    let expected = Fulfilled {
        quote_hash: h(&f.env, 1),
        settler: f.settler.clone(),
        to: f.recipient.clone(),
        token: f.token.address.clone(),
        amount: 250,
        timestamp: T0,
    };
    assert_eq!(events, [expected.to_xdr(&f.env, &f.proxy.address)]);
}

#[test]
fn fulfill_is_not_idempotent() {
    let f = setup();
    f.fulfill(1, 10).unwrap();
    f.fulfill(1, 10).unwrap();
    assert_eq!(f.token.balance(&f.recipient), 20);
}

#[test]
fn fulfill_rejects_zero_and_negative_amount() {
    let f = setup();
    assert_eq!(f.fulfill(1, 0), Err(Error::ZeroAmount));
    assert_eq!(f.fulfill(1, -5), Err(Error::ZeroAmount));
    assert_eq!(f.token.balance(&f.recipient), 0);
}

#[test]
fn fulfill_ignores_allowlist_enforcement() {
    let f = setup();
    f.proxy.set_settler_allowlist_enforced(&true);
    f.fulfill(1, 10).unwrap();
    assert_eq!(f.token.balance(&f.recipient), 10);
}

#[test]
fn fulfill_requires_settler_auth() {
    let f = setup();
    f.env.set_auths(&[]);
    let res = f.proxy.try_fulfill(
        &f.settler,
        &h(&f.env, 1),
        &f.recipient,
        &f.token.address,
        &10,
        &DL,
        &0,
    );
    assert!(res.is_err());
    assert_eq!(f.token.balance(&f.recipient), 0);
}

#[test]
fn fulfill_records_settler_auth_for_proxy_and_token_transfer() {
    let f = setup();
    f.fulfill(1, 10).unwrap();
    let auths = f.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, f.settler);
}

#[test]
fn fulfill_fails_when_settler_authorizes_proxy_call_but_not_the_nested_transfer() {
    // The settler authorizes the proxy call but not the nested token transfer.
    let f = setup();
    f.env.set_auths(&[]);
    let res = f
        .proxy
        .mock_auths(&[MockAuth {
            address: &f.settler,
            invoke: &MockAuthInvoke {
                contract: &f.proxy.address,
                fn_name: "fulfill",
                args: (
                    &f.settler,
                    &h(&f.env, 1),
                    &f.recipient,
                    &f.token.address,
                    &10_i128,
                    &DL,
                    &0_u64,
                )
                    .into_val(&f.env),
                sub_invokes: &[],
            },
        }])
        .try_fulfill(
            &f.settler,
            &h(&f.env, 1),
            &f.recipient,
            &f.token.address,
            &10,
            &DL,
            &0,
        );
    assert!(res.is_err());
    assert_eq!(f.token.balance(&f.recipient), 0);
}

// ---- strict_fulfill ----

#[test]
fn strict_fulfill_moves_tokens_marks_quote_and_emits_event() {
    let f = setup();
    f.strict(7, 300, T0 + 10).unwrap();
    let events = f.proxy_events();
    assert_eq!(f.token.balance(&f.recipient), 300);
    assert!(f
        .proxy
        .is_strictly_fulfilled(&h(&f.env, 7), &f.recipient, &f.token.address, &300));
    assert!(!f
        .proxy
        .is_strictly_fulfilled(&h(&f.env, 8), &f.recipient, &f.token.address, &300));
    let expected = Fulfilled {
        quote_hash: h(&f.env, 7),
        settler: f.settler.clone(),
        to: f.recipient.clone(),
        token: f.token.address.clone(),
        amount: 300,
        timestamp: T0,
    };
    assert_eq!(events, [expected.to_xdr(&f.env, &f.proxy.address)]);
}

#[test]
fn strict_fulfill_deadline_is_inclusive() {
    let f = setup();
    f.strict(1, 10, T0).unwrap();
    f.env.ledger().set_timestamp(T0 + 1);
    assert_eq!(f.strict(2, 10, T0), Err(Error::DeadlineExpired));
    assert_eq!(f.token.balance(&f.recipient), 10);
    assert!(!f
        .proxy
        .is_strictly_fulfilled(&h(&f.env, 2), &f.recipient, &f.token.address, &10));
}

#[test]
fn strict_fulfill_rejects_replay_of_same_quote() {
    // The same payment: quote hash, recipient, token and amount. A different payment for the same
    // quote hash is covered in `payment_marker`.
    let f = setup();
    f.strict(1, 10, T0 + 10).unwrap();
    assert_eq!(f.strict(1, 10, T0 + 10), Err(Error::AlreadyFulfilled));
    assert_eq!(f.token.balance(&f.recipient), 10);
}

#[test]
fn strict_fulfill_marker_is_global_across_settlers() {
    // Global across settlers for one payment: the marker key carries no settler.
    let f = setup();
    f.strict(1, 10, T0 + 10).unwrap();
    let other = Address::generate(&f.env);
    StellarAssetClient::new(&f.env, &f.token.address).mint(&other, &100);
    let res = f.proxy.try_strict_fulfill(
        &other,
        &h(&f.env, 1),
        &f.recipient,
        &f.token.address,
        &10,
        &(T0 + 10),
        &0,
    );
    assert_eq!(res.unwrap_err().unwrap(), Error::AlreadyFulfilled);
}

#[test]
fn strict_fulfill_rejects_empty_quote_hash_and_bad_amount() {
    let f = setup();
    assert_eq!(f.strict(0, 10, T0 + 10), Err(Error::QuoteHashCannotBeEmpty));
    assert_eq!(f.strict(1, 0, T0 + 10), Err(Error::ZeroAmount));
    assert_eq!(f.strict(1, -1, T0 + 10), Err(Error::ZeroAmount));
    assert!(!f
        .proxy
        .is_strictly_fulfilled(&h(&f.env, 1), &f.recipient, &f.token.address, &10));
}

#[test]
fn strict_fulfill_failed_transfer_leaves_no_marker() {
    // Insufficient balance traps the whole invocation, so the marker write rolls back.
    let f = setup();
    assert!(f
        .proxy
        .try_strict_fulfill(
            &f.settler,
            &h(&f.env, 1),
            &f.recipient,
            &f.token.address,
            &2_000_000,
            &(T0 + 10),
            &0,
        )
        .is_err());
    assert!(!f.proxy.is_strictly_fulfilled(
        &h(&f.env, 1),
        &f.recipient,
        &f.token.address,
        &2000000
    ));
}

#[test]
fn strict_fulfill_dormant_allowlist_is_permissionless() {
    let f = setup();
    assert!(!f.proxy.settler_allowlist_enforced());
    assert!(!f.proxy.is_authorized_settler(&f.settler));
    f.strict(1, 10, T0 + 10).unwrap();
}

#[test]
fn strict_fulfill_enforced_allowlist_blocks_unlisted_settler() {
    let f = setup();
    f.proxy.set_settler_allowlist_enforced(&true);
    assert_eq!(f.strict(1, 10, T0 + 10), Err(Error::UnauthorizedSettler));
    assert_eq!(f.token.balance(&f.recipient), 0);
    assert!(!f
        .proxy
        .is_strictly_fulfilled(&h(&f.env, 1), &f.recipient, &f.token.address, &10));
}

#[test]
fn strict_fulfill_unauthorized_settler_reverts_uniformly_before_other_guards() {
    let f = setup();
    f.proxy.set_settler_allowlist_enforced(&true);
    // Expired deadline, empty hash and zero amount would each fail on their own.
    assert_eq!(f.strict(0, 0, 0), Err(Error::UnauthorizedSettler));
}

#[test]
fn strict_fulfill_enforced_allowlist_admits_listed_settler() {
    let f = setup();
    f.proxy.add_authorized_settler(&f.settler);
    f.proxy.set_settler_allowlist_enforced(&true);
    f.strict(1, 10, T0 + 10).unwrap();
    assert_eq!(f.token.balance(&f.recipient), 10);
}

#[test]
fn strict_fulfill_removed_settler_is_blocked_and_rollback_is_instant() {
    let f = setup();
    f.proxy.add_authorized_settler(&f.settler);
    f.proxy.set_settler_allowlist_enforced(&true);
    f.proxy.remove_authorized_settler(&f.settler);
    assert_eq!(f.strict(1, 10, T0 + 10), Err(Error::UnauthorizedSettler));
    f.proxy.set_settler_allowlist_enforced(&false);
    f.strict(1, 10, T0 + 10).unwrap();
}

#[test]
fn strict_fulfill_requires_settler_auth_even_when_listed() {
    let f = setup();
    f.proxy.add_authorized_settler(&f.settler);
    f.proxy.set_settler_allowlist_enforced(&true);
    f.env.set_auths(&[]);
    assert!(f
        .proxy
        .try_strict_fulfill(
            &f.settler,
            &h(&f.env, 1),
            &f.recipient,
            &f.token.address,
            &10,
            &(T0 + 10),
            &0,
        )
        .is_err());
}

#[test]
fn strict_marker_ttl_is_extended_on_write() {
    let f = setup();
    f.strict(1, 10, T0 + 10).unwrap();
    let ttl = f.env.as_contract(&f.proxy.address, || {
        f.env
            .storage()
            .persistent()
            .get_ttl(&DataKey::StrictFulfilled(
                h(&f.env, 1),
                f.recipient.clone(),
                f.token.address.clone(),
                10,
            ))
    });
    assert_eq!(ttl, 180 * 17_280);
}

// ---- authorize_fulfillment ----

#[test]
fn authorize_fulfillment_emits_event_and_moves_nothing() {
    let f = setup();
    let before = f.token.balance(&f.settler);
    f.proxy
        .authorize_fulfillment(&f.settler, &h(&f.env, 1), &h(&f.env, 2));
    let events = f.proxy_events();
    assert_eq!(f.token.balance(&f.settler), before);
    let expected = FulfillmentAuthorized {
        authorization_hash: h(&f.env, 2),
        quote_hash: h(&f.env, 1),
        settler: f.settler.clone(),
    };
    assert_eq!(events, [expected.to_xdr(&f.env, &f.proxy.address)]);
    // Writes no marker, so the quote stays fulfillable.
    assert!(!f
        .proxy
        .is_strictly_fulfilled(&h(&f.env, 1), &f.recipient, &f.token.address, &10));
}

#[test]
fn authorize_fulfillment_is_repeatable_and_ignores_allowlist() {
    let f = setup();
    f.proxy.set_settler_allowlist_enforced(&true);
    f.proxy
        .authorize_fulfillment(&f.settler, &h(&f.env, 1), &h(&f.env, 2));
    f.proxy
        .authorize_fulfillment(&f.settler, &h(&f.env, 1), &h(&f.env, 2));
}

#[test]
fn authorize_fulfillment_requires_settler_auth() {
    let f = setup();
    f.env.set_auths(&[]);
    assert!(f
        .proxy
        .try_authorize_fulfillment(&f.settler, &h(&f.env, 1), &h(&f.env, 2))
        .is_err());
}

// ---- pause ----

#[test]
fn paused_blocks_every_fulfillment_entrypoint() {
    let f = setup();
    f.proxy.pause();
    assert!(f.proxy.is_paused());
    assert_eq!(f.fulfill(1, 10), Err(Error::Paused));
    assert_eq!(f.strict(1, 10, T0 + 10), Err(Error::Paused));
    assert_eq!(
        f.proxy
            .try_authorize_fulfillment(&f.settler, &h(&f.env, 1), &h(&f.env, 2))
            .unwrap_err()
            .unwrap(),
        Error::Paused
    );
    f.proxy.unpause();
    assert!(!f.proxy.is_paused());
    f.fulfill(1, 10).unwrap();
}

#[test]
fn pause_and_unpause_revert_when_already_in_that_state_and_emit_nothing() {
    let f = setup();
    assert_eq!(
        f.proxy.try_unpause().unwrap_err().unwrap(),
        Error::NotPaused
    );
    f.proxy.pause();
    assert_eq!(f.proxy.try_pause().unwrap_err().unwrap(), Error::Paused);
    assert!(f.proxy.is_paused());
    f.proxy.unpause();
    assert_eq!(
        f.proxy.try_unpause().unwrap_err().unwrap(),
        Error::NotPaused
    );
    assert!(!f.proxy.is_paused());
}

#[test]
fn pause_unpause_emit_events() {
    let f = setup();
    f.proxy.pause();
    let events = f.proxy_events();
    assert_eq!(
        events,
        [ProxyPaused {
            by: f.pauser.clone()
        }
        .to_xdr(&f.env, &f.proxy.address)]
    );
    f.proxy.unpause();
    let events = f.proxy_events();
    assert_eq!(
        events,
        [ProxyUnpaused {
            by: f.pauser.clone()
        }
        .to_xdr(&f.env, &f.proxy.address)]
    );
}

#[test]
fn only_pauser_can_pause_and_unpause() {
    let f = setup();
    let stranger = Address::generate(&f.env);
    for (name, who) in [("pause", &stranger), ("pause", &f.admin)] {
        f.env.set_auths(&[]);
        let res = f
            .proxy
            .mock_auths(&[MockAuth {
                address: who,
                invoke: &MockAuthInvoke {
                    contract: &f.proxy.address,
                    fn_name: name,
                    args: ().into_val(&f.env),
                    sub_invokes: &[],
                },
            }])
            .try_pause();
        assert!(res.is_err());
        assert!(!f.proxy.is_paused());
    }
    // The pauser-signed path works, and unpause is pauser-only too.
    f.env.mock_all_auths();
    f.proxy.pause();
    f.env.set_auths(&[]);
    let res = f
        .proxy
        .mock_auths(&[MockAuth {
            address: &f.admin,
            invoke: &MockAuthInvoke {
                contract: &f.proxy.address,
                fn_name: "unpause",
                args: ().into_val(&f.env),
                sub_invokes: &[],
            },
        }])
        .try_unpause();
    assert!(res.is_err());
    assert!(f.proxy.is_paused());
}

#[test]
fn set_pauser_rotates_the_pause_authority() {
    let f = setup();
    let new_pauser = Address::generate(&f.env);
    f.proxy.set_pauser(&new_pauser);
    let events = f.proxy_events();
    assert_eq!(f.proxy.pauser(), new_pauser);
    assert_eq!(
        events,
        [PauserUpdated {
            old_pauser: f.pauser.clone(),
            new_pauser: new_pauser.clone()
        }
        .to_xdr(&f.env, &f.proxy.address)]
    );
    f.proxy.pause();
    // The recorded auth is the new pauser's.
    assert_eq!(f.env.auths()[0].0, new_pauser);
}

// ---- admin-gated setters ----

/// Signs the named call as a stranger only and asserts the proxy refuses it: a setter that gated
/// on anything weaker than the stored admin's auth would let this through.
macro_rules! assert_rejects_stranger {
    ($f:expr, $fn_name:literal, $args:expr, $call:ident($($arg:expr),*)) => {{
        let f = $f;
        let stranger = Address::generate(&f.env);
        f.env.set_auths(&[]);
        let invoke = MockAuthInvoke {
            contract: &f.proxy.address,
            fn_name: $fn_name,
            args: $args.into_val(&f.env),
            sub_invokes: &[],
        };
        let auths = [MockAuth { address: &stranger, invoke: &invoke }];
        let res = f.proxy.mock_auths(&auths).$call($($arg),*);
        assert!(res.is_err(), concat!($fn_name, " accepted a non-admin signer"));
    }};
}

#[test]
fn admin_setters_reject_non_admin() {
    let f = setup();
    let someone = Address::generate(&f.env);
    assert_rejects_stranger!(
        &f,
        "set_settler_allowlist_enforced",
        (true,),
        try_set_settler_allowlist_enforced(&true)
    );
    assert_rejects_stranger!(
        &f,
        "add_authorized_settler",
        (f.settler.clone(),),
        try_add_authorized_settler(&f.settler)
    );
    assert_rejects_stranger!(
        &f,
        "remove_authorized_settler",
        (f.settler.clone(),),
        try_remove_authorized_settler(&f.settler)
    );
    assert_rejects_stranger!(
        &f,
        "set_pauser",
        (someone.clone(),),
        try_set_pauser(&someone)
    );
    assert_rejects_stranger!(
        &f,
        "begin_default_admin_transfer",
        (someone.clone(),),
        try_begin_default_admin_transfer(&someone)
    );
    assert_rejects_stranger!(
        &f,
        "change_default_admin_delay",
        (1_u32,),
        try_change_default_admin_delay(&1)
    );
    assert_rejects_stranger!(
        &f,
        "rollback_default_admin_delay",
        (),
        try_rollback_default_admin_delay()
    );
    assert!(!f.proxy.settler_allowlist_enforced());
    assert!(!f.proxy.is_authorized_settler(&f.settler));
    assert_eq!(f.proxy.pauser(), f.pauser);
    assert!(f.proxy.pending_default_admin().is_none());
    assert_eq!(f.proxy.default_admin_delay(), DELAY);
}

#[test]
fn cancel_rejects_non_admin() {
    let f = setup();
    f.proxy
        .begin_default_admin_transfer(&Address::generate(&f.env));
    assert_rejects_stranger!(
        &f,
        "cancel_default_admin_transfer",
        (),
        try_cancel_default_admin_transfer()
    );
    assert!(f.proxy.pending_default_admin().is_some());
}

#[test]
fn admin_setters_record_the_admin_auth() {
    let f = setup();
    f.proxy.add_authorized_settler(&f.settler);
    assert_eq!(f.env.auths()[0].0, f.admin);
    f.proxy.set_settler_allowlist_enforced(&true);
    assert_eq!(f.env.auths()[0].0, f.admin);
}

#[test]
fn allowlist_changes_emit_events_only_on_real_change() {
    let f = setup();
    f.proxy.add_authorized_settler(&f.settler);
    let events = f.proxy_events();
    assert_eq!(
        events,
        [AuthorizedSettlerAdded {
            settler: f.settler.clone()
        }
        .to_xdr(&f.env, &f.proxy.address)]
    );
    f.proxy.add_authorized_settler(&f.settler);
    assert!(f.proxy_events().events().is_empty());
    assert!(f.proxy.is_authorized_settler(&f.settler));

    f.proxy.remove_authorized_settler(&f.settler);
    let events = f.proxy_events();
    assert_eq!(
        events,
        [AuthorizedSettlerRemoved {
            settler: f.settler.clone()
        }
        .to_xdr(&f.env, &f.proxy.address)]
    );
    f.proxy.remove_authorized_settler(&f.settler);
    assert!(f.proxy_events().events().is_empty());
    assert!(!f.proxy.is_authorized_settler(&f.settler));
}

#[test]
fn enforcement_toggle_emits_event() {
    let f = setup();
    f.proxy.set_settler_allowlist_enforced(&true);
    let events = f.proxy_events();
    assert!(f.proxy.settler_allowlist_enforced());
    assert_eq!(
        events,
        [SettlerAllowlistEnforcementSet { enforced: true }.to_xdr(&f.env, &f.proxy.address)]
    );
    f.proxy.set_settler_allowlist_enforced(&false);
    assert!(!f.proxy.settler_allowlist_enforced());
}

// ---- default admin transfer ----

#[test]
fn admin_transfer_waits_out_the_delay() {
    let f = setup();
    let new_admin = Address::generate(&f.env);
    f.proxy.begin_default_admin_transfer(&new_admin);
    let events = f.proxy_events();
    assert_eq!(
        events,
        [DefaultAdminTransferScheduled {
            new_admin: new_admin.clone(),
            accept_after: T0 + u64::from(DELAY),
        }
        .to_xdr(&f.env, &f.proxy.address)]
    );
    let pending = f.proxy.pending_default_admin().unwrap();
    assert_eq!(pending.admin, new_admin);
    assert_eq!(pending.accept_after, T0 + 100);

    f.env.ledger().set_timestamp(T0 + 99);
    assert_eq!(
        f.proxy
            .try_accept_default_admin_transfer()
            .unwrap_err()
            .unwrap(),
        Error::AdminTransferNotReady
    );
    assert_eq!(f.proxy.default_admin(), f.admin);

    // Exactly at accept_after is still too early: the schedule must have strictly passed.
    f.env.ledger().set_timestamp(T0 + 100);
    assert_eq!(
        f.proxy
            .try_accept_default_admin_transfer()
            .unwrap_err()
            .unwrap(),
        Error::AdminTransferNotReady
    );
    assert_eq!(f.proxy.default_admin(), f.admin);

    f.env.ledger().set_timestamp(T0 + 101);
    f.proxy.accept_default_admin_transfer();
    let events = f.proxy_events();
    assert_eq!(f.env.auths()[0].0, new_admin);
    assert_eq!(f.proxy.default_admin(), new_admin);
    assert!(f.proxy.pending_default_admin().is_none());
    assert_eq!(
        events,
        [DefaultAdminTransferred {
            old_admin: f.admin.clone(),
            new_admin: new_admin.clone(),
        }
        .to_xdr(&f.env, &f.proxy.address)]
    );
}

#[test]
fn old_admin_loses_power_after_transfer() {
    let f = setup();
    let new_admin = Address::generate(&f.env);
    f.proxy.begin_default_admin_transfer(&new_admin);
    f.env.ledger().set_timestamp(T0 + 101);
    f.proxy.accept_default_admin_transfer();
    f.proxy.add_authorized_settler(&f.settler);
    assert_eq!(f.env.auths()[0].0, new_admin);
}

#[test]
fn accept_requires_pending_admin_auth() {
    let f = setup();
    let new_admin = Address::generate(&f.env);
    f.proxy.begin_default_admin_transfer(&new_admin);
    f.env.ledger().set_timestamp(T0 + 101);
    f.env.set_auths(&[]);
    // The old admin signing is not enough.
    let res = f
        .proxy
        .mock_auths(&[MockAuth {
            address: &f.admin,
            invoke: &MockAuthInvoke {
                contract: &f.proxy.address,
                fn_name: "accept_default_admin_transfer",
                args: ().into_val(&f.env),
                sub_invokes: &[],
            },
        }])
        .try_accept_default_admin_transfer();
    assert!(res.is_err());
    assert_eq!(f.proxy.default_admin(), f.admin);
}

#[test]
fn accept_without_pending_transfer_fails() {
    let f = setup();
    assert_eq!(
        f.proxy
            .try_accept_default_admin_transfer()
            .unwrap_err()
            .unwrap(),
        Error::NoPendingAdminTransfer
    );
}

#[test]
fn admin_can_cancel_a_pending_transfer() {
    let f = setup();
    let new_admin = Address::generate(&f.env);
    f.proxy.begin_default_admin_transfer(&new_admin);
    f.proxy.cancel_default_admin_transfer();
    let events = f.proxy_events();
    assert_eq!(
        events,
        [DefaultAdminTransferCanceled {
            admin: f.admin.clone()
        }
        .to_xdr(&f.env, &f.proxy.address)]
    );
    assert!(f.proxy.pending_default_admin().is_none());
    f.env.ledger().set_timestamp(T0 + 1000);
    assert_eq!(
        f.proxy
            .try_accept_default_admin_transfer()
            .unwrap_err()
            .unwrap(),
        Error::NoPendingAdminTransfer
    );
    assert_eq!(
        f.proxy
            .try_cancel_default_admin_transfer()
            .unwrap_err()
            .unwrap(),
        Error::NoPendingAdminTransfer
    );
}

#[test]
fn beginning_a_second_transfer_replaces_the_first_and_restarts_the_clock() {
    let f = setup();
    let first = Address::generate(&f.env);
    let second = Address::generate(&f.env);
    f.proxy.begin_default_admin_transfer(&first);
    f.env.ledger().set_timestamp(T0 + 50);
    f.proxy.begin_default_admin_transfer(&second);
    let pending = f.proxy.pending_default_admin().unwrap();
    assert_eq!(pending.admin, second);
    assert_eq!(pending.accept_after, T0 + 150);
    f.env.ledger().set_timestamp(T0 + 151);
    f.proxy.accept_default_admin_transfer();
    assert_eq!(f.proxy.default_admin(), second);
}

const FIVE_DAYS: u64 = 5 * 24 * 60 * 60;

fn pending_delay(f: &Fx) -> Option<(u32, u64)> {
    f.proxy
        .pending_default_admin_delay()
        .map(|p| (p.new_delay, p.effective_at))
}

#[test]
fn delay_increase_waits_min_of_new_delay_and_five_days() {
    let f = setup();
    // Small increase: waits the new delay itself.
    f.proxy.change_default_admin_delay(&500);
    assert_eq!(
        f.proxy_events(),
        [AdminDelayChangeScheduled {
            new_delay: 500,
            effective_at: T0 + 500
        }
        .to_xdr(&f.env, &f.proxy.address)]
    );
    assert_eq!(pending_delay(&f), Some((500, T0 + 500)));
    // Large increase: capped at five days.
    f.proxy.change_default_admin_delay(&(FIVE_DAYS as u32 * 3));
    assert_eq!(
        pending_delay(&f),
        Some((FIVE_DAYS as u32 * 3, T0 + FIVE_DAYS))
    );
}

#[test]
fn delay_decrease_waits_the_difference() {
    let f = setup();
    f.proxy.change_default_admin_delay(&40);
    assert_eq!(pending_delay(&f), Some((40, T0 + 60)));
    // Decrease to zero waits the whole current delay.
    f.proxy.change_default_admin_delay(&0);
    assert_eq!(pending_delay(&f), Some((0, T0 + 100)));
}

#[test]
fn scheduled_delay_is_not_effective_early_and_applies_lazily() {
    let f = setup();
    f.proxy.change_default_admin_delay(&500);
    // At and before the effective time the old delay governs (strictly after, as the escrow).
    f.env.ledger().set_timestamp(T0 + 500);
    assert_eq!(f.proxy.default_admin_delay(), DELAY);
    assert_eq!(pending_delay(&f), Some((500, T0 + 500)));
    let early = Address::generate(&f.env);
    f.proxy.begin_default_admin_transfer(&early);
    assert_eq!(
        f.proxy.pending_default_admin().unwrap().accept_after,
        T0 + 500 + u64::from(DELAY)
    );
    // After it, the new delay is in force with no transaction needed, and governs new transfers.
    f.env.ledger().set_timestamp(T0 + 501);
    assert_eq!(f.proxy.default_admin_delay(), 500);
    assert_eq!(pending_delay(&f), None);
    let late = Address::generate(&f.env);
    f.proxy.begin_default_admin_transfer(&late);
    assert_eq!(
        f.proxy.pending_default_admin().unwrap().accept_after,
        T0 + 501 + 500
    );
    assert_eq!(f.proxy.default_admin_delay(), 500);
}

#[test]
fn delay_change_rollback_cancels_the_schedule() {
    let f = setup();
    assert_eq!(
        f.proxy
            .try_rollback_default_admin_delay()
            .unwrap_err()
            .unwrap(),
        Error::NoPendingDelayChange
    );
    f.proxy.change_default_admin_delay(&500);
    let _ = f.proxy_events();
    f.proxy.rollback_default_admin_delay();
    assert_eq!(
        f.proxy_events(),
        [AdminDelayChangeCanceled {
            admin: f.admin.clone()
        }
        .to_xdr(&f.env, &f.proxy.address)]
    );
    assert_eq!(pending_delay(&f), None);
    f.env.ledger().set_timestamp(T0 + 10_000);
    assert_eq!(f.proxy.default_admin_delay(), DELAY);
    // An already-elapsed change cannot be rolled back.
    f.proxy.change_default_admin_delay(&500);
    f.env.ledger().set_timestamp(T0 + 20_000);
    assert_eq!(
        f.proxy
            .try_rollback_default_admin_delay()
            .unwrap_err()
            .unwrap(),
        Error::NoPendingDelayChange
    );
    assert_eq!(f.proxy.default_admin_delay(), 500);
}

#[test]
fn compromised_admin_cannot_zero_the_delay_and_transfer_in_one_ledger() {
    let f = setup();
    let attacker = Address::generate(&f.env);
    f.proxy.change_default_admin_delay(&0);
    f.proxy.begin_default_admin_transfer(&attacker);
    // Same ledger: the delay is still DELAY, so the transfer is not acceptable.
    assert_eq!(
        f.proxy.pending_default_admin().unwrap().accept_after,
        T0 + u64::from(DELAY)
    );
    assert_eq!(
        f.proxy
            .try_accept_default_admin_transfer()
            .unwrap_err()
            .unwrap(),
        Error::AdminTransferNotReady
    );
    // Even one ledger later, before the old delay has elapsed.
    f.env.ledger().set_timestamp(T0 + 1);
    assert_eq!(
        f.proxy
            .try_accept_default_admin_transfer()
            .unwrap_err()
            .unwrap(),
        Error::AdminTransferNotReady
    );
    assert_eq!(f.proxy.default_admin(), f.admin);
}

#[test]
fn delay_change_overflow_is_an_error() {
    let f = setup();
    f.env.ledger().set_timestamp(u64::MAX);
    assert_eq!(
        f.proxy
            .try_change_default_admin_delay(&500)
            .unwrap_err()
            .unwrap(),
        Error::TimestampOverflow
    );
}

#[test]
fn begin_transfer_overflow_is_an_error() {
    let f = setup();
    f.env.ledger().set_timestamp(u64::MAX);
    assert_eq!(
        f.proxy
            .try_begin_default_admin_transfer(&Address::generate(&f.env))
            .unwrap_err()
            .unwrap(),
        Error::TimestampOverflow
    );
}

#[test]
fn constructor_sets_initial_state() {
    let f = setup();
    assert_eq!(f.proxy.default_admin(), f.admin);
    assert_eq!(f.proxy.pauser(), f.pauser);
    assert_eq!(f.proxy.default_admin_delay(), DELAY);
    assert!(!f.proxy.is_paused());
    assert!(!f.proxy.settler_allowlist_enforced());
    assert!(f.proxy.pending_default_admin().is_none());
}

#[test]
fn an_entrypoint_extends_the_code_entry_with_the_instance() {
    use soroban_sdk::testutils::Deployer as _;
    let f = setup();
    let code_before = f.env.deployer().get_contract_code_ttl(&f.proxy.address);
    f.proxy.pause();
    let code = f.env.deployer().get_contract_code_ttl(&f.proxy.address);
    let instance = f.env.deployer().get_contract_instance_ttl(&f.proxy.address);
    assert!(code > code_before);
    assert_eq!(code, instance);
}

#[test]
fn replacing_a_pending_admin_transfer_emits_canceled_before_the_new_schedule() {
    let f = setup();
    let first = Address::generate(&f.env);
    let second = Address::generate(&f.env);
    f.proxy.begin_default_admin_transfer(&first);
    // Nothing pending yet: only the schedule
    assert_eq!(
        f.proxy_events(),
        [DefaultAdminTransferScheduled {
            new_admin: first.clone(),
            accept_after: T0 + 100
        }
        .to_xdr(&f.env, &f.proxy.address)]
    );
    f.env.ledger().set_timestamp(T0 + 50);
    f.proxy.begin_default_admin_transfer(&second);
    assert_eq!(
        f.proxy_events(),
        [
            DefaultAdminTransferCanceled {
                admin: f.admin.clone()
            }
            .to_xdr(&f.env, &f.proxy.address),
            DefaultAdminTransferScheduled {
                new_admin: second.clone(),
                accept_after: T0 + 150
            }
            .to_xdr(&f.env, &f.proxy.address)
        ]
    );
    assert_eq!(f.proxy.pending_default_admin().unwrap().admin, second);
    // After an explicit cancel nothing is pending, so a new schedule is not a replacement
    f.proxy.cancel_default_admin_transfer();
    f.proxy.begin_default_admin_transfer(&first);
    assert_eq!(f.proxy_events().events().len(), 1);
}

#[test]
fn replacing_a_pending_delay_change_emits_canceled_before_the_new_schedule() {
    let f = setup();
    f.proxy.change_default_admin_delay(&500);
    assert_eq!(
        f.proxy_events(),
        [AdminDelayChangeScheduled {
            new_delay: 500,
            effective_at: T0 + 500
        }
        .to_xdr(&f.env, &f.proxy.address)]
    );
    // Still pending: the second change replaces it
    f.proxy.change_default_admin_delay(&800);
    assert_eq!(
        f.proxy_events(),
        [
            AdminDelayChangeCanceled {
                admin: f.admin.clone()
            }
            .to_xdr(&f.env, &f.proxy.address),
            AdminDelayChangeScheduled {
                new_delay: 800,
                effective_at: T0 + 800
            }
            .to_xdr(&f.env, &f.proxy.address)
        ]
    );
    // A change that has already taken effect is folded into the current delay, not replaced
    f.env.ledger().set_timestamp(T0 + 801);
    f.proxy.change_default_admin_delay(&900);
    assert_eq!(f.proxy_events().events().len(), 1);
    // After a rollback nothing is pending
    f.proxy.rollback_default_admin_delay();
    f.proxy.change_default_admin_delay(&950);
    assert_eq!(f.proxy_events().events().len(), 1);
}

#[test]
fn deployment_publishes_one_genesis_event() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let pauser = Address::generate(&env);
    let id = env.register(FulfillmentProxy, (&admin, &pauser, DELAY));
    let events = env.events().all().filter_by_contract(&id);
    assert_eq!(events.events().len(), 1);
    let soroban_sdk::xdr::ContractEventBody::V0(v0) = &events.events()[0].body;
    assert!(matches!(
        v0.topics.first(),
        Some(soroban_sdk::xdr::ScVal::Symbol(s)) if s.to_utf8_string_lossy() == "proxy_initialized"
    ));
}

// ---- typed: compiles only once the event exists

#[test]
fn the_genesis_event_carries_the_initial_authorities_and_the_dormant_allowlist_flag() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let pauser = Address::generate(&env);
    let id = env.register(FulfillmentProxy, (&admin, &pauser, DELAY));
    assert_eq!(
        env.events().all().filter_by_contract(&id),
        [crate::ProxyInitialized {
            default_admin: admin,
            pauser,
            delay_seconds: DELAY,
            enforce_settler_allowlist: false
        }
        .to_xdr(&env, &id)]
    );
}

// ---- TTL at mainnet limits ----

mod mainnet_ttl {
    use super::*;
    use soroban_sdk::testutils::storage::Instance as _;

    /// Mainnet network limits: a persistent entry or instance starts at `MIN_PERSISTENT` ledgers and
    /// no extension may go past `MAX_ENTRY`. The longest live TTL is one ledger less, because the
    /// maximum counts the current ledger: that is what `Storage::max_ttl` returns.
    const MIN_PERSISTENT: u32 = 2_073_600;
    const MAX_ENTRY: u32 = 3_110_400;
    const MAX_TTL: u32 = MAX_ENTRY - 1;

    /// A proxy and a funded settler under the given limits, which are set before anything is
    /// created so that new entries start at `min_persistent`, as on a live network.
    fn on_network<'a>(
        min_persistent: u32,
        max_entry: u32,
    ) -> (Env, FulfillmentProxyClient<'a>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(T0);
        env.ledger().with_mut(|li| {
            li.min_persistent_entry_ttl = min_persistent;
            li.max_entry_ttl = max_entry;
        });
        let admin = Address::generate(&env);
        let id = env.register(FulfillmentProxy, (&admin, &Address::generate(&env), DELAY));
        let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
        let settler = Address::generate(&env);
        StellarAssetClient::new(&env, &sac.address()).mint(&settler, &1_000);
        let proxy = FulfillmentProxyClient::new(&env, &id);
        (env, proxy, settler, sac.address())
    }

    fn ttl_of(env: &Env, proxy: &Address, key: &DataKey) -> u32 {
        env.as_contract(proxy, || env.storage().persistent().get_ttl(key))
    }

    #[test]
    fn a_new_strict_marker_is_extended_to_the_horizon_at_mainnet_limits() {
        let (env, proxy, settler, token) = on_network(MIN_PERSISTENT, MAX_ENTRY);
        let quote = h(&env, 1);
        let to = Address::generate(&env);
        proxy.strict_fulfill(&settler, &quote, &to, &token, &10, &(T0 + 10), &1);
        // The entry started at the network minimum (2,073,600 ledgers, about 120 days); the
        // extension must lift it to the policy horizon, the network maximum, not leave it there.
        let ttl = ttl_of(
            &env,
            &proxy.address,
            &DataKey::StrictFulfilled(quote, to, token, 10),
        );
        assert_eq!(ttl, MAX_TTL, "a new marker kept the network minimum TTL");
    }

    #[test]
    fn a_new_settler_entry_is_extended_to_the_horizon_at_mainnet_limits() {
        let (env, proxy, settler, _) = on_network(MIN_PERSISTENT, MAX_ENTRY);
        proxy.add_authorized_settler(&settler);
        let ttl = ttl_of(&env, &proxy.address, &DataKey::Settler(settler));
        assert_eq!(
            ttl, MAX_TTL,
            "a new settler entry kept the network minimum TTL"
        );
    }

    #[test]
    fn the_instance_is_extended_to_the_horizon_at_mainnet_limits() {
        let (env, proxy, settler, token) = on_network(MIN_PERSISTENT, MAX_ENTRY);
        proxy.authorize_fulfillment(&settler, &h(&env, 1), &h(&env, 2));
        let _ = token;
        let ttl = env.as_contract(&proxy.address, || env.storage().instance().get_ttl());
        assert_eq!(ttl, MAX_TTL, "the instance kept the network minimum TTL");
    }

    #[test]
    fn the_extension_is_capped_at_a_lower_network_maximum() {
        // A network whose maximum is below the horizon: the extension is capped, and does not trap.
        let (env, proxy, settler, token) = on_network(1_000, 200_000);
        let quote = h(&env, 1);
        let to = Address::generate(&env);
        proxy.strict_fulfill(&settler, &quote, &to, &token, &10, &(T0 + 10), &1);
        let ttl = ttl_of(
            &env,
            &proxy.address,
            &DataKey::StrictFulfilled(quote, to, token, 10),
        );
        assert_eq!(ttl, 199_999);
    }
}

// ---- replay of a failed fulfilment's authorization ----

mod replay {
    use super::*;
    use soroban_sdk::{
        auth::{Context, CustomAccountInterface},
        contract, contractimpl,
        crypto::Hash,
        vec as svec,
        xdr::{
            InvokeContractArgs, ScAddress, ScSymbol, ScVal, SorobanAddressCredentials,
            SorobanAuthorizationEntry, SorobanAuthorizedFunction, SorobanAuthorizedInvocation,
            SorobanCredentials, VecM,
        },
        TryFromVal, Val, Vec,
    };

    /// A contract account that accepts any signature: its authorization entry carries an address
    /// credential, so the host spends a nonce for it, as for a signing contract account.
    #[contract]
    struct OpenAccount;

    #[contractimpl]
    impl CustomAccountInterface for OpenAccount {
        type Signature = ();
        type Error = Error;

        fn __check_auth(
            _env: Env,
            _payload: Hash<32>,
            _signature: (),
            _contexts: Vec<Context>,
        ) -> Result<(), Error> {
            Ok(())
        }
    }

    fn sc(a: &Address) -> ScAddress {
        ScAddress::from(a)
    }

    fn call(env: &Env, contract: &Address, name: &str, args: Vec<Val>) -> InvokeContractArgs {
        let args: std::vec::Vec<ScVal> = args
            .iter()
            .map(|v| ScVal::try_from_val(env, &v).unwrap())
            .collect();
        InvokeContractArgs {
            contract_address: sc(contract),
            function_name: ScSymbol(name.try_into().unwrap()),
            args: args.try_into().unwrap(),
        }
    }

    /// A signed authorization for `fulfill(settler, quote, to, token, amount, DL, nonce)` and the token transfer
    /// it performs, under the host nonce `nonce`, as one entry the settler hands to a submitter.
    fn entry(
        f: &Fx,
        settler: &Address,
        host_nonce: i64,
        nonce: u64,
        amount: i128,
    ) -> SorobanAuthorizationEntry {
        let env = &f.env;
        let root = call(
            env,
            &f.proxy.address,
            "fulfill",
            svec![
                env,
                settler.to_val(),
                h(env, 7).to_val(),
                f.recipient.to_val(),
                f.token.address.to_val(),
                amount.into_val(env),
                DL.into_val(env),
                nonce.into_val(env)
            ],
        );
        let transfer = call(
            env,
            &f.token.address,
            "transfer",
            svec![
                env,
                settler.to_val(),
                f.recipient.to_val(),
                amount.into_val(env)
            ],
        );
        let sub: VecM<SorobanAuthorizedInvocation> = std::vec![SorobanAuthorizedInvocation {
            function: SorobanAuthorizedFunction::ContractFn(transfer),
            sub_invocations: VecM::default(),
        }]
        .try_into()
        .unwrap();
        SorobanAuthorizationEntry {
            credentials: SorobanCredentials::Address(SorobanAddressCredentials {
                address: sc(settler),
                nonce: host_nonce,
                signature_expiration_ledger: 1_000,
                signature: ScVal::Void,
            }),
            root_invocation: SorobanAuthorizedInvocation {
                function: SorobanAuthorizedFunction::ContractFn(root),
                sub_invocations: sub,
            },
        }
    }

    fn submit(
        f: &Fx,
        settler: &Address,
        e: &SorobanAuthorizationEntry,
        nonce: u64,
        amount: i128,
    ) -> Result<(), Error> {
        f.env.set_auths(core::slice::from_ref(e));
        f.proxy
            .try_fulfill(
                settler,
                &h(&f.env, 7),
                &f.recipient,
                &f.token.address,
                &amount,
                &DL,
                &nonce,
            )
            .map_err(|e| e.unwrap())
            .map(|r| r.unwrap())
    }

    #[test]
    fn a_failed_fulfill_authorization_cannot_be_replayed_after_a_retry_lands() {
        let f = setup();
        let settler = f.env.register(OpenAccount, ());
        StellarAssetClient::new(&f.env, &f.token.address).mint(&settler, &500);
        f.env.set_auths(&[]);

        // The first attempt fails after `require_auth` (the settler is short of the amount).
        let first = entry(&f, &settler, 1, 9, 600);
        assert!(submit(&f, &settler, &first, 9, 600).is_err());
        assert_eq!(f.token.balance(&f.recipient), 0);

        // The settler tops up and retries under a new host nonce and the same settler nonce. It lands.
        f.env.mock_all_auths();
        StellarAssetClient::new(&f.env, &f.token.address).mint(&settler, &1_000);
        f.env.set_auths(&[]);
        let retry = entry(&f, &settler, 2, 9, 600);
        submit(&f, &settler, &retry, 9, 600).unwrap();
        assert_eq!(f.token.balance(&f.recipient), 600);

        // The first signed entry is still public. Submitting it must not pay a second time.
        assert_eq!(
            submit(&f, &settler, &first, 9, 600),
            Err(Error::NonceAlreadyUsed)
        );
        assert_eq!(f.token.balance(&f.recipient), 600);
    }

    #[test]
    fn a_failed_fulfill_authorization_stops_paying_at_its_deadline() {
        let f = setup();
        let settler = f.env.register(OpenAccount, ());
        StellarAssetClient::new(&f.env, &f.token.address).mint(&settler, &500);
        f.env.set_auths(&[]);

        let first = entry(&f, &settler, 1, 9, 600);
        assert!(submit(&f, &settler, &first, 9, 600).is_err());

        // The settler is topped up, but the quote's window has passed: the stale entry reverts.
        f.env.mock_all_auths();
        StellarAssetClient::new(&f.env, &f.token.address).mint(&settler, &1_000);
        f.env.set_auths(&[]);
        f.env.ledger().set_timestamp(DL + 1);
        assert_eq!(
            submit(&f, &settler, &first, 9, 600),
            Err(Error::DeadlineExpired)
        );
        assert_eq!(f.token.balance(&f.recipient), 0);
    }
}

// ---- settler nonce and fulfill deadline ----

#[test]
fn fulfill_nonce_is_single_use_per_settler() {
    let f = setup();
    let go = |nonce: u64| {
        f.proxy
            .try_fulfill(
                &f.settler,
                &h(&f.env, 1),
                &f.recipient,
                &f.token.address,
                &10,
                &DL,
                &nonce,
            )
            .map_err(|e| e.unwrap())
            .map(|r| r.unwrap())
    };
    go(5).unwrap();
    assert_eq!(go(5), Err(Error::NonceAlreadyUsed));
    assert_eq!(f.token.balance(&f.recipient), 10);
    // Another nonce is unaffected, and so is the same nonce for another settler.
    go(6).unwrap();
    let other = Address::generate(&f.env);
    StellarAssetClient::new(&f.env, &f.token.address).mint(&other, &100);
    f.proxy.fulfill(
        &other,
        &h(&f.env, 1),
        &f.recipient,
        &f.token.address,
        &10,
        &DL,
        &5,
    );
    assert_eq!(f.token.balance(&f.recipient), 30);
}

#[test]
fn fulfill_and_strict_fulfill_share_one_nonce_space() {
    let f = setup();
    f.proxy.fulfill(
        &f.settler,
        &h(&f.env, 1),
        &f.recipient,
        &f.token.address,
        &10,
        &DL,
        &3,
    );
    let res = f.proxy.try_strict_fulfill(
        &f.settler,
        &h(&f.env, 2),
        &f.recipient,
        &f.token.address,
        &10,
        &DL,
        &3,
    );
    assert_eq!(res.unwrap_err().unwrap(), Error::NonceAlreadyUsed);
    // The refused strict call left no marker, and its own fresh nonce works.
    assert!(!f
        .proxy
        .is_strictly_fulfilled(&h(&f.env, 2), &f.recipient, &f.token.address, &10));
    f.strict(2, 10, DL).unwrap();
}

#[test]
fn a_failed_call_does_not_spend_its_nonce() {
    let f = setup();
    // Too large for the settler's balance: the transfer traps and the nonce write rolls back.
    assert!(f
        .proxy
        .try_fulfill(
            &f.settler,
            &h(&f.env, 1),
            &f.recipient,
            &f.token.address,
            &2_000_000,
            &DL,
            &4,
        )
        .is_err());
    f.proxy.fulfill(
        &f.settler,
        &h(&f.env, 1),
        &f.recipient,
        &f.token.address,
        &10,
        &DL,
        &4,
    );
    assert_eq!(f.token.balance(&f.recipient), 10);
}

#[test]
fn nonce_bitmap_words_are_independent() {
    let f = setup();
    for nonce in [0u64, 127, 128, 255, u64::MAX] {
        f.proxy.fulfill(
            &f.settler,
            &h(&f.env, 1),
            &f.recipient,
            &f.token.address,
            &1,
            &DL,
            &nonce,
        );
    }
    for nonce in [0u64, 127, 128, 255, u64::MAX] {
        let res = f.proxy.try_fulfill(
            &f.settler,
            &h(&f.env, 1),
            &f.recipient,
            &f.token.address,
            &1,
            &DL,
            &nonce,
        );
        assert_eq!(res.unwrap_err().unwrap(), Error::NonceAlreadyUsed);
    }
    // Neighbours of a spent bit in the same word are still free.
    f.nonce.set(1);
    f.fulfill(1, 1).unwrap();
    assert_eq!(f.token.balance(&f.recipient), 6);
}

#[test]
fn fulfill_deadline_is_inclusive_and_refused_after() {
    let f = setup();
    let go = |deadline: u64, nonce: u64| {
        f.proxy
            .try_fulfill(
                &f.settler,
                &h(&f.env, 1),
                &f.recipient,
                &f.token.address,
                &10,
                &deadline,
                &nonce,
            )
            .map_err(|e| e.unwrap())
            .map(|r| r.unwrap())
    };
    go(T0, 1).unwrap();
    f.env.ledger().set_timestamp(T0 + 1);
    assert_eq!(go(T0, 2), Err(Error::DeadlineExpired));
    // The refused call did not spend its nonce.
    go(T0 + 1, 2).unwrap();
    assert_eq!(f.token.balance(&f.recipient), 20);
}

// ---- strict marker keyed on the payment ----

mod payment_marker {
    use super::*;
    use soroban_sdk::{contract, contractimpl, MuxedAddress};

    /// A token whose `transfer` accepts and moves nothing: what a listed rival can pass as `token`
    /// to burn a marker for the price of fees.
    #[contract]
    struct NullToken;

    #[contractimpl]
    impl NullToken {
        pub fn transfer(_env: Env, _from: Address, _to: MuxedAddress, _amount: i128) {}
    }

    fn null_token(env: &Env) -> Address {
        env.register(NullToken, ())
    }

    /// A funded settler other than `f.settler`.
    fn funded_rival(f: &Fx) -> Address {
        let rival = Address::generate(&f.env);
        StellarAssetClient::new(&f.env, &f.token.address).mint(&rival, &1_000_000);
        rival
    }

    fn strict_as(
        f: &Fx,
        settler: &Address,
        quote: u8,
        to: &Address,
        token: &Address,
        amount: i128,
        nonce: u64,
    ) -> Result<(), Error> {
        f.proxy
            .try_strict_fulfill(
                settler,
                &h(&f.env, quote),
                to,
                token,
                &amount,
                &(T0 + 10),
                &nonce,
            )
            .map_err(|e| e.unwrap())
            .map(|r| r.unwrap())
    }

    fn marked(f: &Fx, quote: u8, to: &Address, token: &Address, amount: i128) -> bool {
        f.proxy
            .is_strictly_fulfilled(&h(&f.env, quote), to, token, &amount)
    }

    /// The audit's proof of concept: a listed rival strict-fulfils the quote with a token that moves
    /// nothing and amount 1. It used to burn the quote's marker for good, so the awarded settler's
    /// call with the real payment reverted `AlreadyFulfilled`.
    #[test]
    fn a_rival_burn_with_a_worthless_token_does_not_block_the_awarded_settler() {
        let f = setup();
        let rival = funded_rival(&f);
        f.proxy.add_authorized_settler(&f.settler);
        f.proxy.add_authorized_settler(&rival);
        f.proxy.set_settler_allowlist_enforced(&true);
        let worthless = null_token(&f.env);

        strict_as(&f, &rival, 9, &f.recipient, &worthless, 1, 0).unwrap();
        assert_eq!(f.token.balance(&f.recipient), 0);
        // The burn consumed only its own key.
        assert!(marked(&f, 9, &f.recipient, &worthless, 1));
        assert!(!marked(&f, 9, &f.recipient, &f.token.address, 300));

        strict_as(&f, &f.settler, 9, &f.recipient, &f.token.address, 300, 0).unwrap();
        assert_eq!(f.token.balance(&f.recipient), 300);
        assert!(marked(&f, 9, &f.recipient, &f.token.address, 300));
    }

    #[test]
    fn an_identical_payment_reverts_already_fulfilled_from_any_settler() {
        let f = setup();
        let rival = funded_rival(&f);
        strict_as(&f, &f.settler, 1, &f.recipient, &f.token.address, 10, 0).unwrap();
        assert_eq!(
            strict_as(&f, &f.settler, 1, &f.recipient, &f.token.address, 10, 1),
            Err(Error::AlreadyFulfilled)
        );
        assert_eq!(
            strict_as(&f, &rival, 1, &f.recipient, &f.token.address, 10, 0),
            Err(Error::AlreadyFulfilled)
        );
        assert_eq!(f.token.balance(&f.recipient), 10);
    }

    #[test]
    fn a_different_amount_token_or_recipient_uses_its_own_key() {
        let f = setup();
        let other_to = Address::generate(&f.env);
        let other_token = f
            .env
            .register_stellar_asset_contract_v2(Address::generate(&f.env))
            .address();
        StellarAssetClient::new(&f.env, &other_token).mint(&f.settler, &1_000);

        strict_as(&f, &f.settler, 1, &f.recipient, &f.token.address, 10, 0).unwrap();
        // Same quote hash, each differing from the first in exactly one field.
        strict_as(&f, &f.settler, 1, &f.recipient, &f.token.address, 11, 1).unwrap();
        strict_as(&f, &f.settler, 1, &other_to, &f.token.address, 10, 2).unwrap();
        strict_as(&f, &f.settler, 1, &f.recipient, &other_token, 10, 3).unwrap();

        assert!(marked(&f, 1, &f.recipient, &f.token.address, 10));
        assert!(marked(&f, 1, &f.recipient, &f.token.address, 11));
        assert!(marked(&f, 1, &other_to, &f.token.address, 10));
        assert!(marked(&f, 1, &f.recipient, &other_token, 10));
        // A combination nobody paid is still unmarked.
        assert!(!marked(&f, 1, &other_to, &f.token.address, 11));
        assert_eq!(f.token.balance(&f.recipient), 21);
        assert_eq!(f.token.balance(&other_to), 10);
    }

    /// The rival pays the exact real payment first, from its own funds. That is a real delivery, so
    /// the awarded settler's identical call reverts: the residual of keying on the payment. The
    /// offchain verifier matches quote hash, recipient, token and exact amount, and does not match the
    /// settler, so it still sees the payment.
    #[test]
    fn a_rival_paying_the_exact_real_payment_first_makes_the_awarded_call_revert() {
        let f = setup();
        let rival = funded_rival(&f);
        f.proxy.add_authorized_settler(&f.settler);
        f.proxy.add_authorized_settler(&rival);
        f.proxy.set_settler_allowlist_enforced(&true);

        strict_as(&f, &rival, 9, &f.recipient, &f.token.address, 300, 0).unwrap();
        assert_eq!(f.token.balance(&f.recipient), 300);
        assert_eq!(
            strict_as(&f, &f.settler, 9, &f.recipient, &f.token.address, 300, 0),
            Err(Error::AlreadyFulfilled)
        );
        // Nothing moved from the settler, and its nonce was not spent by the reverted call.
        assert_eq!(f.token.balance(&f.settler), 1_000_000);
        strict_as(&f, &f.settler, 9, &f.recipient, &f.token.address, 301, 0).unwrap();
    }

    #[test]
    fn an_enforced_allowlist_still_blocks_an_unlisted_burner() {
        let f = setup();
        let rival = funded_rival(&f);
        f.proxy.add_authorized_settler(&f.settler);
        f.proxy.set_settler_allowlist_enforced(&true);
        let worthless = null_token(&f.env);

        assert_eq!(
            strict_as(&f, &rival, 9, &f.recipient, &worthless, 1, 0),
            Err(Error::UnauthorizedSettler)
        );
        assert!(!marked(&f, 9, &f.recipient, &worthless, 1));
        strict_as(&f, &f.settler, 9, &f.recipient, &f.token.address, 300, 0).unwrap();
    }

    #[test]
    fn a_reused_nonce_still_reverts_even_for_a_different_payment() {
        let f = setup();
        strict_as(&f, &f.settler, 1, &f.recipient, &f.token.address, 10, 7).unwrap();
        assert_eq!(
            strict_as(&f, &f.settler, 1, &f.recipient, &f.token.address, 11, 7),
            Err(Error::NonceAlreadyUsed)
        );
        // The refused call left no marker for its payment.
        assert!(!marked(&f, 1, &f.recipient, &f.token.address, 11));
        strict_as(&f, &f.settler, 1, &f.recipient, &f.token.address, 11, 8).unwrap();
    }
}
