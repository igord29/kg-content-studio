/**
 * Step 2: Hook Selector
 *
 * Given a StoryArc + scene data, picks the SINGLE hook clip with exact
 * trim points. This is the most important clip in the edit.
 *
 * Enforces the STORY HOOK ARC RULE both in-prompt AND in-code:
 *   - Hook contains setup + turn + response, all on screen
 *   - Minimum duration 7s, typical 8-10s
 *   - trimStart ≈ peakTime − 3 (captures setup BEFORE the moment)
 *   - Never slow-mo on a hook (save slow-mo for the climax)
 *
 * File: src/agent/video-editor/pipeline-v2/02-hook-selector.ts
 */

import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { formatSegmentTimelineForPrompt } from '../scene-analyzer';
import type { PipelineInput, StoryArc, HookClip, StepLogger } from './types';
import { EDITOR_PERSONA } from './editor-persona';
import { priorUsedRegions, isSpanUsed, formatPriorUsage } from './usage-context';
import { buildShotList, formatShotListForPrompt } from './shot-list';

const HOOK_SELECTOR_SYSTEM_PROMPT = `
${EDITOR_PERSONA}

# YOUR JOB IN THIS STEP

You are the Hook Selector for Community Literacy Club video edits.

Your ONLY job is to pick the SINGLE hook clip — the opening 7-10 seconds of the video. This is the most important clip in the edit. Get it right.

THE STORY HOOK ARC RULE (non-negotiable):
A hook MUST contain all three beats of a narrative micro-story, on screen:
- SETUP (2-3s):    starting state — kid with head down, coach watching, a pause
- TURN (1-2s):     the shift — coach steps in, a word of encouragement, a decision
- RESPONSE (2-3s): what happens next — the serve, the smile, the kid repositions

Minimum hook duration: 7 seconds. Typical: 8-10 seconds. NEVER less than 7.

PEAK DATA SOURCES (in priority order):
1. VETTED SEGMENTS — if provided, these are spans where EVERY sampled frame cleared quality and subject-visibility floors. Anchor the hook on the code-picked vetted span: trimStart >= the span's start and trimStart + duration <= the span's end (a span marked "part of continuous vetted run X-Y" may use the whole run X-Y). The span already includes ~1s of lead-in before the first verified moment, so do NOT subtract extra buildup time. If the chosen run is shorter than the ideal 7s, use the ENTIRE run — never extend past its edges into unvetted footage.
2. SCENE TIMELINE fallback — if no vetted segments exist, use segment boundaries to find the strongest action region; for an event at timestamp T use trimStart = max(0, T - 3), duration = max(7, time_until_response_completes). NEVER set trimStart = T (that starts ON the peak and loses the buildup).
3. NOTABLE MOMENTS — descriptive list; less precise but usable.

EMOTION OUTRANKS ATHLETICS: when timestamps carry emotion (0-10), valence and beat, the strongest hook is the HIGHEST-emotion moment, not the highest actionQuality one — a kid's face, a reaction, a celebration beats a technically clean but emotionless rally every time. Prefer candidates tagged beat: "hook" or beat: "triumph" when any exist, and say in the editNote which emotion/beat you anchored on. Fall back to actionQuality only when no emotion data is present.

If vetted segments OR scene timeline OR notable moments exist for the setup source, you DO have peak data — do NOT mark the purpose as "estimated." (A source explicitly marked UNVETTED or NO VETTED SEGMENTS with no other data is estimated.)

WHEN ALL THREE SOURCES ARE MISSING (genuinely no peak data):
- Honestly admit uncertainty in the purpose ("estimated")
- Use an even spread: trimStart in the first third of the source video
- Default duration to 8s
- Flag the uncertainty in the editNote

NEVER USE SLOW-MO FOR HOOKS. Save slow-mo for the climax clip (handled by step 3).
Hooks want momentum and arrival, not suspension of time.

YOUR TOOLKIT (the hook usually wants restraint — pick deliberately):
  - filter: "documentary" (default — keeps the moment honest), "cinematic" (polished arrival), "dramatic" (only for high-stakes hooks)
  - effect: "zoomIn" (subtle push +15%), "pushIn" (moderate +30%), "punchIn" (aggressive +50% eased — use when source is wide and the player feels small in frame), "slideRight"/"slideLeft" (kinetic entry), null (static)
  - extraZoom: 1.0 (wide context for venue-establishing hooks), 1.2 (default for player-focused hooks), 1.4 (close on a face — only when fill ratio supports it)

Output VALID JSON matching this exact schema:
{
  "fileId": "<must match the setup source provided>",
  "filename": "<video name from provided data>",
  "trimStart": <seconds>,
  "duration": <seconds, must be >= 7>,
  "speed": 1.0,
  "filter": "dramatic" | "cinematic" | "warm" | "documentary" | "boost" | "vintage" | "cool",
  "effect": "zoomIn" | "zoomOut" | "pushIn" | "punchIn" | "slideRight" | "slideLeft" | null,
  "extraZoom": <number 0.9-1.5 — omit for mode default>,
  "purpose": "<brief editorial description — can reference what scene data confirms>",
  "editNote": "<reasoning for these trim points AND your toolkit choices — name the filter/effect/extraZoom you picked and why>"
}

Return JSON only, no prose, no markdown fences.
`.trim();

