# HANDOFF — KG Content Studio quality overhaul

**For:** whoever picks this up next (Claude Code or a human).
**From:** a Cowork session, 2026-08-06 → 08-12.
**Branch:** `quality-overhaul-2026-08` — **26 files changed, nothing committed, nothing pushed.**
**Read `RUNBOOK.md` next** — it has the operational steps. This file is the context.

---

## 1. TL;DR

Ian spent months trying to get professional-looking videos out of this pipeline and
kept getting amateur output. A previous Claude conversation diagnosed it as
"the system slices chronologically, there's no story arc." **That diagnosis was
wrong** — `pipeline-v2/` already does hook → body → close and it runs by default.

The real diagnosis, from measuring the actual rendered files:

| | `UnitedSets_Usopen1` | `out (1)` | `out (2)` |
|---|---|---|---|
| frames with **no person at all** | 9% | 18% | **31%** |
| frames where the largest person is **under 2% of frame** | **70%** | 37% | 46% |
| **median subject size when present** | **1.0% of frame** | 13.4% | 7.2% |
| true peak (anything > 0 is clipping) | **+0.1 dBFS** | **+0.1** | **+0.2** |
| integrated loudness (target −14) | −12.7 | −15.3 | −11.9 LUFS |

Half of `UnitedSets_Usopen1` (23.0 of 46.7 seconds) contains no usable subject.
The median frame shows a child occupying **one percent** of the screen.

**Root cause: the system cannot see.** `catalog-seed.json` has 247 entries,
mean source duration 152 seconds, and **0 of 247** have `timestampScores`,
`visualTimeline`, `sceneAnalysis` or `narrativeBeats`. The editor picks a
4-second cut out of a 3-minute video knowing only ~10 words like
*"Spectators watching tennis practice at a professional venue."* Its documented
fallback (`video-director-prompt.ts:270-277`) is to guess on an even grid. The
empty court at second 19 is what guessing looks like.

Everything below fixes how well the system *executes* a choice. **The catalog
backfill — still not done — is what fixes how it *chooses*.** Do not mistake one
for the other.

---

## 2. What was changed — 6 patches, all applied to the working tree

All `.patch` files are in the repo root. They are already applied; they're kept
so you can read them as a changelog. Delete them once you've reviewed the diff.

### Patch 1 `quality-overhaul.patch` — 23 files
- **Emotional tagging.** `cataloger.ts` `TIMESTAMP_SCORING_PROMPT` now asks for
  `emotion` (0-10, anchored on faces and body language, explicitly independent of
  athletic quality), `valence`, and `beat` (hook|setup|struggle|turn|triumph|
  reflection|community|none). Types widened in `google-drive.ts`.
- **Those fields are consumed.** `pipeline-v2/02-hook-selector.ts` now ranks hooks
  by emotion over actionQuality; `03-body-composer.ts` enforces emotional
  escalation and requires ≥1 body clip at emotion ≥6; `04-close-composer.ts`
  prefers reflection/community with positive valence; `01-story-planner.ts` gets a
  per-video emotion summary. **Adding tags nothing reads was the original bug —
  don't repeat it.**
- **Adaptive sampling.** `chooseInterval()` replaces a flat 10s grid (a 180s clip
  got 18 samples). Capped at 26 frames.
- **Ordering bug.** The dense contact-sheet `visualTimeline` was built *after*
  `generateNamedSegments`, which needed it. Reordered; ~5× more segment boundaries.
- **Framing.** `deriveExtraZoom()` in `preprocessor-invoke.ts` sizes punch-in from
  the cataloger's `subjectFillRatio` (which was computed and read by nothing)
  instead of a per-mode constant.
- **Audio.** Per-clip `loudnorm=I=-16:TP=-1.5:LRA=11` + `aresample=48000` + 15ms
  de-click fades.
