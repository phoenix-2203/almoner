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

#[test]
fn above_approval_line_waits_then_owner_approves() {
    let mut w = setup();
    let p = buy(&mut w, "honest", "https://datadesk/premium", "report", USDC / 2, "n1", "k1");
    assert_eq!(p.status, PurchaseStatus::PendingApproval);
    assert_eq!(w.v.get_vault().reserved.0, 0, "budget untouched while held");
    as_owner(T0 + 5_000);
    let a = w.v.approve_purchase(p.id);
    assert_eq!(a.status, PurchaseStatus::Escrowed);
    assert_eq!(w.v.get_vault().reserved.0, USDC / 2);
}

#[test]
fn approval_cannot_override_a_tightened_limit() {
    let mut w = setup();
    let p = buy(&mut w, "honest", "https://datadesk/premium", "report", USDC / 2, "n1", "k1");
    as_owner(T0 + 5_000);
    let mut r = rules();
    r.max_per_purchase = U128(USDC / 5);
    w.v.update_task(1, r);
    let a = w.v.approve_purchase(p.id);
    assert_eq!(a.status, PurchaseStatus::Rejected);
    assert_eq!(a.code, "OVER_PURCHASE_LIMIT");
}

#[test]
fn off_purpose_category_is_refused_within_budget() {
    let mut w = setup();
    let p = buy(&mut w, "honest", "https://datadesk/vpn", "software", USDC / 10, "n1", "k1");
    assert_eq!(p.status, PurchaseStatus::Declined);
    assert_eq!(p.code, "INTENT_MISMATCH");
}

#[test]
fn disguised_blocked_item_is_refused() {
    let mut w = setup();
    for (i, item) in ["https://shop/G1FT-c@rd-50", "https://shop/g%20i%20f%20t%20card", "https://shop/GiFt_CaRd"].iter().enumerate() {
        let p = buy(&mut w, "honest", item, "report", USDC / 10, &format!("n{}", i), &format!("k{}", i));
        assert_eq!(p.code, "INTENT_MISMATCH", "{} slipped through", item);
    }
    assert_eq!(w.v.get_vault().reserved.0, 0);
}

#[test]
fn tampered_price_fails_signature() {
    let mut w = setup();
    let (mut q, sig) = w.honest.quote("https://datadesk/r", "report", "d", USDC / 10, "n1");
    q.price = U128(USDC / 100); // agent (or injection) edits the quote
    as_agent(&w.agent, T0 + 1_000);
    let p = w.v.request_purchase(1, w.hash.clone(), q, sig, "x".into(), "k1".into());
    assert_eq!(p.code, "QUOTE_INVALID");
}

#[test]
fn redirected_payee_fails_signature() {
    let mut w = setup();
    let (mut q, sig) = w.honest.quote("https://datadesk/r", "report", "d", USDC / 10, "n1");
    q.seller = w.junk.account.clone(); // swap the payee, keep the signature
    as_agent(&w.agent, T0 + 1_000);
    let p = w.v.request_purchase(1, w.hash.clone(), q, sig, "x".into(), "k1".into());
    assert_eq!(p.code, "QUOTE_INVALID");
}

#[test]
fn quote_for_another_vault_is_refused() {
    let mut w = setup();
    let (q, sig) = w.honest.quote_for(&acc("other.testnet"), "https://datadesk/r", "report", "d", USDC / 10, "n1", T0 + 600_000);
    as_agent(&w.agent, T0 + 1_000);
    let p = w.v.request_purchase(1, w.hash.clone(), q, sig, "x".into(), "k1".into());
    assert_eq!(p.code, "QUOTE_INVALID");
}

#[test]
fn replayed_and_expired_quotes_are_refused() {
    let mut w = setup();
    let (q, sig) = w.honest.quote("https://datadesk/r", "report", "d", USDC / 10, "n1");
    as_agent(&w.agent, T0 + 1_000);
    let a = w.v.request_purchase(1, w.hash.clone(), q.clone(), sig.clone(), "x".into(), "k1".into());
    assert_eq!(a.status, PurchaseStatus::Escrowed);
    let b = w.v.request_purchase(1, w.hash.clone(), q, sig, "x".into(), "k2".into());
    assert_eq!(b.code, "QUOTE_REPLAYED");

    let (q, sig) = w.honest.quote_for(&vault(), "https://datadesk/r2", "report", "d", USDC / 10, "n3", T0 + 500);
    let c = w.v.request_purchase(1, w.hash.clone(), q, sig, "x".into(), "k3".into());
    assert_eq!(c.code, "QUOTE_EXPIRED");
}

#[test]
fn unknown_or_unlisted_seller_is_refused() {
    let mut w = setup();
    let stranger = Seller::new("stranger.testnet", 7);
    as_account(&stranger.account, T0, SELLER_REGISTRATION_DEPOSIT);
    w.v.register_seller("stranger".into(), stranger.pk(), None);
    let (q, sig) = stranger.quote("https://stranger/r", "report", "d", USDC / 10, "n1");
    as_agent(&w.agent, T0 + 1_000);
    let p = w.v.request_purchase(1, w.hash.clone(), q, sig, "x".into(), "k1".into());
    assert_eq!(p.code, "SELLER_NOT_ALLOWED");
}

