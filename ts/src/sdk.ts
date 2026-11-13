/**
 * @almoner/near SDK: typed client for the Almoner Vault contract.
 *
 * - Views use a plain RPC provider (no keys).
 * - Agent calls are signed with a vault-issued agent key: the signer account is
 *   the vault itself, and the key can only call the agent methods.
 * - Owner and seller calls are signed by their own accounts.
 */
import { createHash, randomBytes } from "node:crypto";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";

export const TGAS = 1_000_000_000_000n;
export const USDC_DECIMALS = 6;

// ---------- contract types (mirror contracts/vault/src/types.rs) ----------

export interface TaskInput {
  name: string;
  purpose: string;
  categories: string[];
  blocked_terms: string[];
  allowed_sellers: string[];
  budget: string;
  max_per_purchase: string;
  approval_above: string;
  max_purchases_per_hour: number;
  reuse_window_ms: number;
  delivery_window_ms: number;
  review_window_ms: number;
  expires_at_ms: number;
}

export type TaskStatus = "Active" | "Paused" | "Closed";

export interface TaskView {
  id: number;
  rules: TaskInput;
  status: TaskStatus;
  version: number;
  mandate_hash: string;
  spent: string;
  reserved: string;
  remaining: string;
  created_ms: number;
  updated_ms: number;
}

