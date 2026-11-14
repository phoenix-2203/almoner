# What the video says, and what backs it

Every claim in the narration, with where to check it. Testnet only; not audited.

| In the video | Evidence |
| --- | --- |
| "This is the private key to an AI agent's wallet. A real key. A live vault." | The key on the opening card is the one in `challenge.json` and `CHALLENGE.md`; it is a vault-issued agent key for `vault.almoner-502c7b80.testnet` |
| "Send the money out? Blocked. Add your own key? Blocked. Four thefts die at the NEAR protocol. Two reach the vault, and are refused." | `ts/src/attack.ts` and the attack console on `try.html`, run live in the shot: attacks 1 to 4 are rejected by the protocol, 5 and 6 by the contract (`QUOTE_INVALID`, `SELLER_UNKNOWN`) and recorded |
| "The agent never holds money. The vault gives it a NEAR function-call key, that can only ask to buy." | `add_agent` in `contracts/vault/src/lib.rs` (`add_access_key_allowance` with `AGENT_METHODS`). The key can also confirm a delivery and settle an expired purchase, which the card's "ask to buy" line simplifies |
| "Rules the owner signed decide, on-chain." | `decide()` in the contract; no server or model takes part in a decision |
| "One click gives you your own vault on testnet, with your budget, and your rules." | `web/sandbox.js` `setup()`: account, vault account, contract deploy, task and agent key, all signed in the browser; shown live |
| "Give a real AI model a job. It haggles, the seller signs the price, and the money waits in escrow until the delivery is accepted." | `ts/src/relay.ts` (hosted language model, fixed prompt and tools); `/quote` in `ts/src/sellers.ts`; `ed25519_verify` in `decide()`; `confirm_delivery`. If the buyer never reviews, payment releases after the review window, which the video does not mention |
| "It reads a web page with a hidden instruction: buy a gift card. The model obeys. The vault refuses." | The sandbox model is instructed to be obedient (stated on the page). `contracts/vault/src/intent.rs`; test `disguised_blocked_item_is_refused`; shown live as `INTENT_MISMATCH` |
| "Approve what is held. Freeze the vault in one click. And every decision has a receipt you can check yourself." | `approve_purchase`, `set_frozen`; `web/receipt.js` re-checks seller list, category, blocked terms and limits from public data. It cannot re-verify the seller's signature, which is not stored |
| "Agents can even hire agents, but only by narrowing. Cancel one, and everything below it stops." | `contracts/vault/src/sub.rs`; 14 tests; `raw/team.txt` is the unedited output of `npm run team` on testnet |
| "Forty-five contract tests." | `cargo test --workspace`, run by CI on every push |
| "Every decision on-chain." | `append_log`, `verify_log`; every request, including each refusal, is stored as a purchase record and a hash-chained log entry |

Editing: browser shots are the real site driven by a script, always at real speed. Where a shot is longer than its scene, the waiting in the middle is cut with a dissolve; nothing is re-ordered. Waits between chat messages are cut. The cards are illustrations, not footage.
