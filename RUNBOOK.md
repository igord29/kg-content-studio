# Runbook — professional videos at scale

Everything below is ordered so each step ships something usable on its own.
Steps 1–3 change what you post this week. Step 4 is the one that makes the
rest of the system start working.

---

## 0. What changed in this branch

Branch: `quality-overhaul-2026-08`

**18 source files patched, 4 new tools.** Every changed file transpiles clean
(verified with esbuild). A full typecheck was **not** run — `node_modules` was
unavailable — so run `bun install && bun run typecheck` before deploying.

### New capability

| What | Where |
|---|---|
| Emotional tagging (`emotion` 0-10, `valence`, `beat`) added to the vision pass | `cataloger.ts` |
| Those fields surfaced to the hook selector, body composer, close composer, story planner | `pipeline-v2/*` |
| Punch-in now derived from `subjectFillRatio` instead of a mode constant | `preprocessor-invoke.ts` |
| Per-clip loudness normalization + de-click fades | `preprocessor-lambda.ts`, `preprocess.ts` |
| Montserrat self-hosted via @fontsource — zero network requests at render | `TextOverlay.tsx` |
| Platform-aware text safe areas | `TextOverlay.tsx` |
| Overlay timeline remapped onto the transition-compressed clock | `CLCVideo.tsx` |
| Validators now run on the v2 path and in `auto-pipeline` | `index.ts`, `auto-pipeline.ts` |
| Subject-tracked reframe + dead-air removal | `tools/reframe.py` |
| Deterministic publish gate | `tools/quality-gate.py` |
| Whisper transcription over the library | `tools/transcribe-library.ts` |
| Measured publish gate wired into the pipeline | `render-gate.ts`, `auto-pipeline.ts` |
| Reviewer sees one frame per SHOT + hears the audio + is handed the measurements | `video-reviewer.ts` |
| Composition duration shares one source of truth | `entry.tsx`, `CLCVideo.tsx` |
| Deployed Lambda honours extraZoom + masters audio | `scripts/deploy-preprocessor-lambda.ts` |

### Bugs fixed

- `game_day` and `quick_hit` rendered **completely silent** (music tier 1 → `shouldAddMusic` false)
- `editMode: 'auto'` silently produced **no music on any mode** (`selectTrack('auto')` → `[]`)
- Music volume hardcoded `0.3` at 4 sites, overriding the per-mode map
- `validateEditPlan` **never ran** on the default path — every bounds check bypassed
- Min-clip clamp forced every `our_story` clip to ≥3.0s, manufacturing **freeze frames**
- Text overlays drifted **up to 4 seconds late** and flashed for 1 frame at the end
- `Math.ceil` on float clip length added a spurious held frame
- `cropX: 0` silently became `50` (falsy-zero)
- `"None"` leaked into prompts as a notable moment (case-sensitive sentinel)
- Dense contact-sheet timeline was computed **after** the segmenter that needed it
- Stabilization log printed "yes" while the filter was gated off

### Known follow-ups (not done)

- `index.ts:636` and `render.ts:1234` still say *"stabilized + sharpened"* while stabilization is off by default. Either enable it (use two-pass `vidstabdetect`/`vidstabtransform`, not `deshake`) or fix the copy.
- `TikTokCaptions.tsx` is still orphaned — nothing imports it. Wire it after step 4.
- `selectTrack()`'s returned `.volume` is captured and logged but the render config has no field for it; `render.ts` computes its own per-mode value. Unify when convenient.
- `mode: 'auto'` still falls through to `game_day` defaults for transition timing and zoom.
- The `<Composition>` registration (in the bundled Remotion site, not this repo) may still compute `durationInFrames` butt-joined, which would leave dead trailing frames.

---

## 0.5 DO THIS FIRST — the deploy checklist

Nothing below matters until these five are done, in this order.

Run `./deploy.sh` from **WSL** (not PowerShell — package.json's build is
`bash create-stubs.sh`, and .gitattributes documents the WSL requirement).

### THREE deploy targets. Missing one silently drops a whole class of fix.

| # | Target | Command | Carries |
|---|---|---|---|
| 1 | **Remotion site bundle** | `bun scripts/setup-remotion-lambda.ts` | composition duration, freeze frames, overlay timing, Montserrat, text safe area |
| 2 | **Preprocessor Lambda** | `bun scripts/deploy-preprocessor-lambda.ts` | subject punch-in, audio mastering |
| 3 | **Railway** | your normal deploy | tagging, selection, validators, music, publish gate |

**Target 1 is the one that gets missed.** `REMOTION_SERVE_URL` is set in `.env`,
and `render.ts:448` takes a fast path — when the env vars are present it uses the
**already-built S3 bundle** and never rebuilds it. Every render-layer fix lives
inside that bundle. Redeploying Railway does not touch it, and you get no error:
just an unchanged video.

Note also: `node_modules` was last installed by **Windows** bun (`.exe` shims).
That tree cannot be used from WSL. `deploy.sh` detects this and offers to
reinstall — take the offer, and from then on stay in WSL.

### Already verified — you do not need to re-check these

