/*
================================================================================
 GLASS BOX · PLAYGROUND  -  body3d.js
================================================================================
 The 3D body (design "A+", chosen from projects/playground/mockups/bodies.html)
 in a MuJoCo world. A 1.70 m, ~62 kg mannequin: pelvis, belly and chest with a
 bendable spine, a head on a neck, arms with ball hands, legs with feet and
 toes. Ball joints (hips, shoulders, spine, neck) are three hinges each, one
 per direction, so every direction can get its own muscle pair.

 MuJoCo's frame: x forward, y to the body's left, z up. Units: m, kg, s.
 Muscles: every joint direction has a pair (one pulls its angle up, one down), built by muscle.js with human
 strengths for a ~62 kg adult. Needs the MuJoCo module (loadMujocoClassic(), ../embodied-2d/vendor/mujoco.js)
 and Muscle (../embodied-2d/muscle.js). Senses and the brain come next.
================================================================================
*/
function __body3dModule(root) {
'use strict';
const Muscle = root.Muscle || (typeof require === 'function' ? require('../embodied-2d/muscle.js') : null);
const Brain = root.Brain || (typeof require === 'function' ? require('../embodied-2d/brain.js') : null);

const DT = 1 / 60, SUB = 6, H = DT / SUB;   // brain step; physics sub-steps (360 Hz), as in Embodied 2D
const SIDES = [['L', 1], ['R', -1]];         // left is +y

/* ---------- the body plan ----------
   Parts: name, parent, position (world, standing), mass, geoms (box half-sizes, capsules from-to, spheres; positions
   are world positions while standing). visual: how the page draws a box (softened edges). Joints sit in the child. */
const P = (x, y, z) => [x, y, z];
function plan() {
  const parts = [], joints = [];
  const part = (id, parent, pos, mass, geoms, extra) => parts.push(Object.assign({ id, parent, pos, mass, geoms }, extra));
  // a ball joint as three hinges: flex (about -y: + = forward / tip back for the trunk), side (about the body's
  // outward x: + = away from the midline), twist (about z)
  const ball = (id, body, at, side, lim) => {
    joints.push({ id: id + 'Flex', body, at, axis: [0, -1, 0], range: lim.flex, group: lim.group });
    joints.push({ id: id + 'Side', body, at, axis: [side || 1, 0, 0], range: lim.side, group: lim.group });
    joints.push({ id: id + 'Twist', body, at, axis: [0, 0, side || 1], range: lim.twist, group: lim.group });
  };
  const hinge = (id, body, at, axis, range, group) => joints.push({ id, body, at, axis, range, group });

  part('pelvis', null, P(0, 0, 1.00), 9.5, [{ type: 'box', pos: P(0, 0, 1.00), size: P(0.0925, 0.14, 0.095), soft: 0.03 }]);
  part('belly', 'pelvis', P(0.005, 0, 1.17), 5.0, [{ type: 'box', pos: P(0.005, 0, 1.17), size: P(0.085, 0.1275, 0.085), soft: 0.03 }]);
  ball('lumbar', 'belly', P(0, 0, 1.09), 1, { flex: [-0.9, 0.4], side: [-0.4, 0.4], twist: [-0.5, 0.5], group: 'trunk' });
  part('chest', 'belly', P(0, 0, 1.38), 8.8, [{ type: 'box', pos: P(0, 0, 1.38), size: P(0.1025, 0.16, 0.1325), soft: 0.035 }]);
  ball('thoracic', 'chest', P(0, 0, 1.25), 1, { flex: [-0.4, 0.2], side: [-0.3, 0.3], twist: [-0.4, 0.4], group: 'trunk' });
  part('head', 'chest', P(0.012, 0, 1.675), 4.5, [
    { type: 'capsule', from: P(0, 0, 1.49), to: P(0.005, 0, 1.57), r: 0.058, mass: 1.0 },
    { type: 'sphere', pos: P(0.012, 0, 1.675), r: 0.12, mass: 3.5 }]);
  ball('neck', 'head', P(0, 0, 1.53), 1, { flex: [-0.7, 0.6], side: [-0.6, 0.6], twist: [-1.2, 1.2], group: 'trunk' });
  for (const [s, sg] of SIDES) {
    const HIP = P(0, sg * 0.09, 0.92), KNEE = P(0.01, sg * 0.09, 0.50), ANKLE = P(0, sg * 0.09, 0.08);
    part('thigh' + s, 'pelvis', P(0.005, sg * 0.09, 0.71), 5.677, [{ type: 'capsule', from: HIP, to: KNEE, r: 0.062 }], { side: s });
    ball('hip' + s, 'thigh' + s, HIP, sg, { flex: [-0.5, 2.0], side: [-0.5, 0.8], twist: [-0.6, 0.6], group: 'legs' });
    part('shin' + s, 'thigh' + s, P(0.005, sg * 0.09, 0.29), 4.327, [{ type: 'capsule', from: KNEE, to: ANKLE, r: 0.046 }], { side: s });
    hinge('knee' + s, 'shin' + s, KNEE, [0, -1, 0], [-2.3, 0], 'legs');
    part('foot' + s, 'shin' + s, P(0.03, sg * 0.09, 0.03), 1.35, [{ type: 'box', pos: P(0.03, sg * 0.09, 0.03), size: P(0.0825, 0.045, 0.03), soft: 0.022, friction: 1.1 }], { side: s, foot: true });
    hinge('ankle' + s + 'Flex', 'foot' + s, ANKLE, [0, -1, 0], [-0.75, 0.35], 'legs');   // + = toes up
    hinge('ankle' + s + 'Side', 'foot' + s, ANKLE, [sg, 0, 0], [-0.35, 0.35], 'legs');   // + = sole turns outward
    part('toes' + s, 'foot' + s, P(0.14, sg * 0.09, 0.02), 0.23, [{ type: 'box', pos: P(0.14, sg * 0.09, 0.02), size: P(0.0275, 0.0425, 0.02), soft: 0.016, friction: 1.1 }], { side: s, toes: true });
    hinge('toe' + s, 'toes' + s, P(0.112, sg * 0.09, 0.02), [0, -1, 0], [-0.5, 1.0], 'legs');
    const SHO = P(0, sg * 0.19, 1.40), ELB = P(-0.01, sg * 0.22, 1.12), WRI = P(0.01, sg * 0.24, 0.86);
    part('upper' + s, 'chest', P(-0.005, sg * 0.205, 1.26), 2.715, [{ type: 'capsule', from: SHO, to: ELB, r: 0.042 }], { side: s });
    ball('shoulder' + s, 'upper' + s, SHO, sg, { flex: [-1.0, 3.0], side: [-0.3, 2.8], twist: [-1.0, 1.0], group: 'arms' });
    part('fore' + s, 'upper' + s, P(0, sg * 0.23, 0.99), 2.989, [
      { type: 'capsule', from: ELB, to: WRI, r: 0.036, mass: 2.2 },
      { type: 'sphere', pos: P(0.015, sg * 0.245, 0.80), r: 0.045, mass: 0.789, name: 'hand' + s, friction: 1.5 }], { side: s });
    hinge('elbow' + s, 'fore' + s, ELB, [0, -1, 0], [0, 2.5], 'arms');
  }
  return { id: 'mannequin3d-a+', parts, joints };
}
const BODY = plan();

/* ---------- muscles: a pair per joint direction ----------
   [peak torque N·m, moment arm m, tendon slack m, tendon strain at peak] for the muscle pulling the angle up and the
   one pulling it down, the joint's top speed (rad/s), and where the fibres are ideal (default: mid-range).
   Directions: Flex + = forward (trunk and head: tip back); Side + = away from the midline; Twist + = outward.
   Human figures for a ~62 kg adult; flex/extend numbers are the ones calibrated in Embodied 2D.                    */
const MUSCLES3D = {
  hipFlex:       { up: [150, 0.05, 0.10, 0.04], down: [220, 0.05, 0.10, 0.04], speed: 15, mid: 0.65 },   // flexors / glutes
  hipSide:       { up: [120, 0.05, 0.10, 0.04], down: [130, 0.05, 0.10, 0.04], speed: 10 },              // abductors / adductors
  hipTwist:      { up: [60, 0.03, 0.12, 0.05], down: [50, 0.03, 0.12, 0.05], speed: 10 },                // outward / inward rotators
  knee:          { up: [200, 0.045, 0.15, 0.045], down: [100, 0.03, 0.20, 0.04], speed: 20, mid: -1.15 }, // quadriceps / hamstrings
  ankleFlex:     { up: [40, 0.04, 0.20, 0.04], down: [150, 0.05, 0.25, 0.06], speed: 20, mid: -0.2 },   // shin / calf (Achilles)
  ankleSide:     { up: [30, 0.03, 0.10, 0.04], down: [35, 0.03, 0.10, 0.04], speed: 10 },                // evertors / invertors
  toe:           { up: [10, 0.02, 0.10, 0.04], down: [25, 0.02, 0.15, 0.05], speed: 15, mid: 0.2 },
  lumbarFlex:    { up: [200, 0.05, 0.20, 0.05], down: [150, 0.08, 0.20, 0.05], speed: 8, mid: -0.25 },  // back / abdominals
  lumbarSide:    { up: [150, 0.06, 0.20, 0.05], down: [150, 0.06, 0.20, 0.05], speed: 6 },
  lumbarTwist:   { up: [60, 0.04, 0.15, 0.05], down: [60, 0.04, 0.15, 0.05], speed: 6 },   // twist muscles: long springy tendons (short stiff ones made the light twisting parts shake)
  thoracicFlex:  { up: [100, 0.04, 0.15, 0.05], down: [70, 0.06, 0.15, 0.05], speed: 8, mid: -0.1 },
  thoracicSide:  { up: [80, 0.05, 0.15, 0.05], down: [80, 0.05, 0.15, 0.05], speed: 6 },
  thoracicTwist: { up: [40, 0.04, 0.12, 0.05], down: [40, 0.04, 0.12, 0.05], speed: 6 },
  neckFlex:      { up: [30, 0.03, 0.12, 0.05], down: [20, 0.025, 0.12, 0.05], speed: 10, mid: -0.05 },
  neckSide:      { up: [20, 0.025, 0.10, 0.05], down: [20, 0.025, 0.10, 0.05], speed: 8 },
  neckTwist:     { up: [12, 0.02, 0.12, 0.05], down: [12, 0.02, 0.12, 0.05], speed: 8 },
  shoulderFlex:  { up: [60, 0.03, 0.05, 0.04], down: [60, 0.03, 0.05, 0.04], speed: 20, mid: 1.0 },
  shoulderSide:  { up: [55, 0.03, 0.05, 0.04], down: [70, 0.03, 0.05, 0.04], speed: 15 },                // deltoid / adductors
  shoulderTwist: { up: [30, 0.025, 0.12, 0.05], down: [40, 0.025, 0.12, 0.05], speed: 20 },
  elbow:         { up: [55, 0.03, 0.10, 0.04], down: [40, 0.03, 0.10, 0.04], speed: 25, mid: 1.25 },    // biceps / triceps
};
const muscleKey = jointId => jointId.replace(/[LR](?=[A-Z]|$)/, '');   // 'hipLFlex' -> 'hipFlex', 'kneeR' -> 'knee'
function makeMuscles3D() {
  return BODY.joints.flatMap(j => {
    const g = MUSCLES3D[muscleKey(j.id)];
    return Muscle.makePair({ up: g.up, down: g.down, range: j.range, topSpeed: g.speed, mid: g.mid !== undefined ? g.mid : (j.range[0] + j.range[1]) / 2 });
  });
}
const NJ = BODY.joints.length, NM = 2 * NJ;   // 31 joint directions, 62 muscles (muscle 2i pulls joint i's angle down, 2i+1 up)
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const SERVO = { kp: 1.5, kd: 0.07, co: 0.15 };   // steering a joint to an angle with its two muscles (tests, the ideal)

/* ---------- the world, as MJCF ---------- */
// contacts: the body touches the ground, objects and itself (MuJoCo skips a part and its own parent automatically)
const CONTACT = { body: 'contype="2" conaffinity="3"', ground: 'contype="1" conaffinity="2"' };
const f = v => +v.toFixed(5), v3 = a => a.map(f).join(' ');
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
function bodyXML(opts = {}) {
  const kids = {}; for (const p of BODY.parts) (kids[p.parent || ''] = kids[p.parent || ''] || []).push(p);
  const geomXML = (p, g) => {
    const fr = g.friction || (p.foot || p.toes ? 1.1 : 0.7), mass = g.mass !== undefined ? g.mass : p.mass, name = g.name ? ` name="${g.name}"` : '';
    if (g.type === 'box') return `<geom${name} type="box" pos="${v3(sub3(g.pos, p.pos))}" size="${v3(g.size)}" mass="${f(mass)}" friction="${fr}" ${CONTACT.body}/>`;
    if (g.type === 'sphere') return `<geom${name} type="sphere" pos="${v3(sub3(g.pos, p.pos))}" size="${g.r}" mass="${f(mass)}" friction="${fr}" ${CONTACT.body}/>`;
    return `<geom${name} type="capsule" fromto="${v3(sub3(g.from, p.pos))} ${v3(sub3(g.to, p.pos))}" size="${g.r}" mass="${f(mass)}" friction="${fr}" ${CONTACT.body}/>`;
  };
  const jointXML = (j, p) => `<joint name="${j.id}" type="hinge" pos="${v3(sub3(j.at, p.pos))}" axis="${v3(j.axis)}" range="${j.range[0]} ${j.range[1]}" limited="true" armature="${p.toes ? 0.002 : 0.01}" damping="${opts.damping || 0}"/>`;
  const bodyX = (p, parentPos) => `<body name="${p.id}" pos="${v3(sub3(p.pos, parentPos || [0, 0, 0]))}">` +
    (p.parent ? BODY.joints.filter(j => j.body === p.id).map(j => jointXML(j, p)).join('') : '<freejoint name="root"/>') +
    p.geoms.map(g => geomXML(p, g)).join('') + (kids[p.id] || []).map(k => bodyX(k, p.pos)).join('') + '</body>';
  return bodyX(BODY.parts.find(p => !p.parent));
}
/** The world: ground, the body, and any task objects (opts.objects, MJCF). opts.grip: the hands can hold the "box". */
function worldXML(opts = {}) {
  return `<mujoco model="glassbox-playground"><compiler angle="radian" inertiafromgeom="true"/>
<option timestep="${H}" integrator="implicitfast" noslip_iterations="3"/>
<worldbody><light pos="0 0 4" dir="0 0 -1"/><geom name="ground" type="plane" size="200 200 0.1" friction="1.0" ${CONTACT.ground}/>
${bodyXML(opts)}${opts.objects || ''}</worldbody>
${opts.grip ? '<equality><connect name="gripL" body1="foreL" body2="box" anchor="0 0 0" active="false"/><connect name="gripR" body1="foreR" body2="box" anchor="0 0 0" active="false"/></equality>' : ''}</mujoco>`;
}
/* Objects. A box anything can bump into (ground, body); a stand it can rest on (fixed, like the ground). */
const BOX = { hx: 0.15, hy: 0.15, hz: 0.125, mass: 3 };   // a 30 x 30 x 25 cm box of 3 kg
const HAND = { r: 0.045, at: s => [0.015, s * 0.015, -0.19] };   // the ball hand, in its forearm's frame (s: +1 left, -1 right)
const boxXML = (x, y, z) => `<body name="box" pos="${f(x)} ${f(y)} ${f(z)}"><freejoint name="box"/><geom name="box" type="box" size="${BOX.hx} ${BOX.hy} ${BOX.hz}" mass="${BOX.mass}" friction="1.2" contype="3" conaffinity="3"/></body>`;
const standXML = (x, y, h) => `<geom name="stand" type="box" pos="${f(x)} ${f(y)} ${f(Math.max(0.005, h) / 2)}" size="0.2 0.2 ${f(Math.max(0.005, h) / 2)}" friction="1.0" ${CONTACT.ground}/>`;

/* ---------- senses (what the body reports, with nerve delays) ----------
     9  inner ear (in the head): which way is down (3), spin (3), acceleration (3), all in the head's own frame
     3  seeing yourself move: the head's velocity (forward, sideways, up), in the direction the body faces
    31  joint position (joint receptors)
    62  muscle stretch sensors (spindles): how fast each muscle is being stretched (+) or shortening (-)
    62  tendon force sensors: how hard each muscle pulls
     6  touch under each heel, ball and toe tip (L heel, ball, toes, R heel, ball, toes)
     2  a 1 Hz rhythm (sin, cos)
     4  task inputs, seen (target forward, sideways, up; extra)
     3  energy left, leg tiredness, arm tiredness (felt)
     3  what it's trying to do (none of them: just stand)
   Nerve delays (brain steps of 17 ms): inner ear 1, sight 6, legs 2, trunk and arms 1, touch 2, inner feelings 3.  */
const INTENTS = ['walk', 'jump', 'grab'];
const SENSE_LIST = [['ear', 9], ['sight', 3], ['joints', NJ], ['spindles', NM], ['tendons', NM], ['touch', 6], ['clock', 2], ['task', 4], ['inner', 3], ['intent', INTENTS.length]];
const SENSE_AT = (() => { let i = 0; const at = {}; for (const [k, n] of SENSE_LIST) { at[k] = i; i += n; } at.total = i; return at; })();
const SENSES = SENSE_AT.total;   // 185
const DELAY = { ear: 1, sight: 6, legs: 2, trunk: 1, arms: 1, touch: 2, clock: 0, task: 6, inner: 3, intent: 0 };
const SENSE_DELAY = (() => {
  const d = new Int8Array(SENSES), jd = j => DELAY[BODY.joints[j].group];
  const fill = (k, f) => { for (let i = 0; i < SENSE_LIST.find(e => e[0] === k)[1]; i++) d[SENSE_AT[k] + i] = f(i); };
  fill('ear', () => DELAY.ear); fill('sight', () => DELAY.sight); fill('joints', jd); fill('spindles', m => jd(m >> 1)); fill('tendons', m => jd(m >> 1));
  fill('touch', () => DELAY.touch); fill('clock', () => DELAY.clock); fill('task', () => DELAY.task); fill('inner', () => DELAY.inner); fill('intent', () => DELAY.intent);
  return d;
})();
const MOTORS = NM + 1;   // 62 muscles + grip
const MOTOR_DELAY = Int8Array.from({ length: MOTORS }, (_, m) => m < NM ? DELAY[BODY.joints[m >> 1].group] : DELAY.arms);
const HIST = 8;
const REFLEX = { gain: 0.8, threshold: 0.02 };   // stretch reflex, switched down while the opposite muscle is driven
const SIZES = [SENSES, 64, MOTORS];
const muscleGroup = g => BODY.joints.flatMap((j, i) => j.group === g ? [2 * i, 2 * i + 1] : []);
const OUTPUT_GROUPS = [muscleGroup('legs'), muscleGroup('trunk'), muscleGroup('arms').concat(NM)];
// energy and fatigue, as in Embodied 2D
const BASAL_W = 70, MAINT = 1.2, WORK_COST = 4, TIRE = 0.08, RECOVER = 0.05;

/* ---------- one body ---------- */
class Body3D {
  /** opts.model: a compiled world to share (one per attempt); otherwise the body gets its own. */
  constructor(mj, opts = {}) {
    this.mj = mj; this.ownModel = !opts.model;
    this.model = opts.model || mj.MjModel.from_xml_string(worldXML(opts)); this.data = new mj.MjData(this.model);
    const id = (t, n) => mj.mj_name2id(this.model, t, n);
    this.ids = {}; for (const p of BODY.parts) this.ids[p.id] = id(mj.mjtObj.mjOBJ_BODY.value, p.id);
    this.joints = BODY.joints.map(j => { const k = id(mj.mjtObj.mjOBJ_JOINT.value, j.id); return { spec: j, q: this.model.jnt_qposadr[k], dq: this.model.jnt_dofadr[k], fatigue: 0 }; });
    this.nbody = this.model.nbody; this.harness = null; this.time = 0;
    // task objects: the box (if the world has one) and the two hands' grips on it
    this.box = id(mj.mjtObj.mjOBJ_BODY.value, 'box');
    this.gripEq = this.box >= 0 ? { L: id(mj.mjtObj.mjOBJ_EQUALITY.value, 'gripL'), R: id(mj.mjtObj.mjOBJ_EQUALITY.value, 'gripR') } : null;
    this.gripCmd = false; this.hold = { L: null, R: null };
    this.mus = makeMuscles3D(); this.exc = new Float64Array(NM); this.mtq = new Float64Array(NM); this.mfat = new Float64Array(NM);
    this.jq = Int32Array.from(this.joints, j => j.q); this.jdq = Int32Array.from(this.joints, j => j.dq);
    this.senseHist = Array.from({ length: HIST }, () => new Float32Array(SENSES)); this.excHist = Array.from({ length: HIST }, () => new Float64Array(NM));
    this.frame = 0; this.histFilled = false; this.prevHeadVel = null; this.limp = false; this.fallen = false;
    this.drive = new Float64Array(NM); this.pending = new Float64Array(3 * this.nbody);
    this.energyMax = opts.energy || 14000; this.energyLeft = this.energyMax; this.used = 0; this.power = 0;
    this.hipsLow = opts.hipsLow || 0.78; this.intent = null;
    this.vel = new Float64Array(3 * this.nbody); this.prev = new Float64Array(3 * this.nbody);
    mj.mj_forward(this.model, this.data);
    this.savePositions();
    // start already standing: muscles settle at a light resting tone before time starts
    for (let k = 0; k < 400; k++) for (let m = 0; m < NM; m++) this.mus[m].step(0.1, this.data.qpos[this.jq[m >> 1]], 1 / 400);
  }
  /** Typed-array views of MuJoCo's state, kept (building them on every read is slow), rebuilt if memory grew. */
  views() {
    const v = this._v; if (v && v.qpos.length) return v;
    const d = this.data, m = this.model;
    return this._v = { qpos: d.qpos, qvel: d.qvel, xpos: d.xpos, xquat: d.xquat, xmat: d.xmat, cvel: d.cvel, xfrc: d.xfrc_applied, qfrc: d.qfrc_applied, mass: m.body_mass, damping: m.dof_damping,
      eqData: this.gripEq ? m.eq_data : null, eqActive: this.gripEq ? d.eq_active : null };
  }
  savePositions() { const p = this.views().xpos; this.prev.set(p.subarray(0, 3 * this.nbody)); }
  /** Hold the pelvis up (on) or let go: springs on its position and tilt, with MuJoCo-applied damping (stable). */
  setHarness(on) { const V = this.views(); this.harness = on ? { x: V.qpos[0], y: V.qpos[1], z: 1.01 } : null; const d = V.damping; for (let k = 0; k < 6; k++) d[k] = on ? (k < 3 ? 3000 : 200) : 0; if (on) this.fallen = false; }
  /** A world point of a part from a point in its own frame. */
  worldPoint(partId, lx, ly, lz) {
    const V = this.views(), b = this.ids[partId], m = V.xmat, p = V.xpos, k = 9 * b;
    return [p[3 * b] + m[k] * lx + m[k + 1] * ly + m[k + 2] * lz, p[3 * b + 1] + m[k + 3] * lx + m[k + 4] * ly + m[k + 5] * lz, p[3 * b + 2] + m[k + 6] * lx + m[k + 7] * ly + m[k + 8] * lz];
  }
  /** Height above the ground of the heel (-1) or ball (+1) of a foot, or the toe tip ('toes', +1). */
  soleHeight(side, part, end) { const pz = part === 'toes' ? [0.0275, 0.02] : [0.0825, 0.03]; return this.worldPoint(part + side, end * pz[0], 0, -pz[1])[2]; }
  soleClear(side) { return Math.min(this.soleHeight(side, 'foot', -1), this.soleHeight(side, 'foot', 1), this.soleHeight(side, 'toes', 1)); }
  /** How far the body leans from upright: the angle between vertical and the line from the pelvis to the head. */
  lean() { const V = this.views(), p = 3 * this.ids.pelvis, h = 3 * this.ids.head, dx = V.xpos[h] - V.xpos[p], dy = V.xpos[h + 1] - V.xpos[p + 1], dz = V.xpos[h + 2] - V.xpos[p + 2]; return Math.atan2(Math.hypot(dx, dy), dz); }
  /** The direction the body faces on the ground (the pelvis's forward axis, flattened): [cos, sin] of its heading. */
  heading() { const m = this.views().xmat, k = 9 * this.ids.pelvis, fx = m[k], fy = m[k + 3], n = Math.hypot(fx, fy) || 1; return [fx / n, fy / n]; }
  tiredness(group) { let s = 0, n = 0; this.joints.forEach(j => { if (group === 'legs' ? j.spec.group === 'legs' : j.spec.group === 'arms') { s += j.fatigue; n++; } }); return s / n; }

  /** What the body reports right now (see SENSES), before any nerve delay. task = { fwd, side, up, a }. */
  senseNow(out, time, task) {
    const V = this.views(), h = this.ids.head, m = V.xmat, k = 9 * h, cv = V.cvel;
    const toHead = (x, y, z) => [m[k] * x + m[k + 3] * y + m[k + 6] * z, m[k + 1] * x + m[k + 4] * y + m[k + 7] * z, m[k + 2] * x + m[k + 5] * y + m[k + 8] * z];   // world -> head frame
    const hv = [this.vel[3 * h], this.vel[3 * h + 1], this.vel[3 * h + 2]];
    const acc = this.prevHeadVel ? hv.map((v, i) => (v - this.prevHeadVel[i]) / DT) : [0, 0, 0];
    this.prevHeadVel = hv;
    let i = 0;
    for (const v of toHead(0, 0, -1)) out[i++] = v;                                          // which way is down
    for (const v of toHead(cv[6 * h], cv[6 * h + 1], cv[6 * h + 2])) out[i++] = v * 0.25;    // spin
    for (const v of toHead(acc[0], acc[1], acc[2] + 9.81)) out[i++] = Math.max(-1, Math.min(1, v * 0.05));   // what the balance organs feel: gravity plus acceleration
    const [c, s] = this.heading();
    out[i++] = (hv[0] * c + hv[1] * s) * 0.3; out[i++] = (-hv[0] * s + hv[1] * c) * 0.3; out[i++] = hv[2] * 0.3;   // seeing yourself move
    for (const j of this.joints) { const r = j.spec.range; out[i++] = ((V.qpos[j.q] - r[0]) / (r[1] - r[0])) * 2 - 1; }
    for (let q = 0; q < NM; q++) out[i++] = this.mus[q].vn;
    for (let q = 0; q < NM; q++) out[i++] = Math.min(1.5, this.mus[q].force / this.mus[q].F0);
    const press = z => Math.max(0, 1 - z / 0.015);
    for (const sd of ['L', 'R']) { out[i++] = press(this.soleHeight(sd, 'foot', -1)); out[i++] = press(this.soleHeight(sd, 'foot', 1)); out[i++] = press(this.soleHeight(sd, 'toes', 1)); }
    out[i++] = Math.sin(time * Math.PI * 2); out[i++] = Math.cos(time * Math.PI * 2);
    out[i++] = task ? task.fwd : 0; out[i++] = task ? task.side : 0; out[i++] = task ? task.up : 0; out[i++] = task ? task.a : 0;
    out[i++] = this.energyLeft / this.energyMax; out[i++] = this.tiredness('legs'); out[i++] = this.tiredness('arms');
    for (const kk of INTENTS) out[i++] = this.intent === kk ? 1 : 0;
    return out;
  }
  /** What the brain gets: each sense as it was SENSE_DELAY brain steps ago. */
  sense(out, time, task) {
    const now = this.senseHist[this.frame % HIST];
    this.senseNow(now, time, task);
    if (!this.histFilled) { for (const hh of this.senseHist) hh.set(now); this.histFilled = true; }
    for (let i = 0; i < SENSES; i++) out[i] = this.senseHist[(this.frame - SENSE_DELAY[i] + HIST) % HIST][i];
    return out;
  }
  /** actions[0..61]: muscle excitations (negative = off). override: { jointId: angle } steered by that joint's two muscles. */
  act(actions, override, servo = SERVO) {
    this.limp = false; this.gripCmd = !!(actions && actions.length > NM && actions[NM] > 0);   // the last output closes the hands
    for (let m = 0; m < NM; m++) this.exc[m] = clamp01(actions ? actions[m] : 0);
    if (override) { const V = this.views(); this.joints.forEach((j, i) => {
      const t = override[j.spec.id]; if (t === undefined) return;
      const u = servo.kp * (t - V.qpos[j.q]) - servo.kd * V.qvel[j.dq];
      this.exc[2 * i] = clamp01(Math.max(0, -u) + servo.co); this.exc[2 * i + 1] = clamp01(Math.max(0, u) + servo.co);
    }); }
  }
  /** Brain off: every muscle relaxes and the reflexes are off too (limp, like someone unconscious). */
  relax() { this.exc.fill(0); this.limp = true; this.gripCmd = false; }
  /** A hand's centre in the world (side 'L' or 'R'). */
  handPos(side) { const a = HAND.at(side === 'L' ? 1 : -1); return this.worldPoint('fore' + side, a[0], a[1], a[2]); }
  /** How far a world point is from the box's surface (negative = inside), and the point in the box's own frame. */
  boxDist(p) {
    const V = this.views(), b = this.box, m = V.xmat, k = 9 * b, d = [p[0] - V.xpos[3 * b], p[1] - V.xpos[3 * b + 1], p[2] - V.xpos[3 * b + 2]];
    const l = [m[k] * d[0] + m[k + 3] * d[1] + m[k + 6] * d[2], m[k + 1] * d[0] + m[k + 4] * d[1] + m[k + 7] * d[2], m[k + 2] * d[0] + m[k + 5] * d[1] + m[k + 8] * d[2]];
    const h = [BOX.hx, BOX.hy, BOX.hz], q = l.map((v, i) => Math.max(Math.abs(v) - h[i], 0));
    const out = Math.hypot(...q), inside = Math.min(...l.map((v, i) => h[i] - Math.abs(v)));
    return { dist: out > 0 ? out : -inside, local: l };
  }
  /** Which hands hold the box (0, 1 or 2). */
  holding() { return (this.hold.L ? 1 : 0) + (this.hold.R ? 1 : 0); }
  /** Close or open the hands: a closing hand that touches the box holds it where it touches (no yank); opening lets go. */
  updateGrip() {
    if (!this.gripEq) return;
    for (const sd of ['L', 'R']) {
      if (!this.gripCmd) { this.hold[sd] = null; continue; }
      if (this.hold[sd]) continue;
      const hp = this.handPos(sd), bd = this.boxDist(hp);
      if (bd.dist <= HAND.r + 0.015) this.hold[sd] = HAND.at(sd === 'L' ? 1 : -1).concat(bd.local);
    }
  }
  /** Writes this body's grips into the (shared) model before each physics sub-step. */
  applyGrip() {
    const V = this.views(), ed = V.eqData, ea = V.eqActive, n = ed.length / this.model.neq;
    for (const sd of ['L', 'R']) {
      const e = this.gripEq[sd], h = this.hold[sd];
      if (h) for (let k = 0; k < 6; k++) ed[e * n + k] = h[k];
      ea[e] = h ? 1 : 0;
    }
  }
  /** Where the box is and how it's turned (or null). */
  boxPose() { if (this.box < 0) return null; const V = this.views(), b = this.box; return { pos: [V.xpos[3 * b], V.xpos[3 * b + 1], V.xpos[3 * b + 2]], quat: [V.xquat[4 * b], V.xquat[4 * b + 1], V.xquat[4 * b + 2], V.xquat[4 * b + 3]] }; }
  /** A shove (impulse, N·s, world x/y/z) to a part, spread over the next brain step. */
  shove(partId, ix, iy, iz = 0) { const b = this.ids[partId], P = this.pending; P[3 * b] += ix / DT; P[3 * b + 1] += iy / DT; P[3 * b + 2] += iz / DT; }
  /** A steady pull (N, world x/y/z) on a part for the next brain step (Test mode: dragging with the mouse). */
  pull(partId, fx, fy, fz) { const b = this.ids[partId], P = this.pending; P[3 * b] += fx; P[3 * b + 1] += fy; P[3 * b + 2] += fz; }
  /** A part's speed (m/s, world) over the last brain step. */
  partVel(partId) { const b = this.ids[partId]; return [this.vel[3 * b], this.vel[3 * b + 1], this.vel[3 * b + 2]]; }
  /** A joint's angle now. */
  angle(jointId) { const j = this.joints.find(k => k.spec.id === jointId); return this.views().qpos[j.q]; }
  /** One brain step of physics: SUB sub-steps with the muscles' joint torques (after the motor nerve delay, plus the
      stretch reflex), shoves and the harness. */
  step() {
    const V = this.views(), pel = this.ids.pelvis, xf = V.xfrc, qpos = V.qpos, qf = V.qfrc, P = this.pending, nb = this.nbody;
    const low = Math.max(0.1, Math.min(1, this.energyLeft / (0.15 * this.energyMax)));   // running on empty: crippling
    this.excHist[this.frame % HIST].set(this.exc);
    const drive = this.drive;
    for (let q = 0; q < NM; q++) drive[q] = this.excHist[(this.frame - MOTOR_DELAY[q] + HIST) % HIST][q];
    if (!this.limp) for (let q = 0; q < NM; q++) drive[q] = clamp01(drive[q] + REFLEX.gain * Math.max(0, this.mus[q].vn - REFLEX.threshold) * (1 - drive[q ^ 1]));
    this.frame++;
    this.updateGrip();
    for (let n = 0; n < SUB; n++) {
      for (let i = 0; i < NJ; i++) {
        const q = qpos[this.jq[i]];
        const t0 = this.mus[2 * i].step(drive[2 * i] * (1 - 0.6 * this.mfat[2 * i]) * low, q, H), t1 = this.mus[2 * i + 1].step(drive[2 * i + 1] * (1 - 0.6 * this.mfat[2 * i + 1]) * low, q, H);
        this.mtq[2 * i] = t0; this.mtq[2 * i + 1] = t1; qf[this.jdq[i]] = t0 + t1;
      }
      for (let b = 1; b < nb; b++) { xf[6 * b] = P[3 * b]; xf[6 * b + 1] = P[3 * b + 1]; xf[6 * b + 2] = P[3 * b + 2]; xf[6 * b + 3] = 0; xf[6 * b + 4] = 0; xf[6 * b + 5] = 0; }
      if (this.assist > 0) {   // helping hands: hold the chest up and upright, like a parent holding a baby under the arms
        const a = this.assist, ch = this.ids.chest, xm = V.xmat, km = 9 * ch, cz = V.xpos[3 * ch + 2], vz = this.cvz || 0;
        xf[6 * ch + 2] += a * Math.max(0, Math.min(62 * 9.81, 4000 * (1.38 - cz) - 300 * vz));   // carries up to the whole weight
        // turn the chest back upright: torque along (its up axis × world up), proportional to how far it's tipped
        const ux = xm[km + 2], uy = xm[km + 5];   // chest's up axis in world (x, y components; z ~ 1 when upright)
        xf[6 * ch + 3] += a * 1500 * (uy); xf[6 * ch + 4] += a * 1500 * (-ux);
        const w = qpos[3] >= 0 ? 1 : -1;   // and the hips upright too, more gently
        xf[6 * pel + 3] += a * -600 * w * qpos[4]; xf[6 * pel + 4] += a * -600 * w * qpos[5];
      }
      if (this.harness) {
        const hh = this.harness, w = qpos[3] >= 0 ? 1 : -1;
        xf[6 * pel] += 40000 * (hh.x - qpos[0]); xf[6 * pel + 1] += 40000 * (hh.y - qpos[1]); xf[6 * pel + 2] += 40000 * (hh.z - qpos[2]);
        xf[6 * pel + 3] += -8000 * w * qpos[4]; xf[6 * pel + 4] += -8000 * w * qpos[5]; xf[6 * pel + 5] += -8000 * w * qpos[6];
      }
      if (this.gripEq) this.applyGrip();
      this.mj.mj_step(this.model, this.data);
    }
    P.fill(0);
    const p = V.xpos; for (let k = 0; k < 3 * nb; k++) this.vel[k] = (p[k] - this.prev[k]) / DT;
    this.cvz = this.vel[3 * this.ids.chest + 2];
    this.savePositions();
    this.time += DT;
  }
  /** Energy and fatigue, once per brain step (as in Embodied 2D). */
  muscles() {
    const V = this.views(); let w = BASAL_W;
    for (let q = 0; q < NM; q++) {
      const mu = this.mus[q], a = mu.a, om = V.qvel[this.jdq[q >> 1]];
      w += a * mu.F0 * mu.l0 * MAINT + Math.max(0, this.mtq[q] * om) * WORK_COST;
      this.mfat[q] = Math.max(0, Math.min(1, this.mfat[q] + DT * (TIRE * a * a * a - RECOVER * this.mfat[q])));
    }
    this.joints.forEach((j, i) => { j.fatigue = (this.mfat[2 * i] + this.mfat[2 * i + 1]) / 2; });
    this.energyLeft = Math.max(0, this.energyLeft - w * DT); this.used += w * DT; this.power += (w - this.power) * 0.05;
  }
  /** Fallen = head low, pelvis low (sitting, the splits), or leaning over too far. */
  checkFallen() {
    if (!this.fallen && (this.pose('head').pos[2] < 1.15 || this.pose('pelvis').pos[2] < this.hipsLow || this.lean() > 1.3)) this.fallen = true;
    return this.fallen;
  }
  /** Where a part is and how it's turned (MuJoCo quaternion w, x, y, z). */
  pose(partId) { const V = this.views(), b = this.ids[partId]; return { pos: [V.xpos[3 * b], V.xpos[3 * b + 1], V.xpos[3 * b + 2]], quat: [V.xquat[4 * b], V.xquat[4 * b + 1], V.xquat[4 * b + 2], V.xquat[4 * b + 3]] }; }
  totalMass() { const V = this.views(); let m = 0; for (let b = 1; b < this.nbody; b++) m += V.mass[b]; return m; }
  /** The old step without senses or brain (the limp/harness viewer uses it): muscles + physics. */
  free() { this.data.delete(); if (this.ownModel) this.model.delete(); }
}

/* ---------- tasks ---------- */
const energyBonus = b => 3 * b.energyLeft / b.energyMax;
const TASKS = {
  stand: {
    name: 'Stand', seconds: 8, energy: 14000,
    setup() { return { alive: 0, drift: 0, wide: 0 }; },
    senseTask() { return null; },
    step(st, body, trial) {
      st.alive += DT;
      const l = body.pose('footL').pos, r = body.pose('footR').pos, p = body.pose('pelvis').pos;
      st.wide += Math.max(0, Math.hypot(l[0] - r[0], l[1] - r[1]) - 0.45) * DT;   // a stance wider than 45 cm costs
      st.drift = Math.max(st.drift, Math.hypot(p[0], p[1]));
      // a shove to the chest every 2 seconds, from a different direction each time, stronger with the difficulty
      if (trial.steps % 120 === 60) { const a = trial.rng() * Math.PI * 2, J = 28 * trial.hard; body.shove('chest', Math.cos(a) * J, Math.sin(a) * J); }
    },
    score(st, b) { return st.alive - Math.min(st.drift, 2) * 0.5 - st.wide * 2 - (b.fallen ? 2 : 0) + energyBonus(b); },
    describe(st, b) { return b.fallen ? `fell after ${st.alive.toFixed(1)} s` : `standing · drifted ${(st.drift * 100).toFixed(0)} cm`; },
    success(st, b) { return !b.fallen; },
  },
  /* Pick up the box and carry it to a spot 2.5 m ahead. It starts on a stand at about waist height; the stand gets
     lower with the difficulty until the box sits on the floor (bend down and lift it). It sees where the box is (and,
     once it holds it, where to take it). Grip: the brain's last output closes both hands; a hand touching the box holds it. */
  carry: {
    name: 'Pick up and carry', seconds: 12, energy: 16000, carryTo: 2.5,
    layout(trial) { const h = 0.72 * (1 - trial.hard); return { x: 0.5, y: 0, h: h < 0.03 ? 0 : h }; },
    world(trial) { const L = this.layout(trial); return { objects: (L.h ? standXML(L.x, L.y, L.h) : '') + boxXML(L.x, L.y, L.h + BOX.hz + 0.002), grip: true }; },
    setup(body, trial) {
      const L = this.layout(trial), p = body.boxPose().pos;
      return { x0: p[0], z0: p[2], tx: L.x + this.carryTo, ty: L.y, near: 9, lift: 0, held: 0, carried: 0, alive: 0, dropped: false };
    },
    // seen: the box (forward, sideways, up from the hips, in the direction the body faces); holding it: the spot to take it to
    senseTask(st, b) {
      const p = b.pose('pelvis').pos, [c, s] = b.heading(), box = b.boxPose().pos, hold = b.holding();
      const t = hold ? [st.tx, st.ty, 0.9] : box, dx = t[0] - p[0], dy = t[1] - p[1];
      return { fwd: Math.max(-3, Math.min(3, dx * c + dy * s)), side: Math.max(-3, Math.min(3, -dx * s + dy * c)), up: t[2] - p[2], a: hold / 2 };
    },
    step(st, b) {
      st.alive += DT;
      const box = b.boxPose().pos, hold = b.holding();
      st.near = Math.min(st.near, Math.min(b.boxDist(b.handPos('L')).dist, b.boxDist(b.handPos('R')).dist) - HAND.r);
      if (hold) { st.held += DT; st.lift = Math.max(st.lift, box[2] - st.z0); st.carried = Math.max(st.carried, Math.min(this.carryTo, box[0] - st.x0)); }
      if (st.held > 0.5 && !hold && box[2] < st.z0 - 0.05) st.dropped = true;
    },
    progress(st) { return { reach: Math.exp(-10 * Math.max(0, st.near) ** 2), lift: Math.min(1, st.lift / 0.3), carry: st.carried / this.carryTo }; },
    score(st, b) {
      const g = this.progress(st);
      return 0.1 * st.alive + g.reach + Math.min(1, st.held) + 2 * g.lift + 4 * g.carry + (this.success(st, b) ? 2 : 0) - (b.fallen ? 2 : 0) - (st.dropped ? 1 : 0) + energyBonus(b);
    },
    describe(st, b) {
      if (b.fallen) return `fell after ${st.alive.toFixed(1)} s`;
      if (!st.held) return `reaching for the box · ${Math.max(0, st.near * 100).toFixed(0)} cm away`;
      return `${b.holding() ? `holding the box with ${b.holding() === 2 ? 'both hands' : 'one hand'}` : st.dropped ? 'dropped the box' : 'let go of the box'} · lifted ${(st.lift * 100).toFixed(0)} cm · carried ${(st.carried).toFixed(1)} of ${this.carryTo} m`;
    },
    success(st, b) { return !b.fallen && b.holding() > 0 && st.carried >= this.carryTo - 0.3 && b.boxPose().pos[2] > 0.4; },
  },
};

/* ---------- an attempt: brains practising a task, each body in its own copy of one world ---------- */
class Trial3D {
  constructor(mj, taskId, brains, opts = {}) {
    this.mj = mj; this.taskId = taskId; this.task = TASKS[taskId];
    this.time = 0; this.steps = 0; this.maxSteps = Math.round(this.task.seconds / DT);
    this.hard = opts.hard === undefined ? 1 : opts.hard; this.noise = opts.noise === undefined ? 0.02 * this.hard : opts.noise;
    this.assist = opts.assist || 0;   // helping hands (see assistFor)
    this.keepSimulating = !!opts.keepSimulating; this.brainOff = false;
    this.override = opts.override || null;   // Test mode: { jointId: angle } joints you're moving with a slider
    this.rng = Brain.makeRng(opts.seed || 1); this.input = new Float32Array(SENSES);
    const push = (this.rng() * 2 - 1) * 0.3 * (opts.push === undefined ? this.hard : opts.push), pushDir = this.rng() * Math.PI * 2;
    this.energy = opts.energy || this.task.energy * (1 + 4 * (1 - this.hard));
    this.model = mj.MjModel.from_xml_string(worldXML(this.task.world ? this.task.world(this) : {}));
    this.agents = brains.map(params => {
      const body = new Body3D(mj, { model: this.model, energy: this.energy }); body.assist = this.assist;
      body.intent = taskId === 'stand' ? null : taskId;
      const V = body.views(); V.qvel[0] += Math.cos(pushDir) * push; V.qvel[1] += Math.sin(pushDir) * push;   // a small random push at the start
      return { body, st: this.task.setup(body, this), net: new Brain.Network(SIZES, params), done: false };
    });
  }
  get finished() { return this.steps >= this.maxSteps || this.agents.every(a => a.done); }
  step() {
    const inp = this.input, rng = this.rng;
    for (const a of this.agents) {
      if (a.done) { if (this.keepSimulating) { a.body.relax(); a.body.step(); } continue; }
      a.body.sense(inp, this.time, this.task.senseTask(a.st, a.body));
      if (this.noise) for (let i = 0; i < inp.length; i++) inp[i] += (rng() - 0.5) * 2 * this.noise;
      const out = a.net.forward(inp);
      if (this.brainOff) { a.body.relax(); if (this.override && Object.keys(this.override).length) a.body.act(new Float64Array(MOTORS), this.override); }
      else a.body.act(out, this.override);
      this.task.step(a.st, a.body, this);
      a.body.step(); a.body.muscles();
      if (a.body.checkFallen()) { a.done = true; a.fitness = this.task.score(a.st, a.body); a.success = false; }
    }
    this.time += DT; this.steps++;
  }
  run() { while (!this.finished) this.step(); return this.agents.map(a => a.fitness !== undefined ? a.fitness : this.task.score(a.st, a.body)); }
  successes() { return this.agents.map(a => a.success !== undefined ? a.success : !!this.task.success(a.st, a.body)); }
  free() { for (const a of this.agents) a.body.free(); this.agents = []; if (this.model) { this.model.delete(); this.model = null; } }
}

/* ---------- learning: the same rules as Embodied 2D ---------- */
/** A new brain: random, but every muscle starts with a light resting tone (like a newborn's). */
function freshBrain(rng) {
  const net = Brain.Network.random(SIZES, rng), hid = SIZES[1], start = hid * (SIZES[0] + 1);
  for (let o = 0; o < NM; o++) { const row = start + o * (hid + 1); for (let q = 0; q < hid; q++) net.params[row + q] *= 0.3; net.params[row + hid] = Math.atanh(0.1); }
  return net.params;
}
/* Difficulty by stage (it rises only while the agent copes). Learning to stand in 3D from nothing stalls (the first
   agent learned to fall in 2.9 s and stayed there), so at first "helping hands" hold the chest up and upright, like an
   adult holding a baby under the arms; the help fades out by stage 80. Because the stage only rises while the agent copes, the help
   settles at what it needs and fades as it learns. Shoves, noise and energy scarcity grow from stage 0 to 150.       */
const hardness = stage => Math.min(1, stage / 150);
const assistFor = stage => Math.max(0, 1 - stage / 80);
function nextStage(stage, rate) { return rate >= 2 / 3 ? stage + 1 : rate <= 0 ? Math.max(0, stage - 0.5) : stage; }
function episodeConfigs(taskId, stage, generation) {
  const hard = hardness(stage), out = [];
  for (let e = 0; e < 2; e++) out.push({ seed: Math.round(generation) * 7919 + e * 104729 + 1, hard, push: hard, noise: 0.02 * hard, assist: assistFor(stage) });
  return out;
}
/** Scores per attempt -> one per brain: mean rank, minus a little for inconsistency (as in 2D). */
function combineRanks(perEpisode) {
  const n = perEpisode[0].length, ranked = perEpisode.map(sc => { const order = sc.map((s, i) => i).sort((a, b) => sc[a] - sc[b]), r = new Float64Array(n); order.forEach((i, k) => { r[i] = n > 1 ? k / (n - 1) : 1; }); return r; });
  return Array.from({ length: n }, (_, i) => { const v = ranked.map(r => r[i]), m = v.reduce((s, x) => s + x, 0) / v.length; return m - 0.25 * (Math.max(...v) - Math.min(...v)); });
}

const api = { DT, SUB, BODY, BOX, HAND, MUSCLES3D, NJ, NM, SERVO, SENSES, SENSE_AT, SENSE_LIST, SENSE_DELAY, MOTORS, MOTOR_DELAY, REFLEX, SIZES, OUTPUT_GROUPS, INTENTS,
  TASKS, worldXML, Body3D, Trial3D, freshBrain, hardness, assistFor, nextStage, episodeConfigs, combineRanks };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.Body3D = api;
}
__body3dModule(typeof globalThis !== 'undefined' ? globalThis : this);
