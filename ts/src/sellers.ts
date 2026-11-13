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

