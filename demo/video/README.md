# Demo video

The demo video is built from four things, all in this folder:

| Part | Made by | Kept in git |
| --- | --- | --- |
| Narration (voice `bm_george`, Kokoro, offline) | `tts.py` from `narration.json` | `audio/*.wav`, `audio/*.json` |
| Title and diagram cards | `cards/render.cjs` from `cards/cards.html` | `cards/*.png` |
| Live footage of the real site on NEAR testnet | `record.cjs` (Playwright) | `raw/*.json` (timing marks and what was observed); the `.webm` files are not committed |
| Music bed (generated, no samples) | `music.py` | `music.mp3` |

`assemble.py` cuts them together with ffmpeg: each scene lasts as long as its narration, footage is cut at the recorder's marks and sped up or held to fit, subtitles are burned in.

```bash
npm install && npx playwright install chromium   # once
node record.cjs                                  # records landing, sandbox, attack, log, term (about 6 minutes)
python3 assemble.py                              # -> out/almoner-final-demo.mp4 and out/almoner-demo.srt
```

What is real: every browser shot is the public site driven by Playwright with real testnet transactions and a real language model; nothing in a shot is re-ordered. Shots are sped up to fit the narration, and the waits between chat messages are cut. `raw/team.txt` is the unedited output of `npm run team`, replayed line by line in a terminal window. The cards are illustrations, not footage. If the footage was recorded against anything but the live site, the video is stamped "SIMULATED PREVIEW".
