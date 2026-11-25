# Aether

*A GPU live wallpaper of particles, fluids and fractals that never repeats.*

Aether runs ten simulations on the graphics chip and drifts between them
with slow, organic dissolves:

| Scene | What you see |
|---|---|
| **Silk** | 262k particles riding 3D curl noise, leaving luminous threads that keep re-braiding |
| **Physarum** | half a million slime-mold agents growing living transport networks; up to three rival species |
| **Attractor** | Clifford / de Jong maps piled into glowing density fields that fold and re-bloom (sometimes kaleidoscopic) |
| **Reaction** | Gray-Scott reaction-diffusion as lit enamel: coral, mitosis, mazes and spirals invading each other |
| **Ink** | a stable-fluids simulation stirred by unseen brushes that bleed coloured ink |
| **Julia** | Julia sets of z²+c as c glides along the edge of the Mandelbrot set |
| **Particle Life** | species with asymmetric attractions forming cells, worms and chasers; heat waves melt crystal into gas |
| **Galaxy** | spiral galaxies on a close encounter, throwing out tidal tails and bridges |
| **Chaos** | 3D strange attractors (Lorenz, Aizawa, Thomas, Halvorsen, Dadras, Rössler) pouring from one shape into the next |
| **Nebula** | a calm interlude of domain-warped gas and twinkling stars |

**Why it doesn't feel like it's on repeat:** every appearance of a scene
gets a fresh random seed, shape, palette and duration, and while it's on
screen its parameters glide between random waypoints (feed/kill rates,
sensor angles, attraction matrices, attractor coefficients, camera paths,
palettes). Some scenes also have events: new seeds in Reaction, heat waves in
Particle Life, morphs between systems in Chaos, the collision in Galaxy. The
scheduler avoids the last four scenes.

**Calm by design:** slow cameras and parameter drift, no hard cuts,
bloom and filmic tone-mapping with soft highlights, dithering against
banding, and a gentle auto-exposure so scenes sit at similar brightness.

## Requirements

- OpenGL 4.3 (any Intel HD 5xx / UHD 6xx or newer with Mesa; most GPUs from
  the last decade)
- `python3` with PyGObject and GTK 4 (`gir1.2-gtk-4.0`). No pip installs:
  OpenGL is called through a small ctypes layer (`aether/gl.py`)
- Pillow (optional, only for `--preview` / `--sheet`)

## Performance (i7-8550U, Intel UHD 620, 1920x1080)

GPU time per frame with the default quality (simulations at 75% of screen
resolution) ranges from about 5 ms (Chaos, Galaxy) to about 12–14 ms
(Reaction, Julia, Attractor, Particle Life), against a 33 ms budget at
30 fps. CPU use is about 5% of one core. On battery it drops to 20 fps, and
the extension pauses it entirely when a maximized or fullscreen window
covers the screen or the screen is locked. Measure your own machine with
`python3 -m aether --bench`.

## Use it as your desktop wallpaper (GNOME / Wayland)

A normal Wayland app can't put itself behind the desktop, so the repository
ships a small GNOME Shell extension (`gnome-extension/`) that does it:

- launches `python3 -m aether --wallpaper` at login and restarts it if it
  exits (and falls back to the older CPU renderer, Mirage, if Aether keeps
  failing, e.g. no OpenGL 4.3)
- moves its window into the desktop layer (below Desktop Icons and every
  other window), on all workspaces, hidden from the dock, Alt-Tab and Overview
- sizes it to the primary monitor
- **pauses rendering** while a maximized or fullscreen window covers the
  primary monitor, and while the screen is locked

Install (GNOME Shell 48–51):

```sh
./install-wallpaper.sh                    # install + enable, then log out and back in once
./install-wallpaper.sh --engine mirage    # use the original CPU renderer instead
./install-wallpaper.sh --uninstall
```

Wayland only picks up a new extension, or changes to `extension.js`, after
you log out and back in. Re-run the script after moving the repository,
since it records the repository path. Logs:
`journalctl --user -b | grep -i mirage`.

