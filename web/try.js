// Almoner "Try it": sign real transactions in the browser with the published agent key.
// Uses the same near-api-js as `npm run attack` (bundled into vendor/near.js).
(() => {
  const { cfg, view, usdc, esc, refresh } = window.Almoner;
  const { Account, KeyPair } = window.NearApi;
  const $ = (id) => document.getElementById(id);
  const KEY_URL = (cfg.challenge && cfg.challenge.keyUrl) || "https://raw.githubusercontent.com/phoenix-2203/almoner/main/challenge.json";
  const LOOT = "almoner-thief.testnet";
  const TGAS = 1000000000000n;
  const short = (e) => String((e && e.message) || e).split("\n")[0].slice(0, 170);
  const near = (yocto) => (Number(BigInt(yocto) / 10n ** 20n) / 10000).toFixed(3) + " NEAR";
  let c = null; // challenge.json: { vault, token, taskId, seller, agentPublicKey, agentPrivateKey }
  let thief = null;
  let busy = false;

  async function rpcQuery(params) {
    const r = await fetch(cfg.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params }) });
    return (await r.json()).result;
  }
  const tokenBalance = async () => {
    const res = await rpcQuery({ request_type: "call_function", finality: "optimistic", account_id: c.token, method_name: "ft_balance_of", args_base64: btoa(JSON.stringify({ account_id: c.vault })) });
    return JSON.parse(new TextDecoder().decode(new Uint8Array(res.result)));
  };
  const allowance = async () => {
    const k = await rpcQuery({ request_type: "view_access_key", finality: "optimistic", account_id: c.vault, public_key: c.agentPublicKey });
    const fc = k && k.permission && k.permission.FunctionCall;
    return fc ? fc.allowance : null;
  };

  async function sha256hex(text) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const rand = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

  // A quote the attacker signs with their own throwaway key (never the seller's).
  async function forgedRequest(seller) {
    const task = await view("get_task", { task_id: c.taskId });
    const quote = { seller, item: "https://datadesk.example/reports/ai-agents-2026-11", category: "report", description: "AI agents market report", price: "200000", expires_at_ms: Date.now() + 600000, nonce: rand(12) };
    const msg = ["almoner-quote/v1", c.vault, quote.seller, quote.item, quote.category, quote.price, String(quote.expires_at_ms), quote.nonce, await sha256hex(quote.description)].join("\n");
    const sig = KeyPair.fromRandom("ed25519").sign(new TextEncoder().encode(msg)).signature;
    return thief.callFunction({
      contractId: c.vault,
      methodName: "request_purchase",
      args: { task_id: c.taskId, mandate_hash: task.mandate_hash, quote, signature: btoa(String.fromCharCode(...sig)), reason: "public challenge (browser)", idempotency_key: rand(8) },
      gas: 30n * TGAS,
    });
  }

  const ATTACKS = [
    { kind: "protocol", title: "Transfer NEAR out of the vault account", why: "The simplest theft: just send the money away.", run: () => thief.transfer({ receiverId: LOOT, amount: 1n }) },
    { kind: "protocol", title: "Add your own full-access key to the vault", why: "If this worked you would own the account.", run: () => thief.addFullAccessKey(KeyPair.fromRandom("ed25519").getPublicKey()) },
    { kind: "protocol", title: "Call ft_transfer on the token contract directly", why: "Skip the vault and move the tUSDC yourself.", run: async () => thief.callFunction({ contractId: c.token, methodName: "ft_transfer", args: { receiver_id: LOOT, amount: await tokenBalance() }, deposit: 1n, gas: 10n * TGAS }) },
    { kind: "protocol", title: "Call the vault's owner-only withdraw", why: "Ask the vault to empty itself.", run: async () => thief.callFunction({ contractId: c.vault, methodName: "withdraw", args: { amount: await tokenBalance() }, gas: 10n * TGAS }) },
    { kind: "contract", title: "Pay a quote you signed in the seller's name", why: "Forge a price quote for an allowed seller.", run: () => forgedRequest(c.seller) },
    { kind: "contract", title: "Pay a 'seller' account you control", why: "Point the payment at your own account.", run: () => forgedRequest(LOOT) },
  ];

  function draw() {
    $("attacks").innerHTML = ATTACKS.map((a, i) => `<div class="attack" id="atk${i}">
      <div class="n mono">${i + 1}</div>
      <div class="t"><b>${esc(a.title)}</b><span>${esc(a.why)}</span><div class="res" id="res${i}"></div></div>
      <button type="button" class="btn small" data-i="${i}">Run</button></div>`).join("");
    $("attacks").querySelectorAll("button").forEach((b) => (b.onclick = () => runOne(Number(b.dataset.i))));
  }

  async function runOne(i) {
    if (!thief || busy) return;
    busy = true;
    const a = ATTACKS[i], res = $("res" + i), card = $("atk" + i);
    card.className = "attack running";
    res.innerHTML = `<span class="muted">signing and sending…</span>`;
    try {
      const out = await a.run();
      if (a.kind === "contract" && out && out.status === "Declined") {
        card.className = "attack stopped";
        res.innerHTML = `<span class="chip ok">refused by the vault</span> <span class="mono">${esc(out.code)}</span> · ${esc(out.detail)} <span class="muted">Recorded on-chain as decision #${out.id}.</span>`;
      } else {
        card.className = "attack through";
        res.innerHTML = `<span class="chip bad">it went through</span> ${esc(JSON.stringify(out)).slice(0, 200)} · please open an issue on GitHub.`;
      }
    } catch (e) {
      const m = short(e);
      if (/allowance/i.test(m)) {
        card.className = "attack";
        res.innerHTML = `<span class="chip warn">key out of gas</span> Visitors have used up this key's gas allowance. The funds are untouched; a fresh key is published when the owner next rotates it.`;
      } else if (/fetch|network|timeout|load failed/i.test(m)) {
        card.className = "attack";
        res.innerHTML = `<span class="chip warn">couldn't reach NEAR</span> ${esc(m)}`;
      } else {
        card.className = "attack stopped";
        res.innerHTML = `<span class="chip ok">${a.kind === "protocol" ? "blocked by the NEAR protocol" : "rejected"}</span> ${esc(m)}`;
      }
    }
    busy = false;
    status();
    refresh();
  }

  async function status() {
    try {
      const [bal, gas] = await Promise.all([tokenBalance(), allowance()]);
      $("kHolds").textContent = usdc(bal);
      $("kGas").textContent = gas == null ? "key replaced: reload the page" : near(gas);
    } catch (e) { /* keep the last values */ }
  }

  async function loadKey() {
    try {
      const r = await fetch(KEY_URL + "?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      c = await r.json();
    } catch (e) {
      $("kKey").textContent = "couldn't load the published key";
      $("keynote").innerHTML = `Couldn't fetch <a href="${esc(KEY_URL)}">challenge.json</a> (${esc(short(e))}). You can still run <span class="mono">npm run attack</span> from the repository.`;
      return;
    }
    thief = new Account(c.vault, cfg.rpc, c.agentPrivateKey);
    $("kVault").textContent = c.vault;
    $("kKey").textContent = c.agentPrivateKey;
    $("cContract").value = c.vault;
    $("keynote").innerHTML = `Loaded from <a href="${esc(KEY_URL)}" target="_blank" rel="noopener">challenge.json</a> in the public repository. This key can only <b>ask</b> the vault to buy; NEAR itself enforces that.`;
    status();
  }

  $("runAll").onclick = async () => {
    for (let i = 0; i < ATTACKS.length; i++) await runOne(i);
  };

  $("customForm").onsubmit = async (ev) => {
    ev.preventDefault();
    if (!thief || busy) return;
    const out = $("cOut");
    let args;
    try { args = JSON.parse($("cArgs").value || "{}"); } catch (e) { out.textContent = "Arguments must be valid JSON."; return; }
    busy = true;
    out.textContent = "signing and sending…";
    try {
      const res = await thief.callFunction({ contractId: $("cContract").value.trim(), methodName: $("cMethod").value.trim(), args, gas: 30n * TGAS, deposit: $("cYocto").checked ? 1n : 0n });
      out.textContent = "The call was accepted. Result:\n" + JSON.stringify(res, null, 2);
    } catch (e) {
      out.textContent = "Blocked: " + short(e);
    }
    busy = false;
    status();
    refresh();
  };

  draw();
  loadKey();
})();
