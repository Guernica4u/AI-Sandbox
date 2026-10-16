/*
 Fits the human recordings in projects/playground/mocap/cmu onto our body.
   node projects/playground/tools/retarget.js [clipId ...]   fit these (default: all) -> mocap/fitted/<id>.json
   node projects/playground/tools/retarget.js --combine      gather mocap/fitted/*.json -> mocap/clips.js
 clips.js is loaded by the page as a plain script, so it works from file:// too.
*/
'use strict';
const fs = require('fs'), path = require('path');
const D = path.join(__dirname, '..');
// id, label, CMU trial, loops (repeats a stride), what it's for, { from, to } seconds to keep. All from mocap.cs.cmu.edu (free to use and share).
const CLIPS = [
  ['stand', 'Stand still', '82_08', false, 'everyday', { to: 7.5 }],   // then the person walks off
  ['walk', 'Walk', '02_01', true, 'everyday'],
  ['walk2', 'Walk (2)', '02_02', true, 'everyday'],
  ['run', 'Run', '02_03', true, 'everyday'],
  ['navigate', 'Walk forward, backward, sideways', '09_12', false, 'everyday'],
  ['jump', 'Jump and balance', '02_04', false, 'everyday'],
  ['hop', 'Jump and hop on one foot', '49_02', false, 'everyday'],
  ['balance', 'Balance on one leg', '49_18', false, 'everyday'],
  ['getup', 'Lie down and get up', '77_16', false, 'everyday'],
  ['getup2', 'Lie on the back and get up', '77_18', false, 'everyday'],
  ['reach', 'Reach up, tiptoe, jump to grab', '13_10', false, 'everyday'],
  ['pickup', 'Bend and pick up', '26_09', false, 'work'],
  ['lift', 'Bend and lift', '26_10', false, 'work'],
  ['carry', 'Walk, pick up, carry', '69_69', false, 'work'],
  ['suitcase', 'Carry a heavy suitcase', '70_03', false, 'work'],
  ['push', 'Push something heavy', '81_05', false, 'work'],
  ['drag', 'Drag something heavy', '81_08', false, 'work'],
  ['hammer', 'Hammer a nail', '62_07', false, 'work'],
  ['saw', 'Saw with a hand saw', '62_03', false, 'work'],
  ['dig', 'Dig a hole', '80_05', false, 'work'],
  ['ladder', 'Climb a ladder', '13_33', false, 'work'],
  ['stairs', 'Walk up stairs', '83_27', false, 'work'],
  ['stepover', 'Climb and step over', '40_07', false, 'work'],
  ['crouchwalk', 'Walk crouched', '136_09', true, 'work'],
  ['crawl', 'Walk, then crawl', '133_01', false, 'work'],
  ['squat', 'Jumping jacks and squats', '13_30', false, 'work'],
];
const OUT = path.join(D, 'mocap/fitted');

function combine() {
  const out = {};
  for (const [id, label, trial, loop, group, cut = {}] of CLIPS) {
    const f = path.join(OUT, id + '.json'); if (!fs.existsSync(f)) { console.log('not fitted yet:', id); continue; }
    const c = JSON.parse(fs.readFileSync(f, 'utf8'));
    c.qpos = c.qpos.slice(Math.round((cut.from || 0) * c.fps), cut.to ? Math.round(cut.to * c.fps) : undefined);
    out[id] = { label, group, loop, source: `CMU subject ${trial.split('_')[0]}, trial ${+trial.split('_')[1]}`, fps: c.fps, scale: c.scale, qpos: c.qpos.map(q => q.map(v => +v.toFixed(3))) };
  }
  const head = `/* Human movement examples for the Playground, fitted onto our body by tools/retarget.js (do not edit by hand).
   Source: CMU Graphics Lab Motion Capture Database, mocap.cs.cmu.edu (free to use, modify and redistribute).
   Each clip: poses 30 times a second; each pose is MuJoCo's qpos (pelvis x y z, pelvis turn w x y z, 31 joint angles). */\n`;
  const file = path.join(D, 'mocap/clips.js');
  fs.writeFileSync(file, head + `(function (root) { root.MOCAP_CLIPS = ${JSON.stringify(out)}; })(typeof globalThis !== 'undefined' ? globalThis : this);\nif (typeof module !== 'undefined' && module.exports) module.exports = globalThis.MOCAP_CLIPS;\n`);
  console.log(`wrote mocap/clips.js: ${Object.keys(out).length} clips, ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
}

if (process.argv[2] === '--combine') combine();
else require('../../embodied-2d/tools/node-env.js').load().then(({ mj }) => {
  globalThis.Body3D = require('../body3d.js');
  const M = require('../mocap.js');
  fs.mkdirSync(OUT, { recursive: true });
  const want = process.argv.slice(2), todo = CLIPS.filter(c => !want.length || want.includes(c[0]));
  for (const [id, , trial] of todo) {
    const subj = trial.split('_')[0], t0 = Date.now();
    const bones = M.parseASF(fs.readFileSync(path.join(D, 'mocap/cmu', subj + '.asf'), 'utf8'));
    const frames = M.parseAMC(fs.readFileSync(path.join(D, 'mocap/cmu', trial + '.amc'), 'utf8'));
    const clip = M.retarget(mj, bones, frames, { fps: 30 });
    fs.writeFileSync(path.join(OUT, id + '.json'), JSON.stringify({ fps: clip.fps, scale: clip.scale, qpos: clip.qpos }));
    console.log(`${id}: ${clip.qpos.length} poses (${(clip.qpos.length / clip.fps).toFixed(1)} s, person scaled ×${clip.scale}) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
});
