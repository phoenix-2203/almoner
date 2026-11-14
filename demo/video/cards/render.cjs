// Render each animated card to a short, perfectly smooth 30 fps video, frame by frame:  node cards/render.cjs
// The opening card shows the challenge key that is already published in ../../../challenge.json.
const { chromium } = require("playwright"); const path = require("path"); const fs = require("fs"); const { execFileSync } = require("child_process");
const FPS = 30;
(async () => {
  const cj = [process.env.CHALLENGE_JSON, path.join(__dirname, "../../../challenge.json")].find((f) => f && fs.existsSync(f));
  const key = cj ? JSON.parse(fs.readFileSync(cj, "utf8")).agentPrivateKey : "";
  if (!key) console.log("! challenge.json not found: the opening card will not show the key");
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  for (const c of ["open", "title", "how", "close"]) {
    await p.goto("file://" + path.join(__dirname, "cards.html") + "?c=" + c + "&key=" + encodeURIComponent(key));
    await p.evaluate(() => document.fonts.ready);
    const dur = Number(await p.locator("#" + c).getAttribute("data-dur"));
    const dir = path.join(__dirname, "_" + c); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
    const n = Math.round(dur * FPS);
    for (let i = 0; i <= n; i++) { await p.evaluate((t) => window.seek(t), i / FPS); await p.screenshot({ path: path.join(dir, String(i).padStart(4, "0") + ".png") }); }
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(dir, "%04d.png"), "-c:v", "libx264", "-crf", "12", "-preset", "slow", "-pix_fmt", "yuv420p", path.join(__dirname, c + ".mp4")]);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(c + ".mp4", dur + "s");
  }
  await b.close();
})();
