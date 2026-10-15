/*
================================================================================
 GLASS BOX · EMBODIED 2D  -  body2d.js
================================================================================
 The physical half of an agent: a jointed body in a MuJoCo world, moved by
 realistic muscles (muscle.js), plus the tasks it can practise.
 Needs the MuJoCo module (vendor/mujoco.js → loadMujocoClassic()), Muscle
 (muscle.js) and Brain (brain.js).

 Physics: MuJoCo (Google DeepMind), planar: the body moves forward/back and
 up/down and tips, and nothing moves sideways. Every body part is a MuJoCo body
 in one jointed chain, so joints can't drift apart and planted feet don't slide
 (no patches needed). Physics runs 8 sub-steps per brain step (480 Hz).

 Muscles: each joint has a pair (bend / straighten) with human strength, a
 switch-on delay, force-length and force-velocity curves and springy tendons.
 The brain sets how hard each of the 20 muscles is told to work (0..1), and
 the hand's grip. Nothing tells the agents how to move.

 Realism: muscles cost energy whenever they're switched on (even just
 holding), they tire with sustained effort and recover with rest, and every
 attempt starts with a limited energy store.

 Units: metres, kilograms, seconds, joules. y is up, the agent faces +x.
 (MuJoCo's z axis is our y; rotations are about MuJoCo's -y axis, so a positive
 angle swings a hanging limb forward, as before.)
================================================================================
*/
function __body2dModule(root) {   // a named function so the page can pass its source to training workers
'use strict';
const Muscle = root.Muscle || (typeof require === 'function' ? require('./muscle.js') : null);

const DT = 1 / 60;            // one brain step
const SUB = 8, H = DT / SUB;  // physics sub-steps per brain step (480 Hz; 240 Hz brings back joint chatter)
// energy (see Biped.muscles): resting watts; holding cost per (peak force × fibre length) per second of full activation;
// metabolic cost of positive work (muscle is ~25% efficient); how fast sustained activation tires a muscle; recovery
const BASAL_W = 70, MAINT = 1.2, WORK_COST = 4, TIRE = 0.08, RECOVER = 0.05;
const wrap = a => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));   // to -π..π
// passive joint damping (N·m per rad/s): ligaments, joint capsule and soft tissue gently resist fast movement
const JOINT_DAMPING = { value: 0 };
// how soft the end of a joint's range is (MuJoCo's limit time constant, s): ligaments stretch a little before they stop it
const JOINT_LIMIT_SOFTNESS = { value: 0.02 };
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

/* ---------- body plan: a 1.7 m, ~62 kg humanoid seen from the side ----------
   y values are for standing still with the feet on the ground. mass (kg) and inertia (kg·m², about the side-on axis)
   per part; com = centre of mass offset along the part. side: 'L' limbs are drawn behind the trunk, 'R' in front.
   The trunk bends: pelvis, belly and chest with two spine joints, and the head sits on a neck. Each foot has toes.   */
const BIPED = {
  id: 'biped2d-v7',           // v7: MuJoCo, muscle pairs; spine, neck, toes; human senses, nerve delays, stretch reflex; one shared brain
  root: 'pelvis',
  parts: [
    { id: 'pelvis', shape: 'box', hx: 0.12, hy: 0.09, x: 0, y: 1.00, mass: 9.5, inertia: 0.0713 },
    { id: 'belly', shape: 'box', hx: 0.11, hy: 0.08, x: 0, y: 1.17, mass: 5.0, inertia: 0.0308 },
    { id: 'chest', shape: 'box', hx: 0.12, hy: 0.13, x: 0, y: 1.38, mass: 8.8, inertia: 0.0918 },
    { id: 'head', shape: 'sphere', r: 0.10, x: 0, y: 1.64, mass: 4.5, inertia: 0.0250, com: -0.02 },   // with the neck
    { id: 'thighL', side: 'L', shape: 'capsule', r: 0.060, hh: 0.150, x: 0, y: 0.71, mass: 5.677, inertia: 0.0797 },
    { id: 'shinL', side: 'L', shape: 'capsule', r: 0.045, hh: 0.165, x: 0, y: 0.29, mass: 4.327, inertia: 0.0606 },
    { id: 'footL', side: 'L', shape: 'box', hx: 0.0825, hy: 0.03, x: 0.0275, y: 0.03, mass: 1.35, inertia: 0.0035, foot: true },   // heel 5.5 cm behind the ankle, ball 11 cm ahead
    { id: 'toesL', side: 'L', shape: 'box', hx: 0.0275, hy: 0.02, x: 0.1375, y: 0.02, mass: 0.23, inertia: 0.00009, toes: true },  // toes: 11 to 16.5 cm ahead
    { id: 'thighR', side: 'R', shape: 'capsule', r: 0.060, hh: 0.150, x: 0, y: 0.71, mass: 5.677, inertia: 0.0797 },
    { id: 'shinR', side: 'R', shape: 'capsule', r: 0.045, hh: 0.165, x: 0, y: 0.29, mass: 4.327, inertia: 0.0606 },
    { id: 'footR', side: 'R', shape: 'box', hx: 0.0825, hy: 0.03, x: 0.0275, y: 0.03, mass: 1.35, inertia: 0.0035, foot: true },
    { id: 'toesR', side: 'R', shape: 'box', hx: 0.0275, hy: 0.02, x: 0.1375, y: 0.02, mass: 0.23, inertia: 0.00009, toes: true },
    { id: 'upperL', side: 'L', shape: 'capsule', r: 0.040, hh: 0.110, x: 0, y: 1.27, mass: 2.715, inertia: 0.0194 },
    { id: 'foreL', side: 'L', shape: 'capsule', r: 0.035, hh: 0.105, x: 0, y: 0.98, mass: 2.989, inertia: 0.0292, com: -0.04, hand: { r: 0.045, y: -0.16 } },
    { id: 'upperR', side: 'R', shape: 'capsule', r: 0.040, hh: 0.110, x: 0, y: 1.27, mass: 2.715, inertia: 0.0194 },
    { id: 'foreR', side: 'R', shape: 'capsule', r: 0.035, hh: 0.105, x: 0, y: 0.98, mass: 2.989, inertia: 0.0292, com: -0.04, hand: { r: 0.045, y: -0.16 } },
  ],
  // angle = child rotation minus parent rotation (+ swings a hanging limb forward, tips the trunk or head back, lifts the
  // toes); rest = the relaxed standing pose. group: which mutation group's outputs drive it (legs, trunk, arms).
  joints: [
    { id: 'hipL', a: 'pelvis', b: 'thighL', x: 0, y: 0.92, lo: -0.6, hi: 1.9, rest: 0.05, group: 'legs' },
    { id: 'kneeL', a: 'thighL', b: 'shinL', x: 0, y: 0.50, lo: -2.3, hi: 0.0, rest: -0.08, group: 'legs' },
    { id: 'ankleL', a: 'shinL', b: 'footL', x: 0, y: 0.08, lo: -0.75, hi: 0.35, rest: 0.0, group: 'legs' },   // human range: toes down 43°, up 20°
    { id: 'toeL', a: 'footL', b: 'toesL', x: 0.11, y: 0.02, lo: -0.5, hi: 1.0, rest: 0.0, group: 'legs' },    // toes curl down 30°, bend up 55° (push-off)
    { id: 'hipR', a: 'pelvis', b: 'thighR', x: 0, y: 0.92, lo: -0.6, hi: 1.9, rest: 0.05, group: 'legs' },
    { id: 'kneeR', a: 'thighR', b: 'shinR', x: 0, y: 0.50, lo: -2.3, hi: 0.0, rest: -0.08, group: 'legs' },
    { id: 'ankleR', a: 'shinR', b: 'footR', x: 0, y: 0.08, lo: -0.75, hi: 0.35, rest: 0.0, group: 'legs' },
    { id: 'toeR', a: 'footR', b: 'toesR', x: 0.11, y: 0.02, lo: -0.5, hi: 1.0, rest: 0.0, group: 'legs' },
    { id: 'lumbar', a: 'pelvis', b: 'belly', x: 0, y: 1.09, lo: -0.9, hi: 0.4, rest: 0.0, group: 'trunk' },   // lower back: bend forward 50°, back 23°
    { id: 'thoracic', a: 'belly', b: 'chest', x: 0, y: 1.25, lo: -0.4, hi: 0.2, rest: 0.0, group: 'trunk' },  // upper back
    { id: 'neck', a: 'chest', b: 'head', x: 0, y: 1.52, lo: -0.7, hi: 0.6, rest: 0.0, group: 'trunk' },       // chin to chest 40°, look up 34°
    { id: 'shoulderL', a: 'chest', b: 'upperL', x: 0, y: 1.40, lo: -1.0, hi: 3.0, rest: 0.1, group: 'arms' },
    { id: 'elbowL', a: 'upperL', b: 'foreL', x: 0, y: 1.14, lo: 0.0, hi: 2.5, rest: 0.25, group: 'arms' },
    { id: 'shoulderR', a: 'chest', b: 'upperR', x: 0, y: 1.40, lo: -1.0, hi: 3.0, rest: 0.1, group: 'arms' },
    { id: 'elbowR', a: 'upperR', b: 'foreR', x: 0, y: 1.14, lo: 0.0, hi: 2.5, rest: 0.25, group: 'arms' },
  ],
};
const NJ = BIPED.joints.length, NM = 2 * NJ;   // 15 joints, 30 muscles (muscle 2i pulls joint i's angle down, 2i+1 up)
const ROOT_Y = BIPED.parts.find(p => p.id === BIPED.root).y;   // pelvis height standing (1.00 m)

