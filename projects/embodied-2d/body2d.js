/*
================================================================================
 GLASS BOX · EMBODIED 2D  -  body2d.js
================================================================================
 The physical half of an agent: a jointed body in a Rapier 2D world, plus the
 tasks it can practise. Needs RAPIER (vendor/rapier2d.js) and Brain (brain.js).

 Porting to 3D: Rapier's 3D API is nearly identical (RigidBodyDesc,
 ColliderDesc, JointData.revolute, configureMotorPosition...). The body plan
 table, the sense/act layout and the task scoring are written so they carry
 over; what changes is the shapes (capsules get a 3D axis) and joint axes.

 Realism: muscles cost energy whenever they push (even just holding), they tire
 with sustained effort and recover with rest, and every attempt starts with a
 limited energy store. Nothing tells the agents how to move; efficient
 movement is simply what lasts.

 Units: metres, kilograms, seconds, joules. y is up, the agent faces +x.
================================================================================
*/
function __body2dModule(root) {   // a named function so the page can pass its source to training workers
'use strict';

const DT = 1 / 60;
// muscles (see Biped.muscles): resting watts, watts per N·m of force held, multiplier on work done,
// how fast sustained effort tires a joint, how fast rest recovers it
const BASAL_W = 70, HOLD_W_PER_NM = 0.3, WORK_EFF = 1.3, TIRE = 0.08, RECOVER = 0.05;
// dragging a foot along the ground (skin and friction): energy per metre slid while the foot touches the ground
let SCUFF_J_PER_M = 0;   // tested at 800: sliding fell only ~15% and it broke already-trained scooting agents, so off
const GROUP = { GROUND: 0x0001, BODY: 0x0002, OBJECT: 0x0004 };
const groups = (member, filter) => (member << 16) | filter;
const wrap = a => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));   // to -π..π

/* ---------- body plan: a 1.7 m, ~64 kg humanoid seen from the side ----------
   y values are for standing still with the feet on the ground.
   side: 'L' limbs are drawn behind the torso, 'R' in front.                      */
const BIPED = {
  id: 'biped2d-v3',          // v3: human foot, heel/toe senses, energy and fatigue senses
  parts: [
    { id: 'torso', shape: 'box', hx: 0.11, hy: 0.28, x: 0, y: 1.20, density: 200, head: { r: 0.10, y: 0.40 } },
    { id: 'thighL', side: 'L', shape: 'capsule', r: 0.060, hh: 0.150, x: 0, y: 0.71, density: 120 },
    { id: 'shinL', side: 'L', shape: 'capsule', r: 0.045, hh: 0.165, x: 0, y: 0.29, density: 120 },
    { id: 'footL', side: 'L', shape: 'box', hx: 0.11, hy: 0.03, x: 0.055, y: 0.03, density: 120, foot: true },   // heel 5.5 cm behind the ankle, toes 16.5 cm ahead
    { id: 'thighR', side: 'R', shape: 'capsule', r: 0.060, hh: 0.150, x: 0, y: 0.71, density: 120 },
    { id: 'shinR', side: 'R', shape: 'capsule', r: 0.045, hh: 0.165, x: 0, y: 0.29, density: 120 },
    { id: 'footR', side: 'R', shape: 'box', hx: 0.11, hy: 0.03, x: 0.055, y: 0.03, density: 120, foot: true },
    { id: 'upperL', side: 'L', shape: 'capsule', r: 0.040, hh: 0.110, x: 0, y: 1.27, density: 120 },
    { id: 'foreL', side: 'L', shape: 'capsule', r: 0.035, hh: 0.105, x: 0, y: 0.98, density: 120, hand: { r: 0.045, y: -0.16 } },
    { id: 'upperR', side: 'R', shape: 'capsule', r: 0.040, hh: 0.110, x: 0, y: 1.27, density: 120 },
    { id: 'foreR', side: 'R', shape: 'capsule', r: 0.035, hh: 0.105, x: 0, y: 0.98, density: 120, hand: { r: 0.045, y: -0.16 } },
  ],
  // angle = child rotation minus parent rotation (counter-clockwise positive, so + swings a hanging limb forward)
  // rest = the angle the motor holds when the brain outputs 0.  k/d/max = stiffness, damping, strength (N·m)
  joints: [
    { id: 'hipL', a: 'torso', b: 'thighL', x: 0, y: 0.92, lo: -0.6, hi: 1.9, rest: 0.05, k: 3500, d: 90, max: 320 },
    { id: 'kneeL', a: 'thighL', b: 'shinL', x: 0, y: 0.50, lo: -2.3, hi: 0.0, rest: -0.08, k: 3500, d: 90, max: 300 },
    { id: 'ankleL', a: 'shinL', b: 'footL', x: 0, y: 0.08, lo: -0.75, hi: 0.35, rest: 0.0, k: 4000, d: 90, max: 200 },   // human range: toes down 43°, up 20°
    { id: 'hipR', a: 'torso', b: 'thighR', x: 0, y: 0.92, lo: -0.6, hi: 1.9, rest: 0.05, k: 3500, d: 90, max: 320 },
    { id: 'kneeR', a: 'thighR', b: 'shinR', x: 0, y: 0.50, lo: -2.3, hi: 0.0, rest: -0.08, k: 3500, d: 90, max: 300 },
    { id: 'ankleR', a: 'shinR', b: 'footR', x: 0, y: 0.08, lo: -0.75, hi: 0.35, rest: 0.0, k: 4000, d: 90, max: 200 },   // human range: toes down 43°, up 20°
    { id: 'shoulderL', a: 'torso', b: 'upperL', x: 0, y: 1.40, lo: -1.0, hi: 3.0, rest: 0.1, k: 700, d: 18, max: 70 },
    { id: 'elbowL', a: 'upperL', b: 'foreL', x: 0, y: 1.14, lo: 0.0, hi: 2.5, rest: 0.25, k: 450, d: 12, max: 45 },
    { id: 'shoulderR', a: 'torso', b: 'upperR', x: 0, y: 1.40, lo: -1.0, hi: 3.0, rest: 0.1, k: 700, d: 18, max: 70 },
    { id: 'elbowR', a: 'upperR', b: 'foreR', x: 0, y: 1.14, lo: 0.0, hi: 2.5, rest: 0.25, k: 450, d: 12, max: 45 },
  ],
};

