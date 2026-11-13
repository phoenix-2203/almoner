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

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Tasks,
    Agents,
    Sellers,
    Purchases,
    Idempotency,
    Memory,
    QuoteNonces,
    Log,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner: AccountId,
    token: AccountId,
    frozen: bool,
    balance: u128,
    reserved: u128,
    next_task_id: TaskId,
    tasks: IterableMap<TaskId, Task>,
    agents: IterableMap<String, Agent>,
    sellers: IterableMap<AccountId, Seller>,
    purchases: Vector<Purchase>,
    idempotency: LookupMap<String, PurchaseId>,
    /// seller|item -> last paid purchase id (procurement memory).
    memory: LookupMap<String, PurchaseId>,
    /// seller|nonce -> used.
    quote_nonces: LookupMap<String, bool>,
    log: Vector<LogEntry>,
    log_head: String,
}

fn sha256_hex(data: &[u8]) -> String {
    hex(&env::sha256_array(data))
}

fn hex(bytes: &[u8]) -> String {
    const CHARS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(CHARS[(b >> 4) as usize] as char);
        s.push(CHARS[(b & 0xf) as usize] as char);
    }
    s
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

pub fn mandate_hash(rules: &TaskInput) -> String {
    let json = near_sdk::serde_json::to_string(rules).unwrap_or_else(|_| env::abort());
    sha256_hex(json.as_bytes())
}

/// Outcome of the checks in `request_purchase`.
enum Decision {
    Decline(&'static str, String),
    Reuse(PurchaseId, String),
    Hold(String),
    Escrow(String),
}

#[near]
impl Vault {
    #[init]
    pub fn new(owner: AccountId, token: AccountId) -> Self {
        let mut v = Self {
            owner,
            token,
            frozen: false,
            balance: 0,
            reserved: 0,
            next_task_id: 1,
            tasks: IterableMap::new(StorageKey::Tasks),
            agents: IterableMap::new(StorageKey::Agents),
            sellers: IterableMap::new(StorageKey::Sellers),
            purchases: Vector::new(StorageKey::Purchases),
            idempotency: LookupMap::new(StorageKey::Idempotency),
            memory: LookupMap::new(StorageKey::Memory),
            quote_nonces: LookupMap::new(StorageKey::QuoteNonces),
            log: Vector::new(StorageKey::Log),
            log_head: "0".repeat(64),
        };
        v.append_log("vault_created", None, "OK");
        v
    }

    // ------------------------------------------------------------------
    // Owner
    // ------------------------------------------------------------------

    pub fn create_task(&mut self, rules: TaskInput) -> TaskView {
        self.assert_owner();
        Self::validate_rules(&rules);
        let id = self.next_task_id;
        self.next_task_id += 1;
        let now = env::block_timestamp_ms();
        let task = Task {
            id,
            mandate_hash: mandate_hash(&rules),
            rules,
            status: TaskStatus::Active,
            version: 1,
            spent: 0,
            reserved: 0,
            created_ms: now,
            updated_ms: now,
        };
        self.emit("task_signed", near_sdk::serde_json::json!({
            "task_id": id, "version": 1, "mandate_hash": task.mandate_hash
        }));
        self.tasks.insert(id, task);
        self.append_log("task_signed", None, &format!("TASK_{}_V1", id));
        self.task_view(id)
    }

    /// Replace a task's rules. Bumps the version; agents holding the old
    /// mandate hash are refused until they re-read it.
    pub fn update_task(&mut self, task_id: TaskId, rules: TaskInput) -> TaskView {
        self.assert_owner();
        Self::validate_rules(&rules);
        let mut task = self.task_or_panic(task_id).clone();
        require!(task.status != TaskStatus::Closed, "task is closed");
        require!(
            rules.budget.0 >= task.spent + task.reserved,
            "budget below what is already spent and reserved"
        );
        task.version += 1;
        task.mandate_hash = mandate_hash(&rules);
        task.rules = rules;
        task.updated_ms = env::block_timestamp_ms();
        let code = format!("TASK_{}_V{}", task_id, task.version);
        self.emit("task_signed", near_sdk::serde_json::json!({
            "task_id": task_id, "version": task.version, "mandate_hash": task.mandate_hash
        }));
        self.tasks.insert(task_id, task);
        self.append_log("task_signed", None, &code);
        self.task_view(task_id)
    }

    pub fn set_task_status(&mut self, task_id: TaskId, status: TaskStatus) {
        self.assert_owner();
        let task = self.tasks.get_mut(&task_id).unwrap_or_else(|| env::panic_str("unknown task"));
        require!(task.status != TaskStatus::Closed, "task is closed");
        task.status = status;
        task.updated_ms = env::block_timestamp_ms();
        let code = format!("TASK_{}_{:?}", task_id, status).to_uppercase();
        self.append_log("task_status", None, &code);
    }

    /// Issue an agent key: a function-call access key on this vault account,
    /// restricted to the agent methods. The vault adds the key itself.
    pub fn add_agent(
        &mut self,
        public_key: PublicKey,
        name: String,
        task_ids: Vec<TaskId>,
        allowance: Option<NearToken>,
    ) -> Promise {
        self.assert_owner();
        let pk = String::from(&public_key);
        require!(!self.agents.get(&pk).map(|a| a.active).unwrap_or(false), "agent key already active");
        for id in &task_ids {
            require!(self.tasks.contains_key(id), "unknown task in task_ids");
        }
        self.agents.insert(
            pk.clone(),
            Agent {
                name: truncate(&name, MAX_SHORT),
                public_key: pk,
                task_ids,
                active: true,
                added_ms: env::block_timestamp_ms(),
                window_start_ms: 0,
                window_count: 0,
                requests: 0,
            },
        );
        self.append_log("agent_added", None, "AGENT_KEY_ISSUED");
        let allowance = Allowance::limited(allowance.unwrap_or(DEFAULT_AGENT_ALLOWANCE))
            .unwrap_or_else(|| env::panic_str("allowance must be > 0"));
        Promise::new(env::current_account_id()).add_access_key_allowance(
            public_key,
            allowance,
            env::current_account_id(),
            AGENT_METHODS,
        )
    }

    pub fn assign_agent(&mut self, public_key: PublicKey, task_ids: Vec<TaskId>) {
        self.assert_owner();
        for id in &task_ids {
            require!(self.tasks.contains_key(id), "unknown task in task_ids");
        }
        let a = self
            .agents
            .get_mut(&String::from(&public_key))
            .unwrap_or_else(|| env::panic_str("unknown agent"));
        a.task_ids = task_ids;
        self.append_log("agent_assigned", None, "OK");
    }

    /// Revoke an agent: mark inactive and delete its access key from the vault.
    pub fn revoke_agent(&mut self, public_key: PublicKey) -> Promise {
        self.assert_owner();
        let a = self
            .agents
            .get_mut(&String::from(&public_key))
            .unwrap_or_else(|| env::panic_str("unknown agent"));
        a.active = false;
        self.append_log("agent_revoked", None, "AGENT_KEY_DELETED");
        Promise::new(env::current_account_id()).delete_key(public_key)
    }
}
