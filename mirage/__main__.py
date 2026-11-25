"""Mirage: a live wallpaper that is never quite the same twice.

Usage:
    python3 -m mirage [--windowed | --wallpaper] [--seed N] [--scene NAME] [--palette NAME]
                      [--quality 0.30-1.00] [--fps F] [--debug]
    python3 -m mirage --preview OUT.png [--scene NAME] [--palette NAME]

Default: fullscreen, undecorated. Press Esc to quit.
"""
import argparse


def parse_args():
    ap = argparse.ArgumentParser(
        description='Mirage — an endlessly cycling animated live wallpaper.')
    ap.add_argument('--preview', metavar='OUT.png',
                    help='Render the first frame to a PNG and exit (no display needed).')
    ap.add_argument('--windowed', action='store_true',
                    help='Run in a normal window instead of fullscreen.')
    ap.add_argument('--wallpaper', action='store_true',
                    help='Run as a desktop wallpaper (used by the GNOME Shell extension): '
                         'no overlays or key controls, pauses on SIGUSR1, resumes on SIGUSR2, '
                         'drops to --battery-fps when unplugged.')
    ap.add_argument('--battery-fps', type=int, default=15,
                    help='Frame rate cap on battery in --wallpaper mode (default: 15).')
    ap.add_argument('--seed', type=int, default=None,
                    help='Seed for the initial scene/palette selection.')
    ap.add_argument('--scene', default=None, metavar='NAME',
                    help='Force the first scene (e.g. "Aurora Curtain").')
    ap.add_argument('--palette', default=None, metavar='NAME',
                    help='Force the first scene palette (e.g. "ember").')
    ap.add_argument('--quality', type=float, default=0.5,
                    help='Initial internal render scale, 0.30-1.00 (default: 0.5).')
    ap.add_argument('--fps', type=int, default=30,
                    help='Target frame rate (default: 30).')
    ap.add_argument('--debug', action='store_true',
                    help='Log scene changes and quality adjustments to stderr.')
    args = ap.parse_args()
    args.quality = min(1.0, max(0.30, args.quality))
    args.fullscreen = not args.windowed
    return args


def main():
    args = parse_args()
    if args.preview:
        # reuse the headless preview path
        from .preview import main as preview_main
        import sys
        argv = sys.argv
        sys.argv = ['mirage.preview', '--scene', args.scene or 'Nebula Drift',
                    '--palette', args.palette or 'midnight',
                    '--out', args.preview]
        preview_main()
        sys.argv = argv
        return

    from .app import MirageApp
    app = MirageApp(args)
    app.run()


if __name__ == '__main__':
    main()
