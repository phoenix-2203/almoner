#!/usr/bin/env python3
"""Cut the demo video together.

  python3 assemble.py                 # -> out/almoner-final-demo.mp4 (+ out/almoner-demo.srt)
  python3 assemble.py --no-music --no-subs

Inputs: audio/<scene>.wav + .json (narration and sentence times, from tts.py), cards/*.mp4 (animated cards,
from cards/render.cjs), raw/<clip>.mp4 + .json (live footage and its marks, from record.cjs), music.mp3.

Each scene lasts as long as its narration plus a short beat. Live footage always plays at real speed: when a
shot is longer than its scene, the middle (waiting) is cut with a short dissolve, so the action that starts a
step and the result that ends it are both seen as they happened. Needs python3 and ffmpeg with libass.
The target is under 2:20, the limit for video on X without Premium; the script warns if the result is longer.
"""
import json, os, subprocess, sys, wave

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
FPS, LEAD, XF, LIMIT = 30, 0.45, 0.4, 140
BG = "0xf6f4ef"
p = lambda *a: os.path.join(HERE, *a)

# (scene, shots, beat): shots are ("card", name, weight) or ("clip", file, from_mark, to_mark, weight);
# beat = seconds the picture runs on after the narration ends.
SCENES = [
    ("s01_open", [("card", "open", 1)], 0.7),
    ("s02_attack", [("clip", "attack", "start", "stop", 1)], 1.6),
    ("s03_title", [("card", "title", 1)], 0.7),
    ("s04_how", [("card", "how", 1)], 0.7),
    ("s05_sandbox", [("clip", "sandbox", "rules", "ready", 1)], 0.9),
    ("s06_buy", [("clip", "sandbox", "buy", "buyEnd", 1)], 1.8),
    ("s07_inject", [("clip", "sandbox", "inject", "injectEnd", 1)], 2.0),
    ("s08_owner", [("clip", "sandbox", "owner", "approved", 0.32), ("clip", "sandbox", "approved", "frozen", 0.3), ("clip", "sandbox", "receipt", "receiptEnd", 0.38)], 1.0),
    ("s09_team", [("clip", "term", "start", "stop", 1)], 1.6),
    ("s10_close", [("card", "close", 1)], 1.6),
]


def run(args):
    r = subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"] + args, capture_output=True, text=True)
    if r.returncode:
        sys.exit("ffmpeg failed:\n" + r.stderr[-1800:])


def wav_len(path):
    with wave.open(path) as w:
        return w.getnframes() / w.getframerate()


def meta(clip):
    f = p("raw", clip + ".json")
    if not os.path.exists(f) or not os.path.exists(p("raw", clip + ".mp4")):
        sys.exit(f"Missing footage: raw/{clip}.mp4. Record it first:  node record.cjs --only {clip}")
    j = json.load(open(f))
    if j.get("error"):
        sys.exit(f"raw/{clip} did not finish recording ({j['error']}). Re-record it:  node record.cjs --only {clip}")
    return j


def shot(k, s, T):
    """Returns (input args, filter text, inputs used) for exactly T seconds of 1920x1080 video labelled [v{k}]."""
    n = round(T * FPS)
    fit = f"tpad=stop_mode=clone:stop_duration={T + 1:.2f},trim=end_frame={n},setpts=PTS-STARTPTS"
    if s[0] == "card":
        return ["-i", p("cards", s[1] + ".mp4")], lambda i: f"[{i}:v]fps={FPS},{fit}[v{k}]", 1
    _, clip, a, b, _w = s
    m = meta(clip)["marks"]
    for key in (a, b):
        if key not in m:
            sys.exit(f"raw/{clip}.json has no mark '{key}' (the recording stopped early). Re-record:  node record.cjs --only {clip}")
    t0, t1 = m[a], m[b]
    L = t1 - t0
    src = p("raw", clip + ".mp4")
    if L <= T + 0.2:  # short enough: play it all, then rest on the last frame
        return ["-ss", f"{t0:.3f}", "-t", f"{L:.3f}", "-i", src], lambda i: f"[{i}:v]fps={FPS},setpts=PTS-STARTPTS,{fit}[v{k}]", 1
    head = max(1.6, T * 0.36)
    tail = T - head + XF
    ins = ["-ss", f"{t0:.3f}", "-t", f"{head:.3f}", "-i", src, "-ss", f"{t1 - tail:.3f}", "-t", f"{tail:.3f}", "-i", src]
    f = lambda i: (f"[{i}:v]fps={FPS},settb=AVTB,setpts=PTS-STARTPTS[h{k}];[{i + 1}:v]fps={FPS},settb=AVTB,setpts=PTS-STARTPTS[t{k}];"
                   f"[h{k}][t{k}]xfade=transition=fade:duration={XF}:offset={head - XF:.3f},{fit}[v{k}]")
    return ins, f, 2


def ass_time(t):
    h, r = divmod(t, 3600)
    m, s = divmod(r, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}"


