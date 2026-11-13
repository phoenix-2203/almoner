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

fn buy(w: &mut World, s: &str, item: &str, cat: &str, price: u128, nonce: &str, idem: &str) -> Purchase {
    let seller = if s == "honest" { &w.honest } else { &w.junk };
    let (q, sig) = seller.quote(item, cat, "Daily report", price, nonce);
    as_agent(&w.agent, T0 + 1_000);
    w.v.request_purchase(1, w.hash.clone(), q, sig, "for tonight's brief".into(), idem.into())
}

#[test]
fn happy_path_escrow_deliver_accept_pay() {
    let mut w = setup();
    let p = buy(&mut w, "honest", "https://datadesk/ai-agents-report", "report", USDC / 10, "n1", "k1");
    assert_eq!(p.status, PurchaseStatus::Escrowed, "{}", p.detail);
    assert_eq!(w.v.get_vault().reserved.0, USDC / 10);

    as_account(&w.honest.account, T0 + 2_000, NearToken::from_yoctonear(0));
    let d = w.v.deliver(p.id, "sha256:abc".into());
    assert_eq!(d.status, PurchaseStatus::Delivered);

    as_agent(&w.agent, T0 + 3_000);
    let _ = w.v.confirm_delivery(p.id, true, None);
    assert_eq!(w.v.get_purchase(p.id).unwrap().status, PurchaseStatus::PayoutPending);
    assert_eq!(w.v.get_vault().balance.0, 10 * USDC - USDC / 10);

    as_callback(T0 + 4_000, true);
    let paid = w.v.on_payout(p.id, "PAID_ACCEPTED".into());
    assert_eq!(paid.status, PurchaseStatus::Paid);
    let s = w.v.get_seller(w.honest.account.clone()).unwrap();
    assert_eq!(s.stats.delivered_ok, 1);
    assert_eq!(s.stats.earned.0, USDC / 10);
    assert_eq!(s.delivery_score_bps, 10_000);
    let t = w.v.get_task(1).unwrap();
    assert_eq!(t.spent.0, USDC / 10);
    assert_eq!(t.reserved.0, 0);
    assert!(w.v.verify_log());
}

#[test]
fn identical_item_is_reused_for_free() {
    let mut w = setup();
    let p = buy(&mut w, "honest", "https://datadesk/r", "report", USDC / 10, "n1", "k1");
    as_account(&w.honest.account, T0 + 2_000, NearToken::from_yoctonear(0));
    w.v.deliver(p.id, "h1".into());
    as_agent(&w.agent, T0 + 3_000);
    let _ = w.v.confirm_delivery(p.id, true, None);
    as_callback(T0 + 4_000, true);
    w.v.on_payout(p.id, "PAID_ACCEPTED".into());

    let again = buy(&mut w, "honest", "https://datadesk/r", "report", USDC / 10, "n2", "k2");
    assert_eq!(again.status, PurchaseStatus::Reused);
    assert_eq!(again.price.0, 0);
    assert_eq!(again.reused_from, Some(p.id));
    assert_eq!(again.result_hash.as_deref(), Some("h1"));
    assert_eq!(w.v.get_task(1).unwrap().spent.0, USDC / 10);
}

#[test]
fn retry_with_same_idempotency_key_returns_original() {
    let mut w = setup();
    let a = buy(&mut w, "honest", "https://datadesk/r", "report", USDC / 10, "n1", "same");
    let b = buy(&mut w, "honest", "https://datadesk/other", "report", USDC / 10, "n9", "same");
    assert_eq!(a.id, b.id);
    assert_eq!(w.v.get_vault().purchases, 1);
    assert_eq!(w.v.get_vault().reserved.0, USDC / 10);
}

