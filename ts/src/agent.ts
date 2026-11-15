/**
 * Buyer agent helpers: discover quotes, negotiate inside the signed mandate,
 * buy through the vault, collect delivery and review it.
 *
 * Negotiation is advisory; the contract is the boundary. Whatever the agent
 * (or a prompt injection) decides, the vault re-checks the signed quote
 * against the mandate before any money is reserved.
 */
import { AlmonerVault, checkDelivery, preflight, type Purchase, type SellerView, type SignedQuote, type TaskView } from "./sdk.js";
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

/**
 * Ask each seller for a list quote, then counter at ~80% of the cheapest list
 * price, capped at the mandate's per-purchase limit. Returns signed offers,
 * best first: proven sellers (higher delivery score) before cheaper unknowns.
 */
export async function negotiate(
  task: TaskView,
  sellers: Record<string, string>, // name -> item URL at that seller
  onChain: SellerView[],
  log: (s: string) => void = () => {},
): Promise<Offer[]> {
  const lists: { name: string; price: bigint }[] = [];
  for (const [name, item] of Object.entries(sellers)) {
    try {
      const q = await post(`/${name}/quote`, { item });
      lists.push({ name, price: BigInt(q.quote.price) });
      log(`  ${name}: list ${q.quote.price}`);
    } catch (e: any) {
      log(`  ${name}: no quote (${e.message})`);
    }
  }
  if (!lists.length) return [];
  const cheapest = lists.reduce((a, b) => (a.price < b.price ? a : b)).price;
  const ceiling = BigInt(task.rules.max_per_purchase);
  let target = (cheapest * 80n) / 100n;
  if (target > ceiling) target = ceiling;

  const offers: Offer[] = [];
  for (const { name } of lists) {
    const q = await post(`/${name}/quote`, { item: sellers[name], offer: target.toString() });
    const rep = onChain.find((s) => s.account_id === q.quote.seller);
    log(`  ${name}: offered ${target} -> ${q.note} at ${q.quote.price}`);
    offers.push({ sellerName: name, signed: { quote: q.quote, signature: q.signature }, note: q.note, reputationBps: rep?.delivery_score_bps ?? 0, settled: rep?.settled ?? 0 });
  }
  return offers
    .filter((o) => !onChain.find((s) => s.account_id === o.signed.quote.seller)?.on_hold)
    .filter((o) => preflight(task.rules, o.signed.quote).ok)
    .sort((a, b) => b.reputationBps - a.reputationBps || Number(BigInt(a.signed.quote.price) - BigInt(b.signed.quote.price)));
}

/** A delivered result is acceptable if it hashes to what the seller committed on-chain and isn't junk. */
export { checkDelivery } from "./sdk.js";

/** Ask the seller to fulfil an escrowed purchase, verify, then accept or reject on-chain. */
export async function collectAndReview(
  vault: AlmonerVault,
  agent: ReturnType<AlmonerVault["agent"]>,
  sellerName: string,
  p: Purchase,
): Promise<{ purchase: Purchase; result: string; check: { ok: boolean; why: string } }> {
  const { result } = await post(`/${sellerName}/fulfil`, { purchase_id: p.id });
  const delivered = (await vault.getPurchase(p.id))!;
  const check = checkDelivery(result, delivered.result_hash);
  const purchase = await agent.confirmDelivery(p.id, check.ok, check.ok ? undefined : check.why);
  return { purchase, result, check };
}
