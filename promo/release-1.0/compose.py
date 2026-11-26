"""Aether 1.0 reel: 1080x1920, 30 fps. Real GPU footage, the real Ubuntu desktop,
macOS and Windows desktops drawn around real footage, and a scroll of the site."""
import os
import subprocess
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = '/home/jtalbott/wallpaper/promo'
W, H, FPS = 1080, 1920, 30
ACCENT, GOOD, VIOLET = (120, 226, 255), (124, 255, 178), (195, 181, 255)
INK, DIM = (255, 255, 255), (172, 180, 192)
SANS = '/usr/share/fonts/truetype/ubuntu/UbuntuSans[wdth,wght].ttf'
_fonts = {}


def font(size, weight=800):
    k = (size, weight)
    if k not in _fonts:
        f = ImageFont.truetype(SANS, size)
        try:
            f.set_variation_by_axes([100, weight])
        except Exception:
            pass
        _fonts[k] = f
    return _fonts[k]


def smooth(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


def lerp(a, b, u):
    return a + (b - a) * u


def frames(name):
    d = os.path.join(HERE, 'foot-' + name)
    return [os.path.join(d, f) for f in sorted(os.listdir(d))]


# ---------------------------------------------------------------- timeline (seconds)
SEG = [('hook', 0.0, 3.0), ('ubuntu', 3.0, 9.6), ('mac', 9.6, 14.2), ('windows', 14.2, 18.8),
       ('web', 18.8, 26.6), ('end', 26.6, 31.0)]
TOTAL = SEG[-1][2]


def seg_at(t):
    for name, a, b in SEG:
        if a <= t < b:
            return name, t - a, b - a
    return SEG[-1][0], t - SEG[-1][1], SEG[-1][2] - SEG[-1][1]


# ---------------------------------------------------------------- shared art
def aether_icon(size, col=(255, 255, 255)):
    s = size * 4
    im = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    k = s / 18.0
    r = 6.5 * k
    d.ellipse((9 * k - r, 9 * k - r, 9 * k + r, 9 * k + r), outline=col, width=max(1, int(1.4 * k)))
    d.ellipse((5.5 * k, 5 * k, 10.5 * k, 10 * k), fill=col)
    pts = []
    for i in range(41):
        t = i / 40
        bx = (1 - t) ** 3 * 4.5 + 3 * (1 - t) ** 2 * t * 7 + 3 * (1 - t) * t * t * 12 + t ** 3 * 13.5
        by = (1 - t) ** 3 * 11 + 3 * (1 - t) ** 2 * t * 14.5 + 3 * (1 - t) * t * t * 13 + t ** 3 * 9
        pts.append((bx * k, by * k))
    d.line(pts, fill=col, width=max(1, int(1.2 * k)), joint='curve')
    return im.resize((size, size), Image.LANCZOS)


def rounded_mask(size, r):
    w, h = size
    m = Image.new('L', (w * 2, h * 2), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, w * 2 - 1, h * 2 - 1), r * 2, fill=255)
    return m.resize((w, h), Image.LANCZOS)


def backdrop(img):
    """The scene, blurred and darkened, filling the vertical frame."""
    sw, sh = img.size
    k = max(W / sw, H / sh)
    small = img.resize((max(1, int(sw * k / 8)), max(1, int(sh * k / 8))), Image.BILINEAR)
    small = small.filter(ImageFilter.GaussianBlur(6))
    big = small.resize((int(sw * k), int(sh * k)), Image.BILINEAR)
    x, y = (big.width - W) // 2, (big.height - H) // 2
    big = big.crop((x, y, x + W, y + H))
    return Image.blend(big, Image.new('RGB', (W, H), (0, 0, 0)), 0.55)


