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

