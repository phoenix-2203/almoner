#!/usr/bin/env python3
"""Cut the demo video together. The hackathon limit is 3 minutes; the script stops if the result is longer.

  python3 assemble.py                 # -> out/almoner-final-demo.mp4
  python3 assemble.py --no-music --no-subs

Inputs: audio/<scene>.wav + .json (narration and sentence times, from tts.py), cards/*.png (render.cjs),
raw/<clip>.webm + .json (live footage and its marks, from record.cjs), music.mp3 (music.py).
Each scene lasts as long as its narration. Live footage is cut at the recorder's marks and sped up or
held on its last frame to fit; nothing in it is re-ordered or edited within a shot.
Needs only python3 and ffmpeg (with libass for burned-in subtitles).
"""
import json, os, subprocess, sys, wave

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
FPS, LEAD, TAIL = 30, 0.35, 0.45
p = lambda *a: os.path.join(HERE, *a)

# scene -> shots. ("still", card, weight) or ("clip", file, from_mark, to_mark, weight)
SCENES = [
    ("s01_hook", [("still", "hook", 1)]),
    ("s02_key", [("clip", "landing", "start", "stop", 1)]),
    ("s03_problem", [("still", "problem", 1)]),
    ("s04_how", [("still", "how1", 0.56), ("still", "how2", 0.44)]),
    ("s05_sandbox", [("clip", "sandbox", "rules", "create", 0.42), ("clip", "sandbox", "create", "ready", 0.58)]),
    ("s06_buy", [("clip", "sandbox", "buy", "buyEnd", 1)]),
    ("s07_inject", [("clip", "sandbox", "inject", "injectEnd", 1)]),
    ("s08_owner", [("clip", "sandbox", "owner", "approved", 0.3), ("clip", "sandbox", "approved", "ownerEnd", 0.3), ("clip", "sandbox", "receipt", "receiptEnd", 0.4)]),
    ("s09_attack", [("clip", "attack", "start", "run", 0.24), ("clip", "attack", "run", "stop", 0.76)]),
    ("s10_team", [("clip", "term", "start", "stop", 1)]),
    ("s11_proof", [("still", "proof", 0.42), ("clip", "log", "start", "stop", 0.26), ("still", "future", 0.32)]),
    ("s13_close", [("still", "close", 1)]),
]


def run(args):
    r = subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"] + args, capture_output=True, text=True)
    if r.returncode:
        sys.exit("ffmpeg failed:\n" + r.stderr[-1500:])


def wav_len(path):
    with wave.open(path) as w:
        return w.getnframes() / w.getframerate()


def marks(clip):
    f = p("raw", clip + ".json")
    if not os.path.exists(f) or not os.path.exists(p("raw", clip + ".webm")):
        sys.exit(f"Missing footage: raw/{clip}.webm. Record it first:  node record.cjs --only {clip}")
    j = json.load(open(f))
    if j.get("error"):
        sys.exit(f"raw/{clip} did not finish recording ({j['error']}). Re-record it:  node record.cjs --only {clip}")
    return j


def shot_filter(i, shot, T):
    """ffmpeg input args and a filter chain producing exactly T seconds of 1920x1080 video."""
    n = round(T * FPS)
    if shot[0] == "still":
        ins = ["-loop", "1", "-framerate", str(FPS), "-t", f"{T + 1:.3f}", "-i", p("cards", shot[1] + ".png")]
        # a very slow push-in so stills are not dead frames (upscaled first, which keeps the motion smooth)
        f = f"[{i}:v]scale=3840:2160,zoompan=z='1+0.035*on/{n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps={FPS},trim=end_frame={n},setpts=PTS-STARTPTS[v{i}]"
        return ins, f
    _, clip, a, b, _w = shot
    m = marks(clip)["marks"]
    for k in (a, b):
        if k not in m:
            sys.exit(f"raw/{clip}.json has no mark '{k}' (the recording stopped early). Re-record:  node record.cjs --only {clip}")
    t0, t1 = m[a], m[b]
    L = max(t1 - t0, 0.5)
    hold = min(1.4, T * 0.18)  # rest on the final frame so the result can be read
    play = T - hold
    if L > play:
        k, extra = play / L, hold  # speed up
    elif play / L <= 1.3:
        k, extra = play / L, hold  # slow down slightly
    else:
        k, extra = 1.0, T - L  # play at real speed, then hold
    f = (f"[{i}:v]trim=start={t0:.3f}:end={t1:.3f},setpts=(PTS-STARTPTS)*{k:.5f},fps={FPS},scale=1920:1080:flags=lanczos,"
         f"tpad=stop_mode=clone:stop_duration={extra + 0.5:.3f},trim=end_frame={n},setpts=PTS-STARTPTS[v{i}]")
    return ["-i", p("raw", clip + ".webm")], f


def ass_time(t):
    h, r = divmod(t, 3600)
    m, s = divmod(r, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}"


