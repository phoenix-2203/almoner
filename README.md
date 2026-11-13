# Almoner on NEAR

**Every agent purchase, accounted for, and enforced by a NEAR contract.**

AI agents now buy data, APIs and compute by themselves, a few cents at a time. A spending cap answers "can the agent afford this?". It doesn't answer "is this what the agent was asked to buy, did we pay what was quoted, did we get what we paid for, and can we prove it?" Almoner answers those questions in a NEAR contract that the agent can't get around.

## Tracks

| Track | Official ask (nearhackathon.com) | Where Almoner does it |
| --- | --- | --- |
| **`security`** AI Security & Defense (primary) | "Spending limits, policy engines, sandboxed wallets, reputation and scam detection. Give AI money without handing it the keys to everything." Hints: agent security, function-call keys | Per-task budgets, per-purchase caps and approval lines (`decide()` in `contracts/vault/src/lib.rs`); the vault is the sandboxed wallet and issues **function-call keys** that can only ask (`add_agent`); IntentLock refuses off-purpose and disguised purchases; signed quotes stop price and payee tampering; sellers who don't deliver go on hold |
| **`agents`** Agent Economy | "Agents that earn, spend, negotiate, hire other agents, and pay for APIs, compute or data" | Buyer agents **spend** from the vault and **negotiate** with seller agents (`ts/src/agent.ts`); seller agents **earn** through escrow and build reputation from verified deliveries (`ts/src/sellers.ts`, `get_sellers`); every purchase is data paid per call |

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

