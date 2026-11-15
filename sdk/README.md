# almoner-sdk

A typed TypeScript client for [Almoner](../README.md) vaults on NEAR. Agents can ask to spend; they can never take. Testnet only for now.

## Install

Not on npm yet. From a clone of this repository, in your own project:

```bash
npm install near-api-js /path/to/almoner/sdk --install-links
```

`--install-links` copies the package instead of symlinking it, so its peer `near-api-js` resolves from your project. Or pack it once and install the tarball: `cd sdk && npm pack`, then `npm install near-api-js /path/to/almoner-sdk-0.1.0.tgz`. The built `dist/` is committed; rebuild it with `cd ts && npm ci && node ../sdk/build.mjs`. Needs Node 20 or later.

## Quick start: an agent buys

```ts
import { AlmonerVault, AlmonerError, buy } from "almoner-sdk";

const vault = new AlmonerVault("vault.you.testnet", "https://rpc.testnet.fastnear.com");
try {
  const r = await buy(vault, process.env.AGENT_KEY, {        // the function-call key the vault issued
    sellerUrl: "https://seller.example/api/datadesk",        // any Almoner seller server
    item: "https://datadesk.example/data/near-intents-volume-daily",
    taskId: 1, reason: "Volume data for the weekly report",
  });
  // A refusal is data, not an exception: r.paid, r.status, r.code ("INTENT_MISMATCH", ...), r.detail
  console.log(r.paid ? `paid #${r.purchase.id}` : `refused: ${r.code} ${r.detail}`);
} catch (e) {
  if (e instanceof AlmonerError) console.log(e.kind);       // "revoked_key" | "out_of_gas" | "network" | "seller" | "contract"
}
```

`buy()` gets a signed quote from the seller, asks the vault, and if the vault escrows the money, collects the delivery, checks it hashes to what the seller committed on-chain and is real data, then accepts (seller paid) or rejects (refund) on-chain.

## Examples

Each runs against NEAR testnet; the output below is from real runs on 15 Nov 2026. Install the package as above, then run them from your project.

**[`examples/agent-buy.mjs`](examples/agent-buy.mjs)**: an agent buys from the public demo shop with the key published in [`shop.json`](../shop.json), then tries an item that hides a blocked term.

```
$ node agent-buy.mjs shop.json
datadesk: PAID Paid APPROVED_ESCROW (0.060 tUSDC) #45
  vault says: Within every rule; funds held in escrow until the seller delivers.
  agent review: hash matches and content is data
junkdata: NOT PAID Declined INTENT_MISMATCH (0.200 tUSDC) #46
  vault says: The item matches blocked term 'gift card' (disguises are decoded first).
task 3 "Open shop": 9.85 tUSDC left of 10.00 tUSDC
```

**[`examples/owner-setup.mjs`](examples/owner-setup.mjs)**: an owner creates a mandate and issues an agent key in one call with `setupAgent()`, checks both on-chain, then revokes the key and closes the task.

```
$ OWNER_ACCOUNT_ID=... OWNER_PRIVATE_KEY=... VAULT_ID=vault.almoner-502c7b80.testnet node owner-setup.mjs
task 5 "SDK example: research data" v1, mandate f4b8a3005ccbb9e1…
  budget 0.500 tUSDC, max 0.100 tUSDC each, approval above 0.080 tUSDC
agent key issued: ed25519:Fqq67vjeES6Q… (private key returned to you once; give it to the agent)
on-chain: agent "sdk-example-agent" active=true tasks=5, gas allowance 0.250 NEAR
tidied up: key revoked (gone from the vault), task 5 Closed
```

**[`examples/seller-quote.mjs`](examples/seller-quote.mjs)**: a seller signs a quote and checks the signature against the quote key the vault has on record for it.

```
$ SELLER_ID=datadesk.almoner-502c7b80.testnet SELLER_QUOTE_KEY=... VAULT_ID=vault.almoner-502c7b80.testnet node seller-quote.mjs
signed https://datadesk.example/data/near-intents-volume-daily at 0.060 tUSDC, nonce 11060781bb88725a60194761
signature o9VNwXUM+N81b9I2USzGzg3a… over:
  almoner-quote/v1
  vault.almoner-502c7b80.testnet
  datadesk.almoner-502c7b80.testnet
  https://datadesk.example/data/near-intents-volume-daily
  market-data
  60000
  1794748667943
  11060781bb88725a60194761
  852cb5c341146a6781c47acc0ddf19d790bc4d27b661c9005ccb7e1510c4fbdc
