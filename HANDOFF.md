# Glass Box — handoff (state as of 2026-10-16)

You're taking over **Glass Box**, a hobby project by a non-technical owner (GitHub: `Guernica4u/GlassBox`). Read this whole file before doing anything.

---

## 1. Who you're working with (important)

- The owner is **not a programmer**. Explain everything in **plain, jargon-free language**: short sentences, no unexplained technical terms. When you report progress, say what it means ("half the walking tries now keep up with the person"), not raw metrics.
- They're on **Windows 11, PowerShell, Firefox**, with a Ryzen 7 3700X (16 threads) and an RTX 3060 Ti.
- **They want everything as realistic as possible.** When there's a choice, recommend the realistic option, but keep it fun and not painfully slow.
- **Agents must learn their behaviour themselves.** Nothing scripted or puppeted. Copying human motion-capture as a *target* is approved ("they figure it out themselves, but learn by watching humans"). The agent's own muscles must do the moving.
- **Visual style:** the Playground must stay a **plain blank dark room**. They rejected a "nature" theme and didn't want to be asked about colour schemes. The Village uses muted natural tones on the same dark UI.
- They like being **asked questions** about design decisions, with a recommended option first.
- **Never push to GitHub without asking.** Commit locally only.
- They have **limited usage**, so be efficient: do the work, verify it, and report briefly.

---

## 2. The project in one paragraph

Glass Box is a browser hub (`index.html`, no build step, works from `file://`) with several "environments". The current focus is **physical AI agents with realistic bodies that learn to move**, built on **MuJoCo 3.16** (official WASM, bundled as a classic script) with an **own Hill-type muscle model**. There's a 2D version (Embodied 2D) and a 3D one (**Playground**). There's also a first **Village**: a small civilization world where several 3D agents share one world with trees, stones, berries and a pond. The long-term goal is a civilization where agents learn to survive, make tools, build, and invent their own communication.

---

## 3. Repo, branches, how to run

- Local path: `C:\Documents 2.0\Vibecoding\GlassBox`
- **Branch `mujoco-switch`**: all recent work, **local commits only, not pushed**. The latest commit is `c06d31a`.
- `claude/ai-sandbox-embodied-agents-w9h36f` is the older pushed "main" branch. Only merge or push when the owner agrees.
- **Running the pages:** open `index.html` directly, or serve the repo root with `python -m http.server 8737` and open `http://localhost:8737/`. The pages load three.js 0.160 from unpkg (importmap) and MuJoCo from `projects/embodied-2d/vendor/mujoco.js`.
- **Node 24** is used for training tools. MuJoCo runs in Node through a small sandbox: `projects/embodied-2d/tools/node-env.js`.
- `training/` and `race-brains/` are **gitignored** (big, changing brain files).

---

## 4. Key files

### Shared engine (`projects/embodied-2d/`)
- `vendor/mujoco.js`: MuJoCo 3.16 WASM as a base64 classic script (`loadMujocoClassic()`). Works in pages, Web Workers and Node.
- `muscle.js`: muscle-tendon units (activation delay 10/40 ms, force-length, force-velocity, springy tendons, fibre damping), `makePair()`.
- `brain.js`:
  - `Network` (tanh MLP).
  - `Evolution` (copy-and-mutate GA).
  - `Strategy` (evolution strategy with mirrored nudges and Adam).
  - `makeRng`, base64 brain helpers.
- `body2d.js`, `index.html`: the 2D lab (stand/walk/jump/grab). Older; a brain was trained to gen ~1760 there.
- `tools/node-env.js`: loads MuJoCo, Brain and Muscle in Node.

