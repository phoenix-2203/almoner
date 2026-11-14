/**
 * Agents hiring agents, live on testnet.
 *
 *   npm run team
 *
 * The owner issues one agent key ("lead") that may delegate. Lead hands Scout
 * 0.30 tUSDC of the task; Scout hands Runner 0.20 of that. Each of them only
 * holds a function-call key on the vault. The run shows that:
 *   - a sub-agent's purchase counts against every budget above it,
 *   - a hand-off can only narrow,
 *   - revoking one link stops everything below it.
 *
 * Needs the upgraded vault (npm run owner -- upgrade) and the sellers' server
 * (the hosted one from shop.json, or `npm run sellers` locally).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { KeyPair, type KeyPairString } from "near-api-js";
import { AlmonerVault, fmtUsdc, usdc, type Purchase, type SignedQuote } from "./sdk.js";
import { loadState, ownerCreds, ROOT, RPC, STATE_FILE } from "./config.js";

const TEAM_FILE = join(dirname(STATE_FILE), "team.json");
const shopFile = join(ROOT, "shop.json");
const API = process.env.SELLERS_URL ?? (existsSync(shopFile) ? JSON.parse(readFileSync(shopFile, "utf8")).api : "http://localhost:8787");
const REPORT = "https://datadesk.example/reports/ai-agents-2026-11";
const DATA = "https://datadesk.example/data/near-intents-volume-daily";

const post = async (path: string, body: unknown) => {
  const r = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `sellers' server answered ${r.status}`);
  return j;
};
const newKey = () => {
  const key = KeyPair.fromRandom("ed25519").toString() as KeyPairString;
  return { key, publicKey: KeyPair.fromString(key).getPublicKey().toString() };
};
const why = (e: any) => {
  const m = String(e?.message ?? e);
  return (m.match(/Smart contract panicked: ([^"\\]+)/)?.[1] ?? m.split("\n")[0]).slice(0, 160);
};

async function main() {
  const state = loadState();
  const { accountId, key } = ownerCreds();
  const vault = new AlmonerVault(state.vault.accountId, RPC);
  const owner = vault.owner(accountId, key);
  const run = randomBytes(3).toString("hex");

  if (!(await vault.view<unknown[]>("get_sub_mandates").catch(() => null))) {
    console.log("This vault's contract doesn't have sub-mandates yet. Run `npm run owner -- upgrade` first.");
    return;
  }

  // The task the owner signs for the team. Reused between runs while it has budget.
  let team: { taskId: number } | null = existsSync(TEAM_FILE) ? JSON.parse(readFileSync(TEAM_FILE, "utf8")) : null;
  let task = team ? await vault.getTask(team.taskId) : null;
  if (!task || BigInt(task.remaining) < BigInt(usdc(0.6))) {
    task = await owner.createTask({
      name: "Team brief",
      purpose: "A lead agent and the sub-agents it hires buy market data and reports for one research brief.",
      categories: ["market-data", "report"],
      blocked_terms: ["gift card", "crypto transfer", "seed phrase"],
      allowed_sellers: [state.sellers.datadesk.accountId],
      budget: usdc(2),
      max_per_purchase: usdc(0.5),
      approval_above: usdc(0.25),
      max_purchases_per_hour: 30,
      reuse_window_ms: 0,
      delivery_window_ms: 10 * 60_000,
      review_window_ms: 10 * 60_000,
      expires_at_ms: Date.now() + 30 * 24 * 3_600_000,
    });
    team = { taskId: task.id };
    writeFileSync(TEAM_FILE, JSON.stringify(team, null, 2));
    console.log(`Owner signed task #${task.id} "Team brief": ${fmtUsdc(task.rules.budget)} budget, DataDesk only.`);
  }
  const taskId = task.id;
  const hash = task.mandate_hash;

  const leadK = newKey(), scoutK = newKey(), runnerK = newKey();
  await owner.addAgent(leadK.publicKey, `lead-${run}`, [taskId], (10n ** 24n).toString(), true);
  console.log(`Owner issued the lead's key, with the right to delegate.\n`);
  const lead = vault.agent(leadK.key), scout = vault.agent(scoutK.key), runner = vault.agent(runnerK.key);

  await lead.delegate({ public_key: scoutK.publicKey, name: `scout-${run}`, task_id: taskId, budget: usdc(0.3), max_per_purchase: usdc(0.2) });
  console.log(`1. Lead hands Scout a sub-mandate: 0.30 tUSDC, at most 0.20 per purchase.`);
  await scout.delegate({ public_key: runnerK.publicKey, name: `runner-${run}`, task_id: taskId, budget: usdc(0.2) });
  console.log(`2. Scout hands Runner a sub-mandate: 0.20 tUSDC of its 0.30.\n`);

  let n = 0;
  const open: Purchase[] = [];
  const buy = async (who: string, agent: ReturnType<AlmonerVault["agent"]>, item: string) => {
    const q = await post("/datadesk/quote", { item, order: `${run}${(n++).toString(36)}`.padEnd(6, "0") });
    const signed: SignedQuote = { quote: q.quote, signature: q.signature };
    const p = await agent.requestPurchase({ task_id: taskId, mandate_hash: hash, signed, reason: `${who}'s part of the team brief`, idempotency_key: randomBytes(6).toString("hex") });
    const verdict = p.status === "Escrowed" ? "APPROVED, held in escrow" : p.status === "Declined" ? `REFUSED ${p.code}` : `${p.status} ${p.code}`;
    console.log(`   ${who} asks for ${fmtUsdc(q.quote.price)} → ${verdict}${p.status === "Declined" ? `\n     ${p.detail}` : ""}  (decision #${p.id})`);
    if (p.status === "Escrowed") open.push(p);
    return p;
  };

  console.log("3. Runner buys inside its sub-mandate, and the seller is paid:");
  const first = await buy("Runner", runner, REPORT);
  if (first.status === "Escrowed") {
    await post("/datadesk/fulfil", { purchase_id: first.id });
    await runner.confirmDelivery(first.id, true);
    open.splice(open.indexOf(first), 1);
    console.log(`   Runner accepted the delivery; DataDesk was paid ${fmtUsdc(first.price)}.`);
  }
  await buy("Runner", runner, DATA);
  console.log("\n4. Runner asks for more than its 0.20 allows:");
  await buy("Runner", runner, DATA);
  console.log("\n5. Scout buys with what Runner left of Scout's 0.30, then asks for more:");
  await buy("Scout", scout, REPORT);
  await buy("Scout", scout, DATA);
  console.log("\n6. Lead is bound only by the task the owner signed:");
  await buy("Lead", lead, DATA);

  console.log("\n7. Scout tries to hand out more than it has:");
  try {
    await scout.delegate({ public_key: newKey().publicKey, name: "greedy", task_id: taskId, budget: usdc(1) });
    console.log("   ! it was accepted. That is a bug; please open an issue.");
  } catch (e) {
    console.log(`   REFUSED by the vault: ${why(e)}`);
  }

  console.log("\n8. Lead cancels Scout. Runner, below Scout, stops too:");
  await lead.revokeDelegate(scoutK.publicKey);
  await buy("Runner", runner, DATA);

  console.log("\nSub-mandates on-chain:");
  for (const s of (await vault.getSubMandates()).filter((s) => s.name.endsWith(run))) {
    console.log(`   ${s.name.padEnd(14)} budget ${fmtUsdc(s.budget)} · spent ${fmtUsdc(s.spent)} · reserved ${fmtUsdc(s.reserved)} · ${s.revoked ? "revoked" : s.usable ? "in force" : "stopped (a link above was revoked)"}`);
  }

  // Tidy up: settle what is still in escrow so no seller is left waiting, and delete the keys.
  for (const p of open) {
    await post("/datadesk/fulfil", { purchase_id: p.id });
    await owner.review(p.id, true);
  }
  await owner.revokeDelegate(runnerK.publicKey).catch(() => {});
  await owner.revokeAgent(leadK.publicKey).catch(() => {});
  const t = (await vault.getTask(taskId))!;
  console.log(`\nOwner settled ${open.length} open purchases and deleted the team's keys. Task #${taskId}: ${fmtUsdc(t.spent)} spent of ${fmtUsdc(t.rules.budget)}. Log intact: ${await vault.verifyLog()}`);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
