# Embodied 2D

Agents with physical bodies learn motor skills by themselves. Each body is a
1.7 m, ~62 kg humanoid seen from the side, with 10 joints (hips, knees,
ankles, shoulders, elbows; left and right are separate), human-shaped feet
(heel behind the ankle) and a right hand that can close. Every joint is moved
by **a pair of realistic muscles**, one bending it and one straightening it.
A small neural network (49 senses → 32 hidden → 21 outputs) runs 60 times a
second and sets how hard each of the 20 muscles works, plus the grip. Nothing
about walking, jumping or grabbing is scripted, and nothing copies a human.

Open `index.html` directly (works from `file://`) or through GitHub Pages.

> **Status (branch `mujoco-switch`):** the physics moved from Rapier to MuJoCo
> with realistic muscles. Brains only fit the body they trained on, so the old
> examples (Kit, Juno, Pax, Remy) don't work on this body and are being
> retrained. Until then the page opens on **Nova**, an untrained agent.

## Modes

| Mode | What it does |
|---|---|
| **Watch** | The agent tries its skill. *Success check* runs 10 attempts. Click near the body to shove it. |
| **Train** | 48 variations per generation, in the background (you can keep watching or testing). |
| **Test** | Move the limbs yourself (drag any part, or hold a slider; let go and the brain takes over) and see how the agent reacts. *Brain off* makes the body go limp. *Play ideal movement* resets the body and lets a hand-made reference movement steer every joint through its muscles, under the same physics; it's for comparison only and never trained on. Nothing here changes any brain or training run. |

## Physics: MuJoCo

The world runs on [MuJoCo](https://github.com/google-deepmind/mujoco) (Google
DeepMind, Apache-2.0), the engine most research on learned movement uses. The
body is one jointed chain, so joints can't drift apart and planted feet don't
slide (Rapier needed a "ground grip" patch for that, and its light feet
jittered). The world is planar: forward/back, up/down and tipping, nothing
sideways. Physics runs 8 small steps per brain step (480 Hz); 240 Hz brings
back joint chatter.

`vendor/mujoco.js` is the official MuJoCo JavaScript package packed into one
plain script with the WebAssembly inside (14.6 MB), so it loads from `file://`
and in training workers. `tools/make-mujoco-classic.js` rebuilds it from the
npm package `@mujoco/mujoco`.

## Muscles (muscle.js)

Engine-independent, so they carry over to 3D. Each muscle (a Hill-type
muscle-tendon unit, Thelen 2003 / Millard 2013 style) has:

- **Human strength, per direction**, for a ~62 kg adult: hip 220 N·m back /
  150 forward, knee 200 straightening / 100 bending, ankle 150 toes-down / 40
  toes-up, shoulder 60/60, elbow 55 bending / 40 straightening.
- **Switch-on delay:** ~10 ms to tense, ~40 ms to relax.
- **Force-length:** strongest near its ideal length, weak when very short or
  long (the calf is weak with the toes already pointed).
- **Force-velocity:** weaker the faster it shortens, up to 1.4× when stretched.
- **Springy tendons** that store and return energy (a long, stretchy Achilles).
- **A little fibre damping**, which keeps a lightly tensed muscle from
  chattering (without it, elbows and ankles shook at up to 50 rad/s).

Speeds are calibrated to people: each joint's top speed under full effort is
human (knee ~23, hip ~19, ankle ~15 rad/s). A crude jump with every leg muscle
fully on at once rises ~24 cm (a person's best squat jump is ~30 cm; real
jumpers fire hips, knees and ankles in sequence).

## Realism: why they move the way they do

Instead of rewarding a human-looking movement, the agents get the problems that
shaped human movement, and adapt to them:

- **Muscles cost energy even when holding still**, in proportion to their size
  and how hard they're switched on, plus the work they do (~25% efficient), plus
  a resting cost. Tensing everything burns ~9 kW (game joules); relaxed, a few
  hundred watts.
- **Muscles get tired** with sustained effort and recover with rest.
- **Energy is limited.** Every attempt starts with an energy store. Running out
  is crippling (10% strength). Energy left at the end adds to the score.
- **Food is far away** (Walk: 6–10 m), so a wasteful gait runs out first.
- **Feeling the feet:** pressure senses under each heel and toe, and a human
  ankle range (toes down 43°, up 20°).

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
store); the food moves from 6 m to 9.5–10.5 m; obstacles creep in from
generation 60 to 400 (sticks up to 3.5 cm, logs up to 9 cm); the grip assist
(the hand closes on touch) fades from 100% to 0% by generation 200; the fruit
rises from 1.98 m to 2.30 m by generation 150. Jump allows a deeper crouch
before it counts as a fall (hips down to 80 cm instead of 98).