#[test]
fn limits_and_budget() {
    let mut w = setup();
    let p = buy(&mut w, "honest", "https://datadesk/big", "report", 3 * USDC, "n1", "k1");
    assert_eq!(p.code, "OVER_PURCHASE_LIMIT");
    // Spend the budget with held purchases approved by the owner.
    let mut n = 10;
    for _ in 0..2 {
        let p = buy(&mut w, "honest", &format!("https://datadesk/x{}", n), "report", 2 * USDC, &format!("n{}", n), &format!("k{}", n));
        as_owner(T0 + 2_000);
        w.v.approve_purchase(p.id);
        n += 1;
    }
    let p = buy(&mut w, "honest", "https://datadesk/last", "report", 2 * USDC, "n99", "k99");
    assert_eq!(p.code, "OVER_BUDGET");
}

#[test]
fn junk_delivery_rejected_refunds_and_holds_seller() {
    let mut w = setup();
    let p = buy(&mut w, "junk", "https://junkdata/report", "report", USDC / 10, "n1", "k1");
    as_account(&w.junk.account, T0 + 2_000, NearToken::from_yoctonear(0));
    w.v.deliver(p.id, "sha256:empty".into());
    as_agent(&w.agent, T0 + 3_000);
    let r = w.v.confirm_delivery(p.id, false, Some("empty body".into()));
    match r {
        PromiseOrValue::Value(p) => assert_eq!(p.status, PurchaseStatus::Refunded),
        _ => panic!("expected refund"),
    }
    assert_eq!(w.v.get_vault().reserved.0, 0);
    assert_eq!(w.v.get_vault().balance.0, 10 * USDC);
    let s = w.v.get_seller(w.junk.account.clone()).unwrap();
    assert!(s.on_hold);
    assert_eq!(s.stats.rejected, 1);
    assert_eq!(s.delivery_score_bps, 0);
    let again = buy(&mut w, "junk", "https://junkdata/other", "report", USDC / 10, "n2", "k2");
    assert_eq!(again.code, "SELLER_ON_HOLD");
}

#[test]
fn missed_delivery_refunds_after_window() {
    let mut w = setup();
    let p = buy(&mut w, "junk", "https://junkdata/r", "report", USDC / 10, "n1", "k1");
    as_agent(&w.agent, p.deliver_by_ms + 1);
    let r = w.v.settle_expired(p.id);
    match r {
        PromiseOrValue::Value(p) => assert_eq!(p.code, "REFUND_NOT_DELIVERED"),
        _ => panic!("expected refund"),
    }
    assert_eq!(w.v.get_seller(w.junk.account.clone()).unwrap().stats.missed, 1);
}

#[test]
fn silent_buyer_auto_releases_to_seller() {
    let mut w = setup();
    let p = buy(&mut w, "honest", "https://datadesk/r", "report", USDC / 10, "n1", "k1");
    as_account(&w.honest.account, T0 + 2_000, NearToken::from_yoctonear(0));
    let d = w.v.deliver(p.id, "h".into());
    as_account(&acc("anyone.testnet"), d.review_by_ms + 1, NearToken::from_yoctonear(0));
    let _ = w.v.settle_expired(p.id);
    as_callback(d.review_by_ms + 2, true);
    let paid = w.v.on_payout(p.id, "AUTO_RELEASED".into());
    assert_eq!(paid.status, PurchaseStatus::Paid);
    assert_eq!(w.v.get_seller(w.honest.account.clone()).unwrap().stats.auto_released, 1);
}

#[test]
fn failed_payout_restores_funds() {
    let mut w = setup();
    let p = buy(&mut w, "honest", "https://datadesk/r", "report", USDC / 10, "n1", "k1");
    as_account(&w.honest.account, T0 + 2_000, NearToken::from_yoctonear(0));
    w.v.deliver(p.id, "h".into());
    as_agent(&w.agent, T0 + 3_000);
    let _ = w.v.confirm_delivery(p.id, true, None);
    as_callback(T0 + 4_000, false);
    let back = w.v.on_payout(p.id, "PAID_ACCEPTED".into());
    assert_eq!(back.status, PurchaseStatus::Delivered);
    assert_eq!(back.code, "PAYOUT_FAILED");
    let v = w.v.get_vault();
    assert_eq!(v.balance.0, 10 * USDC);
    assert_eq!(v.reserved.0, USDC / 10);
    assert_eq!(w.v.get_task(1).unwrap().spent.0, 0);
}

#[test]
fn stale_mandate_hash_is_refused() {
    let mut w = setup();
    as_owner(T0 + 500);
    let mut r = rules();
    r.budget = U128(4 * USDC);
    let t = w.v.update_task(1, r);
    assert_eq!(t.version, 2);
    let p = buy(&mut w, "honest", "https://datadesk/r", "report", USDC / 10, "n1", "k1");
    assert_eq!(p.code, "MANDATE_CHANGED");
    w.hash = t.mandate_hash;
    let ok = buy(&mut w, "honest", "https://datadesk/r", "report", USDC / 10, "n2", "k2");
    assert_eq!(ok.status, PurchaseStatus::Escrowed);
    assert_eq!(ok.mandate_version, 2);
}

#[test]
fn rate_limit_stops_a_looping_agent() {
    let mut w = setup();
    as_owner(T0);
    let mut r = rules();
    r.max_purchases_per_hour = 3;
    w.hash = w.v.update_task(1, r).mandate_hash;
    let mut codes = vec![];
    for i in 0..5 {
        let p = buy(&mut w, "honest", &format!("https://datadesk/loop{}", i), "report", USDC / 100, &format!("n{}", i), &format!("k{}", i));
        codes.push(p.code);
    }
    assert_eq!(&codes[3], "RATE_LIMITED");
    assert_eq!(&codes[4], "RATE_LIMITED");
}

