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

 Units: metres, kilograms, seconds. y is up, the agent faces +x.
================================================================================
*/
(function (root) {
'use strict';

const DT = 1 / 60;
const GROUP = { GROUND: 0x0001, BODY: 0x0002, OBJECT: 0x0004 };
const groups = (member, filter) => (member << 16) | filter;
const wrap = a => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));   // to -π..π

/* ---------- body plan: a 1.7 m, ~64 kg humanoid seen from the side ----------
   y values are for standing still with the feet on the ground.
   side: 'L' limbs are drawn behind the torso, 'R' in front.                      */
const BIPED = {
  id: 'biped2d-v2',          // v2: 44 senses (ground ahead, foot height)
  parts: [
    { id: 'torso', shape: 'box', hx: 0.11, hy: 0.28, x: 0, y: 1.20, density: 200, head: { r: 0.10, y: 0.40 } },
    { id: 'thighL', side: 'L', shape: 'capsule', r: 0.060, hh: 0.150, x: 0, y: 0.71, density: 120 },
    { id: 'shinL', side: 'L', shape: 'capsule', r: 0.045, hh: 0.165, x: 0, y: 0.29, density: 120 },
    { id: 'footL', side: 'L', shape: 'box', hx: 0.12, hy: 0.03, x: 0.04, y: 0.03, density: 120, foot: true },
    { id: 'thighR', side: 'R', shape: 'capsule', r: 0.060, hh: 0.150, x: 0, y: 0.71, density: 120 },
    { id: 'shinR', side: 'R', shape: 'capsule', r: 0.045, hh: 0.165, x: 0, y: 0.29, density: 120 },
    { id: 'footR', side: 'R', shape: 'box', hx: 0.12, hy: 0.03, x: 0.04, y: 0.03, density: 120, foot: true },
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
    { id: 'ankleL', a: 'shinL', b: 'footL', x: 0, y: 0.08, lo: -0.6, hi: 0.6, rest: 0.0, k: 4000, d: 90, max: 260 },
    { id: 'hipR', a: 'torso', b: 'thighR', x: 0, y: 0.92, lo: -0.6, hi: 1.9, rest: 0.05, k: 3500, d: 90, max: 320 },
    { id: 'kneeR', a: 'thighR', b: 'shinR', x: 0, y: 0.50, lo: -2.3, hi: 0.0, rest: -0.08, k: 3500, d: 90, max: 300 },
    { id: 'ankleR', a: 'shinR', b: 'footR', x: 0, y: 0.08, lo: -0.6, hi: 0.6, rest: 0.0, k: 4000, d: 90, max: 260 },
    { id: 'shoulderL', a: 'torso', b: 'upperL', x: 0, y: 1.40, lo: -1.0, hi: 3.0, rest: 0.1, k: 700, d: 18, max: 70 },
    { id: 'elbowL', a: 'upperL', b: 'foreL', x: 0, y: 1.14, lo: 0.0, hi: 2.5, rest: 0.25, k: 450, d: 12, max: 45 },
    { id: 'shoulderR', a: 'torso', b: 'upperR', x: 0, y: 1.40, lo: -1.0, hi: 3.0, rest: 0.1, k: 700, d: 18, max: 70 },
    { id: 'elbowR', a: 'upperR', b: 'foreR', x: 0, y: 1.14, lo: 0.0, hi: 2.5, rest: 0.25, k: 450, d: 12, max: 45 },
  ],
};

/* What the brain senses, in order. The same layout is used for every skill so
   skills can later be merged into one brain.
     6  torso tilt (sin, cos), spin, velocity x/y, height
    20  joint angles and joint speeds
     2  foot touching the ground (L, R)
     2  foot height above the ground (L, R)
     2  a 1 Hz clock (sin, cos)
     4  task inputs (target dx, dy, holding, extra)
     8  ground height ahead (from 0.1 m to 1.2 m in front)                      */
