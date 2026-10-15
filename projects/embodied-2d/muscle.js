/*
================================================================================
 GLASS BOX · EMBODIED  -  muscle.js
================================================================================
 Realistic muscles, independent of the physics engine (works in 2D and 3D).
 Each joint has a pair: one muscle bends it one way, the other the other way.
 A muscle can only pull. The brain sets how hard each muscle is told to work
 (its excitation, 0..1); the muscle turns that into force like real tissue:

   - activation delay: ~10 ms to switch on, ~40 ms to relax
   - force-length: strongest near its ideal length, weak when very short/long
   - force-velocity: weaker the faster it shortens, up to 1.4x when stretched
   - passive stretch: resists being pulled far past its ideal length
   - springy tendon in series: stores and returns energy (long Achilles)

 Strengths are human data for a ~62 kg adult, per direction (a knee straightens
 with 200 N·m but bends with 100). Speeds come from human joint top speeds,
 scaled by SPEED so a squat jump rises ~30 cm, like a person's.
 The engine only receives the joint torque: moment arm x tendon force.

 Model: Hill-type muscle-tendon unit (Thelen 2003 style). Units: m, N, s.
================================================================================
*/
function __muscleModule(root) {   // a named function so the page can pass its source to training workers
'use strict';

const TAU_ACT = 0.010, TAU_DEACT = 0.040;   // activation / deactivation time constants (s)
const FMAX_ECC = 1.4, AF = 0.25;            // force-velocity: max force when lengthening, curve shape
const GAMMA = 0.45, KPE = 4, E0 = 0.6;      // force-length width; passive stretch shape and strain at F0
const fl = l => Math.exp(-((l - 1) * (l - 1)) / GAMMA);                                  // active force vs fibre length (in l0)
const fpe = l => l <= 1 ? 0 : (Math.exp(KPE * (l - 1) / E0) - 1) / (Math.exp(KPE) - 1);  // passive stretch
/** Fibre speed (in vmax units, + = lengthening) that produces force ratio f: the Hill curve, inverted. */
function fvInv(f) {
  if (f <= 1) return (f - 1) / (1 + f / AF);                                             // shortening
  const fe = Math.min(f, FMAX_ECC - 0.01);
  return (fe - 1) * (1 + 1 / AF) / (FMAX_ECC - fe) * 0.25;                               // lengthening
}

/** One muscle-tendon unit acting on one joint. */
class MTU {
  /** F0 peak force (N); arm moment arm (m); dir +1 = pulls the joint angle up, -1 = down; l0 ideal fibre length;
      ls tendon slack length; strain = tendon stretch at F0; vmax in l0/s; theta0 joint angle where the fibre is ideal. */
  constructor({ F0, arm, dir, l0, ls, strain = 0.04, vmax = 10, theta0 = 0 }) {
    Object.assign(this, { F0, arm, dir, l0, ls, strain, vmax, theta0 });
    this.Lref = ls + l0;
    this.reset();
  }
  reset() { this.a = 0.01; this.lm = this.l0; this.force = 0; }
  /** Whole muscle + tendon length: shortens as the muscle moves the joint its way. */
  mtLength(theta) { return this.Lref - this.dir * this.arm * (theta - this.theta0); }
  /** Advance by dt with excitation u (0..1) at joint angle theta. Returns the joint torque (N·m). */
  step(u, theta, dt) {
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    this.a += (u - this.a) / (u > this.a ? TAU_ACT : TAU_DEACT) * dt;
    const a = Math.max(0.01, this.a), lt = this.mtLength(theta) - this.lm;
    const ft = lt > this.ls ? (lt - this.ls) / (this.ls * this.strain) : 0;             // tendon force / F0
    const ln = this.lm / this.l0;
    const v = fvInv(Math.max(0, (ft - fpe(ln)) / (a * Math.max(0.05, fl(ln))))) * this.vmax * this.l0;   // fibre speed that balances the tendon
    this.lm = Math.max(0.3 * this.l0, Math.min(1.8 * this.l0, this.lm + v * dt));
    this.force = ft * this.F0;
    return this.dir * this.arm * this.force;
  }
}

/* Per joint group: peak torque (N·m), moment arm (m), tendon slack (m), tendon strain at peak force; for the muscle that
   pulls the angle up and the one that pulls it down. mid = joint angle where both fibres are at their ideal length.
   Angles follow body2d.js: hip + = thigh forward, knee - = bend, ankle + = toes up, shoulder + = arm forward, elbow + = bend. */
const MUSCLES = {
  hip:      { up: [150, 0.05, 0.10, 0.04], down: [220, 0.05, 0.10, 0.04], mid: 0.65 },   // flexors / extensors (glutes)
  knee:     { up: [200, 0.045, 0.15, 0.045], down: [100, 0.03, 0.20, 0.04], mid: -1.15 }, // quadriceps / hamstrings
  ankle:    { up: [40, 0.04, 0.20, 0.04], down: [150, 0.05, 0.25, 0.06], mid: -0.2 },    // shin / calf with Achilles
  shoulder: { up: [60, 0.03, 0.05, 0.04], down: [60, 0.03, 0.05, 0.04], mid: 1.0 },
  elbow:    { up: [55, 0.03, 0.10, 0.04], down: [40, 0.03, 0.10, 0.04], mid: 1.25 },     // biceps / triceps
};
const RANGE = { hip: [-0.6, 1.9], knee: [-2.3, 0], ankle: [-0.75, 0.35], shoulder: [-1, 3], elbow: [0, 2.5] };
const TOPSPEED = { hip: 15, knee: 20, ankle: 20, shoulder: 20, elbow: 25 };   // human joint top speeds (rad/s)
const SPEED = 1.4;          // calibration: squat jump ~30 cm (1.25x → 25 cm, 1.5x → 34 cm)
const EXCURSION = 0.35;     // a full joint sweep keeps fibres within ±35% of ideal length (real fibres are pennate)

/** Muscles for a list of joint ids ('hipL', 'kneeR', ...): [down, up] per joint, so muscle 2i pulls joint i's angle
    down and 2i+1 pulls it up. */
function makeMuscles(jointIds, { speed = SPEED, excursion = EXCURSION } = {}) {
  return jointIds.flatMap(id => {
    const k = id.replace(/[LR]$/, ''), g = MUSCLES[k], [lo, hi] = RANGE[k];
    return ['down', 'up'].map(side => {
      const [T, arm, ls0, strain] = g[side], l0 = arm * (hi - lo) / 2 / excursion;
      return new MTU({ F0: T / arm, arm, dir: side === 'up' ? 1 : -1, l0, ls: Math.max(ls0, 0.5 * l0), strain, vmax: speed * TOPSPEED[k] * arm / l0, theta0: g.mid });
    });
  });
}

const api = { MTU, MUSCLES, RANGE, TOPSPEED, SPEED, makeMuscles, TAU_ACT, TAU_DEACT };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.Muscle = api;
}
__muscleModule(typeof globalThis !== 'undefined' ? globalThis : this);
