/*
 Fits the human recordings in projects/playground/mocap/cmu onto our body and writes
 projects/playground/mocap/clips.js (loaded by the page as a plain script, so it works from file:// too).
   node projects/playground/tools/retarget.js
*/
'use strict';
const fs = require('fs'), path = require('path');
const D = path.join(__dirname, '..');
const CLIPS = [
  { id: 'walk', label: 'Walk', file: '02_01.amc', note: 'CMU subject 2, trial 1: walk' },
  { id: 'walk2', label: 'Walk (2)', file: '02_02.amc', note: 'CMU subject 2, trial 2: walk' },
  { id: 'run', label: 'Run', file: '02_03.amc', note: 'CMU subject 2, trial 3: run/jog' },
  { id: 'jump', label: 'Jump and balance', file: '02_04.amc', note: 'CMU subject 2, trial 4: jump, balance' },
];
require('../../embodied-2d/tools/node-env.js').load().then(({ mj }) => {
  globalThis.Body3D = require('../body3d.js');
  const M = require('../mocap.js');
  const bones = M.parseASF(fs.readFileSync(path.join(D, 'mocap/cmu/02.asf'), 'utf8'));
  const out = {};
  for (const c of CLIPS) {
    const t0 = Date.now(), frames = M.parseAMC(fs.readFileSync(path.join(D, 'mocap/cmu', c.file), 'utf8'));
    const clip = M.retarget(mj, bones, frames, { fps: 30 });
    out[c.id] = { label: c.label, source: c.note, fps: clip.fps, scale: clip.scale, qpos: clip.qpos };
    console.log(`${c.id}: ${clip.qpos.length} poses (${(clip.qpos.length / clip.fps).toFixed(1)} s) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  const head = `/* Human movement examples for the Playground, fitted onto our body by tools/retarget.js (do not edit by hand).
   Source: CMU Graphics Lab Motion Capture Database, mocap.cs.cmu.edu (free to use, modify and redistribute).
   Each clip: poses 30 times a second; each pose is MuJoCo's qpos (pelvis x y z, pelvis turn w x y z, 31 joint angles). */\n`;
  fs.writeFileSync(path.join(D, 'mocap/clips.js'), head + `(function (root) { root.MOCAP_CLIPS = ${JSON.stringify(out)}; })(typeof globalThis !== 'undefined' ? globalThis : this);\nif (typeof module !== 'undefined' && module.exports) module.exports = globalThis.MOCAP_CLIPS;\n`);
  console.log('wrote mocap/clips.js', (fs.statSync(path.join(D, 'mocap/clips.js')).size / 1024).toFixed(0), 'KB');
});
