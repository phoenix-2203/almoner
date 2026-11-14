//! Sub-mandates: an agent hands part of its task to another agent.
//!
//! The hand-off can only narrow: same task, a budget and per-purchase limit no
//! larger than the parent's, an expiry no later. Every purchase a sub-agent
//! makes counts against its own sub-mandate and against every one above it,
//! and still has to pass every rule of the task the owner signed. Revoking
//! one link stops everything below it.
//!
//! A sub-agent gets what every Almoner agent gets: a function-call access key
//! on the vault account that can only ask. It never holds funds.
//!
//! Records live under their own storage prefix, so the vault's main state
//! layout is unchanged and this code can be deployed over an existing vault.

use crate::*;
use near_sdk::borsh;

/// Deepest chain allowed: owner -> agent -> sub -> sub -> sub.
pub const MAX_SUB_DEPTH: u8 = 3;
/// How many sub-mandates one agent may hand out.
pub const MAX_SUBS_PER_AGENT: u32 = 4;
/// Gas allowance of a sub-agent's key.
pub const SUB_AGENT_ALLOWANCE: NearToken = NearToken::from_millinear(500);

const PREFIX: &[u8] = b"sub|";
const COUNT_PREFIX: &[u8] = b"subn|";
const INDEX_KEY: &[u8] = b"subs";

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct SubMandate {
    /// The sub-agent's key.
    pub agent: String,
    /// The key of the agent that handed this out.
    pub parent: String,
    pub name: String,
    pub task_id: TaskId,
    pub budget: U128,
    pub max_per_purchase: U128,
    pub expires_at_ms: u64,
    pub spent: U128,
    pub reserved: U128,
    /// 1 for a sub-agent of an owner-issued agent, 2 for its sub-agent, ...
    pub depth: u8,
    pub revoked: bool,
    pub created_ms: u64,
}

#[near(serializers = [json])]
pub struct SubMandateView {
    #[serde(flatten)]
    pub mandate: SubMandate,
    pub remaining: U128,
    /// False when this link or any link above it is revoked or expired.
    pub usable: bool,
}

fn key(prefix: &[u8], pk: &str) -> Vec<u8> {
    [prefix, pk.as_bytes()].concat()
}

impl Vault {
    pub(crate) fn sub_get(&self, pk: &str) -> Option<SubMandate> {
        env::storage_read(&key(PREFIX, pk)).map(|b| borsh::from_slice(&b).unwrap_or_else(|_| env::abort()))
    }

    fn sub_put(&mut self, m: &SubMandate) {
        env::storage_write(&key(PREFIX, &m.agent), &borsh::to_vec(m).unwrap_or_else(|_| env::abort()));
    }

    fn sub_index(&self) -> Vec<String> {
        env::storage_read(INDEX_KEY).map(|b| borsh::from_slice(&b).unwrap_or_else(|_| env::abort())).unwrap_or_default()
    }

    fn sub_count(&self, parent: &str) -> u32 {
        env::storage_read(&key(COUNT_PREFIX, parent)).map(|b| borsh::from_slice(&b).unwrap_or_else(|_| env::abort())).unwrap_or(0)
    }

    /// The sub-mandates that bind `pk`, nearest first. Empty for an owner-issued agent.
    pub(crate) fn sub_chain(&self, pk: &str) -> Vec<SubMandate> {
        let mut chain = Vec::new();
        let mut cur = pk.to_string();
        while let Some(m) = self.sub_get(&cur) {
            cur = m.parent.clone();
            chain.push(m);
            if chain.len() > MAX_SUB_DEPTH as usize {
                break;
            }
        }
        chain
    }

