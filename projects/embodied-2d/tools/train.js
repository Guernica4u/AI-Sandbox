/*
 Train an agent's shared brain in Node, with the same code as the page, on all CPU cores.
   node projects/embodied-2d/tools/train.js <brain.json> <generations> <skill> [seed] [cores]
 <skill> is the one being learned (stand, walk, jump or grab); every skill the brain already practises is tested too,
 once per generation, so nothing is forgotten (see the shared brain in body2d.js). Continues from <brain.json> if it
 exists (saved every 10 generations) and adds <skill> to the practised skills if it's new. Prints progress and a
 10-run success check per practised skill, each at its own difficulty stage.
*/
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { Worker, isMainThread, parentPort } = require('worker_threads');

if (!isMainThread) {
  // a worker: scores its share of the population on every attempt it's given
  require('./node-env.js').load().then(({ mj, Body2D: B }) => {
    parentPort.on('message', m => {
      const genomes = m.genomes.map(g => Float32Array.from(g)), scores = [], successes = [];
      for (const e of m.episodes) { const tr = new B.Trial(mj, e.taskId, genomes, e.cfg); scores.push(tr.run()); successes.push(tr.successes()); tr.free(); }
      parentPort.postMessage({ id: m.id, scores, successes });
    });
    parentPort.postMessage({ ready: true });
  });
  return;
}

require('./node-env.js').load().then(async ({ mj, Brain, Body2D: B }) => {
  const [file = 'brain.json', gens = '50', focus = 'stand', seed = '1', coresArg] = process.argv.slice(2);
  if (!B.SKILLS.includes(focus)) throw new Error(`unknown skill ${focus}`);
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  if (saved && saved.bodyPlan !== B.BIPED.id) throw new Error(`${file} is for body ${saved.bodyPlan}, this is ${B.BIPED.id}`);
  let stages = saved ? Object.assign({}, saved.stages) : { stand: 0 };
  if (typeof stages[focus] !== 'number') stages[focus] = 0;   // a new skill starts at its easiest
  const evo = new Brain.Evolution({ sizes: B.SIZES, popSize: 48, seed: +seed + (saved ? saved.generation : 0), sigma: saved ? saved.sigma : 0.15,
    parent: saved ? Float32Array.from(saved.params) : B.freshBrain(Brain.makeRng(+seed)), outputGroups: B.OUTPUT_GROUPS,
    generation: saved ? saved.generation : 0, history: saved ? saved.history : [] });

  // the worker pool (leave one core free for the computer)
  const n = Math.max(1, Math.min(+coresArg || os.cpus().length - 1, 48));
  const workers = await Promise.all(Array.from({ length: n }, () => new Promise(res => { const w = new Worker(__filename); w.once('message', () => res(w)); })));
  let nextId = 1;
  const runAll = (episodes, population) => {
    const per = Math.ceil(population.length / n);
    return Promise.all(workers.map((w, k) => new Promise(res => {
      const chunk = population.slice(k * per, (k + 1) * per);
      if (!chunk.length) return res(null);
      const id = nextId++, on = m => { if (m.id === id) { w.off('message', on); res(m); } };
      w.on('message', on);
      w.postMessage({ id, episodes, genomes: chunk.map(g => Array.from(g)) });
    }))).then(parts => {
      parts = parts.filter(Boolean);
      return { scores: episodes.map((_, e) => [].concat(...parts.map(p => p.scores[e]))), successes: episodes.map((_, e) => [].concat(...parts.map(p => p.successes[e]))) };
    });
  };
  const check = (params, skill) => {
    let ok = 0; const g = stages[skill], hard = B.hardness(g);
    for (let k = 0; k < 10; k++) {
      const tr = new B.Trial(mj, skill, [params], { seed: 77777 + k * 131, variant: (k % 3) - 1, hard, terrainLevel: B.terrainLevel(g), assist: skill === 'grab' ? B.gripAssist(g) : 0, noise: 0.02 * hard, earlyStop: false });
      tr.run(); ok += tr.successes()[0] ? 1 : 0; tr.free();
    }
    return ok;
  };
  const save = () => fs.writeFileSync(file, JSON.stringify({ bodyPlan: B.BIPED.id, sizes: B.SIZES, generation: evo.generation, stages, sigma: evo.sigma, history: evo.history, params: Array.from(evo.best) }));

  const t0 = Date.now(), end = evo.generation + +gens;
  console.log(`${path.basename(file)}: learning ${focus}, practising ${Object.keys(stages).join(', ')} · generation ${evo.generation} → ${end} · ${n} cores`);
  while (evo.generation < end) {
    const t1 = Date.now(), eps = B.mixedEpisodes(stages, focus, evo.generation);
    const r = await runAll(eps, evo.population);
    const combined = B.combineMixed(r.scores);
    stages = B.nextStages(stages, eps, combined, r.successes);
    evo.tell(combined);
    if (evo.generation % 10 === 0 || evo.generation === end) {
      const parts = Object.keys(stages).map(k => `${k} stage ${stages[k].toFixed(1)} (${Math.round(B.hardness(stages[k]) * 100)}%) ${check(evo.best, k)}/10`);
      console.log(`gen ${evo.generation} · ${parts.join(' · ')} · ${((Date.now() - t1) / 1000).toFixed(1)} s/gen · ${((Date.now() - t0) / 60000).toFixed(1)} min`);
      save();
    }
  }
  save();
  for (const w of workers) w.terminate();
});
