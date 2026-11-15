// src/sdk.ts
import { createHash, randomBytes } from "node:crypto";
import { Account, JsonRpcProvider, KeyPair } from "near-api-js";
var TGAS = 1000000000000n;
var USDC_DECIMALS = 6;
var sha256hex = (data) => createHash("sha256").update(data).digest("hex");
var usdc = (amount) => BigInt(Math.round(amount * 10 ** USDC_DECIMALS)).toString();
var fmtNear = (yocto) => yocto < 0n ? "unlimited" : (Number(yocto / 10n ** 20n) / 1e4).toFixed(3) + " NEAR";
var fmtUsdc = (base) => {
  const n = Number(BigInt(base)) / 10 ** USDC_DECIMALS;
  return `${n.toFixed(n < 1 ? 3 : 2)} tUSDC`;
};
function quoteMessage(vault, q) {
  return [
    "almoner-quote/v1",
    vault,
    q.seller,
    q.item,
    q.category,
    BigInt(q.price).toString(),
    String(q.expires_at_ms),
    q.nonce,
    sha256hex(q.description)
  ].join("\n");
}
function signQuote(vault, q, quoteKey) {
  for (const f of [q.item, q.category, q.nonce]) {
    if (f.includes("\n")) throw new Error("quote fields must not contain newlines");
  }
  const kp = KeyPair.fromString(quoteKey);
  const sig = kp.sign(new TextEncoder().encode(quoteMessage(vault, q))).signature;
  return { quote: q, signature: Buffer.from(sig).toString("base64") };
}
var newNonce = () => randomBytes(12).toString("hex");
function normalize(s) {
  const pct = (x) => x.replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const map = { "0": "o", "1": "i", "!": "i", "|": "i", "3": "e", "4": "a", "@": "a", "5": "s", $: "s", "7": "t", "8": "b" };
  let out = "";
  for (const ch of pct(pct(s)).toLowerCase()) {
    if (map[ch]) out += map[ch];
    else if (/[a-z0-9]/.test(ch)) out += ch;
  }
  return out;
}
function preflight(rules, q) {
  if (rules.categories.length && !rules.categories.includes(q.category.trim().toLowerCase())) {
    return { ok: false, code: "INTENT_MISMATCH", detail: `category '${q.category}' not in mandate` };
  }
  const hay = normalize(`${q.item} ${q.category} ${q.description}`);
  const hit = rules.blocked_terms.find((t) => normalize(t) && hay.includes(normalize(t)));
  if (hit) return { ok: false, code: "INTENT_MISMATCH", detail: `matches blocked term '${hit}'` };
  if (BigInt(q.price) > BigInt(rules.max_per_purchase)) return { ok: false, code: "OVER_PURCHASE_LIMIT", detail: "above per-purchase limit" };
  return { ok: true };
}
var explorerTx = (network, hash) => network === "mainnet" ? `https://nearblocks.io/txns/${hash}` : `https://testnet.nearblocks.io/txns/${hash}`;
var explorerAccount = (network, id) => network === "mainnet" ? `https://nearblocks.io/address/${id}` : `https://testnet.nearblocks.io/address/${id}`;
var AlmonerVault = class {
  constructor(vaultId, rpcUrl) {
    this.vaultId = vaultId;
    this.rpcUrl = rpcUrl;
    this.provider = new JsonRpcProvider({ url: rpcUrl });
  }
  vaultId;
  rpcUrl;
  provider;
  /** Call any view method on the vault. */
  view(method, args = {}) {
    return this.provider.callFunction({ contractId: this.vaultId, method, args });
  }
  /** Vault totals. */
  getVault = () => this.view("get_vault");
  /** One task, or null. */
  getTask = (task_id) => this.view("get_task", { task_id });
  /** All tasks. */
  getTasks = () => this.view("get_tasks");
  /** All agent keys issued by the owner. */
  getAgents = () => this.view("get_agents");
  /** All registered sellers. */
  getSellers = () => this.view("get_sellers");
  /** One seller, or null. */
  getSeller = (account_id) => this.view("get_seller", { account_id });
  /** One purchase, or null. */
  getPurchase = (purchase_id) => this.view("get_purchase", { purchase_id });
  /** The most recent purchases. */
  getPurchases = (limit = 50) => this.view("get_purchases", { limit });
  /** Log entries from an index. */
  getLog = (from_index = 0, limit = 200) => this.view("get_log", { from_index, limit });
  /** True if the on-chain log's hash chain is intact. */
  verifyLog = () => this.view("verify_log");
  /** Sub-mandates handed out by agents. Empty on a vault whose contract predates them. */
  getSubMandates = () => this.view("get_sub_mandates").catch(() => []);
  /** The exact mandate JSON a task's mandate_hash commits to. */
  getMandateJson = (task_id) => this.view("get_mandate_json", { task_id });
  /** Remaining gas allowance (yoctoNEAR) of a function-call key on the vault, or null if the key is gone. */
  async keyAllowance(publicKey) {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key", finality: "optimistic", account_id: this.vaultId, public_key: publicKey } })
    });
    const j = await res.json();
    const fc = j?.result?.permission?.FunctionCall;
    if (!fc) return null;
    return fc.allowance == null ? -1n : BigInt(fc.allowance);
  }
  /** NEAR balance (yoctoNEAR) of any account. */
  async nearBalance(accountId) {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "optimistic", account_id: accountId } })
    });
    const j = await res.json();
    return BigInt(j?.result?.amount ?? 0);
  }
  /** Client signed by a vault-issued agent key. */
  agent(agentKey) {
    const acct = new Account(this.vaultId, this.rpcUrl, agentKey);
    const call = (methodName, args, gas) => acct.callFunction({ contractId: this.vaultId, methodName, args, gas });
    return {
      publicKey: KeyPair.fromString(agentKey).getPublicKey().toString(),
      requestPurchase: (a) => call(
        "request_purchase",
        { task_id: a.task_id, mandate_hash: a.mandate_hash, quote: a.signed.quote, signature: a.signed.signature, reason: a.reason, idempotency_key: a.idempotency_key },
        a.gas ?? 60n * TGAS
      ),
      confirmDelivery: (purchase_id, accept, note) => call("confirm_delivery", { purchase_id, accept, note: note ?? null }, 100n * TGAS),
      settleExpired: (purchase_id) => call("settle_expired", { purchase_id }, 100n * TGAS),
      /** Hand part of the task to a sub-agent. Can only narrow; needs a key issued with the right to delegate. */
      delegate: (a) => call("delegate", { public_key: a.public_key, name: a.name, task_id: a.task_id, budget: a.budget, max_per_purchase: a.max_per_purchase ?? null, expires_at_ms: a.expires_at_ms ?? null }, 40n * TGAS),
      revokeDelegate: (public_key) => call("revoke_delegate", { public_key }, 40n * TGAS)
    };
  }
  /** Client for the vault owner (their own account). */
  owner(ownerId, ownerKey) {
    const acct = new Account(ownerId, this.rpcUrl, ownerKey);
    const call = (methodName, args, gas = 50n * TGAS, deposit = 0n) => acct.callFunction({ contractId: this.vaultId, methodName, args, gas, deposit });
    return {
      account: acct,
      createTask: (rules) => call("create_task", { rules }),
      updateTask: (task_id, rules) => call("update_task", { task_id, rules }),
      setTaskStatus: (task_id, status) => call("set_task_status", { task_id, status }),
      addAgent: (public_key, name, task_ids, allowanceYocto, canDelegate = false) => call("add_agent", { public_key, name, task_ids, allowance: allowanceYocto ?? null, ...canDelegate ? { can_delegate: true } : {} }, 50n * TGAS),
      revokeDelegate: (public_key) => call("revoke_delegate", { public_key }),
      revokeAgent: (public_key) => call("revoke_agent", { public_key }),
      approve: (purchase_id) => call("approve_purchase", { purchase_id }),
      reject: (purchase_id, note) => call("reject_purchase", { purchase_id, note: note ?? null }),
      review: (purchase_id, accept, note) => call("owner_review", { purchase_id, accept, note: note ?? null }, 100n * TGAS),
      clearHold: (seller) => call("clear_seller_hold", { seller }),
      setFrozen: (frozen) => call("set_frozen", { frozen }),
      withdraw: (amount) => call("withdraw", { amount }, 100n * TGAS)
    };
  }
  /** Client for a seller (their own account). */
  seller(sellerId, sellerKey) {
    const acct = new Account(sellerId, this.rpcUrl, sellerKey);
    return {
      register: (name, quote_key, about) => acct.callFunction({
        contractId: this.vaultId,
        methodName: "register_seller",
        args: { name, quote_key, about },
        gas: 30n * TGAS,
        deposit: 10000000000000000000000n
        // 0.01 NEAR
      }),
      deliver: (purchase_id, result_hash) => acct.callFunction({
        contractId: this.vaultId,
        methodName: "deliver",
        args: { purchase_id, result_hash },
        gas: 30n * TGAS
      })
    };
  }
};
var AlmonerError = class extends Error {
  /** Machine-readable category of the failure. */
  kind;
  /** The underlying error, if any. */
  cause;
  constructor(kind, message, cause) {
    super(message);
    this.name = "AlmonerError";
    this.kind = kind;
    this.cause = cause;
  }
};
function toAlmonerError(e) {
  if (e instanceof AlmonerError) return e;
  const m = String(e?.message ?? e);
  const type = String(e?.type ?? e?.cause?.name ?? "");
  const all = `${type} ${m}`;
  if (/NotEnoughAllowance|allowance/i.test(all)) return new AlmonerError("out_of_gas", "the agent key's gas allowance is used up; issue a new key", e);
  if (/AccessKeyDoesNotExist|InvalidAccessKey|access key .*does not exist|Can't complete the action because access key/i.test(all))
    return new AlmonerError("revoked_key", "the agent key does not exist on the vault (revoked or never issued)", e);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network|socket/i.test(all)) return new AlmonerError("network", m, e);
  return new AlmonerError("contract", m, e);
}
function checkDelivery(result, onChainHash) {
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
async function postJson(url, body) {
  let r;
  try {
    r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    throw new AlmonerError("network", `could not reach ${url}`, e);
  }
  let j;
  try {
    j = await r.json();
  } catch (e) {
    throw new AlmonerError("seller", `${url} answered ${r.status} without JSON`, e);
  }
  if (!r.ok) throw new AlmonerError("seller", j?.error ?? `${url} answered ${r.status}`);
  return j;
}
function getQuote(sellerUrl, item, opts = {}) {
  return postJson(`${sellerUrl.replace(/\/$/, "")}/quote`, { item, ...opts });
}
async function buy(vault, agentKey, o) {
  const agent = vault.agent(agentKey);
  const quote = await getQuote(o.sellerUrl, o.item, { ...o.offer ? { offer: o.offer } : {}, vault: vault.vaultId });
  let p;
  try {
    const task = await vault.getTask(o.taskId);
    if (!task) throw new AlmonerError("contract", `task ${o.taskId} does not exist on ${vault.vaultId}`);
    p = await agent.requestPurchase({
      task_id: o.taskId,
      mandate_hash: task.mandate_hash,
      signed: { quote: quote.quote, signature: quote.signature },
      reason: o.reason,
      idempotency_key: o.idempotencyKey ?? newNonce()
    });
  } catch (e) {
    throw toAlmonerError(e);
  }
  const out = (purchase, extra = {}) => ({
    paid: ["Paid", "Delivered", "PayoutPending"].includes(purchase.status),
    status: purchase.status,
    code: p.code,
    detail: p.detail,
    purchase,
    quote,
    ...extra
  });
  if (p.status !== "Escrowed") return out(p);
  const { result } = await postJson(`${o.sellerUrl.replace(/\/$/, "")}/fulfil`, { purchase_id: p.id, vault: vault.vaultId });
  try {
    const delivered = await vault.getPurchase(p.id);
    const review = (o.check ?? checkDelivery)(result, delivered.result_hash);
    const final = await agent.confirmDelivery(p.id, review.ok, review.ok ? void 0 : review.why);
    return out(final, { result, review });
  } catch (e) {
    throw toAlmonerError(e);
  }
}
async function setupAgent(vault, ownerId, ownerKey, rules, agentName, opts = {}) {
  const owner = vault.owner(ownerId, ownerKey);
  const kp = KeyPair.fromRandom("ed25519");
  const publicKey = kp.getPublicKey().toString();
  try {
    const task = await owner.createTask(rules);
    await owner.addAgent(publicKey, agentName, [task.id], opts.allowanceYocto, opts.canDelegate ?? false);
    return { task, agentKey: kp.toString(), publicKey };
  } catch (e) {
    throw toAlmonerError(e);
  }
}
export {
  AlmonerError,
  AlmonerVault,
  TGAS,
  USDC_DECIMALS,
  buy,
  checkDelivery,
  explorerAccount,
  explorerTx,
  fmtNear,
  fmtUsdc,
  getQuote,
  newNonce,
  normalize,
  preflight,
  quoteMessage,
  setupAgent,
  sha256hex,
  signQuote,
  toAlmonerError,
  usdc
};
