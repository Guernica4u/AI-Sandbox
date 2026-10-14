# Embodied 2D

Agents with physical bodies learn motor skills by themselves. Each body is a
1.7 m, ~64 kg humanoid seen from the side, with 10 motorised joints (hips,
knees, ankles, shoulders, elbows; left and right are separate), human-shaped
feet (heel behind the ankle) and a right hand that can close. A small neural
network (49 senses → 32 hidden → 11 motors) runs 60 times a second and sets
every motor's target angle. Nothing about walking or grabbing is scripted, and
nothing copies a human.

Open `index.html` directly (works from `file://`) or through GitHub Pages.
The page opens on **Nova**, an untrained agent; **Kit, Juno and Pax** are
trained examples.

## Modes

| Mode | What it does |
|---|---|
| **Watch** | The agent tries its skill. *Show ideal* draws a reference human movement as a ghost, for comparison only (it is never trained on). *Success check* runs 10 attempts. Click near the body to shove it. |
| **Train** | 48 variations per generation, in the background (you can keep watching or testing). |
| **Test** | Move the limbs yourself (drag any part, or hold a slider; let go and the brain takes over) and see how the agent reacts. *Brain off* makes the body go limp; *Freeze time* pauses physics (sliders still pose it). Nothing here changes any brain or training run. |

## Training speed

- **All CPU cores:** by default, training runs in background workers, one per
  spare CPU core, each scoring part of the 48 variations. The workers are built
  from the page's own scripts (`__rapierFactory`, `__brainModule`,
  `__body2dModule`), so this works from `file://` as well as on a website. If a
  browser can't start workers, training falls back to running on the page.
- **Keeps going in the background:** the worker loop doesn't depend on the
  screen redrawing, so training continues when the tab is hidden or the window
  is minimised (the tab title shows the generation). While training, the stage
  replays the best brain so far.
- **Measured:** about 6× faster than training on the page, on a 4-core machine
  (more cores, more speed-up). Training continued at full speed with screen
  redraws stopped (what a hidden tab does).
- **Hopeless attempts end early:** a walker stuck for 4 s or out of energy, or a
  spilled glass, stops being simulated and is scored as if it had stood still
  until the end, so the ranking doesn't change.
- *Real time (watch every try)* and *On this page only* still run the old way.

## Realism: why they walk the way they do

Instead of rewarding a human-looking walk, the agents get the problems that
shaped human walking, and adapt to them:

- **Muscles cost energy even when holding still.** Every motor burns energy in
  proportion to how hard it pushes, plus the work it does, plus a resting cost.
  Tiptoeing (calf always working) costs about 4× standing flat-footed; holding a
  leg up behind you costs more than putting it down.
- **Muscles get tired.** Sustained effort fatigues a joint and makes it weaker;
  rest recovers it. A tiptoe calf wears out within seconds.
- **Energy is limited.** Every attempt starts with an energy store. Running out
  is crippling (10% strength). Energy left at the end adds to the score.
- **Food is far away.** Walk is *Walk to food*: the food is 6–10 m away, and a
  wasteful gait runs out before it gets there.
- **Feeling the feet.** Separate pressure senses under each heel and toe, and a
  human ankle range (toes down 43°, up 20°).
- **Springy knees.** New brains get knee muscles that are softer than the hips
  and ankles, like a real knee that hangs loose while the leg swings, and every
  joint's command is spread evenly over its range. Before this, "straight" took
  up half of the knee's command range, the brain learned to keep it pinned there,
  and the knees never bent. Brains trained before keep the old stiff knees (the
  page says so under the skill).

Energy is in game joules (a fully tensed body burns ~10 kW, a relaxed one a few
hundred watts); what matters is the *relative* cost of different movements.

## Skills

| Skill | Goal | Success check |
|---|---|---|
| Stand | Stay upright and in place while being shoved every 2 s | stayed standing |
| Walk to food | Reach food 6–10 m away before the energy runs out; sticks and logs appear as training goes on | reached the food |
| Pick up the glass | The glass stands on a free-standing table (~8 kg: it slides if you lean on it and tips if you bump it). Reach, touch, close the hand, lift, keep it upright | lifted 10 cm without spilling or knocking the table over |

