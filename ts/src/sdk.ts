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

/** One teragas (10^12 gas). Calls attach multiples of this. */
export const TGAS = 1_000_000_000_000n;
/** Decimals of the vault token (tUSDC on testnet): 1 tUSDC = 1_000_000 base units. */
export const USDC_DECIMALS = 6;

// ---------- contract types (mirror contracts/vault/src/types.rs) ----------

/** A mandate: what an agent may buy under a task, and how much. Amounts are base-unit strings. */
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

/** Lifecycle of a task. Only Active tasks accept purchase requests. */
export type TaskStatus = "Active" | "Paused" | "Closed";

/** A task as stored on-chain, with its mandate hash and spend so far. */
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

/** A seller's offer for one item. Signed by the seller's quote key; the vault verifies it. */
export interface Quote {
  seller: string;
  item: string;
  category: string;
  description: string;
  price: string;
  expires_at_ms: number;
  nonce: string;
}

/** A Quote plus the seller's ed25519 signature over quoteMessage(vault, quote). */
export interface SignedQuote {
  quote: Quote;
  /** base64 ed25519 signature over quoteMessage(vault, quote) */
  signature: string;
}

/** Where a purchase stands. Declined and Rejected are refusals; Paid and Refunded are final. */
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

/** One purchase request and everything that happened to it. `code` and `detail` hold the vault's decision. */
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

/** A registered seller, with its delivery record and hold state. */
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

/** Vault totals: owner, token, balance, reserved escrow, counts and the log head. */
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

/** A sub-mandate an agent handed to a sub-agent (contracts/vault/src/sub.rs). */
export interface SubMandateView {
  agent: string;
  parent: string;
  name: string;
  task_id: number;
  budget: string;
  max_per_purchase: string;
  expires_at_ms: number;
  spent: string;
  reserved: string;
  depth: number;
  revoked: boolean;
  created_ms: number;
  remaining: string;
  usable: boolean;
}

/** One entry of the vault's hash-chained decision log. */
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

/** SHA-256 of a string or bytes, as lowercase hex. */
export const sha256hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** tUSDC amount (e.g. 0.5) to a base-unit string ("500000"). */
export const usdc = (amount: number) => BigInt(Math.round(amount * 10 ** USDC_DECIMALS)).toString();
/** yoctoNEAR to a short NEAR string. A key's allowance is spent by the gas a call attaches (about 0.001 NEAR per TGas on testnet). */
export const fmtNear = (yocto: bigint) => (yocto < 0n ? "unlimited" : (Number(yocto / 10n ** 20n) / 10000).toFixed(3) + " NEAR");
/** Base units to a short display string such as "0.500 tUSDC". */
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

/** Sign a quote with a seller's quote key (seller side). Fields must not contain newlines. */
export function signQuote(vault: string, q: Quote, quoteKey: KeyPairString): SignedQuote {
  for (const f of [q.item, q.category, q.nonce]) {
    if (f.includes("\n")) throw new Error("quote fields must not contain newlines");
  }
  const kp = KeyPair.fromString(quoteKey);
  const sig = kp.sign(new TextEncoder().encode(quoteMessage(vault, q))).signature;
  return { quote: q, signature: Buffer.from(sig).toString("base64") };
}

/** A random 24-hex-character nonce for quotes and idempotency keys. */
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

/** Check a quote against a mandate locally before spending gas. The vault re-checks everything on-chain. */
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

/** Explorer link for a transaction hash. */
export const explorerTx = (network: string, hash: string) =>
  network === "mainnet" ? `https://nearblocks.io/txns/${hash}` : `https://testnet.nearblocks.io/txns/${hash}`;
/** Explorer link for an account. */
export const explorerAccount = (network: string, id: string) =>
  network === "mainnet" ? `https://nearblocks.io/address/${id}` : `https://testnet.nearblocks.io/address/${id}`;

// ---------- client ----------

/**
 * Client for one Almoner vault. Views need no keys; agent(), owner() and seller() return signers for each role.
 * @param vaultId the vault contract account, e.g. "vault.example.testnet"
 * @param rpcUrl a NEAR RPC endpoint, e.g. "https://rpc.testnet.near.org"
 */
export class AlmonerVault {
  readonly provider: JsonRpcProvider;
  constructor(readonly vaultId: string, readonly rpcUrl: string) {
    this.provider = new JsonRpcProvider({ url: rpcUrl });
  }

