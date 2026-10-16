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
function worldXML(opts = {}) {
  return `<mujoco model="glassbox-playground"><compiler angle="radian" inertiafromgeom="true"/>
<option timestep="${H}" integrator="implicitfast" noslip_iterations="3"/>
<worldbody><light pos="0 0 4" dir="0 0 -1"/><geom name="ground" type="plane" size="200 200 0.1" friction="1.0" ${CONTACT.ground}/>
${bodyXML(opts)}</worldbody></mujoco>`;
}

/* ---------- one body in its own world ---------- */
class Body3D {
  constructor(mj, opts = {}) {
    this.mj = mj; this.model = mj.MjModel.from_xml_string(worldXML(opts)); this.data = new mj.MjData(this.model);
    const id = (t, n) => mj.mj_name2id(this.model, t, n);
    this.ids = {}; for (const p of BODY.parts) this.ids[p.id] = id(mj.mjtObj.mjOBJ_BODY.value, p.id);
    this.joints = BODY.joints.map(j => { const k = id(mj.mjtObj.mjOBJ_JOINT.value, j.id); return Object.assign({ spec: j }, { q: this.model.jnt_qposadr[k], dq: this.model.jnt_dofadr[k] }); });
    this.nbody = this.model.nbody; this.harness = null; this.time = 0;
    this.mus = makeMuscles3D(); this.exc = new Float64Array(NM); this.mtq = new Float64Array(NM);
    this.jq = Int32Array.from(this.joints, j => j.q); this.jdq = Int32Array.from(this.joints, j => j.dq);
    mj.mj_forward(this.model, this.data);
    // start already standing: muscles settle at a light resting tone before time starts
    for (let k = 0; k < 400; k++) for (let m = 0; m < NM; m++) this.mus[m].step(0.1, this.data.qpos[this.jq[m >> 1]], 1 / 400);
  }
  /** Typed-array views of MuJoCo's state, kept (building them on every read is slow), rebuilt if memory grew. */
  views() {
    const v = this._v; if (v && v.qpos.length) return v;
    const d = this.data, m = this.model;
    return this._v = { qpos: d.qpos, qvel: d.qvel, xpos: d.xpos, xquat: d.xquat, xfrc: d.xfrc_applied, qfrc: d.qfrc_applied, mass: m.body_mass, damping: m.dof_damping };
  }
  /** Hold the pelvis up (on) or let go: springs on its position and tilt, with MuJoCo-applied damping (stable). */
  setHarness(on) { const V = this.views(); this.harness = on ? { x: V.qpos[0], y: V.qpos[1], z: 1.01 } : null; const d = V.damping; for (let k = 0; k < 6; k++) d[k] = on ? (k < 3 ? 3000 : 200) : 0; }
  /** actions[0..61]: muscle excitations (negative = off). override: { jointId: angle } steered by that joint's two muscles. */
  act(actions, override, servo = SERVO) {
    for (let m = 0; m < NM; m++) this.exc[m] = clamp01(actions ? actions[m] : 0);
    if (override) { const V = this.views(); this.joints.forEach((j, i) => {
      const t = override[j.spec.id]; if (t === undefined) return;
      const u = servo.kp * (t - V.qpos[j.q]) - servo.kd * V.qvel[j.dq];
      this.exc[2 * i] = clamp01(Math.max(0, -u) + servo.co); this.exc[2 * i + 1] = clamp01(Math.max(0, u) + servo.co);
    }); }
  }
  /** Every muscle switched off: the body goes limp. */
  relax() { this.exc.fill(0); }
  /** One brain step of physics: SUB sub-steps, each with the muscles' joint torques, and the harness if it's on. */
  step() {
    const V = this.views(), pel = this.ids.pelvis, xf = V.xfrc, qpos = V.qpos, qf = V.qfrc;
    for (let n = 0; n < SUB; n++) {
      for (let i = 0; i < NJ; i++) {
        const q = qpos[this.jq[i]], t = this.mus[2 * i].step(this.exc[2 * i], q, H) + this.mus[2 * i + 1].step(this.exc[2 * i + 1], q, H);
        this.mtq[2 * i] = t; qf[this.jdq[i]] = t;
      }
      for (let k = 0; k < 6; k++) xf[6 * pel + k] = 0;
      if (this.harness) {
        const h = this.harness, q = V.qpos;   // free joint: position (3) then orientation quaternion (w, x, y, z)
        xf[6 * pel] = 40000 * (h.x - q[0]); xf[6 * pel + 1] = 40000 * (h.y - q[1]); xf[6 * pel + 2] = 40000 * (h.z - q[2]);
        // keep upright: torque toward the identity orientation (small-angle: 2 × the quaternion's vector part)
        const w = q[3] >= 0 ? 1 : -1;
        xf[6 * pel + 3] = -4000 * 2 * w * q[4]; xf[6 * pel + 4] = -4000 * 2 * w * q[5]; xf[6 * pel + 5] = -4000 * 2 * w * q[6];
      }
      this.mj.mj_step(this.model, this.data);
    }
    this.time += DT;
  }
  /** Where a part is and how it's turned (MuJoCo quaternion w, x, y, z). */
  pose(partId) { const V = this.views(), b = this.ids[partId]; return { pos: [V.xpos[3 * b], V.xpos[3 * b + 1], V.xpos[3 * b + 2]], quat: [V.xquat[4 * b], V.xquat[4 * b + 1], V.xquat[4 * b + 2], V.xquat[4 * b + 3]] }; }
  totalMass() { const V = this.views(); let m = 0; for (let b = 1; b < this.nbody; b++) m += V.mass[b]; return m; }
  free() { this.data.delete(); this.model.delete(); }
}

const api = { DT, SUB, BODY, MUSCLES3D, NJ, NM, SERVO, worldXML, Body3D };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.Body3D = api;
}
__body3dModule(typeof globalThis !== 'undefined' ? globalThis : this);
