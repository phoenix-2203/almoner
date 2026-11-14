// Almoner receipt: one decision, read from chain, with every rule the browser can re-check re-checked.
(async () => {
  const { cfg, view, usdc, esc, when, tone, sha256hex, explorer } = window.Almoner;
  const $ = (id) => document.getElementById(id);
  const id = Number(new URLSearchParams(location.search).get("id"));
  // Same disguise-decoding as contracts/vault/src/intent.rs::normalize.
  const pct = (s) => s.replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const leet = { 0: "o", 1: "i", "!": "i", "|": "i", 3: "e", 4: "a", "@": "a", 5: "s", $: "s", 7: "t", 8: "b" };
  const norm = (s) => [...pct(pct(String(s))).toLowerCase()].map((c) => leet[c] || (/[a-z0-9]/.test(c) ? c : "")).join("");

  try {
    if (!Number.isInteger(id) || id < 0) throw new Error("Add ?id=<decision number> to the address.");
    const p = await view("get_purchase", { purchase_id: id });
    if (!p) throw new Error(`This vault has no decision #${id}.`);
    const [t, seller, subs, chainOk] = await Promise.all([
      view("get_task", { task_id: p.task_id }), view("get_seller", { account_id: p.seller }).catch(() => null), view("get_sub_mandates").catch(() => []), view("verify_log"),
    ]);
    let log = [];
    for (let from = 0; ; from += 200) { const part = await view("get_log", { from_index: from, limit: 200 }); log = log.concat(part); if (part.length < 200) break; }

    document.title = `Almoner receipt #${p.id}`;
    $("rTitle").innerHTML = `Decision #${p.id}: <mark>${esc(p.status === "Declined" ? "refused" : p.status === "PendingApproval" ? "waiting for the owner" : p.status.toLowerCase())}</mark>`;
    $("rSub").textContent = p.detail;
    const card = (k, v) => `<div class="card"><div class="k">${esc(k)}</div><div class="v" style="font-size:15px;word-break:normal;overflow-wrap:anywhere">${v}</div></div>`;
    const chain = []; for (let pk = p.agent, m; (m = subs.find((x) => x.agent === pk)) && chain.length < 5; pk = m.parent) chain.push(m);
    $("rCards").innerHTML =
      card("Decision", `<span class="chip ${tone[p.status] || ""}">${esc(p.status)}</span> <span class="mono">${esc(p.code)}</span>`) +
      card("Price", usdc(p.price)) + card("Seller", `<span class="mono">${esc(p.seller)}</span>`) + card("Item", `<span class="mono">${esc(p.item)}</span>`) +
      card("Task", t ? `#${t.id} ${esc(t.rules.name)}` : `#${p.task_id}`) + card("Asked", esc(when(p.created_ms))) +
      card("Agent's reason", p.reason ? `“${esc(p.reason)}”` : "none given") +
      card("Asked by", chain.length ? esc(["the owner's agent", ...chain.map((m) => m.name).reverse()].join(" → ")) : "an agent key the owner issued") +
      (p.result_hash ? card("Delivery hash", `<span class="mono">${esc(p.result_hash.slice(0, 24))}…</span>`) : "");

    if (!t) throw new Error("The task for this decision could not be read.");
    const r = t.rules, price = BigInt(p.price);
    const hay = norm(p.item) + "|" + norm(p.category) + "|" + norm(p.description);
    const hit = r.blocked_terms.find((term) => norm(term) && hay.includes(norm(term)));
    const zero = p.status === "Reused";
    const checks = [
      ["Seller is registered and on the task's list", !!seller && (!r.allowed_sellers.length || r.allowed_sellers.includes(p.seller)), "SELLER_UNKNOWN / SELLER_NOT_ALLOWED", seller ? `${p.seller} is ${r.allowed_sellers.includes(p.seller) || !r.allowed_sellers.length ? "" : "not "}on the list.` : "Not a registered seller."],
      ["Category serves the task", !r.categories.length || r.categories.includes(p.category), "INTENT_MISMATCH", `"${p.category}" against allowed: ${r.categories.join(", ") || "any"}.`],
      ["No blocked term, after decoding disguises", !hit, "INTENT_MISMATCH", hit ? `The item decodes to contain "${hit}".` : `Checked against: ${r.blocked_terms.join(", ") || "none"}.`],
      ["Price is within the per-purchase limit", zero || price <= BigInt(r.max_per_purchase), "OVER_PURCHASE_LIMIT", `${usdc(p.price)} against a limit of ${usdc(r.max_per_purchase)}.`],
      ["Price is below the owner-approval line", zero || price <= BigInt(r.approval_above), "NEEDS_APPROVAL", `${usdc(p.price)} against a line of ${usdc(r.approval_above)}. Above it, only the owner can approve.`],
    ];
    const failed = checks.filter((c) => !c[1]);
    $("rChecks").innerHTML = checks.map((c, i) => `<div class="attack ${c[1] ? "" : "stopped"}"><div class="n mono">${i + 1}</div>
      <div class="t"><b>${esc(c[0])}</b><span>${esc(c[3])}</span><div class="res"><span class="chip ${c[1] ? "ok" : "bad"}">${c[1] ? "✓ passes" : "✗ fails"}</span>${c[1] ? "" : ` <span class="mono">${esc(c[2])}</span>`}</div></div></div>`).join("");
    const agrees = failed.length ? failed.some((c) => c[2].includes(p.code)) || !["Escrowed", "Paid", "Delivered", "PayoutPending", "Reused"].includes(p.status) : true;
    $("rNote").innerHTML = `<span class="chip ${agrees ? "ok" : "warn"}">${agrees ? "✓ the vault's decision agrees with these checks" : "these checks and the vault's decision differ"}</span> ` +
      (p.mandate_version !== t.version ? `The rules have changed since (decided under version ${p.mandate_version}, now ${t.version}), so a difference can be expected. ` : "") +
      `The vault also checked things only it can see at that moment: the seller's signature on the quote, that the quote was unused and unexpired, the budget left, the hourly limit${chain.length ? ", and every sub-mandate above this agent" : ""}. A refusal for one of those shows its own code above.`;

    const mine = log.filter((e) => e.purchase_id === p.id);
    const rows = await Promise.all(mine.map(async (e) => {
      const ok = (await sha256hex(`${e.seq}|${e.at_ms}|${e.kind}|${e.purchase_id ?? "-"}|${e.code}|${e.prev_hash}`)) === e.hash;
      return `<tr><td>${e.seq}</td><td>${esc(when(e.at_ms))}</td><td>${esc(e.kind)}</td><td class="mono">${esc(e.code)}</td><td class="mono muted">${esc(e.hash.slice(0, 16))}…</td><td><span class="chip ${ok ? "ok" : "bad"}">${ok ? "✓ matches" : "✗ differs"}</span></td></tr>`;
    }));
    $("rLog").innerHTML = rows.join("") || `<tr><td colspan="6" class="muted">No log entries.</td></tr>`;
    $("rChain").innerHTML = `<span class="chip ${chainOk ? "ok" : "bad"}">${chainOk ? "✓" : "✗"} the contract re-verified its whole log (${log.length} entries)</span> Each entry's hash covers the one before it, so none can be changed or removed without breaking the chain. <a href="${explorer}/address/${esc(cfg.vault)}" target="_blank" rel="noopener">See the vault's transactions</a>.`;
  } catch (e) {
    $("rTitle").textContent = "Receipt not available";
    $("rSub").textContent = String((e && e.message) || e);
  }
})();