const AHEAD = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1.0, 1.2];
const SENSES = 6 + BIPED.joints.length * 2 + 2 + 2 + 2 + 4 + AHEAD.length;   // 44
const MOTORS = BIPED.joints.length + 1;                                       // + grip
const SIZES = [SENSES, 32, MOTORS];
// output groups for Evolution: legs (hips, knees, ankles) and arms + grip
const OUTPUT_GROUPS = [[0, 1, 2, 3, 4, 5], [6, 7, 8, 9, 10]];

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
    this.energy = 0;                        // how much the motor targets jumped around (tiny score penalty)
    this.work = 0;                          // mechanical work done by the motors, joules (shown, not scored)
    this.power = 0;                         // watts, smoothed
    this.terrain = opts.terrain || null;    // obstacles on the ground, for sensing
  }
  groundAt(x) { return this.terrain ? terrainHeight(this.terrain, x) : 0; }
  footClear(id) { const f = this.parts[id].translation(); return f.y - 0.03 - this.groundAt(f.x); }
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
    const cl = this.footClear('footL'), cr = this.footClear('footR');
    out[i++] = cl < 0.02 ? 1 : 0; out[i++] = cr < 0.02 ? 1 : 0;
    out[i++] = Math.min(1, cl * 5); out[i++] = Math.min(1, cr * 5);
    out[i++] = Math.sin(time * Math.PI * 2); out[i++] = Math.cos(time * Math.PI * 2);   // a 1 Hz clock: a rhythm to walk to
    out[i++] = task ? task.dx : 0; out[i++] = task ? task.dy : 0;
    out[i++] = this.grip ? 1 : 0; out[i++] = task ? task.a : 0;
    const tx = t.translation().x;
    for (const d of AHEAD) out[i++] = this.groundAt(tx + d) * 5;                         // what's on the ground ahead
    return out;
  }
  /** actions[] in -1..1: one per joint (0 = relaxed standing pose) then grip. */
  act(actions, override) {
    for (let k = 0; k < this.joints.length; k++) {
      const j = this.joints[k], s = j.spec, u = Math.max(-1, Math.min(1, actions[k]));
      let target = u >= 0 ? s.rest + u * (s.hi - s.rest) : s.rest + u * (s.rest - s.lo);
      if (override && override[s.id] !== undefined) target = override[s.id];   // teaching: a joint held where you put it
      this.energy += Math.abs(target - j.target);
      j.target = target;
      j.joint.configureMotorPosition(target, s.k, s.d);
    }
  }
  /** Joint angles as { jointId: angle }, plus 'torso' (world tilt). Same shape as a motion-clip pose. */
  pose() {
    const p = { torso: wrap(this.torso.rotation()) };
    for (const j of this.joints) p[j.spec.id] = this.angle(j);
    return p;
  }
  /** Energy meter: motor torque × joint speed, summed (joules). Call once per physics step. */
  meter() {
    let w = 0;
    for (const j of this.joints) {
      const s = j.spec, rel = j.b.angvel() - j.a.angvel();
      const torque = Math.max(-s.max, Math.min(s.max, s.k * (j.target - this.angle(j)) - s.d * rel));
      w += Math.abs(torque * rel);
    }
    this.work += w * DT;
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

/* ---------- motion clips: reference movements and your demonstrations ----------
   A clip is keyframed joint angles: { name, skill, loop, period, keys: [{ t, pose, grip }] }
   pose = { torso: world tilt, hipL: angle, ... } (missing joints = relaxed pose).
   Looping clips last 1 s per cycle, so they line up with the brain's 1 Hz clock.
   Clips are only ever an optional hint: training imitates one only when asked.
   Optional clip.joints limits which joints are compared (the reference pick-up only guides the arm). */
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
  // Raise the straight right arm forward, close the hand as it meets the glass, keep raising to lift.
  // Only the right arm is guided (joints), so each agent keeps its own way of standing.
  grab: { id: 'ref-grab', name: 'Reference pick-up', skill: 'grab', loop: false, period: 5, joints: ['shoulderR', 'elbowR'], keys: [
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
/** How far a body's pose is from a target pose (mean squared radians; the torso counts double). */
function poseError(pose, target, keys) {
  let e = 0, n = 0;
  for (const k of keys || POSE_KEYS) { const w = k === 'torso' ? 2 : 1, d = wrap(pose[k] - target[k]); e += w * d * d; n += w; }
  return e / n;
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
const IMITATE_WEIGHT = 1.5;   // score per second of moving like the clip (perfect match)

/* ---------- tasks: how an attempt is set up, sensed and scored ----------
   setup(lane)            -> per-agent state (objects it gets)
   senseTask(st, body)    -> { dx, dy, a } extra inputs
   step(st, body, motors) -> called every physics step after act()
   score(st, body)        -> fitness (higher is better)                          */
const GLASS = { hx: 0.035, hy: 0.06, density: 36 };
const GRIP_REACH = 0.11;    // palm centre to glass surface for the hand to close on it (fingers reach ~10 cm)
const TABLE = { hx: 0.022, hy: 0.015 };   // a narrow wall ledge, hung from above; the glass overhangs it on both sides   // hand centre to glass surface, for the hand to close on it
const TASKS = {
  stand: {
    name: 'Stand', seconds: 8,
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
    score(st, body) { return st.alive - Math.min(st.drift, 2) * 0.5 - st.wide * 2 - (body.fallen ? 2 : 0) - body.energy * 0.0005; },
    describe(st, body) { return body.fallen ? `fell after ${st.alive.toFixed(1)} s` : `standing · drifted ${(st.drift * 100).toFixed(0)} cm`; },
    success(st, body) { return !body.fallen; },
    successText: 'stayed standing through every shove',
  },
  walk: {
    name: 'Walk', seconds: 10, terrain: true,
    blurb: 'Get as far to the right as you can without falling over. Sticks and logs on the ground get bigger as training goes on.',
    setup() { return { best: 0, alive: 0 }; },
    senseTask() { return null; },
    step(st, body) { st.best = Math.max(st.best, body.pos().x); st.alive += DT; },
    score(st, body) {
      // distance, plus a little for every second upright so "dive forward" doesn't win
      return body.pos().x + st.alive * 0.3 - (body.fallen ? 2 : 0) - body.energy * 0.0005;
    },
    describe(st, body) { return `${body.pos().x.toFixed(2)} m${body.fallen ? ' · fell' : ''}`; },
    success(st, body) { return !body.fallen && body.pos().x >= 5; },
    successText: 'walked 5 m without falling',
  },
  grab: {
    name: 'Pick up the glass', seconds: 7,
    blurb: 'A glass of water is on a table. Pick it up and lift it without spilling.',
    setup(R, world, x0, variant, hard) {
      // curriculum: the glass starts within arm's reach and moves farther away (and around) as training goes on
      const h = hard === undefined ? 1 : hard;
      // A small wall shelf hung from above, placed on the path a straight arm takes when you raise it forward.
      // Earlier versions taught us why: a solid block tripped forward feet, a tabletop sat in the arm's way
      // (agents pressed their hand under it, or even gripped through it), and a table far enough away
      // needed an awkward over-the-top reach that evolution never found.
      const gx = 0.52 + 0.06 * h + (variant || 0) * 0.07 * h, top = 0.96 + 0.03 * (variant || 0) * h, tx = gx;
      const table = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x0 + tx, top - TABLE.hy));
      const tg = groups(GROUP.OBJECT, GROUP.GROUND | GROUP.BODY | GROUP.OBJECT);
      world.createCollider(R.ColliderDesc.cuboid(TABLE.hx, TABLE.hy).setFriction(0.8).setCollisionGroups(tg), table);
      const glass = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x0 + gx, top + GLASS.hy + 0.001).setAngularDamping(1.5));
      world.createCollider(R.ColliderDesc.cuboid(GLASS.hx, GLASS.hy).setDensity(GLASS.density).setFriction(1.0).setCollisionGroups(groups(GROUP.OBJECT, GROUP.GROUND | GROUP.BODY | GROUP.OBJECT)), glass);
      return { table, glass, tx, top, rest: top + GLASS.hy, minDist: 9, grabbed: false, lift: 0, spilled: false, liftAtSpill: 0, alive: 0, reward: 0, touched: 0, held: 0 };
    },
    senseTask(st, body) {
      const g = st.glass.translation(), h = body.handPos();
      return { dx: Math.max(-2, Math.min(2, (g.x - h.x) * 2)), dy: Math.max(-2, Math.min(2, (g.y - h.y) * 2)), a: st.spilled ? -1 : st.glass.rotation() };
    },
    step(st, body, motors, trial) {
      st.alive += DT;
      const h = body.handPos(), d = distToBox(h, st.glass, GLASS.hx, GLASS.hy);
      st.minDist = Math.min(st.minDist, d);
      // Grip assist that fades out: early in training the hand closes on the glass whenever it
      // touches it; as the assist fades the brain's own grip signal has to be higher and higher.
      const assist = trial ? trial.assist : 0, threshold = -assist, g = motors[MOTORS - 1];
      // touching needs the hand at or above the table surface: with a long reach, Kit learned to grip the
      // glass from under the tabletop, through the table, and then couldn't lift it
      const underShelf = Math.abs(h.x - st.tx) < TABLE.hx + 0.01 && h.y < st.top - 0.02;   // only right under the ledge itself is blocked
      const touching = d < GRIP_REACH && !underShelf;
      if (touching) st.touched += DT;
      if (g > threshold && !body.grip && !st.spilled && touching) { body.holdObject(st.glass, GLASS.hx, GLASS.hy); st.grabbed = true; }
      else if (g < threshold - 0.2 && body.grip) body.release();
      if (!st.spilled && Math.abs(wrap(st.glass.rotation())) > 0.9) { st.spilled = true; st.liftAtSpill = st.lift; if (body.grip) body.release(); }
      const lift = st.glass.translation().y - st.rest, holding = body.grip && !st.spilled;
      if (holding) { st.lift = Math.max(st.lift, lift); st.held += DT; }
      // a reward for every step of the job, paid every moment (a hand swinging past earns little).
      // Reach is measured to where a hand would grip: the near side of the glass, up high. Measured to the
      // glass itself, Kit learned to press its hand under the tabletop, 9 cm away but on the wrong side.
      const ga = st.glass.rotation(), gt = st.glass.translation(), ox = -GLASS.hx - 0.045, oy = GLASS.hy * 0.5;
      const reach = Math.hypot(h.x - (gt.x + ox * Math.cos(ga) - oy * Math.sin(ga)), h.y - (gt.y + ox * Math.sin(ga) + oy * Math.cos(ga)));
      let r = 1 - Math.min(1, reach / 1.0);                                // 1. get the hand to the glass (felt from 1 m away)
      if (touching) r += 1;                                                // 2. touch it
      if (holding) r += 2                                                  // 3. hold it
        + 30 * Math.max(0, Math.min(lift, 0.25))                           // 4. lift it (worth much more than just holding)
        + (1 - Math.min(1, Math.abs(wrap(st.glass.rotation())) / 0.9));    // 5. keep it upright
      st.reward += r * DT;
    },
    score(st, body) {
      let f = st.reward;
      if (st.spilled) f -= 2;
      if (body.fallen) f -= 3;
      f += st.alive * 0.3;                               // staying on your feet
      return f - body.energy * 0.0003;
    },
    describe(st, body) {
      return st.spilled ? 'spilled' : body.grip ? `holding · lifted ${(Math.max(0, st.lift) * 100).toFixed(0)} cm` : st.grabbed ? 'dropped it' : `hand ${(st.minDist * 100).toFixed(0)} cm away`;
    },
    success(st, body) { return !st.spilled && !!body.grip && st.lift >= 0.1 && !body.fallen; },
    successText: 'lifted the glass 10 cm without spilling',
    remove(world, st) { world.removeRigidBody(st.glass); world.removeRigidBody(st.table); },
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
    this.imitate = opts.imitate || null;             // optional motion clip to imitate (reference or your demonstration)
    this.override = opts.override || null;           // teaching: { jointId: angle } held by you, not the brain
    this.gripOverride = opts.gripOverride === undefined ? null : opts.gripOverride;   // teaching: hand forced open (-1) or closed (1)
    this.rng = Brain.makeRng(opts.seed || 1);
    this.input = new Float32Array(SENSES);
    const push = (this.rng() * 2 - 1) * 0.4 * (opts.push === undefined ? 1 : opts.push);
    this.terrainLevel = opts.terrainLevel === undefined ? this.hard : opts.terrainLevel;
    this.terrain = opts.terrain || (this.task.terrain ? makeTerrain(this.rng, this.terrainLevel) : []);
    this.agents = brains.map(params => {
      const world = makeWorld(R);
      if (this.terrain.length) placeTerrain(R, world, this.terrain);
      const body = new Biped(R, world, 0, { terrain: this.terrain });
      body.torso.setLinvel({ x: push, y: 0 }, true);
      const st = this.task.setup(R, world, 0, this.variant, this.hard);
      return { world, body, st, net: new Brain.Network(SIZES, params), done: false, imit: 0 };
    });
  }
  get finished() { return this.steps >= this.maxSteps || this.agents.every(a => a.done); }
  step() {
    const rng = this.rng, inp = this.input;
    for (const a of this.agents) {
      if (a.done) { if (this.keepSimulating) a.world.step(); continue; }
      a.body.sense(inp, this.time, this.task.senseTask(a.st, a.body));
      if (this.noise) for (let i = 0; i < inp.length; i++) inp[i] += (rng() - 0.5) * 2 * this.noise;
      const out = a.net.forward(inp);
      if (this.gripOverride !== null) out[MOTORS - 1] = this.gripOverride;
      a.body.act(out, this.override);
      this.task.step(a.st, a.body, out, this);
      a.body.wristReflex();
      a.world.step();
      a.body.meter();
      if (this.imitate) a.imit += Math.exp(-2 * poseError(a.body.pose(), clipPose(this.imitate, this.time), this.imitate.joints)) * DT;
      if (a.body.checkFallen()) { a.done = true; a.fitness = this.score(a); a.success = false; }
    }
    this.time += DT; this.steps++;
  }
  run() { while (!this.finished) this.step(); return this.scores(); }
  score(a) { return this.task.score(a.st, a.body) + (this.imitate ? a.imit * IMITATE_WEIGHT : 0); }
  scores() { return this.agents.map(a => a.fitness !== undefined ? a.fitness : this.score(a)); }
  successes() { return this.agents.map(a => a.success === false ? false : !!this.task.success(a.st, a.body)); }
  free() { for (const a of this.agents) a.world.free(); this.agents = []; }
}

