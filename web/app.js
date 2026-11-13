// Almoner dashboard: reads the vault directly over NEAR JSON-RPC. No keys, no backend.
(() => {
  const qs = new URLSearchParams(location.search);
  const cfg = Object.assign({ rpc: "https://rpc.testnet.fastnear.com", network: "testnet", vault: "" }, window.ALMONER || {});
  if (qs.get("vault")) cfg.vault = qs.get("vault");
  if (qs.get("rpc")) cfg.rpc = qs.get("rpc");
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const usdc = (b) => { const n = Number(BigInt(b || 0)) / 1e6; return n.toFixed(n < 1 ? 3 : 2) + " tUSDC"; };
  const when = (ms) => (ms ? new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
  const explorer = cfg.network === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
  const tone = { Paid: "ok", Reused: "ok", Escrowed: "info", Delivered: "info", PayoutPending: "info", PendingApproval: "warn", Refunded: "warn", Rejected: "bad", Declined: "bad" };
  let filter = "All";

  async function view(method, args = {}) {
    const res = await fetch(cfg.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "almoner", method: "query",
        params: { request_type: "call_function", finality: "optimistic", account_id: cfg.vault, method_name: method, args_base64: btoa(JSON.stringify(args)) },
      }),
    });
    const j = await res.json();
    if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error || j.result.error));
    return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
  }

  async function sha256hex(text) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  const card = (k, v, cls = "") => `<div class="card"><div class="k">${esc(k)}</div><div class="v ${cls}">${v}</div></div>`;

  async function render() {
    if (!cfg.vault) { $("vault").innerHTML = card("No vault", "Enter a vault account above"); return; }
    $("vaultInput").value = cfg.vault;
    const [v, tasks, purchases, sellers, log, chainOk] = await Promise.all([
      view("get_vault"), view("get_tasks"), view("get_purchases", { limit: 100 }), view("get_sellers"), view("get_log", { from_index: 0, limit: 200 }), view("verify_log"),
    ]);

    $("vault").innerHTML = [
      card("Vault", `<a class="mono" href="${explorer}/address/${esc(cfg.vault)}" target="_blank" rel="noopener">${esc(cfg.vault)}</a>`),
      card("Holds", usdc(v.balance)),
      card("In escrow", usdc(v.reserved), "info"),
      card("Free", usdc(v.available)),
      card("Status", v.frozen ? "Frozen" : "Live", v.frozen ? "bad" : "ok"),
      card("Decisions", String(v.purchases)),
    ].join("");

    // Hero: the newest decisions and four headline numbers, all read from chain.
    $("heroVault").textContent = cfg.vault;
    const words = { Paid: "Paid after delivery check", Reused: "Reused for $0", Escrowed: "Held in escrow", Delivered: "Delivered, awaiting review", PayoutPending: "Paying seller", PendingApproval: "Waiting for a person", Refunded: "Refunded", Rejected: "Rejected by owner", Declined: "Refused" };
    $("feed").innerHTML = purchases.slice(0, 6).map((p) => `<li><span class="chip ${tone[p.status] || ""}">${esc(p.status === "Declined" ? p.code : p.status)}</span>
      <span class="what"><b>${esc(p.item.replace(/^https?:\/\//, ""))}</b><span>${esc(words[p.status] || p.status)} · ${esc(p.detail)}</span></span>
      <span class="amt">${usdc(p.price)}</span></li>`).join("") || `<li class="muted">No decisions yet.</li>`;
    const refused = purchases.filter((p) => p.status === "Declined").length;
    const refunded = purchases.filter((p) => p.status === "Refunded").length;
    const stat = (v, k) => `<div class="stat"><div class="v">${v}</div><div class="k">${esc(k)}</div></div>`;
    $("stats").innerHTML = [
      stat(v.purchases, "decisions recorded on-chain"),
      stat(refused, "purchases refused before money moved"),
      stat(refunded, "junk deliveries refunded"),
      stat(usdc(v.balance).replace(" tUSDC", ""), "tUSDC still in the vault"),
    ].join("");

    if (cfg.challenge) {
      const tries = purchases.filter((p) => p.task_id === cfg.challenge.task);
      const moved = tries.filter((p) => !["Declined", "Rejected"].includes(p.status)).length;
      $("challenge").innerHTML = `<div class="challenge"><a class="btn" href="${esc(cfg.challenge.url)}" target="_blank" rel="noopener">Get the key (CHALLENGE.md)</a><br>
        <span class="chip ${moved ? "bad" : "ok"}">${tries.length} recorded attempt${tries.length === 1 ? "" : "s"} so far · ${moved} got through</span></div>`;
    }

    $("tasks").innerHTML = (await Promise.all(tasks.map(async (t) => {
      const json = await view("get_mandate_json", { task_id: t.id });
      const ok = (await sha256hex(json)) === t.mandate_hash;
      const r = t.rules;
      return `<div class="task"><strong>#${t.id} ${esc(r.name)}</strong> <span class="chip">${esc(t.status)}</span> <span class="chip">v${t.version}</span>
        <span class="chip ${ok ? "ok" : "bad"}">${ok ? "✓ mandate hash verified in your browser" : "✗ mandate hash mismatch"}</span>
        <div class="muted">${esc(r.purpose)}</div>
        <dl>
          <dt>Spent</dt><dd>${usdc(t.spent)} of ${usdc(r.budget)} · ${usdc(t.reserved)} in escrow · ${usdc(t.remaining)} left</dd>
          <dt>Per purchase</dt><dd>up to ${usdc(r.max_per_purchase)}; above ${usdc(r.approval_above)} waits for a person</dd>
          <dt>Categories</dt><dd>${r.categories.map(esc).join(", ") || "any"}</dd>
          <dt>Never buy</dt><dd>${r.blocked_terms.map(esc).join(", ") || "—"} <span class="muted">(disguises decoded)</span></dd>
          <dt>Sellers</dt><dd>${r.allowed_sellers.map(esc).join(", ") || "any registered"}</dd>
          <dt>Windows</dt><dd>deliver within ${Math.round(r.delivery_window_ms / 60000)} min · review within ${Math.round(r.review_window_ms / 60000)} min · reuse ${Math.round(r.reuse_window_ms / 60000)} min · ${r.max_purchases_per_hour}/hour</dd>
          <dt>Mandate</dt><dd class="mono">${esc(t.mandate_hash)}</dd>
        </dl></div>`;
    }))).join("") || `<p class="muted">No tasks yet.</p>`;

    const statuses = ["All", ...new Set(purchases.map((p) => p.status))];
    $("filters").innerHTML = statuses.map((s) => `<button class="${s === filter ? "on" : ""}" data-s="${esc(s)}">${esc(s)}${s === "All" ? "" : " " + purchases.filter((p) => p.status === s).length}</button>`).join("");
    $("filters").querySelectorAll("button").forEach((b) => (b.onclick = () => { filter = b.dataset.s; render(); }));
    const shown = purchases.filter((p) => filter === "All" || p.status === filter);
    $("pcount").textContent = `${purchases.length} newest first`;
    $("purchases").querySelector("tbody").innerHTML = shown.map((p) => `<tr>
      <td>${p.id}</td><td>${when(p.created_ms)}</td>
      <td><span class="chip ${tone[p.status] || ""}">${esc(p.status)}</span><div class="mono muted">${esc(p.code)}</div></td>
      <td class="mono">${esc(p.seller)}</td><td class="item mono">${esc(p.item)}<div class="muted">${esc(p.category)}</div></td>
      <td class="num">${usdc(p.price)}</td>
      <td class="why">${esc(p.detail)}${p.reason ? `<div><em>Agent: “${esc(p.reason)}”</em></div>` : ""}${p.result_hash ? `<div class="mono">result ${esc(p.result_hash.slice(0, 18))}…</div>` : ""}</td></tr>`).join("")
      || `<tr><td colspan="7" class="muted">No purchases yet.</td></tr>`;

    $("sellers").innerHTML = sellers.map((s) => {
      const pct = s.delivery_score_bps / 100;
      return `<div class="card"><div><strong>${esc(s.name)}</strong> ${s.on_hold ? `<span class="chip bad">on hold</span>` : ""}</div>
        <div class="mono muted">${esc(s.account_id)}</div>
        <div class="bar"><span style="width:${pct}%"></span></div>
        <div>${s.settled ? `${pct.toFixed(0)}% delivered over ${s.settled} settled` : "no settled purchases yet"}</div>
        <div class="muted">earned ${usdc(s.stats.earned)} · ${s.stats.rejected} rejected · ${s.stats.missed} missed</div>
        ${s.on_hold ? `<div class="bad">${esc(s.hold_reason)}</div>` : ""}</div>`;
    }).join("") || `<p class="muted">No sellers yet.</p>`;

    // Recompute the hash chain in the browser, independently of the contract.
    let prev = "0".repeat(64), ok = true;
    for (const e of log) {
      const h = await sha256hex(`${e.seq}|${e.at_ms}|${e.kind}|${e.purchase_id ?? "-"}|${e.code}|${prev}`);
      if (e.prev_hash !== prev || h !== e.hash) { ok = false; break; }
      prev = e.hash;
    }
    const complete = log.length === v.log_len;
    $("logcheck").innerHTML = `<p><span class="chip ${ok ? "ok" : "bad"}">${ok ? "✓" : "✗"} chain recomputed in your browser${complete ? "" : ` (first ${log.length} of ${v.log_len})`}</span>
      <span class="chip ${chainOk ? "ok" : "bad"}">${chainOk ? "✓" : "✗"} contract verify_log()</span> <span class="mono muted">head ${esc(v.log_head.slice(0, 20))}…</span></p>`;
    $("log").querySelector("tbody").innerHTML = log.slice().reverse().slice(0, 60).map((e) => `<tr><td>${e.seq}</td><td>${when(e.at_ms)}</td>
      <td>${esc(e.kind)}${e.purchase_id != null ? ` #${e.purchase_id}` : ""}</td><td class="mono">${esc(e.code)}</td><td class="mono muted">${esc(e.hash.slice(0, 16))}…</td></tr>`).join("");
    $("updated").textContent = `Updated ${new Date().toLocaleTimeString()}.`;
  }

  $("pick").onsubmit = (ev) => {
    ev.preventDefault();
    cfg.vault = $("vaultInput").value.trim();
    history.replaceState(null, "", `?vault=${encodeURIComponent(cfg.vault)}`);
    render().catch(showError);
  };
  const showError = (e) => { $("vault").innerHTML = card("Couldn't read the vault", esc(e.message || e), "bad"); };
  render().catch(showError);
  setInterval(() => render().catch(showError), 15000);
})();
