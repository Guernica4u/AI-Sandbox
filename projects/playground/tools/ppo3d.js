/*
 Train a Playground (3D) brain by learning from experience (PPO, see learn.js), on all CPU cores.
   node projects/playground/tools/ppo3d.js <brain.json> <iterations> [skills=stand] [seed] [cores]
 skills: one or more, comma-separated, practised together by the one brain (mixed practice, so learning a new skill
 doesn't wipe out the old ones):
   stand, carry          the tasks (stand against shoves; pick up the box and carry it)
   copy:walk, copy:stand ... copy a recorded person (any clip in mocap/clips.js; a bare clip name like "walk" works too)
   e.g.  copy:stand,copy:walk,stand,carry
 Each iteration: every core practises with 2 bodies (the skills shared out over all the bodies) for 512 brain steps,
 then the brain and the critic learn from all of it together. Each skill has its own difficulty stage, which rises
 only while that skill copes. Saves every 5 iterations and continues where it left off.
 Env: GB_STAGE=<n> start stage (fresh brains), GB_ASSIST=<0..1> fixed helping hands (default: by stage).
*/
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const env = require('../../embodied-2d/tools/node-env.js');

if (!isMainThread) {
  env.load().then(({ mj }) => {
    globalThis.Body3D = require('../body3d.js');
    const Learn = require('../learn.js');
    const pr = new Learn.Practice(mj, workerData);
    parentPort.on('message', m => {
      if (m.cmd === 'rollout') parentPort.postMessage(Object.assign({ id: m.id }, pr.rollout(m)));
      else if (m.cmd === 'grad') { const g = pr.grad(m); parentPort.postMessage({ id: m.id, count: g.count, gp: g.gp, gls: g.gls, gv: g.gv, kl: g.kl, clipped: g.clipped, vloss: g.vloss }, [g.gp.buffer, g.gls.buffer, g.gv.buffer]); }
    });
    parentPort.postMessage({ ready: true });
  });
  return;
}

