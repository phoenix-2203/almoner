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

  view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.provider.callFunction({ contractId: this.vaultId, method, args }) as Promise<T>;
  }

  getVault = () => this.view<VaultView>("get_vault");
  getTask = (task_id: number) => this.view<TaskView | null>("get_task", { task_id });
  getTasks = () => this.view<TaskView[]>("get_tasks");
  getAgents = () => this.view<{ name: string; public_key: string; task_ids: number[]; active: boolean; requests: number }[]>("get_agents");
  getSellers = () => this.view<SellerView[]>("get_sellers");
  getSeller = (account_id: string) => this.view<SellerView | null>("get_seller", { account_id });
  getPurchase = (purchase_id: number) => this.view<Purchase | null>("get_purchase", { purchase_id });
  getPurchases = (limit = 50) => this.view<Purchase[]>("get_purchases", { limit });
  getLog = (from_index = 0, limit = 200) => this.view<LogEntry[]>("get_log", { from_index, limit });
  verifyLog = () => this.view<boolean>("verify_log");
  getMandateJson = (task_id: number) => this.view<string | null>("get_mandate_json", { task_id });

  /** Client signed by a vault-issued agent key. */
  agent(agentKey: KeyPairString) {
    const acct = new Account(this.vaultId, this.rpcUrl, agentKey);
    const call = <T>(methodName: string, args: object, gas: bigint) =>
      acct.callFunction<T & object>({ contractId: this.vaultId, methodName, args, gas }) as Promise<T>;
    return {
      publicKey: KeyPair.fromString(agentKey).getPublicKey().toString(),
      requestPurchase: (a: { task_id: number; mandate_hash: string; signed: SignedQuote; reason: string; idempotency_key: string }) =>
        call<Purchase>(
          "request_purchase",
          { task_id: a.task_id, mandate_hash: a.mandate_hash, quote: a.signed.quote, signature: a.signed.signature, reason: a.reason, idempotency_key: a.idempotency_key },
          60n * TGAS,
        ),
      confirmDelivery: (purchase_id: number, accept: boolean, note?: string) =>
        call<Purchase>("confirm_delivery", { purchase_id, accept, note: note ?? null }, 100n * TGAS),
      settleExpired: (purchase_id: number) => call<Purchase>("settle_expired", { purchase_id }, 100n * TGAS),
    };
  }

  /** Client for the vault owner (their own account). */
  owner(ownerId: string, ownerKey: KeyPairString) {
    const acct = new Account(ownerId, this.rpcUrl, ownerKey);
    const call = <T>(methodName: string, args: object, gas = 50n * TGAS, deposit: bigint = 0n) =>
      acct.callFunction<T & object>({ contractId: this.vaultId, methodName, args, gas, deposit }) as Promise<T>;
    return {
      account: acct,
      createTask: (rules: TaskInput) => call<TaskView>("create_task", { rules }),
      updateTask: (task_id: number, rules: TaskInput) => call<TaskView>("update_task", { task_id, rules }),
      setTaskStatus: (task_id: number, status: TaskStatus) => call<void>("set_task_status", { task_id, status }),
      addAgent: (public_key: string, name: string, task_ids: number[], allowanceYocto?: string) =>
        call<void>("add_agent", { public_key, name, task_ids, allowance: allowanceYocto ?? null }, 50n * TGAS),
      revokeAgent: (public_key: string) => call<void>("revoke_agent", { public_key }),
      approve: (purchase_id: number) => call<Purchase>("approve_purchase", { purchase_id }),
      reject: (purchase_id: number, note?: string) => call<Purchase>("reject_purchase", { purchase_id, note: note ?? null }),
      review: (purchase_id: number, accept: boolean, note?: string) =>
        call<Purchase>("owner_review", { purchase_id, accept, note: note ?? null }, 100n * TGAS),
      clearHold: (seller: string) => call<void>("clear_seller_hold", { seller }),
      setFrozen: (frozen: boolean) => call<void>("set_frozen", { frozen }),
      withdraw: (amount: string) => call<boolean>("withdraw", { amount }, 100n * TGAS),
    };
  }

  /** Client for a seller (their own account). */
  seller(sellerId: string, sellerKey: KeyPairString) {
    const acct = new Account(sellerId, this.rpcUrl, sellerKey);
    return {
      register: (name: string, quote_key: string, about: string) =>
        acct.callFunction({
          contractId: this.vaultId,
          methodName: "register_seller",
          args: { name, quote_key, about },
          gas: 30n * TGAS,
          deposit: 10_000_000_000_000_000_000_000n, // 0.01 NEAR
        }),
      deliver: (purchase_id: number, result_hash: string) =>
        acct.callFunction<Purchase & object>({
          contractId: this.vaultId,
          methodName: "deliver",
          args: { purchase_id, result_hash },
          gas: 30n * TGAS,
        }) as Promise<Purchase>,
    };
  }
}
