/**
 * Create a free, funded NEAR testnet account and save its key to ts/.env,
 * so the rest of the demo needs no wallet.
 *
 *   npm run new-account
 *
 * Uses NEAR's public testnet faucet service. The key is generated on this
 * machine and written only to ts/.env (gitignored). Testnet only.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { KeyPair } from "near-api-js";
import { ROOT, RPC } from "./config.js";

const ENV = join(ROOT, "ts", ".env");
const FAUCET = "https://helper.nearprotocol.com/account";

const rpc = (params: object) =>
  fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params }) }).then((r) => r.json() as Promise<any>);

async function main() {
  if (existsSync(ENV) && !process.argv.includes("--force")) {
    console.log("ts/.env already exists. Use `npm run new-account -- --force` to replace it.");
    return;
  }
  const name = `almoner-${randomBytes(4).toString("hex")}.testnet`;
  const kp = KeyPair.fromRandom("ed25519");
  const pk = kp.getPublicKey().toString();
  const res = await fetch(FAUCET, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newAccountId: name, newAccountPublicKey: pk }), signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`The testnet faucet answered ${res.status}. Try again in a minute, or create an account in a wallet and fill in ts/.env by hand (see ts/.env.example).`);

  // The faucet can answer OK before the account is visible: wait until our key is really on it.
  let ok = false;
  for (let i = 0; i < 15 && !ok; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const k = await rpc({ request_type: "view_access_key", finality: "final", account_id: name, public_key: pk });
    ok = !!(k.result && !k.result.error && k.result.permission === "FullAccess");
  }
  if (!ok) throw new Error("The new account did not appear with our key. Nothing was saved; try again.");
  const a = await rpc({ request_type: "view_account", finality: "final", account_id: name });
  const near = Number(BigInt(a.result.amount) / 10n ** 21n) / 1000;
  writeFileSync(ENV, `OWNER_ACCOUNT_ID=${name}\nOWNER_PRIVATE_KEY=${kp.toString()}\nNEAR_NETWORK=testnet\n`, { mode: 0o600 });
  console.log(`Created ${name} with ${near} test NEAR. Key saved to ts/.env.`);
  console.log(near < 9 ? "Note: bootstrap needs about 9 NEAR; this account has less." : "Next: npm run bootstrap");
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
