//! Unit tests: the night-shift flow plus the attack lab, run natively against
//! near-sdk's mocked blockchain. Cross-contract calls aren't executed here;
//! callbacks are driven directly with mocked promise results.

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
use near_sdk::test_vm_config;

const T0: u64 = 1_800_000_000_000; // unix ms
const USDC: u128 = 1_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn vault() -> AccountId {
    acc("vault.owner.testnet")
}
fn owner() -> AccountId {
    acc("owner.testnet")
}
fn token() -> AccountId {
    acc("tusdc.testnet")
}

struct Seller {
    account: AccountId,
    key: SigningKey,
}

impl Seller {
    fn new(name: &str, seed: u8) -> Self {
        Self { account: acc(name), key: SigningKey::from_bytes(&[seed; 32]) }
    }
    fn pk(&self) -> PublicKey {
        PublicKey::from_parts(CurveType::ED25519, self.key.verifying_key().to_bytes().to_vec()).unwrap()
    }
    fn quote(&self, item: &str, category: &str, desc: &str, price: u128, nonce: &str) -> (Quote, Base64VecU8) {
        self.quote_for(&vault(), item, category, desc, price, nonce, T0 + 600_000)
    }
    #[allow(clippy::too_many_arguments)]
    fn quote_for(&self, v: &AccountId, item: &str, category: &str, desc: &str, price: u128, nonce: &str, expires: u64) -> (Quote, Base64VecU8) {
        let q = Quote {
            seller: self.account.clone(),
            item: item.into(),
            category: category.into(),
            description: desc.into(),
            price: U128(price),
            expires_at_ms: expires,
            nonce: nonce.into(),
        };
        let dh = {
            use std::fmt::Write;
            let d = near_sdk::env::sha256_array(desc.as_bytes());
            let mut s = String::new();
            for b in d { write!(s, "{:02x}", b).unwrap(); }
            s
        };
        let msg = intent::quote_message(v.as_str(), &q, &dh);
        let sig = self.key.sign(msg.as_bytes()).to_bytes().to_vec();
        (q, Base64VecU8(sig))
    }
}

fn agent_key(seed: u8) -> PublicKey {
    let k = SigningKey::from_bytes(&[seed; 32]);
    PublicKey::from_parts(CurveType::ED25519, k.verifying_key().to_bytes().to_vec()).unwrap()
}

fn ctx(predecessor: AccountId, signer_pk: Option<PublicKey>, now_ms: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(vault())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .block_timestamp(now_ms * 1_000_000);
    if let Some(pk) = signer_pk {
        b.signer_account_pk(pk);
    }
    b
}

fn as_owner(now: u64) {
    testing_env!(ctx(owner(), None, now).build());
}
fn as_agent(pk: &PublicKey, now: u64) {
    testing_env!(ctx(vault(), Some(pk.clone()), now).build());
}
fn as_account(a: &AccountId, now: u64, deposit: NearToken) {
    testing_env!(ctx(a.clone(), None, now).attached_deposit(deposit).build());
}
fn as_callback(now: u64, ok: bool) {
    let r = if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed };
    testing_env!(
        ctx(vault(), None, now).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![r]
    );
}

fn rules() -> TaskInput {
    TaskInput {
        name: "Tonight's market brief".into(),
        purpose: "Buy market data and reports for tonight's AI-agents market brief.".into(),
        categories: vec!["market-data".into(), "report".into()],
        blocked_terms: vec!["gift card".into(), "crypto transfer".into()],
        allowed_sellers: vec![acc("datadesk.testnet"), acc("junkdata.testnet")],
        budget: U128(5 * USDC),
        max_per_purchase: U128(2 * USDC),
        approval_above: U128(USDC / 4),
        max_purchases_per_hour: 20,
        reuse_window_ms: 3_600_000,
        delivery_window_ms: 300_000,
        review_window_ms: 300_000,
        expires_at_ms: T0 + 86_400_000,
    }
}

struct World {
    v: Vault,
    agent: PublicKey,
    honest: Seller,
    junk: Seller,
    hash: String,
}

fn setup() -> World {
    as_owner(T0);
    let mut v = Vault::new(owner(), token());
    let t = v.create_task(rules());
    let agent = agent_key(9);
    let _ = v.add_agent(agent.clone(), "research-agent".into(), vec![t.id], None);
    // Fund the vault: 10 tUSDC from the owner via ft_transfer_call.
    as_account(&token(), T0, NearToken::from_yoctonear(0));
    let _ = v.ft_on_transfer(owner(), U128(10 * USDC), String::new());
    let honest = Seller::new("datadesk.testnet", 1);
    let junk = Seller::new("junkdata.testnet", 2);
    for s in [&honest, &junk] {
        as_account(&s.account, T0, SELLER_REGISTRATION_DEPOSIT);
        v.register_seller(s.account.to_string(), s.pk(), None);
    }
    World { v, agent, honest, junk, hash: t.mandate_hash }
}

