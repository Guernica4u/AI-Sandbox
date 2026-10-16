/*
================================================================================
 GLASS BOX · PLAYGROUND  -  mocap.js
================================================================================
 Human movement recordings (motion capture), turned into our mannequin's poses.

 The recordings come from the CMU Graphics Lab Motion Capture Database
 (mocap.cs.cmu.edu; "may be copied, modified, or redistributed without
 permission"). Each one is a skeleton (.asf: bone lengths and directions) and
 its joint angles over time (.amc, 120 frames a second).

 People and our mannequin are built differently (other bones, other joint
 axes), so the recording is fitted onto our body frame by frame, like posing a
 doll to match a photo: our joints are turned until each of our bones points
 the same way as the person's (thighs, shins, feet, spine, neck, arms), and the
 hips are placed where theirs were (scaled to our leg length). Joint limits are
 respected. The result is a "clip": our body's pose (pelvis position and turn
 plus all 31 joint angles) 30 times a second, which the agent learns to copy
 with its own muscles. Nothing here moves the agent: it's only an example.
================================================================================
*/
function __mocapModule(root) {
'use strict';
const B3 = root.Body3D || (typeof require === 'function' ? require('./body3d.js') : null);
const TO_M = (1 / 0.45) * 2.54 / 100;   // CMU units to metres (their FAQ)

/* ---------- reading the files ---------- */
function parseASF(text) {
  const bones = { root: { name: 'root', dir: [0, 0, 0], len: 0, axis: [0, 0, 0], dof: ['tx', 'ty', 'tz', 'rx', 'ry', 'rz'], kids: [] } };
  const lines = text.split(/\r?\n/).map(l => l.trim());
  let i = 0, section = '';
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith(':')) { section = l.split(/\s+/)[0]; if (section === ':root') continue; }
    if (section === ':root') {
      const w = l.split(/\s+/);
      if (w[0] === 'order') bones.root.dof = w.slice(1).map(s => s.toLowerCase());
      if (w[0] === 'orientation') bones.root.axis = w.slice(1, 4).map(Number);
    }
    if (section === ':bonedata' && l === 'begin') {
      const b = { dof: [], kids: [] };
      for (i++; lines[i] !== 'end'; i++) {
        const w = lines[i].split(/\s+/);
        if (w[0] === 'name') b.name = w[1];
        else if (w[0] === 'direction') b.dir = w.slice(1, 4).map(Number);
        else if (w[0] === 'length') b.len = +w[1];
        else if (w[0] === 'axis') b.axis = w.slice(1, 4).map(Number);
        else if (w[0] === 'dof') b.dof = w.slice(1);
      }
      bones[b.name] = b;
    }
    if (section === ':hierarchy' && l !== 'begin' && l !== 'end' && l && !l.startsWith(':')) {
      const w = l.split(/\s+/); for (const k of w.slice(1)) { bones[w[0]].kids.push(k); bones[k].parent = w[0]; }
    }
  }
  return bones;
}
function parseAMC(text) {
  const frames = []; let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith('#') || l.startsWith(':')) continue;
    if (/^\d+$/.test(l)) { cur = {}; frames.push(cur); continue; }
    const w = l.split(/\s+/); if (cur) cur[w[0]] = w.slice(1).map(Number);
  }
  return frames;
}

/* ---------- 3x3 rotations (row-major arrays) ---------- */
const rx = a => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const ry = a => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
const rz = a => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
const mul = (A, B) => { const C = new Array(9); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[3 * r + c] = A[3 * r] * B[c] + A[3 * r + 1] * B[3 + c] + A[3 * r + 2] * B[6 + c]; return C; };
const tr = A => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
const app = (A, v) => [A[0] * v[0] + A[1] * v[1] + A[2] * v[2], A[3] * v[0] + A[4] * v[1] + A[5] * v[2], A[6] * v[0] + A[7] * v[1] + A[8] * v[2]];
const deg = d => d * Math.PI / 180;
const euler = (x, y, z) => mul(rz(deg(z)), mul(ry(deg(y)), rx(deg(x))));   // ASF's XYZ: x first, then y, then z

/** Where every bone ends in one frame (metres), turned so z is up (CMU's y is up): { boneName: [x, y, z] } */
function framePoints(bones, frame) {
  const out = {}, mats = {};
  const toMj = p => [p[2] * TO_M, p[0] * TO_M, p[1] * TO_M];   // (x, y, z) → (z, x, y): a rotation, so nothing is mirrored
  const walk = (name, parentMat, parentPos) => {
    const b = bones[name], v = frame[name] || [], val = {};
    b.dof.forEach((d, k) => { val[d] = v[k] || 0; });
    const C = euler(...b.axis), M = mul(parentMat, mul(C, mul(euler(val.rx || 0, val.ry || 0, val.rz || 0), tr(C))));
    const pos = name === 'root' ? [val.tx || 0, val.ty || 0, val.tz || 0] : (() => { const d = app(M, b.dir); return [parentPos[0] + d[0] * b.len, parentPos[1] + d[1] * b.len, parentPos[2] + d[2] * b.len]; })();
    mats[name] = M; out[name] = toMj(pos);
    for (const k of b.kids) walk(k, M, pos);
  };
  walk('root', [1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0]);
  return out;
}

