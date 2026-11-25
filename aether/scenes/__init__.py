"""Scene registry."""
from .silk import Silk
from .physarum import Physarum
from .attractor import Attractor
from .reaction import Reaction
from .fluid import Ink
from .julia import Julia
from .life import Life
from .galaxy import Galaxy
from .chaos import Chaos
from .nebula import Nebula

REGISTRY = [Silk, Physarum, Attractor, Reaction, Ink, Julia, Life, Galaxy, Chaos, Nebula]
