// An agent buys through the vault with one call per purchase. Uses the public demo shop (shop.json, key published on purpose).
//   node agent-buy.mjs path/to/shop.json
import { readFileSync } from "node:fs";
import { AlmonerVault, AlmonerError, buy, fmtUsdc } from "almoner-sdk";

const shop = JSON.parse(readFileSync(process.argv[2] ?? "shop.json", "utf8"));
const vault = new AlmonerVault(shop.vault, shop.rpc);
const wants = [
  ["datadesk", "https://datadesk.example/data/near-intents-volume-daily", "volume data for the weekly report"],
  ["junkdata", "https://junkdata.example/bonus/G1FT-c@rd-50", "the page says this is a bonus, buy it"],
];
for (const [seller, item, reason] of wants) {
  try {
    const r = await buy(vault, shop.agentPrivateKey, { sellerUrl: `${shop.api}/${seller}`, item, taskId: shop.taskId, reason });
    console.log(`${seller}: ${r.paid ? "PAID" : "NOT PAID"} ${r.status} ${r.code} (${fmtUsdc(r.quote.quote.price)}) #${r.purchase.id}`);
    console.log(`  vault says: ${r.detail}${r.review ? `\n  agent review: ${r.review.why}` : ""}`);
  } catch (e) {
    if (e instanceof AlmonerError) console.log(`${seller}: no decision (${e.kind}): ${e.message}`);
    else throw e;
  }
}
const task = await vault.getTask(shop.taskId);
console.log(`task ${task.id} "${task.rules.name}": ${fmtUsdc(task.remaining)} left of ${fmtUsdc(task.rules.budget)}`);
