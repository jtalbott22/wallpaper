"""All built-in Mirage scenes, in no particular order."""
from .nebula import NebulaDrift
from .plasma import PlasmaRise
from .liquid import LiquidFlow
from .constellation import ConstellationDrift
from .quantum import QuantumInterference
from .aurora import AuroraRibbons
from .orbital import OrbitalGarden
from .starfield import StarfieldHorizon
from .fireflies import FirefliesSwarm
from .ocean import OceanSwell
from .dna import DNAHelix
from .fractal import FractalMirror

SCENES = [
    NebulaDrift,
    PlasmaRise,
    LiquidFlow,
    ConstellationDrift,
    QuantumInterference,
    AuroraRibbons,
    OrbitalGarden,
    StarfieldHorizon,
    FirefliesSwarm,
    OceanSwell,
    DNAHelix,
    FractalMirror,
]

BY_NAME = {s.name: s for s in SCENES}
FAMILIES = sorted({s.family for s in SCENES})