Limits: the wallpaper covers the primary monitor only, and it doesn't react
to the mouse (the desktop window doesn't receive pointer events).

## Run it by hand

```sh
python3 -m aether                        # fullscreen: Space/N next scene, P pause, F11, Esc quit
python3 -m aether --windowed --debug     # in a window, logging scene changes and fps
python3 -m aether --scene "Galaxy"       # stay on one scene (see --list)
python3 -m aether --list
python3 -m aether --bench                # per-scene GPU frame time at 1920x1080
python3 -m aether --preview out.png --scene Physarum --time 40
python3 -m aether --sheet sheet.png      # every scene at 8s, 35s and 70s
```

Options: `--seed N`, `--fps F` (default 30), `--battery-fps F` (20),
`--quality Q` (0.4–1.0 of screen resolution for the simulations, default
0.75; lower it on weaker GPUs), `--size WxH` for the headless modes.

## Aether layout

```
aether/
  app.py        GTK 4 GLArea front end, frame pacing, wallpaper signals, battery
  engine.py     scene scheduling, noise dissolves, bloom, ACES tone map, auto-exposure
  gl.py         ctypes OpenGL 4.3 bindings + Program/Texture/Buffer helpers
  glsl.py       shared GLSL: hashes, simplex & curl noise, fbm, palette lookup
  palettes.py   15 curated gradient palettes that crossfade over time
  headless.py   surfaceless EGL context for previews and benchmarks
  preview.py    --preview / --sheet / --bench
  scenes/       one file per scene, plus base.py (Scene, Drift, camera helpers)
```

Adding a scene: subclass `Scene` in `aether/scenes/`, implement `setup`,
`step(dt)` and `draw()` (render HDR linear colour into `self.out`), and add
it to `REGISTRY` in `scenes/__init__.py`. Check it with
`python3 -m aether --sheet x.png --scene "Name"`.

---

# Mirage (original CPU renderer)

The first version: twelve pycairo scenes rendered on the CPU at reduced
resolution. It still works and is the extension's fallback.

### Run

```sh
./mirage.sh                      # fullscreen, decorated=False
python3 -m mirage                # same, from the repository directory
./mirage.sh --windowed           # windowed, for quick testing
python3 -m mirage --windowed     # same
python3 -m mirage --wallpaper    # wallpaper mode (normally started by the extension)
```

Or from the repository directory without the wrapper:

```sh
python3 -m mirage
```

### Controls

| Key             | Action                                |
|-----------------|---------------------------------------|
| `Space` / `N`   | Skip to the next scene                |
| `P`             | Pause / resume                        |
| `H`             | Toggle the control hint at the bottom |
| `F11`           | Toggle fullscreen                     |
| `Esc`           | Quit                                  |

The mouse should be allowed to rest anywhere on the screen; scenes react
gently to the pointer (or to a slow phantom drift when the mouse is idle).

### Options

```
python3 -m mirage [--windowed | --wallpaper] [--seed N] [--scene NAME]
                  [--palette NAME] [--quality 0.30-1.00] [--fps F]
                  [--battery-fps F] [--debug]
python3 -m mirage --preview OUT.png [--scene NAME] [--palette NAME]
```

- `--windowed` — run as a normal window instead of fullscreen (default).
- `--wallpaper` — desktop-wallpaper mode for the GNOME extension: no
  overlays or key controls; `SIGUSR1` pauses, `SIGUSR2` resumes.
- `--battery-fps F` — frame-rate cap on battery in `--wallpaper` mode (default `15`).
- `--seed N` — seed the initial scene/palette selection (for repeatable runs).
- `--scene NAME` — force the first scene (e.g. `"Aurora Curtain"`).
- `--palette NAME` — force the first scene palette (e.g. `ember`).
- `--quality` — initial internal render scale, `0.30`–`1.00` (default `0.5`).
  The app adapts this automatically at runtime, lowering when frames
  get slow and raising slowly when headroom appears.
- `--fps` — target frame rate (default `30`).
- `--debug` — log scene changes and quality adjustments to stderr.
- `--preview OUT.png` — render a single frame headlessly and exit
  (no display needed). Useful for checking a scene without opening it.

### Scenes

Nebula Drift · Plasma Rise · Liquid Flow · Constellation Drift ·
Quantum Interference · Aurora Curtain · Orbital Garden · Starfield
Horizon · Fireflies Swarm · Ocean Swell · DNA Helix · Fractal Mirror

Eight palettes — midnight, ember, aurora, dusk, pearl, rose, forest, mono —
are picked at random on each scene change, never repeating the same
palette back-to-back.

### Headless preview

To render a scene to a PNG without a display:

```sh
python3 -m mirage --preview /tmp/out.png --scene "Aurora Curtain" --palette aurora
# or the standalone previewer with more control:
python3 -m mirage.preview --scene "Nebula Drift" --palette midnight \
                          --size 1280x720 --frames 5 --out /tmp/out.png
```

### Project layout

```
install-wallpaper.sh   installs the GNOME Shell extension
gnome-extension/       extension that runs Mirage as the desktop wallpaper
mirage/
  app.py          GTK application (window, overlay, labels, input, tick loop)
  __main__.py     CLI entry point
  scheduler.py    Scene/palette rotation, never-back-to-back, durations
  renderer.py     Low-res surface + crossfade + full-screen upscale
  perf.py         Adaptive quality controller
  sprites.py      Hand-built soft glow/gradient sprites (cached)
  palettes.py     8 calm palettes
  util.py         math helpers, smooth noise, shared RNG
  preview.py      Headless preview renderer
  scenes/         12 scenes + base class + registry
```

### Notes

- All rendering is software (pycairo), so nothing is wasted on GPU
  drivers and it runs identically across Wayland sessions.
- Scenes never repeat back-to-back: the scheduler keeps a short history
  of the last few scenes/palettes and always picks from what remains.
- Internal render resolution scales with `--quality` (smaller = faster);
  the finished frame is upscaled to the window so the widget never does
  any scaling.
- Crossfades between scenes take ~2.2 s.
