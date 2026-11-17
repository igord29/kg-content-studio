#!/usr/bin/env python3
"""Quality gate for finished social videos.

usage: python3 tools/video-qc/qc.py <video.mp4> [--meta video.qc.json] [--log qc-log.csv] [--frames out.jpg]

Runs objective checks on a rendered video and prints a scorecard (0-100).
A video with any HARD failure must not be delivered, whatever its score.
The sidecar meta (written by the render) tells the gate what the edit intends:
voice-over line timings and files, shot list, caption file, safe zone, end card.
Without it only the file-level checks run.

Every check here exists because a real video shipped with that defect once:
  - voice-over lines rendered silent (fade timed on the wrong clock)
  - last words of a line cut off
  - end card frozen because a shot ran short
  - text placed under the platform UI
  - quiet mix (-16.9 LUFS) next to louder posts
"""
import json, math, os, re, struct, subprocess, sys, wave, tempfile, csv, datetime

def sh(args):
    return subprocess.run(args, capture_output=True, text=True)

def probe(path):
    j = json.loads(sh(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate:format=duration',
                       '-of', 'json', path]).stdout)
    v = next(s for s in j['streams'] if s['codec_type'] == 'video')
    a = next((s for s in j['streams'] if s['codec_type'] == 'audio'), None)
    n, d = v['r_frame_rate'].split('/')
    return dict(w=v['width'], h=v['height'], fps=float(n) / float(d), vcodec=v['codec_name'], acodec=a and a['codec_name'],
                dur=float(j['format']['duration']))