/* What the brain senses: what a person's body actually reports, not exact numbers it couldn't know.
     5  inner ear (in the head): tilt (sin, cos), spin, acceleration forward and up
     2  seeing yourself move: the head's speed forward and up (vision)
    15  joint position (joint receptors)
    30  muscle stretch sensors (spindles): how fast each muscle is being stretched (+) or shortening (-)
    30  tendon force sensors (Golgi organs): how hard each muscle is pulling
     6  touch under each heel, ball and toe tip (L heel, ball, toes, R heel, ball, toes)
     2  a 1 Hz rhythm (sin, cos), like the spinal cord's own rhythm generators
     4  task inputs, seen (target dx, dy, holding, extra)
     8  ground height ahead, seen (from 0.1 m to 1.2 m in front)
     3  energy left, leg tiredness, arm tiredness (felt)
     3  what it's trying to do: walk to food, jump for fruit, pick up the glass (none of them: just stand)
   One brain does every skill (see the shared brain below), so it needs to know which one it's on.
   Nerve delays: every sense arrives late by a realistic amount (SENSE_DELAY), and commands reach the muscles late
   (MOTOR_DELAY). A spinal stretch reflex tenses a muscle that's suddenly stretched, without the brain (Biped.stepPhysics).
   What the brain sets: 30 muscle excitations (0..1; negative = 0), then grip (-1..1).        */
const AHEAD = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1.0, 1.2];
const SKILLS = ['stand', 'walk', 'jump', 'grab'];
const INTENTS = ['walk', 'jump', 'grab'];   // stand is the absence of any of these
const SENSE_LIST = [['ear', 5], ['sight', 2], ['joints', NJ], ['spindles', NM], ['tendons', NM], ['pressure', 6], ['clock', 2], ['task', 4], ['ahead', AHEAD.length], ['inner', 3], ['intent', INTENTS.length]];
const SENSE_AT = (() => { let i = 0; const at = {}; for (const [k, n] of SENSE_LIST) { at[k] = i; i += n; } at.total = i; return at; })();
const SENSES = SENSE_AT.total;                                 // 108
/* Nerve delays in brain steps (1 step = 17 ms): the inner ear is close to the brain (17 ms), legs and feet are far
   (33 ms), arms and trunk in between (17 ms), the eyes are slow (100 ms), feeling tired is slower still (50 ms).    */
const DELAY = { ear: 1, sight: 6, legs: 2, trunk: 1, arms: 1, touch: 2, clock: 0, task: 6, ahead: 6, inner: 3, intent: 0 };
const SENSE_DELAY = (() => {
  const d = new Int8Array(SENSES), jointDelay = j => DELAY[BIPED.joints[j].group];
  const fill = (k, f) => { for (let i = 0; i < SENSE_LIST.find(e => e[0] === k)[1]; i++) d[SENSE_AT[k] + i] = f(i); };
  fill('ear', () => DELAY.ear); fill('sight', () => DELAY.sight); fill('joints', jointDelay);
  fill('spindles', m => jointDelay(m >> 1)); fill('tendons', m => jointDelay(m >> 1)); fill('pressure', () => DELAY.touch);
  fill('clock', () => DELAY.clock); fill('task', () => DELAY.task); fill('ahead', () => DELAY.ahead); fill('inner', () => DELAY.inner); fill('intent', () => DELAY.intent);
  return d;
})();
/** Motor nerve delays, per muscle (and the grip): commands to the legs take 33 ms, to the trunk and arms 17 ms. */
const MOTOR_DELAY = Int8Array.from({ length: 2 * NJ + 1 }, (_, m) => m < 2 * NJ ? DELAY[BIPED.joints[m >> 1].group] : DELAY.arms);
const HIST = 8;   // brain steps of history kept for the delays
// stretch reflex: extra excitation per unit of stretch speed (fibre speed / top speed) above a small threshold; switched
// down in a muscle while its opposite muscle is being driven (reciprocal inhibition), so it doesn't fight movements
const REFLEX = { gain: 0.8, threshold: 0.02 };
const MOTORS = NM + 1;                                         // 30 muscles + grip
const SIZES = [SENSES, 48, MOTORS];   // one brain for every skill, so a little more room than a one-skill brain
// output groups for Evolution (half the mutations touch only one group): leg muscles, trunk and neck muscles, arm muscles + grip
const muscleGroup = g => BIPED.joints.flatMap((j, i) => j.group === g ? [2 * i, 2 * i + 1] : []);
const OUTPUT_GROUPS = [muscleGroup('legs'), muscleGroup('trunk'), muscleGroup('arms').concat(NM)];
const ARM_OUTPUTS = OUTPUT_GROUPS[2];

/* ---------- the MuJoCo world, as MJCF (MuJoCo's XML) ----------
   Collision groups: body parts touch the ground and objects but not each other; objects touch everything. */
const CONTACT = { body: 'contype="2" conaffinity="1"', ground: 'contype="1" conaffinity="6"', object: 'contype="4" conaffinity="7"' };
const f3 = v => +v.toFixed(5);
function bipedXML() {
  const byId = {}; for (const p of BIPED.parts) byId[p.id] = p;
  const kids = {}; for (const j of BIPED.joints) (kids[j.a] = kids[j.a] || []).push(j);
  const geoms = p => {
    const fr = p.foot || p.toes ? 1.1 : 0.7;
    let g = p.shape === 'box' ? `<geom name="${p.id}" type="box" size="${p.hx} 0.05 ${p.hy}" ${CONTACT.body} friction="${fr}"/>`
      : p.shape === 'sphere' ? `<geom name="${p.id}" type="sphere" size="${p.r}" ${CONTACT.body} friction="${fr}"/>`
      : `<geom name="${p.id}" type="capsule" fromto="0 0 ${-p.hh} 0 0 ${p.hh}" size="${p.r}" ${CONTACT.body} friction="${fr}"/>`;
    if (p.hand) g += `<geom name="hand${p.side}" type="sphere" pos="0 0 ${p.hand.y}" size="${p.hand.r}" ${CONTACT.body} friction="1.5"/>`;
    return g;
  };
  const inertial = p => `<inertial pos="0 0 ${p.com || 0}" mass="${p.mass}" diaginertia="${p.inertia} ${p.inertia} ${p.inertia}"/>`;
  const sub = (p, j) => {
    const pa = byId[j.a];
    return `<body name="${p.id}" pos="${f3(p.x - pa.x)} 0 ${f3(p.y - pa.y)}">${inertial(p)}` +
      `<joint name="${j.id}" type="hinge" axis="0 -1 0" pos="${f3(j.x - p.x)} 0 ${f3(j.y - p.y)}" armature="${p.toes ? 0.002 : 0.01}" damping="${JOINT_DAMPING.value}" limited="true" range="${j.lo} ${j.hi}" solreflimit="${JOINT_LIMIT_SOFTNESS.value} 1"/>` +
      geoms(p) + (kids[p.id] || []).map(k => sub(byId[k.b], k)).join('') + `</body>`;
  };
  const t = byId[BIPED.root];
  return `<body name="${t.id}" pos="0 0 ${t.y}">${inertial(t)}` +
    `<joint name="rootx" type="slide" axis="1 0 0"/><joint name="rooty" type="slide" axis="0 0 1"/><joint name="roottilt" type="hinge" axis="0 -1 0"/>` +
    geoms(t) + kids[t.id].map(k => sub(byId[k.b], k)).join('') + `</body>`;
}
/** A free 2D object (moves in the plane, tips), with its own three joints. */
const objectXML = (name, x, y, geomsXml, damping = 0) =>
  `<body name="${name}" pos="${f3(x)} 0 ${f3(y)}"><joint type="slide" axis="1 0 0"/><joint type="slide" axis="0 0 1"/><joint type="hinge" axis="0 -1 0" damping="${damping}"/>${geomsXml}</body>`;
