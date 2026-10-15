/*
 Train a skill in Node, with the same code as the page (one CPU core).
   node projects/embodied-2d/tools/train.js <skill> <generations> <brain.json> [seed] [from-brain.json]
 Continues from <brain.json> if it exists (it's saved every 10 generations). A new brain starts fresh, or from
 another skill's brain (e.g. Stand) given as [from-brain.json]. Prints progress and a 10-run success check.
*/
'use strict';
const fs = require('fs');
require('./node-env.js').load().then(({ mj, Brain, Body2D: B }) => {
  const [skill = 'stand', gens = '50', file = 'brain.json', seed = '1', from] = process.argv.slice(2);
  let saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  let parent;
  if (saved) parent = Float32Array.from(saved.params);
  else if (from) { const f = JSON.parse(fs.readFileSync(from, 'utf8')); parent = B.transferBrain(Float32Array.from(f.params), f.skill, skill); }
  else parent = B.freshBrain(Brain.makeRng(+seed));
  const evo = new Brain.Evolution({ sizes: B.SIZES, popSize: 48, seed: +seed + (saved ? saved.generation : 0), sigma: saved ? saved.sigma : 0.15,
    parent, outputGroups: B.OUTPUT_GROUPS, generation: saved ? saved.generation : 0, history: saved ? saved.history : [] });
  let stage = saved && typeof saved.stage === 'number' ? saved.stage : 0;   // difficulty: rises only while the best brain copes
  const check = (params, g) => {
    let ok = 0; const hard = B.hardness(g);
    for (let k = 0; k < 10; k++) {
      const tr = new B.Trial(mj, skill, [params], { seed: 77777 + k * 131, variant: (k % 3) - 1, hard, terrainLevel: B.terrainLevel(g), assist: skill === 'grab' ? B.gripAssist(g) : 0, noise: 0.02 * hard, earlyStop: false });
      tr.run(); ok += tr.successes()[0] ? 1 : 0; tr.free();
    }
    return ok;
  };
  const t0 = Date.now(), end = evo.generation + +gens;
  console.log(`${skill}: generation ${evo.generation} → ${end}`);
  while (evo.generation < end) {
    const t1 = Date.now();
    const r = B.evaluate(mj, skill, evo.population, stage, evo.generation, true);
    stage = B.nextStage(stage, r.successRate);
    evo.tell(r.scores);
    if (evo.generation % 10 === 0 || evo.generation === end) {
      const tr = new B.Trial(mj, skill, [evo.best], { seed: 5, hard: B.hardness(stage), terrainLevel: B.terrainLevel(stage), earlyStop: false });
      tr.run(); const a = tr.agents[0];
      console.log(`gen ${evo.generation} · best ${evo.bestFitness.toFixed(2)} · stage ${stage.toFixed(1)} (level ${(B.hardness(stage) * 100).toFixed(0)}%) · ${B.TASKS[skill].describe(a.st, a.body)} · check ${check(evo.best, stage)}/10 · ${((Date.now() - t1) / 1000).toFixed(1)} s/gen · ${((Date.now() - t0) / 60000).toFixed(1)} min`);
      tr.free();
      fs.writeFileSync(file, JSON.stringify({ skill, bodyPlan: B.BIPED.id, sizes: B.SIZES, generation: evo.generation, stage, sigma: evo.sigma, history: evo.history, params: Array.from(evo.best) }));
    }
  }
});