## The ideal: is a skill possible at all?

*Play ideal movement* lets a hand-made reference movement steer the joints
through their muscles, with simple reflexes (ankles keep the centre of mass
over the feet, hips keep the torso upright, legs swing under the body before
landing, arms aim at the fruit). In Node, `Body2D.idealCheck(mj, skill)` runs
it on all three variants.

Honest status: on realistic muscles these hand-made controllers don't do the
skills yet (they did on Rapier's stiff motors, which could snap any joint to
any angle instantly). Separate tests showed the body itself can: it stands
quietly, and with each muscle group fired fully in sequence it reaches 2.44 m,
high enough for the fruit; landing that jump reliably by hand failed. Balancing
real muscles by hand is hard (it's why toddlers fall over), so the agents
learning it themselves is the real check.

## Physics test kit

`node projects/embodied-2d/tests/physics-kit.js` (about a minute) scores the
engine before anything is retrained. Current results:

| Check | Result |
|---|---|
| Muscle strength vs human data | PASS (0.2% off) |
| Planted foot under sideways force: slip | PASS (0.00 cm/s) |
| Lying limp: creep / joints moving on average | PASS (0.01 cm/s / ~0.1 rad/s) |
| Lying limp: brief twitches (worst moment) | info: ~1–2 rad/s at a light part resting on the ground or a joint limit (known minor issue) |
| Held in a harness, steady tone: shaking | PASS (0.05 rad/s; was 16 on Rapier) |
| Squat jump, muscles alone | PASS (~24 cm) |
| Repeatability | PASS |
| Speed: one body, one simulated second | FAIL (~31 ms; the mark is 20). Fine for 2D training on all cores; needs work before 3D crowds. |

On Rapier the same kind of kit gave 7 pass, 5 fail, with feet shaking at
16 rad/s, walking feet sliding 17 cm/s, and superhuman jumps (63 cm).

## Training speed

- **All CPU cores:** training runs in background workers, one per CPU core,
  each scoring part of the 48 variations. The workers are built from the page's
  own scripts (`__mujocoFactory`, `__brainModule`, `__muscleModule`,
  `__body2dModule`), so this works from `file://` as well as on a website.
  Measured: 16 workers, ~0.4 s per generation early in training.
- **Keeps going in the background:** training continues when the tab is hidden
  or the window is minimised.
- **Hopeless attempts end early:** a walker stuck for 4 s or out of energy, or a
  spilled glass, stops being simulated and is scored as if it had stood still.

## Training outside the browser

`node projects/embodied-2d/tools/train.js <skill> <generations> <brain.json> [seed] [from-brain.json]`
trains with the same code as the page (one CPU core), saves every 10
generations and continues where it left off. `tools/node-env.js` loads MuJoCo,
the muscles and the body in Node for any script.

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
  limb group's outputs (leg muscles, or arm muscles and hand).
- **A new sense makes an old brain flail.** Starting a new skill cuts
  connections from senses the old skill never used (`transferBrain`), and
  relaxes the arms before learning to grab or jump.
- **Lucky runs** looked like skill. Every brain is tested on the same 2–3
  episodes with random shoves, and inconsistent brains score lower.
- **Agents learn physics glitches.** On Rapier, Nova walked by using a sliding
  bug, and Kit and Pax hid a foot jitter by pushing their ankles into the joint
  stop. Physics fixes then broke them. That's why there's now a test kit.

## Files

| File | What it is | Reused in 3D? |
|---|---|---|
| `brain.js` | Networks, evolution, brain file format. No physics, no page code. | **Yes, as-is.** |
| `muscle.js` | Realistic muscles (no physics engine inside) | **Yes, as-is.** |
| `body2d.js` | Body plan, the MuJoCo world (as MJCF), senses, muscle outputs, energy and fatigue, obstacles, tasks and scoring, reference movements, skill transfer | **Mostly:** MuJoCo is 3D already; the body plan and joint axes change. |
| `index.html` | Watch / Train / Test UI, saving | Partly; the renderer becomes three.js. |
| `starters.js` | Pretrained agents (`window.EMBODIED_STARTERS`); the current ones fit the old body and are hidden | No: brains only fit the body they trained on. |
| `vendor/mujoco.js` | MuJoCo 3.16.0 (Apache-2.0, see `vendor/LICENSE-mujoco.txt`) as one plain script | Yes. |
| `vendor/rapier2d.js` | The old engine (Rapier 2D 0.21.0), no longer loaded | No. |
| `tests/physics-kit.js` | The physics test kit | Yes (ported). |
| `tools/` | `train.js` (Node training), `node-env.js` (loads everything in Node), `make-mujoco-classic.js` (rebuilds the MuJoCo bundle) | Yes. |
