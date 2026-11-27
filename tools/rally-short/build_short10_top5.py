# Source: session scratchpad hl/t5/top5.py. Run from the folder that holds r10/ r20/ r24/ r59/ r64/ t5/.
"""Short 10: TOP 5 GETS. Compilation of the best defensive moments from Shorts 05-09. 9:16, 30 fps.
  hook   #1 teaser in slow motion + TOP 5 GETS title (Brian: "Top five gets of the tournament. Let's go.")
  items  #5 -> #1: real speed, then slow-mo of the get with a big rank badge and a label; Brian counts, Jessica reacts
  end    WHICH WAS #1? COMMENT 1-5 over a dimmed slow-mo of #1 (loops into the hook)
usage: python3 t5/top5.py   (run from scratchpad/hl)"""
import cv2, json, math, os, re, subprocess
import numpy as np

FPS, OW, OH = 30, 1080, 1920
FONTS = '/home/user/kg-content-studio/assets/story/fonts'
US = '/tmp/claude-0/-home-user-kg-content-studio/a80d6f28-a584-5a33-8c8f-b33e0110540d/scratchpad/us'
WD = 't5/build'; os.makedirs(WD, exist_ok=True)
LIME, WHITE, CORAL = '&H3CF0D4&', '&HFFFFFF&', '&H597AFF&'

class Clip:
    def __init__(self, d):
        self.src = f'{d}/{d}.mp4'; self.cap = cv2.VideoCapture(self.src); self.nf = int(self.cap.get(7)); self.last = -9; self.cache = {}
        self.SW, self.SH = int(self.cap.get(3)), int(self.cap.get(4))
        P = json.load(open(f'{d}/paths.json')); self.T = np.array(P['t']); N = np.array(P['near'])
        sm = lambda v, s: np.convolve(np.pad(v, max(3, int(s * 6) | 1) // 2, mode='edge'), np.ones(max(3, int(s * 6) | 1)) / max(3, int(s * 6) | 1), 'valid')
        self.NX, self.NY, self.NH = sm(N[:, 0], 0.5), sm(N[:, 1], 0.5), sm(N[:, 2], 0.8)
    def frame(self, i):
        i = max(0, min(self.nf - 1, int(i)))
        if i not in self.cache:
            if len(self.cache) > 120: self.cache.clear()
            if i != self.last + 1: self.cap.set(cv2.CAP_PROP_POS_FRAMES, i)
            ok, f = self.cap.read(); self.last = i; self.cache[i] = f if ok else np.zeros((self.SH, self.SW, 3), np.uint8)
        return self.cache[i]
    def at(self, t):
        x = max(0, t) * FPS; i = int(math.floor(x)); w = x - i
        return self.frame(i) if w < 0.1 else self.frame(i + 1) if w > 0.9 else cv2.addWeighted(self.frame(i), 1 - w, self.frame(i + 1), w, 0)
    def render(self, t, z=1.12, push=1.0):
        img = self.at(t); nx, ny = np.interp(t, self.T, self.NX), np.interp(t, self.T, self.NY)
        ch = int(self.SH / z / push); cw = int(round(ch * 9 / 16)); cx, cy = nx * self.SW, (ny - 0.06) * self.SH
        x0 = int(round(min(max(cx - cw / 2, 0), self.SW - cw))); y0 = int(round(min(max(cy - ch / 2, 0), self.SH - ch)))
        o = cv2.resize(img[y0:y0 + ch, x0:x0 + cw], (OW, OH), interpolation=cv2.INTER_LANCZOS4)
        b = cv2.GaussianBlur(o, (0, 0), 1.6); return cv2.addWeighted(o, 1.3, b, -0.3, 0)

C = {d: Clip(d) for d in ('r64', 'r10', 'r59', 'r24', 'r20')}
ZOOM = {'r24': 1.7}                                   # black sits at the bottom edge of that camera: crop tighter
#        rank, clip,  real window,   slow window,   rate, contact, label
ITEMS = [(5, 'r64', (13.6, 15.4), (14.3, 15.3), 0.4, 14.85, 'FULL SPLIT'),
         (4, 'r10', (12.2, 14.0), (12.9, 13.7), 0.4, 13.30, 'THE SLIDE'),
         (3, 'r59', (11.3, 14.6), (11.7, 12.7), 0.4, 11.86, 'DOWN & BACK UP'),
         (2, 'r24', (19.4, 21.0), (20.0, 20.8), 0.4, 20.39, 'FULL STRETCH'),
         (1, 'r20', (24.9, 27.0), (25.5, 26.75), 0.4, 26.12, 'SPRINT & LUNGE')]
L = [dict(clip='r20', s0=25.5, rate=0.6, dur=2.9, hook=True)]
for rank, c, (a, b), (sa, sb), r, ct, lab in ITEMS:
    L.append(dict(clip=c, s0=a, rate=1.0, dur=b - a, rank=rank, label=lab, real=True))
    L.append(dict(clip=c, s0=sa, rate=r, dur=(sb - sa) / r, rank=rank, label=lab, slow=True, contact=ct))
L.append(dict(clip='r20', s0=25.9, rate=0.25, dur=3.4, end=True))
t = 0
for s in L: s['t0'] = t; t += s['dur']
TOTAL = t; T_END = L[-1]['t0']
def seg_at(t): return next(s for s in L if s['t0'] <= t < s['t0'] + s['dur'] + 1e-6) if t < TOTAL - 1e-6 else L[-1]

def load_rgba(p, size):
    im = cv2.imread(p, cv2.IMREAD_UNCHANGED); return cv2.resize(im, (size, int(im.shape[0] * size / im.shape[1])), interpolation=cv2.INTER_AREA)
bug = load_rgba(f'{US}/logo.png', 120)
def paste(dst, rgba, cx, cy, alpha=0.9):
    hh, ww = rgba.shape[:2]; x0, y0 = int(cx - ww / 2), int(cy - hh / 2); a = rgba[:, :, 3:4] / 255.0 * alpha
    dst[y0:y0 + hh, x0:x0 + ww] = (dst[y0:y0 + hh, x0:x0 + ww] * (1 - a) + rgba[:, :, :3] * a).astype(np.uint8)

VID = f'{WD}/video.mp4'
ff = subprocess.Popen(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{OW}x{OH}', '-r', str(FPS), '-i', '-',
                       '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', VID], stdin=subprocess.PIPE)
for i in range(int(round(TOTAL * FPS))):
    t = i / FPS; S = seg_at(t); u = t - S['t0']; st = S['s0'] + u * S['rate']
    push = 1 + (0.10 * u / S['dur'] if (S.get('slow') or S.get('end') or S.get('hook')) else 0)
    img = C[S['clip']].render(st, z=ZOOM.get(S['clip'], 1.12), push=push)
    if S.get('slow') or S.get('hook'):
        cv2.rectangle(img, (6, 6), (OW - 7, OH - 7), (60, 240, 212), 12)
        if u < 0.1: img = cv2.addWeighted(img, 0.35, np.full_like(img, 255), 0.65, 0)
    if S.get('real') and u < 0.12:                                           # whip-in: horizontal smear
        k = int(60 * (1 - u / 0.12)) | 1; img = cv2.blur(img, (k, 1))
    if S.get('end'): img = cv2.addWeighted(img, 0.6, np.zeros_like(img), 0.4, 0)
    paste(img, bug, 966, 330)
    ff.stdin.write(np.ascontiguousarray(img).tobytes())
ff.stdin.close(); ff.wait()

# ---- voice ----------------------------------------------------------------------------------------
VO = {f[:-4]: float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f't5/vo/{f}'], capture_output=True, text=True).stdout)
      for f in os.listdir('t5/vo') if f.endswith('.wav')}
