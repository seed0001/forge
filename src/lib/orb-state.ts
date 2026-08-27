import type { Phase } from './mood';

/**
 * How the Orb should look and move for each agent phase. Colour is an iq
 * cosine-gradient (pal(t) = a + b·cos(2π(c·t + d))); the four scalars drive the
 * shader's plasma flow, turbulence, corona and core-pulse. The Orb eases toward
 * whichever target the current phase names, so a state change reads as the
 * sphere shifting mood rather than snapping.
 */
export interface OrbTarget {
  a: [number, number, number];
  b: [number, number, number];
  c: [number, number, number];
  d: [number, number, number];
  flow: number;
  turb: number;
  glow: number;
  storm: number;
}

type Vec3 = [number, number, number];
interface Coeffs {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  d: Vec3;
}

// Palettes carried over from the reference orb, tuned per phase.
const AURORA: Coeffs = { a: [0.32, 0.44, 0.44], b: [0.38, 0.42, 0.36], c: [1.0, 1.05, 1.0], d: [0.28, 0.52, 0.74] };
const PLASMA: Coeffs = { a: [0.62, 0.34, 0.42], b: [0.46, 0.34, 0.3], c: [1.0, 1.0, 1.0], d: [0.0, 0.18, 0.32] };
const OIL: Coeffs = { a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1.0, 1.0, 1.0], d: [0.0, 0.33, 0.67] };
const EMBER: Coeffs = { a: [0.48, 0.26, 0.16], b: [0.44, 0.26, 0.14], c: [1.0, 0.95, 0.9], d: [0.0, 0.12, 0.22] };
const ABYSS: Coeffs = { a: [0.24, 0.36, 0.56], b: [0.28, 0.34, 0.46], c: [1.0, 1.0, 1.05], d: [0.52, 0.62, 0.74] };
const CRIMSON: Coeffs = { a: [0.55, 0.19, 0.18], b: [0.45, 0.16, 0.15], c: [1.0, 1.0, 1.0], d: [0.0, 0.06, 0.12] };

function make(p: Coeffs, flow: number, turb: number, glow: number, storm: number): OrbTarget {
  return {
    a: [...p.a] as Vec3,
    b: [...p.b] as Vec3,
    c: [...p.c] as Vec3,
    d: [...p.d] as Vec3,
    flow,
    turb,
    glow,
    storm,
  };
}

export const ORB_TARGETS: Record<Phase, OrbTarget> = {
  //                       flow  turb  glow  storm
  idle:     make(ABYSS,    0.30, 0.24, 0.55, 0.10),
  reading:  make(ABYSS,    1.00, 0.55, 1.00, 0.30),
  thinking: make(OIL,      0.85, 0.80, 0.95, 0.45),
  deep:     make(PLASMA,   1.30, 1.55, 1.15, 1.35),
  running:  make(EMBER,    1.45, 1.15, 1.10, 1.55),
  editing:  make(AURORA,   1.10, 0.85, 1.28, 0.55),
  error:    make(CRIMSON,  0.55, 1.85, 0.85, 1.05),
  review:   make(AURORA,   0.50, 0.40, 1.38, 0.35),
};

export function orbTarget(phase: Phase): OrbTarget {
  return ORB_TARGETS[phase] ?? ORB_TARGETS.idle;
}
