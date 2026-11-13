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
 *   npm run owner -- new-agent-key [near]   (replace the demo agent's key; default 3 NEAR gas allowance)
 *   npm run owner -- lock-vault --yes   (deletes the vault's full-access key: no more upgrades)
 */
import { Account, KeyPair, type KeyPairString } from "near-api-js";
import { AlmonerVault, fmtNear, fmtUsdc } from "./sdk.js";
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
      console.log(`vault account holds ${fmtNear(await vault.nearBalance(state.vault.accountId))} for gas and storage · owner holds ${fmtNear(await vault.nearBalance(accountId))}`);
      for (const a of await vault.getAgents()) {
        const left = a.active ? await vault.keyAllowance(a.public_key) : null;
        console.log(`agent ${a.name} · ${a.active ? "active" : "revoked"} · tasks ${a.task_ids.join(",")} · gas allowance left ${left == null ? "-" : fmtNear(left)}`);
      }
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
    case "new-agent-key": {
      // A key's allowance can't be topped up, so replace the key.
      const near = Number(a1 ?? 3);
      const fresh = KeyPair.fromRandom("ed25519").toString() as KeyPairString;
      const publicKey = KeyPair.fromString(fresh).getPublicKey().toString();
      await o.addAgent(publicKey, state.agent.name, [state.taskId], (BigInt(Math.round(near * 1000)) * 10n ** 21n).toString());
      const old = state.agent.publicKey;
      state.agent = { name: state.agent.name, key: fresh, publicKey };
      saveState(state);
      await o.revokeAgent(old).catch(() => {});
      return console.log(`new agent key issued with ${near} NEAR gas allowance; old key deleted`);
    }
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
      console.log("commands: status | approve <id> | reject <id> [note] | review <id> accept|reject [note] | clear-hold <seller> | freeze | unfreeze | pause | resume | revoke-agent | new-agent-key [near] | lock-vault --yes");
  }
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
