/**
 * Demo seller agents (the "earn" side). One HTTP server hosts two sellers:
 *
 *  - datadesk: honest. Negotiates down to a floor price, delivers real data.
 *  - junkdata: cheaper, but delivers an empty body or an error. Also lists a
 *    disguised gift card to show IntentLock.
 *
 * Endpoints (per seller):
 *   GET  /:seller/catalog
 *   POST /:seller/quote   { item, offer? }  -> SignedQuote (list price, the offer, or a counter at the floor)
 *   POST /:seller/fulfil  { purchase_id }   -> { result, result_hash } after calling `deliver` on-chain
 *
 * Sellers never trust the agent: before delivering they read the purchase
 * from the vault and check it is Escrowed, addressed to them, at their price.
 *
 * The same server runs behind the public "Try it" page (see scripts/deploy-vps.sh).
 * There it is given only the sellers' keys (ALMONER_SELLERS_FILE), never the owner's.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { KeyPairString } from "near-api-js";
import { AlmonerVault, newNonce, sha256hex, signQuote, usdc, type Quote } from "./sdk.js";
import { existsSync, readFileSync } from "node:fs";
import { loadState, RPC } from "./config.js";

export interface CatalogItem {
  item: string;
  category: string;
  description: string;
  list: string;
  floor: string;
}

export const CATALOG: Record<string, CatalogItem[]> = {
  datadesk: [
    { item: "https://datadesk.example/reports/ai-agents-2026-11", category: "report", description: "AI agents market report, November 2026", list: usdc(0.12), floor: usdc(0.09) },
    { item: "https://datadesk.example/data/near-intents-volume-daily", category: "market-data", description: "Daily NEAR Intents swap volume by asset, last 30 days", list: usdc(0.06), floor: usdc(0.05) },
    { item: "https://datadesk.example/reports/premium-deep-dive", category: "report", description: "Premium deep dive: agent payments market map", list: usdc(0.6), floor: usdc(0.5) },
    { item: "https://datadesk.example/reports/analyst-briefing", category: "report", description: "Analyst briefing: stablecoin flows on NEAR", list: usdc(0.3), floor: usdc(0.3) },
    { item: "https://datadesk.example/extras/G1FT-c@rd-25", category: "report", description: "Thank-you extra for report buyers", list: usdc(0.1), floor: usdc(0.1) },
  ],
  junkdata: [
    { item: "https://junkdata.example/data/near-intents-volume-daily", category: "market-data", description: "Daily NEAR Intents volume (cheap!)", list: usdc(0.04), floor: usdc(0.03) },
    { item: "https://junkdata.example/bonus/G1FT-c@rd-50", category: "report", description: "Bonus report pack", list: usdc(0.2), floor: usdc(0.2) },
  ],
};

function deliverable(seller: string, item: string): string {
  if (seller === "junkdata") {
    // Junk: alternate between an empty body and an error message.
    return item.includes("volume") ? "" : JSON.stringify({ error: "upstream timeout" });
  }
  return JSON.stringify({
    source: item,
    generated_by: "DataDesk",
    summary: "Sample dataset (demo only): agent payment activity on NEAR, by asset.",
    rows: [
      { asset: "tUSDC", payments: 58_120 },
      { asset: "wNEAR", payments: 21_404 },
    ],
  });
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-max-age": "86400" };
const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...CORS });
  res.end(JSON.stringify(body));
};

/** What the server needs: the vault's id and each seller's account and quote keys. */
export interface SellerBook {
  vault: string;
  sellers: Record<string, { accountId: string; key: KeyPairString; quoteKey: KeyPairString }>;
}

/** On the public host only the sellers' keys are present; locally they come from bootstrap's state. */
export function loadSellerBook(): SellerBook {
  const file = process.env.ALMONER_SELLERS_FILE;
  if (file) {
    if (!existsSync(file)) throw new Error(`ALMONER_SELLERS_FILE points at ${file}, which does not exist.`);
    return JSON.parse(readFileSync(file, "utf8"));
  }
  const state = loadState();
  return { vault: state.vault.accountId, sellers: state.sellers };
}

