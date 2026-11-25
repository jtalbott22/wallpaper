"""Instagram reel (1080x1920, 30 fps) for Aether: real GPU footage plus an
AI-news style layout (bold headline on top, square clip, timeline overlay).

    python3 promo/make_reel.py            # writes promo/aether-reel.mp4 and a cover JPEG
"""
import math
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, REPO)

W, H, FPS = 1080, 1920, 30
MEDIA_Y, MEDIA = 650, 1080            # square clip, top edge
ACCENT = (120, 226, 255)              # Aether cyan
GOOD = (124, 255, 178)
INK = (255, 255, 255)
DIM = (170, 178, 190)

# footage: (scene, seed, seconds)
SHOTS = [('Galaxy', 23, 5.4), ('Silk', 2026, 5.4), ('Particle Life', 42, 5.4), ('Reaction', 2026, 5.4), ('Chaos', 7, 6.0)]
XFADE = 0.6
MONTAGE_END = 21.0                    # clock reaches 11:07 pm here
END_CARD = (21.6, 27.6)

SANS = '/usr/share/fonts/truetype/ubuntu/UbuntuSans[wdth,wght].ttf'
EMOJI = '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf'


def font(size, weight=800, width=100):
    f = ImageFont.truetype(SANS, size)
    try:
        f.set_variation_by_axes([width, weight])
    except Exception:
        pass
    return f


