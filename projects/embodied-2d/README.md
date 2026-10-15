# Embodied 2D

Agents with physical bodies learn motor skills by themselves. Each body is a
1.7 m, ~64 kg humanoid seen from the side, with 10 motorised joints (hips,
knees, ankles, shoulders, elbows; left and right are separate), human-shaped
feet (heel behind the ankle) and a right hand that can close. A small neural
network (49 senses → 32 hidden → 11 motors) runs 60 times a second and sets
every motor's target angle. Nothing about walking, jumping or grabbing is scripted, and
nothing copies a human.

Open `index.html` directly (works from `file://`) or through GitHub Pages.
The page opens on **Nova**, an untrained agent; **Kit, Juno, Pax and Remy**
are trained examples.

## Modes

| Mode | What it does |
|---|---|
| **Watch** | The agent tries its skill. *Success check* runs 10 attempts. Click near the body to shove it. |
| **Train** | 48 variations per generation, in the background (you can keep watching or testing). |
| **Test** | Move the limbs yourself (drag any part, or hold a slider; let go and the brain takes over) and see how the agent reacts. *Brain off* makes the body go limp. *Play ideal movement* takes over the body and moves every joint through a reference human movement for the skill, under the same physics (muscles, gravity, balance), so you can see what the real body does with it; it's for comparison only and never trained on. Nothing here changes any brain or training run. |

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
| Jump for fruit | A fruit hangs overhead: touch it with either hand, then land and stay on your feet. It starts just within reach of a raised arm and hangs ~30 cm higher at full difficulty (1.98 m → 2.30 m) | touched the fruit and didn't fall |
| Pick up the glass | The glass stands on a free-standing table (~8 kg: it slides if you lean on it and tips if you bump it). Reach, touch, close the hand, lift, keep it upright | lifted 10 cm without spilling or knocking the table over |

Walk, Jump and Pick up the glass start from the agent's Stand brain.

**Curriculum** (gets harder as the agent improves): shoves, sensor noise and
energy scarcity reach full strength at generation 150 (energy starts at 5× the
store, so agents first learn to balance stiffly, like a toddler, and then to
relax); the food moves from 6 m to 9.5–10.5 m; obstacles creep in from generation
60 to 400 (sticks up to 3.5 cm you trip over if you drag your feet, logs up to
9 cm you step over); the grip assist (the hand closes on touch) fades from
100% to 0% by generation 200; the fruit rises from 1.98 m to 2.30 m by generation 150.

### Jump: muscles that are weaker when fast

Jump turns on **muscle speed**: like real muscle, a joint pushes less hard the
faster it is already moving in that direction (Hill's force-velocity curve,
`FV_VMAX` in `body2d.js`); braking keeps full strength. Without it the motors
push just as hard at any speed, and a crude scripted crouch-and-spring threw
the body ~70 cm up (a typical adult jumps ~40 cm). With it the same jump rises
~28 cm, and a learned jump with an arm swing should come close to a person's.
It's on for Jump only, so Stand, Walk, Grab and every existing brain behave
exactly as before; it can be switched on everywhere when the examples are next
retrained. Jump also allows a deeper crouch before it counts as a fall (hips
down to 80 cm instead of 98).

## The ideal: is a skill possible at all?

Before training on a skill, check that the best human-style movement can do it
with this body and physics. If the ideal can't, no amount of training will.
*Play ideal movement* (Test mode) resets the body and lets the reference
movement drive it at full difficulty, free-standing, with the same physics as
training. Replayed joint angles alone always topple (nobody stands by holding a
fixed pose), so the ideal gets simple reflexes: the ankles keep the centre of
mass over the feet, the hips keep the torso at the tilt the movement asks for,
in the air the legs swing under the body to land, and for Jump the arms aim at
the fruit (`idealPose` in `body2d.js`). It's for comparison only and never
trained on. In Node, `Body2D.idealCheck(RAPIER, skill)` runs it on all three
variants.

