"""Pre-rendered soft sprites, built by hand and cached.

pycairo (this system) has no gradient API, so all "gradients" are
synthesized pixel-by-pixel into small array-backed surfaces and then
scaled up with cairo - far cheaper per-frame than per-dot gradients.
"""
import math
import cairo

_CACHE = {}


def _write_pixel(buf, x, y, stride, r, g, b, a):
    off = (y * stride + x * 4)
    buf[off + 0] = b
    buf[off + 1] = g
    buf[off + 2] = r
    buf[off + 3] = a


def _build_rgba(buf, w, h, stride, r, g, b, alpha_fn):
    """alpha_fn(x, y) -> (0..255)."""
    for y in range(h):
        for x in range(w):
            a = alpha_fn(x, y)
            if a > 0:
                off = y * stride + x * 4
                # cairo ARGB32 is premultiplied: rgb stored scaled by alpha
                buf[off + 0] = (b * a) // 255
                buf[off + 1] = (g * a) // 255
                buf[off + 2] = (r * a) // 255
                buf[off + 3] = a
    return buf


def glow_sprite(rgb, size=128, inner_alpha=1.0, mid_alpha=0.45):
    rgb_i = tuple(int(round(c * 255)) for c in rgb)
    key = (rgb_i, size, round(inner_alpha, 2), round(mid_alpha, 2))
    surf = _CACHE.get(key)
    if surf is not None:
        return surf
    r, g, b = rgb_i
    buf = bytearray(size * size * 4)

    def alpha_fn(x, y):
        dx = (x - size / 2) / (size / 2)
        dy = (y - size / 2) / (size / 2)
        d = math.hypot(dx, dy)
        if d >= 1.0:
            return 0
        # wide soft falloff: bright core fading smoothly to nothing
        v = inner_alpha * (1.0 - d) ** 1.72
        return int(round(255 * v))

    buf = _build_rgba(buf, size, size, size * 4, r, g, b, alpha_fn)
    surf = cairo.ImageSurface.create_for_data(buf, cairo.FORMAT_ARGB32, size, size, size * 4)
    _CACHE[key] = surf
    return surf


def gradient_sprite(rgb, height, stops, width=8):
    """Vertical gradient from top (0) to bottom (height). stops: [(t, alpha)]."""
    key = (tuple(int(round(c * 255)) for c in rgb), height, tuple(stops), width)
    surf = _CACHE.get(key)
    if surf is not None:
        return surf
    r, g, b = (int(c * 255) for c in rgb)
    buf = bytearray(width * height * 4)

    def alpha_fn(x, y):
        t = y / max(1, height - 1)
        # piecewise linear interpolation across stops
        for i in range(len(stops) - 1):
            t0, a0 = stops[i]
            t1, a1 = stops[i + 1]
            if t0 <= t <= t1:
                u = (t - t0) / max(1e-6, t1 - t0)
                alpha = a0 + (a1 - a0) * u
                return int(round(255 * alpha))
        return int(round(255 * stops[-1][1]))

    _build_rgba(buf, width, height, width * 4, r, g, b, alpha_fn)
    surf = cairo.ImageSurface.create_for_data(buf, cairo.FORMAT_ARGB32, width, height, width * 4)
    _CACHE[key] = surf
    return surf


def bg_gradient_sprite(rgb, bg2_rgb, height=128, width=64):
    """Soft vertical background gradient between two colors."""
    key = ('bg', tuple(int(round(c * 255)) for c in rgb), tuple(int(round(c * 255)) for c in bg2_rgb), height, width)
    surf = _CACHE.get(key)
    if surf is not None:
        return surf
    buf = bytearray(width * height * 4)
    r0, g0, b0 = (int(c * 255) for c in rgb)
    r1, g1, b1 = (int(c * 255) for c in bg2_rgb)

    def alpha_fn(x, y):
        return 255

    for y in range(height):
        t = y / max(1, height - 1)
        r = int(r0 + (r1 - r0) * t)
        g = int(g0 + (g1 - g0) * t)
        bcol = int(b0 + (b1 - b0) * t)
        off = y * (width * 4)
        for x in range(width):
            buf[off + x * 4 + 0] = bcol
            buf[off + x * 4 + 1] = g
            buf[off + x * 4 + 2] = r
            buf[off + x * 4 + 3] = 255
    surf = cairo.ImageSurface.create_for_data(buf, cairo.FORMAT_ARGB32, width, height, width * 4)
    _CACHE[key] = surf
    return surf


def curtain_sprite(rgb, width=64, height=128):
    """Vertical curtain: soft horizontal edges + vertical fade (strongest at top)."""
    rgb_i = tuple(int(round(c * 255)) for c in rgb)
    key = ('curtain', rgb_i, width, height)
    surf = _CACHE.get(key)
    if surf is not None:
        return surf
    r, g, b = rgb_i
    buf = bytearray(width * height * 4)

    def alpha_fn(x, y):
        # horizontal: pin the ribbon to a soft "column"
        u = (x + 0.5) / width
        fall_x = math.sin(math.pi * u) ** 1.6
        # vertical: bright at top, staying visible (fading) toward the bottom
        v = y / height
        fall_y = (1.0 - v * 0.78) ** 1.35
        return int(round(255 * fall_x * fall_y))

    _build_rgba(buf, width, height, width * 4, r, g, b, alpha_fn)
    surf = cairo.ImageSurface.create_for_data(buf, cairo.FORMAT_ARGB32, width, height, width * 4)
    _CACHE[key] = surf
    return surf


def vgradient_sprite(rgb, stops, width=8, height=160):
    """Alias for gradient_sprite (semantic clarity)."""
    return gradient_sprite(rgb, height, stops, width)


def draw_glow(ctx, surf, x, y, size, alpha=1.0, operator=cairo.OPERATOR_OVER):
    if alpha <= 0.001 or size < 2:
        return
    sw = surf.get_width()
    sh = surf.get_height()
    ctx.save()
    ctx.set_operator(operator)
    ctx.translate(x - size / 2, y - size / 2)
    ctx.scale(size / sw, size / sh)
    ctx.set_source_surface(surf, 0, 0)
    if alpha >= 0.999:
        ctx.paint()
    else:
        ctx.paint_with_alpha(alpha)
    ctx.restore()


def draw_surface(ctx, surf, x, y, w, h, alpha=1.0, operator=cairo.OPERATOR_OVER):
    """Draw a surface at (x, y) with the given destination size."""
    if alpha <= 0.001 or w < 1 or h < 1:
        return
    sw = surf.get_width()
    sh = surf.get_height()
    ctx.save()
    ctx.set_operator(operator)
    ctx.translate(x, y)
    ctx.scale(w / sw, h / sh)
    ctx.set_source_surface(surf, 0, 0)
    if alpha >= 0.999:
        ctx.paint()
    else:
        ctx.paint_with_alpha(alpha)
    ctx.restore()


def fill_ellipse(ctx, cx, cy, rx, ry, source_rgba=None, alpha=1.0):
    """Fill an ellipse. pycairo has no ctx.ellipse, so fake it."""
    ctx.save()
    ctx.translate(cx, cy)
    ctx.scale(1.0, ry / max(1e-6, rx))
    ctx.arc(0, 0, rx, 0, 2 * math.pi)
    ctx.close_path()
    if source_rgba is not None:
        ctx.set_source_rgba(*source_rgba, alpha)
    ctx.fill()
    ctx.restore()
