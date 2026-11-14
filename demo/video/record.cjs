#!/usr/bin/env node
/**
 * Records the live footage for the demo video with Playwright. Real site, real NEAR testnet
 * transactions, a real language model: nothing is staged, so run-to-run timing varies and the
 * script writes "marks" (seconds into each clip) that assemble.py uses to cut the footage.
 *
 *   node record.cjs                         # all clips, against https://almoner.duckdns.org
 *   node record.cjs --only sandbox,attack   # re-record some
 *   node record.cjs --base http://localhost:3000
 *
 * Output: raw/<clip>.webm and raw/<clip>.json (marks + what was observed).
 * Needs: npm i playwright && npx playwright install chromium
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg("base", "https://almoner.duckdns.org").replace(/\/$/, "");
const ONLY = arg("only", "landing,sandbox,attack,log,term").split(",");
const MOCK = arg("mock", null); // test hook: a module that installs fake network routes
const RAW = path.join(__dirname, "raw");
const W = 1920, H = 1080, ZOOM = 1.5; // recorded at 1920x1080; the page is laid out as if 1280 wide, so text is large and sharp
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CURSOR = `(() => { const Z = 1.5; const zoom = () => { if (document.documentElement) document.documentElement.style.zoom = Z; }; zoom(); document.addEventListener("readystatechange", zoom); addEventListener("DOMContentLoaded", zoom); const c = document.createElement("div"); c.id = "__cur";
  c.style.cssText = "position:fixed;z-index:2147483647;left:-40px;top:-40px;width:22px;height:22px;margin:-4px 0 0 -4px;pointer-events:none;transition:transform .12s";
  c.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2l15 9-6.5 1.6L16 20l-3 1.4-3.4-7.3L5 18z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const add = () => { zoom(); document.documentElement.appendChild(c); }; document.body ? add() : addEventListener("DOMContentLoaded", add);
  addEventListener("mousemove", (e) => { c.style.left = e.clientX / Z + "px"; c.style.top = e.clientY / Z + "px"; }, true);
  addEventListener("mousedown", () => { c.style.transform = "scale(.75)"; const r = document.createElement("div");
    r.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;border:3px solid #ff6b1a;border-radius:50%;width:16px;height:16px;left:" + (parseFloat(c.style.left) - 8) + "px;top:" + (parseFloat(c.style.top) - 8) + "px;transition:all .45s ease-out;opacity:.9";
    document.documentElement.appendChild(r); requestAnimationFrame(() => { r.style.transform = "scale(4)"; r.style.opacity = "0"; }); setTimeout(() => r.remove(), 500); }, true);
  addEventListener("mouseup", () => { c.style.transform = ""; }, true);
  try { localStorage.setItem("almoner-theme", "dark"); } catch (e) {}
})();`;

async function clip(browser, name, fn) {
  if (!ONLY.includes(name)) return;
  console.log(`\n● recording ${name} …`);
  const tmp = path.join(RAW, "_" + name);
  fs.rmSync(tmp, { recursive: true, force: true });
  const context = await browser.newContext({ viewport: { width: W, height: H }, colorScheme: "dark", recordVideo: { dir: tmp, size: { width: W, height: H } } });
  if (MOCK) await require(path.resolve(MOCK))(context);
  await context.addInitScript(CURSOR);
  const page = await context.newPage();
  const t0 = Date.now();
  const marks = {}, seen = {};
  let pos = { x: W / 2, y: H / 2 };
  const api = {
    page, seen,
    mark: (k) => { marks[k] = +((Date.now() - t0) / 1000).toFixed(2); console.log(`   ${String(marks[k]).padStart(7)}s  ${k}`); },
    wait: sleep,
    async show(sel, block = "center") { await page.locator(sel).first().evaluate((el, b) => el.scrollIntoView({ behavior: "smooth", block: b }), block); await sleep(900); },
    async scrollBy(dy, ms = 1200) { await page.evaluate(([dy]) => window.scrollBy({ top: dy, behavior: "smooth" }), [dy]); await sleep(ms); },
    async hover(sel) { const b = await page.locator(sel).first().boundingBox(); if (!b) return; const x = b.x + Math.min(b.width / 2, 160 * ZOOM), y = b.y + b.height / 2; await page.mouse.move(x, y, { steps: 28 }); pos = { x, y }; await sleep(250); },
    async click(sel, opts = {}) { const l = page.locator(sel).first(); await l.waitFor({ state: "visible", timeout: opts.timeout || 30000 }); await l.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" })); await sleep(800); await api.hover(sel); await sleep(250); await page.mouse.down(); await sleep(90); await page.mouse.up(); await sleep(300); },
  };
  let error = null;
  try { await fn(api); } catch (e) { error = String(e && e.message || e).split("\n")[0]; console.log("   ✗ " + error); }
  await sleep(600);
  marks.end = +((Date.now() - t0) / 1000).toFixed(2);
  const video = page.video();
  await context.close();
  const out = path.join(RAW, name + ".webm");
  fs.rmSync(out, { force: true });
  fs.renameSync(await video.path(), out);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.writeFileSync(path.join(RAW, name + ".json"), JSON.stringify({ clip: name, base: BASE, recorded: new Date().toISOString(), error, marks, seen }, null, 2));
  console.log(error ? `   ✗ ${name} did not finish: re-record it (node record.cjs --only ${name})` : `   ✓ ${name}.webm (${marks.end}s)`);
}

(async () => {
  fs.mkdirSync(RAW, { recursive: true });
  const browser = await chromium.launch();

  await clip(browser, "landing", async ({ page, mark, wait, hover, scrollBy }) => {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await wait(1200); mark("start");
    await wait(2500);
    await hover(".keytag"); await wait(4500);
    await scrollBy(260, 1500); await wait(1800);
    mark("stop");
  });

  await clip(browser, "sandbox", async ({ page, mark, wait, hover, click, show, seen }) => {
    const chatDone = async () => { await page.waitForFunction(() => !document.getElementById("chatSend").disabled, null, { timeout: 180000 }); await wait(1200); };
    const chatText = () => page.locator("#msgs").innerText();
    await page.goto(BASE + "/sandbox.html", { waitUntil: "networkidle" });
    await wait(1000);
    await show("#rules", "start"); mark("rules");
    for (const id of ["#rBudget", "#rMax", "#rApprove", "#rBlocked"]) { await hover(id); await wait(650); }
    await click("#create"); mark("create");
    await page.locator("#live").waitFor({ state: "visible", timeout: 240000 });
    seen.vault = (await page.locator("#setupMsg .mono").first().innerText().catch(() => "")).trim();
    await wait(1500); mark("ready");

    const ask = async (i, key) => {
      await show("#chat .chatbox", "center");
      mark(key);
      await click(`#chips button[data-i="${i}"]`);
      await page.locator("#chat .chatbox").evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
      await chatDone();
      mark(key + "End");
      return chatText();
    };
    let t = await ask(0, "buy");
    seen.buyPaid = /Paid/.test(t); seen.buyApproved = /APPROVED/.test(t);
    await wait(Number(process.env.GAP_MS || 20000)); // spacing for the model provider's rate limit; cut out in the edit
    t = await ask(1, "inject");
    seen.injectRefused = /REFUSED/.test(t) && /INTENT_MISMATCH/.test(t);
    await wait(Number(process.env.GAP_MS || 20000));
    t = await ask(2, "hold");
    seen.holdWaiting = /WAITING FOR THE OWNER/.test(t);

    await show("#owner", "start"); await wait(800); mark("owner");
    if (await page.locator('#decisions button[data-act="approve"]').count()) {
      await click('#decisions button[data-act="approve"]');
      await page.waitForFunction(() => /Escrowed|APPROVED/.test(document.getElementById("ownerMsg").innerText), null, { timeout: 60000 });
      seen.approved = true;
    }
    await wait(1500); mark("approved");
    await click("#freeze");
    await page.waitForFunction(() => /frozen/i.test(document.getElementById("ownerMsg").innerText), null, { timeout: 60000 });
    seen.frozen = true; await wait(2200); mark("frozen");
    await click("#freeze");
    await page.waitForFunction(() => /live again/i.test(document.getElementById("ownerMsg").innerText), null, { timeout: 60000 });
    await wait(800); mark("ownerEnd");

    // The receipt of the refused gift-card purchase.
    const href = await page.locator("#decisions .dec", { hasText: "INTENT_MISMATCH" }).first().locator("a", { hasText: "Receipt" }).getAttribute("href").catch(() => null);
    if (href) {
      await page.goto(new URL(href, page.url()).href, { waitUntil: "networkidle" });
      await wait(1500); mark("receipt");
      await wait(2500);
      await show("#rChecks", "start"); await wait(4500);
      seen.receipt = /INTENT_MISMATCH/.test(await page.locator("#rChecks").innerText());
      mark("receiptEnd");
    }
  });

  await clip(browser, "attack", async ({ page, mark, wait, hover, click, show, seen }) => {
    await page.goto(BASE + "/try.html", { waitUntil: "networkidle" });
    await page.waitForFunction(() => /^ed25519:/.test(document.getElementById("kKey").textContent), null, { timeout: 30000 });
    await show("#keycard", "center"); mark("start");
    await hover("#kKey"); await wait(3500);
    await show("#attack", "start"); await wait(600);
    await click("#runAll"); mark("run");
    await page.locator("#attack").evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "start" }));
    await page.waitForFunction(() => document.querySelectorAll(".attack.stopped, .attack.through").length === 6, null, { timeout: 180000 });
    seen.stopped = await page.locator(".attack.stopped").count();
    seen.through = await page.locator(".attack.through").count();
    seen.byNear = (await page.locator("#attacks").innerText()).split("blocked by the NEAR protocol").length - 1;
    await wait(700);
    await page.evaluate(() => window.scrollBy({ top: 200, behavior: "smooth" })); await wait(3200);
    mark("stop");
  });

  await clip(browser, "log", async ({ page, mark, wait, show, seen }) => {
    await page.goto(BASE + "/try.html", { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.getElementById("logcheck").innerText.length > 10, null, { timeout: 45000 });
    await show("#purchases", "start"); mark("start"); await wait(3500);
    await show("#logcheck", "start"); await wait(4500);
    seen.chain = (await page.locator("#logcheck").innerText()).replace(/\s+/g, " ").trim();
    mark("stop");
  });

  await clip(browser, "term", async ({ page, mark, wait, seen }) => {
    // Real output of `npm run team`, saved to raw/team.txt, replayed line by line in a terminal window.
    const lines = fs.readFileSync(path.join(RAW, "team.txt"), "utf8").replace(/\s+$/, "").split("\n");
    seen.lines = lines.length;
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      html{zoom:1 !important}html,body{margin:0;height:100%;background:#0a0a0b;font:400 21px/1.6 "JetBrains Mono","SF Mono",Menlo,Consolas,monospace;color:#dedcd6}
      .win{position:absolute;inset:44px 70px 170px;background:#060607;border:1px solid #232326;border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
      .bar{padding:14px 20px;border-bottom:1px solid #1f1f22;color:#7e7c76;font-size:17px;display:flex;gap:8px;align-items:center}.bar i{width:11px;height:11px;border-radius:50%;background:#2e2e32}
      #out{padding:20px 28px;overflow:hidden;flex:1;white-space:pre-wrap}.l{opacity:0;transition:opacity .25s}.l.on{opacity:1}
      .ok{color:#8fd18f}.no{color:#ff8a3d;font-weight:700}.h{color:#fff;font-weight:700}.d{color:#7e7c76}</style>
      <div class="win"><div class="bar"><i></i><i></i><i></i>&nbsp; almoner/ts — NEAR testnet</div><div id="out"></div></div>`);
    await page.evaluate((lines) => { const o = document.getElementById("out");
      for (const t of lines) { const d = document.createElement("div"); d.className = "l" + (/^\d\./.test(t) || /^\$/.test(t) ? " h" : /^\s{5}/.test(t) ? " d" : "");
        d.innerHTML = (t || " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/(APPROVED[^(]*)/, '<span class="ok">$1</span>').replace(/(REFUSED[ A-Z_a-z]*)/, '<span class="no">$1</span>'); o.appendChild(d); } }, lines);
    mark("start");
    for (let i = 0; i < lines.length; i++) {
      await page.evaluate((i) => { const el = document.querySelectorAll(".l")[i]; el.classList.add("on"); const o = document.getElementById("out"); const over = el.offsetTop - o.offsetTop + el.offsetHeight - o.clientHeight + 60; if (over > 0) o.scrollTo({ top: over, behavior: "smooth" }); }, i);
      await wait(lines[i].trim() ? 430 : 180);
    }
    await wait(2500); mark("stop");
  });

  await browser.close();
  const bad = ONLY.filter((n) => { try { return JSON.parse(fs.readFileSync(path.join(RAW, n + ".json"))).error; } catch (e) { return true; } });
  console.log(bad.length ? `\nNot finished: ${bad.join(", ")}` : "\nAll clips recorded. Check raw/*.json (the \"seen\" values), then run: python3 assemble.py");
  process.exit(bad.length ? 1 : 0);
})();