/* ---------- fitting onto our body ---------- */
// Bones compared by direction: [their start bone end, their end bone end] ↔ [our start, our end] (see ourPoints).
const MATCH = [
  ['lhipjoint', 'lfemur', 'hipL', 'kneeL', 3], ['lfemur', 'ltibia', 'kneeL', 'ankleL', 3], ['ltibia', 'lfoot', 'ankleL', 'ballL', 2], ['lfoot', 'ltoes', 'ballL', 'toeTipL', 0.5],
  ['rhipjoint', 'rfemur', 'hipR', 'kneeR', 3], ['rfemur', 'rtibia', 'kneeR', 'ankleR', 3], ['rtibia', 'rfoot', 'ankleR', 'ballR', 2], ['rfoot', 'rtoes', 'ballR', 'toeTipR', 0.5],
  ['rhipjoint', 'lhipjoint', 'hipR', 'hipL', 3],                                   // which way the hips face
  ['root', 'upperback', 'lumbar', 'thoracic', 2], ['upperback', 'thorax', 'thoracic', 'neck', 2],   // the spine
  ['rclavicle', 'lclavicle', 'shoulderR', 'shoulderL', 2],                          // which way the shoulders face
  ['upperneck', 'head', 'neck', 'headTop', 1],
  ['lclavicle', 'lhumerus', 'shoulderL', 'elbowL', 1.5], ['lhumerus', 'lradius', 'elbowL', 'wristL', 1],
  ['rclavicle', 'rhumerus', 'shoulderR', 'elbowR', 1.5], ['rhumerus', 'rradius', 'elbowR', 'wristR', 1],
];
/** Our body's matching points, from MuJoCo's kinematics (joint anchors and a few part ends). */
function ourPoints(body) {
  const V = body.views(), d = body.data, xa = d.xanchor, m = body.model, pts = {};
  const anchor = id => { const k = body.mj.mj_name2id(m, body.mj.mjtObj.mjOBJ_JOINT.value, id); return [xa[3 * k], xa[3 * k + 1], xa[3 * k + 2]]; };
  for (const s of ['L', 'R']) {
    pts['hip' + s] = anchor('hip' + s + 'Flex'); pts['knee' + s] = anchor('knee' + s); pts['ankle' + s] = anchor('ankle' + s + 'Flex');
    pts['ball' + s] = anchor('toe' + s); pts['toeTip' + s] = body.worldPoint('toes' + s, 0.0275, 0, 0);
    pts['shoulder' + s] = anchor('shoulder' + s + 'Flex'); pts['elbow' + s] = anchor('elbow' + s);
    pts['wrist' + s] = body.worldPoint('fore' + s, 0, 0, -0.12);
  }
  pts.lumbar = anchor('lumbarFlex'); pts.thoracic = anchor('thoracicFlex'); pts.neck = anchor('neckFlex'); pts.headTop = body.worldPoint('head', 0, 0, 0.12);
  return pts;
}
const unit = (a, b) => { const v = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], n = Math.hypot(...v) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
const quatFromYawPitchRoll = (yaw, pitch, roll) => {   // z, then y, then x (intrinsic)
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2), cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
  return [cy * cp * cr + sy * sp * sr, cy * cp * sr - sy * sp * cr, cy * sp * cr + sy * cp * sr, sy * cp * cr - cy * sp * sr];
};

