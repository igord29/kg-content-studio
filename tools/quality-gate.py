#!/usr/bin/env python3
"""
quality-gate.py — deterministic publish gate for rendered videos.

Replaces the AI reviewer that grades pacing, transitions and music from
eight still JPEGs and no audio. Everything here is measured, not guessed:
if it says the subject is 1% of frame, the subject is 1% of frame.

    python3 quality-gate.py video.mp4                 # human readable
    python3 quality-gate.py video.mp4 --json          # machine readable
    python3 quality-gate.py video.mp4 --profile draft # looser bar

Exit codes:  0 = pass, 1 = fail, 2 = could not measure.

Wire this in front of publishing. A render that fails the gate goes to the
review folder instead of the feed.
"""
import argparse, json, os, re, statistics, subprocess, sys

# --------------------------------------------------------------- thresholds
# Derived from measuring known-bad output. The "publish" numbers are the bar
# a video must clear to be posted without a human looking at it.
PROFILES = {
    "publish": {
        "empty_frame_pct":      (None, 8.0),    # frames with nobody on screen
        "tiny_subject_pct":     (None, 20.0),   # frames where subject < 2% of frame
        "median_subject_pct":   (11.0, None),   # median subject size when present
        "longest_empty_sec":    (None, 1.5),    # longest continuous no-person run
        "integrated_lufs":      (-15.5, -12.5), # platform target is -14
        "true_peak_dbtp":       (None, -0.5),   # anything above 0 is clipping
        "loudness_range_lu":    (2.0, 14.0),
        "cut_length_cv":        (0.30, None),   # rhythm must vary, not be uniform
        "longest_static_sec":   (None, 3.0),    # frozen / held frame detection
        "black_frame_pct":      (None, 1.0),
        "duration_sec":         (8.0, 185.0),
    },
    "draft": {
        "empty_frame_pct":      (None, 15.0),
        "tiny_subject_pct":     (None, 32.0),
        "median_subject_pct":   (8.0, None),
        "longest_empty_sec":    (None, 2.5),
        "integrated_lufs":      (-17.0, -11.5),
        "true_peak_dbtp":       (None, -0.2),
        "loudness_range_lu":    (1.5, 18.0),
        "cut_length_cv":        (0.20, None),
        "longest_static_sec":   (None, 4.5),
        "black_frame_pct":      (None, 3.0),
        "duration_sec":         (5.0, 200.0),
    },
}

LABELS = {
    "empty_frame_pct":    "frames with no person",
    "tiny_subject_pct":   "frames w/ subject under 2%",
    "median_subject_pct": "median subject size",
    "longest_empty_sec":  "longest empty stretch",
    "integrated_lufs":    "integrated loudness",
    "true_peak_dbtp":     "true peak",
    "loudness_range_lu":  "loudness range",
    "cut_length_cv":      "cut rhythm variation",
    "longest_static_sec": "longest static/frozen run",
    "black_frame_pct":    "black frames",
    "duration_sec":       "duration",
}
UNITS = {
    "empty_frame_pct": "%", "tiny_subject_pct": "%", "median_subject_pct": "%",
    "longest_empty_sec": "s", "integrated_lufs": " LUFS", "true_peak_dbtp": " dBTP",
    "loudness_range_lu": " LU", "cut_length_cv": "", "longest_static_sec": "s",
    "black_frame_pct": "%", "duration_sec": "s",
}


