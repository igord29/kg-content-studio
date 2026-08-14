#!/usr/bin/env python3
"""
Subject-tracked reframe + dead-air removal + loudness normalization.

This is the "rescue pass" that turns an amateur-looking auto-edit into
something that reads as professionally framed. Three things, in order:

  1. DEAD-AIR REMOVAL   drop every stretch where no human is on screen
  2. DYNAMIC REFRAME    punch in and track the subject, eased, subject at upper third
  3. AUDIO MASTER       normalize to broadcast/social loudness with a true-peak ceiling

The framing logic here is the part that belongs in the render pipeline.
Everything is driven by a per-frame person track, not by a per-clip enum.
"""
import os, sys, json, math, subprocess, tempfile, shutil
import numpy as np
import cv2

os.environ.setdefault("YOLO_VERBOSE", "False")
from ultralytics import YOLO

# ---------------------------------------------------------------- tunables
DET_FPS          = 6      # detections per second
CONF             = 0.30
MIN_GAP_DROP     = 0.4    # drop a no-person stretch only if longer than this (s)
MIN_SUBJECT_AREA = 0.012  # a figure smaller than this doesn't count as 'someone is on screen'
MAX_SUBJECT_AREA = 0.55   # don't punch further into an already-huge subject (back-of-head shots)
TAIL_TRIM        = 0.20   # shave the tail to kill trailing black/held frames
PAD_KEEP         = 0.25   # keep this much padding around a kept segment (s)
TARGET_FILL      = 0.52   # subject height as a fraction of output height
MAX_ZOOM         = 1.85   # never punch in more than this (protects resolution)
MIN_ZOOM         = 1.00
EYELINE          = 0.36   # put the subject's eyeline here (0=top, 1=bottom)
SMOOTH_SEC       = 1.1    # temporal smoothing window for the crop path
OUT_LUFS         = -14.0  # TikTok / Instagram / YouTube target
OUT_TP           = -1.0   # true peak ceiling, dBTP
VIDEO_BITRATE    = "9M"


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def probe(path):
    out = run(["ffprobe", "-v", "error", "-select_streams", "v:0",
               "-show_entries", "stream=width,height,r_frame_rate,nb_frames",
               "-show_entries", "format=duration", "-of", "json", path]).stdout
    d = json.loads(out)
    s = d["streams"][0]
    num, den = s["r_frame_rate"].split("/")
    return dict(w=int(s["width"]), h=int(s["height"]),
                fps=float(num) / float(den), dur=float(d["format"]["duration"]))


# ---------------------------------------------------------------- pass 1
def detect_track(path, model, det_fps=DET_FPS):
    """Sample the video and return [(t, boxes)] where boxes are xyxy in pixels."""
    meta = probe(path)
    cap = cv2.VideoCapture(path)
    step = max(1, int(round(meta["fps"] / det_fps)))
    track, i = [], 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if i % step == 0:
            r = model.predict(frame, classes=[0], conf=CONF, verbose=False)[0]
            boxes = r.boxes.xyxy.cpu().numpy() if len(r.boxes) else np.zeros((0, 4))
            track.append((i / meta["fps"], boxes))
        i += 1
    cap.release()
    return meta, track


FRAME_AREA = [1.0]


def keep_segments(track, dur, min_gap=MIN_GAP_DROP, pad=PAD_KEEP):
    """Return [(start, end)] covering the parts of the video with people in them."""
    def occupied(boxes):
        if len(boxes) == 0:
            return False
        # a distant speck is not a subject. Require real presence in the frame.
        return max((b[2]-b[0])*(b[3]-b[1]) for b in boxes) >= MIN_SUBJECT_AREA * FRAME_AREA[0]

    present = [(t, occupied(b)) for t, b in track]
    segs, cur = [], None
    for t, ok in present:
        if ok and cur is None:
            cur = t
        elif not ok and cur is not None:
            segs.append((cur, t))
            cur = None
    if cur is not None:
        segs.append((cur, dur))

    # drop micro-segments, pad, then merge anything that touches
    segs = [(max(0, a - pad), min(dur, b + pad)) for a, b in segs if b - a >= 0.5]
    merged = []
    for a, b in segs:
        if merged and a <= merged[-1][1] + min_gap:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    return merged


