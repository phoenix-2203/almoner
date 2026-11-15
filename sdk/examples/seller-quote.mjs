// A seller signs a quote with its quote key and checks it against the key the vault has on record for it.
//   SELLER_ID=... SELLER_QUOTE_KEY=... VAULT_ID=... node seller-quote.mjs
import { KeyPair, PublicKey } from "near-api-js";
import { AlmonerVault, signQuote, quoteMessage, newNonce, usdc, fmtUsdc } from "almoner-sdk";

const { SELLER_ID: seller, SELLER_QUOTE_KEY: quoteKey, VAULT_ID: vaultId } = process.env;
const vault = new AlmonerVault(vaultId, process.env.NEAR_RPC ?? "https://rpc.testnet.fastnear.com");
const quote = {
  seller, item: "https://datadesk.example/data/near-intents-volume-daily", category: "market-data",
  description: "Daily NEAR Intents swap volume by asset, last 30 days",
  price: usdc(0.06), expires_at_ms: Date.now() + 10 * 60_000, nonce: newNonce(),
};
const signed = signQuote(vaultId, quote, quoteKey);
console.log(`signed ${quote.item} at ${fmtUsdc(quote.price)}, nonce ${quote.nonce}`);
console.log(`signature ${signed.signature.slice(0, 24)}… over:\n  ${quoteMessage(vaultId, quote).split("\n").join("\n  ")}`);

const onChain = await vault.getSeller(seller);
if (!onChain) throw new Error(`${seller} is not registered on ${vaultId}: call vault.seller(id, key).register(...) first`);
const ok = PublicKey.fromString(onChain.quote_key).verify(new TextEncoder().encode(quoteMessage(vaultId, quote)), Buffer.from(signed.signature, "base64"));
console.log(`vault ${vaultId} has ${seller} on record: "${onChain.name}", hold=${onChain.on_hold}, score ${onChain.delivery_score_bps / 100}%`);
console.log(`signature verifies against the on-chain quote key: ${ok}`);
console.log(`same key: ${KeyPair.fromString(quoteKey).getPublicKey().toString() === onChain.quote_key}`);