| Skill | Ideal at full difficulty |
|---|---|
| Stand | stands, but falls on the full-strength backward shove: there's only 5 cm of heel behind the ankle, so a person would step back. Needs a stepping reflex. |
| Walk to food | falls at once: walking needs a real balance controller (where to put the next foot), not replayed poses. |
| Jump for fruit | **works**: touches the fruit at 2.30 m in all three positions and lands. The movement (crouch, timing, arm swing, landing) was found by searching for what succeeds; it's sensitive to how it starts (a small nudge before the jump often makes it fail). |
| Pick up the glass | **works** in all three positions (lifts it ~50 cm). |

**Known engine problem (for the engine review):** with 6 solver passes per
step, a light foot under a heavy body jitters (it flips ~20° and back several
times a second) when the ankle holds it mid-range; the ground-grip fix makes it
worse. 12 passes removes it (~25% slower training), but the trained examples
lose skill (Pax stand 9 → 2/10), because they learned to hide the jitter by
pushing the ankle against its joint stop. The ideal (which holds the ankle
mid-range) shows it as visible shaking.

## Where the example agents stand (body v3)

Success check (10 fixed runs) at each skill's full difficulty:

| Agent | Stand | Walk to food (~10 m, obstacles, limited energy) | Pick up the glass (movable table) |
|---|---|---|---|
| Kit | 10/10 | 8/10 | 0/10 |
| Juno | 10/10 | 7/10 | 3/10 |
| Pax | 9/10 | 5/10 | 0/10 |
| Remy (springy knees) | 8/10 | 10/10 at half the obstacles (1/10 with all of them) | 0/10 |

(Measured after the ground-grip fix below; Juno, Pax and Remy's Stand brains were
re-tuned for it, since Pax had learned to stand by using the fake sliding.)

Kit, Juno and Pax have the old stiff knees, and their walk brains come from one
lineage, so they walk alike: a fast, stiff-legged gait that alternates feet but
slides them a lot. Remy walks with springy knees: the swinging leg folds (about
30° on average, up to 55°) like a person's, but slower, and it still trips on
the bigger logs; it stopped improving when the logs got bigger. Grab on the
movable table isn't mastered yet.

**Tested and left off** (kept in the code as options): mirror-symmetric legs
(one shared circuit for both legs) gave no better success or gait; a cost for
dragging a foot cut sliding by only ~15% and broke agents already trained to
scoot.

**Tried for stiff knees and dropped:** springy knees alone still end up
stiff-legged in most training runs (learning to stand first locks the knees
straight, and walking inherits it). These didn't change that, or made walking
worse: an energy cost for dragging a foot, small stones on the ground, a
two-joint calf muscle (pushing off with the toes bends the knee), an energy cost
for straining the knee into its stop, and a newborn-style stepping reflex in new
brains.

## Files

| File | What it is | Reused in 3D? |
|---|---|---|
| `brain.js` | Networks, evolution, brain file format. No physics, no page code. | **Yes, as-is.** |
| `body2d.js` | Body plan table, muscles (energy and fatigue), Rapier 2D world, senses/motors, obstacles, tasks and scoring, reference movements, skill transfer | **Mostly.** Rapier 3D has the same API; shapes and joint axes change. Muscles, scoring, curriculum and anti-exploit rules carry over (the energy/fatigue model is also the stamina system for fighting). |
| `index.html` | Watch / Train / Test UI, saving | Partly; the renderer becomes three.js. |
| `starters.js` | Pretrained Kit, Juno, Pax and Remy (`window.EMBODIED_STARTERS`) | No: brains only fit the body they trained on. |
| `vendor/rapier2d.js` | Rapier 2D 0.21.0 (Apache-2.0, see `vendor/LICENSE-rapier2d.txt`), bundled as a plain script so it works from `file://` | Swapped for Rapier 3D. |

## Ground grip (a physics fix)

Feet used to slide along the floor on their heels, both walking and standing.
That wasn't the agents: Rapier fixes small joint errors by moving bodies
directly, and that fix-up ignores friction, so a planted foot (or a body lying
perfectly still) crept along the ground, a few cm a second, even with 10x the
friction. Now, after every physics step, any body part gripping the ground (its
friction below the slipping limit) keeps only the sideways motion its own
velocity explains (`Biped.stepPhysics`). A body lying still creeps 0.27 cm/s
instead of 2.9, and walking feet slide a third as much. Real slipping (pushing
harder than friction allows) still happens.

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
