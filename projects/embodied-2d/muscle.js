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
   - a little fibre damping (keeps it smooth when lightly activated)
   - passive stretch: resists being pulled far past its ideal length
   - springy tendon in series: stores and returns energy (long Achilles)

 Strengths are human data for a ~62 kg adult, per direction (a knee straightens
 with 200 N·m but bends with 100). Speeds are calibrated so each joint's top
 speed matches a person's (knee ~23 rad/s); a crude all-muscles-at-once squat
 jump then rises ~24 cm (a person's best squat jump is ~30 cm).
 The engine only receives the joint torque: moment arm x tendon force.

 Model: Hill-type muscle-tendon unit (Thelen 2003 style). Units: m, N, s.
================================================================================
*/
function __muscleModule(root) {   // a named function so the page can pass its source to training workers
'use strict';

const TAU_ACT = 0.010, TAU_DEACT = 0.040;   // activation / deactivation time constants (s)
const FMAX_ECC = 1.4, AF = 0.25;            // force-velocity: max force when lengthening, curve shape
const GAMMA = 0.45, KPE = 4, E0 = 0.6;      // force-length width; passive stretch shape and strain at F0
const BETA = 0.1;                           // fibre damping (Millard 2013): real fibres resist fast length changes a little
const fl = l => Math.exp(-((l - 1) * (l - 1)) / GAMMA);                                  // active force vs fibre length (in l0)
const fpe = l => l <= 1 ? 0 : (Math.exp(KPE * (l - 1) / E0) - 1) / (Math.exp(KPE) - 1);  // passive stretch
/** Force-velocity: force ratio at fibre speed v (in vmax units, + = lengthening). Hill's curve when shortening;
    up to FMAX_ECC when stretched. */
function fv(v) {
  if (v <= 0) return (1 + v) / (1 - v / AF);
  return 1 + (FMAX_ECC - 1) * v / (v + 0.18);
}
/** The fibre speed at which the muscle's force (active + passive + damping) balances the tendon force ft (all / F0).
    Damping makes this always solvable; without it, a lightly activated muscle jerks at full speed whenever its
    tendon goes slack and tight again, and the joints chatter. Solved by bisection (the balance rises with speed). */
function fibreSpeed(a, flv, fp, ft) {
  // A·fv(v) + BETA·v + c = 0 with A = a·fl, c = passive − tendon. Both halves of fv are ratios of straight lines, so
  // multiplying out gives a quadratic: solved directly (it used to take 14 rounds of guessing, per muscle, per step).
  const A = a * flv, c = fp - ft, E = 0.18, K = FMAX_ECC - 1;
  if (A + c >= 0) {   // the muscle out-pulls the tendon: it shortens (v <= 0), fv = (1 + v) / (1 - v/AF)
    const qa = -BETA / AF, qb = A + BETA - c / AF, qc = A + c;      // qa v² + qb v + qc = 0, root in [-1, 0]
    const v = (-qb + Math.sqrt(Math.max(0, qb * qb - 4 * qa * qc))) / (2 * qa);
    return v < -1 ? -1 : v > 0 ? 0 : v;
  }
  // the tendon out-pulls the muscle: it's stretched (v > 0), fv = 1 + K·v / (v + E)
  const qa = BETA, qb = A + A * K + c + BETA * E, qc = (A + c) * E; // qa v² + qb v + qc = 0, root in (0, 1]
  const v = (-qb + Math.sqrt(Math.max(0, qb * qb - 4 * qa * qc))) / (2 * qa);
  return v < 0 ? 0 : v > 1 ? 1 : v;
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
  reset() { this.a = 0.01; this.lm = this.l0; this.force = 0; this.vn = 0; }
  /** Whole muscle + tendon length: shortens as the muscle moves the joint its way. */
  mtLength(theta) { return this.Lref - this.dir * this.arm * (theta - this.theta0); }
  /** Advance by dt with excitation u (0..1) at joint angle theta. Returns the joint torque (N·m). */
  step(u, theta, dt) {
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    this.a += (u - this.a) / (u > this.a ? TAU_ACT : TAU_DEACT) * dt;
    const a = Math.max(0.01, this.a), lt = this.mtLength(theta) - this.lm;
    const ft = lt > this.ls ? (lt - this.ls) / (this.ls * this.strain) : 0;             // tendon force / F0
    const ln = this.lm / this.l0;
    this.vn = fibreSpeed(a, fl(ln), fpe(ln), ft);                                     // fibre speed / top speed, + = being stretched
    const v = this.vn * this.vmax * this.l0;                                            // fibre speed that balances the tendon
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
  toe:      { up: [10, 0.02, 0.10, 0.04], down: [25, 0.02, 0.15, 0.05], mid: 0.2 },      // toe extensors / toe flexors
  // back and neck muscles attach through long, flat tendon sheets (aponeuroses), so their tendons are long and springy
  lumbar:   { up: [200, 0.05, 0.20, 0.05], down: [150, 0.08, 0.20, 0.05], mid: -0.25 },  // lower back extensors / abdominals
  thoracic: { up: [100, 0.04, 0.15, 0.05], down: [70, 0.06, 0.15, 0.05], mid: -0.1 },    // upper back / upper abdominals
  neck:     { up: [30, 0.03, 0.12, 0.05], down: [20, 0.025, 0.12, 0.05], mid: -0.05 },   // neck extensors / flexors
};
const RANGE = { hip: [-0.6, 1.9], knee: [-2.3, 0], ankle: [-0.75, 0.35], shoulder: [-1, 3], elbow: [0, 2.5], toe: [-0.5, 1.0], lumbar: [-0.9, 0.4], thoracic: [-0.4, 0.2], neck: [-0.7, 0.6] };
const TOPSPEED = { hip: 15, knee: 20, ankle: 20, shoulder: 20, elbow: 25, toe: 15, lumbar: 8, thoracic: 8, neck: 10 };   // human joint top speeds (rad/s)
const SPEED = 2.0;          // calibration: the model's joints then reach human top speeds (knee ~23, hip ~19, ankle ~15 rad/s
                            // unloaded); fibre damping and the tendons make the effective speed lower than the fibre vmax
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

const api = { MTU, MUSCLES, RANGE, TOPSPEED, SPEED, makeMuscles, TAU_ACT, TAU_DEACT, fv, fibreSpeed, BETA };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.Muscle = api;
}
__muscleModule(typeof globalThis !== 'undefined' ? globalThis : this);
