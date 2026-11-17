# Reference build for a pro ad (the UnitedSets Thanksgiving all-ages 30s pilot, the quality floor).
# Run from a working folder that holds: clips/ (full-quality source cuts from /api/story/clip), wh/ (winner photos),
# tg/ (licensed b-roll stills), vo/ (one wav per voice line), vo_raw.mp3, sfx/, em/ (emoji PNGs), logo.png.
# usage: python3 build_ad.py <v|w> <d4|d2|last|call>   -> out/<name>.mp4 + out/<name>.qc.json
# Then: python3 tools/video-qc/qc.py out/<name>.mp4 --frames review.jpg --log qc-log.csv
# See .claude/skills/pro-ad-video/SKILL.md for the standard and the loop.

"""UnitedSets Thanksgiving L6 ad: all-ages 30s pilot.

usage: python3 build_us.py <aspect v|w> <variant d4|d2|last|call> [--shots-only|--assemble-only]
Builds shots once per aspect (shared by every countdown variant), then assembles the variant.
"""
import json, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

ASPECT, VAR = sys.argv[1], sys.argv[2]
MODE = sys.argv[3] if len(sys.argv) > 3 else ''
OW, OH = (1080, 1920) if ASPECT == 'v' else (1920, 1080)
FONTS = '/home/user/kg-content-studio/assets/story/fonts'
FPS = 30
SD = f'shots_{ASPECT}'
os.makedirs(SD, exist_ok=True)

def ff(args, **kw):
    subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', *args], check=True, **kw)

def dims(src):
    s = subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src]).decode().strip().split(',')
    return int(s[0]), int(s[1])

GRADE = ("eq=contrast=1.13:saturation=1.32:brightness=0.015:gamma=0.97,"
         "colorbalance=rs=0.03:gs=0.0:bs=-0.04:rm=0.02:bm=-0.02,"
         "vignette=angle=PI/5:mode=forward,unsharp=5:5:0.7:5:5:0.0")

# ---- timeline -------------------------------------------------------------
# kind clip: clip, inp, cx, cy, h (9:16 crop height / source height), w16 (16:9 crop width / source width), z (push-in end zoom)
T = [
    dict(k='clip', c='A', inp=4.45, d=1.50, cx=0.33, cy=0.58, h=0.55, w16=0.80, z=1.10, cy16=0.60, tr=('slideleft', 0.18)),
    dict(k='still', img='tg/leftovers.jpg', d=1.60, cx=0.30, cy16=0.5, tr=('cut', 0)),
    dict(k='clip', c='C', inp=7.00, d=2.00, cx=0.21, cy=0.60, h=0.44, w16=0.62, z=1.06, cy16=0.60, tr=('cut', 0)),
    dict(k='clip', c='E', inp=4.80, d=1.20, cx=0.25, cy=0.62, h=0.60, w16=0.62, z=1.06, cy16=0.60, tr=('cut', 0)),
    dict(k='clip', c='G', inp=4.40, d=1.10, cx=0.21, cy=0.62, h=0.44, w16=0.75, z=1.06, cy16=0.55, tr=('fadewhite', 0.16)),
    dict(k='photos', d=3.20, tr=('zoomin', 0.22)),
    dict(k='clip', c='I', inp=5.40, d=1.40, cx=0.50, cy=0.62, h=0.80, w16=1.00, z=1.06, cy16=0.55, tr=('cut', 0)),
    dict(k='clip', c='D', inp=5.90, d=2.30, cx=0.15, cy=0.50, h=0.50, w16=0.70, z=1.08, cy16=0.52, tr=('slideup', 0.18)),
    dict(k='card', name='countdown', d=2.10, tr=('cut', 0)),
    dict(k='still', img='tg/fridgeC.jpg', d=1.40, cx=0.50, cy16=0.27, tr=('cut', 0)),
    dict(k='trophy', d=1.30, tr=('fadewhite', 0.16)),
    dict(k='clip', c='H', inp=11.80, d=2.80, cx=0.48, cy=0.50, h=0.40, w16=0.56, z=1.10, cy16=0.50, tr=('fade', 0.30)),
    dict(k='card', name='end', d=3.60, tr=('cut', 0)),
]
t = 0.0
for s in T:
    s['t0'] = round(t, 3); t += s['d']
