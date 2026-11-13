/**
 * The night shift, live on NEAR testnet. Run `npm run sellers` first.
 *
 * Every step is a real transaction against the Almoner Vault. Refusals are
 * stored on-chain too, so the dashboard and explorer show the whole night.
 */
import { AlmonerVault, explorerAccount, fmtUsdc, type Purchase, type SignedQuote } from "./sdk.js";
import { collectAndReview, negotiate } from "./agent.js";
import { loadState, NETWORK, RPC, SELLERS_URL } from "./config.js";

const state = loadState();
const vault = new AlmonerVault(state.vault.accountId, RPC);
const agent = vault.agent(state.agent.key);
let step = 0;

const head = (s: string) => console.log(`\n\x1b[1m${++step}. ${s}\x1b[0m`);
const show = (p: Purchase) => {
  const c = p.status === "Paid" || p.status === "Escrowed" || p.status === "Reused" ? "32" : p.status === "PendingApproval" ? "33" : "31";
  console.log(`   #${p.id} \x1b[${c}m${p.status}\x1b[0m ${p.code} · ${fmtUsdc(p.price)} · ${p.detail}`);
};