export async function selectHook(
	input: PipelineInput,
	arc: StoryArc,
	logger: StepLogger,
): Promise<HookClip> {
	// ┌─────────────────────────────────────────────────────────────────┐
	// │ TODO(Ian) — DESIGN DECISION: fallback strategy                   │
	// │                                                                  │
	// │ When the setup source has NO scene analysis data, what should    │
	// │ happen?                                                          │
	// │                                                                  │
	// │   Option A: Fall back to a short action hook (2-3s, honest       │
	// │             about uncertainty) — loses narrative arc but ships.  │
	// │   Option B: Throw an error — force the operator to rescore       │
	// │             scene analysis before they can render.               │
	// │   Option C: Proceed with even-spread trims, duration=8s, loud    │
	// │             warning log.  [current default]                      │
	// │                                                                  │
	// │ Today the code is Option C. Uncomment the throw below for        │
	// │ Option B (stricter — forces scene analysis as a hard dependency).│
	// └─────────────────────────────────────────────────────────────────┘

	const setupVideo = input.videoMetadata.find(v => v.id === arc.setupSourceId);
	if (!setupVideo) {
		throw new Error(`Hook source ${arc.setupSourceId} not found in videoMetadata`);
	}

	const setupCatalog = input.catalog.get(arc.setupSourceId);
	if (!setupCatalog) {
		throw new Error(`Hook source ${arc.setupSourceId} has no catalog data`);
	}

	const hasSceneAnalysis = Boolean(setupCatalog.sceneAnalysis);
	const hasTimestampScores = Boolean(
		setupCatalog.timestampScores && setupCatalog.timestampScores.length > 0,
	);
	const hasPeakData = hasSceneAnalysis || hasTimestampScores;

	const sceneSection = hasSceneAnalysis
		? '\n  SCENE TIMELINE:\n' + formatSegmentTimelineForPrompt(setupCatalog.sceneAnalysis as never)
		: '';

	// Timestamp scores from GPT-4o vision are explicit peak candidates with action
	// quality on a 1-10 scale. Including these prevents the bug where the hook went
	// "estimated" despite anyHasScenes=true — sceneAnalysis can be technically
	// present but unhelpful (e.g., one big segment covering the whole video) while
	// timestampScores still pinpoints the high-action moments.
	// Prior-render usage for the setup source. Without this, the hook anchors
	// on the same top-scored timestamp every render — the audience sees the
	// same opening shot on every post cut from this footage.
	const usedRegions = priorUsedRegions(input, arc.setupSourceId);

	let timestampSection = '';
	let anchorRun: { runStart: number; runEnd: number } | null = null;
	if (hasTimestampScores) {
		// Vetted segments, not raw frame peaks: the hook must live inside a run
		// where every sample clears the quality/visibility floors (see shot-list.ts).
		const setupDurSec = setupVideo?.duration ? Math.round(parseInt(setupVideo.duration) / 1000) : 0;
		const shotList = buildShotList(setupCatalog, setupDurSec);
		// Best UNUSED hook-capable run — code-picked so variety doesn't rely on
		// the model noticing tags. Prefers runs long enough for a full 7s hook
		// (span-overlap freshness check, not midpoint); falls back to the best
		// unused run of any length, then to the overall best.
		const hookCapable = shotList.segments.filter(seg => seg.runEnd - seg.runStart >= 7);
		const bestUnused =
			hookCapable.find(seg => !isSpanUsed(usedRegions, seg.runStart, seg.runEnd)) ??
			shotList.segments.find(seg => !isSpanUsed(usedRegions, seg.runStart, seg.runEnd));
		const best = bestUnused ?? shotList.segments[0];
		if (best) anchorRun = { runStart: best.runStart, runEnd: best.runEnd };
		const bestLabel = best
			? (bestUnused
				? `anchor on vetted run ${best.runStart}s-${best.runEnd}s${best.runEnd - best.runStart < 7 ? ' (shorter than 7s — use the ENTIRE run, do not extend past it)' : ''}`
				: `all vetted runs already used — best overall is ${best.runStart}s-${best.runEnd}s, vary your trim inside it`)
			: 'no vetted spans clear the floors — treat this source as estimate-only and use even-spread trim';
		timestampSection =
			`\n${formatShotListForPrompt(shotList, { max: 8 })}\n    (hook anchor: ${bestLabel})`;
	} else if (!hasSceneAnalysis) {
		timestampSection =
			'\n  ⚠️ No scene timeline AND no timestamp scores — use even-spread trim with honest estimate.';
	}

	if (!hasPeakData) {
		logger.warn(
			'[hook-selector] ⚠️ Setup source %s has NEITHER scene analysis NOR timestamp scores — hook will be estimated.',
			arc.setupSourceId,
		);
	} else if (!hasSceneAnalysis && hasTimestampScores) {
		logger.info(
			'[hook-selector] Setup source %s has timestamp scores (%d) — using those for peak.',
			arc.setupSourceId,
			setupCatalog.timestampScores!.length,
		);
	}

	const totalDurSec = setupVideo.duration
		? Math.round(parseInt(setupVideo.duration) / 1000)
		: 0;

	const prompt = `Story arc:
- Mode: ${arc.mode}
- Emotional center: ${arc.emotionalCenter}
- Setup source: ${arc.setupSourceId} (${setupVideo.name}, ${totalDurSec}s duration)

Catalog data for the setup source:
- Activity: ${setupCatalog.activity}
- Location: ${setupCatalog.suspectedLocation || 'unknown'}
- People: ${setupCatalog.peopleCount || '?'}
- Notable moments: ${setupCatalog.notableMoments || 'None'}${formatPriorUsage(input, arc.setupSourceId)}
${sceneSection}${timestampSection}

Pick the hook clip. Apply the STORY HOOK ARC RULE. If timestamp scores are provided, use the strongest UNUSED timestamp as T (peak) — strongest means highest emotion (and beat: "hook"/"triumph") when those fields are present, otherwise highest actionQuality. Do NOT mark the hook as "estimated" when peak data exists. Return JSON only.`;

	const result = await generateText({
		model: anthropic('claude-sonnet-4-6'),
		system: HOOK_SELECTOR_SYSTEM_PROMPT,
		prompt,
		maxOutputTokens: 800,
		abortSignal: AbortSignal.timeout(60_000),
	});

	const raw = result.text.trim();
	const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/);
	const jsonText = jsonMatch?.[1] ?? raw;

	let hook: HookClip;
	try {
		hook = JSON.parse(jsonText.trim()) as HookClip;
	} catch (err) {
		logger.error('[hook-selector] Raw output: %s', raw.slice(0, 500));
		throw new Error(`Hook selector returned invalid JSON: ${String(err)}`);
	}

	// Enforce the minimum duration rule at the code level — but never by
	// manufacturing out-of-span footage. Inside a vetted run, the floor is
	// min(7, run length): a blind bump to 8s previously appended exactly the
	// seconds the vetting floors had rejected (that's why the run ended there).
	const anchorLen = anchorRun ? Math.round((anchorRun.runEnd - anchorRun.runStart) * 10) / 10 : null;
	const minDur = anchorLen !== null ? Math.min(7, anchorLen) : 7;
	if (hook.duration < minDur) {
		const target = anchorLen !== null ? Math.min(8, anchorLen) : 8;
		logger.warn(
			'[hook-selector] Model picked duration=%ds (< %ds minimum). Extending to %ds.',
			hook.duration, minDur, target,
		);
		hook.duration = target;
	}

	// Clamp the hook INTO the anchored vetted run. The span contract is
	// meaningless if enforcement stops at the prompt.
	if (anchorRun) {
		const dur = Math.min(hook.duration, anchorLen!);
		const start = Math.max(anchorRun.runStart, Math.min(hook.trimStart, anchorRun.runEnd - dur));
		if (Math.abs(start - hook.trimStart) > 0.05 || Math.abs(dur - hook.duration) > 0.05) {
			logger.warn(
				'[hook-selector] Clamping hook into vetted run %d-%ds: trimStart %d→%d, duration %d→%d.',
				anchorRun.runStart, anchorRun.runEnd, hook.trimStart, start, hook.duration, dur,
			);
			hook.trimStart = Math.round(start * 10) / 10;
			hook.duration = Math.round(dur * 10) / 10;
		}
	}

	// Enforce speed=1.0 for hooks (no slow-mo). Same reason as above.
	if (hook.speed && hook.speed !== 1.0) {
		logger.warn(
			'[hook-selector] Model set speed=%s on hook. Overriding to 1.0 (no slow-mo on hooks).',
			hook.speed,
		);
		hook.speed = 1.0;
	}

	// Enforce trim bounds. If trimStart + duration exceeds source length, clamp.
	if (totalDurSec > 0 && hook.trimStart + hook.duration > totalDurSec) {
		const clampedStart = Math.max(0, totalDurSec - hook.duration);
		logger.warn(
			'[hook-selector] Trim exceeds source (%d+%d > %d). Clamping trimStart to %d.',
			hook.trimStart, hook.duration, totalDurSec, clampedStart,
		);
		hook.trimStart = clampedStart;
	}

	// Guarantee correct fileId + filename regardless of model output
	hook.fileId = arc.setupSourceId;
	hook.filename = setupVideo.name;

	return hook;
}
