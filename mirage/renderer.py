"""Low-resolution frame renderer with crossfade support.

Frames render on a small internal surface (array-backed ImageSurface),
composited (with an optional fade of the previous frame), then upscaled
into a full-size display surface. The app feeds the display surface to a
GdkPixbuf whose size matches the window, so the Gtk widget needs no
scaling.
"""
import cairo


class Renderer:
    def __init__(self, screen_w, screen_h, quality=0.5):
        self.screen_w = screen_w
        self.screen_h = screen_h
        self.quality = quality
        self.buf = None
        self.surface = None
        self.ctx = None
        self.comp_buf = None
        self.comp_surface = None
        self.comp_ctx = None
        self.disp_buf = None
        self.disp_surface = None
        self.disp_ctx = None
        self.old_buf = None
        self.old_surface = None
        self.fade = 0.0
        self._build()

    def _build(self):
        w = max(8, int(self.screen_w * self.quality))
        h = max(8, int(self.screen_h * self.quality))
        self.buf = bytearray(w * h * 4)
        self.surface = cairo.ImageSurface.create_for_data(
            self.buf, cairo.FORMAT_ARGB32, w, h, w * 4)
        self.ctx = cairo.Context(self.surface)
        self.comp_buf = bytearray(w * h * 4)
        self.comp_surface = cairo.ImageSurface.create_for_data(
            self.comp_buf, cairo.FORMAT_ARGB32, w, h, w * 4)
        self.comp_ctx = cairo.Context(self.comp_surface)
        dw, dh = max(8, self.screen_w), max(8, self.screen_h)
        self.disp_buf = bytearray(dw * dh * 4)
        self.disp_surface = cairo.ImageSurface.create_for_data(
            self.disp_buf, cairo.FORMAT_ARGB32, dw, dh, dw * 4)
        self.disp_ctx = cairo.Context(self.disp_surface)

    @property
    def internal_size(self):
        return self.surface.get_width(), self.surface.get_height()

    def set_quality(self, quality):
        if abs(quality - self.quality) < 0.02:
            return
        self.quality = quality
        self.fade = 0.0
        self.old_buf = None
        self.old_surface = None
        self._build()

    def resize(self, screen_w, screen_h):
        self.screen_w = screen_w
        self.screen_h = screen_h
        self.fade = 0.0
        self.old_buf = None
        self.old_surface = None
        self._build()

    def begin_crossfade(self):
        """Snapshot the current internal frame so it can fade out."""
        self.old_buf = bytearray(self.buf)
        self.old_surface = None
        self.fade = 1.0

    def advance_fade(self, dt):
        if self.fade > 0.0:
            self.fade = max(0.0, self.fade - dt / 2.2)
            if self.fade == 0.0:
                self.old_buf = None
                self.old_surface = None

    def begin_frame(self):
        """Clear the internal surface so the scene can draw."""
        ctx = self.ctx
        ctx.save()
        ctx.set_operator(cairo.OPERATOR_SOURCE)
        ctx.set_source_rgb(0.0, 0.0, 0.0)
        ctx.paint()
        ctx.restore()

    def composite(self):
        """Compose the frame and upscale it into the display surface."""
        ctx = self.comp_ctx
        ctx.save()
        ctx.set_operator(cairo.OPERATOR_SOURCE)
        ctx.set_source_rgb(0.0, 0.0, 0.0)
        ctx.paint()
        ctx.restore()
        if self.old_buf is not None and self.fade > 0.001:
            if self.old_surface is None:
                w, h = self.internal_size
                self.old_surface = cairo.ImageSurface.create_for_data(
                    self.old_buf, cairo.FORMAT_ARGB32, w, h, w * 4)
            ctx.save()
            ctx.set_operator(cairo.OPERATOR_OVER)
            ctx.set_source_surface(self.old_surface, 0, 0)
            ctx.paint_with_alpha(self.fade)
            ctx.restore()
        if self.fade < 0.999:
            ctx.save()
            ctx.set_operator(cairo.OPERATOR_OVER)
            ctx.set_source_surface(self.surface, 0, 0)
            ctx.paint_with_alpha(1.0 - self.fade)
            ctx.restore()

        # upscale composite -> display surface
        iw, ih = self.internal_size
        dw, dh = self.disp_surface.get_width(), self.disp_surface.get_height()
        dctx = self.disp_ctx
        dctx.save()
        dctx.set_operator(cairo.OPERATOR_SOURCE)
        dctx.set_source_rgb(0.0, 0.0, 0.0)
        dctx.paint()
        dctx.restore()
        dctx.save()
        dctx.set_operator(cairo.OPERATOR_OVER)
        dctx.scale(dw / iw, dh / ih)
        dctx.set_source_surface(self.comp_surface, 0, 0)
        dctx.paint()
        dctx.restore()
        return self.disp_surface

    def get_display_data(self):
        return self.disp_buf

    def get_display_size(self):
        return self.disp_surface.get_width(), self.disp_surface.get_height()
