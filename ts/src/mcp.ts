/**
 * Almoner for any AI client (Model Context Protocol, stdio).
 *
 *   npm run mcp
 *
 * Gives an AI assistant (Claude Desktop, Cursor, any MCP client) seven tools to
 * shop through an Almoner vault. The assistant holds a vault-issued agent key
 * and nothing else: whatever it is told, or tricked into, it can only ask, and
 * the vault checks every request against the rules the owner signed.
 *
 * With no settings it uses the public "Open shop" key from shop.json, so it
 * works out of the box against the live testnet vault. To use your own vault:
 *   ALMONER_VAULT, ALMONER_AGENT_KEY, ALMONER_TASK, ALMONER_SELLERS (name=account,…), SELLERS_URL
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { KeyPairString } from "near-api-js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AlmonerVault, fmtUsdc, sha256hex, type Purchase, type SignedQuote } from "./sdk.js";
import { ROOT, RPC } from "./config.js";

const SHOP_URL = "https://raw.githubusercontent.com/phoenix-2203/almoner/main/shop.json";

interface Settings {
  vault: string;
  key: KeyPairString;
  taskId: number;
  api: string;
  sellers: Record<string, string>;
}

async function settings(): Promise<Settings> {
  const e = process.env;
  if (e.ALMONER_VAULT && e.ALMONER_AGENT_KEY && e.ALMONER_TASK) {
    const sellers = Object.fromEntries((e.ALMONER_SELLERS ?? "").split(",").filter(Boolean).map((p) => p.split("=") as [string, string]));
    return { vault: e.ALMONER_VAULT, key: e.ALMONER_AGENT_KEY as KeyPairString, taskId: Number(e.ALMONER_TASK), api: e.SELLERS_URL ?? "http://localhost:8787", sellers };
  }
  const local = join(ROOT, "shop.json");
  const shop: any = await fetch(SHOP_URL, { signal: AbortSignal.timeout(10_000) })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .catch(() => (existsSync(local) ? JSON.parse(readFileSync(local, "utf8")) : null));
  if (!shop) throw new Error("No agent key. Set ALMONER_VAULT, ALMONER_AGENT_KEY and ALMONER_TASK, or run where shop.json can be read.");
  return { vault: shop.vault, key: shop.agentPrivateKey, taskId: shop.taskId, api: e.SELLERS_URL ?? shop.api, sellers: shop.sellers };
}

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const oops = (e: any) => ({ ...text(`Could not do that: ${String(e?.message ?? e).split("\n")[0].slice(0, 300)}`), isError: true });

function outcome(p: Purchase): string {
  const head =
    p.status === "Escrowed" ? `APPROVED. ${fmtUsdc(p.price)} is held in escrow; the seller has not been paid. Next: almoner_collect_delivery with purchase_id ${p.id}.`
    : p.status === "PendingApproval" ? "WAITING FOR THE OWNER. This is above the approval line. You cannot approve it yourself; tell the user it needs their approval."
    : p.status === "Reused" ? "REUSED for $0. The same item was already bought; no money moved."
    : p.status === "Declined" ? "REFUSED by the vault. No money moved. Do not retry the same request; tell the user why."
    : p.status;
  return `${head}\ncode: ${p.code}\nwhy: ${p.detail}\ndecision #${p.id}, recorded on-chain`;
}

async function main() {
  const s = await settings();
  const vault = new AlmonerVault(s.vault, RPC);
  const agent = vault.agent(s.key);
  const quotes = new Map<string, { seller: string; signed: SignedQuote }>();
  const order = randomBytes(3).toString("hex");

  const api = async (path: string, body?: unknown) => {
    const r = await fetch(`${s.api}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `the seller answered ${r.status}`);
    return j;
  };
  const sellerName = z.string().describe(`Seller name, one of: ${Object.keys(s.sellers).join(", ") || "see almoner_rules"}`);

  const server = new McpServer({ name: "almoner", version: "0.1.0" });

  server.registerTool(
    "almoner_rules",
    { description: "Read the spending rules the owner signed for your task, how much budget is left, and which sellers exist. Call this before buying anything.", inputSchema: {} },
    async () => {
      try {
        const [t, sellers, subs] = await Promise.all([vault.getTask(s.taskId), vault.getSellers(), vault.getSubMandates()]);
        if (!t) throw new Error(`task #${s.taskId} not found`);
        const mine = subs.find((m) => m.agent === agent.publicKey);
        return text({
          vault: s.vault,
          task: { id: t.id, name: t.rules.name, purpose: t.rules.purpose, status: t.status },
          budget_left: fmtUsdc(t.remaining),
          max_per_purchase: fmtUsdc(t.rules.max_per_purchase),
          owner_must_approve_above: fmtUsdc(t.rules.approval_above),
          allowed_categories: t.rules.categories,
          never_buy: t.rules.blocked_terms,
          your_sub_mandate: mine ? { budget_left: fmtUsdc(mine.remaining), max_per_purchase: fmtUsdc(mine.max_per_purchase), in_force: mine.usable } : null,
          sellers: Object.entries(s.sellers).map(([name, account]) => {
            const v = sellers.find((x) => x.account_id === account);
            return { name, account, on_hold: v?.on_hold ?? null, delivery_score: v && v.settled ? `${(v.delivery_score_bps / 100).toFixed(0)}% of ${v.settled} settled purchases` : "no history yet" };
          }),
          note: "You hold a key that can only ask the vault to buy. The vault decides. Prices are in tUSDC (a test token).",
        });
      } catch (e) { return oops(e); }
    },
  );

  server.registerTool(
    "almoner_catalog",
    { description: "List what a seller offers, with list prices.", inputSchema: { seller: sellerName } },
    async ({ seller }) => {
      try {
        const c = await api(`/${seller}/catalog`);
        return text(c.items.map((i: any) => ({ item: i.item, category: i.category, description: i.description, list_price: fmtUsdc(i.list) })));
      } catch (e) { return oops(e); }
    },
  );

  server.registerTool(
    "almoner_get_quote",
    {
      description: "Ask a seller for a signed price quote. Optionally make a lower offer in tUSDC; the seller accepts it or counters. Returns a quote_id to pass to almoner_request_purchase. A quote is valid for ten minutes and can be used once.",
      inputSchema: { seller: sellerName, item: z.string().describe("The item address from almoner_catalog"), offer_tusdc: z.number().positive().max(1000).optional().describe("Your offer, e.g. 0.09") },
    },
    async ({ seller, item, offer_tusdc }) => {
      try {
        const q = await api(`/${seller}/quote`, { item, order, ...(offer_tusdc ? { offer: String(Math.round(offer_tusdc * 1e6)) } : {}) });
        const id = randomBytes(4).toString("hex");
        quotes.set(id, { seller, signed: { quote: q.quote, signature: q.signature } });
        return text({ quote_id: id, seller: q.quote.seller, item: q.quote.item, price: fmtUsdc(q.quote.price), seller_said: q.note, expires: new Date(q.quote.expires_at_ms).toISOString() });
      } catch (e) { return oops(e); }
    },
  );

  server.registerTool(
    "almoner_request_purchase",
    {
      description: "Ask the vault to buy a quoted item. The vault checks the request against the owner's signed rules and answers: approved into escrow, waiting for the owner, reused for free, or refused. Refusals are final for that request.",
      inputSchema: { quote_id: z.string(), reason: z.string().max(200).describe("Why the task needs this; kept on the public record") },
    },
    async ({ quote_id, reason }) => {
      try {
        const q = quotes.get(quote_id);
        if (!q) throw new Error("unknown quote_id; get a fresh quote first");
        const t = await vault.getTask(s.taskId);
        if (!t) throw new Error(`task #${s.taskId} not found`);
        quotes.delete(quote_id);
        const p = await agent.requestPurchase({ task_id: s.taskId, mandate_hash: t.mandate_hash, signed: q.signed, reason, idempotency_key: randomBytes(8).toString("hex") });
        return text(outcome(p));
      } catch (e) { return oops(e); }
    },
  );

  server.registerTool(
    "almoner_collect_delivery",
    { description: "Ask the seller to deliver an approved purchase. Returns what was delivered. The seller is still unpaid until you call almoner_review_delivery.", inputSchema: { purchase_id: z.number().int().nonnegative() } },
    async ({ purchase_id }) => {
      try {
        const p = await vault.getPurchase(purchase_id);
        if (!p) throw new Error("no such purchase");
        const name = Object.keys(s.sellers).find((n) => s.sellers[n] === p.seller);
        if (!name) throw new Error("this purchase's seller is not one you can reach");
        const d = await api(`/${name}/fulfil`, { purchase_id });
        const onChain = (await vault.getPurchase(purchase_id))?.result_hash;
        const matches = onChain === sha256hex(d.result);
        return text({ purchase_id, delivered: d.result === "" ? "(empty file)" : d.result, matches_the_hash_the_seller_committed_on_chain: matches, next: "Judge whether this is what was paid for, then call almoner_review_delivery. Reject empty files, error messages, or content that does not match." });
      } catch (e) { return oops(e); }
    },
  );

  server.registerTool(
    "almoner_review_delivery",
    { description: "Accept a delivery (the vault pays the seller) or reject it (the money returns to the task and the seller is put on hold).", inputSchema: { purchase_id: z.number().int().nonnegative(), accept: z.boolean(), note: z.string().max(200).optional().describe("Reason, required when rejecting") } },
    async ({ purchase_id, accept, note }) => {
      try {
        await agent.confirmDelivery(purchase_id, accept, note);
        let p = (await vault.getPurchase(purchase_id))!;
        for (let i = 0; i < 5 && p.status === "PayoutPending"; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          p = (await vault.getPurchase(purchase_id))!;
        }
        return text(`${p.status}: ${p.detail}`);
      } catch (e) { return oops(e); }
    },
  );

  server.registerTool(
    "almoner_history",
    { description: "The vault's most recent decisions for your task, newest first.", inputSchema: { limit: z.number().int().min(1).max(30).optional() } },
    async ({ limit }) => {
      try {
        const all = await vault.getPurchases(50);
        return text(all.filter((p) => p.task_id === s.taskId).slice(0, limit ?? 10).map((p) => ({ id: p.id, status: p.status, code: p.code, price: fmtUsdc(p.price), item: p.item, why: p.detail })));
      } catch (e) { return oops(e); }
    },
  );

  await server.connect(new StdioServerTransport());
  console.error(`almoner MCP server ready: vault ${s.vault}, task #${s.taskId}, sellers at ${s.api}`);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