// A visitor's copy of an item: "<catalog item>?order=<their tag>". Lets many people buy "the same" report.
const ORDER = /\?order=[a-z0-9]{4,16}$/;
const baseItem = (item: string) => item.replace(ORDER, "");

// Small per-address limit so one visitor can't use up the sellers' gas.
const hits = new Map<string, { n: number; at: number }>();
function limited(req: IncomingMessage, perMinute = 40): boolean {
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.at > 60_000) {
    if (hits.size > 5000) hits.clear();
    hits.set(ip, { n: 1, at: now });
    return false;
  }
  return ++h.n > perMinute;
}

const readBody = (req: IncomingMessage) =>
  new Promise<any>((resolve) => {
    let d = "";
    req.on("data", (c) => {
      d += c;
      if (d.length > 8192) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch {
        resolve({});
      }
    });
  });

export function startSellers(port = Number(process.env.SELLERS_PORT ?? 8787)) {
  const state = loadSellerBook();
  const vault = new AlmonerVault(state.vault, RPC);

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS);
        return res.end();
      }
      const [, name, action] = (req.url ?? "").split("?")[0].split("/");
      if (name === "health") return json(res, 200, { ok: true, vault: state.vault, sellers: Object.fromEntries(Object.entries(state.sellers).map(([k, v]) => [k, v.accountId])) });
      if (limited(req)) return json(res, 429, { error: "Too many requests from this address; wait a minute." });
      const s = state.sellers[name];
      const catalog = CATALOG[name];
      if (!s || !catalog) return json(res, 404, { error: "unknown seller" });

      if (req.method === "GET" && action === "catalog") return json(res, 200, { seller: s.accountId, items: catalog.map(({ floor, ...pub }) => pub) });

      if (req.method === "POST" && action === "quote") {
        const body = await readBody(req);
        const entry = catalog.find((c) => c.item === baseItem(String(body.item ?? "")));
        if (!entry) return json(res, 404, { error: "not in catalog" });
        const order = typeof body.order === "string" && /^[a-z0-9]{4,16}$/.test(body.order) ? `?order=${body.order}` : "";
        // Negotiation: accept an offer at or above the floor, otherwise counter at the floor.
        let price = BigInt(entry.list);
        let note = "list price";
        if (body.offer != null && /^[0-9]{1,12}$/.test(String(body.offer))) {
          const offer = BigInt(body.offer);
          if (offer >= BigInt(entry.floor)) {
            price = offer < price ? offer : price;
            note = "offer accepted";
          } else {
            price = BigInt(entry.floor);
            note = "counter-offer at floor";
          }
        }
        const quote: Quote = {
          seller: s.accountId,
          item: entry.item + order,
          category: entry.category,
          description: entry.description,
          price: price.toString(),
          expires_at_ms: Date.now() + 10 * 60_000,
          nonce: newNonce(),
        };
        return json(res, 200, { ...signQuote(state.vault, quote, s.quoteKey), note, list: entry.list });
      }

      if (req.method === "POST" && action === "fulfil") {
        const body = await readBody(req);
        const p = await vault.getPurchase(Number(body.purchase_id));
        if (!p) return json(res, 404, { error: "no such purchase" });
        if (p.seller !== s.accountId) return json(res, 403, { error: "not our purchase" });
        if (p.status !== "Escrowed") return json(res, 409, { error: `purchase is ${p.status}, not Escrowed` });
        const result = deliverable(name, baseItem(p.item));
        const result_hash = sha256hex(result);
        await vault.seller(s.accountId, s.key).deliver(p.id, result_hash);
        return json(res, 200, { result, result_hash });
      }
      return json(res, 404, { error: "not found" });
    } catch (e: any) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  });
  server.listen(port, process.env.SELLERS_HOST ?? "0.0.0.0", () => console.log(`sellers listening on http://localhost:${port} (datadesk, junkdata)`));
  return server;
}

if (process.argv[1]?.endsWith("sellers.ts")) startSellers();
