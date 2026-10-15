/*
 Glass Box · Embodied 2D · physics test kit
 Run:  node projects/embodied-2d/tests/physics-kit.js
 Scores the engine (MuJoCo + muscle.js) on what a realistic body needs, so every physics change can be judged by
 numbers before anything is retrained. Each check prints its value, its pass mark and PASS/FAIL.
 Physics checks don't depend on any controller; "ideal" checks use the hand-made reference movements (Test mode).
*/
'use strict';
const env = require('../tools/node-env.js');
env.load().then(({ mj, Brain, Muscle, Body2D: B }) => {
  const rows = [];
  function report(name, value, unit, pass, mark, note) {
    rows.push({ name, ok: pass });
    const v = typeof value === 'number' ? value.toFixed(2) : String(value);
    console.log(`${pass === null ? 'INFO' : pass ? 'PASS' : 'FAIL'}  ${name.padEnd(38)} ${v.padStart(8)} ${unit.padEnd(6)} pass: ${mark}${note ? '  · ' + note : ''}`);
  }
  const fresh = () => B.freshBrain(Brain.makeRng(1));
  /** A never-ending, shove-free attempt (like Test mode) stepped for secs; onStep(body, trial) after each step. */
  function simulate(skill, opts, secs, onStep, setup) {
    const tr = new B.Trial(mj, skill, [fresh()], Object.assign({ seed: 4242, hard: 0, push: 0, noise: 0, keepSimulating: true, terrain: [] }, opts));
    tr.maxSteps = Infinity; const a = tr.agents[0];
    if (setup) setup(a.body, tr);
    while (tr.time < secs) { a.done = false; a.body.fallen = false; a.body.energyLeft = a.body.energyMax; tr.step(); if (onStep) onStep(a.body, tr); }
    tr.free();
  }
  console.log(`Glass Box physics test kit · body ${B.BIPED.id} · MuJoCo + muscles\n`);

  // 1. Muscles: each one's peak strength when held still (across the joint's range), against human data (muscle.js)
  {
    let worst = 0, name = '';
    for (const [k, g] of Object.entries(Muscle.MUSCLES)) for (const side of ['up', 'down']) {
      const [T] = g[side], [lo, hi] = Muscle.RANGE[k]; let peak = 0;
      for (let q = lo; q <= hi + 1e-9; q += (hi - lo) / 20) {
        const m = Muscle.makeMuscles([k + 'L'])[side === 'up' ? 1 : 0];
        let tq = 0; for (let i = 0; i < 1000; i++) tq = m.step(1, q, 1 / 1000);
        peak = Math.max(peak, Math.abs(tq));
      }
      const err = Math.abs(peak - T) / T; if (err > worst) { worst = err; name = `${k} ${side}`; }
    }
    report('muscle strength vs human data', worst * 100, '% off', worst < 0.05, '< 5%', `worst: ${name}`);
  }
  // 2. Ground contact on its own: a 31 kg block (half the body on one foot) pushed at half of what friction holds
  {
    const xml = `<mujoco><option timestep="${B.DT / B.SUB}" integrator="implicitfast" noslip_iterations="3"/><worldbody><geom type="plane" size="5 5 .1" friction="1.0"/>
      <body pos="0 0 0.03"><joint type="slide" axis="1 0 0"/><joint type="slide" axis="0 0 1"/><geom type="box" size="0.11 0.05 0.03" mass="31" friction="1.1"/></body></worldbody></mujoco>`;
    const m = mj.MjModel.from_xml_string(xml), d = new mj.MjData(m);
    for (let i = 0; i < 60 * B.SUB; i++) mj.mj_step(m, d);
    const x0 = d.qpos[0];
    for (let i = 0; i < 240 * B.SUB; i++) { d.qfrc_applied[0] = 0.5 * 1.1 * 31 * 9.81; mj.mj_step(m, d); }
    const v = (d.qpos[0] - x0) / 4 * 100; d.delete(); m.delete();
    report('planted foot under sideways force: slip', v, 'cm/s', v < 0.05, '< 0.05');
  }
  // 3. Lying limp: a relaxed body on the floor must stay put, and must not shake
  {
    let x0 = null, x1 = 0, peak = 0, sum = 0, n = 0;
    simulate('stand', {}, 12, (b, tr) => { if (tr.time > 4) { const x = b.torso.translation().x; if (x0 === null) x0 = x; x1 = x; for (const j of b.joints) { const v = Math.abs(b.speed(j)); peak = Math.max(peak, v); sum += v; n++; } } }, (b, tr) => { tr.brainOff = true; });
    report('lying limp: creep along the floor', Math.abs(x1 - x0) / 8 * 100, 'cm/s', Math.abs(x1 - x0) / 8 * 100 < 0.5, '< 0.5');
    report('lying limp: joints moving (average)', sum / n, 'rad/s', sum / n < 0.2, '< 0.2');
    report('lying limp: brief twitches (worst)', peak, 'rad/s', null, 'info', 'known minor issue: light parts resting on the ground or a joint limit');
  }
  // 4. Held in the harness, muscles at a steady tone: joints must hold still (no jitter from the engine or muscles)
  {
    let peak = 0;
    simulate('stand', {}, 4, (b, tr) => { b.exc.fill(0.15); if (tr.time > 2) for (const j of b.joints) peak = Math.max(peak, Math.abs(b.speed(j))); },
      b => { b.setHarness(true); const act = b.act.bind(b); b.act = () => { act(new Float32Array(B.MOTORS).fill(0.15)); }; });
    report('in harness, steady tone: joints shaking', peak, 'rad/s', peak < 0.5, '< 0.5');
  }
  if (process.env.SPEED) { const mk = Muscle.makeMuscles; Muscle.makeMuscles = (ids, o) => mk(ids, Object.assign({ speed: +process.env.SPEED }, o)); }   // calibration runs
  // 5. Jump: the muscles alone. Torso held upright, crouch, then every leg straightening muscle fully on (a crude squat jump)
  {
    let best = 0;
    const crouchFor = depth => ({ hipL: depth, hipR: depth, kneeL: -1.6 * depth, kneeR: -1.6 * depth, ankleL: 0.3, ankleR: 0.3, lumbar: 0, thoracic: 0, neck: 0 });
    for (const depth of [0.7, 0.9, 1.1, 1.3]) for (const hold of [10, 25]) {
      let rise = 0;
      simulate('stand', {}, 2.2, (b, tr) => {
        const f = tr.steps; rise = Math.max(rise, b.torso.translation().y - B.ROOT_Y);
        if (f >= 40 + hold) b.act = (out) => {
          b.exc.fill(0);
          for (const j of b.joints) {
            const g = j.spec.id.replace(/[LR]$/, '');
            if (/hip|ankle|toe/.test(g)) b.exc[2 * j.i] = 1; else if (g === 'knee') b.exc[2 * j.i + 1] = 1;
            else if (j.spec.group === 'trunk') { b.exc[2 * j.i] = 0.3; b.exc[2 * j.i + 1] = 0.3; }   // back and neck braced
          }
        };
      }, b => {
        b.setHarness(true, 0, true);
        const steer = (out, ov) => B.Biped.prototype.act.call(b, new Float32Array(B.MOTORS), ov, { kp: 6, kd: 0.4, co: 0.1 });
        let t = 0; b.act = () => { t++; const k = Math.min(1, Math.max(0, (t - 10) / 24)), c = crouchFor(depth), ov = {}; for (const id in c) ov[id] = B.REST_POSE[id] + (c[id] - B.REST_POSE[id]) * k; steer(null, ov); };
      });
      best = Math.max(best, rise * 100);
    }
    report('squat jump, muscles alone (torso upright)', best, 'cm', best >= 20 && best <= 40, '20-40', 'all muscles at once; best human squat jump ~30');
  }
  // 6. Repeatability: the same brain and seed give exactly the same score
  {
    const p = fresh(), run = () => { const tr = new B.Trial(mj, 'walk', [p], { seed: 99, hard: 1 }); const s = tr.run()[0]; tr.free(); return s; };
    const a = run(), b = run();
    report('repeatability (same run twice)', Math.abs(a - b), 'diff', a === b, '0');
  }
  // 7. The ideal movements (hand-made controllers, not physics): can they do each skill?
  for (const skill of ['stand', 'walk', 'jump', 'grab']) {
    const res = B.idealCheck(mj, skill, { foodX: 9.5 }), ok = res.filter(r => r.ok).length;
    report(`ideal ${skill} (hand-made controller)`, `${ok}/3`, '', null, 'info', res[0].text);
  }
  // 8. Speed: one training generation (48 brains, Stand, 2 attempts) on one CPU core
  {
    const pop = Array.from({ length: 48 }, (_, i) => B.freshBrain(Brain.makeRng(i + 1)));
    const t0 = Date.now(); B.evaluate(mj, 'stand', pop, 150); const s = (Date.now() - t0) / 1000;
    report('speed: one Stand generation, 1 core', s, 's', null, 'info', 'untrained brains fall fast; trained ones take longer');
    const t1 = Date.now(); simulate('stand', {}, 10, null, (b, tr) => { tr.brainOff = false; }); const ms = (Date.now() - t1) / 10;
    report('speed: one body, one simulated second', ms, 'ms', ms < 20, '< 20', 'for 50-100 agents in 3D this matters');
  }
  const counted = rows.filter(r => r.ok !== null), fails = counted.filter(r => !r.ok).length;
  console.log(`\n${counted.length - fails} passed, ${fails} failed (info rows not counted)`);
});