    /// Is every link above `pk` still in force for this task?
    pub(crate) fn sub_check_links(&self, pk: &str, task_id: TaskId, now: u64) -> Option<(&'static str, String)> {
        for m in self.sub_chain(pk) {
            if m.task_id != task_id {
                return Some(("SUB_MANDATE_SCOPE", format!("Sub-mandate '{}' only covers task #{}.", m.name, m.task_id)));
            }
            if m.revoked || !self.agents.get(&m.parent).map(|a| a.active).unwrap_or(false) {
                return Some(("SUB_MANDATE_REVOKED", format!("Sub-mandate '{}' or a link above it was revoked.", m.name)));
            }
            if now > m.expires_at_ms {
                return Some(("SUB_MANDATE_EXPIRED", format!("Sub-mandate '{}' has expired.", m.name)));
            }
        }
        None
    }

    /// Does `price` fit inside every sub-mandate above `pk`?
    pub(crate) fn sub_check_budget(&self, pk: &str, price: u128) -> Option<(&'static str, String)> {
        for m in self.sub_chain(pk) {
            if price > m.max_per_purchase.0 {
                return Some(("SUB_MANDATE_LIMIT", format!("Price is above the per-purchase limit of sub-mandate '{}'.", m.name)));
            }
            if m.spent.0 + m.reserved.0 + price > m.budget.0 {
                return Some((
                    "SUB_MANDATE_BUDGET",
                    format!("Sub-mandate '{}' doesn't have enough budget left (purchases below it count against it).", m.name),
                ));
            }
        }
        None
    }

    fn sub_each(&mut self, pk: &str, f: impl Fn(&mut SubMandate)) {
        for mut m in self.sub_chain(pk) {
            f(&mut m);
            self.sub_put(&m);
        }
    }

    pub(crate) fn sub_reserve(&mut self, pk: &str, amount: u128) {
        self.sub_each(pk, |m| m.reserved.0 += amount);
    }

    pub(crate) fn sub_release(&mut self, pk: &str, amount: u128) {
        self.sub_each(pk, |m| m.reserved.0 = m.reserved.0.saturating_sub(amount));
    }

    pub(crate) fn sub_spend(&mut self, pk: &str, amount: u128) {
        self.sub_each(pk, |m| {
            m.reserved.0 = m.reserved.0.saturating_sub(amount);
            m.spent.0 += amount;
        });
    }

    /// Undo `sub_spend` when a payout fails.
    pub(crate) fn sub_unspend(&mut self, pk: &str, amount: u128) {
        self.sub_each(pk, |m| {
            m.spent.0 = m.spent.0.saturating_sub(amount);
            m.reserved.0 += amount;
        });
    }
}

