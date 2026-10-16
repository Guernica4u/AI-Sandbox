/*
 Train a Playground (3D) brain by learning from experience (PPO, see learn.js), on all CPU cores.
   node projects/playground/tools/ppo3d.js <brain.json> <iterations> [skill=stand] [seed] [cores]
 Each iteration: every core practises with 2 bodies for 512 brain steps (~8.5 s each), then the brain and the
 critic learn from all of it together (each core works out its share of the gradients). Saves every 5 iterations
 and continues where it left off. Difficulty stages rise only while it copes, as in evolution.
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

env.load().then(async ({ mj, Brain }) => {
  const P = require('../body3d.js'); globalThis.Body3D = P;
  const Learn = require('../learn.js');
  const [file = 'ppo3d.json', iters = '100', skill = 'stand', seed = '1', coresArg] = process.argv.slice(2);
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  if (saved && saved.bodyPlan !== P.BODY.id) throw new Error(`${file} is for body ${saved.bodyPlan}, this is ${P.BODY.id}`);
  const fromPPO = saved && saved.method === 'ppo';
  const L = Learn.newLearner({ seed: +seed, policy: saved && saved.params, value: fromPPO ? saved.value : null, logstd: fromPPO ? saved.logstd : null,
    stage: saved ? saved.stage : +(process.env.GB_STAGE || 0), iteration: fromPPO ? saved.generation : 0, samples: fromPPO ? saved.samples : 0, history: fromPPO ? saved.history : [] });
  const assist = process.env.GB_ASSIST !== undefined ? +process.env.GB_ASSIST : undefined;

  const n = Math.max(1, Math.min(+coresArg || os.cpus().length - 1, 48));
  const workers = await Promise.all(Array.from({ length: n }, (_, k) => new Promise(res => {
    const w = new Worker(__filename, { workerData: { taskId: skill, stage: L.stage, seed: +seed * 100 + k + 1, envs: 2, steps: 512, assist } });
    w.once('message', () => res(w));
  })));
  let nextId = 1;
  const ask = (w, msg) => new Promise(res => { const id = nextId++, on = m => { if (m.id === id) { w.off('message', on); res(m); } }; w.on('message', on); w.postMessage(Object.assign({ id }, msg)); });
  const save = () => fs.writeFileSync(file, JSON.stringify(Learn.learnerToJSON(L, { skill })));
  const EPOCHS = 5, K = 8;   // 5 passes over the data, 8 minibatches each

  const t0 = Date.now(), end = L.iteration + +iters;
  console.log(`${path.basename(file)}: Playground · learning ${skill} from experience · iteration ${L.iteration} → ${end} · ${n} cores · stage ${L.stage}${assist !== undefined ? ` · help fixed ${assist}` : ''}`);
  while (L.iteration < end) {
    const t1 = Date.now(), base = { policy: L.policy, logstd: L.logstd, value: L.value, valueSizes: Learn.VALUE_SIZES, stage: L.stage };
    const ro = await Promise.all(workers.map(w => ask(w, Object.assign({ cmd: 'rollout' }, base))));
    const N = ro.reduce((s, r) => s + r.n, 0), advMean = ro.reduce((s, r) => s + r.advSum, 0) / N;
    const advStd = Math.sqrt(Math.max(1e-8, ro.reduce((s, r) => s + r.advSum2, 0) / N - advMean * advMean));
    const eps = [].concat(...ro.map(r => r.episodes)), t2 = Date.now();
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
    // difficulty: harder only while it copes (most finished attempts lasted the whole time)
    const fin = eps.length, ok = eps.filter(e => e.ok).length, rate = fin ? ok / fin : 1;
    L.stage = P.nextStage(L.stage, fin === 0 ? 1 : rate);
    const meanSecs = fin ? eps.reduce((s, e) => s + e.secs, 0) / fin : 8.5, meanR = ro.reduce((s, r) => s + r.meanR, 0) / ro.length;
    L.history.push([L.iteration, +meanR.toFixed(3), +meanSecs.toFixed(2)]);
    console.log(`it ${L.iteration} · stage ${L.stage.toFixed(1)} (${Math.round(P.hardness(L.stage) * 100)}%, help ${Math.round((assist !== undefined ? assist : P.assistFor(L.stage)) * 100)}%) · ` +
      `${fin} tries, ${ok} stayed up, avg ${meanSecs.toFixed(1)} s · reward/step ${meanR.toFixed(3)} · wobble ${Math.exp(L.logstd.reduce((s, x) => s + x, 0) / L.logstd.length).toFixed(3)} · ` +
      `kl ${info.kl.toFixed(4)} clip ${(info.clip * 100).toFixed(0)}% critic ${info.vloss.toFixed(3)} · practice ${((t2 - t1) / 1000).toFixed(1)} s learn ${((Date.now() - t2) / 1000).toFixed(1)} s · ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    if (L.iteration % 5 === 0 || L.iteration === end) save();
  }
  save();
  for (const w of workers) w.terminate();
});
