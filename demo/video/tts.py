#!/usr/bin/env python3
"""Narration for the demo video. Each sentence is synthesised with Kokoro (82M, offline, voice bm_george)
and joined with short pauses, so subtitle times are exact. Writes audio/<scene>.wav and audio/<scene>.json
([start, end, sentence]). Model files: github.com/thewh1teagle/kokoro-onnx releases (model-files-v1.0);
set KOKORO_DIR to their folder. The generated audio is committed, so this only needs re-running if the script changes."""
import json, os, re, sys
import numpy as np, soundfile as sf
from kokoro_onnx import Kokoro

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.environ.get("KOKORO_DIR", ".")
VOICE, SPEED, GAP = os.environ.get("VOICE", "bm_george"), float(os.environ.get("SPEED", "1.0")), 0.30
# Spellings the voice reads correctly; subtitles keep the real words.
SAY = {"Almoner": "Ahmoner", "testnet": "test net", "mainnet": "main net", "on-chain": "on chain", "MCP": "M C P", "re-checked": "re checked", "re-verified": "re verified"}
k = Kokoro(os.path.join(D, "kokoro-v1.0.onnx"), os.path.join(D, "voices-v1.0.bin"))
total = 0
for name, text in json.load(open(os.path.join(HERE, "narration.json"))):
    spans, parts, t = [], [], 0.0
    for s in [x.strip() for x in re.split(r"(?<=[.?!])\s+", text) if x.strip()]:
        say = s
        for a, b in SAY.items(): say = say.replace(a, b)
        a, sr = k.create(say, voice=VOICE, speed=SPEED, lang="en-gb")
        nz = np.where(np.abs(a) > 0.008)[0]
        a = a[max(0, nz[0] - 600): nz[-1] + 2400]
        d = len(a) / sr
        spans.append([round(t, 2), round(t + d, 2), s])
        parts += [a, np.zeros(int(sr * GAP), dtype=a.dtype)]
        t += d + GAP
    audio = np.concatenate(parts[:-1])
    sf.write(os.path.join(HERE, "audio", name + ".wav"), audio, sr)
    json.dump(spans, open(os.path.join(HERE, "audio", name + ".json"), "w"), indent=1)
    total += len(audio) / sr
    print(f"{name:14s} {len(audio)/sr:5.1f}s", file=sys.stderr)
print(f"total narration {total:.1f}s", file=sys.stderr)
