/*
================================================================================
 GLASS BOX · PLAYGROUND  -  learn.js
================================================================================
 Learning from experience, moment by moment (reinforcement learning, "PPO").

 Evolution only learns once per generation, from a total score. Here the brain
 learns from every moment: it tries its moves with a little randomness, a second
 small network (the "critic") guesses how well things are going from each moment
 on, and the brain is nudged toward the moves that turned out better than the
 critic expected. This is how simulated bodies learn to move like people in
 research (DeepMimic, AMP, and muscle-driven versions of them).

 The brain itself stays an ordinary Glass Box brain (Brain.Network, same senses,
 same 63 outputs), so every page can play it unchanged. During practice the
 outputs get a little random wobble on top (its size is learned too); when it
 performs, it uses its best guess without wobble.

 Pieces: MLP (a network that can learn by gradients), Env (one body practising a
 task), rollout/gradient helpers the trainer runs on every CPU core, Adam.
================================================================================
*/
function __learnModule(root) {
'use strict';
const Brain = root.Brain || (typeof require === 'function' ? require('../embodied-2d/brain.js') : null);
const B3 = root.Body3D || (typeof require === 'function' ? require('./body3d.js') : null);
const LOG2PI = Math.log(2 * Math.PI);

/* ---------- a network that can learn by gradients (same weight layout as Brain.Network) ---------- */
class MLP {
  /** out: 'tanh' (the brain) or 'linear' (the critic). Hidden layers are always tanh. */
  constructor(sizes, params, out = 'tanh') {
    this.sizes = sizes.slice(); this.out = out;
    this.n = Brain.Network.paramCount(sizes);
    this.params = params ? Float32Array.from(params) : new Float32Array(this.n);
    this.offs = []; let o = 0; for (let k = 1; k < sizes.length; k++) { this.offs[k] = o; o += sizes[k] * (sizes[k - 1] + 1); }
    this.acts = sizes.map(m => new Float32Array(m)); this.d = sizes.map(m => new Float32Array(m));
  }
  static random(sizes, rng, out = 'tanh', lastScale = 1) {
    const net = new MLP(sizes, null, out);
    for (let k = 1; k < sizes.length; k++) {
      const fan = sizes[k - 1], s = (k === sizes.length - 1 ? lastScale : 1) / Math.sqrt(fan);
      for (let j = 0; j < sizes[k]; j++) { const row = net.offs[k] + j * (fan + 1); for (let q = 0; q < fan; q++) net.params[row + q] = rng.gauss() * s; net.params[row + fan] = 0; }
    }
    return net;
  }
  forward(x) {
    const { sizes, params, acts, offs } = this, L = sizes.length;
    acts[0].set(x);
    for (let k = 1; k < L; k++) {
      const prev = acts[k - 1], cur = acts[k], fan = sizes[k - 1], lin = k === L - 1 && this.out === 'linear';
      let i = offs[k];
      for (let j = 0; j < sizes[k]; j++) {
        let z = params[i + fan];
        for (let q = 0; q < fan; q++) z += params[i + q] * prev[q];
        cur[j] = lin ? z : Math.tanh(z); i += fan + 1;
      }
    }
    return acts[L - 1];
  }
  /** After forward(x): adds d(loss)/d(params) into grad, given d(loss)/d(output). */
  backward(dOut, grad) {
    const { sizes, params, acts, offs, d } = this, L = sizes.length;
    d[L - 1].set(dOut);
    for (let k = L - 1; k >= 1; k--) {
      const cur = acts[k], prev = acts[k - 1], dc = d[k], fan = sizes[k - 1], lin = k === L - 1 && this.out === 'linear', dp = d[k - 1];
      if (k > 1) dp.fill(0);
      let i = offs[k];
      for (let j = 0; j < sizes[k]; j++) {
        const dz = lin ? dc[j] : dc[j] * (1 - cur[j] * cur[j]);
        if (dz !== 0) {
          for (let q = 0; q < fan; q++) grad[i + q] += dz * prev[q];
          grad[i + fan] += dz;
          if (k > 1) for (let q = 0; q < fan; q++) dp[q] += dz * params[i + q];
        }
        i += fan + 1;
      }
    }
  }
}

/* ---------- Adam: a step size for every weight ---------- */
class Adam {
  constructor(n, lr = 3e-4) { this.m = new Float32Array(n); this.v = new Float32Array(n); this.t = 0; this.lr = lr; }
  step(params, grad, lr = this.lr) {
    this.t++; const b1 = 0.9, b2 = 0.999, c1 = 1 - Math.pow(b1, this.t), c2 = 1 - Math.pow(b2, this.t), m = this.m, v = this.v;
    for (let i = 0; i < params.length; i++) {
      const g = grad[i]; m[i] = b1 * m[i] + (1 - b1) * g; v[i] = b2 * v[i] + (1 - b2) * g * g;
      params[i] -= lr * (m[i] / c1) / (Math.sqrt(v[i] / c2) + 1e-8);
    }
  }
}

/* ---------- one body practising: it keeps going across rollouts and restarts itself when it falls ---------- */
const REWARDS = {
  /** Standing: being up is good; staying upright, near where it started, and not wasting energy is better. */
  stand(env) {
    const b = env.body, p = b.pose('pelvis').pos, drift2 = (p[0] - env.start[0]) ** 2 + (p[1] - env.start[1]) ** 2;
    return 0.5 + 0.2 * Math.exp(-10 * b.lean() ** 2) + 0.2 * Math.exp(-drift2 / 0.02) + 0.1 * Math.exp(-Math.max(0, b.power - 150) / 600);
  },
};
/* ---------- a human example to copy (a clip from mocap/clips.js) ----------
   Walking and running are repeated: the clip's best-matching stretch (where the pose at the end is closest to the
   pose at the start, about a stride pair long) is looped, moving on by one stride pair each time round. Other clips
   play once. */
const CLIP_INTENT = { walk: 'walk', walk2: 'walk', run: 'walk', jump: 'jump' };
class Reference {
  constructor(clip, loop) {
    this.fps = clip.fps; this.q = clip.qpos; this.n = this.q.length; this.loop = !!loop;
    const NQ = this.q[0].length;
    if (this.loop) {
      let best = Infinity;
      for (let L = Math.round(0.8 * this.fps); L <= Math.min(this.n - 1, Math.round(1.6 * this.fps)); L++) for (let s0 = 0; s0 + L < this.n; s0++) {
        const A = this.q[s0], B = this.q[s0 + L]; let d = 5 * (A[2] - B[2]) ** 2;
        for (let k = 7; k < NQ; k++) d += (A[k] - B[k]) ** 2;
        for (let k = 3; k < 7; k++) d += 2 * (A[k] - B[k]) ** 2;
        d += 0.002 * Math.abs(L - this.fps);   // among equally good loops, about a second long
        if (d < best) { best = d; this.s0 = s0; this.L = L; }
      }
      this.shift = [this.q[this.s0 + this.L][0] - this.q[this.s0][0], this.q[this.s0 + this.L][1] - this.q[this.s0][1]];
      this.loopError = best;
    } else { this.s0 = 0; this.L = this.n - 1; this.shift = [0, 0]; }
    this.period = this.L / this.fps;
    this.out = new Float64Array(NQ); this.tmp = new Float64Array(NQ);
  }
  get length() { return this.loop ? Infinity : this.period; }
  /** The pose at time t (s) into the example (MuJoCo qpos, the pelvis starting at x = y = 0). */
  pose(t, out = this.out) {
    const k = this.loop ? Math.floor(t / this.period) : 0, u = Math.max(0, Math.min(this.period, t - k * this.period)) * this.fps;
    const i = Math.min(this.L - 1, Math.floor(u)), w = u - i, A = this.q[this.s0 + i], B = this.q[this.s0 + i + 1], O = this.q[this.s0];
    for (let j = 0; j < A.length; j++) out[j] = A[j] + (B[j] - A[j]) * w;
    out[0] += k * this.shift[0] - O[0]; out[1] += k * this.shift[1] - O[1];
    let n = 0; for (let j = 3; j < 7; j++) n += out[j] * out[j]; n = Math.sqrt(n); for (let j = 3; j < 7; j++) out[j] /= n;
    return out;
  }
  /** Joint speeds and pelvis speed at time t (from nearby poses; the turn's entries are not speeds). */
  vel(t, out) {
    const h = 1 / this.fps, a = Float64Array.from(this.pose(Math.max(0, t - h / 2), this.tmp)), b = this.pose(t + h / 2, this.tmp);
    for (let j = 0; j < a.length; j++) out[j] = (b[j] - a[j]) / h;
    return out;
  }
  /** Where in the example it is, 0..1 (the brain's rhythm sense follows it). */
  phase(t) { return this.loop ? (t / this.period) % 1 : Math.min(1, t / this.period); }
}
let CLIPS = null;
const clips = () => CLIPS || (CLIPS = root.MOCAP_CLIPS || (typeof require === 'function' ? require('./mocap/clips.js') : {}));

class Env {
  /** cfg: { taskId, stage, seconds, seed, assist, clip (an example to copy: 'walk', 'run', 'jump'...) } */
  constructor(mj, cfg) {
    this.mj = mj; this.cfg = { taskId: 'stand', stage: 0, seconds: 8 }; for (const k in cfg) if (cfg[k] !== undefined) this.cfg[k] = cfg[k];
    this.model = mj.MjModel.from_xml_string(B3.worldXML());
    this.rng = Brain.makeRng(cfg.seed || 1); this.obs = new Float32Array(B3.SENSES); this.body = null;
    if (this.cfg.clip) {
      const c = clips()[this.cfg.clip]; if (!c) throw new Error('no example clip ' + this.cfg.clip);
      this.ref = new Reference(c, this.cfg.clip !== 'jump');
      this.refData = new mj.MjData(this.model); this.refQ = new Float64Array(c.qpos[0].length); this.refV = new Float64Array(c.qpos[0].length);
    }
    this.reset();
  }
  setStage(stage) { this.cfg.stage = stage; }
  reset() {
    if (this.body) this.body.free();
    const st = this.cfg.stage; this.hard = this.ref ? 0 : B3.hardness(st); this.noise = 0.02 * this.hard;
    this.task = B3.TASKS[this.cfg.taskId];
    this.body = new B3.Body3D(this.mj, { model: this.model, energy: this.task.energy * (1 + 4 * (1 - this.hard)) });
    this.body.assist = this.cfg.assist !== undefined ? this.cfg.assist : this.ref ? 0 : B3.assistFor(st);
    const V = this.body.views();
    if (this.ref) {   // start somewhere in the example, already in its pose and moving with it (as in DeepMimic)
      const t0 = this.ref.loop ? this.rng() * this.ref.period : this.rng() * Math.max(0.01, this.ref.period - 0.6);
      this.refT = t0; this.body.intent = CLIP_INTENT[this.cfg.clip] || null;
      const q = this.ref.pose(t0), v = this.ref.vel(t0, this.refV);
      V.qpos.set(q); V.qvel.fill(0); V.qvel[0] = v[0]; V.qvel[1] = v[1]; V.qvel[2] = v[2];
      for (const j of this.body.joints) V.qvel[j.dq] = v[j.q];
      this.mj.mj_forward(this.model, this.body.data); this.body.savePositions();
      for (let k = 0; k < 400; k++) for (let m = 0; m < B3.NM; m++) this.body.mus[m].step(0.1, V.qpos[this.body.jq[m >> 1]], 1 / 400);
    } else {
      const push = (this.rng() * 2 - 1) * 0.3 * this.hard, dir = this.rng() * Math.PI * 2;
      V.qvel[0] += Math.cos(dir) * push; V.qvel[1] += Math.sin(dir) * push;
    }
    this.st = this.task.setup(this.body, this); this.steps = 0; this.time = 0; this.ret = 0;
    this.start = this.body.pose('pelvis').pos;
    this.observe();
  }
  observe() {
    // copying an example, the rhythm sense follows the example (where in the stride it is) instead of the clock
    this.body.sense(this.obs, this.ref ? this.ref.phase(this.refT) : this.time, this.ref ? null : this.task.senseTask(this.st, this.body));
    if (this.noise) for (let i = 0; i < this.obs.length; i++) this.obs[i] += (this.rng() - 0.5) * 2 * this.noise;
    return this.obs;
  }
  /** How closely the body matches the example right now: pose, joint speeds, hands and feet, where the hips are
      (weights as in DeepMimic), plus a little for not wasting energy. Also: how far the hips are from the example's. */
  imitation() {
    const b = this.body, V = b.views(), mj = this.mj, q = this.ref.pose(this.refT, this.refQ), v = this.ref.vel(this.refT, this.refV);
    let dp = 0, dv = 0;
    for (const j of b.joints) { dp += (V.qpos[j.q] - q[j.q]) ** 2; dv += (V.qvel[j.dq] - v[j.q]) ** 2; }
    let dot = 0; for (let k = 3; k < 7; k++) dot += V.qpos[k] * q[k];
    const turn = 2 * Math.acos(Math.min(1, Math.abs(dot))); dp += turn * turn;
    const rd = this.refData; rd.qpos.set(q); mj.mj_kinematics(this.model, rd);
    const xp = V.xpos, rx = rd.xpos, pel = 3 * b.ids.pelvis; let de = 0;
    for (const part of ['footL', 'footR', 'foreL', 'foreR', 'head']) {
      const k = 3 * b.ids[part]; for (let a = 0; a < 3; a++) de += ((xp[k + a] - xp[pel + a]) - (rx[k + a] - rx[pel + a])) ** 2;
    }
    const dc = (V.qpos[0] - q[0]) ** 2 + (V.qpos[1] - q[1]) ** 2 + (V.qpos[2] - q[2]) ** 2;
    const r = 0.5 * Math.exp(-2 * dp) + 0.05 * Math.exp(-0.1 * dv) + 0.15 * Math.exp(-40 * de) + 0.2 * Math.exp(-10 * dc) + 0.1 * Math.exp(-Math.max(0, b.power - 150) / 600);
    return { r, off: Math.sqrt(dc), headLow: xp[3 * b.ids.head + 2] < rx[3 * b.ids.head + 2] - 0.35, pose: Math.exp(-2 * dp) };
  }
  /** One brain step. Returns { r, done (fell), trunc (time up) }; observe() is then the next moment's senses. */
  step(action) {
    const b = this.body;
    b.act(action); if (!this.ref) this.task.step(this.st, b, this); b.step(); b.muscles();
    this.steps++; this.time += B3.DT;
    let r, fell;
    if (this.ref) {
      this.refT += B3.DT;
      const m = this.imitation(); fell = m.off > 0.5 || m.headLow; r = fell ? 0 : m.r;   // fell, or lost the example
      this.lastMatch = m.pose; b.fallen = fell;
    } else { fell = b.checkFallen(); r = fell ? 0 : REWARDS[this.cfg.taskId](this); }
    this.ret += r;
    this.observe();
    const end = this.steps >= Math.round(this.cfg.seconds / B3.DT) || (this.ref && this.refT >= this.ref.length);
    return { r, done: fell, trunc: !fell && end };
  }
  free() { if (this.body) this.body.free(); this.body = null; if (this.refData) this.refData.delete(); this.refData = null; if (this.model) this.model.delete(); this.model = null; }
}

/* ---------- what each CPU core does ---------- */
const GAMMA = 0.97, LAMBDA = 0.95, CLIP = 0.2;
/** A worker's practice: E bodies for T steps each with the current brain plus wobble. Keeps the data for gradients. */
class Practice {
  constructor(mj, opts) {
    this.mj = mj; this.E = opts.envs || 2; this.T = opts.steps || 512;
    this.envs = Array.from({ length: this.E }, (_, e) => new Env(mj, { taskId: opts.taskId, stage: opts.stage || 0, seed: (opts.seed || 1) * 1000 + e + 1, seconds: opts.seconds, assist: opts.assist, clip: opts.clip }));
    this.rng = Brain.makeRng((opts.seed || 1) * 7 + 3);
    const N = this.E * this.T, S = B3.SENSES, A = B3.MOTORS;
    this.obs = new Float32Array(N * S); this.act = new Float32Array(N * A); this.logp = new Float32Array(N);
    this.adv = new Float32Array(N); this.ret = new Float32Array(N); this.val = new Float32Array(N);
  }
  /** msg: { policy, logstd, value, valueSizes, stage } → stats */
  rollout(msg) {
    const S = B3.SENSES, A = B3.MOTORS, E = this.E, T = this.T, rng = this.rng;
    const pol = new MLP(B3.SIZES, msg.policy, 'tanh'), val = new MLP(msg.valueSizes, msg.value, 'linear'), ls = msg.logstd;
    const sd = Float32Array.from(ls, Math.exp), a = new Float32Array(A);
    const rew = new Float32Array(E * T), done = new Uint8Array(E * T), vnext = new Float32Array(E);
    const episodes = [];
    for (const env of this.envs) if (env.cfg.stage !== msg.stage) { env.setStage(msg.stage); }
    for (let t = 0; t < T; t++) for (let e = 0; e < E; e++) {
      const env = this.envs[e], k = e * T + t;   // stored per body, in time order
      this.obs.set(env.obs, k * S);
      const mu = pol.forward(env.obs);
      let lp = 0;
      for (let i = 0; i < A; i++) { const n = rng.gauss(); a[i] = mu[i] + sd[i] * n; lp += -0.5 * n * n - ls[i] - 0.5 * LOG2PI; }
      this.act.set(a, k * A); this.logp[k] = lp; this.val[k] = val.forward(this.obs.subarray(k * S, (k + 1) * S))[0];
      const res = env.step(a);
      let r = res.r;
      if (res.trunc) r += GAMMA * val.forward(env.obs)[0];   // time's up, not a fall: it would have kept earning
      rew[k] = r; done[k] = res.done || res.trunc ? 1 : 0;
      if (done[k]) { episodes.push({ ret: env.ret, secs: env.time, ok: !res.done }); env.reset(); }
    }
    for (let e = 0; e < E; e++) vnext[e] = val.forward(this.envs[e].obs)[0];
    // advantages: how much better each moment went than the critic expected (GAE)
    let sum = 0, sum2 = 0;
    for (let e = 0; e < E; e++) {
      let gae = 0;
      for (let t = T - 1; t >= 0; t--) {
        const k = e * T + t, nv = done[k] ? 0 : t === T - 1 ? vnext[e] : this.val[k + 1];
        const delta = rew[k] + GAMMA * nv - this.val[k];
        gae = delta + (done[k] ? 0 : GAMMA * LAMBDA * gae);
        this.adv[k] = gae; this.ret[k] = gae + this.val[k]; sum += gae; sum2 += gae * gae;
      }
    }
    const meanR = rew.reduce((s, x) => s + x, 0) / rew.length;
    return { n: E * T, advSum: sum, advSum2: sum2, episodes, meanR };
  }
  /** Gradients for this worker's share of one minibatch. msg: { policy, logstd, value, valueSizes, advMean, advStd, epochSeed, k, K, entropy } */
  grad(msg) {
    const S = B3.SENSES, A = B3.MOTORS, N = this.E * this.T;
    if (this.permSeed !== msg.epochSeed) {   // a fresh shuffle each epoch
      const r = Brain.makeRng(msg.epochSeed); this.perm = Int32Array.from({ length: N }, (_, i) => i);
      for (let i = N - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)), t = this.perm[i]; this.perm[i] = this.perm[j]; this.perm[j] = t; }
      this.permSeed = msg.epochSeed;
    }
    const pol = new MLP(B3.SIZES, msg.policy, 'tanh'), val = new MLP(msg.valueSizes, msg.value, 'linear'), ls = msg.logstd;
    const gp = new Float32Array(pol.n), gls = new Float32Array(A), gv = new Float32Array(val.n), dmu = new Float32Array(A), dv = new Float32Array(1);
    const iv = Float32Array.from(ls, x => Math.exp(-2 * x));
    const lo = Math.floor(msg.k * N / msg.K), hi = Math.floor((msg.k + 1) * N / msg.K);
    let kl = 0, clipped = 0, vloss = 0;
    for (let s = lo; s < hi; s++) {
      const k = this.perm[s], o = this.obs.subarray(k * S, (k + 1) * S), act = this.act.subarray(k * A, (k + 1) * A);
      const mu = pol.forward(o);
      let lp = 0; for (let i = 0; i < A; i++) { const z = act[i] - mu[i]; lp += -0.5 * z * z * iv[i] - ls[i] - 0.5 * LOG2PI; }
      const ratio = Math.exp(lp - this.logp[k]), adv = (this.adv[k] - msg.advMean) / msg.advStd;
      kl += this.logp[k] - lp;
      const cut = (adv > 0 && ratio > 1 + CLIP) || (adv < 0 && ratio < 1 - CLIP);
      if (cut) clipped++;
      const c = cut ? 0 : ratio * adv;   // loss = −min(ratio·A, clip(ratio)·A)
      for (let i = 0; i < A; i++) { const z = act[i] - mu[i]; dmu[i] = -c * z * iv[i]; gls[i] += -c * (z * z * iv[i] - 1) - msg.entropy; }
      if (c !== 0) pol.backward(dmu, gp);
      const v = val.forward(o)[0], err = v - this.ret[k]; dv[0] = err; vloss += 0.5 * err * err;
      val.backward(dv, gv);
    }
    return { count: hi - lo, gp, gls, gv, kl, clipped, vloss };
  }
  free() { for (const e of this.envs) e.free(); }
}

