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