vault vault.almoner-502c7b80.testnet has datadesk.almoner-502c7b80.testnet on record: "DataDesk", hold=false, score 100%
signature verifies against the on-chain quote key: true
same key: true
```

Keep owner and seller keys in your environment or a secrets store, never in code or chat.

## Every export

| Export | What it is |
| --- | --- |
| `buy(vault, agentKey, opts)` | The agent flow in one call: quote, ask the vault, collect delivery, accept or reject. Returns a `BuyResult`. |
| `setupAgent(vault, ownerId, ownerKey, rules, name, opts?)` | The owner flow in one call: create a task and issue a fresh agent key for it. Returns an `AgentSetup` (`task`, `agentKey`, `publicKey`). |
| `getQuote(sellerUrl, item, { offer?, vault? })` | Ask an Almoner seller server for a signed quote (`SellerQuote`). |
| `checkDelivery(result, onChainHash)` | The default delivery check: hash matches what the seller committed, body is JSON data and not an error. |
| `AlmonerError`, `toAlmonerError(e)`, `AlmonerErrorKind` | The error for when no decision could be reached: `revoked_key`, `out_of_gas`, `network`, `seller`, `contract`. |
| `new AlmonerVault(vaultId, rpcUrl)` | The client. Views: `getVault`, `getTask`, `getTasks`, `getPurchase`, `getPurchases`, `getSellers`, `getSeller`, `getAgents`, `getSubMandates`, `getLog`, `verifyLog`, `getMandateJson`, `keyAllowance`, `nearBalance`, `view` |
| `vault.agent(agentKey)` | `requestPurchase`, `confirmDelivery`, `settleExpired`, `delegate`, `revokeDelegate`, `publicKey` |
| `vault.owner(accountId, key)` | `createTask`, `updateTask`, `setTaskStatus`, `addAgent`, `revokeAgent`, `revokeDelegate`, `approve`, `reject`, `review`, `clearHold`, `setFrozen`, `withdraw` |
| `vault.seller(accountId, key)` | `register`, `deliver` |
| `signQuote(vaultId, quote, quoteKey)`, `quoteMessage(vaultId, quote)`, `newNonce()` | Seller-side quote signing; `quoteMessage` is the exact bytes the contract verifies. |
| `preflight(rules, quote)`, `normalize(text)` | Local mirror of the contract's IntentLock (categories, blocked terms with disguises decoded, per-purchase limit), to fail fast before spending gas. |
| `usdc`, `fmtUsdc`, `fmtNear`, `sha256hex`, `explorerTx`, `explorerAccount`, `TGAS`, `USDC_DECIMALS` | Amounts, formatting, hashing, explorer links. |
| Types | `BuyOptions`, `BuyResult`, `AgentSetup`, `SellerQuote`, `TaskInput`, `TaskStatus`, `TaskView`, `Quote`, `SignedQuote`, `Purchase`, `PurchaseStatus`, `SellerView`, `VaultView`, `SubMandateView`, `LogEntry` |

## What the vault guarantees, whatever your agent does

These hold on-chain, so a bug, a prompt injection or a compromised agent cannot get around them:

- The agent's key is a function-call key on the vault. It can only ask (`request_purchase`, `confirm_delivery`, `settle_expired`, and `delegate` if the owner allowed it). It cannot transfer funds, add keys or change rules.
- Every request is checked against the owner's mandate, pinned by its hash: category, blocked terms (spacing, leetspeak and double URL-encoding are decoded first), allowed sellers, budget, per-purchase limit, hourly rate, expiry.
- Quotes must be signed by a registered seller's quote key for this vault, unexpired, and each nonce is used once.
- Money goes into escrow first. The seller is paid only after delivering a result whose hash it committed on-chain, and the agent or owner can reject it for a refund. If the seller misses the delivery window, anyone can call `settle_expired` and the money goes back.
- Purchases above the owner's threshold wait for the owner. The owner can freeze the vault or revoke any key at any time.
- Every decision is written to a hash-chained log that anyone can verify (`verifyLog()`).

## Tests

`cd ts && npm test` runs the SDK tests: the quote fixture the Rust contract verifies (`contracts/vault/src/fixtures/ts_quote.json`), the IntentLock cases from `contracts/vault/src/intent.rs`, error typing, and seller errors. `bash sdk/test-pack.sh` packs the SDK, installs the tarball into a clean temp project, and imports and type-checks it there under `--strict`.

The source is [`ts/src/sdk.ts`](../ts/src/sdk.ts); the demos, the MCP server and the owner CLI in this repository use the same file.