def pcm(path, sr=16000):
    """Mono 16 kHz samples of any audio/video file."""
    tmp = tempfile.mktemp(suffix='.wav')
    sh(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', path, '-vn', '-ac', '1', '-ar', str(sr), tmp])
    w = wave.open(tmp); n = w.getnframes(); data = struct.unpack('<%dh' % n, w.readframes(n)); w.close(); os.remove(tmp)
    return data, sr

def db(seg):
    if not seg: return -120.0
    rms = math.sqrt(sum(x * x for x in seg) / len(seg)) / 32768
    return 20 * math.log10(rms + 1e-9)

def speech_band(path):
    """Mono 16 kHz samples, band-limited to the voice range so effects don't mask a missing line."""
    tmp = tempfile.mktemp(suffix='.wav')
    sh(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', path, '-vn', '-af', 'highpass=f=250,lowpass=f=3400', '-ac', '1', '-ar', '16000', tmp])
    w = wave.open(tmp); n = w.getnframes(); data = struct.unpack('<%dh' % n, w.readframes(n)); w.close(); os.remove(tmp)
    return data, 16000

class Card:
    def __init__(self): self.rows = []; self.score = 0; self.max = 0
    def hard(self, name, ok, detail):
        self.rows.append(('HARD', name, ok, detail))
    def soft(self, name, pts, got, detail):
        self.max += pts; self.score += got
        self.rows.append(('SOFT', name, got == pts, f'{got}/{pts}  {detail}'))
    @property
    def passed(self): return all(ok for kind, _, ok, _ in self.rows if kind == 'HARD')

def check(video, meta=None):
    c = Card()
    info = probe(video)
    m = json.load(open(meta)) if meta and os.path.exists(meta) else None

    # --- file integrity -------------------------------------------------------
    errs = [l for l in sh(['ffmpeg', '-nostdin', '-v', 'error', '-i', video, '-f', 'null', '-']).stderr.splitlines() if l.strip()]
    c.hard('Decodes cleanly', not errs, f'{len(errs)} decode errors')
    if m:
        c.hard('Resolution', (info['w'], info['h']) == (m['width'], m['height']), f"{info['w']}x{info['h']} (want {m['width']}x{m['height']})")
        c.hard('Frame rate', abs(info['fps'] - m['fps']) < 0.01, f"{info['fps']:.2f} fps")
    c.hard('H.264 + AAC', info['vcodec'] == 'h264' and info['acodec'] == 'aac', f"{info['vcodec']} / {info['acodec']}")

    # --- picture: frozen or black stretches ---------------------------------------
    fr = sh(['ffmpeg', '-nostdin', '-i', video, '-vf', 'freezedetect=n=0.002:d=0.8,blackdetect=d=0.25:pix_th=0.06', '-an', '-f', 'null', '-']).stderr
    freezes = [(float(a), float(b)) for a, b in re.findall(r'freeze_start: ([\d.]+).*?\n.*?freeze_duration: ([\d.]+)', fr, re.S)]
    blacks = re.findall(r'black_start:([\d.]+) black_end:([\d.]+)', fr)
    c.hard('No frozen picture', not freezes, ', '.join(f'{s:.1f}s for {d:.1f}s' for s, d in freezes) or 'none')
    c.hard('No black frames', not blacks, ', '.join(f'{a}-{b}s' for a, b in blacks) or 'none')

    # --- loudness -------------------------------------------------------------
    lo = sh(['ffmpeg', '-nostdin', '-i', video, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-']).stderr
    I = float(re.findall(r'I:\s+(-?[\d.]+) LUFS', lo)[-1]); TP = float(re.findall(r'Peak:\s+(-?[\d.]+) dBFS', lo)[-1])
    c.hard('Loudness in range (-16 to -12 LUFS)', -16.0 <= I <= -12.0, f'{I:.1f} LUFS')
    c.soft('Loudness on target (-14 ±0.7)', 6, 6 if abs(I + 14) <= 0.7 else 3 if abs(I + 14) <= 1.5 else 0, f'{I:.1f} LUFS')
    c.soft('True peak ≤ -1 dBTP', 4, 4 if TP <= -1.0 else 2 if TP <= 0 else 0, f'{TP:.1f} dBFS')

    # --- duration -----------------------------------------------------------------
    if m:
        lo_d, hi_d = m.get('target_duration', [0, 999])
        c.soft('Duration in target', 4, 4 if lo_d <= info['dur'] <= hi_d else 0, f"{info['dur']:.1f}s (target {lo_d}-{hi_d}s)")

    if not m:
        return c, info, None

    # --- voice-over: every line present, none clipped -------------------------------------
    full, sr = speech_band(video)
    raw_full, _ = pcm(video)
    floor = db(raw_full)  # whole-mix level for reference
    silent, clipped, weak = [], [], []
    for line in m['vo']:
        src, ssr = pcm(line['file'])
        peak_db = db(src)
        if peak_db < -45: silent.append(line['line'])
        tail = src[-int(0.05 * ssr):]; head = src[:int(0.02 * ssr)]
        if db(tail) > -38 or db(head) > -30: clipped.append(line['line'])
        a, b = int((line['at'] + 0.05) * sr), int((line['at'] + line['dur'] - 0.05) * sr)
        if db(full[a:b]) < -40: weak.append(line['line'])
    c.hard('Every voice line has sound', not silent and not weak,
           f'silent source lines {silent}, missing in the mix {weak}' if silent or weak else f"all {len(m['vo'])} lines present")
    c.hard('No voice line cut off', not clipped, f'lines {clipped} start or end mid-sound' if clipped else 'clean starts and ends')

    # --- dead air: no long stretch without voice or effects (end card excepted) ------------
    win, gaps, run = 0.25, [], 0.0
    e0 = m['end_card'][0]
    for k in range(int(e0 / win)):
        seg = raw_full[int(k * win * 16000):int((k + 1) * win * 16000)]
        run = run + win if db(seg) < -48 else 0.0
        if run >= 1.25: gaps.append(round(k * win, 2))
    c.soft('No dead air before the end card', 6, 6 if not gaps else 0, f'quiet stretch ending near {gaps[0]}s' if gaps else 'none')

    # --- voice sits above the effects ------------------------------------------------------
    vo_seg, other = [], []
    mask = [False] * len(raw_full)
    for line in m['vo']:
        for i in range(int(line['at'] * 16000), min(len(raw_full), int((line['at'] + line['dur']) * 16000))): mask[i] = True
    vo_seg = [x for i, x in enumerate(full) if i < len(mask) and mask[i]]
    other = [x for i, x in enumerate(full) if i < len(mask) and not mask[i] and i < e0 * 16000]
    gap_db = db(vo_seg) - db(other)
    c.soft('Voice clearly above effects (≥6 dB)', 6, 6 if gap_db >= 6 else 3 if gap_db >= 3 else 0, f'{gap_db:.1f} dB')

    # --- hook: something said and shown in the first half-second ---------------------------
    first_vo = min(l['at'] for l in m['vo'])
    ass = open(m['ass']).read() if os.path.exists(m.get('ass', '')) else ''
    ev = re.findall(r'^Dialogue: \d+,([\d:.]+),([\d:.]+),(\w+),[^\n]*?\\pos\((\d+),(\d+)\)[^\n]*?\\fs(\d+)[^\n]*?\}([^\n]*)$', ass, re.M)
    tsec = lambda s: sum(float(p) * f for p, f in zip(s.split(':'), (3600, 60, 1)))
    first_txt = min((tsec(a) for a, *_ in ev), default=99)
    c.soft('Hook: voice in first 0.5s', 5, 5 if first_vo <= 0.5 else 0, f'{first_vo:.2f}s')
    c.soft('Hook: on-screen text in first 0.5s', 5, 5 if first_txt <= 0.5 else 0, f'{first_txt:.2f}s')

    # --- pacing --------------------------------------------------------------------------
    body = [s for s in m['shots'] if s['kind'] not in ('card', 'photos')]
    avg = sum(s['d'] for s in body) / max(1, len(body)); longest = max((s['d'] for s in body), default=0)
    c.soft('Pacing: average shot ≤ 2.2s', 6, 6 if avg <= 2.2 else 3 if avg <= 3 else 0, f'{avg:.2f}s')
    c.soft('Pacing: no shot over 3.5s', 4, 4 if longest <= 3.5 else 0, f'longest {longest:.1f}s')
    kinds = len(set(s['trans'] for s in m['shots']))
    c.soft('Transition variety (3+ kinds)', 4, 4 if kinds >= 3 else 2 if kinds == 2 else 0, f'{kinds} kinds')

    # --- text inside the safe zone (clear of platform UI) -------------------------------------
    sz, W = m['safe_zone'], m['width']
    out_of_zone = []
    for start, end, style, x, y, fs, text in ev:
        x, y, fs = int(x), int(y), int(fs)
        clean = re.sub(r'\{[^}]*\}', '', text)
        half_w = len(clean) * fs * 0.24  # measured: Montserrat ExtraBold caps ≈ 0.44 em per letter
        if style == 'Bug':  # corner label: left-anchored next to the logo, checked against the top only
            if y - fs / 2 < sz['top'] - 20: out_of_zone.append(clean[:24])
            continue
        if y - fs * 0.6 < sz['top'] or y + fs * 0.6 > sz['bottom'] or x - half_w < sz['side'] - 20 or x + half_w > W - sz['side'] + 20:
            out_of_zone.append(clean[:24])
    c.soft('Text inside the safe zone', 8, 8 if not out_of_zone else max(0, 8 - 2 * len(out_of_zone)),
           f'outside: {out_of_zone}' if out_of_zone else f'{len(ev)} captions checked')
    big = [e for e in ev if int(e[5]) >= (90 if m['height'] > m['width'] else 80)]
    c.soft('Big, readable key text', 4, 4 if len(big) >= 5 else 2, f'{len(big)} captions at slam size')

    # --- brand ---------------------------------------------------------------------------
    c.soft('Logo on screen until the end card', 4, 4 if m.get('logo_until', 0) >= e0 - 0.1 else 0, f"logo through {m.get('logo_until', 0):.1f}s")
    c.soft('End card ≥ 2.5s', 4, 4 if m['end_card'][1] - m['end_card'][0] >= 2.5 else 0, f"{m['end_card'][1] - m['end_card'][0]:.1f}s")
    return c, info, m

def frames(video, meta, out):
    """One frame from the middle of every shot, for the eyes-on review."""
    m = json.load(open(meta))
    tmpd = tempfile.mkdtemp()
    for k, s in enumerate(m['shots']):
        t = s['t0'] + s['d'] * 0.55
        sh(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', f'{t:.2f}', '-i', video, '-frames:v', '1', '-vf',
            f"scale=-2:{480 if m['height'] > m['width'] else 270},drawtext=text='{k+1}':x=8:y=8:fontsize=28:fontcolor=yellow:box=1:boxcolor=black@0.6",
            f'{tmpd}/{k:02d}.png'])
    sh(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-framerate', '1', '-i', f'{tmpd}/%02d.png', '-vf',
        f"tile={7 if m['height'] > m['width'] else 4}x{2 if m['height'] > m['width'] else 4}:padding=4", '-frames:v', '1', out])

def main():
    args = sys.argv[1:]
    video = args[0]
    opt = {args[i]: args[i + 1] for i in range(1, len(args) - 1, 2)}
    meta = opt.get('--meta', video.replace('.mp4', '.qc.json'))
    c, info, m = check(video, meta)
    pct = round(100 * c.score / c.max) if c.max else 0
    print(f"\nQC  {os.path.basename(video)}   {info['w']}x{info['h']}  {info['dur']:.1f}s")
    for kind, name, ok, detail in c.rows:
        print(f"  {'PASS' if ok else 'FAIL'}  {kind:4s}  {name:40s} {detail}")
    verdict = 'SHIP' if c.passed and pct >= 85 else 'FIX'
    print(f"\n  SCORE {pct}/100   HARD CHECKS {'all pass' if c.passed else 'FAILED'}   VERDICT {verdict}\n")
    if '--frames' in opt and m:
        frames(video, meta, opt['--frames']); print('  review frames:', opt['--frames'])
    if '--log' in opt:
        new = not os.path.exists(opt['--log'])
        with open(opt['--log'], 'a', newline='') as f:
            w = csv.writer(f)
            if new: w.writerow(['date', 'video', 'score', 'hard_pass', 'verdict', 'failed_checks'])
            w.writerow([datetime.date.today().isoformat(), os.path.basename(video), pct, c.passed, verdict,
                        '; '.join(n for _, n, ok, _ in c.rows if not ok)])
    sys.exit(0 if verdict == 'SHIP' else 1)

if __name__ == '__main__':
    main()
