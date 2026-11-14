/**
 * Owner-only: open the hands-on "be the agent" shop on the Try it page.
 *
 *   npm run shop:setup
 *
 * Signs a task ("Open shop") that both demo sellers may be paid from, has the
 * vault issue an agent key for it and PUBLISHES that key in shop.json, so any
 * visitor can act as the agent: get a seller-signed quote, ask the vault to buy,
 * receive the delivery and accept or reject it. Everything they do is bounded by
 * the task's signed rules, exactly like any other Almoner agent.
 *
 * Also writes ts/.almoner/sellers.json: the two sellers' keys only (never the
 * owner's), which scripts/deploy-vps.sh places on the server that answers
 * quote and delivery requests.
 *
 * Run it again any time: it replaces a key that is low on gas and tops up the
 * task's budget when visitors have spent most of it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { KeyPair, type KeyPairString } from "near-api-js";
import { AlmonerVault, fmtNear, fmtUsdc, usdc, type TaskInput } from "./sdk.js";
import { loadState, NETWORK, ownerCreds, ROOT, RPC, STATE_FILE } from "./config.js";

export const SHOP_FILE = join(ROOT, "shop.json");
const API = process.env.SHOP_API ?? "https://almoner.duckdns.org/api";
const ALLOWANCE = 10n * 10n ** 24n; // gas the published key may spend before it is replaced
const BUDGET = 10; // tUSDC

async function main() {
  const state = loadState();
  const { accountId, key } = ownerCreds();
  const vault = new AlmonerVault(state.vault.accountId, RPC);
  const owner = vault.owner(accountId, key);

  let c: any = existsSync(SHOP_FILE) ? JSON.parse(readFileSync(SHOP_FILE, "utf8")) : null;
  if (c && c.vault !== state.vault.accountId) c = null;

  const issueKey = async (taskId: number) => {
    const agentKey = KeyPair.fromRandom("ed25519").toString() as KeyPairString;
    const publicKey = KeyPair.fromString(agentKey).getPublicKey().toString();
    await owner.addAgent(publicKey, "visitor-agent", [taskId], ALLOWANCE.toString());
    console.log(`  + vault issued the shop key ${publicKey} (${fmtNear(ALLOWANCE)} gas allowance)`);
    return { agentKey, publicKey };
  };

  const rules = (budget: string, expires: number): TaskInput => ({
    name: "Open shop",
    purpose: "Visitors act as the agent. Buy market data and reports for a research brief, from the two registered demo sellers.",
    categories: ["market-data", "report"],
    blocked_terms: ["gift card", "crypto transfer", "seed phrase"],
    allowed_sellers: [state.sellers.datadesk.accountId, state.sellers.junkdata.accountId],
    budget,
    max_per_purchase: usdc(0.5),
    approval_above: usdc(0.25),
    max_purchases_per_hour: 120,
    reuse_window_ms: 30 * 60_000,
    delivery_window_ms: 10 * 60_000,
    review_window_ms: 10 * 60_000,
    expires_at_ms: expires,
  });

  if (!c) {
    const task = await owner.createTask(rules(usdc(BUDGET), Date.now() + 30 * 24 * 3_600_000));
    console.log(`  + task #${task.id} "Open shop" signed (budget ${BUDGET} tUSDC)`);
    const k = await issueKey(task.id);
    c = { network: NETWORK, rpc: RPC, api: API, vault: state.vault.accountId, token: state.token.accountId, taskId: task.id, sellers: {}, agentPublicKey: k.publicKey, agentPrivateKey: k.agentKey };
  } else {
    const left = await vault.keyAllowance(c.agentPublicKey);
    if (left == null || (left >= 0n && left < ALLOWANCE / 4n)) {
      console.log(`  = shop key is ${left == null ? "gone" : "low on gas (" + fmtNear(left) + ")"}; replacing it`);
      const old = c.agentPublicKey;
      const k = await issueKey(c.taskId);
      c.agentPublicKey = k.publicKey;
      c.agentPrivateKey = k.agentKey;
      if (left != null) await owner.revokeAgent(old).catch(() => {});
    } else {
      console.log(`  = shop key has ${fmtNear(left)} of gas left`);
    }
    const t = await vault.getTask(c.taskId);
    if (t && BigInt(t.remaining) < BigInt(usdc(2))) {
      const budget = (BigInt(t.rules.budget) + BigInt(usdc(BUDGET))).toString();
      await owner.updateTask(c.taskId, rules(budget, Date.now() + 30 * 24 * 3_600_000));
      console.log(`  + budget topped up: ${fmtUsdc(t.remaining)} was left, task may now spend ${fmtUsdc(budget)} in total`);
    } else if (t) {
      console.log(`  = task has ${fmtUsdc(t.remaining)} of budget left`);
    }
  }
  c.api = API;
  c.sellers = { datadesk: state.sellers.datadesk.accountId, junkdata: state.sellers.junkdata.accountId };
  writeFileSync(SHOP_FILE, JSON.stringify(c, null, 2) + "\n");

  // Sellers put on hold by a rejected delivery stay on hold until the owner clears them.
  for (const [name, id] of Object.entries<string>(c.sellers)) {
    const s = await vault.getSeller(id);
    if (s?.on_hold) {
      await owner.clearHold(id);
      console.log(`  + cleared the hold on ${name} (${s.hold_reason})`);
    }
  }

  const v = await vault.getVault();
  if (BigInt(v.balance) < BigInt(usdc(5))) console.log(`  ! the vault holds only ${fmtUsdc(v.balance)}; send it more tUSDC so purchases keep working`);

  const nearLeft = await vault.nearBalance(state.vault.accountId);
  console.log(`  = vault account holds ${fmtNear(nearLeft)} for gas and storage${nearLeft < 4n * 10n ** 24n ? ". That is getting low: send it a few test NEAR from your wallet" : ""}`);

  const book = { vault: state.vault.accountId, sellers: state.sellers };
  const bookFile = join(dirname(STATE_FILE), "sellers.json");
  writeFileSync(bookFile, JSON.stringify(book, null, 2) + "\n", { mode: 0o600 });

  console.log(`\nShop is open. Wrote shop.json (commit and push it) and ${bookFile} (private: seller keys for the server).`);
  console.log("Next: git add shop.json && git commit -m 'chore: publish the shop key' && git push, then run scripts/deploy-vps.sh");
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
