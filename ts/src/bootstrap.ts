/**
 * One-command testnet setup. Needs only OWNER_ACCOUNT_ID + OWNER_PRIVATE_KEY
 * (a funded testnet account with about 9 NEAR) and the two built wasm files.
 *
 * Creates sub-accounts of the owner, deploys and initialises the contracts,
 * funds the vault, registers two sellers, signs the task mandate and issues
 * the agent key. Safe to re-run: existing steps are skipped.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Account, KeyPair, type KeyPairString } from "near-api-js";
import { AlmonerVault, TGAS, usdc, type TaskInput } from "./sdk.js";
import { NETWORK, ROOT, RPC, STATE_FILE, ownerCreds, saveState, type State } from "./config.js";
import { CATALOG } from "./sellers.js";

const NEAR = (n: number) => BigInt(Math.round(n * 1000)) * 10n ** 21n;

function findWasm(name: string): string {
  const candidates = [
    process.env[`${name.toUpperCase()}_WASM`],
    join(ROOT, "wasm", `${name}.wasm`),
    join(ROOT, "target", "near", name, `${name}.wasm`),
    join(ROOT, "target", "near", `${name}.wasm`),
    join(ROOT, "target", "wasm32-unknown-unknown", "release", `${name}.wasm`),
  ].filter(Boolean) as string[];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error(`Can't find ${name}.wasm. Run \`./scripts/build.sh\` (or download the CI artifact into ./wasm). Looked in:\n  ${candidates.join("\n  ")}`);
  return hit;
}

async function exists(id: string) {
  try {
    await new Account(id, RPC).getState();
    return true;
  } catch {
    return false;
  }
}

async function hasCode(id: string) {
  const s: any = await new Account(id, RPC).getState();
  const hash = s.codeHash ?? s.code_hash;
  return hash && hash !== "11111111111111111111111111111111";
}

const newKey = () => KeyPair.fromRandom("ed25519").toString() as KeyPairString;

async function main() {
  const { accountId: ownerId, key: ownerKey } = ownerCreds();
  const owner = new Account(ownerId, RPC, ownerKey);
  const prev: Partial<State> = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
  const state: State = {
    network: NETWORK,
    owner: { accountId: ownerId },
    token: prev.token ?? { accountId: `tusdc.${ownerId}`, key: newKey() },
    vault: prev.vault ?? { accountId: `vault.${ownerId}`, key: newKey() },
    sellers: prev.sellers ?? {
      datadesk: { accountId: `datadesk.${ownerId}`, key: newKey(), quoteKey: newKey() },
      junkdata: { accountId: `junkdata.${ownerId}`, key: newKey(), quoteKey: newKey() },
    },
    agent: prev.agent ?? (() => {
      const k = newKey();
      return { name: "night-shift-agent", key: k, publicKey: KeyPair.fromString(k).getPublicKey().toString() };
    })(),
    taskId: prev.taskId ?? 0,
  };
  saveState(state); // persist keys before creating anything

  console.log(`Owner ${ownerId} on ${NETWORK} via ${RPC}`);

  // 1. Accounts
  const plan: [string, KeyPairString, number][] = [
    [state.token.accountId, state.token.key, 2.5],
    [state.vault.accountId, state.vault.key!, 5],
    [state.sellers.datadesk.accountId, state.sellers.datadesk.key, 0.3],
    [state.sellers.junkdata.accountId, state.sellers.junkdata.key, 0.3],
  ];
  for (const [id, key, near] of plan) {
    if (await exists(id)) {
      console.log(`  = ${id} exists`);
      continue;
    }
    await owner.createSubAccount({ accountOrPrefix: id, publicKey: KeyPair.fromString(key).getPublicKey(), nearToTransfer: NEAR(near) });
    console.log(`  + created ${id} (${near} NEAR)`);
  }

  // 2. Contracts
  const token = new Account(state.token.accountId, RPC, state.token.key);
  if (!(await hasCode(token.accountId))) {
    await token.deployContract(readFileSync(findWasm("almoner_test_usdc")));
    await token.callFunction({ contractId: token.accountId, methodName: "new", args: {}, gas: 30n * TGAS });
    console.log(`  + deployed tUSDC to ${token.accountId}`);
  }
  const vaultAcct = new Account(state.vault.accountId, RPC, state.vault.key!);
  if (!(await hasCode(vaultAcct.accountId))) {
    await vaultAcct.deployContract(readFileSync(findWasm("almoner_vault")));
    await vaultAcct.callFunction({ contractId: vaultAcct.accountId, methodName: "new", args: { owner: ownerId, token: token.accountId }, gas: 30n * TGAS });
    console.log(`  + deployed Almoner Vault to ${vaultAcct.accountId}`);
  }

  const vault = new AlmonerVault(state.vault.accountId, RPC);
  const ownerApi = vault.owner(ownerId, ownerKey);

  // 3. Fund the vault with 20 tUSDC
  const v0 = await vault.getVault();
  if (BigInt(v0.balance) === 0n) {
    await owner.callFunction({ contractId: token.accountId, methodName: "faucet", args: { amount: usdc(100) }, gas: 30n * TGAS });
    await owner.callFunction({
      contractId: token.accountId,
      methodName: "ft_transfer_call",
      args: { receiver_id: vault.vaultId, amount: usdc(20), msg: "" },
      deposit: 1n,
      gas: 100n * TGAS,
    });
    console.log("  + funded vault with 20 tUSDC");
  }

  // 4. Sellers register their quote keys
  const onChain = await vault.getSellers();
  for (const [name, s] of Object.entries(state.sellers)) {
    if (onChain.some((x) => x.account_id === s.accountId)) continue;
    const about = name === "datadesk" ? "Market data and reports for agents." : "Cheap data. Very cheap.";
    await vault.seller(s.accountId, s.key).register(name === "datadesk" ? "DataDesk" : "JunkData", KeyPair.fromString(s.quoteKey).getPublicKey().toString(), about);
    console.log(`  + seller ${s.accountId} registered (${CATALOG[name].length} catalog items)`);
  }

  // 5. Owner signs the task mandate
  if (!state.taskId || !(await vault.getTask(state.taskId))) {
    const rules: TaskInput = {
      name: "Tonight's market brief",
      purpose: "Buy market data and reports for tonight's AI-agents market brief. Nothing else.",
      categories: ["market-data", "report"],
      blocked_terms: ["gift card", "crypto transfer", "seed phrase"],
      allowed_sellers: [state.sellers.datadesk.accountId, state.sellers.junkdata.accountId],
      budget: usdc(5),
      max_per_purchase: usdc(1),
      approval_above: usdc(0.25),
      max_purchases_per_hour: 30,
      reuse_window_ms: 3_600_000,
      delivery_window_ms: 10 * 60_000,
      review_window_ms: 10 * 60_000,
      expires_at_ms: Date.now() + 7 * 24 * 3_600_000,
    };
    const t = await ownerApi.createTask(rules);
    state.taskId = t.id;
    saveState(state);
    console.log(`  + task #${t.id} signed, mandate ${t.mandate_hash.slice(0, 16)}…`);
  }

  // 6. Vault issues the agent's function-call key
  const agents = await vault.getAgents();
  if (!agents.some((a) => a.public_key === state.agent.publicKey && a.active)) {
    await ownerApi.addAgent(state.agent.publicKey, state.agent.name, [state.taskId], NEAR(3).toString());
    console.log(`  + agent key issued: ${state.agent.publicKey.slice(0, 20)}… (function-call only, 3 NEAR gas allowance)`);
  }

  writeFileSync(
    join(ROOT, "web", "config.js"),
    `// Written by npm run bootstrap\nwindow.ALMONER = ${JSON.stringify({ vault: state.vault.accountId, rpc: RPC, network: NETWORK }, null, 2)};\n`,
  );
  console.log(`\nDone. Vault: ${state.vault.accountId}\nNext: \`npm run sellers\` in one terminal, \`npm run demo\` in another.`);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
