/*
================================================================================
 GLASS BOX · EMBODIED  -  brain.js
================================================================================
 The learning half of an embodied agent. It knows nothing about physics,
 2D vs 3D, or the page: it maps a list of numbers (what the body senses) to a
 list of numbers (what each motor should do), and improves by neuroevolution.

 This file is meant to be reused as-is by the 3D version. A body only has to
 provide:  body.sense(out: Float32Array)  and  body.act(actions: Float32Array)

 BODY-BRAIN FILE FORMAT  (format "glassbox-body-brain", formatVersion 1)
 {
   "format": "glassbox-body-brain", "formatVersion": 1, "app": "Glass Box",
   "exportedAt": "...ISO date...",
   "name": "Ash",                 // agent name
   "bodyPlan": "biped2d-v1",      // which body it controls; a brain only fits its own body plan
   "skill": "walk",               // "walk" | "grab"
   "sizes": [38, 24, 11],         // network layer sizes (inputs, hidden..., outputs)
   "weights": "base64 Float32",   // all weights and biases, layer by layer
   "generation": 120,             // generations of evolution so far
   "sigma": 0.08,                 // current mutation size
   "seed": 12345,                 // the agent's own random seed (why every agent ends up different)
   "history": [[gen, best, mean], ...],
   "created": "...", "updated": "..."
 }
================================================================================
*/
(function (root) {
'use strict';

/* ---------- seeded randomness: same seed, same agent ---------- */
function makeRng(seed) {
  let s = seed >>> 0 || 1;
  const rng = () => {             // mulberry32
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  rng.state = () => s;
  return rng;
}

/* ---------- a small fully connected network, tanh everywhere ---------- */
class Network {
  constructor(sizes, params) {
    this.sizes = sizes.slice();
    let n = 0;
    for (let k = 1; k < sizes.length; k++) n += sizes[k] * (sizes[k - 1] + 1);
    this.params = params ? Float32Array.from(params) : new Float32Array(n);
    if (this.params.length !== n) throw new Error(`Network expects ${n} parameters, got ${this.params.length}`);
    this.acts = sizes.map(m => new Float32Array(m));
  }
  static paramCount(sizes) { let n = 0; for (let k = 1; k < sizes.length; k++) n += sizes[k] * (sizes[k - 1] + 1); return n; }
  /** Random starting weights, scaled so every layer starts in tanh's useful range. */
  static random(sizes, rng) {
    const net = new Network(sizes);
    let i = 0;
    for (let k = 1; k < sizes.length; k++) {
      const fan = sizes[k - 1], scale = 1 / Math.sqrt(fan);
      for (let j = 0; j < sizes[k]; j++) {
        for (let q = 0; q < fan; q++) net.params[i++] = rng.gauss() * scale;
        net.params[i++] = 0;
      }
    }
    return net;
  }
  /** Runs the network. Returns the output layer (reused between calls; copy it if you keep it). */
  forward(input) {
    const { sizes, params, acts } = this;
    acts[0].set(input);
    let i = 0;
    for (let k = 1; k < sizes.length; k++) {
      const prev = acts[k - 1], cur = acts[k], fan = sizes[k - 1];
      for (let j = 0; j < sizes[k]; j++) {
        let z = 0;
        for (let q = 0; q < fan; q++) z += params[i++] * prev[q];
        cur[j] = Math.tanh(z + params[i++]);
      }
    }
    return acts[acts.length - 1];
  }
}

/* ---------- neuroevolution: try variations of the best brains, keep what works ---------- */
class Evolution {
  /**
   * opts: { sizes, popSize, seed, sigma, eliteFrac, parent (Float32Array, optional) }
   * Every agent has its own seed, so two agents trained on the same task find different solutions.
   */
  constructor(opts) {
    this.sizes = opts.sizes.slice();
    this.popSize = opts.popSize || 48;
    this.eliteFrac = opts.eliteFrac || 0.2;
    this.sigma = opts.sigma || 0.12;
    this.seed = opts.seed >>> 0 || 1;
    // optional: groups of output indices (e.g. legs, arms). Half the mutations then only touch the
    // last-layer weights of one group, so an agent can try new arm moves without wrecking its balance.
    this.outputGroups = opts.outputGroups || null;
    this.rng = makeRng(this.seed);
    this.generation = opts.generation || 0;
    this.history = opts.history ? opts.history.slice() : [];
    this.best = opts.parent ? Float32Array.from(opts.parent) : Network.random(this.sizes, this.rng).params;
    this.bestFitness = -Infinity;
    this.population = this._spawn([this.best]);
  }
  _mutant(parent, sigma) {
    const g = Float32Array.from(parent), r = this.rng;
    if (this.outputGroups && r() < 0.5) {
      const sz = this.sizes, L = sz.length, fan = sz[L - 2] + 1;
      const start = g.length - sz[L - 1] * fan;                       // where the output layer begins
      const group = this.outputGroups[Math.floor(r() * this.outputGroups.length)];
      for (const o of group) for (let q = 0; q < fan; q++) if (r() < 0.3) g[start + o * fan + q] += r.gauss() * sigma;
      return g;
    }
    for (let i = 0; i < g.length; i++) if (r() < 0.25) g[i] += r.gauss() * sigma;
    return g;
  }
  _spawn(elites) {
    const pop = [Float32Array.from(elites[0])];                    // the best is always re-tested unchanged
    for (let i = 1; i < elites.length && pop.length < 3; i++) pop.push(Float32Array.from(elites[i]));
    while (pop.length < this.popSize) {
      const a = elites[Math.floor(this.rng() * elites.length)];
      let child = a;
      if (elites.length > 1 && this.rng() < 0.3) {                   // uniform crossover between two good parents
        const b = elites[Math.floor(this.rng() * elites.length)];
        child = Float32Array.from(a);
        for (let i = 0; i < child.length; i++) if (this.rng() < 0.5) child[i] = b[i];
      }
      // a few big jumps keep the search from getting stuck
      pop.push(this._mutant(child, this.sigma * (this.rng() < 0.15 ? 3 : 1)));
    }
    return pop;
  }
  /** Call with one fitness per member of this.population (same order). */
  tell(fitness) {
    const order = fitness.map((f, i) => i).sort((a, b) => fitness[b] - fitness[a]);
    const nElite = Math.max(2, Math.round(this.popSize * this.eliteFrac));
    const elites = order.slice(0, nElite).map(i => this.population[i]);
    const top = fitness[order[0]];
    const mean = fitness.reduce((s, f) => s + f, 0) / fitness.length;
    this.best = Float32Array.from(elites[0]);
    this.bestFitness = top;
    this.generation++;
    this.history.push([this.generation, +top.toFixed(3), +mean.toFixed(3)]);
    if (this.history.length > 400) this.history = compressHistory(this.history);
    this.population = this._spawn(elites);
    return { generation: this.generation, best: top, mean };
  }
}

function compressHistory(h) {   // keep the first and last points, thin out the middle
  const out = [h[0]];
  for (let i = 1; i < h.length - 100; i += 2) out.push(h[i]);
  return out.concat(h.slice(Math.max(1, h.length - 100)));
}

/* ---------- save / load ---------- */
function toBase64(f32) {
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64');
}
function fromBase64(b64) {
  const s = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
function brainToJSON(b) {
  return {
    format: 'glassbox-body-brain', formatVersion: 1, app: 'Glass Box', exportedAt: new Date().toISOString(),
    name: b.name, bodyPlan: b.bodyPlan, skill: b.skill, sizes: b.sizes, weights: toBase64(b.params),
    generation: b.generation, sigma: b.sigma, seed: b.seed, history: b.history, created: b.created, updated: b.updated,
  };
}
/** Returns { ok: true, brain } or { ok: false, error }. */
function brainFromJSON(j) {
  if (!j || j.format !== 'glassbox-body-brain') return { ok: false, error: 'Not a Glass Box body-brain file.' };
  if (!(j.formatVersion >= 1) || j.formatVersion > 1) return { ok: false, error: `Unsupported formatVersion ${j.formatVersion}.` };
  if (!Array.isArray(j.sizes) || j.sizes.some(n => !(n > 0))) return { ok: false, error: 'Bad layer sizes.' };
  let params;
  try { params = fromBase64(j.weights); } catch (e) { return { ok: false, error: 'Weights are damaged.' }; }
  if (params.length !== Network.paramCount(j.sizes)) return { ok: false, error: 'Weights do not match the layer sizes.' };
  return { ok: true, brain: {
    name: String(j.name || 'Unnamed').slice(0, 40), bodyPlan: j.bodyPlan, skill: j.skill, sizes: j.sizes, params,
    generation: j.generation | 0, sigma: +j.sigma || 0.1, seed: j.seed >>> 0, history: Array.isArray(j.history) ? j.history : [],
    created: j.created, updated: j.updated,
  } };
}

const api = { makeRng, Network, Evolution, brainToJSON, brainFromJSON, toBase64, fromBase64 };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.Brain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