/** The whole world: ground, obstacles, the body, any task objects, and the hand's grip (switched on when it closes). */
function worldXML({ terrain = [], objects = '', grip = false } = {}) {
  return `<mujoco model="glassbox-embodied2d"><compiler angle="radian"/>
<option timestep="${H}" integrator="implicitfast" noslip_iterations="3"/>
<worldbody><geom name="ground" type="plane" size="500 5 0.1" ${CONTACT.ground} friction="1.0"/>
${terrain.map(o => `<geom type="box" pos="${f3(o.x)} 0 ${f3(o.h / 2)}" size="${f3(o.w / 2)} 0.1 ${f3(o.h / 2)}" ${CONTACT.ground} friction="0.9"/>`).join('')}
${bipedXML()}${objects}</worldbody>
${grip ? '<equality><connect name="grip" body1="foreR" body2="glass" anchor="0 0 0" active="false"/></equality>' : ''}
</mujoco>`;
}

/** A body part as the page and the tasks see it: position, rotation, velocity, mass, and pushes. */
class Part {
  constructor(body, id, spec) { this.body = body; this.id = id; this.spec = spec; }
  translation() { const p = this.body.data.xpos; return { x: p[3 * this.id], y: p[3 * this.id + 2] }; }
  rotation() { const m = this.body.data.xmat; return Math.atan2(-m[9 * this.id + 2], m[9 * this.id + 8]); }
  linvel() { const v = this.body.vel; return { x: v[3 * this.id], y: v[3 * this.id + 1] }; }
  angvel() { return this.body.vel[3 * this.id + 2]; }
  mass() { return this.body.model.body_mass[this.id]; }
  /** An impulse (N·s), spread over the next brain step. */
  applyImpulse(imp) { this.applyImpulseAtPoint(imp, null); }
  applyImpulseAtPoint(imp, point) {
    const f = this.body.pending, k = 3 * this.id, fx = imp.x / DT, fy = imp.y / DT;
    f[k] += fx; f[k + 1] += fy;
    if (point) { const c = this.body.data.xipos, rx = point.x - c[3 * this.id], ry = point.y - c[3 * this.id + 2]; f[k + 2] += rx * fy - ry * fx; }
  }
}

