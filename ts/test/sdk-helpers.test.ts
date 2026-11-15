// SDK helpers: IntentLock edge cases from contracts/vault/src/intent.rs, error typing, seller errors as AlmonerError.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AlmonerError, getQuote, normalize, preflight, toAlmonerError, type Quote } from "../src/sdk.js";

test("normalize keeps invalid percent escapes, like intent.rs percent_decode", () => {
  assert.equal(normalize("100%"), "ioo"); // "%" is dropped, digits are leet-mapped
  assert.equal(normalize("a%zzb"), "azzb");
  assert.equal(normalize("%41"), "a");
});

test("blocked terms are found in item, category and description, as find_blocked does", () => {
  const rules: any = { categories: [], blocked_terms: ["gift card"], max_per_purchase: "10" };
  const q = (p: Partial<Quote>): Quote => ({ seller: "s", item: "https://x/r", category: "report", description: "", price: "1", expires_at_ms: 0, nonce: "n", ...p });
  assert.equal((preflight(rules, q({ description: "a G1FT c@rd inside" })) as any).code, "INTENT_MISMATCH");
  assert.equal((preflight(rules, q({ item: "https://x/gift%2520card" })) as any).code, "INTENT_MISMATCH");
  assert.deepEqual(preflight(rules, q({})), { ok: true });
});

test("toAlmonerError classifies revoked keys, used-up allowance and network failures", () => {
  assert.equal(toAlmonerError(new Error("Can't complete the action because access key ed25519:abc doesn't exist")).kind, "revoked_key");
  assert.equal(toAlmonerError({ type: "AccessKeyDoesNotExist", message: "x" }).kind, "revoked_key");
  assert.equal(toAlmonerError(new Error("Access Key ed25519:abc does not have enough allowance to cover transaction cost")).kind, "out_of_gas");
  assert.equal(toAlmonerError(new TypeError("fetch failed")).kind, "network");
  assert.equal(toAlmonerError(new Error("Smart contract panicked: unknown task")).kind, "contract");
  const typed = new AlmonerError("seller", "x");
  assert.equal(toAlmonerError(typed), typed);
});

test("getQuote turns seller errors and unreachable sellers into AlmonerError", async () => {
  const srv = createServer((_q, r) => { r.writeHead(404, { "content-type": "application/json" }); r.end('{"error":"not in catalog"}'); });
  await new Promise<void>((ok) => srv.listen(0, ok));
  const port = (srv.address() as any).port;
  await assert.rejects(getQuote(`http://127.0.0.1:${port}/datadesk`, "nope"), (e: any) => e instanceof AlmonerError && e.kind === "seller" && e.message === "not in catalog");
  srv.close();
  await assert.rejects(getQuote(`http://127.0.0.1:${port}/datadesk`, "nope"), (e: any) => e instanceof AlmonerError && e.kind === "network");
});
