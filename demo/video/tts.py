#!/usr/bin/env python3
"""Narration for the demo video. Each scene is synthesised in ONE pass with Kokoro (82M, offline, voice
bm_george), so the intonation flows across sentences instead of sounding stitched. Subtitle times come from the
sentence boundaries: each sentence's share of the scene is predicted from its length when read alone, then
snapped to the nearest pause in the audio. Writes audio/<scene>.wav and audio/<scene>.json ([start, end, sentence]).
Model files: github.com/thewh1teagle/kokoro-onnx releases (model-files-v1.0); set KOKORO_DIR to their folder.
The generated audio is committed, so this only needs re-running if narration.json changes."""
import json, os, re, sys
import numpy as np, soundfile as sf
from kokoro_onnx import Kokoro

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.environ.get("KOKORO_DIR", ".")
VOICE, SPEED = os.environ.get("VOICE", "bm_george"), float(os.environ.get("SPEED", "0.92"))
# Spellings the voice reads correctly; subtitles keep the real words.
SAY = {"Almoner": "Ahmoner", "testnet": "test net", "on-chain": "on chain", "MCP": "M C P", "SDK": "S D K"}
k = Kokoro(os.path.join(D, "kokoro-v1.0.onnx"), os.path.join(D, "voices-v1.0.bin"))
say = lambda s: re.sub("|".join(map(re.escape, SAY)), lambda m: SAY[m.group(0)], s)

def pauses(a, sr, thr=0.012, min_len=0.10):
    hop = int(sr * 0.01)
    quiet = np.array([np.sqrt(np.mean(a[i:i + hop] ** 2)) for i in range(0, len(a) - hop, hop)]) < thr
    out, s = [], None
    for i, q in enumerate(quiet):
        if q and s is None: s = i
        if not q and s is not None:
            if (i - s) * 0.01 >= min_len: out.append((s * 0.01, i * 0.01))
            s = None
    return out

total = 0
for name, text in json.load(open(os.path.join(HERE, "narration.json"))):
    sentences = [s.strip() for s in re.split(r"(?<=[.?!])\s+", text) if s.strip()]
    a, sr = k.create(say(text), voice=VOICE, speed=SPEED, lang="en-gb")
    nz = np.where(np.abs(a) > 0.008)[0]
    a = a[max(0, nz[0] - 1200): nz[-1] + 6000]
    d = len(a) / sr
    solo = np.array([len(k.create(say(s), voice=VOICE, speed=SPEED, lang="en-gb")[0]) for s in sentences], dtype=float)
    cuts = np.cumsum(solo)[:-1] / solo.sum() * d
    ps = [p for p in pauses(a, sr) if 0.25 < p[0] < d - 0.25]
    spans, start = [], 0.0
    for i, s in enumerate(sentences):
        if i < len(cuts):
            near = min(ps, key=lambda p: abs((p[0] + p[1]) / 2 - cuts[i]), default=None)
            end, nxt = (near[0], near[1]) if near and abs((near[0] + near[1]) / 2 - cuts[i]) < 0.9 else (cuts[i], cuts[i])
        else:
            end, nxt = d - 0.2, d
        spans.append([round(start, 2), round(max(end, start + 0.4), 2), s])
        start = nxt
    sf.write(os.path.join(HERE, "audio", name + ".wav"), a, sr, subtype="PCM_16")
    json.dump(spans, open(os.path.join(HERE, "audio", name + ".json"), "w"), indent=1)
    total += d
    print(f"{name:12s} {d:5.1f}s  " + " | ".join(f"{x[0]}-{x[1]}" for x in spans), file=sys.stderr)
print(f"total narration {total:.1f}s", file=sys.stderr)