TOTAL = round(t, 3)
TAIL = 0.4  # every shot rendered this much longer so transitions have frames to eat

# ---- shots ----------------------------------------------------------------
def build_clip(i, s):
    src = f"clips/{s['c']}.mp4"
    W, H = dims(src)
    if ASPECT == 'v':
        ch = int(H * s['h']) // 2 * 2; cw = int(ch * 9 / 16) // 2 * 2
        if cw > W: cw = W // 2 * 2; ch = int(cw * 16 / 9) // 2 * 2
        cy = s['cy']
    else:
        cw = int(W * s['w16']) // 2 * 2; ch = int(cw * 9 / 16) // 2 * 2
        cy = s['cy16']
    x = max(0, min(W - cw, int(s['cx'] * W - cw / 2)))
    y = max(0, min(H - ch, int(cy * H - ch / 2)))
    d = s['d'] + TAIL
    n = int(round(d * FPS))
    z = s['z']
    # 2x supersample then zoompan for a smooth push-in toward the subject
    vf = (f"fps={FPS},crop={cw}:{ch}:{x}:{y},scale={OW*3//2}:{OH*3//2}:flags=lanczos,"
          f"zoompan=z='1+({z}-1)*on/{n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={OW}x{OH}:fps={FPS},"
          f"{GRADE},format=yuv420p")
    ff(['-ss', str(s['inp']), '-t', f'{d:.3f}', '-i', src, '-vf', vf, '-frames:v', str(n), '-an',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', f'{SD}/shot_{i:02d}.mp4'])

PHOTOS = ['20260104_174018', '20260104_183616(0)', '20260404_164726', '20260523_212120',
          '20260809_162520', '20260524_103124', '20260809_174410', '20260503_133017']

def bg_blur(src, inp, d):
    """Blurred, darkened, teal-tinted footage background."""
    return ['-ss', str(inp), '-t', f'{d:.3f}', '-i', src], (
        f"fps={FPS},scale={OW}:{OH}:force_original_aspect_ratio=increase,crop={OW}:{OH},"
        f"gblur=sigma=28,eq=brightness=-0.18:saturation=0.6,"
        f"colorbalance=bs=0.10:gs=0.04:rs=-0.08")

def build_photos(i, s):
    d = s['d'] + TAIL
    per = s['d'] / len(PHOTOS)
    inputs, base_vf = bg_blur('clips/L.mp4', 0.5, d)
    if ASPECT == 'v':
        pw, ph = 740, 987; cx, cy = OW // 2, 840
        offs = [(-30, 0), (40, -20), (-50, 25), (35, 10), (-20, -30), (50, 20), (-40, 5), (15, -10)]
    else:
        pw, ph = 540, 720; cx, cy = OW // 2, OH // 2 + 10
        offs = [(-520, 0), (-300, -15), (-80, 10), (140, -10), (360, 15), (-410, 5), (250, -5), (30, 0)]
    fc = [f"[0:v]{base_vf}[bg]"]
    cur = 'bg'
    for k, p in enumerate(PHOTOS):
        inputs += ['-i', f'wh/{p}.jpg']
        ang = [-4, 3, -2, 4, -3, 2, -4, 3][k]
        fc.append(f"[{k+1}:v]scale={pw}:{ph}:force_original_aspect_ratio=increase,crop={pw}:{ph},{GRADE},"
                  f"pad={pw+28}:{ph+28}:14:14:color=white,format=rgba,"
                  f"rotate={ang}*PI/180:c=none:ow=rotw({ang}*PI/180):oh=roth({ang}*PI/180)[p{k}]")
        t0 = k * per
        ox, oy = offs[k]
        # drop in from above with a quick ease, then hold
        fc.append(f"[{cur}][p{k}]overlay=x='{cx+ox}-w/2':y='{cy+oy}-h/2-140*max(0,1-(t-{t0:.3f})/0.12)':"
                  f"enable='gte(t,{t0:.3f})'[o{k}]")
        cur = f'o{k}'
    fc.append(f"[{cur}]format=yuv420p[out]")
    ff([*inputs, '-filter_complex', ';'.join(fc), '-map', '[out]', '-t', f'{d:.3f}', '-r', str(FPS),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', f'{SD}/shot_{i:02d}.mp4'])

def build_trophy(i, s):
    d = s['d'] + TAIL
    n = int(round(d * FPS))
    inputs, base_vf = bg_blur('clips/H.mp4', 2.0, d)
    tw = 1000 if ASPECT == 'v' else 1080
    inputs += ['-loop', '1', '-t', f'{d:.3f}', '-i', 'wh/20260618_105806.jpg']
    fc = [f"[0:v]{base_vf}[bg]",
          f"[1:v]scale={tw*2}:-2,{GRADE},zoompan=z='1+0.07*on/{n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:"
          f"s={tw}x{int(tw*0.75)//2*2}:fps={FPS},pad=iw+20:ih+20:10:10:color=white[ph]",
          f"[bg][ph]overlay=(W-w)/2:(H-h)/2-{230 if ASPECT=='v' else 90},format=yuv420p[out]"]
    ff([*inputs, '-filter_complex', ';'.join(fc), '-map', '[out]', '-frames:v', str(n), '-r', str(FPS),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', f'{SD}/shot_{i:02d}.mp4'])

def build_still(i, s):
    """Licensed still b-roll with a slow push-in (Ken Burns)."""
    d = s['d'] + TAIL
    n = int(round(d * FPS))
    W, H = dims(s['img'])
    if ASPECT == 'v':
        ch = H; cw = int(H * 9 / 16) // 2 * 2
        if cw > W: cw = W // 2 * 2; ch = int(cw * 16 / 9) // 2 * 2
        y = (H - ch) // 2
    else:
        cw = W; ch = int(W * 9 / 16) // 2 * 2
        y = max(0, min(H - ch, int(s['cy16'] * H - ch / 2)))
    x = max(0, min(W - cw, int(s.get('cx', 0.5) * W - cw / 2)))
    vf = (f"crop={cw}:{ch}:{x}:{y},scale={OW*3//2}:{OH*3//2}:flags=lanczos,"
          f"zoompan=z='1+0.12*on/{n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={OW}x{OH}:fps={FPS},"
          f"eq=contrast=1.06:saturation=1.12,vignette=angle=PI/5,format=yuv420p")
    ff(['-loop', '1', '-t', f'{d:.3f}', '-i', s['img'], '-vf', vf, '-frames:v', str(n), '-r', str(FPS),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', f'{SD}/shot_{i:02d}.mp4'])

def build_card(i, s):
    d = s['d'] + TAIL
    if s['name'] == 'countdown':
        inputs, base_vf = bg_blur('clips/D.mp4', 5.5, d)
    else:
        inputs, base_vf = bg_blur('clips/L.mp4', 2.0, d)
    # deep teal wash (logo colour 014A62) over moving blurred footage
    n = int(round(d * FPS))
    # cards must never sit still: slow push-in on the footage + a breathing vignette
    vf = (base_vf + f",scale={OW*5//4}:{OH*5//4},zoompan=z='1+0.16*on/{n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={OW}x{OH}:fps={FPS}"
          f",drawbox=x=0:y=0:w=iw:h=ih:color=0x014A62@0.62:t=fill,vignette=angle='PI/4+0.12*sin(2*PI*t/1.6)':eval=frame,format=yuv420p")
    ff([*inputs, '-vf', vf, '-t', f'{d:.3f}', '-r', str(FPS), '-an',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', f'{SD}/shot_{i:02d}.mp4'])

def build(i):
    s = T[i]
    # cache: skip a shot whose spec (and the code that renders it) hasn't changed
    import hashlib, inspect
    fn = {'clip': build_clip, 'photos': build_photos, 'trophy': build_trophy, 'card': build_card, 'still': build_still}[s['k']]
    key = hashlib.sha1((json.dumps(s, sort_keys=True, default=str) + inspect.getsource(fn) + GRADE + str(TAIL)).encode()).hexdigest()
    kf, out = f'{SD}/shot_{i:02d}.key', f'{SD}/shot_{i:02d}.mp4'
    if os.path.exists(out) and os.path.exists(kf) and open(kf).read() == key:
        return i
    fn(i, s)
    open(kf, 'w').write(key)
    return i

if MODE != '--assemble-only':
    with ThreadPoolExecutor(3) as ex:
        for i in ex.map(build, range(len(T))):
            print('shot', i, 'ok', flush=True)
    print('shots ok', flush=True)
if MODE == '--shots-only':
    sys.exit(0)

# ---- overlays: text, logo, emoji -----------------------------------------
V = ASPECT == 'v'
start = {i: T[i]['t0'] for i in range(len(T))}
COUNT = {'d4': ('4', 'DAYS LEFT', 'TO ENTER', 'ENTER BY NOV 22'),
         'd2': ('2', 'DAYS LEFT', 'TO ENTER', 'ENTER BY NOV 22'),
         'last': ('', 'LAST DAY', 'TO ENTER', 'ENTER TODAY'),
         'call': ('', 'LAST CALL', 'TO ENTER', 'LAST CALL')}[VAR]

def ts(x):
    x = max(0, x); h = int(x // 3600); m = int(x % 3600 // 60); s = x % 60
    return f"{h}:{m:02d}:{s:05.2f}"

LIME = '&H3CF0D4&'   # tennis-ball lime, ASS is BGR
TEAL = '&H624A01&'
WHITE = '&HFFFFFF&'
cx = OW // 2
if V:
    SLAM_Y, BIG, MID, SMALL = 1250, 150, 110, 56
else:
    SLAM_Y, BIG, MID, SMALL = 840, 132, 98, 48

ev = []
def slam(t0, t1, text, size=BIG, y=SLAM_Y, color=WHITE, extra=''):
    pop = r"{\fscx135\fscy135\t(0,130,\fscx100\fscy100)\fad(40,110)}"
    ev.append(f"Dialogue: 1,{ts(t0)},{ts(t1)},Slam,,0,0,0,,{{\\an5\\pos({cx},{y})\\fs{size}\\1c{color}{extra}}}{pop}{text}")

def line(t0, t1, text, size, y, color=WHITE, style='Slam', fade=(80, 120), layer=1, extra=''):
    ev.append(f"Dialogue: {layer},{ts(t0)},{ts(t1)},{style},,0,0,0,,{{\\an5\\pos({cx},{y})\\fs{size}\\1c{color}\\fad({fade[0]},{fade[1]}){extra}}}{text}")

L = r"{\1c" + LIME + "}"
W_ = r"{\1c" + WHITE + "}"
gap = 1.12 if V else 1.05
slam(0.20, start[1], f"WHO'S {L}NEXT?", BIG + 20)
slam(1.50, start[2] - 0.05, "THANKSGIVING", MID, SLAM_Y - MID * 0.6)
slam(1.62, start[2] - 0.05, f"{L}WEEKEND", MID, SLAM_Y + MID * 0.6)
line(start[2] + 0.05, start[3], "UNITEDSETS TAKES OVER", SMALL, SLAM_Y - BIG * 0.85)
slam(start[2] + 0.12, start[3], f"{L}OAK LANE", BIG)
slam(start[3] + 0.08, start[4], f"BOYS {L}&{W_} GIRLS", BIG)
slam(start[4] + 0.0, start[5], f"{L}12{W_}–{L}18", BIG + 60)
# champions: lower bar over the photo stack
bar_y = 1375 if V else 905
ev.append(f"Dialogue: 2,{ts(start[5]+0.25)},{ts(start[6])},Bar,,0,0,0,,{{\\an5\\pos({cx},{bar_y})\\fs{SMALL+6}\\fad(100,80)}}TOURNAMENT CHAMPIONS")
ev.append(f"Dialogue: 2,{ts(start[5]+0.40)},{ts(start[6])},Bar2,,0,0,0,,{{\\an5\\pos({cx},{bar_y + (SMALL+6)*1.35:.0f})\\fs{SMALL-6}\\fad(100,80)}}UNITEDSETS")
slam(start[6] + 0.10, start[7], f"CLAIM YOUR {L}SPOT", MID + 10)
slam(start[7] + 0.10, start[8], f"USTA {L}LEVEL 6", MID + 10, SLAM_Y - MID * 0.6)
slam(start[7] + 0.30, start[8], "SINGLES", MID, SLAM_Y + MID * 0.6)
# countdown card
c0, c1 = start[8], start[9]
num, l1, l2, endline = COUNT
cy_num = (OH // 2 - 120) if V else (OH // 2 - 90)
line(c0 + 0.05, c1, "THE COUNTDOWN IS ON", SMALL, cy_num - (330 if V else 250) if num else cy_num - 230, LIME)
if num:
    ev.append(f"Dialogue: 2,{ts(c0+0.10)},{ts(c1)},Slam,,0,0,0,,{{\\an5\\pos({cx},{cy_num})\\fs{460 if V else 400}\\1c{LIME}}}"
              r"{\fscx170\fscy170\t(0,160,\fscx100\fscy100)\fad(0,100)}" + num)
    slam(c0 + 0.35, c1, l1, MID + 10, cy_num + (330 if V else 270))
    slam(c0 + 0.50, c1, l2, MID + 10, cy_num + (330 if V else 270) + (MID + 10) * 1.1)
else:
    slam(c0 + 0.10, c1, f"{L}{l1}", BIG + 40, cy_num)
    slam(c0 + 0.35, c1, l2, MID + 10, cy_num + (BIG + 40) * 1.0)
slam(start[9] + 0.08, start[10], f"LEFTOVERS {L}CAN WAIT", MID)
slam(start[10] + 0.05, start[11], f"TROPHIES {L}CAN'T.", MID + 20)
slam(start[11] + 0.20, start[12], f"ENTER {L}NOW", BIG + 10)
line(start[11] + 1.25, start[12], "LINK IN BIO", SMALL + 6, SLAM_Y + BIG * 1.05, LIME, fade=(120, 100))
# end card
e0 = start[12]
if V:
    ys = dict(ent=1130, l1=1250, l2=1330, bio=1460)
else:
    ys = dict(ent=640, l1=750, l2=830, bio=950)
slam(e0 + 0.55, TOTAL, f"{L}{endline}", MID + 6, ys['ent'])
line(e0 + 0.80, TOTAL, "THANKSGIVING WEEKEND · OAK LANE", SMALL - 4, ys['l1'])
line(e0 + 0.95, TOTAL, "USTA LEVEL 6 SINGLES · BOYS & GIRLS 12–18", SMALL - 10 if V else SMALL - 8, ys['l2'])
ev.append(f"Dialogue: 2,{ts(e0+1.2)},{ts(TOTAL)},Pill,,0,0,0,,{{\\an5\\pos({cx},{ys['bio']})\\fs{SMALL+4}\\fad(120,0)}} LINK IN BIO ")
# score bug next to the corner logo, on every shot before the end card
if V:
    bug_x, bug_y, bug_fs = 60 + 150 + 18, 290 + 75, 34
else:
    bug_x, bug_y, bug_fs = 40 + 120 + 16, 40 + 60, 30
ev.append(f"Dialogue: 0,{ts(0.15)},{ts(e0)},Bug,,0,0,0,,{{\\an4\\pos({bug_x},{bug_y})\\fs{bug_fs}\\fad(200,150)}} OAK LANE · THANKSGIVING ")

ass = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {OW}
PlayResY: {OH}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Slam,Montserrat ExtraBold,100,&H00FFFFFF,&H00FFFFFF,&H00101010,&H90000000,0,0,0,0,100,100,1,0,1,4,7,5,60,60,0,1
Style: Bar,Montserrat ExtraBold,60,&H00FFFFFF,&H00FFFFFF,&H00624A01,&H00624A01,0,0,0,0,100,100,2,0,3,22,0,5,60,60,0,1
Style: Bar2,Montserrat ExtraBold,48,&H00624A01,&H00624A01,&H003CF0D4,&H003CF0D4,0,0,0,0,100,100,6,0,3,16,0,5,60,60,0,1
Style: Pill,Montserrat ExtraBold,60,&H00624A01,&H00624A01,&H003CF0D4,&H003CF0D4,0,0,0,0,100,100,3,0,3,20,0,5,60,60,0,1
Style: Bug,Montserrat ExtraBold,34,&H00FFFFFF,&H00FFFFFF,&H00624A01,&H00624A01,0,0,0,0,100,100,2,0,3,12,0,4,60,60,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
""" + '\n'.join(ev) + '\n'
# fake italics: a forward slant reads as "sport"
ass = ass.replace('\\an5\\pos', '\\fax-0.12\\an5\\pos')
open(f'ad_{ASPECT}_{VAR}.ass', 'w').write(ass)

# ---- audio ---------------------------------------------------------------
VO_AT = [0.22, 1.50, start[3] + 0.06, start[5] + 0.30, start[6] + 0.12, start[7] + 0.10,
         start[8] + 0.22, start[9] + 0.10, start[10] + 0.05, start[11] + 0.20]
SFX = [('pop', 0.38, 1.0), ('whip', start[1] - 0.12, 0.8), ('whoosh', start[5] - 0.12, 0.8)]
SFX += [('shutter-modern', start[5] + k * T[5]['d'] / 8, 0.55) for k in range(8)]
SFX += [('whoosh', start[6] - 0.1, 0.6), ('whip', start[7] - 0.12, 0.7), ('pop', start[7] + 1.50, 1.0),
        ('boom', start[8] + 0.08, 0.9)]
SFX += [('tick', start[8] + 0.6 + k * 0.38, 0.8) for k in range(4)]
SFX += [('scratch', start[9] + 0.0, 0.8), ('boom', start[10] + 0.03, 0.7), ('whoosh', start[12] - 0.2, 0.6),
        ('boom', start[12] + 0.5, 1.0)]

ins, fca, labels = [], [], []
for k, at in enumerate(VO_AT):
    ins += ['-i', f'vo/{k+1}.wav']
    fca.append(f"[{k}:a]aresample=48000,volume=1.0,adelay={int(at*1000)}:all=1[vo{k}]"); labels.append(f'[vo{k}]')
for j, (name, at, vol) in enumerate(SFX):
    n = len(VO_AT) + j
    ins += ['-i', f'sfx/{name}.wav']
    fca.append(f"[{n}:a]aresample=48000,aformat=channel_layouts=stereo,volume={vol},adelay={int(max(0,at)*1000)}:all=1[s{j}]"); labels.append(f'[s{j}]')
fca.append(''.join(labels) + f"amix=inputs={len(labels)}:normalize=0:duration=longest,apad,atrim=duration={TOTAL},"
           "alimiter=limit=0.85[aout]")
ff([*ins, '-filter_complex', ';'.join(fca), '-map', '[aout]', '-ar', '48000', '-ac', '2', f'raw_{ASPECT}_{VAR}.wav'])
meas = subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-i', f'raw_{ASPECT}_{VAR}.wav', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json',
                       '-f', 'null', '-'], capture_output=True, text=True).stderr
m = json.loads(meas[meas.rindex('{'):meas.rindex('}') + 1])
ff(['-i', f'raw_{ASPECT}_{VAR}.wav', '-af', f"loudnorm=I=-14:TP=-1.5:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
    f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true",
    '-ar', '48000', '-ac', '2', f'mix_{ASPECT}_{VAR}.wav'])

# ---- final composite -----------------------------------------------------
lg = 150 if V else 120
big = 520 if V else 400
logo_xy = '60:290' if V else '40:40'
big_y = 330 if V else 120
emoji_sz = 150 if V else 120
emoji_y = SLAM_Y - (BIG + 150 if V else BIG + 120)
leaf_y = int(SLAM_Y - MID * 0.6 - MID * 0.55 - emoji_sz * 1.2 - 10)
OVL = [
    f"[L1]scale=-1:{lg},format=rgba,fade=t=in:st=0.15:d=0.2:alpha=1,fade=t=out:st={e0-0.15:.2f}:d=0.15:alpha=1[lg]",
    f"[L2]scale=-1:{big},format=rgba,fade=t=in:st={e0+0.05:.2f}:d=0.35:alpha=1[bl]",
    f"[L3]scale={emoji_sz}:{emoji_sz},format=rgba[em]",
    f"[base][lg]overlay={logo_xy}:enable='lt(t,{e0:.2f})'[a]",
    f"[a][bl]overlay=x=(W-w)/2:y='{big_y}-60*max(0,1-(t-{e0+0.05:.2f})/0.35)':enable='gte(t,{e0+0.05:.2f})'[b]",
    f"[b][em]overlay=x=(W-w)/2:y={emoji_y}:enable='between(t,{start[10]+0.15:.2f},{start[11]:.2f})'[c0]",
    f"[L4]scale={int(emoji_sz*1.4)}:{int(emoji_sz*1.4)},format=rgba[lf]",
    f"[c0][lf]overlay=x=(W-w)/2:y='{leaf_y}-50*max(0,1-(t-{start[1]+0.05:.2f})/0.15)':enable='between(t,{start[1]+0.05:.2f},{start[2]-0.05:.2f})'[c]",
    f"[c]subtitles=SECASS:fontsdir={FONTS},format=yuv420p[ov]",
]
IMG = ['logo.png', 'logo.png', 'em/1f3c6.png', 'em/1f342_glow.png']

# Sections: shots linked by a real transition stay together; a hard cut starts a new section.
groups, g = [], [0]
for k in range(len(T) - 1):
    tp, du = T[k]['tr']
    if tp != 'cut' and du > 0.05: g.append(k + 1)
    else: groups.append(g); g = [k + 1]
groups.append(g)

import hashlib
def tsec(x):
    h, m, sec = x.split(':'); return int(h) * 3600 + int(m) * 60 + float(sec)
ass_head = ass[:ass.index('[Events]')]
ass_lines = [l for l in ass.splitlines() if l.startswith('Dialogue:')]
SEGD = f'segs_{ASPECT}'; os.makedirs(SEGD, exist_ok=True)

def section(g):
    S = T[g[0]]['t0']; E = T[g[-1]]['t0'] + T[g[-1]]['d']; dur = round(E - S, 3)
    mine = [l for l in ass_lines if tsec(l.split(',')[1]) < E and tsec(l.split(',')[2]) > S]
    shot_keys = ''.join(open(f'{SD}/shot_{i:02d}.key').read() for i in g)
    key = hashlib.sha1((shot_keys + json.dumps([T[i]['tr'] for i in g]) + f'{S}{E}' + ''.join(OVL) + ass_head + '\n'.join(mine)).encode()).hexdigest()[:16]
    out = f'{SEGD}/{key}.mp4'
    if os.path.exists(out):
        return out, False
    sass = f'{SEGD}/{key}.ass'
    open(sass, 'w').write(ass_head + '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' + '\n'.join(mine) + '\n')
    inputs, fc = [], []
    for j, i in enumerate(g):
        inputs += ['-i', f'{SD}/shot_{i:02d}.mp4']
        fc.append(f"[{j}:v]settb=1/{FPS},setpts=PTS-STARTPTS,fps={FPS},format=yuv420p,tpad=stop_mode=clone:stop_duration=1[v{j}]")
    cur, cum = 'v0', 0.0
    for j in range(len(g) - 1):
        cum += T[g[j]]['d']
        tp, du = T[g[j]]['tr']
        fc.append(f"[{cur}][v{j+1}]xfade=transition={tp}:duration={du:.4f}:offset={cum - du / 2:.4f}[x{j}]")
        cur = f'x{j}'
    # put the section on the ad's clock so every overlay/caption time stays global
    fc.append(f"[{cur}]trim=duration={dur:.4f},setpts=PTS-STARTPTS+{S}/TB[base]")
    n = len(g)
    for k, img in enumerate(IMG):
        inputs += ['-loop', '1', '-i', img]
    ovl = [x.replace('[L1]', f'[{n}:v]').replace('[L2]', f'[{n+1}:v]').replace('[L3]', f'[{n+2}:v]').replace('[L4]', f'[{n+3}:v]')
           .replace('SECASS', sass) for x in OVL]
    fc += ovl
    fc.append(f"[ov]setpts=PTS-STARTPTS[vout]")
    ff([*inputs, '-filter_complex', ';'.join(fc), '-map', '[vout]', '-frames:v', str(int(round(dur * FPS))), '-r', str(FPS),
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-an', out])
    return out, True

with ThreadPoolExecutor(3) as ex:
    res = list(ex.map(section, groups))
print('sections:', ' '.join(('NEW' if new else 'cached') for _, new in res), flush=True)
name = {'d4': 'nov18-4days', 'd2': 'nov20-2days', 'last': 'nov22-lastday', 'call': 'nov23-lastcall'}[VAR]
out = f"out/UnitedSets-AllAges-30s-{name}-{'9x16' if V else '16x9'}.mp4"
os.makedirs('out', exist_ok=True)
lst = f'{SEGD}/list_{VAR}.txt'
open(lst, 'w').write(''.join(f"file '{os.path.abspath(p)}'\n" for p, _ in res))
ff(['-f', 'concat', '-safe', '0', '-i', lst, '-i', f'mix_{ASPECT}_{VAR}.wav', '-map', '0:v', '-map', '1:a',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', f'{TOTAL:.3f}', '-movflags', '+faststart', out])
print('wrote', out, TOTAL)

# ---- sidecar for the QC gate: what the edit intends, so the check can verify it ----
vo_d = [float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f'vo/{k+1}.wav']).decode()) for k in range(len(VO_AT))]
json.dump({
    'video': out, 'aspect': '9:16' if V else '16:9', 'width': OW, 'height': OH, 'fps': FPS, 'duration': TOTAL,
    'target_duration': [15, 31],
    'shots': [{'t0': x['t0'], 'd': x['d'], 'kind': x['k'], 'trans': x['tr'][0]} for x in T],
    'vo': [{'line': k + 1, 'at': round(a, 3), 'dur': round(vo_d[k], 3), 'file': f'vo/{k+1}.wav'} for k, a in enumerate(VO_AT)],
    'end_card': [e0, TOTAL],
    'ass': os.path.abspath(f'ad_{ASPECT}_{VAR}.ass'),
    'safe_zone': {'top': 280, 'bottom': 1500, 'side': 60} if V else {'top': 60, 'bottom': 1020, 'side': 60},
    'logo_until': e0,
}, open(out.replace('.mp4', '.qc.json'), 'w'), indent=1)
print('wrote', out)