/* What the brain senses, in order. The same layout is used for every skill so
   skills can later be merged into one brain.
     6  torso tilt (sin, cos), spin, velocity x/y, height              0-5
    20  joint angles and joint speeds                                   6-25
     4  pressure under each heel and toe (L heel, L toe, R heel, R toe) 26-29
     2  foot height above the ground (L, R)                             30-31
     2  a 1 Hz clock (sin, cos)                                         32-33
     4  task inputs (target dx, dy, holding, extra)                     34-37
     8  ground height ahead (from 0.1 m to 1.2 m in front)              38-45
     3  energy left, leg tiredness, arm tiredness                       46-48   */
const AHEAD = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1.0, 1.2];
const SENSES = 6 + BIPED.joints.length * 2 + 4 + 2 + 2 + 4 + AHEAD.length + 3;   // 49
const MOTORS = BIPED.joints.length + 1;                                       // + grip
const SIZES = [SENSES, 32, MOTORS];
// output groups for Evolution: legs (hips, knees, ankles) and arms + grip
const OUTPUT_GROUPS = [[0, 1, 2, 3, 4, 5], [6, 7, 8, 9, 10]];

/* Mirror-symmetric legs (a bilateral nervous system): when a brain is "symmetric", the right leg is driven
   by the network as usual, and the left leg by the same network run on mirrored senses (left and right
   swapped, the clock half a cycle later). Both legs then share one circuit, half a step apart, like the
   paired circuits in a real spinal cord. Arms and grip always come from the normal pass.            */
const MIRROR_SWAPS = [];
{
  const ji = id => BIPED.joints.findIndex(j => j.id === id), NJ = BIPED.joints.length;
  for (const [l, r] of [['hipL', 'hipR'], ['kneeL', 'kneeR'], ['ankleL', 'ankleR'], ['shoulderL', 'shoulderR'], ['elbowL', 'elbowR']]) {
    MIRROR_SWAPS.push([6 + ji(l), 6 + ji(r)], [6 + NJ + ji(l), 6 + NJ + ji(r)]);   // joint angles, joint speeds
  }
  MIRROR_SWAPS.push([26, 28], [27, 29], [30, 31]);                                  // heel/toe pressure, foot height
}
const LEG_L = ['hipL', 'kneeL', 'ankleL'].map(id => BIPED.joints.findIndex(j => j.id === id));
const LEG_R = ['hipR', 'kneeR', 'ankleR'].map(id => BIPED.joints.findIndex(j => j.id === id));
function mirrorSenses(inp, out) {
  out.set(inp);
  for (const [a, b] of MIRROR_SWAPS) { out[a] = inp[b]; out[b] = inp[a]; }
  out[32] = -inp[32]; out[33] = -inp[33];                                           // clock: half a cycle later
  return out;
}

