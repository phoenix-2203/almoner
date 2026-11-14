# Demo video

The demo video is built from four things, all in this folder:

| Part | Made by | Kept in git |
| --- | --- | --- |
| Narration (voice `bm_george`, Kokoro, offline) | `tts.py` from `narration.json` | `audio/*.wav`, `audio/*.json` |
| Animated title and diagram cards (rendered frame by frame, so motion is exact) | `cards/render.cjs` from `cards/cards.html` | `cards/*.mp4` |
| Live footage of the real site on NEAR testnet, light theme | `record.cjs` (Playwright driving the page, frames taken from the browser's screencast) | `raw/*.json` (timing marks and what was observed); the `.mp4` clips are not committed |
| Music bed (generated, no samples) | `music.py` | `music.mp3` |

`assemble.py` cuts them together with ffmpeg: each scene lasts as long as its narration plus a short beat. Footage always plays at real speed; where a shot is longer than its scene, the waiting in the middle is cut with a dissolve. Subtitles are burned in. The target is under 2:20, the limit for video on X without Premium.

```bash
npm install && npx playwright install chromium   # once
node record.cjs                                  # records attack, sandbox, term (about 5 minutes)
python3 assemble.py                              # -> out/almoner-final-demo.mp4 and out/almoner-demo.srt
```

What is real: every browser shot is the public site driven by Playwright with real testnet transactions and a real language model; nothing in a shot is re-ordered or sped up. The waiting inside long shots, and the waits between chat messages, are cut. `raw/team.txt` is the unedited output of `npm run team`, replayed line by line in a terminal window. The cards are illustrations, not footage. If the footage was recorded against anything but the live site, the video is stamped "SIMULATED PREVIEW".