/** Senses that a skill never uses (always 0 while training it), by index into the sense list. */
const SENSE_TASK = [32, 33, 34, 35], SENSE_AHEAD = AHEAD.map((_, i) => 36 + i);
const UNUSED_SENSES = { stand: SENSE_TASK.concat(SENSE_AHEAD), walk: SENSE_TASK, grab: SENSE_AHEAD };
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
function episodeConfigs(taskId, generation, imitate) {
  const hard = hardness(generation), n = taskId === 'grab' ? 3 : 2, out = [];
  for (let e = 0; e < n; e++) out.push({
    seed: generation * 7919 + e * 104729 + 1,
    variant: taskId === 'grab' ? (e % 3) - 1 : 0,   // grab: glass nearer, middle, farther
    hard, push: hard, noise: 0.02 * hard,             // curriculum: shoves, sensor noise and obstacles grow with training
    assist: taskId === 'grab' ? gripAssist(generation) : 0,
    terrainLevel: terrainLevel(generation),
    imitate: imitate || null,
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
function evaluate(R, taskId, population, generation, imitate) {
  return combineScores(episodeConfigs(taskId, generation, imitate).map(cfg => {
    const tr = new Trial(R, taskId, population, cfg), sc = tr.run();
    tr.free();
    return sc;
  }));
}

const api = { DT, BIPED, SENSES, MOTORS, SIZES, OUTPUT_GROUPS, AHEAD, GLASS, GRIP_REACH, TABLE, TASKS, Biped, Trial, hardness, gripAssist, terrainLevel, transferBrain, episodeConfigs, combineScores, evaluate,
  makeWorld, distToBox, wrap, makeTerrain, terrainHeight, POSE_KEYS, REST_POSE, REFERENCE, clipPose, poseError, poseParts, IMITATE_WEIGHT, GROUP, groups };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.Body2D = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