/* ---------- one agent's body ---------- */
class Biped {
  constructor(R, world, x0, opts = {}) {
    this.R = R; this.world = world; this.x0 = x0; this.plan = BIPED;
    this.parts = {}; this.joints = [];
    const filter = opts.collideWithBodies ? GROUP.GROUND | GROUP.OBJECT | GROUP.BODY : GROUP.GROUND | GROUP.OBJECT;
    const cg = groups(GROUP.BODY, filter);
    for (const p of BIPED.parts) {
      const rb = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x0 + p.x, p.y).setAngularDamping(0.2).setLinearDamping(0.02));
      const desc = p.shape === 'box' ? R.ColliderDesc.cuboid(p.hx, p.hy) : R.ColliderDesc.capsule(p.hh, p.r);
      world.createCollider(desc.setDensity(p.density).setFriction(p.foot ? 1.2 : 0.7).setCollisionGroups(cg), rb);
      if (p.head) world.createCollider(R.ColliderDesc.ball(p.head.r).setTranslation(0, p.head.y).setDensity(p.density * 0.5).setCollisionGroups(cg), rb);
      if (p.hand) world.createCollider(R.ColliderDesc.ball(p.hand.r).setTranslation(0, p.hand.y).setDensity(p.density).setFriction(1.5).setCollisionGroups(cg), rb);
      this.parts[p.id] = rb;
    }
    for (const j of BIPED.joints) {
      const pa = BIPED.parts.find(p => p.id === j.a), pb = BIPED.parts.find(p => p.id === j.b);
      const data = R.JointData.revolute({ x: j.x - pa.x, y: j.y - pa.y }, { x: j.x - pb.x, y: j.y - pb.y });
      const joint = world.createImpulseJoint(data, this.parts[j.a], this.parts[j.b], true);
      joint.setLimits(j.lo, j.hi);
      joint.configureMotorModel(R.MotorModel.ForceBased);
      joint.setMotorMaxForce(j.max);
      joint.configureMotorPosition(j.rest, j.k, j.d);
      joint.setContactsEnabled(false);
      this.joints.push({ spec: j, joint, a: this.parts[j.a], b: this.parts[j.b], target: j.rest });
    }
    this.torso = this.parts.torso;
    this.hand = this.parts.foreR;           // the right hand is the one that grips
    this.grip = null;                       // fixed joint while holding something
    this.fallen = false;
    this.energyMax = opts.energy || 2000;   // joules in the store at the start
    this.energyLeft = this.energyMax;
    this.used = 0;                          // joules burned so far
    this.power = 0;                         // watts, smoothed (for display)
    this.terrain = opts.terrain || null;    // obstacles on the ground, for sensing
    for (const j of this.joints) j.fatigue = 0;
  }
  groundAt(x) { return this.terrain ? terrainHeight(this.terrain, x) : 0; }
  footClear(id) { const f = this.parts[id].translation(); return f.y - 0.03 - this.groundAt(f.x); }
  /** Height above the ground of a foot's heel (end = -1) or toe (end = +1). */
  footEnd(id, end) {
    const f = this.parts[id], t = f.translation(), a = f.rotation();
    const x = t.x + end * 0.11 * Math.cos(a) + 0.03 * Math.sin(a), y = t.y + end * 0.11 * Math.sin(a) - 0.03 * Math.cos(a);
    return y - this.groundAt(x);
  }
  tiredness(group) { let s = 0, n = 0; for (const j of this.joints) if (group === 'legs' ? /hip|knee|ankle/.test(j.spec.id) : /shoulder|elbow/.test(j.spec.id)) { s += j.fatigue; n++; } return s / n; }
  angle(j) { return wrap(j.b.rotation() - j.a.rotation()); }
  /** Torso position relative to where this body started. */
  pos() { const t = this.torso.translation(); return { x: t.x - this.x0, y: t.y }; }
  headY() { const t = this.torso.translation(), a = this.torso.rotation(); return t.y + Math.cos(a) * 0.40; }
  handPos() { const f = this.hand, t = f.translation(), a = f.rotation(); return { x: t.x + Math.sin(a) * 0.16, y: t.y - Math.cos(a) * 0.16 }; }

  /** Fills out[] with what the body senses (see SENSES). task = { dx, dy, a, b } extra inputs from the task. */
  sense(out, time, task) {
    const t = this.torso, a = t.rotation(), v = t.linvel();
    let i = 0;
    out[i++] = Math.sin(a); out[i++] = Math.cos(a); out[i++] = t.angvel() * 0.25;
    out[i++] = v.x * 0.3; out[i++] = v.y * 0.3; out[i++] = t.translation().y - 1.2;
    for (const j of this.joints) { const s = j.spec; out[i++] = ((this.angle(j) - s.lo) / (s.hi - s.lo)) * 2 - 1; }
    for (const j of this.joints) out[i++] = (j.b.angvel() - j.a.angvel()) * 0.1;
    for (const id of ['footL', 'footR']) for (const end of [-1, 1]) out[i++] = Math.max(0, 1 - this.footEnd(id, end) / 0.015);   // pressure: 1 = pressed down
    out[i++] = Math.min(1, this.footClear('footL') * 5); out[i++] = Math.min(1, this.footClear('footR') * 5);
    out[i++] = Math.sin(time * Math.PI * 2); out[i++] = Math.cos(time * Math.PI * 2);   // a 1 Hz clock: a rhythm to walk to
    out[i++] = task ? task.dx : 0; out[i++] = task ? task.dy : 0;
    out[i++] = this.grip ? 1 : 0; out[i++] = task ? task.a : 0;
    const tx = t.translation().x;
    for (const d of AHEAD) out[i++] = this.groundAt(tx + d) * 5;                         // what's on the ground ahead
    out[i++] = this.energyLeft / this.energyMax; out[i++] = this.tiredness('legs'); out[i++] = this.tiredness('arms');
    return out;
  }
  /** actions[] in -1..1: one per joint (0 = relaxed standing pose) then grip. */
  act(actions, override) {
    for (let k = 0; k < this.joints.length; k++) {
      const j = this.joints[k], s = j.spec, u = Math.max(-1, Math.min(1, actions[k]));
      let target = u >= 0 ? s.rest + u * (s.hi - s.rest) : s.rest + u * (s.rest - s.lo);
      if (override && override[s.id] !== undefined) target = override[s.id];   // testing: a joint you're moving
      j.target = target;
      j.joint.configureMotorPosition(target, s.k, s.d);
    }
  }
  /** Brain off: motors go slack (a little damping so it isn't a rag in a hurricane). */
  relax() { for (const j of this.joints) { j.target = this.angle(j); j.joint.configureMotorPosition(j.target, 0, 4); } }
  /** Joint angles as { jointId: angle }, plus 'torso' (world tilt). Same shape as a motion-clip pose. */
  pose() {
    const p = { torso: wrap(this.torso.rotation()) };
    for (const j of this.joints) p[j.spec.id] = this.angle(j);
    return p;
  }
  /** Muscles: energy and fatigue. Call once per physics step.
      Energy: a resting cost, plus every motor costs energy in proportion to how hard it pushes, even
      when holding still (like real muscle), plus the work it does. Fatigue: sustained effort tires a
      joint, rest recovers it, and a tired joint is weaker. An empty energy store makes everything weak. */
  muscles() {
    let w = BASAL_W;
    const low = Math.max(0.1, Math.min(1, this.energyLeft / (0.15 * this.energyMax)));    // running on empty: crippling (agents learned to stand on empty)
    for (const j of this.joints) {
      const s = j.spec, rel = j.b.angvel() - j.a.angvel();
      const torque = Math.max(-s.max, Math.min(s.max, s.k * (j.target - this.angle(j)) - s.d * rel));
      const effort = Math.abs(torque) / s.max;
      w += HOLD_W_PER_NM * Math.abs(torque) + WORK_EFF * Math.abs(torque * rel);
      // effort cubed: walking-level effort (~0.5) barely tires (settles ~20%), hard sustained effort (tiptoe, ~0.9) wears out fast
      j.fatigue = Math.max(0, Math.min(1, j.fatigue + DT * (TIRE * effort * effort * effort - RECOVER * j.fatigue)));
      const strength = (1 - 0.6 * j.fatigue) * low;
      if (Math.abs(strength - (j.strength || 1)) > 0.01) { j.strength = strength; j.joint.setMotorMaxForce(s.max * strength); }
    }
    if (SCUFF_J_PER_M) for (const id of ['footL', 'footR']) if (this.footEnd(id, -1) < 0.012 || this.footEnd(id, 1) < 0.012) w += SCUFF_J_PER_M * Math.abs(this.parts[id].linvel().x);
    this.energyLeft = Math.max(0, this.energyLeft - w * DT);
    this.used += w * DT;
    this.power += (w - this.power) * 0.05;
  }
  checkFallen() {
    // fallen = head low, torso tipped over, or hips down low. Agents found two cheap ways to "stand":
    // sitting down, and dropping into the splits. Both count as fallen now.
    const g = this.groundAt(this.torso.translation().x);
    if (!this.fallen && (this.headY() - g < 1.15 || this.torso.translation().y - g < 0.98 || Math.abs(wrap(this.torso.rotation())) > 1.3)) this.fallen = true;
    return this.fallen;
  }
  /** Stop simulating this body (used for fallen agents during training, saves time). */
  freeze() {
    this.release();
    for (const k in this.parts) this.parts[k].setEnabled(false);
  }
  /** Close the hand on obj: a hinge at the point where the hand touches it.
      Held near the top it hangs upright; held low it tips over (that's for the agent to discover). */
  holdObject(obj, hx, hy) {
    if (this.grip) return;
    const R = this.R, h = this.handPos(), t = obj.translation(), a = obj.rotation(), c = Math.cos(-a), s = Math.sin(-a);
    const lx = Math.max(-hx, Math.min(hx, (h.x - t.x) * c - (h.y - t.y) * s));
    const ly = Math.max(-hy, Math.min(hy, (h.x - t.x) * s + (h.y - t.y) * c));
    // hinge exactly where that point of the object already is (in the forearm's frame), so closing the
    // hand doesn't yank the object toward the palm (that jolt used to spin the glass over)
    const wx = t.x + lx * Math.cos(a) - ly * Math.sin(a), wy = t.y + lx * Math.sin(a) + ly * Math.cos(a);
    const f = this.hand.translation(), fa = this.hand.rotation(), fc = Math.cos(-fa), fs = Math.sin(-fa);
    const data = R.JointData.revolute({ x: (wx - f.x) * fc - (wy - f.y) * fs, y: (wx - f.x) * fs + (wy - f.y) * fc }, { x: lx, y: ly });
    this.grip = this.world.createImpulseJoint(data, this.hand, obj, true);
    this.grip.setContactsEnabled(false);
    this.held = obj; this.gripAt = ly / hy;     // -1 = bottom of the object, +1 = top
  }
  /** Automatic wrist: while holding something, gently keep it level, the way your wrist does without
      thinking. It has limited strength, so rough or fast arm movements still tip (spill) it. */
  wristReflex() {
    if (!this.grip || !this.held) return;
    const o = this.held, a = wrap(o.rotation());
    const torque = Math.max(-0.25, Math.min(0.25, -0.6 * a - 0.04 * o.angvel()));
    o.applyTorqueImpulse(torque * DT, true);
  }
  release() {
    if (this.grip) { this.world.removeImpulseJoint(this.grip, true); this.grip = null; this.held = null; }
  }
  remove() {
    this.release();
    for (const j of this.joints) this.world.removeImpulseJoint(j.joint, true);
    for (const k in this.parts) this.world.removeRigidBody(this.parts[k]);
  }
}