- Montserrat loading, platform-aware text safe areas, overlay clock remap,
  min-clip clamp only when a transition exists, `Math.round` not `Math.ceil`,
  `??` not `||` so an explicit `cropX: 0` survives, case-insensitive `"none"`
  sentinel, validators actually run on the v2 path and in auto-pipeline.
- **Bugs fixed:** `game_day` and `quick_hit` rendered **completely silent**
  (music tier 1 → `shouldAddMusic` false); `editMode: 'auto'` yielded no music on
  any mode (`selectTrack('auto')` → `[]`).
- New tools: `tools/reframe.py`, `tools/quality-gate.py`, `tools/transcribe-library.ts`.

### Patch 2 `lambda-fix.patch` — `scripts/deploy-preprocessor-lambda.ts`
**The deployed Lambda has its own copies of `buildSmartCropFilter` and
`buildAudioFilter`.** The files under `src/.../preprocessor-lambda.ts` are
reference mirrors that never execute. The deployed crop did a fill-crop with
**no zoom at all** and silently discarded the `extraZoom` the invoker was already
sending. That is the direct mechanism behind the 1%-of-frame subject.
Verified: at zoom 1.0 the new crop reproduces `scale=3414:1920,crop=1080:1920:1168:0`
byte-for-byte, matching the filter in `OVERNIGHT_REPORT.md`.

### Patch 3 `gate-and-duration-fix.patch` — 4 files
- **`render-gate.ts` (new).** Deterministic publish gate, FFmpeg only, no new
  deps. Seven checks: loudness, true peak, loudness range, frozen frames
  (`freezedetect`), black frames (`blackdetect`), cut-rhythm CV, duration.
  Wired into `auto-pipeline.ts` *before* the vision model, and a measured failure
  now **blocks publication even after max attempts** — it previously wrote to
  `finished_videos` with `success: true` regardless of score.
- **Every video was being truncated.** `entry.tsx` computed composition length by
  subtracting a transition's overlap for *every* clip boundary
  (`clips.length - 1`), but transitions only exist where `transitionType` is set
  and the prompt says make 80% of cuts hard. Measured on an 8-clip edit:

  | mode | 2 transitions | all hard cuts |
  |---|---|---|
  | our_story | **5.0s cut off** | **7.0s cut off** |
  | showcase | 4.0s | 5.6s |
  | game_day | 2.5s | 3.5s |

  `entry.tsx` and `CLCVideo.tsx` now share one exported `computeCompositionFrames()`.

### Patch 4 `selfhost-font.patch`
`@remotion/google-fonts` fetches from `fonts.gstatic.com` at render time — measured
**45-90 requests per render**, and when unreachable the render throws
`NetworkError` and **dies rather than falling back**. Switched to
`@fontsource/montserrat`, whose `.woff2` files live in `node_modules` and get
inlined by the bundler. Zero network requests for type.

### Patch 5 `reviewer-upgrade.patch`
`video-reviewer.ts` graded pacing, transitions and music from **8 uniform stills
and no audio** — none of which are observable in a still every ~5.6s. Now:
detects cuts, derives shots, samples the **middle** of each shot (sampling *at* a
cut gives a dissolve blend that represents neither side), always anchors the first
and last frame (a 4-shot video was sampling first at 9s — reviewing a social video
without ever seeing its hook), pulls a Whisper transcript, and is handed the gate's
measurements with an instruction not to re-estimate them.

### Patch 6 `catalog-durability.patch`
`PERSISTENT_DIR = fs.existsSync('/data') ? '/data' : process.cwd()`. With no
Railway volume mounted, the enriched catalog lands on an **ephemeral filesystem**.
`saveCatalog()` uploaded a copy to Drive but **nothing ever read it back** —
`loadExistingCatalog()` checked the local file then fell through to the bundled
seed. So a redeploy silently reverted the library to the un-enriched 247-entry
seed, logging `Loaded 247 entries from bundled catalog seed` — which looks normal.
Added `fetchLatestCatalogFromDrive()` and `hydrateCatalogFromDrive()`, awaited once
at the agent handler chokepoint (`loadExistingCatalog` is sync with 24 call sites,
so it cannot download itself).

