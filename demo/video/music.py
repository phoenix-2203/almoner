#!/usr/bin/env python3
"""A quiet, generated music bed (no samples, no licence to worry about): slow warm chords, soft attack.
Writes music.mp3. Only needs re-running to change the music; the result is committed."""
import numpy as np, subprocess, wave, os
SR, BAR, TOTAL = 44100, 8.0, 232.0
HERE = os.path.dirname(os.path.abspath(__file__))
chords = [[110.00, 164.81, 220.00, 261.63, 329.63], [87.31, 174.61, 220.00, 261.63, 349.23], [130.81, 196.00, 261.63, 329.63, 392.00], [98.00, 196.00, 246.94, 293.66, 392.00]]  # Am F C G
t = np.arange(int(SR * TOTAL)) / SR
out = np.zeros_like(t)
rng = np.random.default_rng(7)
for i in range(int(TOTAL / BAR) + 1):
    seg = (t >= i * BAR - 1.5) & (t < (i + 1) * BAR + 1.5)
    lt = t[seg] - i * BAR
    env = np.clip((lt + 1.5) / 3.0, 0, 1) * np.clip(((BAR + 1.5) - lt) / 3.0, 0, 1)  # 3 s cross-fades between chords
    env = np.sin(env * np.pi / 2) ** 2
    for j, f in enumerate(chords[i % 4]):
        for det, amp in ((0.0, 1.0), (0.35, 0.6), (-0.3, 0.6)):  # slight detune for width
            ph = rng.uniform(0, 2 * np.pi)
            w = np.sin(2 * np.pi * (f + det) * lt + ph) + 0.18 * np.sin(2 * np.pi * 2 * (f + det) * lt + ph)
            out[seg] += env * w * amp * (0.9 if j < 2 else 0.5) * (1 + 0.12 * np.sin(2 * np.pi * 0.11 * lt + j))
out /= np.max(np.abs(out)) * 1.6
with wave.open(os.path.join(HERE, "_music.wav"), "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((out * 32767).astype("<i2").tobytes())
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", os.path.join(HERE, "_music.wav"), "-af", "lowpass=f=1400,highpass=f=70,aecho=0.6:0.5:120|260:0.25|0.18", "-ac", "2", "-b:a", "112k", os.path.join(HERE, "music.mp3")], check=True)
os.remove(os.path.join(HERE, "_music.wav"))
print("music.mp3 written")