#[near]
impl Vault {
    /// An agent hands part of its task to a sub-agent. Callable only with an
    /// agent key that was issued with the right to delegate. The vault adds a
    /// function-call key for the sub-agent to its own account.
    pub fn delegate(
        &mut self,
        public_key: PublicKey,
        name: String,
        task_id: TaskId,
        budget: U128,
        max_per_purchase: Option<U128>,
        expires_at_ms: Option<u64>,
    ) -> Promise {
        let parent_pk = self.assert_agent();
        let now = env::block_timestamp_ms();
        require!(!self.frozen, "vault is frozen");
        let task = self.task_or_panic(task_id).clone();
        require!(task.status == TaskStatus::Active && now <= task.rules.expires_at_ms, "task is not active");
        let parent_agent = self.agents.get(&parent_pk).unwrap_or_else(|| env::abort());
        require!(parent_agent.task_ids.contains(&task_id), "you are not assigned to this task");
        if let Some((_, why)) = self.sub_check_links(&parent_pk, task_id, now) {
            env::panic_str(&why);
        }

        // What the parent itself is bound by: its own sub-mandate, or the task.
        let (cap_budget, cap_per_purchase, cap_expiry, depth) = match self.sub_get(&parent_pk) {
            Some(m) => (m.budget.0, m.max_per_purchase.0, m.expires_at_ms, m.depth + 1),
            None => (task.rules.budget.0, task.rules.max_per_purchase.0, task.rules.expires_at_ms, 1),
        };
        require!(depth <= MAX_SUB_DEPTH, "sub-mandate chain is too deep");
        let per_purchase = max_per_purchase.map(|m| m.0).unwrap_or(cap_per_purchase.min(budget.0));
        let expiry = expires_at_ms.unwrap_or(cap_expiry);
        require!(budget.0 > 0, "budget must be above zero");
        require!(budget.0 <= cap_budget, "a sub-mandate can only narrow: budget is above yours");
        require!(per_purchase <= cap_per_purchase, "a sub-mandate can only narrow: per-purchase limit is above yours");
        require!(per_purchase <= budget.0, "per-purchase limit is above the sub-mandate's budget");
        require!(expiry <= cap_expiry && expiry > now, "a sub-mandate can only narrow: it must end before yours does");

        let count = self.sub_count(&parent_pk);
        require!(count < MAX_SUBS_PER_AGENT, "this agent has handed out its maximum number of sub-mandates");
        let pk = String::from(&public_key);
        require!(self.agents.get(&pk).is_none(), "this key is already known to the vault");

        let name = truncate(&name, MAX_SHORT);
        self.agents.insert(
            pk.clone(),
            Agent {
                name: name.clone(),
                public_key: pk.clone(),
                task_ids: vec![task_id],
                active: true,
                added_ms: now,
                window_start_ms: 0,
                window_count: 0,
                requests: 0,
            },
        );
        self.sub_put(&SubMandate {
            agent: pk.clone(),
            parent: parent_pk.clone(),
            name,
            task_id,
            budget,
            max_per_purchase: U128(per_purchase),
            expires_at_ms: expiry,
            spent: U128(0),
            reserved: U128(0),
            depth,
            revoked: false,
            created_ms: now,
        });
        env::storage_write(&key(COUNT_PREFIX, &parent_pk), &borsh::to_vec(&(count + 1)).unwrap_or_else(|_| env::abort()));
        let mut index = self.sub_index();
        index.push(pk);
        env::storage_write(INDEX_KEY, &borsh::to_vec(&index).unwrap_or_else(|_| env::abort()));
        self.append_log("sub_mandate", None, &format!("SUB_MANDATE_SIGNED_DEPTH_{}", depth));

        let allowance = Allowance::limited(SUB_AGENT_ALLOWANCE).unwrap_or_else(|| env::abort());
        Promise::new(env::current_account_id()).add_access_key_allowance(
            public_key,
            allowance,
            env::current_account_id(),
            AGENT_METHODS_DELEGATING,
        )
    }

    /// Cancel a sub-mandate. The owner may cancel any; an agent may cancel one
    /// it handed out, or any below those. Everything under it stops with it.
    pub fn revoke_delegate(&mut self, public_key: PublicKey) -> Promise {
        let pk = String::from(&public_key);
        let m = self.sub_get(&pk).unwrap_or_else(|| env::panic_str("no such sub-mandate"));
        if env::predecessor_account_id() != self.owner {
            let caller = self.assert_agent();
            require!(self.sub_chain(&pk).iter().any(|link| link.parent == caller), "only the owner or an agent above this one can revoke it");
        }
        let mut m = m;
        m.revoked = true;
        self.sub_put(&m);
        if let Some(a) = self.agents.get_mut(&pk) {
            a.active = false;
        }
        self.append_log("sub_mandate_revoked", None, "SUB_MANDATE_REVOKED");
        Promise::new(env::current_account_id()).delete_key(public_key)
    }

    pub fn get_sub_mandates(&self) -> Vec<SubMandateView> {
        let now = env::block_timestamp_ms();
        self.sub_index()
            .iter()
            .filter_map(|pk| self.sub_get(pk))
            .map(|m| SubMandateView {
                remaining: U128(m.budget.0.saturating_sub(m.spent.0 + m.reserved.0)),
                usable: self.sub_check_links(&m.agent, m.task_id, now).is_none(),
                mandate: m,
            })
            .collect()
    }
}
