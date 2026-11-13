/**
 * Public challenge: try to take the vault's money with the published agent key.
 *
 *   npm run attack
 *
 * Needs no account and no setup: it reads challenge.json from the repo, which
 * contains a real, deliberately published private key for the live vault.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Account, KeyPair, type KeyPairString } from "near-api-js";
import { AlmonerVault, explorerAccount, fmtUsdc, newNonce, signQuote, TGAS, usdc, type Purchase, type Quote } from "./sdk.js";
import { ROOT } from "./config.js";

const file = join(ROOT, "challenge.json");
if (!existsSync(file)) {
  console.error("No challenge.json in this repo: the public challenge isn't open.");
  process.exit(1);
}
const c = JSON.parse(readFileSync(file, "utf8")) as {
  network: string; rpc: string; vault: string; token: string; taskId: number; seller: string; agentPublicKey: string; agentPrivateKey: KeyPairString;
};
const rpc = process.env.NEAR_RPC ?? c.rpc;
const vault = new AlmonerVault(c.vault, rpc);
// The attacker "is" the vault account, signing with the leaked agent key.
const thief = new Account(c.vault, rpc, c.agentPrivateKey);
const agent = vault.agent(c.agentPrivateKey);
const LOOT = "almoner-thief.testnet";

const tokenBalance = () =>
  vault.provider.callFunction({ contractId: c.token, method: "ft_balance_of", args: { account_id: c.vault } }) as Promise<string>;
const short = (e: any) => String(e?.message ?? e).split("\n")[0].slice(0, 150);
let n = 0, broke = 0;

/** An attack that must fail before reaching the contract. */
async function protocol(title: string, run: () => Promise<unknown>) {
  console.log(`\n${++n}. ${title}`);
  try {
    await run();
    broke++;
    console.log("   \x1b[31m!!! IT WENT THROUGH. Please open an issue.\x1b[0m");
  } catch (e) {
    console.log(`   \x1b[32mblocked by the NEAR protocol\x1b[0m · ${short(e)}`);
  }
}

/** An attack that reaches the vault and must come back Declined. */
async function contract(title: string, run: () => Promise<Purchase>) {
  console.log(`\n${++n}. ${title}`);
  try {
    const p = await run();
    if (p.status === "Declined") {
      console.log(`   \x1b[32mrefused by the vault\x1b[0m · ${p.code} · ${p.detail} (recorded on-chain as decision #${p.id})`);
    } else {
      broke++;
      console.log(`   \x1b[31m!!! status ${p.status} (${p.code}). Please open an issue.\x1b[0m`);
    }
  } catch (e) {
    console.log(`   \x1b[33mcould not send\x1b[0m · ${short(e)}`);
  }
}

async function main() {
  const before = await tokenBalance();
  const task = await vault.getTask(c.taskId);
  if (!task) throw new Error("challenge task not found");
  console.log(`Almoner public challenge · vault ${c.vault} holds ${fmtUsdc(before)}`);
  console.log(`Signing as the vault with the published agent key ${c.agentPublicKey}`);

  await protocol("Transfer 1 NEAR out of the vault account", () =>
    thief.transfer({ receiverId: LOOT, amount: 10n ** 24n }));

  await protocol("Add our own full-access key to the vault account", () =>
    thief.addFullAccessKey(KeyPair.fromRandom("ed25519").getPublicKey()));

  await protocol("Call ft_transfer on the token contract directly", () =>
    thief.callFunction({ contractId: c.token, methodName: "ft_transfer", args: { receiver_id: LOOT, amount: before }, deposit: 1n, gas: 30n * TGAS }));

  await protocol("Call the vault's owner-only withdraw", () =>
    thief.callFunction({ contractId: c.vault, methodName: "withdraw", args: { amount: before }, gas: 100n * TGAS }));

  const forger = KeyPair.fromRandom("ed25519").toString() as KeyPairString;
  const quote = (seller: string): Quote => ({
    seller,
    item: "https://datadesk.example/reports/ai-agents-2026-11",
    category: "report",
    description: "AI agents market report",
    price: usdc(0.2),
    expires_at_ms: Date.now() + 10 * 60_000,
    nonce: newNonce(),
  });
  const ask = (q: Quote) =>
    agent.requestPurchase({ task_id: c.taskId, mandate_hash: task.mandate_hash, signed: signQuote(c.vault, q, forger), reason: "public challenge", idempotency_key: randomBytes(8).toString("hex") });

  await contract("Ask the vault to pay a quote we signed ourselves in the seller's name", () => ask(quote(c.seller)));
  await contract("Ask the vault to pay a 'seller' account we control", () => ask(quote(LOOT)));

  const after = await tokenBalance();
  console.log(`\nVault token balance: ${fmtUsdc(before)} before, ${fmtUsdc(after)} after.`);
  console.log(broke === 0 && after === before ? "Nothing moved. Every attempt above is on the public record:" : "Something moved. Please report it:");
  console.log(`  ${explorerAccount(c.network, c.vault)}`);
}

main().catch((e) => {
  console.error(short(e));
  process.exit(1);
});