/* ---------- one agent's body ---------- */
class Biped {
  /** mj: the MuJoCo module; model: the compiled world; data: this body's own copy of the world's state. */
  constructor(mj, model, data, opts = {}) {
    this.mj = mj; this.model = model; this.data = data; this.x0 = 0; this.plan = BIPED;
    this.hipsLow = opts.hipsLow || 0.78;    // pelvis below this = fallen (standing it's at 1.00; Jump allows a deeper crouch)
    const bodyId = n => mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, n);
    this.parts = {}; for (const p of BIPED.parts) this.parts[p.id] = new Part(this, bodyId(p.id), p);
    this.objects = {}; for (const n of ['table', 'glass']) { const id = bodyId(n); if (id >= 0) this.objects[n] = new Part(this, id); }
    this.partList = Object.values(this.parts);
    this.torso = this.parts[BIPED.root];                            // the pelvis: the body's root (position, harness)
    this.chest = this.parts.chest; this.head = this.parts.head;
    this.hand = this.parts.foreR;                                   // the right hand is the one that grips
    this.vel = new Float64Array(3 * model.nbody); this.prev = new Float64Array(3 * model.nbody);
    this.pending = new Float64Array(3 * model.nbody);              // pushes (fx, fy, torque) for the next brain step
    const jid = n => mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, n);
    this.joints = BIPED.joints.map((spec, i) => ({ spec, i, q: model.jnt_qposadr[jid(spec.id)], dq: model.jnt_dofadr[jid(spec.id)], a: this.parts[spec.a], b: this.parts[spec.b], target: spec.rest, fatigue: 0, effort: 0 }));
    this.jq = Int32Array.from(this.joints, j => j.q); this.jdq = Int32Array.from(this.joints, j => j.dq);
    this.mus = Muscle.makeMuscles(BIPED.joints.map(j => j.id));
    this.exc = new Float64Array(NM); this.mfat = new Float64Array(NM); this.mtq = new Float64Array(NM);
    this.senseHist = Array.from({ length: HIST }, () => new Float32Array(SENSES)); this.excHist = Array.from({ length: HIST }, () => new Float64Array(NM));
    this.frame = 0; this.histFilled = false; this.prevHeadVel = null;   // delays: what was sensed and commanded each brain step
    this.grip = false; this.held = null; this.gripAnchor = null;
    this.harness = null;                    // test mode: { x, y, tilt } holds the hips up
    this.fallen = false;
    this.energyMax = opts.energy || 2000;   // joules in the store at the start
    this.energyLeft = this.energyMax;
    this.used = 0; this.power = 0;          // joules burned so far; watts, smoothed (for display)
    this.terrain = opts.terrain || null;    // obstacles on the ground, for sensing
    for (const j of this.joints) data.qpos[j.q] = j.spec.rest;
    mj.mj_forward(model, data);
    // start already standing: muscles settle at a light resting tone before time starts
    for (let k = 0; k < 400; k++) for (let m = 0; m < NM; m++) this.mus[m].step(0.1, data.qpos[this.jq[m >> 1]], 1 / 400);
    this.savePositions();
  }
  savePositions() { const p = this.data.xpos; for (let b = 0; b < this.model.nbody; b++) { this.prev[3 * b] = p[3 * b]; this.prev[3 * b + 1] = p[3 * b + 2]; this.prev[3 * b + 2] = this.rot(b); } }
  rot(b) { const m = this.data.xmat; return Math.atan2(-m[9 * b + 2], m[9 * b + 8]); }
  groundAt(x) { return this.terrain ? terrainHeight(this.terrain, x) : 0; }
  footClear(id) { const f = this.parts[id].translation(); return f.y - 0.03 - this.groundAt(f.x); }
  /** Height above the ground of a sole point: footEnd('footL', -1) heel, +1 ball; footEnd('toesL', +1) toe tip. */
  footEnd(id, end) {
    const p = this.parts[id], sp = p.spec, t = p.translation(), a = p.rotation();
    const x = t.x + end * sp.hx * Math.cos(a) + sp.hy * Math.sin(a), y = t.y + end * sp.hx * Math.sin(a) - sp.hy * Math.cos(a);
    return y - this.groundAt(x);
  }
  /** Lowest point of a whole foot (heel, ball or toe tip) above the ground. */
  soleClear(side) { return Math.min(this.footEnd('foot' + side, -1), this.footEnd('foot' + side, 1), this.footEnd('toes' + side, 1)); }
  /** Where a joint is in the world right now. */
  jointPos(id) {
    const j = this.joints.find(k => k.spec.id === id), pa = j.a.spec, t = j.a.translation(), a = j.a.rotation(), lx = j.spec.x - pa.x, ly = j.spec.y - pa.y;
    return { x: t.x + lx * Math.cos(a) - ly * Math.sin(a), y: t.y + lx * Math.sin(a) + ly * Math.cos(a) };
  }
  tiredness(group) { let s = 0, n = 0; for (const j of this.joints) if (group === 'legs' ? /hip|knee|ankle/.test(j.spec.id) : /shoulder|elbow/.test(j.spec.id)) { s += j.fatigue; n++; } return s / n; }
  angle(j) { return this.data.qpos[j.q]; }
  speed(j) { return this.data.qvel[j.dq]; }
  /** Torso position relative to where this body started. */
  pos() { const t = this.torso.translation(); return { x: t.x - this.x0, y: t.y }; }
  headY() { return this.head.translation().y; }
  /** How far the body leans from upright: the angle of the line from the pelvis to the head. */
  lean() { const p = this.torso.translation(), h = this.head.translation(); return Math.atan2(-(h.x - p.x), h.y - p.y); }
  handPos(fore) { const f = fore || this.hand, t = f.translation(), a = f.rotation(); return { x: t.x + Math.sin(a) * 0.16, y: t.y - Math.cos(a) * 0.16 }; }
  /** Centre of mass of the whole body and its forward speed. */
  com() { let m = 0, x = 0, vx = 0; for (const p of this.partList) { const k = p.mass(); m += k; x += k * this.data.xipos[3 * p.id]; vx += k * this.vel[3 * p.id]; } return { x: x / m, vx: vx / m }; }

  /** Fills out[] with what the body senses (see SENSES). task = { dx, dy, a } extra inputs from the task. */
  /** What the body reports right now (see SENSES), before any nerve delay. task = { dx, dy, a } from the task. */
  senseNow(out, time, task) {
    const q = this.data.qpos, a = this.head.rotation(), hv = this.head.linvel();
    const acc = this.prevHeadVel ? { x: (hv.x - this.prevHeadVel.x) / DT, y: (hv.y - this.prevHeadVel.y) / DT } : { x: 0, y: 0 };
    this.prevHeadVel = hv;
    let i = 0;
    out[i++] = Math.sin(a); out[i++] = Math.cos(a); out[i++] = this.head.angvel() * 0.25;     // inner ear: tilt, spin
    out[i++] = Math.max(-1, Math.min(1, acc.x * 0.05)); out[i++] = Math.max(-1, Math.min(1, acc.y * 0.05));   // and acceleration
    out[i++] = hv.x * 0.3; out[i++] = hv.y * 0.3;                                              // seeing yourself move
    for (const j of this.joints) { const s = j.spec; out[i++] = ((q[j.q] - s.lo) / (s.hi - s.lo)) * 2 - 1; }   // joint position
    for (let m = 0; m < NM; m++) out[i++] = this.mus[m].vn;                                    // stretch sensors
    for (let m = 0; m < NM; m++) out[i++] = Math.min(1.5, this.mus[m].force / this.mus[m].F0); // tendon force sensors
    const press = h => Math.max(0, 1 - h / 0.015);                                            // touch: 1 = pressed down
    for (const s of ['L', 'R']) { out[i++] = press(this.footEnd('foot' + s, -1)); out[i++] = press(this.footEnd('foot' + s, 1)); out[i++] = press(this.footEnd('toes' + s, 1)); }
    out[i++] = Math.sin(time * Math.PI * 2); out[i++] = Math.cos(time * Math.PI * 2);        // a 1 Hz rhythm
    out[i++] = task ? task.dx : 0; out[i++] = task ? task.dy : 0;
    out[i++] = this.grip ? 1 : 0; out[i++] = task ? task.a : 0;
    const tx = this.head.translation().x;
    for (const d of AHEAD) out[i++] = this.groundAt(tx + d) * 5;                              // what's on the ground ahead
    out[i++] = this.energyLeft / this.energyMax; out[i++] = this.tiredness('legs'); out[i++] = this.tiredness('arms');
    for (const k of INTENTS) out[i++] = this.intent === k ? 1 : 0;                           // what it's trying to do
    return out;
  }
  /** Fills out[] with what the brain gets: each sense as it was SENSE_DELAY brain steps ago (see SENSES). */
  sense(out, time, task) {
    const now = this.senseHist[this.frame % HIST];
    this.senseNow(now, time, task);
    if (!this.histFilled) { for (const h of this.senseHist) h.set(now); this.histFilled = true; }   // at the start: as if it had always been so
    for (let i = 0; i < SENSES; i++) out[i] = this.senseHist[(this.frame - SENSE_DELAY[i] + HIST) % HIST][i];
    return out;
  }
  /** actions[0..19]: muscle excitations (negative = off). override: { jointId: angle } joints steered to an angle
      instead (test sliders, the ideal) by a simple servo made of that joint's two muscles. */
  act(actions, override, servo = IDEAL_SERVO) {
    this.limp = false;
    for (let m = 0; m < NM; m++) this.exc[m] = clamp01(actions[m]);
    for (const j of this.joints) {
      const t = override && override[j.spec.id];
      if (t === undefined || t === null) { j.target = this.angle(j); continue; }
      const u = servo.kp * (t - this.angle(j)) - servo.kd * this.speed(j);
      this.exc[2 * j.i] = clamp01(Math.max(0, -u) + servo.co); this.exc[2 * j.i + 1] = clamp01(Math.max(0, u) + servo.co);   // both keep some tone
      j.target = t;
    }
  }
  /** Brain off: every muscle relaxes and the body goes limp, like someone unconscious: the stretch reflexes are
      suppressed too (otherwise a lying body keeps twitching, one muscle's reflex stretching the other's). */
  relax() { this.exc.fill(0); this.limp = true; for (const j of this.joints) j.target = this.angle(j); }
  /** One brain step of physics: SUB sub-steps, each with the muscles' joint torques, pushes, harness and grip. */
  stepPhysics() {
    const mj = this.mj, m = this.model, d = this.data, low = Math.max(0.1, Math.min(1, this.energyLeft / (0.15 * this.energyMax)));   // running on empty: crippling
    // what reaches each muscle: the command sent MOTOR_DELAY brain steps ago, plus the spinal stretch reflex (a muscle
    // being stretched fast tenses by itself, from its own stretch sensor, ~17 ms later: the last brain step's reading)
    this.excHist[this.frame % HIST].set(this.exc);
    const drive = this.drive || (this.drive = new Float64Array(NM));
    for (let k = 0; k < NM; k++) drive[k] = this.excHist[(this.frame - MOTOR_DELAY[k] + HIST) % HIST][k];
    if (!this.limp) for (let k = 0; k < NM; k++) {
      const stretch = Math.max(0, this.mus[k].vn - REFLEX.threshold), opposite = drive[k ^ 1];   // k ^ 1: the other muscle of the pair
      drive[k] = clamp01(drive[k] + REFLEX.gain * stretch * (1 - opposite));
    }
    this.frame++;
    const tor = this.torso.id, xf = d.xfrc_applied, qf = d.qfrc_applied, P = this.pending;
    if (this.gripAnchor) { const e = m.eq_data; for (let k = 0; k < 6; k++) e[k] = this.gripAnchor[k]; }   // this body's grip point (the model is shared)
    if (d.eq_active && d.eq_active.length) d.eq_active[0] = this.grip ? 1 : 0;
    const glass = this.held ? this.objects.glass : null, gdof = glass ? m.jnt_dofadr[m.body_jntadr[glass.id]] + 2 : -1;
    // the harness's brake as damping on the pelvis's own joints: MuJoCo applies joint damping implicitly, so it stays
    // stable on a light pelvis (as a plain force it overshot and flung the legs). The model is shared, so set it per body.
    const hb = this.harness ? (this.harness.tiltOnly ? [0, 0, 300] : [2000, 2000, 300]) : [0, 0, 0];
    for (let k = 0; k < 3; k++) m.dof_damping[k] = hb[k];
    for (let n = 0; n < SUB; n++) {
      for (let i = 0; i < NJ; i++) {
        const q = d.qpos[this.jq[i]]; let tq = 0;
        for (let s = 0; s < 2; s++) { const k = 2 * i + s, t = this.mus[k].step(drive[k] * (1 - 0.6 * this.mfat[k]) * low, q, H); this.mtq[k] = t; tq += t; }
        qf[this.jdq[i]] = tq;
      }
      for (let b = 1; b < m.nbody; b++) { xf[6 * b] = P[3 * b]; xf[6 * b + 2] = P[3 * b + 1]; xf[6 * b + 4] = -P[3 * b + 2]; }
      if (this.harness) {   // test mode: a strong spring holds the hips in place and the pelvis at a tilt (its brake is set below)
        const h = this.harness, tx = d.xpos[3 * tor], ty = d.xpos[3 * tor + 2];
        if (!h.tiltOnly) { xf[6 * tor] += 30000 * (h.x - tx); xf[6 * tor + 2] += 30000 * (h.y - ty); }
        xf[6 * tor + 4] += -(3000 * (h.tilt - d.qpos[2]));
      }
      if (gdof >= 0) {   // automatic wrist: gently keeps a held glass level (limited strength, so rough moves still spill)
        const a = wrap(glass.rotation()); qf[gdof] = Math.max(-0.25, Math.min(0.25, -0.6 * a - 0.04 * d.qvel[gdof]));
      }
      mj.mj_step(m, d);
    }
    if (gdof >= 0) qf[gdof] = 0;
    P.fill(0);
    const p = d.xpos;
    for (let b = 0; b < m.nbody; b++) {
      const r = this.rot(b);
      this.vel[3 * b] = (p[3 * b] - this.prev[3 * b]) / DT; this.vel[3 * b + 1] = (p[3 * b + 2] - this.prev[3 * b + 1]) / DT; this.vel[3 * b + 2] = wrap(r - this.prev[3 * b + 2]) / DT;
    }
    this.savePositions();
  }
  /** Joint angles as { jointId: angle }, plus 'torso' (world tilt). Same shape as a motion-clip pose. */
  pose() { const p = { torso: wrap(this.torso.rotation()) }; for (const j of this.joints) p[j.spec.id] = this.angle(j); return p; }
  /** Muscles: energy and fatigue. Call once per brain step.
      Energy: a resting cost, plus every switched-on muscle costs energy in proportion to its size and activation,
      even when holding still (like real muscle), plus the work it does (at ~25% efficiency).
      Fatigue: sustained activation tires a muscle, rest recovers it, and a tired muscle is weaker. */
  muscles() {
    let w = BASAL_W;
    for (let k = 0; k < NM; k++) {
      const mu = this.mus[k], a = mu.a, om = this.data.qvel[this.jdq[k >> 1]];
      w += a * mu.F0 * mu.l0 * MAINT + Math.max(0, this.mtq[k] * om) * WORK_COST;
      this.mfat[k] = Math.max(0, Math.min(1, this.mfat[k] + DT * (TIRE * a * a * a - RECOVER * this.mfat[k])));   // effort cubed: hard sustained effort wears out fast
    }
    for (const j of this.joints) {
      j.fatigue = (this.mfat[2 * j.i] + this.mfat[2 * j.i + 1]) / 2;
      const up = this.mus[2 * j.i + 1], dn = this.mus[2 * j.i];
      const net = this.mtq[2 * j.i] + this.mtq[2 * j.i + 1];
      j.effort = Math.max(-1, Math.min(1, net / ((net >= 0 ? up.F0 * up.arm : dn.F0 * dn.arm) || 1)));   // -1..1 of the strength that way
    }
    this.energyLeft = Math.max(0, this.energyLeft - w * DT);
    this.used += w * DT;
    this.power += (w - this.power) * 0.05;
  }
  checkFallen() {
    // fallen = head low, torso tipped over, or hips down low. Agents found two cheap ways to "stand":
    // sitting down, and dropping into the splits. Both count as fallen now.
    const g = this.groundAt(this.torso.translation().x);
    if (!this.fallen && (this.headY() - g < 1.15 || this.torso.translation().y - g < this.hipsLow || Math.abs(this.lean()) > 1.3)) this.fallen = true;
    return this.fallen;
  }
  /** Give the whole body a forward speed (the small random push at the start of an attempt). */
  push(vx) { this.data.qvel[0] += vx * 0.45; }
  /** Test mode: hold the hips up (or let go). tiltOnly: only keep the torso upright, free to move (the test kit's jump). */
  setHarness(on, tilt = 0, tiltOnly = false) { const t = this.torso.translation(); this.harness = on ? { x: t.x, y: ROOT_Y + 0.01, tilt, tiltOnly } : null; if (on) this.fallen = false; }
  /** Close the hand on obj: a hinge at the point where the hand touches it.
      Held near the top it hangs upright; held low it tips over (that's for the agent to discover). */
  holdObject(obj, hx, hy) {
    if (this.grip) return;
    const h = this.handPos(), t = obj.translation(), a = obj.rotation(), c = Math.cos(a), s = Math.sin(a);
    const lx = Math.max(-hx, Math.min(hx, (h.x - t.x) * c + (h.y - t.y) * s));
    const ly = Math.max(-hy, Math.min(hy, -(h.x - t.x) * s + (h.y - t.y) * c));
    // hinge exactly where that point of the object already is, so closing the hand doesn't yank the object
    const wx = t.x + lx * c - ly * s, wy = t.y + lx * s + ly * c;
    const f = this.hand.translation(), fa = this.hand.rotation(), fc = Math.cos(fa), fs = Math.sin(fa);
    this.gripAnchor = [(wx - f.x) * fc + (wy - f.y) * fs, 0, -(wx - f.x) * fs + (wy - f.y) * fc, lx, 0, ly];
    this.grip = true; this.held = obj; this.gripAt = ly / hy;     // -1 = bottom of the object, +1 = top
  }
  wristReflex() {}   // part of stepPhysics now (it runs every sub-step)
  release() { this.grip = false; this.held = null; this.gripAnchor = null; if (this.data.eq_active && this.data.eq_active.length) this.data.eq_active[0] = 0; }
  freeze() {}        // a finished body is simply no longer stepped
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