def smooth(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


# ---------------------------------------------------------------- footage
def render_footage():
    from aether.headless import HeadlessContext
    from aether import preview
    HeadlessContext()
    clips = []
    for name, seed, secs in SHOTS:
        n = int(round((secs + XFADE) * FPS))
        print(f'rendering {name} ({n} frames)', flush=True)
        _, frames = preview.render_frames(name, (MEDIA, MEDIA), [28.0 + i / FPS for i in range(n)],
                                          seed=seed, quality=1.0, log=lambda *_: None)
        clips.append((name, frames))
    return clips


def footage_at(clips, t):
    """Frame and scene name at time t, crossfading between shots."""
    start = 0.0
    for i, (name, frames) in enumerate(clips):
        secs = SHOTS[i][2]
        if t < start + secs or i == len(clips) - 1:
            k = min(int((t - start) * FPS), len(frames) - 1)
            img = frames[max(k, 0)]
            # crossfade into the next shot over the last XFADE seconds
            if i + 1 < len(clips) and t > start + secs - XFADE:
                u = (t - (start + secs - XFADE)) / XFADE
                nxt = clips[i + 1][1][min(int((t - (start + secs - XFADE)) * FPS), len(clips[i + 1][1]) - 1)]
                img = Image.blend(img, nxt, smooth(u))
                name = clips[i + 1][0] if u > 0.5 else name
            return img, name
        start += secs
    return clips[-1][1][-1], clips[-1][0]


# ---------------------------------------------------------------- text layout
def draw_rich(d, x, y, words, f, line_h, max_w, emoji_img=None):
    """Words are (text, colour) pairs; wraps to max_w. Returns bottom y."""
    space = d.textlength(' ', font=f)
    cx, cy = x, y
    for text, col in words:
        if text == '🤯':
            w = line_h * 0.86
            if cx + w > x + max_w:
                cx, cy = x, cy + line_h
            if emoji_img:
                e = emoji_img.resize((int(w), int(w)), Image.LANCZOS)
                d._image.paste(e, (int(cx), int(cy + line_h * 0.04)), e)
            cx += w + space
            continue
        w = d.textlength(text, font=f)
        if cx + w > x + max_w and cx > x:
            cx, cy = x, cy + line_h
        d.text((cx, cy), text, font=f, fill=col)
        cx += w + space
    return cy + line_h


def emoji(ch):
    try:
        f = ImageFont.truetype(EMOJI, 109)
        im = Image.new('RGBA', (136, 128), (0, 0, 0, 0))
        ImageDraw.Draw(im).text((0, 0), ch, font=f, embedded_color=True)
        return im.crop(im.getbbox())
    except Exception:
        return None


def aether_icon(size, col=INK):
    """The ring-core-swirl icon, drawn at 4x and scaled down."""
    s = size * 4
    im = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    k = s / 18.0
    r = 6.5 * k
    d.ellipse((9 * k - r, 9 * k - r, 9 * k + r, 9 * k + r), outline=col, width=int(1.4 * k))
    d.ellipse((8 * k - 2.5 * k, 7.5 * k - 2.5 * k, 8 * k + 2.5 * k, 7.5 * k + 2.5 * k), fill=col)
    # swirl: cubic from (4.5,11) via (7,14.5),(12,13) to (13.5,9)
    pts = []
    for i in range(41):
        t = i / 40
        bx = (1 - t) ** 3 * 4.5 + 3 * (1 - t) ** 2 * t * 7 + 3 * (1 - t) * t * t * 12 + t ** 3 * 13.5
        by = (1 - t) ** 3 * 11 + 3 * (1 - t) ** 2 * t * 14.5 + 3 * (1 - t) * t * t * 13 + t ** 3 * 9
        pts.append((bx * k, by * k))
    d.line(pts, fill=col, width=int(1.2 * k), joint='curve')
    return im.resize((size, size), Image.LANCZOS)


def pill(d, box, text, f, on, check=False):
    x0, y0, x1, y1 = box
    r = (y1 - y0) // 2
    if on:
        d.rounded_rectangle(box, r, fill=(12, 20, 26, 235), outline=GOOD + (255,), width=3)
        col = GOOD
    else:
        d.rounded_rectangle(box, r, fill=(0, 0, 0, 150), outline=(255, 255, 255, 70), width=2)
        col = (200, 205, 212)
    label = ('✓ ' if check and on else '') + text
    tw = d.textlength(label, font=f)
    d.text(((x0 + x1 - tw) / 2, y0 + (y1 - y0) * 0.17), label, font=f, fill=col)


# ---------------------------------------------------------------- static layers
def build_static():
    base = Image.new('RGB', (W, H), (0, 0, 0))
    d = ImageDraw.Draw(base)
    # account row
    av = 74
    ax, ay = 60, 150
    circ = Image.new('L', (av * 4, av * 4), 0)
    ImageDraw.Draw(circ).ellipse((0, 0, av * 4 - 1, av * 4 - 1), fill=255)
    circ = circ.resize((av, av), Image.LANCZOS)
    disc = Image.new('RGB', (av, av), (18, 24, 30))
    base.paste(disc, (ax, ay), circ)
    ic = aether_icon(46)
    base.paste(ic, (ax + (av - 46) // 2, ay + (av - 46) // 2), ic)
    d.text((ax + av + 20, ay + 4), 'Aether', font=font(34, 800), fill=INK)
    d.text((ax + av + 20, ay + 42), 'joshuaallentalbott.com', font=font(26, 450), fill=DIM)

    # headline
    f = font(64, 820)
    W_ = W - 120
    words = [(w, INK) for w in 'This AI-built wallpaper went from Linux-only to'.split()]
    words += [(w, ACCENT) for w in 'Windows, Mac and the web'.split()]
    words += [('in', INK)] + [(w, GOOD) for w in 'ONE evening'.split()] + [('🤯', INK)]
    draw_rich(d, 60, 265, words, f, 78, W_, emoji('🤯'))
    return base


# ---------------------------------------------------------------- per-frame
CLOCK0, CLOCK1 = 20 * 60 + 21, 23 * 60 + 7   # 8:21 pm -> 11:07 pm (minutes after midnight)
MILESTONES = [('Linux', 20 * 60 + 21), ('Web', 21 * 60 + 16), ('Windows', 21 * 60 + 55), ('macOS', 22 * 60 + 17)]


def clock_at(t):
    u = smooth(min(1.0, t / MONTAGE_END) ** 0.92)
    return CLOCK0 + (CLOCK1 - CLOCK0) * u


def fmt_clock(m):
    m = int(m)
    h, mm = divmod(m, 60)
    return f'{h % 12 or 12}:{mm:02d} PM'


def compose(base, clip, scene, t, f_small, f_pill, f_clock, f_label):
    frame = base.copy()
    media = clip.copy()
    # end card: dim and blur the clip
    e0, e1 = END_CARD
    endu = smooth((t - (e0 - 0.6)) / 0.6) if t > e0 - 0.6 else 0.0
    if endu > 0:
        blurred = media.filter(ImageFilter.GaussianBlur(18 * endu))
        media = Image.blend(blurred, Image.new('RGB', media.size, (0, 0, 0)), 0.55 * endu)
    frame.paste(media, (0, MEDIA_Y))

    ov = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    m = clock_at(t)
    if endu < 1:
        a = int(255 * (1 - endu))
        # clock chip, top left of the clip
        txt = fmt_clock(m)
        cw = d.textlength(txt, font=f_clock) + 92
        d.rounded_rectangle((40, MEDIA_Y + 36, 40 + cw, MEDIA_Y + 112), 38, fill=(0, 0, 0, int(170 * (1 - endu))))
        d.ellipse((64, MEDIA_Y + 64, 84, MEDIA_Y + 84), fill=(255, 76, 76, a) if int(t * 2) % 2 == 0 else (255, 76, 76, a // 3))
        d.text((100, MEDIA_Y + 44), txt, font=f_clock, fill=(255, 255, 255, a))
        # scene name, top right
        lab = scene
        lw = d.textlength(lab, font=f_label)
        d.rounded_rectangle((W - 40 - lw - 44, MEDIA_Y + 44, W - 40, MEDIA_Y + 104), 30, fill=(0, 0, 0, int(140 * (1 - endu))))
        d.text((W - 40 - lw - 22, MEDIA_Y + 53), lab, font=f_label, fill=(230, 236, 242, a))
        # platform pills along the bottom of the clip
        n = len(MILESTONES)
        gap, pw, ph = 18, 222, 72
        x = (W - (n * pw + (n - 1) * gap)) // 2
        y = MEDIA_Y + MEDIA - 112
        for name, at in MILESTONES:
            on = m >= at
            pill(d, (x, y, x + pw, y + ph), name, f_pill, on, check=True)
            x += pw + gap
        if a < 255:
            ov.putalpha(ov.getchannel('A').point(lambda v: v * a // 255))

    # end card
    if endu > 0:
        d2 = ImageDraw.Draw(ov)
        a = int(255 * endu)
        cy = MEDIA_Y + 200
        ic = aether_icon(150)
        if a < 255:
            ic.putalpha(ic.getchannel('A').point(lambda v: v * a // 255))
        ov.alpha_composite(ic, ((W - 150) // 2, cy))
        lines = [
            ('Aether', font(92, 820), INK, 178),
            ('10 living GPU scenes · free & open source', font(36, 500), DIM, 300),
            ('Linux  ·  Windows  ·  macOS  ·  Web', font(40, 700), GOOD, 380),
            ('Try it in your browser', font(38, 500), INK, 520),
            ('joshuaallentalbott.com/aether.html', font(46, 800), ACCENT, 574),
        ]
        for txt, f, col, dy in lines:
            tw = d2.textlength(txt, font=f)
            d2.text(((W - tw) / 2, cy + dy), txt, font=f, fill=col + (a,))

    # footer line under the clip
    foot = 'Built with Claude Code  ·  github.com/jtalbott22/wallpaper'
    fw = d.textlength(foot, font=f_small)
    d.text(((W - fw) / 2, MEDIA_Y + MEDIA + 34), foot, font=f_small, fill=DIM + (255,))

    frame = frame.convert('RGBA')
    frame.alpha_composite(ov)
    return frame.convert('RGB')


def main():
    out = os.path.join(HERE, 'aether-reel.mp4')
    clips = render_footage()
    base = build_static()
    f_small, f_pill, f_clock, f_label = font(28, 500), font(36, 760), font(42, 800), font(32, 650)
    total = END_CARD[1]
    n = int(total * FPS)
    ff = subprocess.Popen([
        'ffmpeg', '-y', '-loglevel', 'error',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-shortest', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p',
        '-profile:v', 'high', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '128k', out,
    ], stdin=subprocess.PIPE)
    cover = None
    for i in range(n):
        t = i / FPS
        clip, scene = footage_at(clips, min(t, sum(s[2] for s in SHOTS) - 1 / FPS))
        fr = compose(base, clip, scene, t, f_small, f_pill, f_clock, f_label)
        if abs(t - 13.0) < 1e-6:
            cover = fr
        for k, ts in enumerate((2.0, 9.0, 16.0, 20.5, 25.0)):
            if abs(t - ts) < 1e-6:
                fr.save(os.path.join(HERE, f'check-{k}.jpg'), quality=88)
        ff.stdin.write(fr.tobytes())
        if i % 150 == 0:
            print(f'frame {i}/{n}', flush=True)
    ff.stdin.close()
    ff.wait()
    if cover:
        cover.save(os.path.join(HERE, 'aether-reel-cover.jpg'), quality=92)
    print(out)


if __name__ == '__main__':
    main()
