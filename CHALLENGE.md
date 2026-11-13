# Here is the agent's private key. Try to take the money.

The Almoner vault below is live on NEAR testnet and holds **19.85 tUSDC**.
This is a real agent key for it, published on purpose:

```
vault        vault.almoner-502c7b80.testnet
agent key    ed25519:2h3E1vYHvJMMG3BvQcMjUiGdBgvAPRo28F4CSfAv58e1R1ZK8me12XT2j1VdD1jGvLiyfqSEiLvv99dSC5CSn3WT
public key   ed25519:57kkewe2vdA2Gn5CYtkERkiQUBuC6VvdEivbY731VMBy
task         #2 "Public challenge"
```

On most agent wallets, leaking the agent's key means losing the wallet. Here the
vault issued this key **to its own account** as a NEAR function-call access key.
It can call three methods on the vault (`request_purchase`, `confirm_delivery`,
`settle_expired`) and nothing else. The NEAR protocol enforces that, not our code.

## Try it

```bash
git clone https://github.com/phoenix-2203/almoner && cd almoner/ts
npm ci
npm run attack
```

`npm run attack` signs six attacks with the key above and prints what happened to
each. The first four are stopped by the NEAR protocol before they reach the
contract; the last two reach the vault, are refused, and are **recorded on-chain**:

| # | Attack | Stopped by |
| --- | --- | --- |
| 1 | Transfer NEAR out of the vault account | NEAR protocol: function-call keys can't transfer |
| 2 | Add a full-access key to the vault account | NEAR protocol |
| 3 | Call `ft_transfer` on the token contract directly | NEAR protocol: key is bound to the vault contract |
| 4 | Call the vault's owner-only `withdraw` | NEAR protocol: method isn't on the key's list |
| 5 | Ask the vault to pay a quote the attacker signed in a seller's name | Vault: `QUOTE_INVALID` |
| 6 | Ask the vault to pay an attacker-controlled "seller" | Vault: `SELLER_UNKNOWN` |

Write your own attack: the key works with any NEAR tool
(`near-api-js`, `near-cli-rs`). Signer account = the vault account.

## Watch the attempts

- Dashboard: https://phoenix-2203.github.io/almoner/ (every refusal appears under "Every decision")
- Explorer: https://testnet.nearblocks.io/address/vault.almoner-502c7b80.testnet

## Honest limits

- The key has a gas allowance of 1 NEAR, enough for roughly thirty attempts.
  Spam can burn that allowance, after which the key stops working and we publish
  a fresh one here. That is the worst case: the funds don't move.
- The key belongs to its own task with a 1 tUSDC budget and one allowed seller.
  The seller only signs quotes for real purchases, so without a seller-signed
  quote nothing can even be put into escrow.
- If you do find a way to move funds, please open an issue: that is a real bug.
- Testnet only. tUSDC is a test token with no value.