/* ---------- shared world pieces ---------- */
function makeWorld(R) {
  const world = new R.World({ x: 0, y: -9.81 });
  world.timestep = DT;
  world.numSolverIterations = 6;
  const ground = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -0.5));
  world.createCollider(R.ColliderDesc.cuboid(5000, 0.5).setFriction(1.0).setCollisionGroups(groups(GROUP.GROUND, 0xffff)), ground);
  return world;
}

/** Distance from point p to a box body (hx, hy) — used for "is the hand touching the glass". */
function distToBox(p, body, hx, hy) {
  const t = body.translation(), a = body.rotation(), c = Math.cos(-a), s = Math.sin(-a);
  const lx = (p.x - t.x) * c - (p.y - t.y) * s, ly = (p.x - t.x) * s + (p.y - t.y) * c;
  const qx = Math.max(Math.abs(lx) - hx, 0), qy = Math.max(Math.abs(ly) - hy, 0);
  return Math.hypot(qx, qy);
}

/* ---------- obstacles on the ground (Walk) ----------
   Sticks you trip over if you drag your feet, and logs you have to step over.
   The same obstacles are used for every brain in an attempt (fair), and they
   grow with the curriculum: none at first, small sticks, then logs.           */
function makeTerrain(rng, level) {
  const out = [];
  if (level <= 0.02) return out;
  for (let x = 1.5 + rng() * 0.8; x < 16; x += 1.5 + rng() * (2.5 - level)) {
    const log = level > 0.5 && rng() < (level - 0.5) * 0.7;
    out.push(log
      ? { x, w: 0.12 + rng() * 0.06, h: 0.04 + rng() * 0.05 * level, kind: 'log' }        // up to 9 cm: step over it
      : { x, w: 0.03 + rng() * 0.03, h: 0.01 + rng() * 0.025 * level, kind: 'stick' });   // up to 3.5 cm: don't drag your feet
  }
  return out;
}
/** Obstacle level for a generation: flat ground first, then obstacles creep in from generation 60 to 400. */
const terrainLevel = generation => Math.max(0, Math.min(1, (generation - 60) / 340));
function terrainHeight(terrain, x) {
  let h = 0;
  for (const o of terrain) if (Math.abs(x - o.x) <= o.w / 2) h = Math.max(h, o.h);
  return h;
}
function placeTerrain(R, world, terrain) {
  for (const o of terrain) {
    const rb = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(o.x, o.h / 2));
    world.createCollider(R.ColliderDesc.cuboid(o.w / 2, o.h / 2).setFriction(0.9).setCollisionGroups(groups(GROUP.GROUND, 0xffff)), rb);
  }
}

/* ---------- reference movements: what a person would do (shown as a ghost, never trained on) ----------
   A clip is keyframed joint angles: { name, skill, loop, period, keys: [{ t, pose, grip }] }
   pose = { torso: world tilt, hipL: angle, ... } (missing joints = relaxed pose).          */