def sh(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def measure_video(path, det_fps=3):
    """Person detection + static-run detection. Returns a dict of metrics."""
    os.environ.setdefault("YOLO_VERBOSE", "False")
    from ultralytics import YOLO
    import cv2, numpy as np

    model = YOLO(os.environ.get("QG_MODEL", "yolo11n.pt"))
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError(f"cannot open {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, int(round(fps / det_fps)))

    sizes, prev_small, static_run, longest_static, dark = [], None, 0, 0, 0
    i = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if i % step == 0:
            h, w = frame.shape[:2]
            r = model.predict(frame, classes=[0], conf=0.35, verbose=False)[0]
            boxes = r.boxes.xywh.cpu().numpy()
            sizes.append(max(((b[2] * b[3]) / (w * h)) for b in boxes) if len(boxes) else 0.0)

            small = cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (64, 114))
            if float(small.mean()) < 12:
                dark += 1
            if prev_small is not None:
                if float(np.abs(small.astype(int) - prev_small.astype(int)).mean()) < 1.2:
                    static_run += 1
                    longest_static = max(longest_static, static_run)
                else:
                    static_run = 0
            prev_small = small
        i += 1
    cap.release()

    n = len(sizes) or 1
    present = [s for s in sizes if s > 0]
    run = best = 0
    for s in sizes:
        run = run + 1 if s == 0 else 0
        best = max(best, run)

    return {
        "empty_frame_pct":    100.0 * sum(1 for s in sizes if s == 0) / n,
        "tiny_subject_pct":   100.0 * sum(1 for s in sizes if s < 0.02) / n,
        "median_subject_pct": 100.0 * statistics.median(present) if present else 0.0,
        "mean_subject_pct":   100.0 * statistics.mean(present) if present else 0.0,
        "longest_empty_sec":  best / det_fps,
        "longest_static_sec": longest_static / det_fps,
        "black_frame_pct":    100.0 * dark / n,
        "_samples": n,
    }


def measure_audio(path):
    out = sh(["ffmpeg", "-hide_banner", "-nostats", "-i", path,
              "-af", "ebur128=peak=true", "-f", "null", "-"]).stderr
    def grab(pat):
        m = re.findall(pat, out)
        return float(m[-1]) if m else None
    return {
        "integrated_lufs":   grab(r"I:\s+(-?[\d.]+)\s+LUFS"),
        "loudness_range_lu": grab(r"LRA:\s+(-?[\d.]+)\s+LU"),
        "true_peak_dbtp":    grab(r"Peak:\s+(-?[\d.]+)\s+dBFS"),
    }


def measure_cuts(path, duration):
    out = sh(["ffmpeg", "-hide_banner", "-nostats", "-i", path,
              "-vf", "select='gt(scene,0.18)',metadata=print:file=-",
              "-an", "-f", "null", "-"]).stdout
    cuts = [float(x) for x in re.findall(r"pts_time:([\d.]+)", out)]
    # collapse near-duplicate detections from dissolves/strobing
    dedup = [c for j, c in enumerate(cuts) if j == 0 or c - cuts[j - 1] > 0.4]
    bounds = [0.0] + dedup + [duration]
    lens = [b - a for a, b in zip(bounds, bounds[1:]) if b - a > 0.3]
    if len(lens) < 2:
        return {"shot_count": len(lens), "cut_length_cv": 0.0,
                "mean_shot_sec": lens[0] if lens else duration}
    m = statistics.mean(lens)
    return {"shot_count": len(lens),
            "cut_length_cv": statistics.pstdev(lens) / m if m else 0.0,
            "mean_shot_sec": m}


def probe_duration(path):
    r = sh(["ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "csv=p=0", path])
    try:
        return float(r.stdout.strip())
    except ValueError:
        raise RuntimeError(f"ffprobe could not read {path}")


def evaluate(metrics, profile):
    checks, failures = [], []
    for key, (lo, hi) in PROFILES[profile].items():
        v = metrics.get(key)
        if v is None:
            checks.append({"metric": key, "value": None, "ok": False, "reason": "not measured"})
            failures.append(key)
            continue
        v = float(v)  # numpy scalars leak in from the detector; normalise for output
        ok = (lo is None or v >= lo) and (hi is None or v <= hi)
        bound = []
        if lo is not None: bound.append(f">= {lo}")
        if hi is not None: bound.append(f"<= {hi}")
        checks.append({"metric": key, "value": round(v, 2), "ok": ok, "bound": " and ".join(bound)})
        if not ok:
            failures.append(key)
    return checks, failures


def main():
    ap = argparse.ArgumentParser(description="Deterministic quality gate for rendered videos.")
    ap.add_argument("video")
    ap.add_argument("--profile", choices=list(PROFILES), default="publish")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--det-fps", type=float, default=3.0)
    a = ap.parse_args()

    if not os.path.exists(a.video):
        print(f"no such file: {a.video}", file=sys.stderr)
        return 2
    try:
        duration = probe_duration(a.video)
        m = {"duration_sec": duration}
        m.update(measure_video(a.video, a.det_fps))
        m.update(measure_audio(a.video))
        m.update(measure_cuts(a.video, duration))
    except Exception as e:
        print(f"measurement failed: {e}", file=sys.stderr)
        return 2

    checks, failures = evaluate(m, a.profile)
    passed = not failures

    if a.json:
        print(json.dumps({"file": a.video, "profile": a.profile, "pass": passed,
                          "failures": failures, "metrics": m, "checks": checks}, indent=2))
    else:
        print(f"\n  {os.path.basename(a.video)}   [{a.profile} profile]\n")
        for c in checks:
            mark = "PASS" if c["ok"] else "FAIL"
            val = "—" if c["value"] is None else f"{c['value']}{UNITS.get(c['metric'],'')}"
            print(f"    {mark}  {LABELS.get(c['metric'], c['metric']):<28} {val:>12}"
                  f"   (need {c.get('bound','measurable')})")
        print(f"\n    shots: {m.get('shot_count','?')}   "
              f"mean shot {m.get('mean_shot_sec',0):.1f}s   "
              f"mean subject {m.get('mean_subject_pct',0):.1f}%\n")
        print("    RESULT: PUBLISH\n" if passed
              else f"    RESULT: HOLD FOR REVIEW — {len(failures)} check(s) failed\n")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
