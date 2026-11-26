"""Thumbnails for Short 05 (1080x1920). Key content kept inside the centre 1080x1350 so 4:5 / grid crops still read."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance
import math
W, H = 1080, 1920
ANTON = 'fonts/Anton-Regular.ttf'; MONT = '/home/user/kg-content-studio/assets/story/fonts/Montserrat-800.ttf'
EMOJI = '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf'
LIME, WHITE, BLACK, RED = (212, 240, 60), (255, 255, 255), (0, 0, 0), (235, 40, 40)

def emoji(ch, size):
    f = ImageFont.truetype(EMOJI, 109); im = Image.new('RGBA', (160, 160), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((10, 10), ch, font=f, embedded_color=True)
    im = im.crop(im.getbbox()); return im.resize((size, int(size * im.height / im.width)), Image.LANCZOS)

def text_c(d, y, parts, font, stroke=12):
    """centred line made of (text, colour) parts"""
    widths = [d.textlength(t, font=font) for t, _ in parts]; x = (W - sum(widths)) / 2
    for (t, c), w in zip(parts, widths):
        d.text((x, y), t, font=font, fill=c, stroke_width=stroke, stroke_fill=BLACK); x += w

def pill(img, y, text, size=52, fg=(1, 74, 98), bg=LIME):
    d = ImageDraw.Draw(img); f = ImageFont.truetype(MONT, size); tw = d.textlength(text, font=f)
    x0 = (W - tw) / 2 - 34; d.rounded_rectangle([x0, y, x0 + tw + 68, y + size + 40], radius=22, fill=bg)
    d.text((x0 + 34, y + 14), text, font=f, fill=fg)

def arrow(img, p0, p1, width=26, head=70, col=RED):
    d = ImageDraw.Draw(img); ang = math.atan2(p1[1] - p0[1], p1[0] - p0[0])
    q = (p1[0] - head * 0.8 * math.cos(ang), p1[1] - head * 0.8 * math.sin(ang))
    for w, c in ((width + 14, BLACK), (width, col)):
        d.line([p0, q], fill=c, width=w)
    tip = [p1, (q[0] + head * 0.6 * math.cos(ang + math.pi / 2), q[1] + head * 0.6 * math.sin(ang + math.pi / 2)),
           (q[0] + head * 0.6 * math.cos(ang - math.pi / 2), q[1] + head * 0.6 * math.sin(ang - math.pi / 2))]
    d.polygon(tip, fill=col, outline=BLACK, width=6)

def vignette(img, k=0.55):
    m = Image.new('L', (W, H), 0); dm = ImageDraw.Draw(m); dm.ellipse([-W * 0.35, -H * 0.12, W * 1.35, H * 1.12], fill=255)
    m = m.filter(ImageFilter.GaussianBlur(160)); dark = ImageEnhance.Brightness(img).enhance(1 - k)
    return Image.composite(img, dark, m)

# --- A: the ball on the line ----------------------------------------------------------------------
bg = Image.open('f_31.5.png').convert('RGB')
bg = bg.crop((0, 120, W, 120 + H * 1020 // 1080)) if False else bg
bg = ImageEnhance.Contrast(ImageEnhance.Color(bg).enhance(1.25)).enhance(1.12)
# zoom the court/ball area up so it fills the frame: ball ring sits near (535, 690) in the freeze frame
z = 1.35; cx, cy = 560, 760
bw, bh = int(W / z), int(H / z); box = (int(cx - bw / 2), int(cy - bh / 2) + 175, int(cx + bw / 2), int(cy + bh / 2) + 175)
A = vignette(bg.crop(box).resize((W, H), Image.LANCZOS), 0.5)
d = ImageDraw.Draw(A)
text_c(d, 300, [('IN OR ', WHITE), ('OUT?', LIME)], ImageFont.truetype(ANTON, 230), 14)
arrow(A, (760, 720), (610, 905))
e = emoji('\U0001F914', 150); A.paste(e, (860, 610), e)
logo = Image.open('/tmp/claude-0/-home-user-kg-content-studio/a80d6f28-a584-5a33-8c8f-b33e0110540d/scratchpad/us/logo.png').convert('RGBA'); logo = logo.resize((170, int(170 * logo.height / logo.width)))
A.paste(Image.new('RGB', (W, 230), (22, 30, 90)), (0, 0)) if False else None
lg = logo.resize((200, int(200 * logo.height / logo.width))); A.paste(lg, (935, 143 - lg.height // 2), lg)   # sits over the cropped bug from the video frame
pill(A, 1330, 'YOU MAKE THE CALL')
e2 = emoji('\U0001F447', 90); A.paste(e2, ((W - e2.width) // 2, 1440), e2)
A.save('short05_thumb_A_in-or-out.jpg', quality=93)

# --- B: the player + the question (split) ---------------------------------------------------------
top = Image.open('f_1.1.png').convert('RGB'); top = ImageEnhance.Contrast(ImageEnhance.Color(top).enhance(1.2)).enhance(1.1)
top = top.crop((0, 900, W, 900 + 1000)).resize((W, 1000), Image.LANCZOS)         # maroon at full stretch
bot = A.copy()
B = Image.new('RGB', (W, H)); B.paste(top, (0, 0))
lower = Image.open('f_31.5.png').convert('RGB'); lower = ImageEnhance.Color(lower).enhance(1.25)
lz = 1.6; bw, bh = int(W / lz), int(920 / lz); lb = (537 - bw // 2, 890 - bh // 2, 537 + bw // 2, 890 + bh // 2)
B.paste(lower.crop(lb).resize((W, 920), Image.LANCZOS), (0, 1000))
d = ImageDraw.Draw(B); d.rectangle([0, 988, W, 1012], fill=LIME)
text_c(d, 830, [('ON THE ', WHITE), ('LINE?', LIME)], ImageFont.truetype(ANTON, 200), 14)
e = emoji('\U0001F633', 150); B.paste(e, (880, 1090), e)
pill(B, 1520, 'IN OR OUT? COMMENT')
B.paste(logo, (W - 210, 70), logo)
B.save('short05_thumb_B_on-the-line.jpg', quality=93)
print('ok')