WORDS = json.load(open('t5/vo/words.json'))
TXT = {'b0': "Top five gets of the tournament. Let's go.", 'b5': "Number five.", 'b4': "Number four.", 'b3': "Number three.", 'b2': "Number two.",
       'b1': "And number one.", 'j5': "Full split!", 'j4': "The slide!", 'j3': "Down… and right back UP!", 'j2': "Full stretch!",
       'j1': "Sprint, lunge, still swinging!", 'je': "Which one's YOUR number one? Comment one to five."}
VO_AT = [('b0', 0.05)]
for s in L:
    if s.get('real'): VO_AT.append((f"b{s['rank']}", s['t0'] + 0.05))
    if s.get('slow'): VO_AT.append((f"j{s['rank']}", s['t0'] + 0.15))
VO_AT.append(('je', T_END + 0.2))
for (a, ta), (b, tb) in zip(VO_AT, VO_AT[1:]): assert ta + VO[a] <= tb + 0.25, f'overlap {a}->{b} {ta + VO[a]:.2f} {tb:.2f}'
assert VO_AT[-1][1] + VO['je'] <= TOTAL + 0.02

# ---- text -----------------------------------------------------------------------------------------
def ts(x): x = max(0, x); return f"{int(x // 3600)}:{int(x % 3600 // 60):02d}:{x % 60:05.2f}"
ev = []
def slam(t0, t1, txt, y, fs, x=OW // 2, layer=1):
    ev.append(f"Dialogue: {layer},{ts(t0)},{ts(t1)},Slam,,0,0,0,,{{\\an5\\pos({x},{y})\\fs{fs}\\fscx145\\fscy145\\t(0,120,\\fscx100\\fscy100)\\fad(20,40)}}{txt}")
slam(0.1, L[0]['dur'], f"TOP {{\\1c{LIME}}}5", 470, 190)
slam(0.35, L[0]['dur'], "GETS", 650, 170)
for s in L:
    if s.get('real') or s.get('slow'):
        slam(s['t0'] + 0.03, s['t0'] + s['dur'], f"{{\\1c{LIME}}}#{s['rank']}", 520, 230, x=190)
    if s.get('slow'):
        slam(s['t0'] + 0.15, s['t0'] + s['dur'], s['label'], 420, 84, layer=2)
slam(T_END + 0.15, TOTAL, f"WHICH WAS {{\\1c{LIME}}}#1?", 700, 130)
ev.append(f"Dialogue: 2,{ts(T_END + 0.4)},{ts(TOTAL)},Pill,,0,0,0,,{{\\an5\\pos({OW//2},840)\\fs46\\fad(100,0)}} COMMENT 1-5 · @UNITEDSETS ")
WHO = {'b': ('BRIAN', LIME), 'j': ('JESSICA', CORAL)}
for n, (k, t0) in enumerate(VO_AT):
    nxt = VO_AT[n + 1][1] if n + 1 < len(VO_AT) else TOTAL; t_end = min(t0 + VO[k] + 0.25, nxt - 0.02)
    y = 1180 if k in ('je',) else 760
    if k == 'b0': y = 1250
    name, col = WHO[k[0]]; S = TXT[k].replace('…', '… ').split(); W = WORDS[k]
    if len(S) != len(W):
        a0, a1 = W[0][0], W[-1][1]; st = (a1 - a0) / len(S); W = [(a0 + i * st, a0 + (i + 1) * st, '') for i in range(len(S))]
    wl = [(t0 + a, t0 + b, w) for (a, b, _), w in zip(W, S)]
    ev.append(f"Dialogue: 3,{ts(t0)},{ts(t_end)},Who,,0,0,0,,{{\\an5\\pos({OW//2},{y - 92})\\fs40\\1c{col}\\fad(60,60)}}{name}")
    chunks, cur = [], []
    for w in wl:
        if cur and (len(' '.join(x[2] for x in cur + [w])) > 16 or cur[-1][2][-1] in '.,!?…'): chunks.append(cur); cur = [w]
        else: cur.append(w)
    chunks.append(cur)
    for ci, ch in enumerate(chunks):
        c0 = ch[0][0] if ci else t0; c1 = chunks[ci + 1][0][0] if ci + 1 < len(chunks) else t_end
        for wi, (a, b, w) in enumerate(ch):
            w0 = c0 if wi == 0 else a; w1 = ch[wi + 1][0] if wi + 1 < len(ch) else c1
            parts = [f"{{\\1c{col}\\fscx112\\fscy112}}{x[2].upper()}{{\\1c{WHITE}\\fscx100\\fscy100}}" if j == wi else x[2].upper() for j, x in enumerate(ch)]
            intro = "\\fscx70\\fscy70\\t(0,90,\\fscx100\\fscy100)" if wi == 0 else ''
            ev.append(f"Dialogue: 2,{ts(w0)},{ts(w1)},Word,,0,0,0,,{{\\an5\\pos({OW//2},{y})\\fs92{intro}}}{' '.join(parts)}")
ass = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {OW}
PlayResY: {OH}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Word,Montserrat ExtraBold,92,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,1,0,1,8,5,5,60,60,0,1
Style: Who,Montserrat ExtraBold,34,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,4,0,1,5,2,5,60,60,0,1
Style: Slam,Montserrat ExtraBold,100,&H00FFFFFF,&H00FFFFFF,&H00101010,&H90000000,0,0,0,0,100,100,1,0,1,7,8,5,60,60,0,1
Style: Pill,Montserrat ExtraBold,40,&H00624A01,&H00624A01,&H003CF0D4,&H003CF0D4,0,0,0,0,100,100,3,0,3,18,0,5,60,60,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
""" + '\n'.join(ev) + '\n'
open(f'{WD}/text.ass', 'w').write(ass)

# ---- audio ----------------------------------------------------------------------------------------
SFX, RX = f'{US}/sfx', 'r20/sfx'
srcs = sorted(set(s['clip'] for s in L)); IDX = {c: i for i, c in enumerate(srcs)}
ins = sum([['-i', C[c].src] for c in srcs], []); fc, ch_a = [], []; k = len(srcs)
for j, s in enumerate(L):
    r = s['rate']; a = s['s0']; b = a + s['dur'] * r
    chain = f"[{IDX[s['clip']]}:a]atrim={a:.4f}:{b:.4f},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo"
    if r < 0.95: chain += f",asetrate={int(48000 * r)},aresample=48000"
    fc.append(chain + f",volume=3.0,apad,atrim=0:{s['dur']:.4f}[a{j}]"); ch_a.append(f'[a{j}]')
fc.append(f"{''.join(ch_a)}concat=n={len(ch_a)}:v=0:a=1,acompressor=threshold=0.2:ratio=3:attack=5:release=120[court]")
vo_l = []
for key, t0 in VO_AT:
    ins += ['-i', f't5/vo/{key}.wav']; fc.append(f"[{k}:a]aresample=48000,aformat=channel_layouts=stereo,volume=1.7,adelay={int(t0*1000)}|{int(t0*1000)}[v{k}]"); vo_l.append(f'[v{k}]'); k += 1
fc.append(f"{''.join(vo_l)}amix=inputs={len(vo_l)}:normalize=0,apad=whole_dur={TOTAL:.3f},asplit[vo][key]")
fx = [(f'{RX}/riser.wav', 0.0, 0.25), (f'{SFX}/pop.wav', 0.12, 0.6)]
for s in L:
    if s.get('real'): fx += [(f'{SFX}/whip.wav', s['t0'] - 0.06, 0.5), (f'{SFX}/pop.wav', s['t0'] + 0.04, 0.5)]
    if s.get('slow'): fx += [(f'{SFX}/whoosh.wav', s['t0'] - 0.1, 0.5), (f'{SFX}/boom.wav', s['t0'] + (s['contact'] - s['s0']) / s['rate'], 0.5)]
fx += [(f'{RX}/subdrop.wav', T_END, 0.5), (f'{SFX}/pop.wav', T_END + 0.15, 0.7), (f'{RX}/applause.wav', T_END + 0.3, 0.25)]
fl = []
for name, t0, g in fx:
    ins += ['-i', name]; fc.append(f"[{k}:a]aresample=48000,aformat=channel_layouts=stereo,volume={g},adelay={int(max(0,t0)*1000)}|{int(max(0,t0)*1000)}[f{k}]"); fl.append(f'[f{k}]'); k += 1
fc.append("[court][key]sidechaincompress=threshold=0.03:ratio=5:attack=20:release=300[duck]")
fc.append(f"[duck][vo]{''.join(fl)}amix=inputs={2 + len(fl)}:normalize=0,atrim=0:{TOTAL:.3f}[mix]")
RAW = f'{WD}/mix_raw.wav'
subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', *ins, '-filter_complex', ';'.join(fc), '-map', '[mix]', '-ar', '48000', '-ac', '2', RAW], check=True)
m = subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-i', RAW, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], capture_output=True, text=True).stderr
m = json.loads(m[m.rindex('{'):m.rindex('}') + 1]); MIX = f'{WD}/mix.wav'
subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', RAW, '-af', f"loudnorm=I=-14:TP=-1.5:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true,alimiter=limit=0.7:level=false", '-ar', '48000', MIX], check=True)
def lufs(p):
    x = subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-i', p, '-af', 'ebur128', '-f', 'null', '-'], capture_output=True, text=True).stderr
    return float(re.findall(r'I:\s+(-?[\d.]+) LUFS', x)[-1])
for _ in range(2):
    gap = -14.0 - lufs(MIX)
    if abs(gap) < 0.4: break
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', MIX, '-af', f'volume={gap:.2f}dB,alimiter=limit=0.7:level=false:attack=3:release=60', '-ar', '48000', MIX + '.g.wav'], check=True)
    os.replace(MIX + '.g.wav', MIX)
OUT = 't5/out/UnitedSets-Short-10-top-5-gets.mp4'; os.makedirs('t5/out', exist_ok=True)
subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', VID, '-i', MIX, '-vf', f"subtitles={WD}/text.ass:fontsdir={FONTS}", '-map', '0:v', '-map', '1:a',
                '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', f'{TOTAL:.3f}', OUT], check=True)
json.dump({'video': OUT, 'aspect': '9:16', 'width': OW, 'height': OH, 'fps': FPS, 'duration': TOTAL, 'target_duration': [12, 60],
           'shots': [{'t0': round(s['t0'], 3), 'd': round(s['dur'], 3), 'kind': 'card' if s.get('end') else 'clip',
                      'trans': 'whip' if s.get('real') else ('flash' if s.get('slow') else 'pop')} for s in L],
           'vo': [{'line': j + 1, 'at': round(t0, 3), 'dur': VO[key], 'file': os.path.abspath(f't5/vo/{key}.wav')} for j, (key, t0) in enumerate(VO_AT)],
           'end_card': [T_END, TOTAL], 'ass': os.path.abspath(f'{WD}/text.ass'),
           'safe_zone': {'top': 280, 'bottom': 1500, 'side': 60}, 'logo_until': TOTAL, 'surface': 'hard'}, open(OUT.replace('.mp4', '.qc.json'), 'w'), indent=1)
print('wrote', OUT, round(TOTAL, 2))