### 3D (`projects/playground/`)
- **`body3d.js`**: the 3D body. Its contents:
  - **Body:** the "A+" mannequin, 1.70 m and ~62 kg. 16 parts, 31 hinge joints (ball joints = 3 hinges), **62 muscles** (a pair per joint direction), toes, ball hands.
  - **Senses (185):** inner ear, sight of own motion, joint positions, muscle spindles, tendon force, foot touch, rhythm clock, 4 task inputs, inner feelings, 3 intents. They have realistic **nerve delays** and a **stretch reflex**.
  - **Brain shape:** standard `SIZES = [185, 64, 63]`, i.e. 62 muscle outputs plus 1 grip output.
  - **Body3D class:**
    - `sense/act/step`; step is split into `beginStep/substep/endStep` so a world can step many bodies together.
    - A name `prefix` and placement `at`, for many agents in one world.
    - Shared `data` (one world).
    - Harness, "helping hands" assist (holds the chest up; records `helpUsed`).
    - Shove/pull/twist forces.
    - Grip: the hands grip **any graspable object** via MuJoCo `connect` equalities whose `eq_obj2id` is re-pointed at runtime.
  - **Tasks:** `stand` (shoves every 2 s) and `carry` (box on a stand that lowers with difficulty; carry it 2.5 m).
  - **Trial3D**, difficulty `hardness/assistFor/nextStage`, `freshBrain`.
- **`learn.js`**: learning from experience (**PPO**).
  - `MLP` with backprop, `Adam`.
  - **`Env`**, a practice body: tasks, *or* copying a human clip DeepMimic-style.
    - It starts mid-clip in the person's pose, and is scored on pose/velocity/hands-feet/hips/energy.
    - Legs are weighted more, and leaning on the helping hands costs points.
    - Steering is optional: the walking example turns toward a commanded direction, sensed via the task inputs.
    - A slow-start option plays the person at half speed at first.
  - **`Reference`**: plays a clip, loops strides.
  - **`Practice`**, which runs on each CPU core:
    - Rollouts and GAE, then gradient shares computed in the workers.
    - Mixed skills: each body can practise a different skill, with a stage per skill.
  - `newLearner`, `applyGrads`, `learnerToJSON`.
  - Brains can be any shape (`sizes`); the policy is a normal `Brain.Network`, so pages can play it.
- **`tools/ppo3d.js`**: the multi-core PPO trainer.
  - Usage: `node playground/tools/ppo3d.js <brain.json> <iterations> <skills> <seed> <cores>`.
  - Skills are comma-separated, e.g. `copy:walk,copy:stand,stand,carry`. A skill listed twice gets twice the bodies.
  - Env switches:
    - `GB_STEER=0`: walk straight.
    - `GB_SLOW=0`: the person's own speed from the start.
    - `GB_HIDDEN=128,128`: a bigger fresh brain.
    - `GB_ASSIST`, `GB_STAGE`.
  - It continues from the saved file.
- `tools/train3d.js`: the evolution trainer (older; `GB_METHOD=es` uses Strategy).
- **`mocap.js`**: CMU ASF/AMC parser, forward kinematics, and **retargeting onto our body**. The retargeting turns our joints frame by frame so the bone directions match the person's, places the hips scaled by leg length, corrects the foot tilt, and puts the feet on the floor.
- **`mocap/cmu/`**: the 26 downloaded CMU clips plus skeletons. Source: mocap.cs.cmu.edu ("may be copied, modified, or redistributed without permission").
- `mocap/fitted/*.json` holds the per-clip fits. **`mocap/clips.js`** is all clips combined (~2.1 MB, loaded as a plain script). Rebuild it with `node playground/tools/retarget.js [ids]` and then `--combine`.
- **`tools/checkclips.js`** checks each clip on our body:
  - Feet sink, planted feet sliding, joints at their limits.
  - A muscle-follow test with a balance helper.
  - **Results:**
    - All clips are fine or usable.
    - getup/getup2/crawl/stepover show feet sliding, which is mostly real.
    - dig/drag hit joint limits about 13% of the time.
- **`index.html`**: the Playground lab page.
  - Agents list (localStorage `glassbox-playground/v2`), with export/import.
  - **Watch / Train / Test** modes.
  - The **Practice** menu:
    - Stand (shoves).
    - Pick up and carry.
    - "Copy a person: …" for every clip, with the person overlaid see-through.
  - The success check (10 runs on Web Workers).
  - Browser training, which uses evolution through Web Workers built from the page's own scripts.
  - **Test** mode: drag body parts, joint sliders (steered by the muscles), brain on/off, harness, and **Play ideal**. Play ideal plays a recorded person on the body with its own muscles, and the person is shown as the target.