const POSE_KEYS = ['torso'].concat(BIPED.joints.map(j => j.id));
const REST_POSE = { torso: 0 };
for (const j of BIPED.joints) REST_POSE[j.id] = j.rest;
const deg = d => d * Math.PI / 180;
function walkReference() {
  // typical human sagittal-plane gait (right leg, heel strike at 0); the left leg is half a cycle later
  const hip = [30, 26, 17, 7, -3, -10, -2, 18, 29, 32, 30], knee = [5, 15, 18, 10, 5, 10, 38, 60, 45, 15, 5];
  const ankle = [0, -6, 4, 10, 12, -6, -18, -6, 4, 2, 0];
  const at = (arr, u) => { const f = (((u % 1) + 1) % 1) * 10, i = Math.floor(f), k = f - i; return arr[i] + (arr[Math.min(10, i + 1)] - arr[i]) * k; };
  const keys = [];
  for (let n = 0; n < 10; n++) {
    const u = n / 10, uL = u + 0.5;
    keys.push({ t: u, grip: 0, pose: {
      torso: -0.06,
      hipR: deg(at(hip, u)), kneeR: -deg(at(knee, u)), ankleR: deg(at(ankle, u)),
      hipL: deg(at(hip, uL)), kneeL: -deg(at(knee, uL)), ankleL: deg(at(ankle, uL)),
      shoulderR: deg(at(hip, uL)) * 0.6, elbowR: deg(25), shoulderL: deg(at(hip, u)) * 0.6, elbowL: deg(25),
    } });
  }
  return { id: 'ref-walk', name: 'Reference walk', skill: 'walk', loop: true, period: 1, keys };
}
const REFERENCE = {
  stand: { id: 'ref-stand', name: 'Reference stance', skill: 'stand', loop: true, period: 1, keys: [{ t: 0, grip: 0, pose: Object.assign({}, REST_POSE) }] },
  walk: walkReference(),
  // raise the straight right arm forward, close the hand as it meets the glass, keep raising to lift
  grab: { id: 'ref-grab', name: 'Reference pick-up', skill: 'grab', loop: false, period: 5, keys: [
    { t: 0, grip: 0, pose: Object.assign({}, REST_POSE) },
    { t: 1.0, grip: 0, pose: { shoulderR: 0.4, elbowR: 0.05 } },
    { t: 1.8, grip: 1, pose: { shoulderR: 0.8, elbowR: 0.05 } },
    { t: 3.2, grip: 1, pose: { shoulderR: 1.6, elbowR: 0.1 } },
    { t: 5.0, grip: 1, pose: { shoulderR: 1.6, elbowR: 0.1 } },
  ] },
};
/** The clip's pose at time t (seconds), smoothly blended between keyframes. */
function clipPose(clip, t) {
  const keys = clip.keys, full = k => Object.assign({}, REST_POSE, k.pose);
  if (!keys.length) return Object.assign({ grip: 0 }, REST_POSE);
  if (keys.length === 1) return Object.assign({ grip: keys[0].grip || 0 }, full(keys[0]));
  const P = clip.period;
  let u = clip.loop ? ((t % P) + P) % P : Math.max(0, Math.min(t, keys[keys.length - 1].t));
  let i = keys.length - 1;
  for (let k = 0; k < keys.length; k++) if (keys[k].t <= u) i = k;
  const a = keys[i], b = keys[i + 1] || (clip.loop ? keys[0] : a);
  let span = (b === a) ? 1 : b.t - a.t;
  if (span <= 0) span += P;
  let f = b === a ? 0 : ((u - a.t + P) % P) / span;
  f = Math.max(0, Math.min(1, f)); f = f * f * (3 - 2 * f);   // ease in and out
  const pa = full(a), pb = full(b), out = { grip: f < 0.5 ? (a.grip || 0) : (b.grip || 0) };
  for (const k of POSE_KEYS) out[k] = pa[k] + (pb[k] - pa[k]) * f;
  return out;
}
/** Where every part would be for a pose, given the torso position: used to draw ghosts. */
function poseParts(pose, tx, ty) {
  const out = { torso: { x: tx, y: ty, a: pose.torso } };
  const byId = {}; for (const p of BIPED.parts) byId[p.id] = p;
  for (const j of BIPED.joints) {
    const pa = byId[j.a], pb = byId[j.b], A = out[j.a], ca = Math.cos(A.a), sa = Math.sin(A.a);
    const lx = j.x - pa.x, ly = j.y - pa.y, jx = A.x + lx * ca - ly * sa, jy = A.y + lx * sa + ly * ca;
    const a = A.a + pose[j.id], cb = Math.cos(a), sb = Math.sin(a), bx = j.x - pb.x, by = j.y - pb.y;
    out[j.b] = { x: jx - (bx * cb - by * sb), y: jy - (bx * sb + by * cb), a };
  }
  return out;
}

/* ---------- tasks: how an attempt is set up, sensed and scored ----------
   energy                 -> joules in the store for this attempt
   setup(R, world, x0, variant, hard, trial) -> per-agent state (objects it gets)
   senseTask(st, body)    -> { dx, dy, a } extra inputs
   step(st, body, motors, trial) -> called every physics step after act()
   done(st, body)         -> optional: finished early (reached the goal)
   score(st, body)        -> fitness (higher is better)
   Every task adds energy left at the end to the score: the same job done for less energy wins.
   Energy is in game joules: a fully tensed body burns ~10 kW, a relaxed one a few hundred W.     */
