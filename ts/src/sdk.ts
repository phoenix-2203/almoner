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

export const usdc = (amount: number) => BigInt(Math.round(amount * 10 ** USDC_DECIMALS)).toString();
export const fmtUsdc = (base: string | bigint) => {
  const n = Number(BigInt(base)) / 10 ** USDC_DECIMALS;
  return `${n.toFixed(n < 1 ? 3 : 2)} tUSDC`;
};

/** Exact bytes a seller signs. Must match contracts/vault/src/intent.rs::quote_message. */
export function quoteMessage(vault: string, q: Quote): string {
  return [
    "almoner-quote/v1",
    vault,
    q.seller,
    q.item,
    q.category,
    BigInt(q.price).toString(),
    String(q.expires_at_ms),
    q.nonce,
    sha256hex(q.description),
  ].join("\n");
}

export function signQuote(vault: string, q: Quote, quoteKey: KeyPairString): SignedQuote {
  for (const f of [q.item, q.category, q.nonce]) {
    if (f.includes("\n")) throw new Error("quote fields must not contain newlines");
  }
  const kp = KeyPair.fromString(quoteKey);
  const sig = kp.sign(new TextEncoder().encode(quoteMessage(vault, q))).signature;
  return { quote: q, signature: Buffer.from(sig).toString("base64") };
}

export const newNonce = () => randomBytes(12).toString("hex");

/** Mirror of the on-chain IntentLock normalizer, for pre-flight checks. */
export function normalize(s: string): string {
  const pct = (x: string) => x.replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const map: Record<string, string> = { "0": "o", "1": "i", "!": "i", "|": "i", "3": "e", "4": "a", "@": "a", "5": "s", $: "s", "7": "t", "8": "b" };
  let out = "";
  for (const ch of pct(pct(s)).toLowerCase()) {
    if (map[ch]) out += map[ch];
    else if (/[a-z0-9]/.test(ch)) out += ch;
  }
  return out;
}

export function preflight(rules: TaskInput, q: Quote): { ok: true } | { ok: false; code: string; detail: string } {
  if (rules.categories.length && !rules.categories.includes(q.category.trim().toLowerCase())) {
    return { ok: false, code: "INTENT_MISMATCH", detail: `category '${q.category}' not in mandate` };
  }
  const hay = normalize(`${q.item} ${q.category} ${q.description}`);
  const hit = rules.blocked_terms.find((t) => normalize(t) && hay.includes(normalize(t)));
  if (hit) return { ok: false, code: "INTENT_MISMATCH", detail: `matches blocked term '${hit}'` };
  if (BigInt(q.price) > BigInt(rules.max_per_purchase)) return { ok: false, code: "OVER_PURCHASE_LIMIT", detail: "above per-purchase limit" };
  return { ok: true };
}

export const explorerTx = (network: string, hash: string) =>
  network === "mainnet" ? `https://nearblocks.io/txns/${hash}` : `https://testnet.nearblocks.io/txns/${hash}`;
export const explorerAccount = (network: string, id: string) =>
  network === "mainnet" ? `https://nearblocks.io/address/${id}` : `https://testnet.nearblocks.io/address/${id}`;

// ---------- client ----------

export class AlmonerVault {
  readonly provider: JsonRpcProvider;
  constructor(readonly vaultId: string, readonly rpcUrl: string) {
    this.provider = new JsonRpcProvider({ url: rpcUrl });
  }
}