# ---------------------------------------------------------------- framing
def primary_subject(boxes, w, h):
    """
    Pick the subject the eye would follow: biggest box, but boxes that are close
    together are treated as one group so a coach + kid stays framed together.
    Returns (cx, cy, bw, bh) in pixels, or None.
    """
    if len(boxes) == 0:
        return None
    areas = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
    k = int(np.argmax(areas))
    main = boxes[k]
    mcx = (main[0] + main[2]) / 2
    mh = main[3] - main[1]

    # group in anything whose centre is within 1.6 subject-heights horizontally
    # and which is at least 35% as tall (ignores distant background figures)
    group = [main]
    for j, b in enumerate(boxes):
        if j == k:
            continue
        bh = b[3] - b[1]
        bcx = (b[0] + b[2]) / 2
        if bh >= 0.35 * mh and abs(bcx - mcx) < 1.6 * mh:
            group.append(b)
    g = np.array(group)
    x1, y1 = g[:, 0].min(), g[:, 1].min()
    x2, y2 = g[:, 2].max(), g[:, 3].max()
    return ((x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1)


def build_crop_path(track, meta, n_frames):
    """Per-frame (cx, cy, zoom), smoothed. Falls back to a slow drift to centre."""
    w, h = meta["w"], meta["h"]
    ts, cxs, cys, zs = [], [], [], []
    for t, boxes in track:
        s = primary_subject(boxes, w, h)
        if s is None:
            continue
        cx, cy, bw, bh = s
        # zoom so the subject occupies TARGET_FILL of the frame height
        if (bw * bh) / (w * h) > MAX_SUBJECT_AREA:
            z = MIN_ZOOM                      # already filling the frame; leave it alone
        else:
            z = np.clip((h * TARGET_FILL) / max(bh, 1e-6), MIN_ZOOM, MAX_ZOOM)
        # aim the eyeline (top of box + 15% of its height), not the box centre
        eye = (cy - bh / 2) + 0.15 * bh
        # where the crop centre must sit so the eyeline lands on EYELINE
        vis_h = h / z
        target_cy = eye + (0.5 - EYELINE) * vis_h
        ts.append(t); cxs.append(cx); cys.append(target_cy); zs.append(z)

    if not ts:
        return np.full(n_frames, w / 2), np.full(n_frames, h / 2), np.ones(n_frames)

    frame_t = np.arange(n_frames) / meta["fps"]
    cx = np.interp(frame_t, ts, cxs)
    cy = np.interp(frame_t, ts, cys)
    z = np.interp(frame_t, ts, zs)

    # heavy smoothing == cinematic. A hard-cut-free, eased move.
    win = max(3, int(SMOOTH_SEC * meta["fps"]) | 1)
    k = np.hanning(win); k /= k.sum()
    pad = win // 2
    sm = lambda a: np.convolve(np.pad(a, pad, mode="edge"), k, mode="valid")[:n_frames]
    return sm(cx), sm(cy), sm(z)


def render(src, dst, crop_path, meta):
    """Decode, crop per frame, write. Video only — audio is handled separately."""
    w, h = meta["w"], meta["h"]
    cx, cy, z = crop_path
    n = len(cx)
    p = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error",
         "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
         "-r", f"{meta['fps']}", "-i", "-",
         "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
         "-b:v", VIDEO_BITRATE, "-maxrate", VIDEO_BITRATE, "-bufsize", "18M",
         "-pix_fmt", "yuv420p", "-movflags", "+faststart", dst],
        stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    cap = cv2.VideoCapture(src)
    i = 0
    while i < n:
        ok, frame = cap.read()
        if not ok:
            break
        zz = float(z[i])
        cw, ch = w / zz, h / zz
        x = np.clip(cx[i] - cw / 2, 0, w - cw)
        y = np.clip(cy[i] - ch / 2, 0, h - ch)
        x0, y0 = int(round(x)), int(round(y))
        x1, y1 = int(round(x + cw)), int(round(y + ch))
        crop = frame[y0:y1, x0:x1]
        if crop.shape[0] < 2 or crop.shape[1] < 2:
            crop = frame
        out = cv2.resize(crop, (w, h), interpolation=cv2.INTER_LANCZOS4)
        # light, consistent sharpening — one grade for every video, no AI choice
        out = cv2.addWeighted(out, 1.14, cv2.GaussianBlur(out, (0, 0), 2.2), -0.14, 0)
        p.stdin.write(out.tobytes())
        i += 1
    cap.release()
    p.stdin.close()
    p.wait()


# ---------------------------------------------------------------- driver
def main(src, dst, workdir):
    os.makedirs(workdir, exist_ok=True)
    model = YOLO("yolo11n.pt")

    print("[1/5] detecting subjects in source ...")
    meta, track = detect_track(src, model)
    FRAME_AREA[0] = meta["w"] * meta["h"]
    segs = keep_segments(track, max(0.0, meta["dur"] - TAIL_TRIM))
    kept = sum(b - a for a, b in segs)
    print(f"      source {meta['dur']:.1f}s -> keeping {kept:.1f}s "
          f"in {len(segs)} segments (dropped {meta['dur']-kept:.1f}s of empty frame)")
    for a, b in segs:
        print(f"        keep {a:6.2f} -> {b:6.2f}  ({b-a:.2f}s)")

    print("[2/5] cutting dead air ...")
    stage1 = os.path.join(workdir, "stage1.mp4")
    parts = []
    fc = []
    for i, (a, b) in enumerate(segs):
        fc.append(f"[0:v]trim=start={a}:end={b},setpts=PTS-STARTPTS[v{i}]")
        fc.append(f"[0:a]atrim=start={a}:end={b},asetpts=PTS-STARTPTS[a{i}]")
        parts.append(f"[v{i}][a{i}]")
    fc.append("".join(parts) + f"concat=n={len(segs)}:v=1:a=1[v][a]")
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", src,
         "-filter_complex", ";".join(fc), "-map", "[v]", "-map", "[a]",
         "-c:v", "libx264", "-preset", "fast", "-crf", "16",
         "-c:a", "aac", "-b:a", "192k", stage1])

    print("[3/5] building subject track for reframe ...")
    meta1, track1 = detect_track(stage1, model)
    n_frames = int(round(meta1["dur"] * meta1["fps"]))
    path = build_crop_path(track1, meta1, n_frames)
    zmean = float(np.mean(path[2]))
    print(f"      mean punch-in {zmean:.2f}x  (range {path[2].min():.2f}-{path[2].max():.2f})")

    print("[4/5] rendering reframed video ...")
    v_only = os.path.join(workdir, "v.mp4")
    render(stage1, v_only, path, meta1)

    print("[5/5] mastering audio and muxing ...")
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", v_only, "-i", stage1,
         "-map", "0:v:0", "-map", "1:a:0",
         "-af", f"loudnorm=I={OUT_LUFS}:TP={OUT_TP}:LRA=9",
         "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
         "-movflags", "+faststart", dst])
    print(f"\nDONE -> {dst}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "/tmp/rf")