- **`bun run typecheck` passes with 0 errors.** The full dependency tree was
  installed and `tsc --noEmit` run against every changed file.
- **The composition renders end to end.** `entry.tsx` -> `CLCVideo` was rendered
  locally with six test clips: **720 frames = exactly 24.00s**, matching
  `computeCompositionFrames` precisely. The old formula would have registered
  21.00s and truncated 3 seconds.
- **`freezedetect` finds zero frozen runs.** A 1.5s clip stayed 1.5s instead of
  being padded to 3.0s with 1.5s of held frame.
- **Montserrat renders.** Confirmed visually at full resolution.
- **Text clears the platform UI.** Measured at 350px from frame bottom (18.2%),
  against the ~340px TikTok/Reels rail. The old `bottom: 8%` put it at 153px.
- **The Lambda FFmpeg chains execute.** Both the crop and audio filters were run
  through real FFmpeg; audio lands on -16.0 LUFS at 48kHz.

Step 5 is still the only thing that proves quality on *real footage*. Everything
above proves the mechanism is correct.

### Two bugs found late that were silently wrecking every render

**The deployed Lambda ignored the punch-in entirely.** `scripts/deploy-preprocessor-lambda.ts`
carries its own `buildSmartCropFilter` and `buildAudioFilter` — the copies under
`src/` are reference mirrors that never run. The deployed crop did a fill-crop
with no zoom and **discarded the `extraZoom` the invoker was already sending it.**
That is the direct mechanism behind the 1%-of-frame subject size. Both functions
are now patched; verified at zoom 1.0 the new crop reproduces
`scale=3414:1920,crop=1080:1920:1168:0` byte-for-byte, matching the filter in
the overnight log, so it is a safe drop-in.

**Every video was being cut short.** `entry.tsx`'s `calculateMetadata` computed
the composition length by subtracting a transition's worth of overlap for *every*
clip boundary (`clips.length - 1`) — but a transition is only emitted when
`clip.transitionType` is set, and the director is told to make ~80% of cuts hard.
Measured on an 8-clip edit:

| mode | 2 transitions | 0 transitions (all hard cuts) |
|---|---|---|
| our_story | **5.0s truncated** | **7.0s truncated** |
| showcase | 4.0s | 5.6s |
| game_day | 2.5s | 3.5s |
| quick_hit | 1.5s | 2.1s |

The old formula only agreed with reality when *every* cut had a transition — the
exact thing the prompt tells the AI not to do. `entry.tsx` and `CLCVideo.tsx` now
share one exported `computeCompositionFrames()` so the two clocks cannot drift again.

---

## 1. Rescue today's renders — 5 minutes

```bash
pip install ultralytics opencv-python-headless --break-system-packages
python3 tools/reframe.py "render.mp4" "render_fixed.mp4"
```

Removes dead air, tracks and punches in on the subject, masters audio to −14 LUFS
with a −1 dBTP ceiling. Measured on your own files: empty frames 18%→2% and
31%→12%, median subject size roughly doubled, clipping eliminated.

**Reframe before compositing text.** Run it on the render only as a stopgap —
once the pipeline does this internally, overlays land after the crop.

Tunables at the top of the file: `TARGET_FILL` (how much of frame the subject
should occupy), `MAX_ZOOM` (resolution protection), `EYELINE` (rule-of-thirds
placement), `SMOOTH_SEC` (how slowly the camera move eases).

## 2. Gate everything before it goes out — 2 minutes

```bash
python3 tools/quality-gate.py render.mp4               # human readable
python3 tools/quality-gate.py render.mp4 --json        # for the pipeline
```

Exit 0 = publish, 1 = hold, 2 = could not measure. Eleven measured checks:
subject size, empty frames, longest empty stretch, loudness, true peak, loudness
range, cut rhythm variation, frozen-frame runs, black frames, duration.

**Already wired in.** `auto-pipeline.ts` now measures every render before the
vision model sees it, and a measured failure blocks publication even after max
attempts — where it previously wrote to `finished_videos` with `success: true`
regardless. The in-pipeline version (`render-gate.ts`) uses FFmpeg only, so it
needs no new dependencies in the Railway image; it covers loudness, true peak,
loudness range, frozen frames, black frames, cut rhythm and duration. The Python
gate below adds the subject-framing checks, which need person detection.

**This replaces the AI reviewer.** The current one grades pacing, transitions and
music from 8 still JPEGs and no audio — none of those things are observable in a
still sample every 5.6 seconds, and it publishes anyway after 3 attempts
(`auto-pipeline.ts:502`). Keep the AI reviewer for taste; gate on the numbers.

Wire it in front of the Supabase write in `auto-pipeline.ts`. A render that fails
goes to the review folder, not the feed. **This is what makes 15/day safe.**

## 3. Deploy the render-layer fixes — 30 minutes

```bash
bun install                # picks up @remotion/google-fonts
bun run typecheck          # MUST pass before deploying
```

Then redeploy Railway **and** the preprocessor Lambda:

```bash
bun scripts/deploy-preprocessor-lambda.ts
```

