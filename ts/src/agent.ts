/**
 * Buyer agent helpers: discover quotes, negotiate inside the signed mandate,
 * buy through the vault, collect delivery and review it.
 *
 * Negotiation is advisory; the contract is the boundary. Whatever the agent
 * (or a prompt injection) decides, the vault re-checks the signed quote
 * against the mandate before any money is reserved.
 */
import { AlmonerVault, preflight, sha256hex, type Purchase, type SellerView, type SignedQuote, type TaskView } from "./sdk.js";
import { SELLERS_URL } from "./config.js";

export interface Offer {
  sellerName: string;
  signed: SignedQuote;
  note: string;
  reputationBps: number;
  settled: number;
}

const post = async (path: string, body: unknown) => {
  const r = await fetch(`${SELLERS_URL}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j: any = await r.json();
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
};

