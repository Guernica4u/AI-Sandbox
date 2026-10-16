/*
================================================================================
 GLASS BOX · VILLAGE  -  village.js
================================================================================
 The first small civilization world: a few agents (the Playground's 3D body,
 its muscles and senses) sharing one MuJoCo world with trees, stones, berry
 bushes and a pond.

 Everything is a real physical object with weight and size, but the rules
 are forgiving, so they don't take forever to discover (the user's rule: hit
 the plank anywhere near the nail and it's nailed):
   - trees: solid hits on the trunk (with a hand, or harder with something
     held) knock sticks loose; enough damage drops a log
   - stones: a stone hitting another stone hard cracks the one that was hit
     into two sharp pieces
   - binding: hold two things in your two hands and keep them pressed
     together for a moment and they stay joined (a stone on a stick acts like
     an axe; nobody tells them it is one)
   - berries: close a hand at a bush with berries and you're holding one;
     bring it to your mouth to eat it. Bushes regrow slowly.
   - water: dip a hand in the pond, bring it to your mouth to drink
   - needs: hunger and thirst grow; starving or parched hurts
   - injuries: hard impacts hurt (the head most); a hurt limb is weaker
     until it heals; health 0 is death
 Fighting isn't coded: bodies and held things can hit each other, and the
 injuries above apply.

 Objects can't be created while MuJoCo runs, so there's a pool of each kind,
 parked far away until needed (then moved into place).
 Needs: ../embodied-2d/vendor/mujoco.js, brain.js, muscle.js, ../playground/body3d.js.
================================================================================
*/
function __villageModule(root) {
'use strict';
const B3 = root.Body3D || (typeof require === 'function' ? require('../playground/body3d.js') : null);
const Brain = root.Brain || (typeof require === 'function' ? require('../embodied-2d/brain.js') : null);
const { DT, SUB, BODY, NM, SENSES } = B3;
const f = v => +(+v).toFixed(4);

/* ---------- the layout ---------- */
const LAYOUT = {
  trees: [[-6, 4], [-8, -3], [5, 7], [8, -5], [-3, 9], [10, 2]].map(([x, y]) => ({ x, y, r: 0.16, h: 3.2 })),
  bushes: [[3, -3], [-4, -6], [6, 3], [-7, 0]].map(([x, y]) => ({ x, y, r: 0.45, berries: 6 })),
  pond: { x: 0, y: -9, r: 2.5 },
  stones: [[1.5, 1.5, 0.07], [2, -1, 0.06], [-2, 2.5, 0.08], [-1.5, -2, 0.05], [3.5, 0.5, 0.06], [-3.2, -1.2, 0.07], [0.5, 4, 0.06], [4.5, -2, 0.08]],
  start: [[0, 0, 0], [1.5, 0.8, 2.6], [-1.2, 1.2, -1.2], [0.6, -1.5, 1.4]],   // agents: x, y, facing
};
const KINDS = {   // pooled object kinds: shape, size (MuJoCo), mass, how many
  stick: { shape: 'capsule', size: [0.02, 0.35], mass: 0.3, pool: 24 },
  log: { shape: 'capsule', size: [0.09, 0.6], mass: 9, pool: 6 },
  stone: { shape: 'sphere', size: [0.06], mass: 0.9, pool: 16 },
  shard: { shape: 'sphere', size: [0.035], mass: 0.18, pool: 16, sharp: true },
  berry: { shape: 'sphere', size: [0.013], mass: 0.006, pool: 30 },
};
const RULES = {
  stickEvery: 25, logAt: 160,           // tree damage (hit speed x weight) per stick knocked loose; for a log
  hitSpeed: 1.5, crackSpeed: 3,         // m/s: a hit counts; stones crack
  bindNear: 0.03, bindTime: 0.8,        // held things pressed this close for this long are joined
  mouth: 0.16, wetFor: 3,               // m from the head that counts as the mouth; s a dipped hand stays wet
  regrow: 60,                           // s per berry regrowing on a bush
  hunger: 1 / 1200, thirst: 1 / 600,    // per second (empty in 20 and 10 minutes)
  hurtAt: 5,                            // m/s of sudden speed change on a body part (a hard impact)
  heal: 1 / 600,                        // health per second while fed and watered
};
const PARK = (k, i) => [300 + k * 3, i * 0.5, 0.2];   // where unused objects wait

/* ---------- the world, as MJCF ---------- */
function villageXML(nAgents) {
  const C = 'contype="3" conaffinity="3"', G = 'contype="1" conaffinity="2"';
  let x = `<mujoco model="glassbox-village"><compiler angle="radian" inertiafromgeom="true"/>
<option timestep="${DT / SUB}" integrator="implicitfast" noslip_iterations="3"/>
<worldbody><light pos="0 0 6" dir="0 0 -1"/><geom name="ground" type="plane" size="400 400 0.1" friction="1.0" ${G}/>`;
  LAYOUT.trees.forEach((t, i) => { x += `<geom name="tree${i}" type="capsule" fromto="${t.x} ${t.y} 0 ${t.x} ${t.y} ${t.h}" size="${t.r}" friction="0.9" ${G}/>`; });
  LAYOUT.bushes.forEach((b, i) => { x += `<geom name="bush${i}" type="sphere" pos="${b.x} ${b.y} ${b.r * 0.7}" size="${b.r}" friction="0.6" ${G}/>`; });
  for (const [k, kd] of Object.entries(KINDS)) for (let i = 0; i < kd.pool; i++) {
    const p = PARK(Object.keys(KINDS).indexOf(k), i), g = kd.shape === 'capsule' ? `type="capsule" fromto="0 0 ${-kd.size[1]} 0 0 ${kd.size[1]}" size="${kd.size[0]}"` : `type="sphere" size="${kd.size[0]}"`;
    x += `<body name="${k}${i}" pos="${p[0]} ${p[1]} ${p[2]}"${kd.shape === 'capsule' ? ' euler="0 1.5708 0"' : ''}><freejoint name="${k}${i}"/><geom ${g} mass="${kd.mass}" friction="1.1" ${C}/></body>`;
  }
  for (let a = 0; a < nAgents; a++) x += B3.bodyXML({ prefix: `a${a}_`, at: LAYOUT.start[a % LAYOUT.start.length] });
  x += '</worldbody><equality>';
  for (let a = 0; a < nAgents; a++) for (const s of ['L', 'R']) x += `<connect name="a${a}_grip${s}" body1="a${a}_fore${s}" body2="stick0" anchor="0 0 0" active="false"/>`;
  for (let w = 0; w < 12; w++) x += `<weld name="bind${w}" body1="stick0" body2="stone0" active="false"/>`;
  return x + '</equality></mujoco>';
}

/* ---------- quaternion helpers (w, x, y, z) ---------- */
const qmul = (a, b) => [a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3], a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2], a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1], a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]];
const qconj = q => [q[0], -q[1], -q[2], -q[3]];
const qrot = (q, v) => qmul(qmul(q, [0, v[0], v[1], v[2]]), qconj(q)).slice(1);

