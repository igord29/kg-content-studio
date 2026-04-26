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

TRIM FORMULA:
If scene analysis shows an interaction or action event at timestamp T:
  trimStart = max(0, T - 3)
  duration  = max(7, time_until_response_completes)
NEVER set trimStart = T. That starts the clip ON the peak and loses the buildup.

PEAK DATA SOURCES (in priority order):
1. TIMESTAMP ACTION SCORES — if provided, these are GPT-4o-vision-confirmed peak moments with action quality 1-10. Pick the top-scored timestamp as your T (peak), then apply trimStart = max(0, T - 3).
2. SCENE TIMELINE — if provided, use segment boundaries to find the strongest action region.
3. NOTABLE MOMENTS — descriptive list; less precise but usable.

If timestamp scores OR scene timeline OR notable moments exist for the setup source, you DO have peak data — do NOT mark the purpose as "estimated."

WHEN ALL THREE SOURCES ARE MISSING (genuinely no peak data):
- Honestly admit uncertainty in the purpose ("estimated")
- Use an even spread: trimStart in the first third of the source video
- Default duration to 8s
- Flag the uncertainty in the editNote

NEVER USE SLOW-MO FOR HOOKS. Save slow-mo for the climax clip (handled by step 3).
Hooks want momentum and arrival, not suspension of time.

Output VALID JSON matching this exact schema:
{
  "fileId": "<must match the setup source provided>",
  "filename": "<video name from provided data>",
  "trimStart": <seconds>,
  "duration": <seconds, must be >= 7>,
  "speed": 1.0,
  "filter": "dramatic" | "cinematic" | "warm" | "documentary" | "boost",
  "effect": "zoomIn" | "slideRight" | "slideLeft",
  "purpose": "<brief editorial description — can reference what scene data confirms>",
  "editNote": "<reasoning for these trim points — cite timestamps if scene data available>"
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
	let timestampSection = '';
	if (hasTimestampScores) {
		const top10 = setupCatalog.timestampScores!.slice(0, 10);
		const lines = top10
			.map(s =>
				`    ${s.timestamp}s: actionQuality=${s.actionQuality}/10 — "${s.brief}" (energy=${s.energy}, people=${s.people})`,
			)
			.join('\n');
		const bestT = top10[0]?.timestamp ?? 0;
		timestampSection =
			`\n  ✅ TIMESTAMP ACTION SCORES (use top-scored timestamp as T for trim formula — best is ${bestT}s):\n${lines}`;
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
- Notable moments: ${setupCatalog.notableMoments || 'None'}
${sceneSection}${timestampSection}

Pick the hook clip. Apply the STORY HOOK ARC RULE. If timestamp scores are provided, use the highest-scoring timestamp as T (peak) — do NOT mark the hook as "estimated" when peak data exists. Return JSON only.`;

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

	// Enforce the minimum duration rule at the code level. The prompt says
	// "minimum 7 seconds" but models occasionally drift — make it impossible
	// to produce a <7s hook regardless of what the model returned.
	if (hook.duration < 7) {
		logger.warn(
			'[hook-selector] Model picked duration=%ds (< 7s minimum). Extending to 8s.',
			hook.duration,
		);
		hook.duration = 8;
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
