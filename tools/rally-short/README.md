# Rally Shorts (the Short 05 bar)

Build scripts for the UnitedSets rally Shorts. The rules live in `.claude/skills/pro-ad-video/SKILL.md`, section 0b. Read that first.

| File | What it does |
|---|---|
| `track.py` | Runs people detection every 5 frames on the rally clip and writes `t_<clip>.json`. |
| `paths.py` | Turns the detections into smoothed near-player and far-player paths (`paths.json`). Seed the far player's start position for each clip. |
| `build_short05.py` | The full edit: cold open, the point with cuts to the hitter, the wide live finish, a slow-mo with the ball ringed, a freeze and push-in with the question, word-by-word captions, voices, sound design, loudness, and the QC sidecar. |
| `make_sfx.py` | Synthesises the riser, sub-drop, heartbeat and applause effects. |
| `thumbs_short05.py` | Two 1080×1920 thumbnails. Run with `python3.13`: the system PIL is broken here. |

The scripts were written in a session scratchpad, so their paths point there:
- source clip `r10/r10.mp4`
- voice lines `r10/vo/*.wav` plus `words.json` (faster-whisper word timings)
- the logo and base effects in `us/`

Copy one, then change the paths, the shot list, `BALL` (the ball path read off a grid sheet), the cue sheet and the text for the next rally.
Every render goes through `tools/video-qc/qc.py` before it is shown to anyone.
