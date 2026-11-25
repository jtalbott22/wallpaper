"""Aether: a GPU live wallpaper.

    python3 -m aether                 # fullscreen; Space = next scene, Esc = quit
    python3 -m aether --windowed
    python3 -m aether --wallpaper     # what the GNOME Shell extension runs
    python3 -m aether --list
    python3 -m aether --preview out.png --scene Galaxy --time 40
    python3 -m aether --sheet out.png       # every scene at three moments
    python3 -m aether --bench               # per-scene GPU cost at 1920x1080
"""
import argparse
import sys


def parse_args():
    ap = argparse.ArgumentParser(description='Aether - particles, fluids and fractals as a live wallpaper.')
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument('--windowed', action='store_true', help='Run in a normal window.')
    mode.add_argument('--wallpaper', action='store_true',
                      help='Desktop-wallpaper mode for the GNOME Shell extension (SIGUSR1 pause / SIGUSR2 resume).')
    ap.add_argument('--scene', metavar='NAME', help='Show only this scene (see --list).')
    ap.add_argument('--seed', type=int, help='Seed for repeatable runs.')
    ap.add_argument('--fps', type=int, default=30, help='Target frame rate (default 30).')
    ap.add_argument('--battery-fps', type=int, default=20, help='Frame-rate cap on battery (default 20).')
    ap.add_argument('--quality', type=float, default=0.75,
                    help='Internal render scale relative to the screen, 0.4-1.0 (default 0.75).')
    ap.add_argument('--debug', action='store_true', help='Log scene changes and frame rate to stderr.')
    ap.add_argument('--list', action='store_true', help='List scenes and exit.')
    ap.add_argument('--preview', metavar='OUT.png', help='Render one frame headlessly and exit.')
    ap.add_argument('--time', type=float, default=20.0, help='Simulated seconds before --preview grabs a frame.')
    ap.add_argument('--size', default='1920x1080', help='Size for --preview/--sheet/--bench (WxH).')
    ap.add_argument('--sheet', metavar='OUT.png', help='Render a contact sheet of every scene and exit.')
    ap.add_argument('--bench', action='store_true', help='Measure per-scene GPU frame time and exit.')
    args = ap.parse_args()
    args.quality = min(1.0, max(0.4, args.quality))
    args.fullscreen = not args.windowed and not args.wallpaper
    return args


def main():
    args = parse_args()
    if args.list:
        from .scenes import REGISTRY
        for cls in REGISTRY:
            print(f'{cls.name:16s} {(cls.__doc__ or "").strip().splitlines()[0]}' if cls.__doc__ else cls.name)
        return
    if args.preview or args.sheet or args.bench:
        w, h = (int(v) for v in args.size.lower().split('x'))
        from . import preview
        if args.bench:
            preview.bench((w, h), quality=args.quality, scenes=[args.scene] if args.scene else None)
        elif args.sheet:
            from .scenes import REGISTRY
            names = [args.scene] if args.scene else [c.name for c in REGISTRY]
            preview.sheet(names, (w // 3, h // 3), [8.0, 35.0, 70.0], args.sheet,
                          seed=args.seed or 1, quality=min(1.0, args.quality * 3))
        else:
            from .headless import HeadlessContext
            HeadlessContext()
            name, shots = preview.render_frames(args.scene, (w, h), [args.time], seed=args.seed or 1,
                                                quality=args.quality, log=lambda *_: None)
            shots[0].save(args.preview)
            print(f'{name} -> {args.preview}')
        return
    from .app import AetherApp
    AetherApp(args).run()


if __name__ == '__main__':
    main()
