// Cross-language checks: the TypeScript SDK must produce exactly what the Rust
// contract verifies. The fixture written here is consumed by the Rust test
// `ts_signed_quote_verifies_on_chain` in contracts/vault/src/tests.rs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KeyPair, type KeyPairString } from "near-api-js";
import { normalize, preflight, quoteMessage, signQuote, type Quote } from "../src/sdk.js";
import { checkDelivery } from "../src/agent.js";
import { ROOT } from "../src/config.js";

const FIXTURE = join(ROOT, "contracts", "vault", "src", "fixtures", "ts_quote.json");
// Deterministic key (testnet fixture only): 32 bytes of 0x01 as seed.
const seed = new Uint8Array(32).fill(1);

test("normalize matches the contract's IntentLock", () => {
  assert.equal(normalize("G1FT-c@rd"), "giftcard");
  assert.equal(normalize("g i f t   c a r d"), "giftcard");
  assert.equal(normalize("gift%20card"), "giftcard");
  assert.equal(normalize("gift%2520card"), "giftcard");
  assert.equal(normalize("Pr3m1um $tock data"), "premiumstockdata");
});

test("signed quote fixture is stable and verifiable", async () => {
  const { ed25519 } = await import("@noble/curves/ed25519.js");
  const secret = new Uint8Array(64);
  secret.set(seed);
  secret.set(ed25519.getPublicKey(seed), 32);
  const { baseEncode } = await import("near-api-js");
  const key = ("ed25519:" + baseEncode(secret)) as KeyPairString;
  const kp = KeyPair.fromString(key);
  const quote: Quote = {
    seller: "datadesk.testnet",
    item: "https://datadesk/ai-agents-report",
    category: "report",
    description: "Daily report | with odd chars\nand newlines",
    price: "100000",
    expires_at_ms: 1_800_000_600_000,
    nonce: "ts-fixture-1",
  };
  const vault = "vault.owner.testnet";
  const signed = signQuote(vault, quote, key);
  const msg = new TextEncoder().encode(quoteMessage(vault, quote));
  assert.ok(kp.verify(msg, Buffer.from(signed.signature, "base64")));
  const fixture = { vault, seller_public_key: kp.getPublicKey().toString(), ...signed };
  const text = JSON.stringify(fixture, null, 2) + "\n";
  if (process.env.WRITE_FIXTURE) writeFileSync(FIXTURE, text);
  assert.equal(readFileSync(FIXTURE, "utf8"), text, "fixture drifted: re-run with WRITE_FIXTURE=1 and re-run cargo test");
});

test("preflight mirrors category and blocked-term rules", () => {
  const rules: any = { categories: ["report"], blocked_terms: ["gift card"], max_per_purchase: "1000000" };
  const q = (item: string, category = "report", price = "1"): Quote => ({ seller: "s", item, category, description: "", price, expires_at_ms: 0, nonce: "n" });
  assert.deepEqual(preflight(rules, q("https://x/report")), { ok: true });
  assert.equal((preflight(rules, q("https://x/G1FT-c@rd")) as any).code, "INTENT_MISMATCH");
  assert.equal((preflight(rules, q("https://x/vpn", "software")) as any).code, "INTENT_MISMATCH");
  assert.equal((preflight(rules, q("https://x/r", "report", "2000000")) as any).code, "OVER_PURCHASE_LIMIT");
});

test("delivery check rejects junk and hash mismatches", async () => {
  const { sha256hex } = await import("../src/sdk.js");
  const good = JSON.stringify({ rows: [1] });
  assert.equal(checkDelivery(good, sha256hex(good)).ok, true);
  assert.equal(checkDelivery("", sha256hex("")).ok, false);
  assert.equal(checkDelivery('{"error":"upstream timeout"}', sha256hex('{"error":"upstream timeout"}')).ok, false);
  assert.equal(checkDelivery(good, sha256hex("other")).ok, false);
});
