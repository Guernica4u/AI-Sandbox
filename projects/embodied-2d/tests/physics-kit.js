/*
 Glass Box · Embodied 2D · physics test kit
 Run:  node projects/embodied-2d/tests/physics-kit.js
 Scores the engine on what a realistic body needs, so every physics change can be judged by numbers before
 anything is retrained. Each check prints its value, its pass mark and PASS/FAIL.
*/
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const D = path.join(__dirname, '..');
globalThis.Brain = require(path.join(D, 'brain.js'));
const RAPIER = vm.runInThisContext(fs.readFileSync(path.join(D, 'vendor/rapier2d.js'), 'utf8') + '\n;__rapierFactory()');
const B = require(path.join(D, 'body2d.js'));
// the starter agents (starters.js is written for the page, so load it in a sandbox; a global `window` confuses Rapier)
const box = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(D, 'starters.js'), 'utf8'), box);
const STARTERS = box.window.EMBODIED_STARTERS;
const brainOf = (name, skill) => Brain.brainFromJSON(STARTERS[name][skill]).brain;
const fresh = () => B.freshBrain(Brain.makeRng(1), true);

const rows = [];
function report(name, value, unit, pass, mark, note) {
  rows.push({ name, value: typeof value === 'number' ? +value.toFixed(2) : value, unit, ok: pass, mark, note });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${String(typeof value === 'number' ? value.toFixed(2) : value).padStart(8)} ${unit.padEnd(8)} pass: ${mark}${note ? '  · ' + note : ''}`);
}
/** A trial that never ends and never shoves (like Test mode), stepped for `secs`; onStep(body, trial) after each step. */
function simulate(skill, params, opts, secs, onStep) {
  const tr = new B.Trial(RAPIER, skill, [params], Object.assign({ seed: 4242, hard: 1, push: 0, noise: 0, springy: true, keepSimulating: true, terrain: [] }, opts));
  tr.maxSteps = Infinity; tr.hard = 0;
  const a = tr.agents[0];
  while (tr.time < secs) { a.done = false; a.body.energyLeft = a.body.energyMax; tr.step(); if (onStep) onStep(a.body, tr); }
  const out = { body: a.body, st: a.st }; tr.free(); return out;
}

RAPIER.init().then(() => {
  console.log('Glass Box physics test kit · body ' + B.BIPED.id + '\n');

  // 1. Standing still: the ideal stand (ankles held mid-range). Feet must not shake, the body must not creep.
  {
    let peak = 0, x0 = null, x1 = 0;
    simulate('stand', fresh(), { ideal: true }, 6, (b, tr) => {
      if (tr.time < 2) return;
      for (const id of ['ankleL', 'ankleR']) { const j = b.joints.find(j => j.spec.id === id); peak = Math.max(peak, Math.abs(j.b.angvel() - j.a.angvel())); }
      const x = b.torso.translation().x; if (x0 === null) x0 = x; x1 = x;
    });
    report('standing: ankle shake (peak speed)', peak, 'rad/s', peak < 2, '< 2', 'trained agents ~1.3');
    report('standing: creep along the floor', Math.abs(x1 - x0) / 4 * 100, 'cm/s', Math.abs(x1 - x0) / 4 * 100 < 0.5, '< 0.5');
  }
  // 2. Lying still: a limp body on the floor must stay put (the old joint-correction creep).
  {
    let x0 = null, x1 = 0;
    const tr = new B.Trial(RAPIER, 'stand', [fresh()], { seed: 4242, hard: 0, push: 0, noise: 0, springy: true, keepSimulating: true });
    tr.maxSteps = Infinity; tr.brainOff = true;
    const a = tr.agents[0];
    while (tr.time < 8) { a.done = false; tr.step(); if (tr.time > 4) { const x = a.body.torso.translation().x; if (x0 === null) x0 = x; x1 = x; } }
    tr.free();
    report('lying limp: creep', Math.abs(x1 - x0) / 4 * 100, 'cm/s', Math.abs(x1 - x0) / 4 * 100 < 0.5, '< 0.5');
  }
  // 3. Walking: a planted foot (heel and toe both down) should not slide. Remy's walk brain, flat ground.
  {
    let slide = 0, planted = 0;
    const br = brainOf('Remy', 'walk');
    simulate('walk', br.params, { springy: !!br.springy, foodX: 30 }, 8, b => {
      for (const f of ['footL', 'footR']) if (b.footEnd(f, -1) < 0.01 && b.footEnd(f, 1) < 0.01) { slide += Math.abs(b.parts[f].linvel().x) * B.DT; planted += B.DT; }
    });
    const v = planted ? slide / planted * 100 : 0;
    report('walking: planted-foot slide', v, 'cm/s', v < 2, '< 2', 'Remy walk');
  }
  // 4. Jump height: a crude scripted crouch-and-spring (not the best possible), with and without muscle speed.
  const jump = muscleSpeed => {
    const ov = {}, stand = Object.assign({}, B.REST_POSE); delete stand.torso; Object.assign(ov, stand);
    const crouch = { hipL: 0.9, hipR: 0.9, kneeL: -1.44, kneeR: -1.44, ankleL: 0.35, ankleR: 0.35, shoulderL: -0.8, shoulderR: -0.8, elbowL: 0.2, elbowR: 0.2 };
    const ext = { hipL: -0.05, hipR: -0.05, kneeL: 0, kneeR: 0, ankleL: -0.75, ankleR: -0.75, shoulderL: 3.0, shoulderR: 3.0, elbowL: 0, elbowR: 0 };
    let rise = 0;
    const tr = new B.Trial(RAPIER, 'stand', [fresh()], { seed: 1, hard: 0, push: 0, noise: 0, springy: true, keepSimulating: true, energy: 1e9, override: ov, body: { muscleSpeed } });
    tr.maxSteps = Infinity; const b = tr.agents[0].body; b.checkFallen = () => false;
    for (let i = 0; i < 110; i++) { if (i === 20) Object.assign(ov, crouch); if (i === 45) Object.assign(ov, ext); tr.step(); rise = Math.max(rise, b.torso.translation().y - 1.2); }
    tr.free(); return rise * 100;
  };
  { const h = jump(true); report('jump height, muscle speed on', h, 'cm', h >= 20 && h <= 50, '20-50', 'scripted, people ~40'); }
  { const h = jump(false); report('jump height, other skills\' muscles', h, 'cm', h >= 20 && h <= 50, '20-50', 'muscle speed is Jump-only'); }
  // 5. Repeatability: the same brain and seed must give exactly the same score.
  {
    const br = brainOf('Kit', 'walk'), run = () => { const tr = new B.Trial(RAPIER, 'walk', [br.params], { seed: 99, hard: 1 }); const s = tr.run()[0]; tr.free(); return s; };
    const a = run(), b = run();
    report('repeatability (same run twice)', Math.abs(a - b), 'diff', a === b, '0');
  }
  // 6. The ideal movement: is every skill possible with this body and physics?
  for (const skill of ['stand', 'walk', 'jump', 'grab']) {
    const res = B.idealCheck(RAPIER, skill, { foodX: 9.5 }), ok = res.filter(r => r.ok).length;
    report(`ideal ${skill}`, `${ok}/3`, '', ok === 3, '3/3', res[0].text);
  }
  // 7. Speed: one training generation (48 brains, Walk, 2 episodes) on one CPU core.
  {
    const p = B.transferBrain(brainOf('Kit', 'stand').params, 'stand', 'walk'), pop = Array.from({ length: 48 }, () => p);
    const t0 = Date.now(); B.evaluate(RAPIER, 'walk', pop, 100, {}); const s = (Date.now() - t0) / 1000;
    report('speed: one walk generation, 1 core', s, 's', s < 4, '< 4', 'today ~1.2-2 s');
  }
  const fails = rows.filter(r => !r.ok).length;
  console.log(`\n${rows.length - fails} passed, ${fails} failed`);
});