const GLASS = { hx: 0.035, hy: 0.06, density: 36 };
const GRIP_REACH = 0.11;    // palm centre to glass surface for the hand to close on it (fingers reach ~10 cm)
const TABLE = { hx: 0.16, hy: 0.02, leg: 0.015, density: 115 };   // a free-standing table, ~8 kg: it slides and tips
const energyBonus = body => 3 * body.energyLeft / body.energyMax;
const TASKS = {
  stand: {
    name: 'Stand', seconds: 8, energy: 14000,
    blurb: 'Stay on your feet and stay put, even when something shoves you.',
    setup() { return { alive: 0, drift: 0, wide: 0 }; },
    senseTask() { return null; },
    step(st, body, motors, trial) {
      st.alive += DT;
      // keep your feet under you: a stance wider than 45 cm costs (a wide split is stable but isn't standing)
      st.wide += Math.max(0, Math.abs(body.parts.footL.translation().x - body.parts.footR.translation().x) - 0.45) * DT;
      st.drift = Math.max(st.drift, Math.abs(body.pos().x));
      // a shove every 2 seconds, alternating direction, getting stronger with the curriculum
      if (trial && trial.steps % 120 === 60) body.torso.applyImpulse({ x: (trial.steps % 240 === 60 ? 1 : -1) * 28 * trial.hard, y: 0 }, true);
    },
    score(st, body) { return st.alive - Math.min(st.drift, 2) * 0.5 - st.wide * 2 - (body.fallen ? 2 : 0) + energyBonus(body); },
    describe(st, body) { return body.fallen ? `fell after ${st.alive.toFixed(1)} s` : `standing · drifted ${(st.drift * 100).toFixed(0)} cm`; },
    success(st, body) { return !body.fallen; },
    successText: 'stayed standing through every shove',
  },
  walk: {
    // Food is far away and the energy store is limited: a wasteful gait runs out before it gets there.
    name: 'Walk to food', seconds: 18, terrain: true,
    blurb: 'Food is 6 to 10 m away and you only have so much energy. Sticks and logs appear as training goes on.',
    energyFor: foodX => 20000 + 2500 * foodX,
    setup(R, world, x0, variant, hard, trial) { return { alive: 0, foodX: trial ? trial.foodX : 10, reachedAt: null }; },
    senseTask(st, body) { return { dx: Math.max(-1, Math.min(1, (st.foodX - body.pos().x) / 10)), dy: 0, a: 0 }; },
    step(st, body, motors, trial) {
      st.alive += DT;
      if (st.reachedAt === null && body.pos().x >= st.foodX - 0.3) st.reachedAt = trial ? trial.time : 0;
    },
    done(st) { return st.reachedAt !== null; },
    // stuck (less than 25 cm of progress in 4 s) or out of energy: it won't get there now
    hopeless(st, body, trial) {
      if (trial.steps % 30) return false;
      const x = body.pos().x, hist = st.xHist || (st.xHist = []);
      hist.push(x); if (hist.length > 9) hist.shift();
      return (hist.length === 9 && x - hist[0] < 0.25) || body.energyLeft <= 0;
    },
    creditRest(st, body, trial) { st.alive += (trial.maxSteps - trial.steps) * DT; },
    score(st, body) {
      const x = Math.min(body.pos().x, st.foodX);
      let f = x + st.alive * 0.3 - (body.fallen ? 2 : 0);
      // got there: sooner is better (time matters), and energy to spare is better (energy matters).
      // Without the time part they learned a slow, careful shuffle that saved energy.
      if (st.reachedAt !== null) f += 5 + 4 * (1 - st.reachedAt / 18) + energyBonus(body) * 2;
      return f;
    },
    describe(st, body) { return st.reachedAt !== null ? `reached the food in ${st.reachedAt.toFixed(1)} s · ${Math.round(100 * body.energyLeft / body.energyMax)}% energy left` : `${body.pos().x.toFixed(1)} of ${st.foodX.toFixed(1)} m${body.fallen ? ' · fell' : body.energyLeft <= 0 ? ' · out of energy' : ''}`; },
    success(st) { return st.reachedAt !== null; },
    successText: 'reached the food',
  },
  grab: {
    name: 'Pick up the glass', seconds: 7, energy: 12000,
    blurb: 'A glass of water stands on a free-standing table. Pick it up and lift it without spilling or knocking the table over.',
    setup(R, world, x0, variant, hard) {
      // curriculum: the glass starts within easy reach and moves around as training goes on.
      // The table is free-standing (~8 kg): lean on it and it slides, bump it hard and it tips over.
      const h = hard === undefined ? 1 : hard;
      const gx = 0.52 + 0.06 * h + (variant || 0) * 0.07 * h, top = 0.96 + 0.03 * (variant || 0) * h;
      const tx = gx - GLASS.hx + 0.01 + TABLE.hx;            // the glass overhangs the front edge by 1 cm
      const tg = groups(GROUP.OBJECT, GROUP.GROUND | GROUP.BODY | GROUP.OBJECT);
      const table = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x0 + tx, top - TABLE.hy));
      world.createCollider(R.ColliderDesc.cuboid(TABLE.hx, TABLE.hy).setDensity(TABLE.density).setFriction(0.8).setCollisionGroups(tg), table);
      const legH = (top - 2 * TABLE.hy) / 2;
      for (const side of [-1, 1]) world.createCollider(R.ColliderDesc.cuboid(TABLE.leg, legH).setTranslation(side * (TABLE.hx - TABLE.leg), -TABLE.hy - legH).setDensity(TABLE.density).setFriction(0.6).setCollisionGroups(tg), table);
      const glass = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x0 + gx, top + GLASS.hy + 0.001).setAngularDamping(1.5));
      world.createCollider(R.ColliderDesc.cuboid(GLASS.hx, GLASS.hy).setDensity(GLASS.density).setFriction(1.0).setCollisionGroups(tg), glass);
      return { table, glass, gx, top, tableHome: x0 + tx, rest: top + GLASS.hy, minDist: 9, grabbed: false, lift: 0, spilled: false, tableOver: false, alive: 0, reward: 0, touched: 0, held: 0 };
    },
    senseTask(st, body) {
      const g = st.glass.translation(), h = body.handPos();
      return { dx: Math.max(-2, Math.min(2, (g.x - h.x) * 2)), dy: Math.max(-2, Math.min(2, (g.y - h.y) * 2)), a: st.spilled ? -1 : st.glass.rotation() };
    },
    step(st, body, motors, trial) {
      st.alive += DT;
      const h = body.handPos(), d = distToBox(h, st.glass, GLASS.hx, GLASS.hy), tt = st.table.translation();
      st.minDist = Math.min(st.minDist, d);
      // Grip assist that fades out: early in training the hand closes on the glass whenever it
      // touches it; as the assist fades the brain's own grip signal has to be higher and higher.
      const assist = trial ? trial.assist : 0, threshold = -assist, g = motors[MOTORS - 1];
      // no gripping through the table from underneath (agents tried)
      const underTable = Math.abs(h.x - tt.x) < TABLE.hx + 0.01 && h.y < tt.y - TABLE.hy;
      const touching = d < GRIP_REACH && !underTable;
      if (touching) st.touched += DT;
      if (g > threshold && !body.grip && !st.spilled && touching) { body.holdObject(st.glass, GLASS.hx, GLASS.hy); st.grabbed = true; }
      else if (g < threshold - 0.2 && body.grip) body.release();
      if (!st.tableOver && Math.abs(wrap(st.table.rotation())) > 0.6) st.tableOver = true;
      if (!st.spilled && (Math.abs(wrap(st.glass.rotation())) > 0.9 || st.glass.translation().y < 0.5)) { st.spilled = true; if (body.grip) body.release(); }
      const lift = st.glass.translation().y - st.rest, holding = body.grip && !st.spilled;
      if (holding) { st.lift = Math.max(st.lift, lift); st.held += DT; }
      // a reward for every step of the job, paid every moment (a hand swinging past earns little).
      // Reach is measured to where a hand would grip: the near side of the glass, up high.
      const ga = st.glass.rotation(), gt = st.glass.translation(), ox = -GLASS.hx - 0.045, oy = GLASS.hy * 0.5;
      const reach = Math.hypot(h.x - (gt.x + ox * Math.cos(ga) - oy * Math.sin(ga)), h.y - (gt.y + ox * Math.sin(ga) + oy * Math.cos(ga)));
      let r = 1 - Math.min(1, reach / 1.0);                                // 1. get the hand to the glass
      if (touching) r += 1;                                                // 2. touch it
      if (holding) r += 2                                                  // 3. hold it
        + 30 * Math.max(0, Math.min(lift, 0.25))                           // 4. lift it
        + (1 - Math.min(1, Math.abs(wrap(st.glass.rotation())) / 0.9));    // 5. keep it upright
      st.reward += r * DT;
    },
    score(st, body) {
      let f = st.reward + st.alive * 0.3 + energyBonus(body);
      if (st.spilled) f -= 2;
      if (st.tableOver) f -= 2;
      if (body.fallen) f -= 3;
      return f;
    },
    describe(st, body) {
      return st.tableOver ? 'knocked the table over' : st.spilled ? 'spilled' : body.grip ? `holding · lifted ${(Math.max(0, st.lift) * 100).toFixed(0)} cm` : st.grabbed ? 'dropped it' : `hand ${(st.minDist * 100).toFixed(0)} cm away`;
    },
    success(st, body) { return !st.spilled && !st.tableOver && !!body.grip && st.lift >= 0.1 && !body.fallen; },
    hopeless(st) { return st.spilled || st.tableOver; },   // the water is gone
    creditRest(st, body, trial) { st.alive += (trial.maxSteps - trial.steps) * DT; },
    successText: 'lifted the glass 10 cm without spilling',
  },
};

