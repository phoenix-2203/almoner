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