---

## 3. Verification status — read this before trusting anything

**Proven by execution:**
- `bun run typecheck` → **0 errors**, full dependency tree installed.
- The composition **renders end to end**. `entry.tsx` → `CLCVideo` with six test
  clips produced **720 frames = exactly 24.00s**, matching
  `computeCompositionFrames`. The old formula would have registered 21.00s.
- `freezedetect` finds **zero** frozen runs; a 1.5s clip stayed 1.5s instead of
  being padded to 3.0s.
- Montserrat renders — confirmed visually at full resolution.
- Text measured at **350px from frame bottom** (18.2%) vs the ~340px TikTok rail.
  Old `bottom: 8%` put it at 153px, under the UI.
- Both Lambda FFmpeg chains executed through real FFmpeg; audio lands on −16.0
  LUFS at 48kHz. `deriveExtraZoom` verified across fill ratios.
- `render-gate.ts` and `tools/quality-gate.py` tested on the real renders:
  `out (2)` fails 6 checks, the reframed version fails 1.
- `tools/reframe.py` measured on the real files: empty frames 18%→2% and
  31%→12%, median subject size roughly doubled, clipping eliminated.

**NOT verified — treat as unproven:**
- **No render has been produced from real footage.** All improvements are
  mechanism, not outcome.
- **The emotion prompt has never been called against a model.** It is written but
  untested. This is where the quality actually comes from.
- Nothing has been deployed. As of the last check, `bun install` had not re-run
  (`@fontsource/montserrat` absent from `node_modules`).
- The Drive catalog restore path has not been exercised against a real Drive.

---

## 4. What's left, in priority order

1. **Deploy.** `./deploy.sh` from WSL. See the trap in §5 — there are **three**
   deploy targets and missing one silently drops a whole class of fix.