/* ---------- an attempt: bodies practising one task ----------
   Every body gets its own little world, so bodies and their objects never
   interact, and replaying a brain with the same seed gives exactly the same
   result. The seed decides a small random push at the start and sensor noise,
   so a brain only scores well if its balance holds up.                         */
class Trial {
  constructor(R, taskId, brains, opts = {}) {
    this.R = R; this.task = TASKS[taskId]; this.taskId = taskId;
    this.time = 0; this.steps = 0; this.maxSteps = Math.round(this.task.seconds / DT);
    this.variant = opts.variant || 0;
    this.hard = opts.hard === undefined ? 1 : opts.hard;
    this.keepSimulating = !!opts.keepSimulating;   // watching: let a fallen body finish falling
    this.noise = opts.noise === undefined ? 0.02 : opts.noise;
    this.assist = opts.assist || 0;                  // grab: grip assist, 1 = hand closes on touch, 0 = brain decides
    this.override = opts.override || null;           // test mode: { jointId: angle } you're moving
    this.gripOverride = opts.gripOverride === undefined ? null : opts.gripOverride;   // test mode: hand forced open (-1) or closed (1)
    this.brainOff = false;                           // test mode: motors slack, the body doesn't react
    this.symmetric = !!opts.symmetric;               // mirror-symmetric legs (see mirrorSenses)
    this.mirrored = new Float32Array(SENSES); this.legOut = new Float32Array(3);
    this.earlyStop = opts.earlyStop !== undefined ? opts.earlyStop : !opts.keepSimulating;   // end hopeless attempts early (training)
    this.rng = Brain.makeRng(opts.seed || 1);
    this.input = new Float32Array(SENSES);
    const push = (this.rng() * 2 - 1) * 0.4 * (opts.push === undefined ? 1 : opts.push);
    this.terrainLevel = opts.terrainLevel === undefined ? this.hard : opts.terrainLevel;
    this.terrain = opts.terrain || (this.task.terrain ? makeTerrain(this.rng, this.terrainLevel) : []);
    this.foodX = opts.foodX || 6 + 3.5 * this.hard + this.rng() * this.hard;   // walk: food gets farther with the curriculum (6 → 9.5-10.5 m)
    // energy gets scarce with the curriculum: 5x the store at first (learn to balance stiffly, like a toddler),
    // the real store at full difficulty (then only relaxed, efficient bodies last)
    this.energy = opts.energy || (this.task.energyFor ? this.task.energyFor(this.foodX) : this.task.energy) * (1 + 4 * (1 - this.hard));
    this.agents = brains.map(params => {
      const world = makeWorld(R);
      if (this.terrain.length) placeTerrain(R, world, this.terrain);
      const body = new Biped(R, world, 0, { terrain: this.terrain, energy: this.energy });
      body.torso.setLinvel({ x: push, y: 0 }, true);
      const st = this.task.setup(R, world, 0, this.variant, this.hard, this);
      return { world, body, st, net: new Brain.Network(SIZES, params), done: false };
    });
  }
  get finished() { return this.steps >= this.maxSteps || this.agents.every(a => a.done); }
  step() {
    const rng = this.rng, inp = this.input;
    for (const a of this.agents) {
      if (a.done) { if (this.keepSimulating) a.world.step(); continue; }
      a.body.sense(inp, this.time, this.task.senseTask(a.st, a.body));
      if (this.noise) for (let i = 0; i < inp.length; i++) inp[i] += (rng() - 0.5) * 2 * this.noise;
      let out;
      if (this.symmetric) {
        const lo = a.net.forward(mirrorSenses(inp, this.mirrored));
        for (let k = 0; k < 3; k++) this.legOut[k] = lo[LEG_R[k]];
        out = a.net.forward(inp);
        for (let k = 0; k < 3; k++) out[LEG_L[k]] = this.legOut[k];
      } else out = a.net.forward(inp);
      if (this.gripOverride !== null) out[MOTORS - 1] = this.gripOverride;
      if (this.brainOff) a.body.relax(); else a.body.act(out, this.override);
      this.task.step(a.st, a.body, out, this);
      a.body.wristReflex();
      a.world.step();
      a.body.muscles();
      if (a.body.checkFallen()) { a.done = true; a.fitness = this.score(a); a.success = false; }
      else if (this.task.done && this.task.done(a.st, a.body)) { a.done = true; a.fitness = this.score(a); a.success = true; }
      else if (this.earlyStop && this.task.hopeless && this.task.hopeless(a.st, a.body, this)) {
        // can't succeed any more: stop simulating it, scored as if it had stood there until the end
        if (this.task.creditRest) this.task.creditRest(a.st, a.body, this);
        a.done = true; a.fitness = this.score(a); a.success = false;
      }
    }
    this.time += DT; this.steps++;
  }
  run() { while (!this.finished) this.step(); return this.scores(); }
  score(a) { return this.task.score(a.st, a.body); }
  scores() { return this.agents.map(a => a.fitness !== undefined ? a.fitness : this.score(a)); }
  successes() { return this.agents.map(a => a.success !== undefined ? a.success : !!this.task.success(a.st, a.body)); }
  free() { for (const a of this.agents) a.world.free(); this.agents = []; }
}

