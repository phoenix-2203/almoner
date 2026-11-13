//! # Almoner Vault
//!
//! Every agent purchase, accounted for, and enforced by a NEAR contract.
//!
//! * The **owner** funds the vault with a NEP-141 stablecoin and signs a
//!   mandate per task: purpose, allowed categories, blocked terms, allowed
//!   sellers, budget, per-purchase cap, approval line, rate limit, windows.
//! * The vault **issues its own agent keys**: function-call access keys on the
//!   vault account, limited to `request_purchase`, `confirm_delivery` and
//!   `settle_expired`, with a gas allowance. They cannot transfer tokens or
//!   NEAR, add keys, or call anything else. Revoking deletes the key.
//! * **Sellers** register an ed25519 quote key and sign each price. The agent
//!   forwards the signed quote; it can't change the price, item or payee.
//! * Every request is checked in order: mandate version, assignment, task
//!   status, rate limit, idempotency, quote signature/expiry/replay, seller
//!   allow-list and hold, procurement memory (reuse for $0), IntentLock
//!   (category + disguised blocked terms), limits, budget, funds, approval.
//! * Approved purchases go into **escrow**. The seller delivers a result hash;
//!   the buyer accepts (pay) or rejects (refund, seller on hold). Missed
//!   delivery refunds; a silent buyer auto-releases payment to the seller.
//! * **Seller reputation** is computed only from escrow-settled purchases.
//! * Every decision, including refusals, is stored and hash-chained.

mod intent;
mod types;

#[cfg(test)]
mod tests;

pub use types::*;

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{
    env, ext_contract, near, require, AccountId, Allowance, BorshStorageKey, CurveType, Gas,
    NearToken, PanicOnDefault, Promise, PromiseOrValue, PublicKey,
};

pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
pub const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
pub const GAS_CALLBACK: Gas = Gas::from_tgas(15);
pub const SELLER_REGISTRATION_DEPOSIT: NearToken = NearToken::from_millinear(10);
/// Default gas allowance for an agent key: 0.25 NEAR of gas.
pub const DEFAULT_AGENT_ALLOWANCE: NearToken = NearToken::from_millinear(250);
pub const AGENT_METHODS: &str = "request_purchase,confirm_delivery,settle_expired";

const HOUR_MS: u64 = 3_600_000;
const MIN_WINDOW_MS: u64 = 60_000;
const MAX_WINDOW_MS: u64 = 7 * 24 * HOUR_MS;
const MAX_ITEM: usize = 256;
const MAX_TEXT: usize = 280;
const MAX_SHORT: usize = 64;

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

