/**
 * Owner-only: open the public challenge.
 *
 * Signs a separate task ("Public challenge"), has the vault issue a fresh agent
 * key for it, and PUBLISHES that key's private half in challenge.json and
 * CHALLENGE.md. That is the point: an Almoner agent key can only ask the vault
 * to buy, so leaking it does not put the vault's funds at risk.
 *
 * The challenge key is kept apart from the demo agent: its own task, a small
 * budget and a small gas allowance, so spam can only burn that allowance.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KeyPair, type KeyPairString } from "near-api-js";
import { AlmonerVault, explorerAccount, usdc, type TaskInput } from "./sdk.js";
import { loadState, NETWORK, ownerCreds, ROOT, RPC } from "./config.js";

export const CHALLENGE_FILE = join(ROOT, "challenge.json");
const REPO = "https://github.com/phoenix-2203/almoner";
const PAGES = "https://phoenix-2203.github.io/almoner/";

async function main() {
  const state = loadState();
  const { accountId, key } = ownerCreds();
  const vault = new AlmonerVault(state.vault.accountId, RPC);
  const owner = vault.owner(accountId, key);

  let c: any = existsSync(CHALLENGE_FILE) ? JSON.parse(readFileSync(CHALLENGE_FILE, "utf8")) : null;
  if (c && c.vault !== state.vault.accountId) c = null;

  if (!c) {
    const rules: TaskInput = {
      name: "Public challenge",
      purpose: "Anyone holding the published agent key may try to make this vault pay. Only DataDesk reports are allowed.",
      categories: ["market-data", "report"],
      blocked_terms: ["gift card", "crypto transfer", "seed phrase"],
      allowed_sellers: [state.sellers.datadesk.accountId],
      budget: usdc(1),
      max_per_purchase: usdc(0.5),
      approval_above: usdc(0.25),
      max_purchases_per_hour: 20,
      reuse_window_ms: 0,
      delivery_window_ms: 10 * 60_000,
      review_window_ms: 10 * 60_000,
      expires_at_ms: Date.now() + 30 * 24 * 3_600_000,
    };
    const task = await owner.createTask(rules);
    console.log(`  + task #${task.id} "Public challenge" signed`);
    const agentKey = KeyPair.fromRandom("ed25519").toString() as KeyPairString;
    const publicKey = KeyPair.fromString(agentKey).getPublicKey().toString();
    // 0.1 NEAR of gas: enough for roughly a hundred attempts, then the key is spent.
    await owner.addAgent(publicKey, "public-challenge", [task.id], (10n ** 23n).toString());
    console.log(`  + vault issued the challenge key ${publicKey}`);
    c = {
      network: NETWORK,
      rpc: RPC,
      vault: state.vault.accountId,
      token: state.token.accountId,
      taskId: task.id,
      seller: state.sellers.datadesk.accountId,
      agentPublicKey: publicKey,
      agentPrivateKey: agentKey,
    };
    writeFileSync(CHALLENGE_FILE, JSON.stringify(c, null, 2) + "\n");
  } else {
    console.log("  = challenge already open; rewriting the docs");
  }

  const v = await vault.getVault();
  const holds = (Number(BigInt(v.balance)) / 1e6).toFixed(2);
  writeFileSync(
    join(ROOT, "CHALLENGE.md"),
    `# Here is the agent's private key. Try to take the money.

The Almoner vault below is live on NEAR ${NETWORK} and holds **${holds} tUSDC**.
This is a real agent key for it, published on purpose:

\`\`\`
vault        ${c.vault}
agent key    ${c.agentPrivateKey}
public key   ${c.agentPublicKey}
task         #${c.taskId} "Public challenge"
\`\`\`

On most agent wallets, leaking the agent's key means losing the wallet. Here the
vault issued this key **to its own account** as a NEAR function-call access key.
It can call three methods on the vault (\`request_purchase\`, \`confirm_delivery\`,
\`settle_expired\`) and nothing else. The NEAR protocol enforces that, not our code.

## Try it

\`\`\`bash
git clone ${REPO} && cd almoner/ts
npm ci
npm run attack
\`\`\`

\`npm run attack\` signs six attacks with the key above and prints what happened to
each. The first four are stopped by the NEAR protocol before they reach the
contract; the last two reach the vault, are refused, and are **recorded on-chain**:

| # | Attack | Stopped by |
| --- | --- | --- |
| 1 | Transfer NEAR out of the vault account | NEAR protocol: function-call keys can't transfer |
| 2 | Add a full-access key to the vault account | NEAR protocol |
| 3 | Call \`ft_transfer\` on the token contract directly | NEAR protocol: key is bound to the vault contract |
| 4 | Call the vault's owner-only \`withdraw\` | NEAR protocol: method isn't on the key's list |
| 5 | Ask the vault to pay a quote the attacker signed in a seller's name | Vault: \`QUOTE_INVALID\` |
| 6 | Ask the vault to pay an attacker-controlled "seller" | Vault: \`SELLER_UNKNOWN\` |

Write your own attack: the key works with any NEAR tool
(\`near-api-js\`, \`near-cli-rs\`). Signer account = the vault account.

## Watch the attempts

- Dashboard: ${PAGES} (every refusal appears under "Every decision")
- Explorer: ${explorerAccount(NETWORK, c.vault)}

## Honest limits

- The key has a gas allowance of 0.1 NEAR. Spam can burn that allowance, after
  which the key stops working. That is the worst case: the funds don't move.
- The key belongs to its own task with a 1 tUSDC budget and one allowed seller.
  The seller only signs quotes for real purchases, so without a seller-signed
  quote nothing can even be put into escrow.
- If you do find a way to move funds, please open an issue: that is a real bug.
- Testnet only. tUSDC is a test token with no value.
`,
  );
  writeFileSync(
    join(ROOT, "web", "config.js"),
    `// Written by npm run challenge:setup\nwindow.ALMONER = ${JSON.stringify({ vault: c.vault, rpc: RPC, network: NETWORK, challenge: { task: c.taskId, url: `${REPO}/blob/main/CHALLENGE.md` } }, null, 2)};\n`,
  );
  console.log("\nChallenge is open. Wrote challenge.json, CHALLENGE.md and web/config.js. Commit and push them.");
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