env.load().then(async () => {
  const P = require('../body3d.js'); globalThis.Body3D = P;
  const Learn = require('../learn.js'), CLIPS = require('../mocap/clips.js');
  const [file = 'ppo3d.json', iters = '100', skillArg = 'stand', seed = '1', coresArg] = process.argv.slice(2);
  // the skills: tasks by name, copying a person as copy:<clip> (or the bare clip name)
  const skills = skillArg.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const clip = s.startsWith('copy:') ? s.slice(5) : !P.TASKS[s] && CLIPS[s] ? s : null;
    if (clip && !CLIPS[clip]) throw new Error('no clip ' + clip);
    if (!clip && !P.TASKS[s]) throw new Error('no task ' + s);
    return clip ? { key: 'copy:' + clip, taskId: 'stand', clip } : { key: s, taskId: s };
  });
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  if (saved && saved.bodyPlan !== P.BODY.id) throw new Error(`${file} is for body ${saved.bodyPlan}, this is ${P.BODY.id}`);
  const fromPPO = saved && saved.method === 'ppo';
  // each skill's stage: from the file (old single-skill files: their one stage belongs to their one skill)
  const stages = Object.assign({}, saved && saved.stages);
  if (saved && !saved.stages && saved.skill) stages[['walk', 'walk2', 'run', 'jump'].includes(saved.skill) ? 'copy:' + saved.skill : saved.skill] = saved.stage || 0;
  for (const sk of skills) if (stages[sk.key] === undefined) stages[sk.key] = saved ? 0 : +(process.env.GB_STAGE || 0);
  const L = Learn.newLearner({ seed: +seed, policy: saved && saved.params, value: fromPPO ? saved.value : null, logstd: fromPPO ? saved.logstd : null,
    stages, iteration: fromPPO ? saved.generation : 0, samples: fromPPO ? saved.samples : 0, history: fromPPO ? saved.history : [] });
  const assist = process.env.GB_ASSIST !== undefined ? +process.env.GB_ASSIST : undefined;

  const n = Math.max(1, Math.min(+coresArg || os.cpus().length - 1, 48)), E = 2;
  const workers = await Promise.all(Array.from({ length: n }, (_, k) => new Promise(res => {
    const specs = Array.from({ length: E }, (_, e) => skills[(k * E + e) % skills.length]);   // the skills shared out over all bodies
    const w = new Worker(__filename, { workerData: { specs, stages: L.stages, seed: +seed * 100 + k + 1, envs: E, steps: 512, assist } });
    w.once('message', () => res(w));
  })));
  let nextId = 1;
  const ask = (w, msg) => new Promise(res => { const id = nextId++, on = m => { if (m.id === id) { w.off('message', on); res(m); } }; w.on('message', on); w.postMessage(Object.assign({ id }, msg)); });
  const keys = skills.map(s => s.key);
  const save = () => fs.writeFileSync(file, JSON.stringify(Learn.learnerToJSON(L, { skill: keys.join(','), skills: keys, stage: L.stages[keys[0]] || 0 })));
  const EPOCHS = 5, K = 8;   // 5 passes over the data, 8 minibatches each
  const help = st => Math.round((assist !== undefined ? assist : P.assistFor(st)) * 100);

  const t0 = Date.now(), end = L.iteration + +iters;
  console.log(`${path.basename(file)}: Playground · learning ${keys.join(' + ')} from experience · iteration ${L.iteration} → ${end} · ${n} cores, ${n * E} bodies${assist !== undefined ? ` · help fixed ${assist}` : ''}`);
  while (L.iteration < end) {
    const t1 = Date.now();
    const ro = await Promise.all(workers.map(w => ask(w, { cmd: 'rollout', policy: L.policy, logstd: L.logstd, value: L.value, valueSizes: Learn.VALUE_SIZES, stages: L.stages })));
    const N = ro.reduce((s, r) => s + r.n, 0), advMean = ro.reduce((s, r) => s + r.advSum, 0) / N;
    const advStd = Math.sqrt(Math.max(1e-8, ro.reduce((s, r) => s + r.advSum2, 0) / N - advMean * advMean));
    const eps = [].concat(...ro.map(r => r.episodes));
    let info = null;
    for (let ep = 0; ep < EPOCHS; ep++) {
      const epochSeed = L.iteration * 100 + ep + 1;
      for (let k = 0; k < K; k++) {
        const parts = await Promise.all(workers.map(w => ask(w, { cmd: 'grad', policy: L.policy, logstd: L.logstd, value: L.value, valueSizes: Learn.VALUE_SIZES, advMean, advStd, epochSeed, k, K, entropy: 0 })));
        info = Learn.applyGrads(L, parts);
      }
      if (info.kl > 0.03) break;   // the brain moved far enough this round
    }
    L.iteration++; L.samples += N;
    // each skill's difficulty: harder only while it copes
    const per = keys.map(key => {
      const e = eps.filter(x => x.key === key), ok = e.filter(x => x.ok).length;
      if (e.length) L.stages[key] = P.nextStage(L.stages[key] || 0, ok / e.length);
      const secs = e.length ? e.reduce((s, x) => s + x.secs, 0) / e.length : 0;
      return `${key} ${ok}/${e.length} ok, ${secs.toFixed(1)} s, stage ${(L.stages[key] || 0).toFixed(0)} help ${help(L.stages[key] || 0)}%`;
    });
    const meanR = ro.reduce((s, r) => s + r.meanR, 0) / ro.length;
    L.history.push([L.iteration, +meanR.toFixed(3)]);
    console.log(`it ${L.iteration} · ${per.join(' | ')} · reward/step ${meanR.toFixed(3)} · wobble ${Math.exp(L.logstd.reduce((s, x) => s + x, 0) / L.logstd.length).toFixed(3)} · ` +
      `kl ${info.kl.toFixed(4)} clip ${(info.clip * 100).toFixed(0)}% critic ${info.vloss.toFixed(3)} · ${((Date.now() - t1) / 1000).toFixed(1)} s · ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    if (L.iteration % 5 === 0 || L.iteration === end) save();
  }
  save();
  for (const w of workers) w.terminate();
});
