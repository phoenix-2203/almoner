// An owner gives an agent a mandate and a key in one call, checks it on-chain, then closes it again.
//   OWNER_ACCOUNT_ID=... OWNER_PRIVATE_KEY=... VAULT_ID=... node owner-setup.mjs
import { AlmonerVault, setupAgent, usdc, fmtUsdc, fmtNear } from "almoner-sdk";

const { OWNER_ACCOUNT_ID: ownerId, OWNER_PRIVATE_KEY: ownerKey, VAULT_ID: vaultId } = process.env;
const vault = new AlmonerVault(vaultId, process.env.NEAR_RPC ?? "https://rpc.testnet.fastnear.com");
const hour = 3_600_000;
const rules = {
  name: "SDK example: research data", purpose: "Buy market data for a weekly report",
  categories: ["market-data", "report"], blocked_terms: ["gift card", "crypto voucher"], allowed_sellers: [],
  budget: usdc(0.5), max_per_purchase: usdc(0.1), approval_above: usdc(0.08), max_purchases_per_hour: 5,
  reuse_window_ms: 24 * hour, delivery_window_ms: hour, review_window_ms: hour, expires_at_ms: Date.now() + 7 * 24 * hour,
};
const { task, agentKey, publicKey } = await setupAgent(vault, ownerId, ownerKey, rules, "sdk-example-agent");
console.log(`task ${task.id} "${task.rules.name}" v${task.version}, mandate ${task.mandate_hash.slice(0, 16)}…`);
console.log(`  budget ${fmtUsdc(task.rules.budget)}, max ${fmtUsdc(task.rules.max_per_purchase)} each, approval above ${fmtUsdc(task.rules.approval_above)}`);
console.log(`agent key issued: ${publicKey.slice(0, 20)}… (private key returned to you once; give it to the agent)`);
const agent = (await vault.getAgents()).find((a) => a.public_key === publicKey);
console.log(`on-chain: agent "${agent.name}" active=${agent.active} tasks=${agent.task_ids}, gas allowance ${fmtNear(await vault.keyAllowance(publicKey))}`);
void agentKey; // a real owner would store this for the agent; this example tidies up instead
const owner = vault.owner(ownerId, ownerKey);
await owner.revokeAgent(publicKey);
await owner.setTaskStatus(task.id, "Closed");
console.log(`tidied up: key revoked (${(await vault.keyAllowance(publicKey)) === null ? "gone from the vault" : "still there"}), task ${task.id} ${(await vault.getTask(task.id)).status}`);
