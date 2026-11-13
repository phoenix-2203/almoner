import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KeyPairString } from "near-api-js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const STATE_FILE = join(ROOT, "ts", ".almoner", "state.json");

export const NETWORK = process.env.NEAR_NETWORK ?? "testnet";
export const RPC = process.env.NEAR_RPC ?? (NETWORK === "mainnet" ? "https://rpc.mainnet.fastnear.com" : "https://rpc.testnet.fastnear.com");
export const SELLERS_URL = process.env.SELLERS_URL ?? "http://localhost:8787";

/** Everything bootstrap creates. Contains testnet private keys: never commit it. */
export interface State {
  network: string;
  owner: { accountId: string };
  token: { accountId: string; key: KeyPairString };
  vault: { accountId: string; key: KeyPairString | null };
  sellers: Record<string, { accountId: string; key: KeyPairString; quoteKey: KeyPairString }>;
  agent: { name: string; key: KeyPairString; publicKey: string };
  taskId: number;
}

export function loadState(): State {
  if (!existsSync(STATE_FILE)) {
    throw new Error(`No ${STATE_FILE}. Run \`npm run bootstrap\` first.`);
  }
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

export function saveState(s: State) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

export function ownerCreds(): { accountId: string; key: KeyPairString } {
  const accountId = process.env.OWNER_ACCOUNT_ID;
  const key = process.env.OWNER_PRIVATE_KEY as KeyPairString | undefined;
  if (!accountId || !key) {
    throw new Error("Set OWNER_ACCOUNT_ID and OWNER_PRIVATE_KEY in ts/.env (testnet account only). See ts/.env.example.");
  }
  if (NETWORK !== "testnet") throw new Error("This demo only runs on testnet.");
  return { accountId, key };
}