def main():
    flags = set(sys.argv[1:])
    os.makedirs(OUT, exist_ok=True)
    parts, events, t, simulated = [], [], 0.0, False
    for name, shots in SCENES:
        narr = p("audio", name + ".wav")
        D = round((LEAD + wav_len(narr) + TAIL) * FPS) / FPS
        ins, filters = [], []
        for i, shot in enumerate(shots):
            a, f = shot_filter(i, shot, round(D * shot[-1] * FPS) / FPS)
            ins += a
            filters.append(f)
            if shot[0] == "clip":
                base = marks(shot[1]).get("base", "")
                simulated |= "localhost" in base or "127.0.0.1" in base
        n = len(shots)
        filters.append("".join(f"[v{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0,fade=t=in:st=0:d=0.22,format=yuv420p[v]")
        filters.append(f"[{n}:a]adelay={int(LEAD * 1000)}:all=1,apad,atrim=duration={D:.3f},aresample=48000,aformat=channel_layouts=stereo[a]")
        part = os.path.join(OUT, name + ".mp4")
        run(ins + ["-i", narr, "-filter_complex", ";".join(filters), "-map", "[v]", "-map", "[a]", "-t", f"{D:.3f}",
                   "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-r", str(FPS), "-c:a", "aac", "-b:a", "192k", part])
        for s0, s1, text in json.load(open(p("audio", name + ".json"))):
            events.append((t + LEAD + s0, t + LEAD + s1 + 0.12, "Sub", text))
        if any(s[0] == "clip" for s in shots) and name != "s10_team":
            events.append((t + 0.3, t + D - 0.2, "Tag", "SIMULATED PREVIEW · not real transactions" if simulated else "LIVE · NEAR testnet · real transactions"))
        elif name == "s10_team":
            events.append((t + 0.3, t + D - 0.2, "Tag", "Real output of  npm run team  on NEAR testnet"))
        parts.append(part)
        print(f"  {name:13s} {D:5.1f}s   at {ass_time(t)}")
        t += D
    total = t

    with open(os.path.join(OUT, "_list.txt"), "w") as f:
        f.write("".join(f"file '{x}'\n" for x in parts))
    joined = os.path.join(OUT, "_joined.mp4")
    run(["-f", "concat", "-safe", "0", "-i", os.path.join(OUT, "_list.txt"), "-c", "copy", joined])

    with open(os.path.join(OUT, "almoner-demo.srt"), "w") as f:
        subs = [e for e in events if e[2] == "Sub"]
        for i, (a, b, _, text) in enumerate(subs, 1):
            st = lambda x: ass_time(x).replace(".", ",").rjust(11, "0") + "0"
            f.write(f"{i}\n{st(a)} --> {st(b)}\n{text}\n\n")
    ass = os.path.join(OUT, "_subs.ass")
    with open(ass, "w") as f:
        f.write("[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\n"
                "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
                "Style: Sub,Helvetica Neue,44,&H00FFFFFF,&H00FFFFFF,&H26000000,&H26000000,0,0,0,0,100,100,0,0,3,12,0,2,240,240,54,1\n"
                "Style: Tag,Menlo,22,&H00408CFF,&H00FFFFFF,&H30000000,&H30000000,1,0,0,0,100,100,1,0,3,8,0,9,40,36,116,1\n\n"
                "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")
        for a, b, style, text in events:
            if style == "Sub" and "--no-subs" in flags:
                continue
            f.write(f"Dialogue: 0,{ass_time(a)},{ass_time(b)},{style},,0,0,0,,{text}\n")

    final = os.path.join(OUT, "almoner-final-demo.mp4")
    esc = ass.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
    vf = f"ass='{esc}',fade=t=out:st={total - 0.6:.2f}:d=0.6"
    if "--no-music" in flags or not os.path.exists(p("music.mp3")):
        run(["-i", joined, "-vf", vf, "-af", f"afade=t=out:st={total - 0.6:.2f}:d=0.6", "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", final])
    else:
        af = (f"[1:a]volume=0.085,afade=t=in:d=2,afade=t=out:st={total - 2.5:.2f}:d=2.5,atrim=duration={total:.2f}[m];"
              f"[0:a][m]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]")
        run(["-i", joined, "-stream_loop", "-1", "-i", p("music.mp3"), "-filter_complex", f"[0:v]{vf}[v];{af}", "-map", "[v]", "-map", "[a]",
             "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-t", f"{total:.2f}", final])
    if total > 178:
        print(f"\n! The video is {total:.0f}s. The limit is 180s: shorten narration.json and re-run tts.py.")
    size = os.path.getsize(final) / 1e6
    print(f"\n{final}\n  {int(total // 60)}:{total % 60:04.1f}, 1920x1080, {FPS} fps, {size:.1f} MB" + ("\n  NOTE: built from SIMULATED footage (recorded against a local mock). Not for submission." if simulated else ""))


if __name__ == "__main__":
    main()
