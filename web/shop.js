// Almoner "Be the agent": a visitor acts as the AI agent against the live vault.
// Quotes and deliveries come from the demo sellers' server; every request to the
// vault is signed here in the browser with the published shop key (shop.json).
(() => {
  const { cfg, view, usdc, esc, refresh } = window.Almoner;
  const { Account } = window.NearApi;
  const $ = (id) => document.getElementById(id);
  const SHOP_URL = (cfg.shop && cfg.shop.keyUrl) || "https://raw.githubusercontent.com/phoenix-2203/almoner/main/shop.json";
  const TGAS = 1000000000000n;
  const short = (e) => String((e && e.message) || e).split("\n")[0].slice(0, 200);
  const rand = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const order = rand(4); // this visitor's own copy of each item
  const tone = { Paid: "ok", Reused: "ok", Escrowed: "info", Delivered: "info", PayoutPending: "info", PendingApproval: "warn", Refunded: "warn", Rejected: "bad", Declined: "bad" };
  const label = { Escrowed: "approved: held in escrow", PendingApproval: "waiting for the owner", Reused: "reused for $0", Declined: "refused by the vault", Paid: "seller paid", Refunded: "refunded", Delivered: "delivered", PayoutPending: "paying the seller", Rejected: "rejected by the owner" };

  let s = null; // shop.json: { api, vault, token, taskId, sellers:{name:account}, agentPublicKey, agentPrivateKey }
  let agent = null;
  let seller = "datadesk";
  let catalog = {}; // seller name -> items
  let picked = null; // catalog item
  let purchase = null; // the purchase being worked on
  let busy = false;

  const api = async (path, body) => {
    let r;
    try {
      r = await fetch(s.api + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
    } catch (e) {
      throw new Error("The sellers' server did not answer. Try again in a moment.");
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "The seller answered " + r.status);
    return j;
  };

  const chip = (p) => `<span class="chip ${tone[p.status] || ""}">${esc(label[p.status] || p.status)}</span> <span class="mono">${esc(p.code)}</span>`;
  const lock = (on) => {
    busy = on;
    ["shopQuote", "shopBuy", "shopDeliver", "shopAccept", "shopReject"].forEach((id) => ($(id).disabled = on || (id === "shopBuy" && !$("shopQuoteJson").value.trim())));
  };
  const fail = (el, e) => {
    const m = short(e);
    el.innerHTML = /allowance/i.test(m)
      ? `<span class="chip warn">key out of gas</span> Visitors have used up this key's gas allowance. No funds are affected; a fresh key is published when the owner next rotates it.`
      : `<span class="chip warn">not sent</span> ${esc(m)}`;
  };

  async function rules() {
    try {
      const [t, k] = await Promise.all([
        view("get_task", { task_id: s.taskId }),
        fetch(cfg.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key", finality: "optimistic", account_id: s.vault, public_key: s.agentPublicKey } }) }).then((r) => r.json()),
      ]);
      const fc = k.result && k.result.permission && k.result.permission.FunctionCall;
      const gas = fc ? (Number(BigInt(fc.allowance) / 10n ** 20n) / 10000).toFixed(2) + " NEAR" : "key replaced: reload";
      const card = (a, b) => `<div class="card"><div class="k">${esc(a)}</div><div class="v">${b}</div></div>`;
      $("shopRules").innerHTML =
        card("Budget left", usdc(t.remaining)) +
        card("Most per purchase", usdc(t.rules.max_per_purchase)) +
        card("Owner must approve above", usdc(t.rules.approval_above)) +
        card("May buy", esc(t.rules.categories.join(", "))) +
        card("Never", esc(t.rules.blocked_terms.join(", "))) +
        card("Gas left on the agent key", gas);
      return t;
    } catch (e) { return null; }
  }

  function drawSellers() {
    $("shopSellers").innerHTML = Object.keys(s.sellers).map((n) => `<button type="button" data-s="${esc(n)}" class="${n === seller ? "on" : ""}">${n === "datadesk" ? "DataDesk" : n === "junkdata" ? "JunkData" : esc(n)}</button>`).join("");
    $("shopSellers").querySelectorAll("button").forEach((b) => (b.onclick = () => { seller = b.dataset.s; picked = null; drawSellers(); drawItems(); }));
  }
  async function drawItems() {
    const box = $("shopItems");
    if (!catalog[seller]) {
      box.innerHTML = `<p class="fine">Loading the catalog…</p>`;
      try { catalog[seller] = (await api(`/${seller}/catalog`)).items; } catch (e) { box.innerHTML = `<p class="fine">${esc(short(e))}</p>`; return; }
    }
    const items = catalog[seller];
    if (!picked) picked = items[0];
    box.innerHTML = items.map((it, i) => `<button type="button" class="item-opt ${it === picked ? "on" : ""}" data-i="${i}"><b>${esc(it.description)}</b><span class="p">${usdc(it.list)}</span><span class="u">${esc(it.item)} · ${esc(it.category)}</span></button>`).join("");
    box.querySelectorAll("button").forEach((b) => (b.onclick = () => { picked = items[Number(b.dataset.i)]; $("shopOffer").value = ""; drawItems(); }));
  }

  $("shopQuote").onclick = async () => {
    if (busy || !picked) return;
    const raw = $("shopOffer").value.trim();
    const body = { item: picked.item, order };
    if (raw) {
      const n = Number(raw);
      if (!(n > 0) || n > 1000) { $("shopQuoteOut").hidden = false; $("shopQuoteNote").textContent = "Enter your offer as a number, for example 0.09."; return; }
      body.offer = String(Math.round(n * 1e6));
    }
    lock(true);
    try {
      const q = await api(`/${seller}/quote`, body);
      const said = q.note === "offer accepted" ? "accepted your offer" : q.note === "counter-offer at floor" ? "refused your offer and countered with its lowest price" : "quoted its list price";
      $("shopQuoteNote").innerHTML = `The seller ${said}: <b>${usdc(q.quote.price)}</b>. The quote is valid for ten minutes and can be used once. Prices are in millionths of a tUSDC (120000 = 0.12).`;
      $("shopQuoteJson").value = JSON.stringify({ quote: q.quote, signature: q.signature }, null, 2);
      $("shopQuoteOut").hidden = false;
    } catch (e) {
      $("shopQuoteOut").hidden = false;
      $("shopQuoteNote").textContent = short(e);
    }
    lock(false);
  };
  $("shopQuoteJson").oninput = () => lock(busy);

  function showStep4(p) {
    purchase = p;
    $("shopStep4").hidden = false;
    $("shopDelivered").hidden = true;
    $("shopDeliver").hidden = false;
    $("shopSettle").innerHTML = "";
  }

  $("shopBuy").onclick = async () => {
    if (busy) return;
    const out = $("shopDecision");
    let signed;
    try { signed = JSON.parse($("shopQuoteJson").value); if (!signed.quote || !signed.signature) throw 0; } catch (e) { out.innerHTML = `<span class="chip warn">not sent</span> The quote must be valid JSON with "quote" and "signature".`; return; }
    lock(true);
    $("shopStep4").hidden = true;
    out.innerHTML = `<span class="muted">signing and sending to NEAR…</span>`;
    try {
      const t = await view("get_task", { task_id: s.taskId });
      const p = await agent.callFunction({
        contractId: s.vault,
        methodName: "request_purchase",
        args: { task_id: s.taskId, mandate_hash: t.mandate_hash, quote: signed.quote, signature: signed.signature, reason: $("shopReason").value.trim() || "no reason given", idempotency_key: rand(8) },
        gas: 60n * TGAS,
      });
      const more =
        p.status === "Escrowed" ? ` ${usdc(p.price)} is now reserved in the vault. Nothing has been paid yet.`
        : p.status === "PendingApproval" ? " Only the owner's account can approve it; this key cannot."
        : p.status === "Reused" ? " No money moved."
        : " No money moved.";
      out.innerHTML = `${chip(p)}<br>${esc(p.detail)}${more} <span class="muted">Recorded on-chain as decision #${p.id}.</span>`;
      if (p.status === "Escrowed") showStep4(p);
      $("shopQuoteJson").value = "";
      $("shopQuoteOut").hidden = true;
    } catch (e) { fail(out, e); }
    lock(false);
    rules();
    refresh();
  };

  $("shopDeliver").onclick = async () => {
    if (busy || !purchase) return;
    const name = Object.keys(s.sellers).find((n) => s.sellers[n] === purchase.seller);
    lock(true);
    $("shopSettle").innerHTML = `<span class="muted">the seller is delivering on-chain…</span>`;
    try {
      const d = await api(`/${name}/fulfil`, { purchase_id: purchase.id });
      $("shopResult").textContent = d.result === "" ? "(the seller delivered an empty file)" : d.result;
      $("shopDelivered").hidden = false;
      $("shopDeliver").hidden = true;
      $("shopSettle").innerHTML = `<span class="chip info">delivered</span> The seller committed to this content on-chain (hash <span class="mono">${esc(String(d.result_hash).slice(0, 16))}…</span>). It is still unpaid. Your call.`;
    } catch (e) { fail($("shopSettle"), e); }
    lock(false);
    refresh();
  };

  async function settle(accept) {
    if (busy || !purchase) return;
    lock(true);
    $("shopSettle").innerHTML = `<span class="muted">signing and sending to NEAR…</span>`;
    try {
      await agent.callFunction({ contractId: s.vault, methodName: "confirm_delivery", args: { purchase_id: purchase.id, accept, note: accept ? null : "rejected by a visitor on the Try it page" }, gas: 100n * TGAS });
      let p = await view("get_purchase", { purchase_id: purchase.id });
      for (let i = 0; i < 5 && p.status === "PayoutPending"; i++) { await new Promise((r) => setTimeout(r, 1500)); p = await view("get_purchase", { purchase_id: purchase.id }); }
      $("shopSettle").innerHTML = `${chip(p)}<br>${esc(p.detail)}`;
      $("shopDelivered").hidden = true;
      purchase = null;
    } catch (e) { fail($("shopSettle"), e); }
    lock(false);
    rules();
    refresh();
  }
  $("shopAccept").onclick = () => settle(true);
  $("shopReject").onclick = () => settle(false);

  (async () => {
    try {
      const r = await fetch(SHOP_URL + "?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      s = await r.json();
    } catch (e) {
      $("shopNote").innerHTML = `The shop isn't open right now (couldn't load <a href="${esc(SHOP_URL)}">shop.json</a>). The attack console below still works.`;
      return;
    }
    agent = new Account(s.vault, cfg.rpc, s.agentPrivateKey);
    const t = await rules();
    $("shopNote").innerHTML = `Task #${s.taskId} on <span class="mono">${esc(s.vault)}</span>. The agent key is published in <a href="${esc(SHOP_URL)}" target="_blank" rel="noopener">shop.json</a>; the vault issued it and it can only ask.${t ? "" : " (Couldn't read the task just now.)"}`;
    $("bench").hidden = false;
    $("shopIdeas").hidden = false;
    drawSellers();
    drawItems();
    lock(false);
  })();
})();
