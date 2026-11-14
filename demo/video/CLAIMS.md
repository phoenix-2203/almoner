# What the video says, and what backs it

Every sentence of narration that makes a claim, with where to check it. Testnet only; not audited.

| In the video | Evidence |
| --- | --- |
| "An AI agent's private key … We published it." | `challenge.json` and `CHALLENGE.md` in the repository root; shown on `try.html` |
| "The vault issues the agent a NEAR function-call key, which can call a short list of methods on the vault, and nothing else. It cannot transfer, or add keys. NEAR itself enforces that." | `add_agent` in `contracts/vault/src/lib.rs` (`add_access_key_allowance` with `AGENT_METHODS`); attacks 1 to 4 in `ts/src/attack.ts` are rejected by the protocol, shown live in the attack shot |
| "One click gives you a vault of your own" | `web/sandbox.js` `setup()`: a faucet account, a sub-account, contract deploy, task and agent key, all signed in the browser; shown live |
| "A real AI model gets a job" | `ts/src/relay.ts` forwards the chat to a hosted language model with a fixed prompt and tools; the tools run in the browser with the vault-issued key |
| "It haggles with a seller, who signs the price. The vault checks that signature" | `ts/src/sellers.ts` (`/quote`), `env::ed25519_verify` in `decide()`; tests `tampered_price_fails_signature`, `redirected_payee_fails_signature` |
| "The seller is paid only after delivery is accepted." | `confirm_delivery` → `start_payout`; test `happy_path_escrow_deliver_accept_pay`. If the buyer never reviews, payment releases after the review window (`silent_buyer_auto_releases_to_seller`), which the video does not mention |
| "The model obeys. The vault decodes it, and refuses." | The sandbox model is instructed to be obedient (stated on the page). `contracts/vault/src/intent.rs`; test `disguised_blocked_item_is_refused`; shown live as `INTENT_MISMATCH` |
| "Approve what is held, freeze the vault in one click, and open a receipt … re-checked in your browser." | `approve_purchase`, `set_frozen`; `web/receipt.js` re-checks seller list, category, blocked terms and limits from public data. It cannot re-verify the seller's signature, which is not stored |
| "Four thefts are thrown out by the NEAR protocol … A forged quote and a fake seller reach the vault, and are refused." | `ts/src/attack.ts`; shown live. "It's a testnet challenge, not an audit." |
| "The funds have not moved." | True of the challenge task: no attempt with the published challenge key has been approved (see the dashboard's challenge counter). Visitors do spend from the separate "Open shop" task, by design |
| "Agents can hire agents, but only by narrowing. Every purchase counts against every budget above it. When Lead cancels Scout, Runner stops too." | `contracts/vault/src/sub.rs`; 14 tests; `raw/team.txt` is the unedited output of `npm run team` on testnet |
| "Forty-five contract tests" | `cargo test --workspace` (run by CI on every push) |
| "Every decision is in a hash-chained log." | `append_log`, `verify_log`; recomputed in the browser on `try.html`; test `log_is_hash_chained` |
| "Any AI client can be the agent, over MCP." | `ts/src/mcp.ts` (seven tools, stdio). Exercised with a test client; not shown in the video |
| "Next: funding through NEAR Intents, and mainnet after an audit." | Roadmap. Not built |

Editing: browser shots are the real site driven by Playwright; they are sped up to fit the narration and waits between chat messages are cut. Nothing inside a shot is re-ordered.