def main():
    flags = set(sys.argv[1:])
    os.makedirs(OUT, exist_ok=True)
    parts, events, t, simulated = [], [], 0.0, False
    for name, shots, beat in SCENES:
        narr = p("audio", name + ".wav")
        D = round((LEAD + wav_len(narr) + beat) * FPS) / FPS
        ins, filters, i = [], [], 0
        left = round(D * FPS)
        for k, s in enumerate(shots):
            n = left if k == len(shots) - 1 else round(D * s[-1] * FPS)
            left -= n
            a, f, used = shot(k, s, n / FPS)
            ins += a
            filters.append(f(i))
            i += used
            if s[0] == "clip":
                base = meta(s[1]).get("base", "")
                simulated |= "localhost" in base or "127.0.0.1" in base
        filters.append("".join(f"[v{k}]" for k in range(len(shots))) + f"concat=n={len(shots)}:v=1:a=0,fade=t=in:st=0:d=0.25:color={BG},format=yuv420p[v]")
        filters.append(f"[{i}:a]adelay={int(LEAD * 1000)}:all=1,apad,atrim=duration={D:.3f},aresample=48000,aformat=channel_layouts=stereo[a]")
        part = os.path.join(OUT, name + ".mp4")
        run(ins + ["-i", narr, "-filter_complex", ";".join(filters), "-map", "[v]", "-map", "[a]", "-t", f"{D:.3f}",
                   "-c:v", "libx264", "-preset", "veryfast", "-crf", "15", "-r", str(FPS), "-c:a", "aac", "-b:a", "192k", part])
        for s0, s1, text in json.load(open(p("audio", name + ".json"))):
            events.append((t + LEAD + s0, t + LEAD + s1 + 0.15, "Sub", text))
        if name == "s09_team":
            events.append((t + 0.3, t + D - 0.15, "Tag", "Real output of  npm run team  on NEAR testnet"))
        elif any(s[0] == "clip" for s in shots):
            events.append((t + 0.3, t + D - 0.15, "Tag", "SIMULATED PREVIEW · not real transactions" if simulated else "LIVE · NEAR testnet · real transactions"))
        parts.append(part)
        print(f"  {name:12s} {D:5.1f}s   at {ass_time(t)}")
        t += D
    total = t

    with open(os.path.join(OUT, "_list.txt"), "w") as f:
        f.write("".join(f"file '{x}'\n" for x in parts))
    joined = os.path.join(OUT, "_joined.mp4")
    run(["-f", "concat", "-safe", "0", "-i", os.path.join(OUT, "_list.txt"), "-c", "copy", joined])

    with open(os.path.join(OUT, "almoner-demo.srt"), "w") as f:
        st = lambda x: ass_time(x).replace(".", ",").rjust(11, "0") + "0"
        for n, (a, b, _, text) in enumerate([e for e in events if e[2] == "Sub"], 1):
            f.write(f"{n}\n{st(a)} --> {st(b)}\n{text}\n\n")
    ass = os.path.join(OUT, "_subs.ass")
    with open(ass, "w") as f:
        f.write("[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\n"
                "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
                "Style: Sub,Helvetica Neue,42,&H00FFFFFF,&H00FFFFFF,&H1E120F11,&H1E120F11,0,0,0,0,100,100,0,0,3,13,0,2,210,210,44,1\n"
                "Style: Tag,Menlo,19,&H000A5CF2,&H00FFFFFF,&H10FFFFFF,&H10FFFFFF,1,0,0,0,100,100,1,0,3,8,0,1,26,26,24,1\n\n"
                "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")
        for a, b, style, text in events:
            if style == "Sub" and "--no-subs" in flags:
                continue
            f.write(f"Dialogue: 0,{ass_time(a)},{ass_time(b)},{style},,0,0,0,,{text}\n")

    final = os.path.join(OUT, "almoner-final-demo.mp4")
    esc = ass.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
    vf = f"ass='{esc}',fade=t=out:st={total - 0.7:.2f}:d=0.7:color={BG}"
    enc = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]
    if "--no-music" in flags or not os.path.exists(p("music.mp3")):
        run(["-i", joined, "-vf", vf, "-af", f"afade=t=out:st={total - 0.7:.2f}:d=0.7"] + enc + [final])
    else:
        af = (f"[1:a]volume=0.06,afade=t=in:d=2,afade=t=out:st={total - 2.5:.2f}:d=2.5,atrim=duration={total:.2f}[m];"
              f"[0:a][m]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]")
        run(["-i", joined, "-stream_loop", "-1", "-i", p("music.mp3"), "-filter_complex", f"[0:v]{vf}[v];{af}", "-map", "[v]", "-map", "[a]"] + enc + ["-t", f"{total:.2f}", final])
    if total > LIMIT - 2:
        print(f"\n! The video is {total:.0f}s. X allows {LIMIT}s without Premium: shorten narration.json (then tts.py) or the beats in SCENES.")
    print(f"\n{final}\n  {int(total // 60)}:{total % 60:04.1f}, 1920x1080, {FPS} fps, {os.path.getsize(final) / 1e6:.1f} MB"
          + ("\n  NOTE: built from SIMULATED footage (recorded against a local mock). Not for submission." if simulated else ""))


if __name__ == "__main__":
    main()
