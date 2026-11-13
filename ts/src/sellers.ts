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
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AlmonerVault, newNonce, sha256hex, signQuote, usdc, type Quote } from "./sdk.js";
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

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
};

const readBody = (req: IncomingMessage) =>
  new Promise<any>((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch {
        resolve({});
      }
    });
  });

export function startSellers(port = Number(process.env.SELLERS_PORT ?? 8787)) {
  const state = loadState();
  const vault = new AlmonerVault(state.vault.accountId, RPC);

  const server = createServer(async (req, res) => {
    try {
      const [, name, action] = (req.url ?? "").split("/");
      const s = state.sellers[name];
      const catalog = CATALOG[name];
      if (!s || !catalog) return json(res, 404, { error: "unknown seller" });

      if (req.method === "GET" && action === "catalog") return json(res, 200, catalog);

      if (req.method === "POST" && action === "quote") {
        const body = await readBody(req);
        const entry = catalog.find((c) => c.item === body.item);
        if (!entry) return json(res, 404, { error: "not in catalog" });
        // Negotiation: accept an offer at or above the floor, otherwise counter at the floor.
        let price = BigInt(entry.list);
        let note = "list price";
        if (body.offer) {
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
          item: entry.item,
          category: entry.category,
          description: entry.description,
          price: price.toString(),
          expires_at_ms: Date.now() + 10 * 60_000,
          nonce: newNonce(),
        };
        return json(res, 200, { ...signQuote(state.vault.accountId, quote, s.quoteKey), note });
      }

      if (req.method === "POST" && action === "fulfil") {
        const body = await readBody(req);
        const p = await vault.getPurchase(Number(body.purchase_id));
        if (!p) return json(res, 404, { error: "no such purchase" });
        if (p.seller !== s.accountId) return json(res, 403, { error: "not our purchase" });
        if (p.status !== "Escrowed") return json(res, 409, { error: `purchase is ${p.status}, not Escrowed` });
        const result = deliverable(name, p.item);
        const result_hash = sha256hex(result);
        await vault.seller(s.accountId, s.key).deliver(p.id, result_hash);
        return json(res, 200, { result, result_hash });
      }
      return json(res, 404, { error: "not found" });
    } catch (e: any) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  });
  server.listen(port, () => console.log(`sellers listening on http://localhost:${port} (datadesk, junkdata)`));
  return server;
}

