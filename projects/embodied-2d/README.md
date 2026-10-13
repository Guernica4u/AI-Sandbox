# Embodied 2D

Agents with physical bodies learn motor skills by themselves. Each body is a
1.7 m, ~64 kg humanoid seen from the side, with 10 motorised joints (hips,
knees, ankles, shoulders, elbows) and a right hand that can close. A small
neural network (34 senses → 24 hidden → 11 motors) runs 60 times a second and
sets every motor's target angle. Nothing about walking or grabbing is scripted.

Open `index.html` directly (works from `file://`) or through GitHub Pages.

## Skills

| Skill | Goal | Starts from |
|---|---|---|
| Stand | Stay upright and in place while being shoved every 2 s | random brain |
| Walk | Get as far right as possible in 10 s without falling | the agent's Stand brain |
| Pick up the glass | Grip the glass on the table and lift it without tipping it (spill) | the agent's Stand brain |

Training is neuroevolution: 48 variations of the current brain each try the
skill (2–3 times, with different shoves and sensor noise), the best ones are
kept and varied again. A curriculum starts gentle (no shoves, glass close by)
and reaches full difficulty at generation 150.

## Where it stands

- **Stand:** all three starters stay up through repeated shoves (each in its own stance).
- **Walk:** all three walk 6–9 m in 10 s, upright. The gaits are lopsided
  (one leg leads, one trails), which is common for early neuroevolution.
- **Pick up the glass:** the hard one. Juno lifts the glass in about 1 run in
  3; Kit and Pax reach within ~10–15 cm but haven't learned to close the
  hand. More generations alone didn't fix it (local optimum). Next ideas: a
  reward for touching before closing, a wrist joint, or novelty search.

## Files

| File | What it is | Reused in 3D? |
|---|---|---|
| `brain.js` | Networks, evolution, brain file format. No physics, no page code. | **Yes, as-is.** |
| `body2d.js` | Body plan table, Rapier 2D world, senses/motors, task scoring | **Mostly.** Rapier 3D has the same API; shapes and joint axes change. The task scoring, curriculum and anti-exploit rules carry over. |
| `index.html` | Viewing, training UI, saving | Partly (training loop, panels); the renderer is replaced by three.js. |
| `starters.js` | Pretrained Kit, Juno and Pax (`window.EMBODIED_STARTERS`) | No: brains only fit the body they trained on. |
| `vendor/rapier2d.js` | Rapier 2D 0.21.0 (Apache-2.0, see `vendor/LICENSE-rapier2d.txt`), bundled as a plain script so it works from `file://` | Swapped for Rapier 3D. |

## Things the agents taught us (now handled in the code)

- **Sitting counts as standing** if "fallen" only checks head height. The
  agents found this within minutes. Fallen now also means hips low.
- **Swinging past the glass** scored like reaching it when the reward used the
  closest distance ever reached. The reward is now paid every moment the hand
  is close or holding.
- **Balance breaks when the arms learn.** Random changes to the whole network
  moved the legs too. Half the mutations now only touch one limb group's
  outputs (legs, or arms and hand).
- **Lucky runs** looked like skill. Every brain is tested on the same 2–3
  episodes with random shoves, and inconsistent brains score lower.

## Training outside the browser

`body2d.js` and `brain.js` also load in Node (they export with
`module.exports`). Load `vendor/rapier2d.js`, call `RAPIER.init()`, then run
`Body2D.evaluate(RAPIER, 'walk', evolution.population, evolution.generation)`
and pass the result to `evolution.tell(...)`. That's how `starters.js` was made.
