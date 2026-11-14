#!/usr/bin/env node
/**
 * Records the live footage for the demo video. Real site, real NEAR testnet transactions, a real
 * language model: nothing is staged. Frames are captured losslessly-ish through the browser's own
 * screencast (sharp, about 30 fps) rather than Playwright's low-bitrate video, and the script writes
 * "marks" (seconds into each clip) that assemble.py uses to cut the footage.
 *
 *   node record.cjs                         # all clips, against https://almoner.duckdns.org
 *   node record.cjs --only sandbox          # re-record one
 *
 * Output: raw/<clip>.mp4 and raw/<clip>.json (marks + what was observed).
 * Needs: npm i playwright && npx playwright install chromium, and ffmpeg.
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg("base", "https://almoner.duckdns.org").replace(/\/$/, "");
const ONLY = arg("only", "attack,tamper,sandbox,term").split(",");
const MOCK = arg("mock", null); // test hook: a module that installs fake network routes
const GAP = Number(process.env.GAP_MS || 20000); // spacing between chat messages for the model provider's rate limit
const RAW = path.join(__dirname, "raw");
const W = 1920, H = 1080, ZOOM = 1.5; // the page is laid out as if 1280 wide, so text is large and sharp at 1080p
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const INIT = `(() => { const Z = ${ZOOM};
  try { localStorage.setItem("almoner-theme", "light"); } catch (e) {}
  const zoom = () => { if (document.documentElement) document.documentElement.style.zoom = Z; };
  zoom(); document.addEventListener("readystatechange", zoom);
  const c = document.createElement("div"); c.id = "__cur";
  c.style.cssText = "position:fixed;z-index:2147483647;left:-60px;top:-60px;width:26px;height:26px;margin:-3px 0 0 -3px;pointer-events:none;transition:transform .14s ease;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))";
  c.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2l15 9-6.5 1.6L16 20l-3 1.4-3.4-7.3L5 18z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  const add = () => { zoom(); document.documentElement.appendChild(c); };
  document.body ? add() : addEventListener("DOMContentLoaded", add);
  addEventListener("mousemove", (e) => { c.style.left = e.clientX / Z + "px"; c.style.top = e.clientY / Z + "px"; }, true);
  addEventListener("mousedown", () => { c.style.transform = "scale(.8)";
    const r = document.createElement("div");
    r.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;border:3px solid #f25c0a;border-radius:50%;width:18px;height:18px;left:" + (parseFloat(c.style.left) - 9) + "px;top:" + (parseFloat(c.style.top) - 9) + "px;transition:transform .5s ease-out,opacity .5s ease-out;opacity:.9";
    document.documentElement.appendChild(r); requestAnimationFrame(() => requestAnimationFrame(() => { r.style.transform = "scale(3.6)"; r.style.opacity = "0"; })); setTimeout(() => r.remove(), 560); }, true);
  addEventListener("mouseup", () => { c.style.transform = ""; }, true);
  // An eased scroll, so the page glides instead of jumping.
  window.__glide = (top, ms) => new Promise((done) => { const from = scrollY, to = Math.max(0, Math.min(top, document.documentElement.scrollHeight - innerHeight)), t0 = performance.now();
    const e = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (now) => { const k = Math.min(1, (now - t0) / ms); scrollTo(0, from + (to - from) * e(k)); k < 1 ? requestAnimationFrame(step) : done(); }; requestAnimationFrame(step); });
})();`;

async function clip(browser, name, fn) {
  if (!ONLY.includes(name)) return;
  console.log(`\n● recording ${name} …`);
  const dir = path.join(RAW, "_" + name);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({ viewport: { width: W, height: H }, colorScheme: "light" });
  if (MOCK) await require(path.resolve(MOCK))(context);
  await context.addInitScript(INIT);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const frames = []; // [file, timestamp]
  let first = null;
  cdp.on("Page.screencastFrame", (f) => {
    const file = path.join(dir, String(frames.length).padStart(6, "0") + ".jpg");
    fs.writeFileSync(file, Buffer.from(f.data, "base64"));
    if (first == null) first = f.metadata.timestamp;
    frames.push([file, f.metadata.timestamp]);
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 93, everyNthFrame: 1 });

  const marks = {}, seen = {};
  let pos = { x: W * 0.62, y: H * 0.55 };
  const now = () => (first == null ? 0 : Date.now() / 1000 - first);
  const api = {
    page, seen, wait: sleep,
    mark: (k) => { marks[k] = +now().toFixed(2); console.log(`   ${String(marks[k]).padStart(7)}s  ${k}`); },
    /** Glide so the element's top sits "offset" CSS px below the top of the window (centre it when offset is null). */
    async show(sel, offset = null, ms = 1100) {
      const top = await page.locator(sel).first().evaluate((el, [offset, Z]) => { const r = el.getBoundingClientRect(); const y = r.top / Z + scrollY / 1; const vh = innerHeight / Z; return offset == null ? y - (vh - r.height / Z) / 2 : y - offset; }, [offset, ZOOM]);
      await page.evaluate(([t, ms]) => window.__glide(t, ms), [top * 1, ms]);
      await sleep(250);
    },
    async moveTo(x, y) { const from = { ...pos }; const dist = Math.hypot(x - from.x, y - from.y); const steps = Math.max(18, Math.min(60, Math.round(dist / 22)));
      const bend = Math.min(60, dist * 0.12); // a slight arc, as a hand makes
      for (let i = 1; i <= steps; i++) { const k = ease(i / steps); const arc = Math.sin(Math.PI * k) * bend; await page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k - arc); await sleep(15); }
      pos = { x, y }; },
    async hover(sel) { const b = await page.locator(sel).first().boundingBox(); if (!b) return; await api.moveTo(b.x + Math.min(b.width / 2, 170 * ZOOM), b.y + b.height / 2); await sleep(220); },
    async click(sel, opts = {}) { const l = page.locator(sel).first(); await l.waitFor({ state: "visible", timeout: opts.timeout || 30000 });
      const b = await l.boundingBox(); if (!b || b.y < 110 * ZOOM || b.y + b.height > H - 60) await api.show(sel);
      await api.hover(sel); await sleep(260); await page.mouse.down(); await sleep(110); await page.mouse.up(); await sleep(350); },
  };
  let error = null;
  try { await fn(api); } catch (e) { error = String((e && e.message) || e).split("\n")[0]; console.log("   ✗ " + error); }
  await sleep(700);
  marks.end = +now().toFixed(2);
  await cdp.send("Page.stopScreencast").catch(() => {});
  await context.close();

  // Frames arrive only when the picture changes; give each its real duration and write a constant 30 fps file.
  if (frames.length > 1) {
    const list = path.join(dir, "list.txt");
    let txt = "";
    for (let i = 0; i < frames.length; i++) { const d = i + 1 < frames.length ? frames[i + 1][1] - frames[i][1] : 0.7; txt += `file '${frames[i][0]}'\nduration ${Math.max(d, 0.001).toFixed(4)}\n`; }
    txt += `file '${frames[frames.length - 1][0]}'\n`;
    fs.writeFileSync(list, txt);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", "fps=30,scale=1920:1080:flags=lanczos", "-c:v", "libx264", "-crf", "13", "-preset", "fast", "-pix_fmt", "yuv420p", path.join(RAW, name + ".mp4")]);
  } else error = error || "no frames were captured";
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(path.join(RAW, name + ".json"), JSON.stringify({ clip: name, base: BASE, recorded: new Date().toISOString(), frames: frames.length, error, marks, seen }, null, 2));
  console.log(error ? `   ✗ ${name} did not finish: re-record it (node record.cjs --only ${name})` : `   ✓ ${name}.mp4 (${marks.end}s, ${frames.length} frames)`);
}

