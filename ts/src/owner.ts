/**
 * Owner CLI.
 *   npm run owner -- status
 *   npm run owner -- approve <purchase_id>
 *   npm run owner -- reject <purchase_id> [note]
 *   npm run owner -- review <purchase_id> accept|reject [note]
 *   npm run owner -- clear-hold <seller_account>
 *   npm run owner -- freeze | unfreeze
 *   npm run owner -- pause | resume
 *   npm run owner -- revoke-agent
 *   npm run owner -- lock-vault --yes   (deletes the vault's full-access key: no more upgrades)
 */
import { Account, KeyPair } from "near-api-js";
import { AlmonerVault, fmtUsdc } from "./sdk.js";
import { loadState, ownerCreds, RPC, saveState } from "./config.js";

async function main() {
  const [cmd, a1, a2, ...rest] = process.argv.slice(2);
  const state = loadState();
  const vault = new AlmonerVault(state.vault.accountId, RPC);
  const { accountId, key } = ownerCreds();
  const o = vault.owner(accountId, key);
  const out = (x: unknown) => console.log(JSON.stringify(x, null, 2));

  switch (cmd) {
    case "status": {
      const v = await vault.getVault();
      console.log(`vault ${state.vault.accountId} · balance ${fmtUsdc(v.balance)} · reserved ${fmtUsdc(v.reserved)} · frozen ${v.frozen}`);
      for (const p of await vault.getPurchases(20)) console.log(`#${p.id} ${p.status} ${p.code} ${fmtUsdc(p.price)} ${p.item}`);
      break;
    }
    case "approve":
      return out(await o.approve(Number(a1)));
    case "reject":
      return out(await o.reject(Number(a1), [a2, ...rest].filter(Boolean).join(" ") || undefined));
    case "review":
      return out(await o.review(Number(a1), a2 === "accept", rest.join(" ") || undefined));
    case "clear-hold":
      await o.clearHold(a1);
      return console.log(`hold cleared for ${a1}`);
    case "freeze":
    case "unfreeze":
      await o.setFrozen(cmd === "freeze");
      return console.log(`vault ${cmd === "freeze" ? "frozen" : "unfrozen"}`);
    case "pause":
    case "resume":
      await o.setTaskStatus(state.taskId, cmd === "pause" ? "Paused" : "Active");
      return console.log(`task #${state.taskId} ${cmd === "pause" ? "paused" : "active"}`);
    case "revoke-agent":
      await o.revokeAgent(state.agent.publicKey);
      return console.log("agent key deleted from the vault");
    case "lock-vault": {
      if (a1 !== "--yes") return console.log("This deletes the vault account's full-access key. The contract can never be upgraded again. Re-run with --yes.");
      if (!state.vault.key) return console.log("already locked");
      const acct = new Account(state.vault.accountId, RPC, state.vault.key);
      await acct.deleteKey(KeyPair.fromString(state.vault.key).getPublicKey());
      state.vault.key = null;
      saveState(state);
      return console.log("vault locked: only the contract and its agent keys can act on it now");
    }
    default:
      console.log("commands: status | approve <id> | reject <id> [note] | review <id> accept|reject [note] | clear-hold <seller> | freeze | unfreeze | pause | resume | revoke-agent | lock-vault --yes");
  }
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
