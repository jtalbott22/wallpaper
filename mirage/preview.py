"""Headless preview: render a scene to a PNG without any display."""
import argparse
from pathlib import Path

import cairo

from .palettes import PALETTES
from .scenes.registry import SCENES, BY_NAME
from .util import RNG


def _palette_by_name(name):
    for p in PALETTES:
        if p.name == name:
            return p
    return PALETTES[0]


def _parse_size(spec):
    w, h = spec.lower().split('x')
    return int(w), int(h)


def main():
    ap = argparse.ArgumentParser(description="Render a Mirage scene to a PNG.")
    ap.add_argument('--scene', '-s', required=True, choices=sorted(BY_NAME))
    ap.add_argument('--palette', '-p', default='midnight',
                    choices=[p.name for p in PALETTES])
    ap.add_argument('--size', '-z', default='960x540')
    ap.add_argument('--frames', '-n', type=int, default=5)
    ap.add_argument('--dt', type=float, default=1.0 / 30.0)
    ap.add_argument('--elapsed', '-e', type=float, default=1.5)
    ap.add_argument('--pointer', default='0.5,0.5', help="pointer x,y as fractions")
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--out', '-o', required=True)
    args = ap.parse_args()

    width, height = _parse_size(args.size)
    palette = _palette_by_name(args.palette)
    scene_cls = BY_NAME[args.scene]
    rng = RNG(args.seed)
    scene = scene_cls(rng, palette, width, height)
    px, py = (float(v) for v in args.pointer.split(','))
    pointer = (px, py)

    buf = bytearray(width * height * 4)
    surf = cairo.ImageSurface.create_for_data(buf, cairo.FORMAT_ARGB32, width, height, width * 4)
    ctx = cairo.Context(surf)

    elapsed = args.elapsed
    for i in range(args.frames):
        scene.update(args.dt, elapsed, pointer)
        elapsed += args.dt

    # clear then draw final frame
    ctx.save()
    ctx.set_operator(cairo.OPERATOR_SOURCE)
    ctx.paint()
    ctx.restore()
    scene.draw(ctx, elapsed, pointer)

    surf.write_to_png(args.out)
    print(f"wrote {args.out}  ({width}x{height}, scene={scene_cls.name}, palette={palette.name})")


if __name__ == '__main__':
    main()
