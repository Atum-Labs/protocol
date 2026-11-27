use soroban_sdk::{contractevent, Address, BytesN};

/// `quote_hash` is the first topic after the name because it is the correlation key the off-chain settler
/// and verifier join on (the Solana events lead with it too). `settler` is a topic, as on EVM, so a
/// scanner filtering by topic can learn who settled without fetching the transaction.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Fulfilled {
    #[topic]
    pub quote_hash: BytesN<32>,
    #[topic]
    pub settler: Address,
    pub to: Address,
    pub token: Address,
    pub amount: i128,
    pub timestamp: u64,
}

/// Emitted when a settler authorizes a fulfillment without moving tokens. All three fields are
/// topics, matching EVM's three indexed fields.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FulfillmentAuthorized {
    #[topic]
    pub authorization_hash: BytesN<32>,
    #[topic]
    pub quote_hash: BytesN<32>,
    #[topic]
    pub settler: Address,
}

/// The EVM event name, `SettlerAllowlistEnforcementSet`, snake-cased is 33 characters, one over the
/// 32-character topic limit, so the topic is shortened; the Rust type keeps the EVM name.
#[contractevent(topics = ["settler_allowlist_enforced"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettlerAllowlistEnforcementSet {
    pub enforced: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthorizedSettlerAdded {
    #[topic]
    pub settler: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthorizedSettlerRemoved {
    #[topic]
    pub settler: Address,
}

/// The genesis entry of the event stream: the constructor's initial authorities and the dormant
/// allowlist flag
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProxyInitialized {
    #[topic]
    pub default_admin: Address,
    pub pauser: Address,
    pub delay_seconds: u32,
    pub enforce_settler_allowlist: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProxyPaused {
    pub by: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProxyUnpaused {
    pub by: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PauserUpdated {
    pub old_pauser: Address,
    pub new_pauser: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DefaultAdminTransferScheduled {
    #[topic]
    pub new_admin: Address,
    pub accept_after: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DefaultAdminTransferCanceled {
    #[topic]
    pub admin: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DefaultAdminTransferred {
    pub old_admin: Address,
    pub new_admin: Address,
}

/// A delay change was scheduled; `new_delay` is the current delay from `effective_at` on.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminDelayChangeScheduled {
    pub new_delay: u32,
    pub effective_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminDelayChangeCanceled {
    #[topic]
    pub admin: Address,
}
