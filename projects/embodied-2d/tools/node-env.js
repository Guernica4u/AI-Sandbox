/*
 Loads the Embodied 2D engine in Node (for the test kit and training scripts):
   const { mj, Brain, Muscle, Body2D } = await require('./tools/node-env.js').load();
 MuJoCo comes from the same bundle the page uses (vendor/mujoco.js), run in a small browser-like sandbox.
*/
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const D = path.join(__dirname, '..');
async function load() {
  const ctx = { atob: s => Buffer.from(s, 'base64').toString('binary'), console, WebAssembly, performance, setTimeout, clearTimeout,
    TextDecoder, TextEncoder, URL, location: { href: 'file:///embodied-2d/index.html' }, crypto: globalThis.crypto };
  ctx.self = ctx; ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(D, 'vendor/mujoco.js'), 'utf8'), ctx);
  const mj = await vm.runInContext('loadMujocoClassic()', ctx);
  globalThis.Brain = require(path.join(D, 'brain.js'));
  globalThis.Muscle = require(path.join(D, 'muscle.js'));
  const Body2D = require(path.join(D, 'body2d.js'));
  return { mj, Brain: globalThis.Brain, Muscle: globalThis.Muscle, Body2D };
}
/** The starter agents (starters.js is written for the page, so it's loaded in a sandbox). */
function starters() { const box = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(D, 'starters.js'), 'utf8'), box); return box.window.EMBODIED_STARTERS; }
module.exports = { load, starters, dir: D };