def screen(frame_img, crop, box_w, radius=26):
    """A desktop shown on a rounded screen: crop (x0,y0,x1,y1) of the 1920x1080 frame."""
    x0, y0, x1, y1 = crop
    view = frame_img.crop((int(x0), int(y0), int(x1), int(y1))).resize((box_w, int(box_w * 9 / 16)), Image.LANCZOS)
    return view, rounded_mask(view.size, radius)


def paste_with_shadow(base, img, mask, xy):
    sh = Image.new('L', (img.width + 120, img.height + 120), 0)
    sh.paste(mask, (60, 60))
    sh = sh.filter(ImageFilter.GaussianBlur(28))
    base.paste((0, 0, 0), (xy[0] - 60, xy[1] - 40), sh.point(lambda v: v * 0.75))
    base.paste(img, xy, mask)
    ov = Image.new('RGBA', base.size, (0, 0, 0, 0))
    ImageDraw.Draw(ov).rounded_rectangle((xy[0], xy[1], xy[0] + img.width - 1, xy[1] + img.height - 1), 26,
                                         outline=(255, 255, 255, 46), width=2)
    base.alpha_composite(ov)


def zoom_crop(u, focus, z):
    """Crop rectangle easing from the full 1920x1080 frame to zoom z around focus."""
    z = lerp(1.0, z, smooth(u))
    cw, ch = 1920 / z, 1080 / z
    fx, fy = focus
    x0 = min(max(fx - cw / 2, 0), 1920 - cw)
    y0 = min(max(fy - ch / 2, 0), 1080 - ch)
    x0 = lerp(0, x0, smooth(u)) if z > 1.0001 else 0
    y0 = lerp(0, y0, smooth(u)) if z > 1.0001 else 0
    return (x0, y0, x0 + cw, y0 + ch)


# ---------------------------------------------------------------- Ubuntu (real GNOME chrome)
CH = {}
for st in ('desk', 'menu', 'rot'):
    CH[st] = (Image.open(os.path.join(HERE, 'chrome', f'black-{st}.png')).convert('RGB'),
              Image.open(os.path.join(HERE, 'chrome', f'pass-{st}.png')).convert('RGB'))


def ubuntu_desktop(x, state):
    b, p = CH[state]
    return ImageChops.add(b, ImageChops.multiply(p, x))


