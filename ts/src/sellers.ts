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

