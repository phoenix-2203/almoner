use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

pub type TaskId = u32;
pub type PurchaseId = u32;

/// Rules a person signs for one task. The owner's transaction that stores them
/// is the signature; `mandate_hash` (sha256 of the canonical JSON below) lets
/// agents prove they are acting on the version they read.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TaskInput {
    pub name: String,
    /// Plain-language purpose. Shown to people and to an optional off-chain
    /// reviewer; the contract itself enforces categories and blocked terms.
    pub purpose: String,
    /// Allowed item categories (lowercase). Empty = any category.
    pub categories: Vec<String>,
    /// Terms that must never appear in what is bought, even inside budget.
    /// Matched after decoding percent-escapes, leetspeak and spacing.
    pub blocked_terms: Vec<String>,
    /// Sellers this task may pay. Empty = any registered seller.
    pub allowed_sellers: Vec<AccountId>,
    /// Total the task may spend, in token base units.
    pub budget: U128,
    pub max_per_purchase: U128,
    /// Purchases strictly above this wait for the owner.
    pub approval_above: U128,
    pub max_purchases_per_hour: u32,
    /// Serve an identical earlier purchase for free within this window (0 = never reuse).
    pub reuse_window_ms: u64,
    /// Seller must deliver within this window or the buyer is refunded.
    pub delivery_window_ms: u64,
    /// Buyer must review within this window or payment releases to the seller.
    pub review_window_ms: u64,
    /// Task stops buying after this time (unix ms).
    pub expires_at_ms: u64,
}