# ---------------------------------------------------------------- macOS (drawn)
def menu_panel(items, width, f, row=34, sep=12, pad=8, radius=12, fill=(36, 36, 40, 232), sub=None):
    """A dark menu; items are text, '-' for a separator, or tuples (text, kind, extra)."""
    hgt = pad * 2
    for it in items:
        hgt += sep if it == '-' else (row + 14 if isinstance(it, tuple) and it[1] == 'slider' else row)
    im = Image.new('RGBA', (width, hgt), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, width - 1, hgt - 1), radius, fill=fill, outline=(255, 255, 255, 38), width=1)
    y = pad
    for it in items:
        if it == '-':
            d.line((14, y + sep // 2, width - 14, y + sep // 2), fill=(255, 255, 255, 36), width=1)
            y += sep
            continue
        text, kind, extra = it if isinstance(it, tuple) else (it, 'item', None)
        col = (150, 152, 160) if kind == 'dim' else (236, 238, 242)
        if kind == 'slider':
            d.text((22, y + 4), text, font=f, fill=(150, 152, 160))
            yy = y + row + 2
            d.rounded_rectangle((22, yy - 3, width - 22, yy + 3), 3, fill=(255, 255, 255, 60))
            kx = 22 + (width - 44) * 0.62
            d.rounded_rectangle((22, yy - 3, kx, yy + 3), 3, fill=(10, 132, 255))
            d.ellipse((kx - 10, yy - 10, kx + 10, yy + 10), fill=(240, 240, 244))
            y += row + 14
            continue
        if kind == 'check':
            d.text((10, y + 5), '✓', font=f, fill=col)
        d.text((32, y + 5), text, font=f, fill=col)
        if kind == 'sub':
            d.text((width - 26, y + 4), '›', font=f, fill=(170, 172, 180))
        if extra:
            fx = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', f.size - 1)
            tw = d.textlength(extra, font=fx)
            d.text((width - 20 - tw, y + 6), extra, font=fx, fill=(150, 152, 160))
        y += row
    return im


def mac_desktop(x, menu_u):
    img = x.copy()
    d = ImageDraw.Draw(img, 'RGBA')
    layers = []
    bar = 38
    d.rectangle((0, 0, 1920, bar), fill=(18, 18, 22, 150))
    f = font(21, 560)
    fb = font(21, 760)
    xx = 26
    for i, word in enumerate(['Finder', 'File', 'Edit', 'View', 'Go', 'Window', 'Help']):
        d.text((xx, 8), word, font=fb if i == 0 else f, fill=(245, 245, 248))
        xx += d.textlength(word, font=fb if i == 0 else f) + 30
    # right side: Aether, battery, Wi-Fi, clock
    clock = 'Thu Nov 26  9:41 PM'
    cw = d.textlength(clock, font=f)
    d.text((1920 - 24 - cw, 8), clock, font=f, fill=(245, 245, 248))
    bx = 1920 - 24 - cw - 62
    d.rounded_rectangle((bx, 12, bx + 34, 27), 4, outline=(245, 245, 248), width=2)
    d.rectangle((bx + 4, 16, bx + 24, 23), fill=(245, 245, 248))
    d.rectangle((bx + 35, 17, bx + 38, 22), fill=(245, 245, 248))
    ax = bx - 60
    if menu_u > 0:
        d.rounded_rectangle((ax - 8, 4, ax + 34, bar - 4), 6, fill=(255, 255, 255, int(60 * min(1, menu_u * 3))))
    layers.append((aether_icon(26), (int(ax), 6)))
    # dock
    n, s, gap = 9, 74, 14
    dw = n * s + (n + 1) * gap
    dx, dy = (1920 - dw) // 2, 1080 - s - 34
    d.rounded_rectangle((dx, dy - gap, dx + dw, 1080 - 14), 26, fill=(40, 40, 46, 120), outline=(255, 255, 255, 50), width=1)
    cols = [(10, 132, 255), (52, 199, 89), (255, 159, 10), (255, 69, 58), (191, 90, 242),
            (100, 210, 255), (255, 214, 10), (172, 142, 104), (142, 142, 147)]
    for i, c in enumerate(cols):
        x0 = dx + gap + i * (s + gap)
        d.rounded_rectangle((x0, dy, x0 + s, dy + s), 18, fill=c + (235,))
        d.rounded_rectangle((x0 + 14, dy + 14, x0 + s - 14, dy + s - 14), 10, outline=(255, 255, 255, 140), width=4)
    if menu_u > 0:
        items = [('Running · Particle Life', 'dim', None), '-', ('Brightness  100%', 'slider', None), '-',
                 'Pause', ('Scene', 'sub', None), ('Quality', 'sub', None), '-',
                 ('Show the Math (?)', 'item', '⇧⌘/'), ('Show the Math When a Scene Starts', 'check', None), '-',
                 ('Open at Login', 'check', None), '-', ('Reload', 'item', '⌘R'), 'Show Log', '-',
                 ('Quit Aether', 'item', '⌘Q')]
        panel = menu_panel(items, 540, font(21, 520))
        a = smooth(menu_u * 2.5)
        if a < 1:
            panel.putalpha(panel.getchannel('A').point(lambda v: int(v * a)))
        layers.append((panel, (int(min(ax - 18, 1920 - panel.width - 14)), bar + 6)))
    img = img.convert('RGBA')
    for im, xy in layers:
        img.alpha_composite(im, xy)
    return img.convert('RGB')


# ---------------------------------------------------------------- Windows (drawn)
def win_desktop(x, menu_u):
    img = x.copy()
    d = ImageDraw.Draw(img, 'RGBA')
    layers = []
    tb = 62
    d.rectangle((0, 1080 - tb, 1920, 1080), fill=(28, 30, 36, 205))
    d.line((0, 1080 - tb, 1920, 1080 - tb), fill=(255, 255, 255, 30))
    # centred: search pill and a few app tiles (generic, no logos)
    cx = 960
    d.rounded_rectangle((cx - 330, 1080 - tb + 12, cx - 110, 1080 - 12), 19, fill=(255, 255, 255, 26))
    d.text((cx - 300, 1080 - tb + 18), 'Search', font=font(20, 480), fill=(205, 208, 214))
    cols = [(0, 120, 212), (255, 185, 0), (16, 137, 62), (232, 17, 35), (136, 23, 152)]
    for i, c in enumerate(cols):
        x0 = cx - 90 + i * 56
        d.rounded_rectangle((x0, 1080 - tb + 13, x0 + 36, 1080 - 13), 8, fill=c + (230,))
    # tray: ^, Aether, Wi-Fi, speaker, clock
    f = font(18, 520)
    tx = 1920 - 20
    for line, yy in (('9:41 PM', 1080 - tb + 9), ('11/26/2026', 1080 - tb + 32)):
        w = d.textlength(line, font=f)
        d.text((tx - w, yy), line, font=f, fill=(240, 242, 246))
    tx -= 140
    d.arc((tx, 1080 - tb + 18, tx + 26, 1080 - tb + 44), 200, 340, fill=(240, 242, 246), width=3)
    d.arc((tx + 6, 1080 - tb + 25, tx + 20, 1080 - tb + 39), 200, 340, fill=(240, 242, 246), width=3)
    ax = tx - 56
    if menu_u > 0:
        d.rounded_rectangle((ax - 9, 1080 - tb + 8, ax + 37, 1080 - 8), 6, fill=(255, 255, 255, int(50 * min(1, menu_u * 3))))
    layers.append((aether_icon(28), (int(ax), 1080 - tb + 17)))
    d.text((ax - 40, 1080 - tb + 14), '^', font=font(24, 500), fill=(240, 242, 246))
    if menu_u > 0:
        items = [('Running · Reaction', 'dim', None), '-', ('Brightness  100%', 'slider', None), '-',
                 'Pause', ('Scene: All, in turn', 'sub', None), 'Next scene', ('Start at login', 'check', None), '-',
                 'Open Aether in browser', 'Reload', 'Open log folder', 'Exit']
        panel = menu_panel(items, 420, font(20, 480), row=36, radius=10, fill=(44, 44, 48, 240))
        a = smooth(menu_u * 2.5)
        if a < 1:
            panel.putalpha(panel.getchannel('A').point(lambda v: int(v * a)))
        layers.append((panel, (int(min(1920 - 440, ax - 200)), 1080 - tb - 10 - panel.height)))
    img = img.convert('RGBA')
    for im, xy in layers:
        img.alpha_composite(im, xy)
    return img.convert('RGB')


# ---------------------------------------------------------------- browser (the site)
def browser(site_img, url='joshuaallentalbott.com'):
    sw = 1200
    page = site_img.resize((sw, int(site_img.height * sw / site_img.width)), Image.LANCZOS)
    bar = 58
    win = Image.new('RGB', (sw, page.height + bar), (32, 34, 40))
    d = ImageDraw.Draw(win)
    for i, c in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
        d.ellipse((22 + i * 28, 21, 38 + i * 28, 37), fill=c)
    d.rounded_rectangle((150, 12, sw - 150, bar - 12), 17, fill=(52, 55, 62))
    lock = '🔒'
    tw = d.textlength(url, font=font(20, 520))
    d.text(((sw - tw) / 2, 18), url, font=font(20, 520), fill=(220, 224, 230))
    win.paste(page, (0, bar))
    return win


def tilt(img, amount):
    """A gentle 3D tilt (perspective) that eases away as amount -> 0."""
    if amount < 0.002:
        return img.convert('RGBA')
    w, h = img.size
    dx = w * 0.10 * amount
    dy = h * 0.05 * amount
    # target quad: top edge narrower (leaning back)
    src = [(0, 0), (w, 0), (w, h), (0, h)]
    dst = [(dx, dy), (w - dx, dy), (w, h), (0, h)]
    coeffs = _persp(dst, src)
    return img.convert('RGBA').transform((w, h), Image.PERSPECTIVE, coeffs, Image.BICUBIC)


def _persp(pa, pb):
    import itertools
    m = []
    for (x, y), (X, Y) in zip(pa, pb):
        m.append([x, y, 1, 0, 0, 0, -X * x, -X * y])
        m.append([0, 0, 0, x, y, 1, -Y * x, -Y * y])
    b = [c for p in pb for c in p]
    # solve 8x8
    n = 8
    a = [row[:] + [b[i]] for i, row in enumerate(m)]
    for c in range(n):
        piv = max(range(c, n), key=lambda r: abs(a[r][c]))
        a[c], a[piv] = a[piv], a[c]
        for r in range(n):
            if r != c:
                f = a[r][c] / a[c][c]
                a[r] = [x - f * y for x, y in zip(a[r], a[c])]
    return [a[i][n] / a[i][i] for i in range(n)]


# ---------------------------------------------------------------- captions
def caption(d, lines, y, sizes=(74,), fade=1.0):
    """lines: list of [(text, colour), ...]; centred."""
    for li, words in enumerate(lines):
        f = font(sizes[min(li, len(sizes) - 1)], 820)
        total = sum(d.textlength(t, font=f) for t, _ in words) + d.textlength(' ', font=f) * (len(words) - 1)
        x = (W - total) / 2
        for t, c in words:
            d.text((x, y), t, font=f, fill=c + (int(255 * fade),))
            x += d.textlength(t + ' ', font=f)
        y += int(f.size * 1.2)
    return y


def platform_pills(d, done, y=1690):
    names = ['Linux', 'macOS', 'Windows', 'Web']
    f = font(34, 760)
    pw, ph, gap = 218, 70, 18
    x = (W - (4 * pw + 3 * gap)) // 2
    for i, n in enumerate(names):
        on = i < done
        if on:
            d.rounded_rectangle((x, y, x + pw, y + ph), 35, fill=(10, 18, 24, 235), outline=GOOD + (255,), width=3)
        else:
            d.rounded_rectangle((x, y, x + pw, y + ph), 35, fill=(0, 0, 0, 150), outline=(255, 255, 255, 70), width=2)
        label = ('✓ ' if on else '') + n
        tw = d.textlength(label, font=f)
        d.text((x + (pw - tw) / 2, y + 14), label, font=f, fill=GOOD if on else (205, 210, 218))
        x += pw + gap


def account_row(base):
    d = ImageDraw.Draw(base, 'RGBA')
    av, ax, ay = 76, 60, 120
    d.ellipse((ax, ay, ax + av, ay + av), fill=(14, 20, 26, 230), outline=(255, 255, 255, 50), width=2)
    base.alpha_composite(aether_icon(48), (ax + 14, ay + 14))
    d.text((ax + av + 20, ay + 6), 'Aether', font=font(34, 800), fill=INK)
    d.text((ax + av + 20, ay + 44), 'joshuaallentalbott.com', font=font(26, 450), fill=DIM)
    # release tag
    tag = 'v1.0'
    tw = d.textlength(tag, font=font(30, 800))
    d.rounded_rectangle((W - 60 - tw - 36, ay + 16, W - 60, ay + 62), 23, fill=(120, 226, 255, 40), outline=ACCENT + (255,), width=2)
    d.text((W - 60 - tw - 18, ay + 21), tag, font=font(30, 800), fill=ACCENT)


# ---------------------------------------------------------------- frames
FOOT = {k: frames(k) for k in ('hook', 'ubuntu', 'mac', 'windows', 'site')}
CAPTIONS = {
    'ubuntu':  [[('On', INK), ('Ubuntu,', ACCENT)], [('it', INK), ('lives', INK), ('in', INK), ('the', INK), ('top', INK), ('bar', INK)]],
    'mac':     [[('On', INK), ('macOS,', ACCENT)], [('in', INK), ('the', INK), ('menu', INK), ('bar', INK)]],
    'windows': [[('On', INK), ('Windows,', ACCENT)], [('in', INK), ('the', INK), ('tray', INK)]],
    'web':     [[('And', INK), ('behind', INK), ('my', INK)], [('website', GOOD)]],
}
SCREEN_W, SCREEN_Y = 1000, 620
FEATURES = {
    'ubuntu':  ['Brightness · Scene picker · Quality', 'Scenes in rotation · The math on screen'],
    'mac':     ['Every screen, every Space', 'Pauses when covered or on Low Power'],
    'windows': ['Behind the icons on every monitor', 'Pauses in battery saver'],
    'web':     ['One file, no dependencies', 'Follows light and dark themes'],
}


def feature(d, name, y, u):
    a = smooth((u - 0.5) / 0.6)
    f = font(40, 600)
    for i, line in enumerate(FEATURES[name]):
        tw = d.textlength(line, font=f)
        d.text(((W - tw) / 2, y + i * 58), line, font=f, fill=(214, 220, 230, int(255 * a)))


def pick(name, i):
    fs = FOOT[name]
    return Image.open(fs[min(i, len(fs) - 1)]).convert('RGB')


def make_frame(n):
    t = n / FPS
    name, u, dur = seg_at(t)
    k = int(u * FPS)
    base = None

    if name in ('hook', 'end'):
        idx = k if name == 'hook' else int((3.0 + u) * FPS)
        img = pick('hook', idx)
        if name == 'end':
            img = Image.blend(img, Image.new('RGB', img.size, (0, 0, 0)), 0.45 * smooth(u / 0.8))
        base = img.convert('RGBA')
        ov = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(ov)
        account_row(ov)
        if name == 'hook':
            a = smooth(u / 0.5)
            d.text(((W - d.textlength('Aether 1.0', font=font(150, 860))) / 2, 700), 'Aether 1.0', font=font(150, 860), fill=INK + (int(255 * a),))
            caption(d, [[('is', INK), ('out', GOOD)]], 880, sizes=(84,), fade=a)
            b2 = smooth((u - 0.6) / 0.6)
            caption(d, [[('A', DIM), ('live', DIM), ('wallpaper', DIM), ('that', DIM), ('never', DIM), ('repeats', DIM)]], 1010, sizes=(44,), fade=b2)
        else:
            a = smooth(u / 0.6)
            ic = aether_icon(170)
            ic.putalpha(ic.getchannel('A').point(lambda v: int(v * a)))
            ov.alpha_composite(ic, ((W - 170) // 2, 520))
            y = caption(d, [[('Aether', INK), ('1.0', ACCENT)]], 730, sizes=(110,), fade=a)
            y = caption(d, [[('16', GOOD), ('living', INK), ('GPU', INK), ('scenes', INK)],
                            [('free', INK), ('&', DIM), ('open', INK), ('source', INK)]], y + 20, sizes=(52,), fade=smooth((u - 0.3) / 0.6))
            caption(d, [[('Try', DIM), ('it', DIM), ('in', DIM), ('your', DIM), ('browser', DIM)]], y + 70, sizes=(36,), fade=smooth((u - 0.7) / 0.6))
            caption(d, [[('joshuaallentalbott.com/aether.html', ACCENT)]], y + 120, sizes=(44,), fade=smooth((u - 0.7) / 0.6))
            caption(d, [[('Download:', DIM), ('github.com/jtalbott22/wallpaper', INK)]], y + 220, sizes=(34,), fade=smooth((u - 1.1) / 0.6))
            platform_pills(d, 4)
        base.alpha_composite(ov)
        return base.convert('RGB')

    if name == 'web':
        site = pick('site', k)
        win = browser(site)
        tl = tilt(win, 1 - smooth(u / 1.6))
        bg = backdrop(pick('hook', 100 + k // 2))
        base = bg.convert('RGBA')
        sc = 0.86 + 0.04 * smooth(u / dur)
        tw = int(W * sc)
        tl = tl.resize((tw, int(tl.height * tw / tl.width)), Image.LANCZOS)
        m = rounded_mask(tl.size, 22)
        m = ImageChops.multiply(m, tl.getchannel('A'))
        x, y = (W - tl.width) // 2, 620
        paste_with_shadow(base, tl.convert('RGB'), m, (x, y))
        ov = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(ov)
        account_row(ov)
        caption(d, CAPTIONS['web'], 300, sizes=(78,), fade=smooth(u / 0.4))
        feature(d, 'web', y + tl.height + 70, u)
        platform_pills(d, 4 if u > 0.5 else 3)
        base.alpha_composite(ov)
        return base.convert('RGB')

    # desktops
    x = pick(name, k)
    if name == 'ubuntu':
        state = 'desk' if u < 1.6 else ('menu' if u < 3.4 else 'rot')
        desk = ubuntu_desktop(x, state)
        zu = smooth((u - 1.3) / 1.0) * (1 - smooth((u - 5.7) / 0.8))
        crop = zoom_crop(zu, (1640, 560), 1.75)
        done = 1
    elif name == 'mac':
        mu = max(0.0, (u - 1.0) / 2.6) if u > 1.0 else 0.0
        desk = mac_desktop(x, min(1.0, mu * 2.6) if u > 1.0 else 0)
        zu = smooth((u - 0.9) / 0.9) * (1 - smooth((u - 3.9) / 0.6))
        crop = zoom_crop(zu, (1560, 330), 1.7)
        done = 2
    else:
        mu = (u - 1.0) if u > 1.0 else 0
        desk = win_desktop(x, min(1.0, mu))
        zu = smooth((u - 0.9) / 0.9) * (1 - smooth((u - 3.9) / 0.6))
        crop = zoom_crop(zu, (1560, 760), 1.7)
        done = 3
    bg = backdrop(x)
    base = bg.convert('RGBA')
    view, mask = screen(desk, crop, int(SCREEN_W * (0.97 + 0.05 * smooth(u / dur))))
    # a slow push-in on the whole screen
    paste_with_shadow(base, view, mask, ((W - view.width) // 2, SCREEN_Y))
    ov = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    account_row(ov)
    caption(d, CAPTIONS[name], 300, sizes=(78,), fade=smooth(u / 0.35))
    feature(d, name, SCREEN_Y + view.height + 80, u)
    platform_pills(d, done if u > 0.6 else done - 1)
    base.alpha_composite(ov)
    return base.convert('RGB')


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, 'aether-1.0-reel.mp4')
    n = int(TOTAL * FPS)
    only = [int(a) for a in sys.argv[1:]]
    if only:
        for i in only:
            make_frame(i).save(os.path.join(HERE, f'check-{i:04d}.jpg'), quality=88)
        return
    ff = subprocess.Popen([
        'ffmpeg', '-y', '-loglevel', 'error',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-shortest', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p',
        '-profile:v', 'high', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '128k', out,
    ], stdin=subprocess.PIPE)
    for i in range(n):
        fr = make_frame(i)
        if i == int(23.0 * FPS):
            fr.save(os.path.join(OUT_DIR, 'aether-1.0-reel-cover.jpg'), quality=92)
        ff.stdin.write(fr.tobytes())
        if i % 150 == 0:
            print(f'frame {i}/{n}', flush=True)
    ff.stdin.close()
    ff.wait()
    print(out)


if __name__ == '__main__':
    main()