(async () => {
  fs.mkdirSync(RAW, { recursive: true });
  const browser = await chromium.launch();

  // The published key, then six thefts signed with it.
  await clip(browser, "attack", async ({ page, mark, wait, hover, click, show, seen }) => {
    await page.goto(BASE + "/try.html", { waitUntil: "networkidle" });
    await page.waitForFunction(() => /^ed25519:/.test(document.getElementById("kKey").textContent), null, { timeout: 30000 });
    await show("#attack", 84, 900); await wait(500);
    mark("start");
    await click("#runAll"); mark("run");
    await show("#attacks", 150, 1400);
    await page.waitForFunction(() => document.querySelectorAll(".attack.stopped, .attack.through").length >= 4, null, { timeout: 120000 });
    mark("four");
    await page.waitForFunction(() => document.querySelectorAll(".attack.stopped, .attack.through").length === 6, null, { timeout: 180000 });
    seen.stopped = await page.locator(".attack.stopped").count();
    seen.through = await page.locator(".attack.through").count();
    seen.byNear = (await page.locator("#attacks").innerText()).split("blocked by the NEAR protocol").length - 1;
    await wait(500);
    await show("#atk5", null, 1300); await hover("#atk4 .res"); await wait(2600);
    mark("stop");
  });

  // The agent edits the price in a seller-signed quote. No AI involved: this is the shared shop on the Try it page.
  await clip(browser, "tamper", async ({ page, mark, wait, hover, click, show, seen }) => {
    await page.goto(BASE + "/try.html", { waitUntil: "networkidle" });
    await page.locator(".item-opt").first().waitFor({ state: "visible", timeout: 45000 });
    await show("#bench", 84, 1000); await wait(500); mark("start");
    await click("#shopQuote");
    await page.locator("#shopQuoteOut").waitFor({ state: "visible", timeout: 30000 });
    await page.waitForFunction(() => document.getElementById("shopQuoteJson").value.includes("signature"), null, { timeout: 30000 });
    await show("#shopQuoteJson", 130, 1100); await wait(700);
    await click("#shopQuoteJson"); mark("edit");
    seen.priceBefore = await page.evaluate(() => (document.getElementById("shopQuoteJson").value.match(/"price": "(\d+)"/) || [])[1]);
    await page.evaluate(() => { const t = document.getElementById("shopQuoteJson"); t.value = t.value.replace(/"price": "\d+"/, '"price": "1000"'); t.dispatchEvent(new Event("input", { bubbles: true }));
      const i = t.value.indexOf('"price"'); t.focus(); t.setSelectionRange(i, i + 15); t.style.transition = "box-shadow .3s"; t.style.boxShadow = "0 0 0 4px #f25c0a"; setTimeout(() => (t.style.boxShadow = ""), 1400); });
    seen.priceAfter = await page.evaluate(() => (document.getElementById("shopQuoteJson").value.match(/"price": "(\d+)"/) || [])[1]);
    if (seen.priceAfter !== "1000" || seen.priceBefore === "1000") throw new Error("the price in the quote was not edited");
    await wait(1900);
    await click("#shopBuy"); mark("ask");
    await page.waitForFunction(() => /chip/.test(document.getElementById("shopDecision").innerHTML), null, { timeout: 90000 });
    seen.tamper = /QUOTE_INVALID/.test(await page.locator("#shopDecision").innerText());
    await show("#shopDecision", null, 900); await wait(2800);
    mark("stop");
  });

  // A visitor's own vault, a real AI agent, and the owner's controls.
  await clip(browser, "sandbox", async ({ page, mark, wait, hover, click, show, seen }) => {
    const chatDone = async () => { await page.waitForFunction(() => !document.getElementById("chatSend").disabled, null, { timeout: 180000 }); await wait(900); };
    await page.goto(BASE + "/sandbox.html", { waitUntil: "networkidle" });
    await wait(600);
    await show("#rules", 96, 1000); mark("rules");
    await hover("#rBudget"); await wait(500); await hover("#rBlocked"); await wait(600);
    await click("#create"); mark("create");
    await page.locator("#live").waitFor({ state: "visible", timeout: 240000 });
    seen.vault = (await page.locator("#setupMsg .mono").first().innerText().catch(() => "")).trim();
    await wait(1800); mark("ready");

    const ask = async (i, key) => {
      await show("#chat .chatbox", 72, 1200); await wait(300);
      mark(key);
      await click(`#chips button[data-i="${i}"]`);
      // Follow the conversation: when its newest line drops towards the subtitle band, glide the page up.
      const follow = async (ms) => {
        const [bottom, y] = await page.locator("#msgs").evaluate((el, Z) => [el.getBoundingClientRect().bottom / Z, scrollY], ZOOM);
        if (bottom > 560) await page.evaluate(([t, ms]) => window.__glide(t, ms), [y + bottom - 500, ms]);
      };
      const until = Date.now() + 180000;
      while (await page.locator("#chatSend").isDisabled() && Date.now() < until) { await follow(700); await wait(350); }
      await chatDone();
      await page.locator("#msgs").evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }));
      await wait(400); await follow(900);
      await wait(1600);
      mark(key + "End");
      return page.locator("#msgs").innerText();
    };
    let t = await ask(0, "buy");
    seen.buyPaid = /Paid/.test(t); seen.buyApproved = /APPROVED/.test(t);
    await wait(GAP);
    t = await ask(1, "inject");
    seen.injectRefused = /REFUSED/.test(t) && /INTENT_MISMATCH/.test(t);
    await wait(GAP);
    t = await ask(3, "junk"); // the cheap seller delivers an empty file
    seen.junkRefunded = /Refunded/.test(t);
    await wait(GAP);
    t = await ask(2, "hold");
    seen.holdWaiting = /WAITING FOR THE OWNER/.test(t);

    await show("#owner", 96, 1300); await wait(500); mark("owner");
    if (await page.locator('#decisions button[data-act="approve"]').count()) {
      await click('#decisions button[data-act="approve"]');
      await page.waitForFunction(() => /Escrowed|APPROVED/.test(document.getElementById("ownerMsg").innerText), null, { timeout: 60000 });
      seen.approved = true;
    }
    await wait(1600); mark("approved");
    await click("#freeze");
    await page.waitForFunction(() => /frozen/i.test(document.getElementById("ownerMsg").innerText), null, { timeout: 60000 });
    seen.frozen = true; await wait(2000); mark("frozen");
    await click("#freeze"); // leave the vault live again
    await page.waitForFunction(() => /live again/i.test(document.getElementById("ownerMsg").innerText), null, { timeout: 60000 });
    await wait(500); mark("ownerEnd");

    // The receipt of the refused gift-card purchase.
    const href = await page.locator("#decisions .dec", { hasText: "INTENT_MISMATCH" }).first().locator("a", { hasText: "Receipt" }).getAttribute("href").catch(() => null);
    if (href) {
      await page.goto(new URL(href, page.url()).href, { waitUntil: "networkidle" });
      await wait(900); mark("receipt");
      await wait(400);
      await show("#rChecks .attack.stopped", 250, 1300); await wait(1800); // land on the failed check, clear of the subtitle; short enough to play uncut
      seen.receipt = /INTENT_MISMATCH/.test(await page.locator("#rChecks").innerText());
      mark("receiptEnd");
    }
  });

  // Real output of `npm run team`, saved to raw/team.txt, replayed line by line in a terminal window.
  await clip(browser, "term", async ({ page, mark, wait, seen }) => {
    const lines = fs.readFileSync(path.join(RAW, "team.txt"), "utf8").replace(/\s+$/, "").split("\n");
    seen.lines = lines.length;
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      html{zoom:1 !important}html,body{margin:0;height:100%;background:#f6f4ef;font:400 21px/1.6 "JetBrains Mono","SF Mono",Menlo,Consolas,monospace;color:#dedcd6}
      .win{position:absolute;inset:48px 76px 150px;background:#111112;border-radius:18px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 40px 80px -40px rgba(40,30,10,.55)}
      .bar{padding:14px 20px;border-bottom:1px solid #262628;color:#8a8882;font-size:17px;display:flex;gap:8px;align-items:center}.bar i{width:12px;height:12px;border-radius:50%;background:#3a3a3e}
      #out{padding:20px 28px;overflow:hidden;flex:1;white-space:pre-wrap}.l{opacity:0;transform:translateY(6px);transition:opacity .3s ease,transform .3s ease}.l.on{opacity:1;transform:none}
      .ok{color:#8fd18f}.no{color:#ff8a3d;font-weight:700}.h{color:#fff;font-weight:700}.d{color:#8a8882}</style>
      <div class="win"><div class="bar"><i></i><i></i><i></i>&nbsp; almoner/ts · NEAR testnet</div><div id="out"></div></div>`);
    await page.evaluate((lines) => { const o = document.getElementById("out");
      for (const t of lines) { const d = document.createElement("div"); d.className = "l" + (/^\d\./.test(t) || /^\$/.test(t) ? " h" : /^\s{5}/.test(t) ? " d" : "");
        d.innerHTML = (t || " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/(APPROVED[^(]*)/, '<span class="ok">$1</span>').replace(/(REFUSED[ A-Z_a-z]*)/, '<span class="no">$1</span>'); o.appendChild(d); } }, lines);
    await wait(400); mark("start");
    for (let i = 0; i < lines.length; i++) {
      await page.evaluate((i) => { const el = document.querySelectorAll(".l")[i]; el.classList.add("on"); const o = document.getElementById("out"); const over = el.offsetTop - o.offsetTop + el.offsetHeight - o.clientHeight + 60; if (over > 0) o.scrollTo({ top: over, behavior: "smooth" }); }, i);
      await wait(lines[i].trim() ? 500 : 210); // paced to last as long as its narration, so the shot never sits frozen
    }
    await wait(2200); mark("stop");
  });

  await browser.close();
  const bad = ONLY.filter((n) => { try { return JSON.parse(fs.readFileSync(path.join(RAW, n + ".json"))).error; } catch (e) { return true; } });
  console.log(bad.length ? `\nNot finished: ${bad.join(", ")}` : "\nAll clips recorded. Check raw/*.json (the \"seen\" values), then run: python3 assemble.py");
  process.exit(bad.length ? 1 : 0);
})();
