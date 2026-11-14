// Render each title card to a 1920x1080 PNG:  node render.cjs
const { chromium } = require("playwright"); const path = require("path");
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  for (const c of ["hook", "problem", "how1", "how2", "proof", "future", "close"]) { await p.goto("file://" + path.join(__dirname, "cards.html") + "?c=" + c); await p.waitForTimeout(400); await p.screenshot({ path: path.join(__dirname, c + ".png") }); }
  await b.close(); })();
