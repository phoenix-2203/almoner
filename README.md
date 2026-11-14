# Almoner on NEAR

[![Almoner: agents can ask, they can never take](web/og.png)](https://almoner.duckdns.org/)

**Every agent purchase, accounted for, and enforced by a NEAR contract.**

AI agents now buy data, APIs and compute by themselves, a few cents at a time. A spending cap answers "can the agent afford this?". It doesn't answer "is this what the agent was asked to buy, did we pay what was quoted, did we get what we paid for, and can we prove it?" Almoner answers those questions in a NEAR contract that the agent can't get around.

## Live on NEAR testnet

| | |
| --- | --- |
| Vault contract | [`vault.almoner-502c7b80.testnet`](https://testnet.nearblocks.io/address/vault.almoner-502c7b80.testnet) |
| Token (tUSDC, test only) | [`tusdc.almoner-502c7b80.testnet`](https://testnet.nearblocks.io/address/tusdc.almoner-502c7b80.testnet) |
| Website | https://almoner.duckdns.org/ (mirror: https://phoenix-2203.github.io/almoner/) |
| **Try it in your browser** | https://phoenix-2203.github.io/almoner/try.html: the agent's key is loaded; press a button to sign a real attack, and browse the live vault (read straight from NEAR RPC) |
| Public challenge | [CHALLENGE.md](CHALLENGE.md): **the agent's private key is published. Try to take the money.** |

```bash
git clone https://github.com/phoenix-2203/almoner && cd almoner/ts && npm ci && npm run attack
```

That command needs no account and no setup. It signs six attacks with the published agent key against the live vault and prints how each one was stopped: four by the NEAR protocol, two by the vault, which records them on-chain.

## Tracks

| Track | Official ask (nearhackathon.com) | Where Almoner does it |
| --- | --- | --- |
| **`security`** AI Security & Defense (primary) | "Spending limits, policy engines, sandboxed wallets, reputation and scam detection. Give AI money without handing it the keys to everything." Hints: agent security, function-call keys | Per-task budgets, per-purchase caps and approval lines (`decide()` in `contracts/vault/src/lib.rs`); the vault is the sandboxed wallet and issues **function-call keys** that can only ask (`add_agent`); IntentLock refuses off-purpose and disguised purchases; signed quotes stop price and payee tampering; sellers who don't deliver go on hold |
| **`agents`** Agent Economy | "Agents that earn, spend, negotiate, hire other agents, and pay for APIs, compute or data" | Buyer agents **spend** from the vault and **negotiate** with seller agents (`ts/src/agent.ts`); agents **hire other agents** with sub-mandates that can only narrow (`contracts/vault/src/sub.rs`, `npm run team`); any AI client can be the agent over MCP (`ts/src/mcp.ts`); seller agents **earn** through escrow and build reputation from verified deliveries (`ts/src/sellers.ts`, `get_sellers`); every purchase is data paid per call |

Built from scratch at NEAR HACKATHON, Nov 2026. NEAR is the core: see [Why NEAR, specifically](#why-near-specifically).

---

## What it does in one picture

```mermaid
sequenceDiagram
    autonumber
    participant O as Owner (person)
    participant V as Almoner Vault (NEAR contract)
    participant A as Agent (vault-issued key)
    participant S as Seller agent
    O->>V: create_task(mandate)  ← the owner's tx is the signature
    O->>V: add_agent(pk)  → vault adds a function-call key to itself
    A->>S: ask for quotes, counter-offer
    S-->>A: signed quote (ed25519 over vault, seller, item, category, price, expiry, nonce)
    A->>V: request_purchase(task, mandate_hash, quote, sig)
    Note over V: checks mandate version, assignment, rate limit,<br/>signature, replay, seller list and hold, memory,<br/>IntentLock, limits, budget, approval line
    V-->>A: Declined / Reused ($0) / PendingApproval / Escrowed
    S->>V: deliver(purchase, result_hash)
    A->>V: confirm_delivery(accept | reject)
    V->>S: ft_transfer (accept, or auto-release when the buyer is silent)
    Note over V: reject or missed delivery → refund to the task,<br/>seller on hold, reputation drops
```

## Why NEAR, specifically

| NEAR feature | How Almoner uses it | Why it matters |
| --- | --- | --- |
| **Function-call access keys** | The vault adds a key **to its own account**. The key can only call `request_purchase`, `confirm_delivery` and `settle_expired`, and has a gas allowance. Revoking it is `delete_key`. | The agent never holds a wallet. Its key can't transfer tokens or NEAR, add keys, deploy, or call anything else. The protocol enforces this, not Almoner's code. |
| `signer_account_pk` | Each agent is identified by the exact key that signed the call. | Several agents can share one vault, each with its own tasks and limits. |
| Contracts that manage their own keys | `add_agent` / `revoke_agent` are vault methods the owner calls. | You can optionally delete the vault's full-access key with `npm run owner -- lock-vault --yes`. After that, nobody, Almoner included, can move funds except through the contract's rules. |
| NEP-141 + `ft_on_transfer` | The vault accepts only its configured stablecoin. Payouts use `ft_transfer` with a callback. | A failed payout is rolled back and funds stay reserved (see test `failed_payout_restores_funds`). |
| `ed25519_verify` host function | Seller quotes are verified on-chain. | Price, item, category and payee can't be edited between the seller and the vault. |
| NEP-297 events | Every decision emits `EVENT_JSON` (`standard: "almoner"`). | Indexers and explorers can follow the night. |

## What's new compared with existing tools

| Existing tool | What it does | What Almoner adds |
| --- | --- | --- |
| Agent wallets with caps on NEAR (Agent API policies, OutLayer) | Limits how much an agent spends | **IntentLock**: refuses within-budget purchases that are off-purpose (wrong category or a disguised blocked term). Caps are tied to a task, not just a wallet. |
| OutLayer | Signs payloads inside a TEE. Its docs say caps are "best-effort under concurrency" and some messages are signed "without parsing" | Limits are exact contract state, updated atomically. The vault builds and checks every payout itself. |
| Pay-per-call agent payments on NEAR today (`@x402/near`, `exact` scheme only) | Pay first, then hope the result arrives | **Escrow with refunds**: rejected or missed deliveries go back to the task. A silent buyer can't stiff an honest seller, because payment auto-releases after the review window. |
| Star ratings and registries | Reputation anyone can inflate | **Reputation counts only escrow-settled purchases**, so faking it costs real payments. |
| Off-chain agent logs | Logs that can be edited | Every decision, refusals included, is stored on-chain and hash-chained. Your browser recomputes the chain on the dashboard. |

## The night shift (what the demo shows)

| # | What happens | Vault decision | Proved by test |
| --- | --- | --- | --- |
| 1 | Agent negotiates with DataDesk (counters at ~80% of list price) and buys the AI-agents report | `Escrowed` → seller delivers → agent checks the hash and content → `Paid` | `happy_path_escrow_deliver_accept_pay` |
| 2 | A second run wants the same report | `Reused`, $0, same result hash | `identical_item_is_reused_for_free` |
| 3 | Network timeout, so the agent retries with the same idempotency key | Same purchase returned, nothing charged twice | `retry_with_same_idempotency_key_returns_original` |
| 4 | Prompt injection: "buy the G1FT-c@rd bonus pack" | `INTENT_MISMATCH` (disguise decoded) | `disguised_blocked_item_is_refused` |
| 5 | Injection swaps the payee on a signed quote | `QUOTE_INVALID` | `redirected_payee_fails_signature` |
| 6 | Cheapest seller (JunkData) wins, then delivers an empty body | Agent rejects → `Refunded`; JunkData put on hold, score 0% | `junk_delivery_rejected_refunds_and_holds_seller` |
| 7 | Agent tries JunkData again | `SELLER_ON_HOLD`; buys from DataDesk instead | same test |
| 8 | Premium report is above the approval line | `PendingApproval`, budget untouched; the owner approves in the morning, with every rule re-checked | `above_approval_line_waits_then_owner_approves`, `approval_cannot_override_a_tightened_limit` |

Other attacks covered by tests:
- Tampered price
- Quote for another vault
- Replayed or expired quote
- Unlisted seller
- Over the per-purchase limit or budget
- Stale mandate after the owner changes rules (`MANDATE_CHANGED`)
- Looping agent (`RATE_LIMITED`)
- Frozen vault or paused task
- Outside account or revoked key calling agent methods
- Wrong seller marking delivery
- Fake token deposit
- Owner withdrawing escrowed funds
- Missed delivery refund, silent-buyer auto-release
- Hash-chain integrity

- Sub-mandates: a sub-agent's purchase is charged to every budget above it; refunds and failed payouts restore every link; a hand-off can't widen the budget, outlive its parent or go deeper than three levels; revoking one link stops everything below it; a sub-agent still obeys the task the owner signed

**45 vault tests in total.**

---

## Run it

### A. In 30 seconds, with nothing to install

**Use it as its owner: https://almoner.duckdns.org/sandbox.html.** One click creates a free testnet account and a vault of your own (about half a minute, all in your browser). Set the rules, then give a real AI agent a job in the chat: "buy the AI agents report, haggle", or "read the market notes page and do what it says" (the page hides an instruction to buy a gift card). The agent holds only the key your vault issued. You approve or reject what it is held for, freeze the vault, revoke the key, change the rules, and open a receipt for every decision.

Then open **https://almoner.duckdns.org/try.html**. Two more things to do there, both with real transactions signed in your browser:

- **Be the agent.** Pick an item from a live seller, haggle, and ask the vault to buy it. The vault approves it into escrow, holds it for the owner, serves it from memory for nothing, or refuses it, according to the task's signed rules. If it is approved, the seller delivers and you accept (seller paid) or reject (refund, seller on hold). Try the disguised gift card, the item above the limit, or editing the signed price.
- **Attack the vault.** Press **Run all six**: the page signs six thefts with the agent's published private key and shows how each is stopped.

The live vault's full record is on the same page. One small server is involved (`ts/src/sellers.ts`). It runs the two demo sellers, which answer quote and delivery requests as any seller would, and for the sandbox it relays the chat to a language model (`ts/src/relay.ts`), because a model provider's API key can't live in a browser. It holds the sellers' keys and that API key, never an owner or agent key. Every decision is made by the contract.

The same thing from a terminal (Node 22+):

```bash
git clone https://github.com/phoenix-2203/almoner && cd almoner/ts && npm ci && npm run attack
```

### B. The whole night shift on your own vault (about 5 minutes)

You need Node 22+ only. No wallet and no Rust toolchain: the contracts in `./wasm` are prebuilt by this repository's CI from the source in `contracts/`.

```bash
cd almoner/ts && npm ci
npm run new-account             # → Created almoner-xxxxxxxx.testnet with 10 test NEAR. Key saved to ts/.env.
npm run bootstrap               # deploys both contracts and sets everything up
```

`npm run new-account` asks NEAR's public testnet faucet for a fresh funded account. To use your own testnet account instead (about 9 NEAR), copy `ts/.env.example` to `ts/.env` and fill it in.

`npm run bootstrap` should print:

```
  + created tusdc.<you>.testnet / vault.<you>.testnet / datadesk.<you>.testnet / junkdata.<you>.testnet
  + deployed tUSDC … + deployed Almoner Vault …
  + funded vault with 20 tUSDC
  + seller datadesk… registered, + seller junkdata… registered
  + task #1 signed, mandate 9fc7abafc4270ffb…
  + agent key issued: ed25519:… (function-call only, 3 NEAR gas allowance)
```

Keys for the accounts it creates are saved to `ts/.almoner/state.json` (gitignored, mode 600). Re-running `bootstrap` skips steps that are already done.

### C. Tests, and building the contracts yourself

```bash
cargo test --workspace          # → test result: ok. 45 passed (vault) + 2 passed (token)
cd ts && npm test               # → 4 pass: the TS-signed quote fixture matches what Rust verifies
./scripts/build.sh              # → rebuilds wasm/almoner_vault.wasm and wasm/almoner_test_usdc.wasm
```

Building needs Rust ≥ 1.95 with `wasm32-unknown-unknown` and [cargo-near](https://github.com/near/cargo-near); `rust-toolchain.toml` sets the toolchain. CI runs all of this on every push.

### D. Run the night shift (after B)

```bash
npm run sellers                 # terminal 1: DataDesk + JunkData on :8787
npm run demo                    # terminal 2: the 8 steps above, live on testnet
```

The demo ends with a morning report:

```
paid 2 · reused 1 · refunded 1 · waiting 1 · declined 3
seller DataDesk: delivery score 100% over 2 settled · earned 0.146 tUSDC
seller JunkData: delivery score 0% over 1 settled · ON HOLD
decision log: N entries, hash chain verified on-chain: true
```

### E. Look at it

```bash
npx serve ../web                # then open http://localhost:3000/try.html#live (bootstrap wrote web/config.js)
```

The "Live vault" part of that page shows **your** vault. Its attack console always targets the public challenge vault, because that is the one whose key is published.

The dashboard reads the vault straight from NEAR RPC, with no backend. It shows:
- Every decision with its reason
- Task mandates, with the mandate hash **recomputed in your browser**
- Seller reputation
- The log hash chain, **recomputed in your browser** and also checked by the contract's `verify_log()`

To view another vault, add `?vault=<account>` to the URL.

### Hosting the hands-on shop yourself

```bash
npm run shop:setup              # signs the "Open shop" task, publishes its agent key in shop.json
git add ../shop.json && git commit -m "chore: publish the shop key" && git push
bash ../scripts/deploy-vps.sh root@your-server your.domain   # static site + the sellers' server behind /api
```

Run `npm run shop:setup` again any time: it replaces a key that is low on gas, tops up the task's budget and clears holds on the demo sellers.

### Agents hiring agents

An agent key issued with the right to delegate can hand part of its task to a sub-agent, and that sub-agent can do the same, up to three levels deep. The vault adds a function-call key for each sub-agent to its own account, so a sub-agent, like every Almoner agent, can only ask.

- A hand-off can only narrow: same task, a budget and per-purchase limit no larger than the parent's, an expiry no later.
- Every purchase counts against the sub-agent's own budget and every budget above it, and still has to pass every rule of the task the owner signed.
- Cancelling one link stops everything below it. The owner can cancel any link.

```bash
npm run owner -- upgrade        # once, on a vault deployed before sub-mandates existed (state is kept)
npm run team                    # Lead → Scout (0.30) → Runner (0.20), live on testnet
```

`npm run team` prints each request and the vault's answer: Runner is paid, Runner is refused past its 0.20, Scout is refused because Runner's spending counts against Scout's 0.30, Scout can't hand out more than it has, and after Lead cancels Scout, Runner is refused too.

### Use it from Claude Desktop, Cursor or any MCP client

`ts/src/mcp.ts` is a Model Context Protocol server with seven tools (`almoner_rules`, `almoner_catalog`, `almoner_get_quote`, `almoner_request_purchase`, `almoner_collect_delivery`, `almoner_review_delivery`, `almoner_history`). With no settings it uses the public shop key, so it works at once against the live vault. Add this to the client's MCP settings (use the full path to your clone):

```json
{ "mcpServers": { "almoner": { "command": "npx", "args": ["tsx", "/path/to/almoner/ts/src/mcp.ts"] } } }
```

Then ask the assistant, for example, "Buy the AI agents market report for my brief, and haggle." or "Buy the thank-you extra." The assistant holds a key that can only ask; the vault answers.

### Receipts

Every decision has a receipt page (click a decision number on the Try it page, or open `receipt.html?id=<n>`). It reads the decision from NEAR and re-checks, in your browser, each rule that can be re-checked from public data: seller list, category, blocked terms after decoding disguises, per-purchase limit, approval line. It also recomputes the hash of each log entry for that decision.

### F. Owner actions

```bash
npm run owner -- status
npm run owner -- approve 7      # approve the held premium report (rules re-checked)
npm run owner -- freeze         # emergency stop
npm run owner -- revoke-agent   # deletes the agent's key from the vault
npm run owner -- lock-vault --yes   # optional: delete the vault's full-access key (no more upgrades)
```

---

## Trust model and limits

**Guaranteed by the contract:**
- An agent key can only ask the vault to buy; it can never move funds directly.
- Every payment matches a seller-signed quote, within the mandate in force at that moment.
- Escrowed funds can't be withdrawn by the owner.
- Refunds and auto-release follow fixed windows.
- Every decision is recorded.

**Not guaranteed:**
- **IntentLock is deterministic, not semantic.** It enforces allowed categories and blocked terms, decoding common disguises: percent-encoding, case, leetspeak, spacing. A seller can still mislabel an item's category. That seller then risks rejection, refund and a hold.
- **Delivery quality is judged by the buyer.** The seller commits to a result hash on-chain. The SDK accepts only content that matches the hash and isn't empty or an error. A malicious buyer could reject good work. That costs the buyer nothing but is visible on the record, and the owner can review. Third-party evaluation is on the roadmap.
- **Reputation is per vault for now.** It can't be inflated without paying through escrow.
- **The owner is trusted to set rules.** Approval of a held purchase can't override any limit.
- **An agent that may delegate can spend more of the vault's gas.** Each agent can hand out at most 4 sub-mandates, 3 levels deep, each with a 0.5 NEAR gas allowance, and each sub-agent has its own hourly request limit. Funds are bounded by the budgets as always; only issue delegating keys to agents you would trust with that much gas.
- **Receipts re-check what is public.** The seller's signature on a quote is verified by the contract at the time and not stored, so a receipt can't re-verify it.
- **The sandbox's AI is told to be obedient**, so that visitors see the vault refuse rather than the model. A sandbox vault's keys live in the visitor's browser storage; they are testnet throwaways.
- **Before `lock-vault`, whoever holds the vault's full-access key can upgrade the contract.**
- **Testnet only, not audited.** The tUSDC token has an open faucet by design.

## Repository layout

```
contracts/vault        Rust (near-sdk 5.30): the Almoner Vault + 45 unit tests
contracts/vault/src/sub.rs  Sub-mandates: agents hiring agents
contracts/test-token   Rust: tUSDC, a testnet NEP-141 token with a faucet
ts/src/sdk.ts          TypeScript client: views, agent/owner/seller calls, quote signing, IntentLock mirror
ts/src/agent.ts        Buyer agent: negotiation inside the mandate, delivery checks
ts/src/sellers.ts      Two seller agents (honest, junk) that sign quotes and deliver
ts/src/demo.ts         The night shift, live on testnet
ts/src/bootstrap.ts    One-command testnet setup
ts/src/owner.ts        Owner CLI
ts/src/relay.ts        AI relay for the sandbox: fixed prompt and tools, holds only the model key
ts/src/team.ts         Agents hiring agents, live on testnet
ts/src/mcp.ts          MCP server: any AI client as the agent
ts/src/shop-setup.ts   Owner-only: open the hands-on shop on the Try it page
ts/src/new-account.ts  One-command funded testnet account
ts/src/attack.ts       Public challenge: six attacks signed with the published agent key
ts/src/challenge-setup.ts  Owner-only: open the public challenge
web/sandbox.html       Your own vault, your rules, a real AI agent, and the owner controls
web/                   Landing page (index.html), product page (try.html): be the agent, attack console, live vault; receipt.html: one decision, re-checked
ts/src/web-bundle.ts   Entry for the browser build of near-api-js (npm run build:web -> web/vendor/near.js)
scripts/build.sh       Contract → wasm
```

## Built at NEAR HACKATHON

- **All code in this repository was written during NEAR HACKATHON (Nov 2026), from scratch, for NEAR only.** Everything runs on NEAR: contracts on NEAR testnet, payments in a NEP-141 token, keys issued by the contract, signatures checked by NEAR host functions. It contains no code for, and no dependency on, any other chain.
- **Disclosure, per HACKATHON.md:** this idea first appeared as an earlier, non-NEAR prototype under a different name (Vibestarter Vibeathon 02). None of that code is used here. Three ideas (agents hiring agents with narrowing sub-mandates, an MCP server, receipts that explain a decision) were first explored in another earlier project of the builder's on a different chain; they were designed again for NEAR access keys and written from scratch here, with no shared code.

### Third-party code and AI (HACKATHON.md Q-005)

| Used | Where | Purpose |
| --- | --- | --- |
| [near-sdk](https://crates.io/crates/near-sdk) 5.30, [near-contract-standards](https://crates.io/crates/near-contract-standards) 5.30 | contracts | NEAR contract SDK; NEP-141 implementation for the test token |
| [ed25519-dalek](https://crates.io/crates/ed25519-dalek), [rand](https://crates.io/crates/rand) | contract tests only | Sign quotes in unit tests |
| [near-api-js](https://www.npmjs.com/package/near-api-js) 7.5 | ts/ | RPC, transactions, key pairs |
| [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk), [zod](https://www.npmjs.com/package/zod) | ts/src/mcp.ts | MCP server and its input schemas |
| [Groq](https://groq.com) API, model `openai/gpt-oss-120b` | sandbox AI agent, through ts/src/relay.ts | The language model behind the sandbox's agent. It can only call the seven tools; the vault decides |
| [tsx](https://www.npmjs.com/package/tsx), [typescript](https://www.npmjs.com/package/typescript), [@noble/curves](https://www.npmjs.com/package/@noble/curves) (tests) | ts/ | Run and typecheck scripts; deterministic test key |
| [Inter](https://github.com/rsms/inter) and [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) fonts (SIL Open Font License) | web/fonts | Text and monospace type, hosted with the site |
| Claude (Anthropic) | whole repo | Track research, design, and writing code, tests and docs with the builder. Every test in the repo runs. |

## Roadmap (NEAR-native)

1. **Pay in any token through NEAR Intents.** Sellers quote in tUSDC/USDC; buyers fund vaults from any asset via 1Click.
2. **Optional private reviewer on NEAR AI Cloud.** A TEE model judges purpose. It can only *hold* a purchase, never approve one, and its signed verdict is recorded.
3. **Shared seller registry contract.** Portable reputation across vaults.
4. **Third-party delivery evaluators**, as an alternative to buyer review.
5. **NEAR mainnet with native USDC.** Audit first.

## License

MIT