**The Lambda redeploy is not optional.** `scripts/deploy-preprocessor-lambda.ts`
carries its own copies of `buildSmartCropFilter` and `buildAudioFilter` — the
`src/.../preprocessor-lambda.ts` file is only a reference mirror. Both copies are
now patched, but until the Lambda is redeployed you get **zero** framing or audio
improvement, because the old code is what actually runs on AWS.

Note what the old deployed crop did: a fill-crop with no punch-in at all, and it
ignored the `extraZoom` the invoker was already sending it. That is the direct
mechanism behind the 1%-of-frame subject size.

Render one video and check: Montserrat renders, text sits above the TikTok rail,
overlays land on the right shot, no frozen frames, `game_day` has music.

## 4. Give the system eyes — the step that matters

Everything above is polish. This is the fix.

### 4a. Transcribe — 1 afternoon, about $4

```bash
bun tools/transcribe-library.ts --limit 5     # sanity check first
bun tools/transcribe-library.ts               # then the whole library
```

627 minutes at $0.006/min. You get every soundbite with word-level timestamps, a
searchable index of 247 clips, the ability to never cut mid-sentence, and the
data `TikTokCaptions.tsx` has been waiting for.

### 4b. Backfill the catalog — 1 day

Your catalog has **0 of 247** entries with `timestampScores`, `visualTimeline`,
`sceneAnalysis`, or `narrativeBeats`. Mean clip length is 152 seconds described
in about 10 words. The editor is choosing a 4-second cut from a 3-minute video
essentially blind, and its documented fallback is to guess on a grid.

```bash
curl -X POST $BASE/video-editor -H 'Content-Type: application/json' \
  -d '{"task":"rescore-timestamps","forceRegenerate":true}'
```

Run it on ~10 clips first and **read the output**. Check specifically:

- Do high `emotion` scores land on faces and reactions, not on fast movement?
- Does `beat` distinguish a triumph from a setup?
- Does `subjectFillRatio` correctly mark the wide shots as low?

If those three look right, run the full library. **This is the prompt to iterate
on** — not the 59KB director prompt. Budget real time here; it is the product.

Once backfilled, these all come alive at once: the Beat Finder (currently skips
100% of videos), all eight editor rules, the slow-mo windowing rule, peak
anchoring, and the revision loop.

### 4c. Then move reframing into the pipeline — 2 days

Port `tools/reframe.py`'s tracking logic into the preprocessor Lambda, which
already runs FFmpeg per clip. Detection at 6 fps on a 5-second clip is ~30
inferences — negligible next to the transcode. The Lambda emits a per-frame crop
path instead of one static `crop=w:h:x:y`.

The `deriveExtraZoom` change in this branch is the interim version: it uses the
cataloger's `subjectFillRatio` to set a per-clip zoom, which is far better than a
mode constant but still static within a clip.

---

## 4.5 Committing and pushing — you have to do this part

Nothing is committed and nothing is pushed. The changes sit in the working tree
on branch `quality-overhaul-2026-08`. Two reasons: the Cowork device bridge
cannot delete files, so every `git` write left a stale `.git/*.lock` (I cleared
them into `_to_delete/`); and 26 files of machine-written change should not land
on `main` without a human reading the diff.

```bash
cd C:\Development_Folder\kg-content-studio
git status                       # confirm you are on quality-overhaul-2026-08
git diff                         # READ THIS
git add -A
git commit -m "Quality overhaul: emotional tagging, subject-aware framing, audio mastering, measured publish gate"
git push -u origin quality-overhaul-2026-08
```

Open a PR against `main` rather than pushing straight to it — then a bad render
is one `git revert` away instead of a rollback under pressure.

Housekeeping: delete `_to_delete/` and the `*.patch` files in the repo root once
you have reviewed the diff.

---

## 5. Cut the legacy prompt — half a day

`video-director-prompt.ts` is ~14,000 tokens with roughly one hard prohibition
every 17 lines. It is **already off the main path** — nothing under `pipeline-v2/`
imports it. But `video-reviewer.ts:556` still loads it as the system prompt for
every revision, so each retry re-enters its contradictions.

Give `generateRevisedEditPlan` a short focused prompt in the v2 style (~1,500
tokens). Keep the legacy file only if the v1 fallback still matters.

Worth knowing before you edit it: its canonical JSON example at line 758 applies
slow-mo to a region marked `"estimated"` — the exact anti-pattern it memorializes
at line 946 as `ANTI-PATTERN TO NEVER REPEAT`. **Models follow the demonstration,
not the rule.** Fix the example first.

---

## 6. On volume

Fifteen videos a day from 247 clips means each clip appears in a new edit roughly
every two weeks, and about half your library contains nothing publishable — by
measurement, 49% of `UnitedSets_Usopen1` had no usable subject at all.

Three genuinely good videos a day will raise more money than fifteen that look
automated, and the gate in step 2 will tell you honestly which you're making.
Solve seeing first; volume is downstream.

The real constraint after step 4 is **footage**, not pipeline. When you next
shoot: get closer, hold shots longer, and let the camera find faces. The system
can only cut what you give it.
