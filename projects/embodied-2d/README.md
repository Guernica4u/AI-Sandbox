# Embodied 2D

Agents with physical bodies learn motor skills by themselves. Each body is a
1.7 m, ~64 kg humanoid seen from the side, with 10 motorised joints (hips,
knees, ankles, shoulders, elbows; left and right are separate) and a right
hand that can close. A small neural network (44 senses → 32 hidden → 11
motors) runs 60 times a second and sets every motor's target angle. Nothing
about walking or grabbing is scripted.

Open `index.html` directly (works from `file://`) or through GitHub Pages.
The page opens on **Nova**, an untrained agent; **Kit, Juno and Pax** are
trained examples.

## Modes

| Mode | What it does |
|---|---|
| **Watch** | The agent tries its skill. *Show ideal* draws the reference movement as a ghost on top. *Test 10 runs* gives a success rate. Click near the body to shove it. |
| **Train** | 48 variations per generation, in the background (you can keep watching or teaching). *Learn from* adds a reward for moving like the reference or your demonstration; off by default. |
| **Teach** | Move the limbs yourself: drag any part, or set joints with sliders. The brain keeps running and fights you, but nothing here changes any brain or training run. Harness holds the hips up; *Hold pose* freezes joints where they are; the hand can be forced open/closed. Record keyframes and save them as a demonstration. |

## Skills

| Skill | Goal | Success test |
|---|---|---|
| Stand | Stay upright and in place while being shoved every 2 s | stayed standing |
| Walk | Get as far right as possible in 10 s; sticks and logs appear as training goes on | walked 5 m without falling |
| Pick up the glass | A glass on a small wall shelf: reach, touch, close the hand, lift, keep it upright | lifted 10 cm without spilling |

Walk and Pick up the glass start from the agent's Stand brain.

**Curriculum** (gets harder as the agent improves): shoves and sensor noise
reach full strength at generation 150; obstacles creep in from generation 60
to 400 (sticks up to 3.5 cm you trip over if you drag your feet, logs up to
9 cm you have to step over); the grip assist (the hand closes on touch) fades
from 100% to 0% by generation 200.

**Senses**: torso tilt/spin/velocity/height, every joint's angle and speed,
feet touching the ground and their height above it, a 1 Hz clock, task inputs
(where the glass is), and the ground height at 8 points ahead (so they can see
obstacles coming).

**Energy** used by the motors is measured and shown, but not scored yet. When
food arrives (civilization), energy becomes a body stat you refill by eating.

## Where the example agents stand

Measured over 9–10 fixed test runs each, at each skill's full difficulty:

| Agent | Stand | Walk (full obstacles) | Pick up the glass |
|---|---|---|---|
| Kit | 10/10 | 3/9 | 8/9 |
| Juno | 10/10 | 5/9 (learned from the reference walk) | 8/9 |
| Pax | 6/10 | ~5/10 | 2/9 |

Grab was trained with *Learn from: Reference movement* (it only guides the
right arm). All agents now alternate their feet (no foot stays up longer than
about 1 s), but each still keeps **one foot on its toes** (never flat). Next
candidates for that: an energy cost (tiptoe is tiring), or rewarding the heel.

## Files

| File | What it is | Reused in 3D? |
|---|---|---|
| `brain.js` | Networks, evolution, brain file format. No physics, no page code. | **Yes, as-is.** |
| `body2d.js` | Body plan table, Rapier 2D world, senses/motors, obstacles, tasks and scoring, motion clips (reference + demonstrations), skill transfer | **Mostly.** Rapier 3D has the same API; shapes and joint axes change. Scoring, curriculum, clip format and anti-exploit rules carry over. |
| `index.html` | Watch / Train / Teach UI, saving | Partly (training loop, panels, teach logic); the renderer becomes three.js. |
| `starters.js` | Pretrained Kit, Juno and Pax (`window.EMBODIED_STARTERS`) | No: brains only fit the body they trained on. |
| `vendor/rapier2d.js` | Rapier 2D 0.21.0 (Apache-2.0, see `vendor/LICENSE-rapier2d.txt`), bundled as a plain script so it works from `file://` | Swapped for Rapier 3D. |

## Things the agents taught us (now handled in the code)

- **Sitting counts as standing** if "fallen" only checks head height. Then
  **the splits** did too. Fallen now means hips below ~1 m, and Stand charges
  for a stance wider than 45 cm.
- **Swinging past the glass** scored like reaching it when the reward used the
  closest distance ever reached. Reward is now paid every moment.
- **Balance breaks when the arms learn.** Half the mutations only touch one
  limb group's outputs (legs, or arms and hand).
- **A new sense makes an old brain flail.** A Stand brain fell within 0.4 s
  the first time it saw the glass, because the connections from that sense
  were never tested. Starting a new skill now cuts connections from senses the
  old skill never used (`transferBrain`).
- **Obstacles too early** taught agents to stop in front of logs. They now
  learn flat walking first.
- **The table kept getting in the way.** A solid block tripped forward feet;
  a tabletop sat in the arm's path, so agents pressed their hand under it and
  even gripped the glass *through* it; a table far enough away needed an
  over-the-top reach that evolution never found. The glass now stands on a
  small wall shelf on the natural path of a forward arm raise. Touching also
  requires the hand to be at or above the shelf.
- **Lucky runs** looked like skill. Every brain is tested on the same 2–3
  episodes with random shoves, and inconsistent brains score lower.

## Training outside the browser

`body2d.js` and `brain.js` also load in Node (`module.exports`). Load
`vendor/rapier2d.js`, call `RAPIER.init()`, then loop
`evolution.tell(Body2D.evaluate(RAPIER, 'walk', evolution.population, evolution.generation))`.
That's how `starters.js` was made.