/* ---------- the trainer's state: brain, wobble, critic, their optimisers ---------- */
const VALUE_SIZES = [B3.SENSES, 128, 128, 1];
function newLearner(opts = {}) {
  const rng = Brain.makeRng(opts.seed || 1);
  const policy = opts.policy ? Float32Array.from(opts.policy) : B3.freshBrain(rng);
  const value = opts.value ? Float32Array.from(opts.value) : MLP.random(VALUE_SIZES, rng, 'linear', 0.1).params;
  const logstd = opts.logstd ? Float32Array.from(opts.logstd) : new Float32Array(B3.MOTORS).fill(Math.log(0.3));
  return { policy, value, logstd, stage: opts.stage || 0, iteration: opts.iteration || 0, samples: opts.samples || 0,
    optP: new Adam(policy.length + logstd.length, opts.lr || 3e-4), optV: new Adam(value.length, opts.lrV || 1e-3), history: opts.history || [] };
}
/** Sum the workers' gradient shares, keep the step sensible (norm clipping), update. */
function applyGrads(L, parts, maxNorm = 0.5) {
  const n = parts.reduce((s, p) => s + p.count, 0);
  const gP = new Float32Array(L.policy.length + L.logstd.length), gV = new Float32Array(L.value.length);
  for (const p of parts) { for (let i = 0; i < p.gp.length; i++) gP[i] += p.gp[i]; for (let i = 0; i < p.gls.length; i++) gP[L.policy.length + i] += p.gls[i]; for (let i = 0; i < p.gv.length; i++) gV[i] += p.gv[i]; }
  const scale = (g, max) => { let s = 0; for (let i = 0; i < g.length; i++) { g[i] /= n; s += g[i] * g[i]; } s = Math.sqrt(s); if (s > max) for (let i = 0; i < g.length; i++) g[i] *= max / s; return s; };
  const normP = scale(gP, maxNorm), normV = scale(gV, maxNorm * 10);
  const both = new Float32Array(gP.length); both.set(L.policy); both.set(L.logstd, L.policy.length);
  L.optP.step(both, gP); L.policy.set(both.subarray(0, L.policy.length)); L.logstd.set(both.subarray(L.policy.length));
  for (let i = 0; i < L.logstd.length; i++) L.logstd[i] = Math.max(Math.log(0.03), Math.min(Math.log(0.6), L.logstd[i]));
  L.optV.step(L.value, gV);
  return { n, normP, normV, kl: parts.reduce((s, p) => s + p.kl, 0) / n, clip: parts.reduce((s, p) => s + p.clipped, 0) / n, vloss: parts.reduce((s, p) => s + p.vloss, 0) / n };
}
/** A brain file (the same kind the pages use) plus what's needed to keep practising. */
function learnerToJSON(L, extra = {}) {
  return Object.assign({ method: 'ppo', bodyPlan: B3.BODY.id, sizes: B3.SIZES, skill: 'stand', generation: L.iteration, stage: L.stage, samples: L.samples,
    params: Array.from(L.policy), logstd: Array.from(L.logstd), valueSizes: VALUE_SIZES, value: Array.from(L.value), history: L.history }, extra);
}

const api = { MLP, Adam, Env, Reference, REWARDS, Practice, VALUE_SIZES, newLearner, applyGrads, learnerToJSON, GAMMA, LAMBDA, CLIP };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.Learn = api;
}
__learnModule(typeof globalThis !== 'undefined' ? globalThis : this);