/**
 Fits a recording onto our body. bones: parseASF(); frames: parseAMC(); opts: { fps (out, 30), from, to (seconds) }.
 Returns { name, fps, joints (ids), frames: [[x, y, z, yaw, pitch, roll, ...31 joint angles]], qpos: [[MuJoCo qpos]] }.
*/
function retarget(mj, bones, frames, opts = {}) {
  const fps = opts.fps || 30, step = Math.round(120 / fps);
  const first = Math.round((opts.from || 0) * 120), last = Math.min(frames.length, opts.to ? Math.round(opts.to * 120) : frames.length);
  const body = new B3.Body3D(mj), V = body.views(), J = body.joints, NJ = J.length;
  // scale: their leg length vs ours (hip to ankle)
  const p0 = framePoints(bones, frames[first]);
  const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const them = len(p0.lhipjoint, p0.lfemur) + len(p0.lfemur, p0.ltibia);
  const usP = ourPoints(body), us = len(usP.hipL, usP.kneeL) + len(usP.kneeL, usP.ankleL), scale = us / them;
  const x = new Float64Array(6 + NJ);   // pelvis x y z, yaw pitch roll, joints
  const lo = Float64Array.from({ length: 6 + NJ }, (_, i) => i < 6 ? -Infinity : J[i - 6].spec.range[0]);
  const hi = Float64Array.from({ length: 6 + NJ }, (_, i) => i < 6 ? Infinity : J[i - 6].spec.range[1]);
  const pose = v => {
    V.qpos[0] = v[0]; V.qpos[1] = v[1]; V.qpos[2] = v[2];
    const q = quatFromYawPitchRoll(v[3], v[4], v[5]); for (let k = 0; k < 4; k++) V.qpos[3 + k] = q[k];
    for (let i = 0; i < NJ; i++) V.qpos[J[i].q] = v[6 + i];
    mj.mj_kinematics(body.model, body.data);
  };
  // their markers put the ankle lower on the foot than our joint, so their foot "bone" points flatter than ours: measure
  // that difference standing (all their angles zero, our body as built) and tilt their foot directions by it
  const pitch = d => Math.asin(Math.max(-1, Math.min(1, d[2])));
  const rest = framePoints(bones, {}), tilt = {};
  for (const [a, b, ua, ub] of MATCH) if (/foot|toes/.test(b) && rest[a] && rest[b]) tilt[a + '>' + b] = pitch(unit(usP[ua], usP[ub])) - pitch(unit(rest[a], rest[b]));
  const tiltDir = (d, t) => {   // turn d up (+) or down (-) by t, keeping its heading
    const h = Math.hypot(d[0], d[1]); if (h < 1e-6) return d;
    const p = pitch(d) + t; return [d[0] / h * Math.cos(p), d[1] / h * Math.cos(p), Math.sin(p)];
  };
  let target = null;
  const cost = v => {
    pose(v); const P = ourPoints(body); let c = 0;
    for (const [a, b, ua, ub, w] of MATCH) { const t = target.dirs[a + '>' + b]; if (!t) continue; const u = unit(P[ua], P[ub]); c += w * ((u[0] - t[0]) ** 2 + (u[1] - t[1]) ** 2 + (u[2] - t[2]) ** 2); }
    const h = target.hips; c += 20 * ((V.qpos[0] - h[0]) ** 2 + (V.qpos[1] - h[1]) ** 2 + (V.qpos[2] - h[2]) ** 2);
    for (let i = 0; i < NJ; i++) c += 0.002 * v[6 + i] * v[6 + i];   // among equal fits, the most relaxed one
    return c;
  };
  const out = [], qpos = [];
  // the pelvis centre sits between the hip joints, a little above them on our body
  const hipLift = V.qpos[2] - (usP.hipL[2] + usP.hipR[2]) / 2;
  x[2] = V.qpos[2];
  for (let f = first; f < last; f += step) {
    const p = framePoints(bones, frames[f]), dirs = {};
    for (const [a, b] of MATCH) if (p[a] && p[b]) { const k = a + '>' + b; dirs[k] = tilt[k] ? tiltDir(unit(p[a], p[b]), tilt[k]) : unit(p[a], p[b]); }
    const mid = [(p.lhipjoint[0] + p.rhipjoint[0]) / 2, (p.lhipjoint[1] + p.rhipjoint[1]) / 2, (p.lhipjoint[2] + p.rhipjoint[2]) / 2];
    target = { dirs, hips: [mid[0] * scale, mid[1] * scale, mid[2] * scale + hipLift] };
    if (!out.length) {   // first frame: start facing the way the hips face
      const lr = unit(p.rhipjoint, p.lhipjoint); x[3] = Math.atan2(-lr[0], lr[1]); x[0] = target.hips[0]; x[1] = target.hips[1]; x[2] = target.hips[2];
    }
    // coordinate search, warm-started from the previous frame
    let c = cost(x), h = out.length ? 0.05 : 0.3;
    for (let round = 0; round < 60 && h > 2e-4; round++) {
      let better = false;
      for (let i = 0; i < x.length; i++) {
        const keep = x[i];
        for (const s of [h, -h]) {
          x[i] = Math.max(lo[i], Math.min(hi[i], keep + (i < 3 ? s * 0.3 : s)));
          const c2 = cost(x); if (c2 < c - 1e-9) { c = c2; better = true; break; }
          x[i] = keep;
        }
      }
      if (!better) h *= 0.5;
    }
    pose(x); out.push(Array.from(x, v => +v.toFixed(4))); qpos.push(Array.from(V.qpos.subarray(0, 7 + NJ), v => +v.toFixed(4)));
  }
  // put the feet on the floor: lift or lower the whole clip so the lowest foot point over the clip touches the ground
  let lowest = Infinity;
  for (const q of qpos) { V.qpos.set(q); mj.mj_kinematics(body.model, body.data); for (const s of ['L', 'R']) lowest = Math.min(lowest, body.soleClear(s)); }
  for (const q of qpos) q[2] = +(q[2] - lowest).toFixed(4); for (const r of out) r[2] = +(r[2] - lowest).toFixed(4);
  body.free();
  return { fps, joints: J.map(j => j.spec.id), frames: out, qpos, scale: +scale.toFixed(3) };
}

const api = { parseASF, parseAMC, framePoints, retarget, MATCH, TO_M };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.Mocap = api;
}
__mocapModule(typeof globalThis !== 'undefined' ? globalThis : this);
