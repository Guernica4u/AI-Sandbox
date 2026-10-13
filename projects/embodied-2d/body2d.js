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
  id: 'biped2d-v1',
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
   skills can later be merged into one brain.                                   */
const SENSES = 6 + BIPED.joints.length * 2 + 2 + 2 + 4;   // 34
const MOTORS = BIPED.joints.length + 1;                     // + grip
const SIZES = [SENSES, 24, MOTORS];
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
    this.energy = 0;
  }
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
    out[i++] = this.parts.footL.translation().y < 0.05 ? 1 : 0;
    out[i++] = this.parts.footR.translation().y < 0.05 ? 1 : 0;
    out[i++] = Math.sin(time * Math.PI * 2); out[i++] = Math.cos(time * Math.PI * 2);   // a 1 Hz clock: a rhythm to walk to
    out[i++] = task ? task.dx : 0; out[i++] = task ? task.dy : 0;
    out[i++] = this.grip ? 1 : 0; out[i++] = task ? task.a : 0;
    return out;
  }
  /** actions[] in -1..1: one per joint (0 = relaxed standing pose) then grip. */
  act(actions) {
    for (let k = 0; k < this.joints.length; k++) {
      const j = this.joints[k], s = j.spec, u = Math.max(-1, Math.min(1, actions[k]));
      const target = u >= 0 ? s.rest + u * (s.hi - s.rest) : s.rest + u * (s.rest - s.lo);
      this.energy += Math.abs(target - j.target);
      j.target = target;
      j.joint.configureMotorPosition(target, s.k, s.d);
    }
  }
  checkFallen() {
    // fallen = head low, torso tipped over, or hips down near the ground (sitting and kneeling count:
    // agents found that sitting down is a very stable way to "stand")
    if (!this.fallen && (this.headY() < 1.15 || this.torso.translation().y < 0.85 || Math.abs(wrap(this.torso.rotation())) > 1.3)) this.fallen = true;
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
    const data = R.JointData.revolute({ x: 0, y: -0.16 }, { x: lx, y: ly });
    this.grip = this.world.createImpulseJoint(data, this.hand, obj, true);
    this.grip.setContactsEnabled(false);
    this.held = obj; this.gripAt = ly / hy;     // -1 = bottom of the object, +1 = top
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

/* ---------- tasks: how an attempt is set up, sensed and scored ----------
   setup(lane)            -> per-agent state (objects it gets)
   senseTask(st, body)    -> { dx, dy, a } extra inputs
   step(st, body, motors) -> called every physics step after act()
   score(st, body)        -> fitness (higher is better)                          */
const GLASS = { hx: 0.035, hy: 0.06, density: 36 };
const GRIP_REACH = 0.075;   // hand centre to glass surface, for the hand to close on it
const TASKS = {
  stand: {
    name: 'Stand', seconds: 8,
    blurb: 'Stay on your feet and stay put, even when something shoves you.',
    setup() { return { alive: 0, drift: 0 }; },
    senseTask() { return null; },
    step(st, body, motors, trial) {
      st.alive += DT;
      st.drift = Math.max(st.drift, Math.abs(body.pos().x));
      // a shove every 2 seconds, alternating direction, getting stronger with the curriculum
      if (trial && trial.steps % 120 === 60) body.torso.applyImpulse({ x: (trial.steps % 240 === 60 ? 1 : -1) * 40 * trial.hard, y: 0 }, true);
    },
    score(st, body) { return st.alive - Math.min(st.drift, 2) * 0.5 - (body.fallen ? 2 : 0) - body.energy * 0.0005; },
    describe(st, body) { return body.fallen ? `fell after ${st.alive.toFixed(1)} s` : `standing · drifted ${(st.drift * 100).toFixed(0)} cm`; },
  },
  walk: {
    name: 'Walk', seconds: 10,
    blurb: 'Get as far to the right as you can without falling over.',
    setup() { return { best: 0, alive: 0 }; },
    senseTask() { return null; },
    step(st, body) { st.best = Math.max(st.best, body.pos().x); st.alive += DT; },
    score(st, body) {
      // distance, plus a little for every second upright so "dive forward" doesn't win
      return body.pos().x + st.alive * 0.3 - (body.fallen ? 2 : 0) - body.energy * 0.0005;
    },
    describe(st, body) { return `${body.pos().x.toFixed(2)} m${body.fallen ? ' · fell' : ''}`; },
  },
  grab: {
    name: 'Pick up the glass', seconds: 7,
    blurb: 'A glass of water is on a table. Pick it up and lift it without spilling.',
    setup(R, world, x0, variant, hard) {
      // curriculum: the glass starts within arm's reach and moves farther away (and around) as training goes on
      const h = hard === undefined ? 1 : hard;
      const tx = 0.30 + 0.14 * h + (variant || 0) * 0.12 * h, top = 0.95 - 0.07 * h;
      const table = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x0 + tx, top / 2));
      world.createCollider(R.ColliderDesc.cuboid(0.14, top / 2).setFriction(0.8).setCollisionGroups(groups(GROUP.OBJECT, GROUP.GROUND | GROUP.BODY | GROUP.OBJECT)), table);
      const glass = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x0 + tx, top + GLASS.hy + 0.001).setAngularDamping(1.5));
      world.createCollider(R.ColliderDesc.cuboid(GLASS.hx, GLASS.hy).setDensity(GLASS.density).setFriction(1.0).setCollisionGroups(groups(GROUP.OBJECT, GROUP.GROUND | GROUP.BODY | GROUP.OBJECT)), glass);
      return { table, glass, tx, top, rest: top + GLASS.hy, minDist: 9, grabbed: false, lift: 0, spilled: false, liftAtSpill: 0, alive: 0, reward: 0 };
    },
    senseTask(st, body) {
      const g = st.glass.translation(), h = body.handPos();
      return { dx: Math.max(-2, Math.min(2, (g.x - h.x) * 2)), dy: Math.max(-2, Math.min(2, (g.y - h.y) * 2)), a: st.spilled ? -1 : st.glass.rotation() };
    },
    step(st, body, motors) {
      st.alive += DT;
      const h = body.handPos(), d = distToBox(h, st.glass, GLASS.hx, GLASS.hy);
      st.minDist = Math.min(st.minDist, d);
      const wantsGrip = motors[MOTORS - 1] > 0;
      if (wantsGrip && !body.grip && !st.spilled && d < GRIP_REACH) { body.holdObject(st.glass, GLASS.hx, GLASS.hy); st.grabbed = true; }
      else if (!wantsGrip && body.grip) body.release();
      if (!st.spilled && Math.abs(wrap(st.glass.rotation())) > 0.9) { st.spilled = true; st.liftAtSpill = st.lift; if (body.grip) body.release(); }
      const lift = st.glass.translation().y - st.rest;
      if (body.grip && !st.spilled) st.lift = Math.max(st.lift, lift);
      // reward every moment, so the agent has to get there and stay there (a hand swinging past earns little)
      let r = (1 - Math.min(1, d / 0.5)) + (1 - Math.min(1, d / 0.1));
      if (body.grip && !st.spilled) r += 1 + 10 * Math.max(0, Math.min(lift, 0.3));
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
      return st.spilled ? 'spilled' : body.grip ? `holding · lifted ${(st.lift * 100).toFixed(0)} cm` : st.grabbed ? 'dropped it' : `hand ${(st.minDist * 100).toFixed(0)} cm away`;
    },
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
    this.rng = Brain.makeRng(opts.seed || 1);
    this.input = new Float32Array(SENSES);
    const push = (this.rng() * 2 - 1) * 0.4 * (opts.push === undefined ? 1 : opts.push);
    this.agents = brains.map(params => {
      const world = makeWorld(R);
      const body = new Biped(R, world, 0);
      body.torso.setLinvel({ x: push, y: 0 }, true);
      const st = this.task.setup(R, world, 0, this.variant, this.hard);
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
      const out = a.net.forward(inp);
      a.body.act(out);
      this.task.step(a.st, a.body, out, this);
      a.world.step();
      if (a.body.checkFallen()) { a.done = true; a.fitness = this.task.score(a.st, a.body); }
    }
    this.time += DT; this.steps++;
  }
  run() { while (!this.finished) this.step(); return this.scores(); }
  scores() { return this.agents.map(a => a.fitness !== undefined ? a.fitness : this.task.score(a.st, a.body)); }
  free() { for (const a of this.agents) a.world.free(); this.agents = []; }
}

/** Curriculum level for a generation: 0 = gentle (no shoves, glass close), 1 = full difficulty. */
const hardness = generation => Math.min(1, generation / 150);

/** The episodes every brain in a generation is tested on (same for all, so it's fair). */
function episodeConfigs(taskId, generation) {
  const hard = hardness(generation), n = taskId === 'grab' ? 3 : 2, out = [];
  for (let e = 0; e < n; e++) out.push({
    seed: generation * 7919 + e * 104729 + 1,
    variant: taskId === 'grab' ? (e % 3) - 1 : 0,   // grab: glass nearer, middle, farther
    hard, push: hard, noise: 0.02 * hard,             // curriculum: shoves and sensor noise grow with training
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
function evaluate(R, taskId, population, generation) {
  return combineScores(episodeConfigs(taskId, generation).map(cfg => {
    const tr = new Trial(R, taskId, population, cfg), sc = tr.run();
    tr.free();
    return sc;
  }));
}

const api = { DT, BIPED, SENSES, MOTORS, SIZES, OUTPUT_GROUPS, GLASS, GRIP_REACH, TASKS, Biped, Trial, hardness, episodeConfigs, combineScores, evaluate, makeWorld, distToBox, wrap };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.Body2D = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
