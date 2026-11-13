/**
 * The night shift, live on NEAR testnet. Run `npm run sellers` first.
 *
 * Every step is a real transaction against the Almoner Vault. Refusals are
 * stored on-chain too, so the dashboard and explorer show the whole night.
 */
import { AlmonerVault, explorerAccount, fmtUsdc, type Purchase, type SignedQuote } from "./sdk.js";
import { collectAndReview, negotiate } from "./agent.js";
import { loadState, NETWORK, RPC, SELLERS_URL } from "./config.js";

