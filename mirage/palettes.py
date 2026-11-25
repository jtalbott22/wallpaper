"""Calm, never-jarring palettes for Mirage.

Every scene picks one of these at random; each palette offers a
near-black background and a short list of soft accent colors.
"""
from dataclasses import dataclass


def _rgb(hexstr):
    hexstr = hexstr.lstrip('#')
    return (int(hexstr[0:2], 16) / 255.0,
            int(hexstr[2:4], 16) / 255.0,
            int(hexstr[4:6], 16) / 255.0)


@dataclass(frozen=True)
class Palette:
    name: str
    bg: tuple         # deep background color
    bg2: tuple        # slightly lighter background (for gradients)
    accents: tuple    # soft glow colors
    text: tuple       # calm UI text color

    def accent(self, i=0):
        return self.accents[i % len(self.accents)]


PALETTES = []


def _add(name, bg, bg2, accents, text='#cfd8ff'):
    PALETTES.append(Palette(name, _rgb(bg), _rgb(bg2),
                            tuple(_rgb(a) for a in accents),
                            _rgb(text)))


_add('midnight', '#05070f', '#101830', ['#7fd4ff', '#9d8cff', '#ff9ad5', '#6ff0c8'])
_add('ember',    '#0e0705', '#2a130b', ['#ffb36b', '#ff7a5c', '#ffd9a0', '#ff5c8a'])
_add('aurora',   '#04100c', '#0d2a20', ['#4ef0b0', '#55d7ff', '#b3ffce', '#7ef0d8'])
_add('dusk',     '#0a0616', '#221536', ['#c79bff', '#ff8ad8', '#8ad8ff', '#ffd1a8'])
_add('pearl',    '#080d13', '#18222c', ['#bfe3ff', '#e8d9a0', '#ffd6b8', '#9fd8d4'])
_add('rose',     '#100709', '#26101a', ['#ffc2d4', '#ff8fb0', '#d9b3ff', '#9fe3ff'])
_add('forest',   '#050d08', '#12261a', ['#b8f0a0', '#7be3c8', '#f7f0a0', '#9fe3b4'])
_add('mono',     '#090a0c', '#141a20', ['#e8ecf2', '#b8c8d4', '#8fa8b8', '#d8e8f0'])