/* ---------- reference movements: what a person would do (played on the body in Test mode, never trained on) ----------
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
/** Both legs and both arms alike: (torso tilt, hip, knee, ankle, shoulder, elbow). */
const JUMP_POSE = (torso, hip, knee, ankle, shoulder, elbow) => ({ torso, hipL: hip, hipR: hip, kneeL: knee, kneeR: knee, ankleL: ankle, ankleR: ankle, shoulderL: shoulder, shoulderR: shoulder, elbowL: elbow, elbowR: elbow });
const REFERENCE = {
  stand: { id: 'ref-stand', name: 'Reference stance', skill: 'stand', loop: true, period: 1, keys: [{ t: 0, grip: 0, pose: Object.assign({}, REST_POSE) }] },
  walk: walkReference(),
  // crouch with the arms swung back, spring up as the arms swing overhead, reach for the fruit, land with bent knees.
  // (Found for the old motor body; on real muscles a jump needs its muscles fired fully in sequence, which this
  // angle-steering ideal doesn't do yet, so it falls short. The muscle body itself can jump high enough.)
  jump: { id: 'ref-jump', name: 'Reference jump', skill: 'jump', loop: false, period: 2.12,
    aim: { from: 0.7, target: st => st.pickedAt === null ? { x: st.fx, y: st.fy } : null },   // reach for the fruit until it's picked
    keys: [
      { t: 0, grip: 0, pose: {} },
      { t: 0.49, grip: 0, pose: JUMP_POSE(-0.92, 1.7, -0.88, -0.33, -0.98, 0.2) },     // crouch, arms back
      { t: 0.54, grip: 0, pose: JUMP_POSE(-0.92, 1.7, -0.88, -0.33, -0.98, 0.2) },
      { t: 0.59, grip: 0, pose: JUMP_POSE(-0.02, -0.46, 0, 0.04, 2.5, -0.52) },        // spring: legs straight, arms up
      { t: 1.10, grip: 0, pose: JUMP_POSE(-0.24, -0.05, -0.66, 0.63, 0.52, 0.4) },     // land with bent knees
      { t: 2.12, grip: 0, pose: {} },
    ] },
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
/* ---------- playing the ideal: can this body and physics do the skill at all? ----------
   The reference movement steers every joint through its muscle pair (IDEAL_SERVO), with simple reflexes on top:
   the ankles keep the centre of mass over the feet, the hips keep the torso at the tilt the movement asks for (both
   off while airborne), the legs swing under the body before landing, and the arms aim at what the skill reaches for.
   Never trained on.                                                                                                */
const BALANCE = { ax: 4.67, av: 0.671, hx: 1.63, hv: 0.186, land: 0.2 };   // ankle: rad per m of lean, per m/s; hip: per rad of tilt, per rad/s; landing: leg angle per m/s
const IDEAL_SERVO = { kp: 1.58, kd: 0.0645, co: 0.188 };                  // excitation per rad of error, per rad/s; co-contraction (tone)
// (tuned on this body: it stands without shoves, though it sways and drifts; it can't yet survive Stand's full shoves,
//  which would take a step. Hand-made balance on realistic muscles is hard; the agents learn their own.)
/** The ideal's joint targets (and grip) at time t, for this body as it is right now (st: the task's state). */
function idealPose(skill, body, t, st) {
  const clip = REFERENCE[skill], pose = clipPose(clip, t), g = BALANCE;
  // reaching: from clip.aim.from on, both arms point straight at the target (you look at what you reach for)
  const target = clip.aim && st && t >= clip.aim.from ? clip.aim.target(st) : null;
  if (target) {
    const sp = body.jointPos('shoulderR'), ca = body.chest.rotation();
    const sh = wrap(Math.atan2(target.x - sp.x, -(target.y - sp.y)) - ca);
    for (const s of ['L', 'R']) { pose['shoulder' + s] = Math.max(-1, Math.min(3, sh)); pose['elbow' + s] = 0; }
  }
  const airborne = body.soleClear('L') > 0.02 && body.soleClear('R') > 0.02, c = body.com();
  if (airborne) {
    // landing: swing the legs to point down under the body, a little ahead in the direction it's moving
    const leg = Math.max(-0.4, Math.min(0.4, g.land * c.vx)) - wrap(body.torso.rotation());
    for (const s of ['L', 'R']) pose['hip' + s] = Math.max(leg, Math.min(pose['hip' + s], leg + 0.6));
  } else {
    const feet = (body.parts.footL.translation().x + body.parts.footR.translation().x) / 2;
    const ankle = g.ax * (c.x - feet) + g.av * c.vx, hip = g.hx * (body.lean() - pose.torso) + g.hv * body.data.qvel[2];
    for (const s of ['L', 'R']) { pose['ankle' + s] -= ankle; pose['hip' + s] += hip; }
  }
  return pose;
}
/** A one-off movement (jump, pick-up) is over `after` seconds past its last keyframe; stand and walk loop forever. */
function idealOver(skill, t, after = 1) { const c = REFERENCE[skill]; return !c.loop && t > c.keys[c.keys.length - 1].t + after; }
/** Runs the ideal on each variant at full difficulty; returns [{ variant, ok, text }]. Check this before training. */
function idealCheck(mj, skill, opts) {
  return [-1, 0, 1].map(variant => {
    const tr = new Trial(mj, skill, [freshBrain(Brain.makeRng(1))], Object.assign({ seed: 5, variant, hard: 1, push: 0, noise: 0, earlyStop: false, ideal: true }, opts));
    tr.run();
    const a = tr.agents[0], out = { variant, ok: tr.successes()[0], text: tr.task.describe(a.st, a.body) };
    tr.free();
    return out;
  });
}
/** Where every part would be for a pose, given the torso position. */
function poseParts(pose, tx, ty) {
  const out = { [BIPED.root]: { x: tx, y: ty, a: pose.torso } };
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
   world(trial)           -> optional: { objects: MJCF for the task's objects, grip: true if the hand can grip }
   setup(body, variant, hard, trial) -> per-agent state (the objects it gets are body.objects)
   senseTask(st, body)    -> { dx, dy, a } extra inputs
   step(st, body, motors, trial) -> called every brain step after act()
   done(st, body)         -> optional: finished early (reached the goal)
   score(st, body)        -> fitness (higher is better)
   Every task adds energy left at the end to the score: the same job done for less energy wins.
   Energy is in game joules: a fully tensed body burns ~9 kW, a relaxed one a few hundred W.      */
const GLASS = { hx: 0.035, hy: 0.06, mass: 0.30 };
const GRIP_REACH = 0.11;    // palm centre to glass surface for the hand to close on it (fingers reach ~10 cm)
const TABLE = { hx: 0.16, hy: 0.02, leg: 0.015, mass: 7.8 };   // a free-standing table, ~8 kg: it slides and tips
const energyBonus = body => 3 * body.energyLeft / body.energyMax;
const FRUIT = { r: 0.05, reachUp: 1.98 };   // reachUp: hand centre with an arm straight up, standing flat-footed (shoulder 1.40 + arm 0.58)
/** Where the fruit hangs: just within reach at first (arm up, hand touching it), then ~30 cm higher at full difficulty,
    which needs about a 20 cm jump on top of reaching up on tiptoe. */
const fruitSpot = (hard, variant) => ({ x: 0.12 + 0.06 * (variant || 0) * hard, y: 1.98 + 0.32 * hard + 0.03 * (variant || 0) * hard });
/** Grab: where the glass and table stand. The glass starts within easy reach and moves around with the curriculum. */
function grabLayout(variant, hard) {
  const h = hard === undefined ? 1 : hard;
  const gx = 0.52 + 0.06 * h + (variant || 0) * 0.07 * h, top = 0.96 + 0.03 * (variant || 0) * h;
  return { gx, top, tx: gx - GLASS.hx + 0.01 + TABLE.hx };   // the glass overhangs the front edge by 1 cm
}
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
      if (trial && trial.steps % 120 === 60) body.chest.applyImpulse({ x: (trial.steps % 240 === 60 ? 1 : -1) * 28 * trial.hard, y: 0 });   // a shove to the chest
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
    setup(body, variant, hard, trial) { return { alive: 0, foodX: trial ? trial.foodX : 10, reachedAt: null }; },
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
  jump: {
    // Food is out of reach: a fruit hangs above the head. Touch it, then land and stay on your feet.
    name: 'Jump for fruit', seconds: 6, energy: 9000,
    body: { hipsLow: 0.60 },   // a jump needs a deep crouch: the pelvis can go lower before it counts as a fall
    blurb: 'A fruit hangs just out of reach. Jump, touch it with a hand, and land on your feet.',
    setup(body, variant, hard) {
      const f = fruitSpot(hard === undefined ? 1 : hard, variant);
      return { fx: body.x0 + f.x, fy: f.y, alive: 0, minDist: 9, pickedAt: null, steady: 0 };
    },
    hands(body) { return [body.handPos(body.parts.foreR), body.handPos(body.parts.foreL)]; },
    senseTask(st, body) {
      // where the fruit is from the nearer hand; a = 1 once it's picked
      const [r, l] = this.hands(body), h = Math.hypot(st.fx - r.x, st.fy - r.y) <= Math.hypot(st.fx - l.x, st.fy - l.y) ? r : l;
      return { dx: Math.max(-2, Math.min(2, (st.fx - h.x) * 2)), dy: Math.max(-2, Math.min(2, (st.fy - h.y) * 2)), a: st.pickedAt !== null ? 1 : 0 };
    },
    step(st, body, motors, trial) {
      st.alive += DT;
      const t = trial ? trial.time : 0;
      this.hands(body).forEach((h, i) => {
        const d = Math.max(0, Math.hypot(st.fx - h.x, st.fy - h.y) - FRUIT.r - 0.045);
        st.minDist = Math.min(st.minDist, d);
        if (st.pickedAt === null && d < 0.01) { st.pickedAt = t; st.hand = i; }   // 0 = right hand, 1 = left
      });
      // after picking it: feet back on the ground and the body settled
      const grounded = body.soleClear('L') < 0.02 && body.soleClear('R') < 0.02, still = Math.abs(body.torso.linvel().y) < 0.3;
      st.steady = st.pickedAt !== null && grounded && still ? st.steady + DT : 0;
    },
    done(st) { return st.steady >= 1; },   // picked it and landed: no need to keep simulating
    score(st, body) {
      let f = 3 * (1 - Math.min(1, st.minDist / 0.8)) + st.alive * 0.3 + energyBonus(body);   // get a hand close, then touch
      if (st.pickedAt !== null) f += 5 + (body.fallen ? 0 : 3 + Math.min(1, st.steady) * 2);   // landed and stayed up
      if (body.fallen) f -= 3;
      return f;
    },
    creditRest(st, body, trial) { st.alive += (trial.maxSteps - trial.steps) * DT; },
    describe(st, body) {
      return st.pickedAt !== null ? (body.fallen ? 'touched the fruit, then fell' : `got the fruit at ${st.pickedAt.toFixed(1)} s${st.steady >= 1 ? ' · landed' : ''}`)
        : `hand ${(st.minDist * 100).toFixed(0)} cm short${body.fallen ? ' · fell' : ''}`;
    },
    success(st, body) { return st.pickedAt !== null && !body.fallen; },
    successText: 'touched the fruit and landed on its feet',
  },
  grab: {
    name: 'Pick up the glass', seconds: 7, energy: 12000,
    blurb: 'A glass of water stands on a free-standing table. Pick it up and lift it without spilling or knocking the table over.',
    // The table is free-standing (~8 kg): lean on it and it slides, bump it hard and it tips over.
    world(trial) {
      const { gx, top, tx } = grabLayout(trial.variant, trial.hard), legH = (top - 2 * TABLE.hy) / 2, legM = TABLE.mass * 0.4;
      const table = objectXML('table', tx, top - TABLE.hy,
        `<geom type="box" size="${TABLE.hx} 0.1 ${TABLE.hy}" mass="${TABLE.mass - 2 * legM}" ${CONTACT.object} friction="0.8"/>` +
        [-1, 1].map(side => `<geom type="box" pos="${f3(side * (TABLE.hx - TABLE.leg))} 0 ${f3(-TABLE.hy - legH)}" size="${TABLE.leg} 0.1 ${f3(legH)}" mass="${legM}" ${CONTACT.object} friction="0.6"/>`).join(''));
      const glass = objectXML('glass', gx, top + GLASS.hy + 0.001, `<geom type="box" size="${GLASS.hx} 0.04 ${GLASS.hy}" mass="${GLASS.mass}" ${CONTACT.object} friction="1.0"/>`, 0.0007);
      return { objects: table + glass, grip: true };
    },
    setup(body, variant, hard) {
      const { gx, top, tx } = grabLayout(variant, hard);
      return { table: body.objects.table, glass: body.objects.glass, gx, top, tableHome: body.x0 + tx, rest: top + GLASS.hy, minDist: 9, grabbed: false, lift: 0, spilled: false, tableOver: false, alive: 0, reward: 0, touched: 0, held: 0 };
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
   One MuJoCo world is compiled per attempt (the same obstacles and objects for everyone, so it's fair), and every
   body gets its own copy of that world's state, so bodies and their objects never interact, and replaying a brain
   with the same seed gives exactly the same result. The seed decides a small random push at the start and sensor
   noise, so a brain only scores well if its balance holds up.                                                       */
class Trial {
  constructor(mj, taskId, brains, opts = {}) {
    this.R = this.mj = mj; this.task = TASKS[taskId]; this.taskId = taskId;
    this.time = 0; this.steps = 0; this.maxSteps = Math.round(this.task.seconds / DT);
    this.variant = opts.variant || 0;
    this.hard = opts.hard === undefined ? 1 : opts.hard;
    this.keepSimulating = !!opts.keepSimulating;   // watching: let a fallen body finish falling
    this.noise = opts.noise === undefined ? 0.02 : opts.noise;
    this.assist = opts.assist || 0;                  // grab: grip assist, 1 = hand closes on touch, 0 = brain decides
    this.override = opts.override || null;           // test mode: { jointId: angle } you're moving
    this.gripOverride = opts.gripOverride === undefined ? null : opts.gripOverride;   // test mode: hand forced open (-1) or closed (1)
    this.brainOff = false;                           // test mode: muscles slack, the body doesn't react
    this.ideal = !!opts.ideal;                       // the reference movement (with reflexes) drives the body instead of the brain
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
    const extra = this.task.world ? this.task.world(this) : {};
    this.model = mj.MjModel.from_xml_string(worldXML({ terrain: this.terrain, objects: extra.objects, grip: extra.grip }));
    this.agents = brains.map(params => {
      const data = new mj.MjData(this.model);
      const body = new Biped(mj, this.model, data, Object.assign({ terrain: this.terrain, energy: this.energy }, this.task.body, opts.body));
      body.push(push); body.intent = taskId;
      const st = this.task.setup(body, this.variant, this.hard, this);
      return { data, body, st, net: new Brain.Network(SIZES, params), done: false };
    });
  }
  get finished() { return this.steps >= this.maxSteps || this.agents.every(a => a.done); }
  step() {
    const rng = this.rng, inp = this.input;
    for (const a of this.agents) {
      if (a.done) { if (this.keepSimulating) { a.body.relax(); a.body.stepPhysics(); } continue; }
      a.body.sense(inp, this.time, this.task.senseTask(a.st, a.body));
      if (this.noise) for (let i = 0; i < inp.length; i++) inp[i] += (rng() - 0.5) * 2 * this.noise;
      const out = a.net.forward(inp);
      if (this.gripOverride !== null) out[MOTORS - 1] = this.gripOverride;
      if (this.ideal) { const p = idealPose(this.taskId, a.body, this.time, a.st); out[MOTORS - 1] = p.grip ? 1 : -1; a.body.act(out, p); }
      else if (this.brainOff) a.body.relax(); else a.body.act(out, this.override);
      this.task.step(a.st, a.body, out, this);
      a.body.stepPhysics();
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
  free() { for (const a of this.agents) a.data.delete(); this.agents = []; if (this.model) { this.model.delete(); this.model = null; } }
}

/** A new, untrained brain: random, but every muscle starts with a light resting tone (excitation ~0.1), like a
    newborn's, instead of half the muscles fully on and half off. */
function freshBrain(rng) {
  const net = Brain.Network.random(SIZES, rng), hid = SIZES[1], start = hid * (SIZES[0] + 1);
  for (let o = 0; o < NM; o++) {
    const row = start + o * (hid + 1);
    for (let q = 0; q < hid; q++) net.params[row + q] *= 0.3;
    net.params[row + hid] = Math.atanh(0.1);   // output bias: resting tone
  }
  return net.params;
}

/** Senses that a skill never uses (always 0 while training it), by index into the sense list. */
const T = SENSE_AT.task, SENSE_TASK = [T, T + 1, T + 2, T + 3], SENSE_AHEAD = AHEAD.map((_, i) => SENSE_AT.ahead + i);   // (layout: see SENSES)
const UNUSED_SENSES = { stand: SENSE_TASK.concat(SENSE_AHEAD), walk: [T + 1, T + 2, T + 3], grab: SENSE_AHEAD, jump: [T + 2].concat(SENSE_AHEAD) };
/** Start skill `to` from a brain trained on skill `from`: cut the connections from senses that were
    always blank in `from`. Their weights were never tested, so leaving them in makes the brain flail
    the moment those senses light up (a Stand brain fell within 0.4 s when it first saw the glass). */
function transferBrain(params, from, to) {
  const out = Float32Array.from(params), fan = SIZES[0];
  if (from === to) return out;
  for (let j = 0; j < SIZES[1]; j++) for (const i of UNUSED_SENSES[from] || []) out[j * (fan + 1) + i] = 0;
  if (to === 'grab' || to === 'jump') {
    // Loosen the arms and hand: a Stand brain can hold them pinned (tanh saturated), where small changes to the
    // brain don't move them at all (Pax's arms never moved). Arm muscles go back to resting tone; legs are kept.
    const hid = SIZES[1], start = SIZES[1] * (fan + 1);
    for (const o of ARM_OUTPUTS) { const row = start + o * (hid + 1); for (let q = 0; q < hid; q++) out[row + q] *= 0.25; out[row + hid] = o < NM ? Math.atanh(0.1) : 0; }
  }
  return out;
}

/* Curriculum. The difficulty of a skill is its "stage", counted in generations: shoves, noise and energy scarcity are
   full at stage 150, obstacles creep in from 60 to 400, the grip assist is gone by 200. The stage only goes up when the
   agent is coping (see nextStage), so a slow learner isn't pushed past what it can do. (It used to rise by one every
   generation regardless; with realistic muscles the agents fell behind and never caught up.)                       */
/** Curriculum level for a stage: 0 = gentle (no shoves, glass close), 1 = full difficulty. */
const hardness = stage => Math.min(1, stage / 150);
/** Grip assist for a stage: full at first, gone by stage 200. */
const gripAssist = stage => Math.max(0, 1 - stage / 200);
/** After a generation: the best brain succeeded in this share of its attempts -> the next stage. */
function nextStage(stage, successRate) {
  if (successRate >= 2 / 3) return stage + 1;            // coping: harder
  if (successRate <= 0) return Math.max(0, stage - 0.5);  // failing every attempt: a little easier
  return stage;                                          // struggling: stay and practise
}
/** The episodes every brain in a generation is tested on (same for all, so it's fair). generation seeds them. */
function episodeConfigs(taskId, stage, generation = stage) {
  const hard = hardness(stage), varied = taskId === 'grab' || taskId === 'jump', n = varied ? 3 : 2, out = [];
  for (let e = 0; e < n; e++) out.push({
    seed: Math.round(generation) * 7919 + e * 104729 + 1,
    variant: varied ? (e % 3) - 1 : 0,   // grab: glass nearer, middle, farther; jump: fruit nearer and lower, middle, farther and higher
    hard, push: hard, noise: 0.02 * hard,             // curriculum: shoves, sensor noise and obstacles grow with training
    assist: taskId === 'grab' ? gripAssist(stage) : 0,
    terrainLevel: terrainLevel(stage),
  });
  return out;
}
/** How many of its attempts the brain with the best combined score succeeded in (0..1). */
function bestSuccess(combined, successesPerEpisode) {
  let best = 0; for (let i = 1; i < combined.length; i++) if (combined[i] > combined[best]) best = i;
  return successesPerEpisode.reduce((s, ep) => s + (ep[best] ? 1 : 0), 0) / successesPerEpisode.length;
}
/** perEpisode[e][i] = score of brain i in episode e. Rewards brains that do well every time, not once. */
function combineScores(perEpisode) {
  return perEpisode[0].map((_, i) => {
    const fs = perEpisode.map(ep => ep[i]), m = fs.reduce((s, f) => s + f, 0) / fs.length;
    return m - 0.25 * (Math.max(...fs) - Math.min(...fs));
  });
}
/* ---------- the shared brain: one brain per agent, for every skill ----------
   A person doesn't have a separate brain for standing and walking: what they learn standing is used whenever they
   stand, walking included. So each agent has one brain. Each generation it's tested on the skill being learned and,
   once each, on every skill it already practises, so it doesn't forget them. Every skill has its own difficulty
   stage (it rises only while the agent copes with that skill). Scores are made comparable across skills by ranking:
   in every attempt, the best of the 48 variations gets 1 and the worst 0.                                          */
/** The attempts for one generation: { taskId, cfg } for the focus skill (its usual 2-3) and one of each other practised skill. */
function mixedEpisodes(stages, focus, generation) {
  const out = [];
  for (const k of SKILLS) {
    if (typeof stages[k] !== 'number') continue;
    const eps = episodeConfigs(k, stages[k], generation);
    for (const cfg of (k === focus ? eps : eps.slice(0, 1))) out.push({ taskId: k, cfg });
  }
  return out;
}
/** Scores per attempt -> one score per brain: the mean of its rank in each attempt, minus a little for inconsistency. */
function combineMixed(perEpisode) {
  const n = perEpisode[0].length, ranked = perEpisode.map(sc => {
    const order = sc.map((s, i) => i).sort((a, b) => sc[a] - sc[b]), r = new Float64Array(n);
    order.forEach((i, k) => { r[i] = n > 1 ? k / (n - 1) : 1; });
    return r;
  });
  return Array.from({ length: n }, (_, i) => { const v = ranked.map(r => r[i]), m = v.reduce((s, x) => s + x, 0) / v.length; return m - 0.25 * (Math.max(...v) - Math.min(...v)); });
}
/** After a generation: each practised skill's next stage, from how often the best brain succeeded at it. */
function nextStages(stages, episodes, combined, successesPerEpisode) {
  let best = 0; for (let i = 1; i < combined.length; i++) if (combined[i] > combined[best]) best = i;
  const out = Object.assign({}, stages);
  for (const k of Object.keys(stages)) {
    const mine = episodes.map((e, i) => e.taskId === k ? i : -1).filter(i => i >= 0);
    if (mine.length) out[k] = nextStage(stages[k], mine.reduce((s, i) => s + (successesPerEpisode[i][best] ? 1 : 0), 0) / mine.length);
  }
  return out;
}
/** One generation of the shared brain, scored on one CPU core: { scores, stages }. */
function evaluateMixed(mj, population, stages, focus, generation) {
  const eps = mixedEpisodes(stages, focus, generation), per = [], ok = [];
  for (const e of eps) { const tr = new Trial(mj, e.taskId, population, e.cfg); per.push(tr.run()); ok.push(tr.successes()); tr.free(); }
  const scores = combineMixed(per);
  return { scores, stages: nextStages(stages, eps, scores, ok) };
}

/** Scores a whole population in one go (used for training outside the page, e.g. in Node).
    Returns the scores; with full = true, { scores, successRate } (the best brain's share of successful attempts). */
function evaluate(mj, taskId, population, stage, generation = stage, full = false) {
  const per = [], ok = [];
  for (const cfg of episodeConfigs(taskId, stage, generation)) {
    const tr = new Trial(mj, taskId, population, cfg);
    per.push(tr.run()); ok.push(tr.successes()); tr.free();
  }
  const scores = combineScores(per);
  return full ? { scores, successRate: bestSuccess(scores, ok) } : scores;
}

const api = { SKILLS, INTENTS, mixedEpisodes, combineMixed, nextStages, evaluateMixed, DT, SUB, BIPED, ROOT_Y, SENSES, SENSE_AT, SENSE_LIST, SENSE_DELAY, MOTOR_DELAY, DELAY, REFLEX, MOTORS, SIZES, OUTPUT_GROUPS, AHEAD, GLASS, GRIP_REACH, TABLE, FRUIT, fruitSpot, TASKS, Biped, Part, Trial,
  freshBrain, hardness, gripAssist, terrainLevel, nextStage, bestSuccess, transferBrain, episodeConfigs, combineScores, evaluate, worldXML,
  distToBox, wrap, makeTerrain, terrainHeight, POSE_KEYS, REST_POSE, REFERENCE, clipPose, poseParts, BALANCE, IDEAL_SERVO, idealPose, idealOver, idealCheck,
  BASAL_W, MAINT, WORK_COST, TIRE, RECOVER, JOINT_DAMPING, JOINT_LIMIT_SOFTNESS };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.Body2D = api;
}
__body2dModule(typeof globalThis !== 'undefined' ? globalThis : this);