2. **Render one video** into `C:\Development_Folder\output_kg_content_studio\`
   and run `python3 tools/quality-gate.py <render>.mp4`. First real evidence.
3. **Commit and push.** Nothing is committed. Open a PR, don't push to `main`.
4. **Restore `google-cloud-service-account.json`.** `.env`'s
   `GOOGLE_APPLICATION_CREDENTIALS` is a relative path to a file that does not
   exist on disk. Correctly gitignored — do **not** commit it. Anything that
   touches Drive from the local machine fails without it.
5. **Transcribe.** `bun tools/transcribe-library.ts --limit 5` then the full run.
   ~627 minutes ≈ $4. Unlocks soundbites, a searchable library, and the
   `CaptionWord[]` that `TikTokCaptions.tsx` has been waiting for.
6. **Backfill the catalog** — the actual fix. Confirm `/data` is mounted first
   (§5). Run on ~10 clips and **read the output**: does high `emotion` land on
   faces and reactions rather than fast movement? Does `beat` distinguish a
   triumph from a setup? Does `subjectFillRatio` mark the wide shots low? Tune the
   prompt here, expect 2-3 rounds, *then* run the full library.
7. Move subject tracking into the preprocessor Lambda (port `tools/reframe.py`).
8. Cut the legacy 14K-token prompt off the revision path.

---

## 5. Traps that will waste your time

**THREE deploy targets. Missing one produces no error, just an unchanged video.**

| Target | Command | Carries |
|---|---|---|
| Remotion **site bundle** | `bun scripts/setup-remotion-lambda.ts` | duration fix, freeze frames, overlay timing, Montserrat, text safe area |
| Preprocessor **Lambda** | `bun scripts/deploy-preprocessor-lambda.ts` | subject punch-in, audio mastering |
| **Railway** | normal deploy | tagging, selection, validators, music, gate |

The site bundle is the one that gets missed: `REMOTION_SERVE_URL` is set in
`.env` and `render.ts:448` takes a fast path that uses the **already-built S3
bundle** without rebuilding it. Redeploying Railway does not touch it.

**Use WSL, not PowerShell.** `package.json` build is `bash create-stubs.sh`, and
`.gitattributes` documents it: *"They run under bash (WSL locally, Linux on…)"* —
added after CRLF endings caused `$'\r': command not found`.

**`node_modules` was last installed by Windows bun** (57 `.exe` shims, win32
native binaries). That tree cannot be used from WSL. `deploy.sh` detects it and
offers to reinstall. Pick one environment and stay there — mixing them produces
errors that look like broken code.

**Check `/data` is mounted on Railway before the backfill.** No volume is
configured anywhere in the repo. Without it, patch 6's Drive restore is your only
protection, and you'd rather have both.

**Don't double-click `.ts` files on Windows.** `.ts` is also the MPEG Transport
Stream extension, so Windows offers to install a media app or code editor. These
are commands to run under `bun`.

**`git` writes from the Cowork device bridge leave stale `.git/*.lock` files**
(the mount can't delete). They were cleared into `_to_delete/`. If git complains
`Unable to create index.lock: File exists`, delete `.git/index.lock`.

**Delete `_to_delete/` and the `*.patch` files** once the diff is reviewed.

---

## 6. Known-deferred, deliberately not done

- `TikTokCaptions.tsx` is fully implemented and **never imported** — nothing
  produces the `CaptionWord[]` it needs. Wire it after transcription (§4.5).
- The 14K-token `video-director-prompt.ts` is off the main path (nothing in
  `pipeline-v2/` imports it) but is still the system prompt for
  `generateRevisedEditPlan`, so every quality retry re-enters its contradictions.
  Its canonical JSON example at line 758 demonstrates the exact anti-pattern it
  forbids at line 946 — **fix the example before the rule; models follow demos.**
- Stabilization is off by default while `index.ts:636` and `render.ts:1234` both
  claim *"stabilized + sharpened"*. Either enable it (two-pass
  `vidstabdetect`/`vidstabtransform`, not `deshake`) or fix the copy.
- Music is four hardcoded MP3s on **Shotstack's public demo bucket** — the sample
  assets that ship with a rendering SaaS this project no longer uses. Selection is
  deterministic per mode, so every game-day video gets the same 128 BPM track.
  `MusicTrack.bpm` is populated and read by nothing.
- `selectTrack()` returns a per-mode `.volume` that every caller discards;
  `render.ts` computes its own. Unify when convenient.
- `saveCatalog()` uses `files.create`, so a backfill with `SAVE_INTERVAL = 5`
  creates ~50 dated JSON files in Drive. Harmless but messy.
- The Railway URL served the **Agentuity default template** on `/` and `/health`
  throughout this session. Resolve before trusting any UI-driven test.

---

## 7. Tools built this session

| Tool | Use |
|---|---|
| `tools/reframe.py` | Subject-tracked reframe + dead-air removal + loudness master. Runs on any finished MP4. `python3 tools/reframe.py in.mp4 out.mp4` |
| `tools/quality-gate.py` | Full 11-check gate incl. person detection. `--profile draft` for a looser bar. Exit 0/1/2. |
| `src/agent/video-editor/render-gate.ts` | The in-pipeline subset — FFmpeg only, no torch in the Railway image. Already wired. |
| `tools/transcribe-library.ts` | Whisper over the library, writes `transcripts/` and folds soundbites into the catalog. |
| `deploy.sh` | Ordered deploy with checks. WSL. |

**Verify your own work with numbers, not opinion.** Everything the old AI reviewer
guessed at is measurable with ffmpeg and a 5MB detection model. If you change the
render path, run `tools/quality-gate.py` before and after and show the delta.

---

## 8. The one-paragraph version

The render layer is now correct and proven; the selection layer is still blind.
Deploy the three targets, render one video, and measure it. Then spend real time
on the catalog backfill and the emotion prompt — that is the only remaining work
where judgment matters more than code, and it is what decides whether this
produces videos worth posting.
