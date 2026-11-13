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

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskStatus {
    Active,
    Paused,
    Closed,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Task {
    pub id: TaskId,
    pub rules: TaskInput,
    pub status: TaskStatus,
    pub version: u32,
    pub mandate_hash: String,
    pub spent: u128,
    pub reserved: u128,
    pub created_ms: u64,
    pub updated_ms: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Agent {
    pub name: String,
    pub public_key: String,
    pub task_ids: Vec<TaskId>,
    pub active: bool,
    pub added_ms: u64,
    pub window_start_ms: u64,
    pub window_count: u32,
    pub requests: u32,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Seller {
    pub account_id: AccountId,
    pub name: String,
    pub about: String,
    /// ed25519 key the seller signs quotes with (32 bytes).
    pub quote_key: [u8; 32],
    pub on_hold: bool,
    pub hold_reason: String,
    pub registered_ms: u64,
    pub stats: SellerStats,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SellerStats {
    /// Delivered and accepted by the buyer.
    pub delivered_ok: u32,
    /// Delivered, buyer stayed silent, payment released after the review window.
    pub auto_released: u32,
    /// Delivered, buyer rejected it: refunded.
    pub rejected: u32,
    /// Never delivered before the deadline: refunded.
    pub missed: u32,
    /// Total paid out to this seller, token base units.
    pub earned: U128,
}

/// A price a seller signed. The agent forwards it; the contract checks the
/// signature, so the agent cannot change the price, the item or the payee.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Quote {
    pub seller: AccountId,
    pub item: String,
    pub category: String,
    pub description: String,
    pub price: U128,
    pub expires_at_ms: u64,
    pub nonce: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PurchaseStatus {
    /// Refused before any money moved. See `code`.
    Declined,
    /// Identical item already bought within the reuse window: served for $0.
    Reused,
    /// Above the approval line: waiting for the owner. Budget untouched.
    PendingApproval,
    /// Owner rejected a held purchase.
    Rejected,
    /// Funds reserved in the vault; waiting for the seller to deliver.
    Escrowed,
    /// Seller says delivered; waiting for the buyer's review.
    Delivered,
    /// Payment to the seller is in flight.
    PayoutPending,
    /// Seller paid.
    Paid,
    /// Reservation released back to the task: nothing was paid.
    Refunded,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Purchase {
    pub id: PurchaseId,
    pub task_id: TaskId,
    pub mandate_version: u32,
    pub agent: String,
    pub seller: AccountId,
    pub item: String,
    pub category: String,
    pub description: String,
    pub price: U128,
    pub reason: String,
    pub status: PurchaseStatus,
    /// Machine-readable decision code, e.g. APPROVED_ESCROW, INTENT_MISMATCH.
    pub code: String,
    /// Plain-language explanation of the decision.
    pub detail: String,
    pub quote_nonce: String,
    pub created_ms: u64,
    pub deliver_by_ms: u64,
    pub delivered_ms: u64,
    pub result_hash: Option<String>,
    pub review_by_ms: u64,
    pub settled_ms: u64,
    pub reused_from: Option<PurchaseId>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct LogEntry {
    pub seq: u32,
    pub at_ms: u64,
    pub kind: String,
    pub purchase_id: Option<PurchaseId>,
    pub code: String,
    pub prev_hash: String,
    /// sha256(hex) of "seq|at_ms|kind|purchase_id|code|prev_hash".
    pub hash: String,
}