/* ---------- the village ---------- */
class Village {
  /** opts: { agents (how many, default 4), brains: [params per agent] (default: fresh), seed, help (0..1 helping hands) } */
  constructor(mj, opts = {}) {
    this.mj = mj; const n = this.n = opts.agents || 4;
    this.model = mj.MjModel.from_xml_string(villageXML(n)); this.data = new mj.MjData(this.model);
    const m = this.model, d = this.data, id = (t, nm) => mj.mj_name2id(m, t, nm), BODYT = mj.mjtObj.mjOBJ_BODY.value, JNT = mj.mjtObj.mjOBJ_JOINT.value;
    this.rng = Brain.makeRng(opts.seed || 1); this.time = 0; this.events = [];
    // objects: every pooled body, whether it's in use
    this.objects = [];
    for (const [k, kd] of Object.entries(KINDS)) for (let i = 0; i < kd.pool; i++) {
      const b = id(BODYT, k + i), j = id(JNT, k + i);
      this.objects.push({ kind: k, id: b, q: m.jnt_qposadr[j], dq: m.jnt_dofadr[j], shape: kd.shape, size: kd.size, mass: kd.mass, sharp: !!kd.sharp, gone: true, bound: -1 });
    }
    this.byId = {}; for (const o of this.objects) this.byId[o.id] = o;
    this.trees = LAYOUT.trees.map(t => Object.assign({ damage: 0, sticks: 0, felled: false }, t));
    this.bushes = LAYOUT.bushes.map(b => Object.assign({ regrow: 0 }, b));
    this.welds = Array.from({ length: 12 }, (_, w) => ({ eq: id(mj.mjtObj.mjOBJ_EQUALITY.value, 'bind' + w), a: -1, b: -1 }));
    mj.mj_forward(m, d);
    // the starting stones
    LAYOUT.stones.forEach(([x, y, r]) => this.spawn('stone', [x, y, r + 0.005]));
    // the agents: each a body in this world, with needs
    this.agents = [];
    for (let a = 0; a < n; a++) {
      const body = new B3.Body3D(mj, { model: m, data: d, prefix: `a${a}_`, graspables: this.objects, energy: 1e9 });
      body.assist = opts.help !== undefined ? opts.help : 0;
      const params = opts.brains && opts.brains[a] ? opts.brains[a] : B3.freshBrain(Brain.makeRng((opts.seed || 1) * 31 + a));
      this.agents.push({ i: a, name: opts.names ? opts.names[a] : `Agent ${a + 1}`, body, net: new Brain.Network(B3.SIZES, params), input: new Float32Array(SENSES),
        food: 0.8, water: 0.8, health: 1, alive: true, wet: { L: 0, R: 0 }, weak: new Float64Array(NM).fill(1), lastVel: null, bindTimer: 0, hitCool: {}, doing: '' });
    }
    mj.mj_forward(m, d);
    for (const ag of this.agents) ag.body.savePositions();
  }
  /** Put a pooled object of a kind into the world at pos (and turn); returns it, or null if the pool is used up. */
  spawn(kind, pos, quat = [1, 0, 0, 0], vel = null) {
    const o = this.objects.find(x => x.kind === kind && x.gone); if (!o) return null;
    const d = this.data, q = d.qpos, v = d.qvel;
    q[o.q] = pos[0]; q[o.q + 1] = pos[1]; q[o.q + 2] = pos[2]; for (let k = 0; k < 4; k++) q[o.q + 3 + k] = quat[k];
    for (let k = 0; k < 6; k++) v[o.dq + k] = vel && k < 3 ? vel[k] : 0;
    o.gone = false; this.mj.mj_kinematics(this.model, d);   // its position counts right away
    return o;
  }
  /** Take an object out of the world (eaten, broken) and park it. */
  remove(o) {
    for (const ag of this.agents) ag.body.dropObject(o.id);
    this.unbind(o);
    const p = PARK(Object.keys(KINDS).indexOf(o.kind), this.objects.filter(x => x.kind === o.kind).indexOf(o)), q = this.data.qpos, v = this.data.qvel;
    q[o.q] = p[0]; q[o.q + 1] = p[1]; q[o.q + 2] = p[2]; q[o.q + 3] = 1; q[o.q + 4] = 0; q[o.q + 5] = 0; q[o.q + 6] = 0;
    for (let k = 0; k < 6; k++) v[o.dq + k] = 0;
    o.gone = true;
  }
  pos(o) { const x = this.data.xpos; return [x[3 * o.id], x[3 * o.id + 1], x[3 * o.id + 2]]; }
  vel(o) { const v = this.data.qvel; return [v[o.dq], v[o.dq + 1], v[o.dq + 2]]; }
  quat(o) { const x = this.data.xquat; return [x[4 * o.id], x[4 * o.id + 1], x[4 * o.id + 2], x[4 * o.id + 3]]; }
  radius(o) { return o.shape === 'capsule' ? o.size[0] : o.size[0]; }
  /** Join two objects where they are now (a weld that keeps their current relative pose). */
  bind(a, b) {
    const w = this.welds.find(x => x.a < 0); if (!w || a.bound >= 0 && a.bound === b.bound) return false;
    const m = this.model, d = this.data, ed = m.eq_data, n = ed.length / m.neq;
    const pa = this.pos(a), pb = this.pos(b), qa = this.quat(a), qb = this.quat(b);
    const rp = qrot(qconj(qa), [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]]), rq = qmul(qconj(qa), qb);
    m.eq_obj1id[w.eq] = a.id; m.eq_obj2id[w.eq] = b.id;
    for (let k = 0; k < n; k++) ed[w.eq * n + k] = 0;
    ed.set(rp, w.eq * n + 3); ed.set(rq, w.eq * n + 6); ed[w.eq * n + 10] = 1;
    d.eq_active[w.eq] = 1; w.a = a.id; w.b = b.id;
    a.bound = b.bound = this.welds.indexOf(w);
    this.events.push({ t: this.time, text: `${a.kind} and ${b.kind} joined` });
    return true;
  }
  unbind(o) {
    for (const w of this.welds) if (w.a === o.id || w.b === o.id) {
      this.data.eq_active[w.eq] = 0; const other = this.byId[w.a === o.id ? w.b : w.a]; if (other) other.bound = -1; w.a = w.b = -1;
    }
    o.bound = -1;
  }

  /** One brain step for the whole village: every living agent senses and acts, the world moves, then the rules. */
  step() {
    const mj = this.mj, m = this.model, d = this.data;
    for (const ag of this.agents) {
      const b = ag.body;
      if (!ag.alive) { b.relax(); continue; }
      b.sense(ag.input, this.time, ag.task || null);
      b.act(ag.net.forward(ag.input));
      for (let q = 0; q < NM; q++) b.exc[q] *= ag.weak[q];   // a hurt limb can't pull as hard
    }
    for (const ag of this.agents) ag.body.beginStep();
    for (let s = 0; s < SUB; s++) { for (const ag of this.agents) ag.body.substep(); mj.mj_step(m, d); }
    for (const ag of this.agents) { ag.body.endStep(); ag.body.muscles(); }
    this.time += DT;
    this.rules();
  }

  /* ---------- the forgiving rules ---------- */
  rules() {
    const R = RULES, live = this.objects.filter(o => !o.gone);
    // things that can hit: every hand, and everything held
    const strikers = [];
    for (const ag of this.agents) if (ag.alive) for (const sd of ['L', 'R']) {
      const held = ag.body.heldBy(sd), o = held >= 0 ? this.byId[held] : null;
      if (o) strikers.push({ ag, sd, o, p: this.pos(o), v: this.vel(o), r: this.radius(o) + (o.shape === 'capsule' ? o.size[1] : 0), mass: o.mass + this.boundMass(o) });
      else strikers.push({ ag, sd, o: null, p: ag.body.handPos(sd), v: ag.body.partVel('fore' + sd), r: B3.HAND.r, mass: 0.5 });
    }
    // trees: a solid hit on the trunk does damage; damage knocks sticks loose, then a log
    for (const [ti, t] of this.trees.entries()) {
      if (t.felled) continue;
      for (const s of strikers) {
        // nearest point of the striker to the trunk's axis (a capsule-shaped held thing counts along its length)
        const pts = s.o && s.o.shape === 'capsule' ? this.capsulePoints(s.o) : [s.p];
        for (const p of pts) {
          const dx = p[0] - t.x, dy = p[1] - t.y, dist = Math.hypot(dx, dy), into = -(s.v[0] * dx + s.v[1] * dy) / (dist || 1);
          if (dist > t.r + (s.o ? this.radius(s.o) : B3.HAND.r) + 0.04 || p[2] > t.h || into < R.hitSpeed) continue;
          const key = `t${ti}-${s.ag.i}${s.sd}`; if ((s.ag.hitCool[key] || 0) > this.time) continue;
          s.ag.hitCool[key] = this.time + 0.3;
          const dmg = s.mass * into * (s.o && s.o.sharp || this.hasSharp(s.o) ? 2 : 1);
          t.damage += dmg;
          if (!s.o) this.hurt(s.ag, 'fore' + s.sd, into * 0.01);   // punching a tree hurts the hand a little
          while (t.damage >= (t.sticks + 1) * R.stickEvery && t.sticks < 8) {
            t.sticks++;
            const a = this.rng() * Math.PI * 2, h = 1.8 + this.rng() * 1.2;
            this.spawn('stick', [t.x + Math.cos(a) * (t.r + 0.3), t.y + Math.sin(a) * (t.r + 0.3), h], [Math.cos(0.7), Math.sin(0.7), 0, 0]);
            this.events.push({ t: this.time, text: `${s.ag.name} knocked a stick off a tree` });
          }
          if (t.damage >= R.logAt) {
            t.felled = true;
            this.spawn('log', [t.x + 0.5, t.y, 0.12], [Math.cos(0.785), 0, Math.sin(0.785), 0]);
            this.events.push({ t: this.time, text: `${s.ag.name} brought a tree down` });
          }
          break;
        }
      }
    }
    // stones: a stone hitting another stone hard cracks the one that was hit into two sharp pieces
    const stones = live.filter(o => o.kind === 'stone');
    for (let i = 0; i < stones.length; i++) for (let j = i + 1; j < stones.length; j++) {
      const a = stones[i], b = stones[j], pa = this.pos(a), pb = this.pos(b), dd = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
      if (dd > a.size[0] + b.size[0] + 0.015) continue;
      const va = this.vel(a), vb = this.vel(b), rel = Math.hypot(va[0] - vb[0], va[1] - vb[1], va[2] - vb[2]);
      if (rel < R.crackSpeed) continue;
      const hit = Math.hypot(...va) > Math.hypot(...vb) ? b : a, at = this.pos(hit);
      this.remove(hit);
      this.spawn('shard', [at[0] + 0.04, at[1], at[2] + 0.02]); this.spawn('shard', [at[0] - 0.04, at[1], at[2] + 0.02]);
      this.events.push({ t: this.time, text: 'a stone cracked into sharp pieces' });
    }
    for (const ag of this.agents) if (ag.alive) this.agentRules(ag);
    // bushes regrow
    for (const bu of this.bushes) if (bu.berries < 6 && (bu.regrow += DT) >= R.regrow) { bu.regrow = 0; bu.berries++; }
  }
  agentRules(ag) {
    const R = RULES, b = ag.body, head = b.pose('head').pos, hold = { L: b.heldBy('L'), R: b.heldBy('R') };
    ag.doing = '';
    for (const sd of ['L', 'R']) {
      const hp = b.handPos(sd);
      // picking a berry: a closing hand at a bush that has berries
      if (b.gripCmd && hold[sd] < 0) for (const bu of this.bushes) {
        if (bu.berries > 0 && Math.hypot(hp[0] - bu.x, hp[1] - bu.y, hp[2] - bu.r * 0.7) < bu.r + 0.12) {
          if (this.spawn('berry', hp)) { bu.berries--; ag.doing = 'picked a berry'; }
          break;
        }
      }
      // eating: something edible held at the mouth
      const o = hold[sd] >= 0 ? this.byId[hold[sd]] : null;
      if (o && o.kind === 'berry' && Math.hypot(hp[0] - head[0], hp[1] - head[1], hp[2] - head[2]) < R.mouth + 0.05) {
        this.remove(o); ag.food = Math.min(1, ag.food + 0.12); ag.doing = 'ate a berry'; this.events.push({ t: this.time, text: `${ag.name} ate a berry` });
      }
      // drinking: a hand dipped in the pond, then brought to the mouth
      const pd = LAYOUT.pond;
      if (Math.hypot(hp[0] - pd.x, hp[1] - pd.y) < pd.r && hp[2] < 0.15) ag.wet[sd] = R.wetFor;
      else ag.wet[sd] = Math.max(0, ag.wet[sd] - DT);
      if (ag.wet[sd] > 0 && Math.hypot(hp[0] - head[0], hp[1] - head[1], hp[2] - head[2]) < R.mouth) {
        ag.wet[sd] = 0; ag.water = Math.min(1, ag.water + 0.15); ag.doing = 'drank'; this.events.push({ t: this.time, text: `${ag.name} drank from the pond` });
      }
    }
    // binding: the two hands hold two different things, pressed together for a moment
    const a = hold.L >= 0 ? this.byId[hold.L] : null, c = hold.R >= 0 ? this.byId[hold.R] : null;
    if (a && c && a !== c && (a.bound < 0 || a.bound !== c.bound) && this.gap(a, c) < R.bindNear) {
      ag.bindTimer += DT;
      if (ag.bindTimer >= R.bindTime) { this.bind(a, c); ag.bindTimer = 0; ag.doing = `joined ${a.kind} and ${c.kind}`; }
    } else ag.bindTimer = 0;
    // needs
    ag.food = Math.max(0, ag.food - R.hunger * DT); ag.water = Math.max(0, ag.water - R.thirst * DT);
    if (ag.food <= 0) ag.health -= 0.01 * DT;
    if (ag.water <= 0) ag.health -= 0.02 * DT;
    // injuries: a sudden change of speed on a part is an impact
    const parts = BODY.parts, v = b.vel;
    if (ag.lastVel) for (const p of parts) {
      const k = 3 * b.ids[p.id], dv = Math.hypot(v[k] - ag.lastVel[k], v[k + 1] - ag.lastVel[k + 1], v[k + 2] - ag.lastVel[k + 2]);
      if (dv > R.hurtAt) this.hurt(ag, p.id, (dv - R.hurtAt) * (p.id === 'head' ? 0.08 : 0.03));
    }
    ag.lastVel = Float64Array.from(v);
    // healing, slowly, while fed and watered
    if (ag.food > 0.2 && ag.water > 0.2) { ag.health = Math.min(1, ag.health + R.heal * DT); for (let q = 0; q < NM; q++) ag.weak[q] = Math.min(1, ag.weak[q] + R.heal * DT); }
    if (ag.health <= 0) { ag.health = 0; ag.alive = false; b.relax(); for (const sd of ['L', 'R']) b.hold[sd] = null; this.events.push({ t: this.time, text: `${ag.name} died` }); }
  }
  /** An injury: health goes down, and that part's muscles get weaker until it heals. */
  hurt(ag, partId, amount) {
    if (amount <= 0) return;
    ag.health -= amount;
    const joints = BODY.joints.map((j, i) => [j, i]).filter(([j]) => j.body === partId || BODY.parts.find(p => p.id === j.body).parent === partId);
    for (const [, i] of joints) { ag.weak[2 * i] = Math.max(0.3, ag.weak[2 * i] - amount * 2); ag.weak[2 * i + 1] = Math.max(0.3, ag.weak[2 * i + 1] - amount * 2); }
    if (amount > 0.02) this.events.push({ t: this.time, text: `${ag.name} got hurt (${partId.replace(/[LR]$/, '')})` });
  }
  boundMass(o) { let mass = 0; for (const w of this.welds) if (w.a === o.id || w.b === o.id) mass += this.byId[w.a === o.id ? w.b : w.a].mass; return mass; }
  hasSharp(o) { if (!o) return false; for (const w of this.welds) if ((w.a === o.id || w.b === o.id) && this.byId[w.a === o.id ? w.b : w.a].sharp) return true; return false; }
  /** Points along a capsule-shaped object (to find what part of it touches something). */
  capsulePoints(o) {
    const p = this.pos(o), m = this.data.xmat, k = 9 * o.id, ax = [m[k + 2], m[k + 5], m[k + 8]], h = o.size[1];
    return [-1, -0.5, 0, 0.5, 1].map(t => [p[0] + ax[0] * h * t, p[1] + ax[1] * h * t, p[2] + ax[2] * h * t]);
  }
  /** Gap between two objects' surfaces (roughly). */
  gap(a, b) {
    const pa = a.shape === 'capsule' ? this.capsulePoints(a) : [this.pos(a)], pb = b.shape === 'capsule' ? this.capsulePoints(b) : [this.pos(b)];
    let best = Infinity; for (const x of pa) for (const y of pb) best = Math.min(best, Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]));
    return best - this.radius(a) - this.radius(b);
  }
  free() { for (const ag of this.agents) ag.body.free(); this.data.delete(); this.model.delete(); }
}

const api = { LAYOUT, KINDS, RULES, villageXML, Village };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.Village = api;
}
__villageModule(typeof globalThis !== 'undefined' ? globalThis : this);