/** Senses that a skill never uses (always 0 while training it), by index into the sense list. */
const SENSE_TASK = [34, 35, 36, 37], SENSE_AHEAD = AHEAD.map((_, i) => 38 + i);
const UNUSED_SENSES = { stand: SENSE_TASK.concat(SENSE_AHEAD), walk: [35, 36, 37], grab: SENSE_AHEAD };
/** Start skill `to` from a brain trained on skill `from`: cut the connections from senses that were
    always blank in `from`. Their weights were never tested, so leaving them in makes the brain flail
    the moment those senses light up (a Stand brain fell within 0.4 s when it first saw the glass). */
function transferBrain(params, from, to) {
  const out = Float32Array.from(params), fan = SIZES[0];
  if (from === to) return out;
  for (let j = 0; j < SIZES[1]; j++) for (const i of UNUSED_SENSES[from] || []) out[j * (fan + 1) + i] = 0;
  if (to === 'grab') {
    // Loosen the arms and hand: a Stand brain can hold them pinned at a limit (tanh saturated), where small
    // changes to the brain don't move them at all (Pax's arms never moved). Legs are left as they were.
    const hid = SIZES[1], start = SIZES[1] * (fan + 1);
    for (const o of OUTPUT_GROUPS[1]) { const row = start + o * (hid + 1); for (let q = 0; q < hid; q++) out[row + q] *= 0.25; out[row + hid] = 0; }
  }
  return out;
}

/** Curriculum level for a generation: 0 = gentle (no shoves, glass close), 1 = full difficulty. */
const hardness = generation => Math.min(1, generation / 150);

/** The episodes every brain in a generation is tested on (same for all, so it's fair). */
/** Grip assist for a generation: full at first, gone by generation 200. */
const gripAssist = generation => Math.max(0, 1 - generation / 200);
function episodeConfigs(taskId, generation, extra) {
  const hard = hardness(generation), n = taskId === 'grab' ? 3 : 2, out = [];
  for (let e = 0; e < n; e++) out.push({
    seed: generation * 7919 + e * 104729 + 1,
    variant: taskId === 'grab' ? (e % 3) - 1 : 0,   // grab: glass nearer, middle, farther
    hard, push: hard, noise: 0.02 * hard,             // curriculum: shoves, sensor noise and obstacles grow with training
    assist: taskId === 'grab' ? gripAssist(generation) : 0,
    terrainLevel: terrainLevel(generation),
    symmetric: !!(extra && extra.symmetric),
  });
  return out;
}
/** perEpisode[e][i] = score of brain i in episode e. Rewards brains that do well every time, not once. */
function combineScores(perEpisode) {
  return perEpisode[0].map((_, i) => {
    const fs = perEpisode.map(ep => ep[i]), m = fs.reduce((s, f) => s + f, 0) / fs.length;
    return m - 0.25 * (Math.max(...fs) - Math.min(...fs));
  });
}
/** Scores a whole population in one go (used for training outside the page, e.g. in Node). */
function evaluate(R, taskId, population, generation, extra) {
  return combineScores(episodeConfigs(taskId, generation, extra).map(cfg => {
    const tr = new Trial(R, taskId, population, cfg), sc = tr.run();
    tr.free();
    return sc;
  }));
}

const api = { DT, BIPED, SENSES, mirrorSenses, MIRROR_SWAPS, MOTORS, SIZES, OUTPUT_GROUPS, AHEAD, GLASS, GRIP_REACH, TABLE, TASKS, Biped, Trial, hardness, gripAssist, terrainLevel, transferBrain, episodeConfigs, combineScores, evaluate,
  makeWorld, distToBox, wrap, makeTerrain, terrainHeight, POSE_KEYS, REST_POSE, REFERENCE, clipPose, poseParts, GROUP, groups,
  BASAL_W, HOLD_W_PER_NM, WORK_EFF, TIRE, RECOVER, setScuff: v => { SCUFF_J_PER_M = v; } };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.Body2D = api;
}
__body2dModule(typeof globalThis !== 'undefined' ? globalThis : this);
