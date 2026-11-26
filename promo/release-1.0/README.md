# Aether 1.0 reel

How `promo/aether-1.0-reel.mp4` (1080×1920, 31 s, 30 fps) was made. The video
itself isn't in git; these scripts rebuild it.

1. **Scene footage:** `python3 render_native.py` renders Galaxy (vertical),
   Silk, Particle Life and Reaction frame by frame with the native GPU
   renderer into `foot-*/`.
2. **Website scroll:** `python3 capture_site.py` records the site (served
   from a local copy of joshuaallentalbott.com) in headless Chromium on the
   GPU into `foot-site/`: a scroll down and back up, then the Aether popover.
   Each frame takes about half a second, so the page's animation runs at a
   tenth of its speed (`Aether.speed(0.1)`).
3. **Ubuntu desktop:** `chrome/` holds stills of a real headless GNOME Shell
   (`--mode=ubuntu`) with the extension installed, taken once over a black
   wallpaper and once over a white one (`black-*.png`, `white-*.png`) for the
   plain desktop, the Aether menu and Scenes in Rotation. `pass-*.png` is
   white minus black. A frame is `black + pass × footage`, which keeps the
   real panels' transparency.
4. **Compose:** `python3 compose.py` draws the captions, the macOS and
   Windows desktops (no Apple or Microsoft logos) and the end card, and
   pipes the frames to ffmpeg. `python3 compose.py 45 378` renders just those
   frames as `check-*.jpg` for a quick look.

Lessons: Playwright's fake clock gave blank and flashing frames with WebGL,
and GNOME's screenshot call is too slow (~0.7 s at 1080p) to record video
directly; hence real-time capture for the site and the black/white trick
for GNOME.
