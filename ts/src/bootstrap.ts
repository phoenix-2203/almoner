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