Walk and Pick up the glass start from the agent's Stand brain.

**Curriculum** (gets harder as the agent improves): shoves, sensor noise and
energy scarcity reach full strength at generation 150 (energy starts at 5× the
store, so agents first learn to balance stiffly, like a toddler, and then to
relax); the food moves from 6 m to 9.5–10.5 m; obstacles creep in from generation
60 to 400 (sticks up to 3.5 cm you trip over if you drag your feet, logs up to
9 cm you step over); the grip assist (the hand closes on touch) fades from
100% to 0% by generation 200.

## Where the example agents stand (body v3)

Success check (10 fixed runs) at each skill's full difficulty:

| Agent | Stand | Walk to food (~10 m, obstacles, limited energy) | Pick up the glass (movable table) |
|---|---|---|---|
| Kit | 10/10 | 8/10 | 0/10 |
| Juno | 5/10 | 6/10 | 0/10 |
| Pax | 10/10 | 6/10 | 0/10 |

The three walk brains come from one lineage, so they walk alike: a fast,
stiff-kneed gait that alternates feet but slides them a lot. Grab on the
movable table isn't mastered yet.

**Tested and left off** (kept in the code as options): mirror-symmetric legs
(one shared circuit for both legs) gave no better success or gait; a cost for
dragging a foot cut sliding by only ~15% and broke agents already trained to
scoot.

## Files

| File | What it is | Reused in 3D? |
|---|---|---|
| `brain.js` | Networks, evolution, brain file format. No physics, no page code. | **Yes, as-is.** |
| `body2d.js` | Body plan table, muscles (energy and fatigue), Rapier 2D world, senses/motors, obstacles, tasks and scoring, reference movements, skill transfer | **Mostly.** Rapier 3D has the same API; shapes and joint axes change. Muscles, scoring, curriculum and anti-exploit rules carry over (the energy/fatigue model is also the stamina system for fighting). |
| `index.html` | Watch / Train / Test UI, saving | Partly; the renderer becomes three.js. |
| `starters.js` | Pretrained Kit, Juno and Pax (`window.EMBODIED_STARTERS`) | No: brains only fit the body they trained on. |
| `vendor/rapier2d.js` | Rapier 2D 0.21.0 (Apache-2.0, see `vendor/LICENSE-rapier2d.txt`), bundled as a plain script so it works from `file://` | Swapped for Rapier 3D. |

## Things the agents taught us (now handled in the code)

- **Sitting counts as standing** if "fallen" only checks head height. Then
  **the splits** did too. Fallen now means hips below ~1 m, and Stand charges
  for a stance wider than 45 cm.
- **Standing on empty.** With energy added, agents burned their whole store in
  0.2 s and then stood in the weakened state. Running empty is now crippling,
  and energy scarcity grows with the curriculum.
- **Swinging past the glass** scored like reaching it when the reward used the
  closest distance ever reached. Reward is now paid every moment.
- **Furniture gets exploited.** A fixed table was pressed against, braced on,
  and even gripped *through*. The table is now free-standing (it slides and
  tips), and touching the glass from under the table doesn't count.
- **Balance breaks when the arms learn.** Half the mutations only touch one
  limb group's outputs (legs, or arms and hand).
- **A new sense makes an old brain flail.** Starting a new skill cuts
  connections from senses the old skill never used (`transferBrain`), and
  loosens the arms before learning to grab.
- **Lucky runs** looked like skill. Every brain is tested on the same 2–3
  episodes with random shoves, and inconsistent brains score lower.

## Training outside the browser

`body2d.js` and `brain.js` also load in Node (`module.exports`). Load
`vendor/rapier2d.js`, call `RAPIER.init()`, then loop
`evolution.tell(Body2D.evaluate(RAPIER, 'walk', evolution.population, evolution.generation))`.
That's how `starters.js` was made.