  /** Call any view method on the vault. */
  view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.provider.callFunction({ contractId: this.vaultId, method, args }) as Promise<T>;
  }

  /** Vault totals. */
  getVault = () => this.view<VaultView>("get_vault");
  /** One task, or null. */
  getTask = (task_id: number) => this.view<TaskView | null>("get_task", { task_id });
  /** All tasks. */
  getTasks = () => this.view<TaskView[]>("get_tasks");
  /** All agent keys issued by the owner. */
  getAgents = () => this.view<{ name: string; public_key: string; task_ids: number[]; active: boolean; requests: number }[]>("get_agents");
  /** All registered sellers. */
  getSellers = () => this.view<SellerView[]>("get_sellers");
  /** One seller, or null. */
  getSeller = (account_id: string) => this.view<SellerView | null>("get_seller", { account_id });
  /** One purchase, or null. */
  getPurchase = (purchase_id: number) => this.view<Purchase | null>("get_purchase", { purchase_id });
  /** The most recent purchases. */
  getPurchases = (limit = 50) => this.view<Purchase[]>("get_purchases", { limit });
  /** Log entries from an index. */
  getLog = (from_index = 0, limit = 200) => this.view<LogEntry[]>("get_log", { from_index, limit });
  /** True if the on-chain log's hash chain is intact. */
  verifyLog = () => this.view<boolean>("verify_log");
  /** Sub-mandates handed out by agents. Empty on a vault whose contract predates them. */
  getSubMandates = () => this.view<SubMandateView[]>("get_sub_mandates").catch(() => [] as SubMandateView[]);
  /** The exact mandate JSON a task's mandate_hash commits to. */
  getMandateJson = (task_id: number) => this.view<string | null>("get_mandate_json", { task_id });

  /** Remaining gas allowance (yoctoNEAR) of a function-call key on the vault, or null if the key is gone. */
  async keyAllowance(publicKey: string): Promise<bigint | null> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key", finality: "optimistic", account_id: this.vaultId, public_key: publicKey } }),
    });
    const j: any = await res.json();
    const fc = j?.result?.permission?.FunctionCall;
    if (!fc) return null;
    return fc.allowance == null ? -1n : BigInt(fc.allowance);
  }

  /** NEAR balance (yoctoNEAR) of any account. */
  async nearBalance(accountId: string): Promise<bigint> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "optimistic", account_id: accountId } }),
    });
    const j: any = await res.json();
    return BigInt(j?.result?.amount ?? 0);
  }

  /** Client signed by a vault-issued agent key. */
  agent(agentKey: KeyPairString) {
    const acct = new Account(this.vaultId, this.rpcUrl, agentKey);
    const call = <T>(methodName: string, args: object, gas: bigint) =>
      acct.callFunction<T & object>({ contractId: this.vaultId, methodName, args, gas }) as Promise<T>;
    return {
      publicKey: KeyPair.fromString(agentKey).getPublicKey().toString(),
      requestPurchase: (a: { task_id: number; mandate_hash: string; signed: SignedQuote; reason: string; idempotency_key: string; gas?: bigint }) =>
        call<Purchase>(
          "request_purchase",
          { task_id: a.task_id, mandate_hash: a.mandate_hash, quote: a.signed.quote, signature: a.signed.signature, reason: a.reason, idempotency_key: a.idempotency_key },
          a.gas ?? 60n * TGAS,
        ),
      confirmDelivery: (purchase_id: number, accept: boolean, note?: string) =>
        call<Purchase>("confirm_delivery", { purchase_id, accept, note: note ?? null }, 100n * TGAS),
      settleExpired: (purchase_id: number) => call<Purchase>("settle_expired", { purchase_id }, 100n * TGAS),
      /** Hand part of the task to a sub-agent. Can only narrow; needs a key issued with the right to delegate. */
      delegate: (a: { public_key: string; name: string; task_id: number; budget: string; max_per_purchase?: string; expires_at_ms?: number }) =>
        call<void>("delegate", { public_key: a.public_key, name: a.name, task_id: a.task_id, budget: a.budget, max_per_purchase: a.max_per_purchase ?? null, expires_at_ms: a.expires_at_ms ?? null }, 40n * TGAS),
      revokeDelegate: (public_key: string) => call<void>("revoke_delegate", { public_key }, 40n * TGAS),
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
      addAgent: (public_key: string, name: string, task_ids: number[], allowanceYocto?: string, canDelegate = false) =>
        call<void>("add_agent", { public_key, name, task_ids, allowance: allowanceYocto ?? null, ...(canDelegate ? { can_delegate: true } : {}) }, 50n * TGAS),
      revokeDelegate: (public_key: string) => call<void>("revoke_delegate", { public_key }),
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

// ---------------------------------------------------------------------------
// Helpers for app developers: one-call buy, one-call agent setup, typed errors.
// Nothing above this line depends on them.
// ---------------------------------------------------------------------------

/** What went wrong when a call could not reach a decision at all. A vault refusal is never an AlmonerError. */
export type AlmonerErrorKind =
  | "revoked_key" // the agent's access key no longer exists on the vault (revoked, or never issued)
  | "out_of_gas" // the key's gas allowance is used up; the owner must issue a new key
  | "network" // the NEAR RPC or the seller could not be reached
  | "seller" // the seller answered with an error (no quote, unknown item, delivery refused)
  | "contract"; // the contract panicked (bad arguments, wrong caller, unknown task)

/** A network or protocol failure. Refusals by the vault are returned as data (see BuyResult), not thrown. */
export class AlmonerError extends Error {
  /** Machine-readable category of the failure. */
  readonly kind: AlmonerErrorKind;
  /** The underlying error, if any. */
  readonly cause?: unknown;
  constructor(kind: AlmonerErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = "AlmonerError";
    this.kind = kind;
    this.cause = cause;
  }
}

/** Turns any error thrown by near-api-js or fetch into an AlmonerError with a kind. Already-typed errors pass through. */
export function toAlmonerError(e: unknown): AlmonerError {
  if (e instanceof AlmonerError) return e;
  const m = String((e as any)?.message ?? e);
  const type = String((e as any)?.type ?? (e as any)?.cause?.name ?? "");
  const all = `${type} ${m}`;
  if (/NotEnoughAllowance|allowance/i.test(all)) return new AlmonerError("out_of_gas", "the agent key's gas allowance is used up; issue a new key", e);
  if (/AccessKeyDoesNotExist|InvalidAccessKey|access key .*does not exist|Can't complete the action because access key/i.test(all))
    return new AlmonerError("revoked_key", "the agent key does not exist on the vault (revoked or never issued)", e);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network|socket/i.test(all)) return new AlmonerError("network", m, e);
  return new AlmonerError("contract", m, e);
}

/** A delivered result is acceptable if it hashes to what the seller committed on-chain and is data, not an error message. */
export function checkDelivery(result: string, onChainHash: string | null): { ok: boolean; why: string } {
  if (!onChainHash || sha256hex(result) !== onChainHash) return { ok: false, why: "result doesn't match the hash the seller committed on-chain" };
  if (!result.trim()) return { ok: false, why: "empty body" };
  try {
    const j = JSON.parse(result);
    if (j && typeof j === "object" && "error" in j) return { ok: false, why: `error message instead of data: ${j.error}` };
  } catch {
    return { ok: false, why: "not valid JSON" };
  }
  return { ok: true, why: "hash matches and content is data" };
}

/** A seller's signed quote as returned by an Almoner seller server (POST {sellerUrl}/quote). */
export interface SellerQuote extends SignedQuote {
  /** The seller's note, e.g. "list price" or "counter at floor". */
  note?: string;
  /** The seller's list price, base units. */
  list?: string;
}

async function postJson(url: string, body: unknown): Promise<any> {
  let r: Response;
  try {
    r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    throw new AlmonerError("network", `could not reach ${url}`, e);
  }
  let j: any;
  try {
    j = await r.json();
  } catch (e) {
    throw new AlmonerError("seller", `${url} answered ${r.status} without JSON`, e);
  }
  if (!r.ok) throw new AlmonerError("seller", j?.error ?? `${url} answered ${r.status}`);
  return j;
}

/**
 * Ask a seller server for a signed quote.
 * @param sellerUrl base URL of one seller, e.g. "https://almoner.duckdns.org/api/datadesk"
 * @param item the catalog item URL to quote
 * @param opts.offer optional counter-offer in base units; the seller may accept it or counter at its floor
 * @param opts.vault the vault the quote is for (sellers serving several vaults need it)
 */
export function getQuote(sellerUrl: string, item: string, opts: { offer?: string; vault?: string } = {}): Promise<SellerQuote> {
  return postJson(`${sellerUrl.replace(/\/$/, "")}/quote`, { item, ...opts });
}

/** The outcome of buy(): the vault's decision, always as data. */
export interface BuyResult {
  /** True only if the purchase ended Paid (or Delivered/PayoutPending on the way to Paid). */
  paid: boolean;
  /** The purchase status the vault ended at: Declined, PendingApproval, Reused, Paid, Refunded, ... */
  status: PurchaseStatus;
  /** The vault's decision code for the request, e.g. APPROVED_ESCROW, INTENT_MISMATCH, QUOTE_INVALID, NEEDS_APPROVAL. */
  code: string;
  /** The vault's reason, in words. */
  detail: string;
  /** The full purchase record as it stands after the last step. */
  purchase: Purchase;
  /** The quote that was sent to the vault. */
  quote: SellerQuote;
  /** The delivered result, if the seller delivered. */
  result?: string;
  /** Why the agent accepted or rejected the delivery, if it got that far. */
  review?: { ok: boolean; why: string };
}

/** Options for buy(). */
export interface BuyOptions {
  /** Base URL of one seller server, e.g. "https://almoner.duckdns.org/api/datadesk". */
  sellerUrl: string;
  /** Catalog item URL to buy. */
  item: string;
  /** Task (mandate) id the agent key is allowed to spend under. */
  taskId: number;
  /** Why the agent wants it; stored on-chain with the request. */
  reason: string;
  /** Optional counter-offer in base units. */
  offer?: string;
  /** Repeat calls with the same key return the first purchase instead of buying twice. Default: random. */
  idempotencyKey?: string;
  /** Custom delivery check. Default: checkDelivery (hash matches, body is JSON data, not an error). */
  check?: (result: string, onChainHash: string | null) => { ok: boolean; why: string };
}

/**
 * The common agent flow in one call: get a signed quote from the seller, ask the vault, collect the delivery,
 * and accept or reject it on-chain. Every vault decision, including refusals, comes back as a BuyResult.
 * Throws AlmonerError only when no decision could be reached (network down, key revoked, gas allowance used up).
 */
export async function buy(vault: AlmonerVault, agentKey: KeyPairString, o: BuyOptions): Promise<BuyResult> {
  const agent = vault.agent(agentKey);
  const quote = await getQuote(o.sellerUrl, o.item, { ...(o.offer ? { offer: o.offer } : {}), vault: vault.vaultId });
  let p: Purchase;
  try {
    const task = await vault.getTask(o.taskId);
    if (!task) throw new AlmonerError("contract", `task ${o.taskId} does not exist on ${vault.vaultId}`);
    p = await agent.requestPurchase({
      task_id: o.taskId,
      mandate_hash: task.mandate_hash,
      signed: { quote: quote.quote, signature: quote.signature },
      reason: o.reason,
      idempotency_key: o.idempotencyKey ?? newNonce(),
    });
  } catch (e) {
    throw toAlmonerError(e);
  }
  const out = (purchase: Purchase, extra: Partial<BuyResult> = {}): BuyResult => ({
    paid: ["Paid", "Delivered", "PayoutPending"].includes(purchase.status),
    status: purchase.status,
    code: p.code,
    detail: p.detail,
    purchase,
    quote,
    ...extra,
  });
  if (p.status !== "Escrowed") return out(p);
  const { result } = await postJson(`${o.sellerUrl.replace(/\/$/, "")}/fulfil`, { purchase_id: p.id, vault: vault.vaultId });
  try {
    const delivered = (await vault.getPurchase(p.id))!;
    const review = (o.check ?? checkDelivery)(result, delivered.result_hash);
    const final = await agent.confirmDelivery(p.id, review.ok, review.ok ? undefined : review.why);
    return out(final, { result, review });
  } catch (e) {
    throw toAlmonerError(e);
  }
}

/** What setupAgent() returns. Keep agentKey secret: it is the only copy. */
export interface AgentSetup {
  /** The task (mandate) that was created. */
  task: TaskView;
  /** The new agent's private key. Give it to the agent; it can only ask the vault, never move funds. */
  agentKey: KeyPairString;
  /** The new agent's public key, as registered on the vault. Use it with owner.revokeAgent(). */
  publicKey: string;
}

/**
 * Owner flow in one call: create a task (mandate) and issue a fresh agent key limited to it.
 * @param vault the vault client
 * @param ownerId the vault owner's account id
 * @param ownerKey the owner's full-access key
 * @param rules the mandate: budget, limits, categories, blocked terms, sellers
 * @param agentName a label for the agent, stored on-chain
 * @param opts.allowanceYocto gas allowance for the agent key in yoctoNEAR (default: the contract's default)
 * @param opts.canDelegate let the agent hand narrower sub-mandates to sub-agents
 */
export async function setupAgent(
  vault: AlmonerVault,
  ownerId: string,
  ownerKey: KeyPairString,
  rules: TaskInput,
  agentName: string,
  opts: { allowanceYocto?: string; canDelegate?: boolean } = {},
): Promise<AgentSetup> {
  const owner = vault.owner(ownerId, ownerKey);
  const kp = KeyPair.fromRandom("ed25519");
  const publicKey = kp.getPublicKey().toString();
  try {
    const task = await owner.createTask(rules);
    await owner.addAgent(publicKey, agentName, [task.id], opts.allowanceYocto, opts.canDelegate ?? false);
    return { task, agentKey: kp.toString() as KeyPairString, publicKey };
  } catch (e) {
    throw toAlmonerError(e);
  }
}
