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

export interface Quote {
  seller: string;
  item: string;
  category: string;
  description: string;
  price: string;
  expires_at_ms: number;
  nonce: string;
}

export interface SignedQuote {
  quote: Quote;
  /** base64 ed25519 signature over quoteMessage(vault, quote) */
  signature: string;
}

export type PurchaseStatus =
  | "Declined"
  | "Reused"
  | "PendingApproval"
  | "Rejected"
  | "Escrowed"
  | "Delivered"
  | "PayoutPending"
  | "Paid"
  | "Refunded";

export interface Purchase {
  id: number;
  task_id: number;
  mandate_version: number;
  agent: string;
  seller: string;
  item: string;
  category: string;
  description: string;
  price: string;
  reason: string;
  status: PurchaseStatus;
  code: string;
  detail: string;
  quote_nonce: string;
  created_ms: number;
  deliver_by_ms: number;
  delivered_ms: number;
  result_hash: string | null;
  review_by_ms: number;
  settled_ms: number;
  reused_from: number | null;
}

export interface SellerView {
  account_id: string;
  name: string;
  about: string;
  quote_key: string;
  on_hold: boolean;
  hold_reason: string;
  registered_ms: number;
  stats: { delivered_ok: number; auto_released: number; rejected: number; missed: number; earned: string };
  delivery_score_bps: number;
  settled: number;
}

export interface VaultView {
  owner: string;
  token: string;
  frozen: boolean;
  balance: string;
  reserved: string;
  available: string;
  tasks: number;
  agents: number;
  sellers: number;
  purchases: number;
  log_len: number;
  log_head: string;
}

export interface LogEntry {
  seq: number;
  at_ms: number;
  kind: string;
  purchase_id: number | null;
  code: string;
  prev_hash: string;
  hash: string;
}

// ---------- helpers ----------

export const sha256hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