### Village (`projects/village/`)
- **`village.js`**: one MuJoCo world.
  - **Contents:** 6 trees (static capsules), 4 berry bushes, a pond, starting stones, and **pooled objects**: sticks, logs, stones, shards, berries. Objects can't be created at runtime, so unused ones are parked far away and moved in when needed.
  - **Agents:** 4 by default, prefixed `a0_`…, sharing one `MjData`.
  - **Forgiving rules** (owner's rule: "hit the plank anywhere near the nail and it's nailed"):
    - Solid hits on a tree trunk (hand or held object; harder with something heavy or sharp) knock sticks loose, and enough damage gives a log.
    - A stone hitting a stone at ≥3 m/s cracks it into 2 sharp shards.
    - **Binding:** two held objects pressed together for 0.8 s are welded where they are. The runtime weld uses relpose = body2's pose in body1's frame.
    - Closing a hand at a bush picks a berry, and bringing it to the mouth eats it.
    - Dipping a hand in the pond and bringing it to the mouth drinks.
    - Hunger and thirst rise. Impacts (a sudden speed change on a part, >5 m/s) hurt, worst on the head, and weaken that limb's muscles until healed. Health 0 means death.
    - **Fighting is not coded**; it can only emerge.
- **`index.html`**: the Village page.
  - 3D view, agent list with health/food/water, event log.
  - Drag anything with the mouse.
  - Helping hands toggle.
  - **New village…**: "learn everything" (fresh brains), or "born able to move" (a Playground agent's brain or a brain file).
  - **The agents can't walk yet.** They just stand with the current brain.
- Hub cards were added for **Playground** and **Village** (in root `index.html`, `ENVS`).

---

## 5. Training right now (the main thread of work)

The goal is a **movement brain** (stand, walk, steer, get up, pick up and carry) learned by copying human recordings with realistic muscles via PPO. It's later used by every village agent ("born able to move").

Runs write to `GlassBox/training/`. They stop when the app quits and **resume from the saved file**.

| Run | Files | State at handoff |
|---|---|---|
| **Straight walking** (most promising) | `walk-straight.json/.log`, 185-64-63 brain, `copy:walk` only, `GB_STEER=0 GB_SLOW=0` | round ~5000: **half the tries keep up with the person ≥3 s** (22/44), avg 3.1 s, score 0.44 and rising. Helping hands still 100% (they fade only when ≥2/3 of tries cope). |
| **Big brain** (185-128-128-63) | `movement-big.json/.log`, mixed `copy:walk,copy:walk,copy:stand,stand` | round ~5600: copies the stand-still person with only 6% help; walking avg 3.1 s (10/21). |
| Small mixed brain (paused) | `movement.json` (+ `movement-before-legweight.json`) | round ~2400, plateaued on walking at ~2.2 s. |

Restart commands, run from `GlassBox\projects` in bash:
```bash
GB_STEER=0 GB_SLOW=0 node playground/tools/ppo3d.js ../training/walk-straight.json 20000 copy:walk 11 8 >> ../training/walk-straight.log
node playground/tools/ppo3d.js ../training/movement-big.json 20000 copy:walk,copy:walk,copy:stand,stand 1 7 >> ../training/movement-big.log
```
(In PowerShell, set the variables first: `$env:GB_STEER=0; $env:GB_SLOW=0`.)

### Lessons learned (don't repeat these mistakes)
1. **DeepMimic's reward scales are too strict for 31 hinges + 5 parts:** the pose score was stuck at 0, so there was no gradient. The fix is gentler scales: pose `exp(-0.4·Σw·e²)` with leg-weighted joints, ends `exp(-5·…)`, velocity `exp(-0.005·…)`.
2. **The agent learned to hang in the helping hands.** It sagged with its knees bent while the hands held its chest. The fix: **charge for help** (score −0.4 × fraction of body weight carried).
3. **Adding steering and mixed skills at the same moment killed walking progress.** Teach straight walking alone first, then add steering, then mix in other skills.
4. **Slow-motion copying isn't easier.** It means longer single-leg balance. Use the person's own speed (`GB_SLOW=0`).
5. A **bigger brain** learns standing much faster but did not by itself fix walking.
6. Explicit damping torques on the light pelvis, applied for a whole 1/60 s brain step, **explode**. Keep any helper torques gentle.
7. Copying requires helping hands at first. "Coping" for a copy skill means keeping up for ≥3 s, and the stage (which fades the help) rises only when ≥2/3 of tries cope.
8. With a fixed policy, `Play ideal` (muscle servo to the recorded joints) falls over without the harness. That's expected: the recording has no balance information, and that's what the brain must learn.

### Suggested next steps for training
1. Keep straight walking going until most tries cope and the helping hands start fading. Then continue with `GB_STEER` on (turning). Then the mixed list: `copy:walk,copy:walk,copy:stand,stand`.
2. Consider moving straight walking onto the **big brain**, since it learned faster, or training both.
3. Then add `copy:getup` (owner's order: **stand still nicely → get up after falling → pick up and carry**). Then `carry` and copy clips like `pickup`/`carry`.
4. After that, the **two-layer brain**: a task brain that issues commands (walk direction/speed, reach, grip) to the movement brain, and learns during its lifetime.

---

## 6. Owner's decisions (keep to them)

- **Learning:** evolution and lifetime learning are both wanted; PPO plus imitation is now the main method. **One shared brain per agent for all skills.** Difficulty rises **only while the agent copes**.
- **Mocap:** learn from **many people** (each clip's own subject). **Copy closely while learning a skill; later relax the copying** so each agent drifts into its own style.
- **Spawn options:** keep both **"learns everything"** (dumb, from scratch) and **"born able to move"** (gets the trained movement brain and then learns higher skills like building).
- **Village/civilization:**
  - Real physics objects with **forgiving interactions** for everything.
  - Agents invent tools; there are no recipes.
  - The world has trees, stones, berry bushes and water.
  - **Injuries are in from the first village.**
  - **Fighting may emerge**; it's never trained.
  - Later: agents invent their own communication (voice and gestures, fading with distance, overhearable), with writing even later.
- Before civilization (owner agreed):
  1. Movement with steering.
  2. Senses for the world (eyes: what's nearby; hearing).
  3. Needs (hunger, thirst, rest).
  4. The two-layer brain.
  5. A life cycle (ageing, death, children inheriting brains).
  6. Performance tests (4 agents run about 1.6× real time on one core).
  7. "Glass box" inspection tools.
  - The plan is a **tiny version of everything first**, then grow it.
- **Future environments** (separate hub cards): civilization (bigger), store-running, stock trading (simulated), chess.
- Same body for all agents for now; variety comes later through reproduction.

---

## 7. Technical gotchas on this machine

- **Bash heredocs mangle quotes and backslashes** in some cases. For multi-line edits, write a Python script to a file (opened with `encoding='utf-8'`) and run it, or use a proper edit tool.
- Python's default cp1252 encoding corrupted a file once. **Always open with `encoding='utf-8'`.**
- **MJCF angles default to degrees.** Always use `<compiler angle="radian">`.
- MuJoCo JS typed-array getters (`data.qpos` etc.) are slow; Body3D caches them in `views()`.
- MuJoCo JS model arrays are **writable at runtime**: `eq_obj2id`, `eq_obj1id`, `eq_data`, and `data.eq_active`.
- After teleporting a body (setting `qpos`), call `mj_kinematics` before reading positions.
- **Browsers cache old scripts:** use `fetch(file, {cache:'reload'})`, then reload. A hidden browser pane pauses `requestAnimationFrame`, so step simulations manually when testing.
- Verify single-agent behaviour after refactors with seeded runs. The multi-agent refactor reproduced the old results to 6 decimals.
- Syntax-check page modules by extracting the `<script type="module">` text and running `node --check`.

---

## 8. Where to start

1. Check `training/walk-straight.log` and `training/movement-big.log` (are they running? `Get-CimInstance Win32_Process -Filter "name='node.exe'"`).
2. Tell the owner in plain words how walking is doing.
3. Continue the training plan in §5.
4. Then build toward the two-layer brain and village v2.
