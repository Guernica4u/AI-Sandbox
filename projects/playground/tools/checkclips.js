/*
 Can our body do each human example? Plays every clip (mocap/clips.js) on the body: its own muscles steer each joint
 along the recording (like Test > Play ideal), while a "balance helper" pushes and turns the hips toward where the
 person's hips were. How hard the helper has to work says whether the clip suits our body:
   little help  -> fine: the body can do it, the agent only has to learn the balance
   lots of help -> the fitting is probably off (feet through the floor, impossible poses): fix or drop the clip
   node projects/playground/tools/checkclips.js [clipId ...]
*/
'use strict';
require('../../embodied-2d/tools/node-env.js').load().then(({ mj }) => {
  globalThis.Body3D = require('../body3d.js');
  const B3 = globalThis.Body3D, L = require('../learn.js'), CLIPS = require('../mocap/clips.js');
  const want = process.argv.slice(2), rows = [];
  for (const [id, c] of Object.entries(CLIPS)) {
    if (want.length && !want.includes(id)) continue;
    const ref = new L.Reference(c, c.loop), b = new B3.Body3D(mj), V = b.views(), NQ = c.qpos[0].length;
    const q0 = ref.pose(0), v0 = ref.vel(0, new Float64Array(NQ));
    V.qpos.set(q0); V.qvel.fill(0); V.qvel[0] = v0[0]; V.qvel[1] = v0[1]; V.qvel[2] = v0[2];
    for (const j of b.joints) V.qvel[j.dq] = v0[j.q];
    mj.mj_forward(b.model, b.data); b.savePositions();
    for (let k = 0; k < 400; k++) for (let m = 0; m < B3.NM; m++) b.mus[m].step(0.1, V.qpos[b.jq[m >> 1]], 1 / 400);
    const weight = b.totalMass() * 9.81, pel = b.ids.pelvis, secs = Math.min(ref.length, 8), steps = Math.round(secs / B3.DT);
    const over = {}, zero = new Float32Array(B3.MOTORS);
    let F = 0, T = 0, err = 0, worstF = 0, maxOff = 0;
    for (let s = 0; s < steps; s++) {
      const t = (s + 1) * B3.DT, q = ref.pose(t);
      for (const j of b.joints) over[j.spec.id] = q[j.q];
      b.act(zero, over);
      // the helper: a spring-damper on the hips' position and turn, toward the person's
      const p = [V.qpos[0], V.qpos[1], V.qpos[2]], v = b.partVel('pelvis'), f = [0, 1, 2].map(k => 3000 * (q[k] - p[k]) - 300 * v[k]);
      const bq = [V.qpos[3], V.qpos[4], V.qpos[5], V.qpos[6]], rq = [q[3], q[4], q[5], q[6]];
      // error turn = ref * conj(body)
      let w = rq[0] * bq[0] + rq[1] * bq[1] + rq[2] * bq[2] + rq[3] * bq[3];
      let ex = -rq[0] * bq[1] + rq[1] * bq[0] - rq[2] * bq[3] + rq[3] * bq[2];
      let ey = -rq[0] * bq[2] + rq[1] * bq[3] + rq[2] * bq[0] - rq[3] * bq[1];
      let ez = -rq[0] * bq[3] - rq[1] * bq[2] + rq[2] * bq[1] + rq[3] * bq[0];
      if (w < 0) { w = -w; ex = -ex; ey = -ey; ez = -ez; }
      const om = [V.cvel[6 * pel], V.cvel[6 * pel + 1], V.cvel[6 * pel + 2]], tq = [ex, ey, ez].map((e, k) => 300 * 2 * e - 5 * om[k]);   // gentle: it's applied for a whole brain step, so stiff damping on the light hips overshoots
      b.pull('pelvis', f[0], f[1], f[2]); b.twist('pelvis', tq[0], tq[1], tq[2]);
      b.step(); b.muscles();
      const fm = Math.hypot(...f); F += fm; worstF = Math.max(worstF, fm); T += Math.hypot(...tq);
      let e2 = 0; for (const j of b.joints) e2 += (V.qpos[j.q] - q[j.q]) ** 2; err += Math.sqrt(e2 / b.joints.length);
      maxOff = Math.max(maxOff, Math.hypot(V.qpos[0] - q[0], V.qpos[1] - q[1], V.qpos[2] - q[2]));
    }
    const help = F / steps / weight;
    // the recording itself, pose by pose (no physics): feet through the floor? planted feet sliding? joints stuck at their limits?
    let sink = 0, slide = 0, planted = 0, pinned = 0, prevFeet = null;
    for (const qq of c.qpos) {
      V.qpos.set(qq); mj.mj_kinematics(b.model, b.data);
      const feet = ['L', 'R'].map(sd => ({ low: b.soleClear(sd), at: b.pose('foot' + sd).pos }));
      for (const ft of feet) sink = Math.max(sink, -ft.low);
      if (prevFeet) feet.forEach((ft, k) => { if (ft.low < 0.02 && prevFeet[k].low < 0.02) { planted++; slide += Math.hypot(ft.at[0] - prevFeet[k].at[0], ft.at[1] - prevFeet[k].at[1]) * c.fps; } });
      prevFeet = feet;
      for (const j of b.joints) { const r = j.spec.range, a = qq[j.q]; if (a <= r[0] + 0.01 || a >= r[1] - 0.01) pinned++; }
    }
    rows.push({ id, label: c.label, secs, help, worst: worstF / weight, turn: T / steps, err: err / steps * 57.3, off: maxOff,
      sink: sink * 100, slide: planted ? slide / planted * 100 : 0, pinned: pinned / (c.qpos.length * b.joints.length) * 100 });
    b.free();
  }
  // the recording's own quality decides the verdict; the muscle-follow numbers compare clips (the puppeteer is crude)
  rows.sort((a, z) => a.slide - z.slide);
  console.log('clip         feet sink  planted feet slide  joints at limit | muscle-follow: help (of weight)  joint error  hips off | verdict');
  for (const r of rows) {
    const verdict = r.sink < 3 && r.slide < 15 && r.pinned < 3 ? 'fine' : r.sink < 6 && r.slide < 30 && r.pinned < 8 ? 'usable' : 'check it';
    console.log(`${r.id.padEnd(12)} ${r.sink.toFixed(1).padStart(5)} cm   ${r.slide.toFixed(0).padStart(6)} cm/s       ${r.pinned.toFixed(1).padStart(5)}%     |   ${(r.help * 100).toFixed(0).padStart(5)}%                    ${r.err.toFixed(0).padStart(4)}°      ${(r.off * 100).toFixed(0).padStart(3)} cm  | ${verdict}`);
  }
});
