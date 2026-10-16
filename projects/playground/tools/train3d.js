/*
 Train a Playground (3D) brain in Node, on all CPU cores, with the same code as the page.
   node projects/playground/tools/train3d.js <brain.json> <generations> [skill=stand] [seed] [cores]
 Saves every 10 generations and continues where it left off. Difficulty rises only while the best brain copes
 (the same stages as Embodied 2D). Prints a 10-run success check at the current difficulty.
*/
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { Worker, isMainThread, parentPort } = require('worker_threads');
const env = require('../../embodied-2d/tools/node-env.js');

if (!isMainThread) {
  env.load().then(({ mj }) => {
    const P = require('../body3d.js');
    parentPort.on('message', m => {
      const genomes = m.genomes.map(g => Float32Array.from(g)), scores = [], successes = [];
      for (const e of m.episodes) { const tr = new P.Trial3D(mj, e.taskId, genomes, e.cfg); scores.push(tr.run()); successes.push(tr.successes()); tr.free(); }
      parentPort.postMessage({ id: m.id, scores, successes });
    });
    parentPort.postMessage({ ready: true });
  });
  return;
}

env.load().then(async ({ mj, Brain }) => {
  const P = require('../body3d.js');
  const [file = 'brain3d.json', gens = '50', skill = 'stand', seed = '1', coresArg] = process.argv.slice(2);
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  if (saved && saved.bodyPlan !== P.BODY.id) throw new Error(`${file} is for body ${saved.bodyPlan}, this is ${P.BODY.id}`);
  if (saved && saved.sizes.join() !== P.SIZES.join()) throw new Error(`${file} has a ${saved.sizes.join('-')} brain, this body needs ${P.SIZES.join('-')}`);
  let stage = saved ? saved.stage : 0;
  const method = process.env.GB_METHOD || (saved && saved.method) || 'ga', Learner = method === 'es' ? Brain.Strategy : Brain.Evolution;
  const evo = new Learner({ sizes: P.SIZES, popSize: 48, seed: +seed + (saved ? saved.generation : 0), sigma: saved ? saved.sigma : 0.15,
    parent: saved ? Float32Array.from(saved.params) : P.freshBrain(Brain.makeRng(+seed)), outputGroups: P.OUTPUT_GROUPS,
    generation: saved ? saved.generation : 0, history: saved ? saved.history : [] });

  const n = Math.max(1, Math.min(+coresArg || os.cpus().length - 1, 48));
  const workers = await Promise.all(Array.from({ length: n }, () => new Promise(res => { const w = new Worker(__filename); w.once('message', () => res(w)); })));
  let nextId = 1;
  const runAll = (episodes, population) => {
    const per = Math.ceil(population.length / n);
    return Promise.all(workers.map((w, k) => new Promise(res => {
      const chunk = population.slice(k * per, (k + 1) * per);
      if (!chunk.length) return res(null);
      const id = nextId++, on = m => { if (m.id === id) { w.off('message', on); res(m); } };
      w.on('message', on); w.postMessage({ id, episodes, genomes: chunk.map(g => Array.from(g)) });
    }))).then(parts => { parts = parts.filter(Boolean); return { scores: episodes.map((_, e) => [].concat(...parts.map(p => p.scores[e]))), successes: episodes.map((_, e) => [].concat(...parts.map(p => p.successes[e]))) }; });
  };
  const check = params => { let ok = 0; for (let k = 0; k < 10; k++) { const tr = new P.Trial3D(mj, skill, [params], { seed: 77777 + k * 131, hard: P.hardness(stage), assist: P.assistFor(stage) }); tr.run(); ok += tr.successes()[0] ? 1 : 0; tr.free(); } return ok; };
  const save = () => fs.writeFileSync(file, JSON.stringify({ bodyPlan: P.BODY.id, sizes: P.SIZES, skill, method, generation: evo.generation, stage, sigma: evo.sigma, history: evo.history, params: Array.from(evo.best) }));

  const t0 = Date.now(), end = evo.generation + +gens;
  console.log(`${path.basename(file)}: Playground · learning ${skill} · generation ${evo.generation} → ${end} · ${n} cores · brain ${P.SIZES.join('-')} · ${method === 'es' ? 'evolution strategy' : 'copy-and-mutate'}`);
  while (evo.generation < end) {
    const t1 = Date.now(), eps = P.episodeConfigs(skill, stage, evo.generation).map(cfg => ({ taskId: skill, cfg }));
    const r = await runAll(eps, evo.population), combined = P.combineRanks(r.scores);
    let best = 0; if (evo.judge) best = evo.judge(); else for (let i = 1; i < combined.length; i++) if (combined[i] > combined[best]) best = i;
    stage = P.nextStage(stage, r.successes.reduce((s, ep) => s + (ep[best] ? 1 : 0), 0) / r.successes.length);
    evo.tell(combined);
    if (evo.generation % 10 === 0 || evo.generation === end) {
      console.log(`gen ${evo.generation} · ${skill} stage ${stage.toFixed(1)} (${Math.round(P.hardness(stage) * 100)}%, help ${Math.round(P.assistFor(stage) * 100)}%) · check ${check(evo.best)}/10 · ${((Date.now() - t1) / 1000).toFixed(1)} s/gen · ${((Date.now() - t0) / 60000).toFixed(1)} min`);
      save();
    }
  }
  save();
  for (const w of workers) w.terminate();
});
