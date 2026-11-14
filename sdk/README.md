# almoner-sdk

A typed TypeScript client for [Almoner](../README.md) vaults on NEAR. Agents can ask to spend; they can never take.

```bash
npm install near-api-js
npm install ./sdk            # from a clone of this repository (not yet published to npm)
```

## An agent, in a few lines

```ts
import { AlmonerVault } from "almoner-sdk";

const vault = new AlmonerVault("vault.you.testnet", "https://rpc.testnet.fastnear.com");
const agent = vault.agent(process.env.AGENT_KEY);        // the function-call key the vault issued

const task = await vault.getTask(1);                      // the rules the owner signed
const p = await agent.requestPurchase({
  task_id: 1, mandate_hash: task.mandate_hash,
  signed: quote,                                          // { quote, signature } from the seller
  reason: "Needed for the brief", idempotency_key: "job-42",
});
// p.status: "Escrowed" | "PendingApproval" | "Reused" | "Declined", with p.code and p.detail

if (p.status === "Escrowed") await agent.confirmDelivery(p.id, true);   // accept: the seller is paid
```

Whatever the agent's code does, the key it holds can only call the vault's agent methods, and the vault checks every request against the owner's signed rules.

## What is in it

| | |
| --- | --- |
| `new AlmonerVault(vaultId, rpcUrl)` | Views: `getVault`, `getTask(s)`, `getPurchase(s)`, `getSellers`, `getAgents`, `getSubMandates`, `getLog`, `verifyLog`, `getMandateJson`, `keyAllowance`, `nearBalance` |
| `vault.agent(agentKey)` | `requestPurchase`, `confirmDelivery`, `settleExpired`, `delegate`, `revokeDelegate` |
| `vault.owner(accountId, key)` | `createTask`, `updateTask`, `setTaskStatus`, `addAgent`, `revokeAgent`, `approve`, `reject`, `review`, `clearHold`, `setFrozen`, `withdraw`, `revokeDelegate` |
| `vault.seller(accountId, key)` | `register`, `deliver` |
| Quotes | `signQuote(vaultId, quote, quoteKey)`, `quoteMessage`, `newNonce` |
| IntentLock mirror | `preflight(rules, quote)`, `normalize(text)`: the same checks the contract makes, to fail fast before spending gas |
| Helpers and types | `usdc`, `fmtUsdc`, `fmtNear`, `sha256hex`, `explorerTx`, `explorerAccount`; `TaskInput`, `TaskView`, `Quote`, `SignedQuote`, `Purchase`, `SellerView`, `SubMandateView`, `LogEntry` |

Testnet only for now. The source is `ts/src/sdk.ts`; rebuild with `cd ts && npm ci && node ../sdk/build.mjs`.
