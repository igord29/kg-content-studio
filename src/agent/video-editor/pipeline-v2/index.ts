/**
 * V2 Pipeline Orchestrator
 *
 * Drop-in replacement for generateEditPlan in auto-pipeline.ts. Breaks
 * edit planning into 4 focused Claude Sonnet calls instead of one monolith.
 *
 *   STEP                 │ PROMPT SIZE │ OUTPUT
 *   ─────────────────────┼─────────────┼────────────────────────────────
 *   1. Story Planner     │ ~500 tok    │ StoryArc (mode, beats, sources)
 *   2. Hook Selector     │ ~600 tok    │ HookClip (exact trim points)
 *   3. Body Composer     │ ~700 tok    │ BodyClips (4-6 clips)
 *   4. Close Composer    │ ~400 tok    │ ClosePlan (close + overlays)
 *   ─────────────────────┴─────────────┴────────────────────────────────
 *   TOTAL system prompt: ~2200 tok (vs ~14000 in v1)
 *
 * ═══════════════════════════════════════════════════════════════════════
 *                              WHY V2 EXISTS
 * ═══════════════════════════════════════════════════════════════════════
 *
 * The v1 pipeline has a single 14K-token prompt doing ALL the work:
 * mode choice + story arc + trim points + slow-mo placement + overlays
 * + music direction. When the output is bad, you can't tell WHICH
 * decision went wrong.
 *
 * The v2 pipeline gives each decision its own typed input/output and
 * its own focused prompt. Each step can:
 *   - Be validated independently (parsed into a typed struct)
 *   - Fail loudly and recoverably (the orchestrator falls back to v1)
 *   - Be tuned without touching the other steps
 *   - Be cached or replayed individually
 *
 * ═══════════════════════════════════════════════════════════════════════
 *                             HOW TO ENABLE
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   Set env: VIDEO_EDITOR_USE_V2_PIPELINE=true
 *
 *   Railway: railway variables set VIDEO_EDITOR_USE_V2_PIPELINE=true
 *   Local:   export VIDEO_EDITOR_USE_V2_PIPELINE=true
 *
 *   Turn it off by unsetting or setting to "false".
 *
 * ═══════════════════════════════════════════════════════════════════════
 *                            HOW TO EXTEND
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Each step file is self-contained. To tune a step, edit its system
 * prompt (the `*_SYSTEM_PROMPT` const) or its code-level enforcement
 * rules. Keep each prompt under ~2000 tokens; if you find yourself
 * adding rules, consider whether they belong in a *different* step.
 *
 * To add a step, create the file (e.g. `05-music-composer.ts`), call
 * it from this orchestrator, and update types.ts.
 *
 * File: src/agent/video-editor/pipeline-v2/index.ts
 */

import type { PipelineInput, EditPlanV2, StepLogger } from './types';
import { planStoryArc } from './01-story-planner';
import { selectHook } from './02-hook-selector';
import { composeBody } from './03-body-composer';
import { composeClose } from './04-close-composer';

export type { PipelineInput, EditPlanV2, StepLogger } from './types';

/**
 * Main orchestrator. Runs the 4 steps in sequence and assembles the
 * final EditPlan in v1-compatible shape (so render.ts can consume it
 * unchanged).
 *
 * Any step throwing bubbles up to the caller — auto-pipeline.ts
 * catches errors and falls back to the v1 pipeline.
 */
export async function generateEditPlanV2(
	input: PipelineInput,
	logger: StepLogger,
): Promise<EditPlanV2> {
	const startTime = Date.now();
	const stepDurationsMs: Record<string, number> = {};

	// ── Step 1: Story Planner ──────────────────────────────────────────
	logger.info('[pipeline-v2] Step 1/4: Planning story arc');
	const step1Start = Date.now();
	const arc = await planStoryArc(input, logger);
	stepDurationsMs.storyPlanner = Date.now() - step1Start;
	logger.info(
		'[pipeline-v2] Step 1 done (%dms): mode=%s, center="%s", setup=%s, response=%s',
		stepDurationsMs.storyPlanner,
		arc.mode,
		arc.emotionalCenter,
		arc.setupSourceId,
		arc.responseSourceId,
	);

	// ── Step 2: Hook Selector ──────────────────────────────────────────
	logger.info('[pipeline-v2] Step 2/4: Selecting narrative hook');
	const step2Start = Date.now();
	const hook = await selectHook(input, arc, logger);
	stepDurationsMs.hookSelector = Date.now() - step2Start;
	logger.info(
		'[pipeline-v2] Step 2 done (%dms): %s @ %ds for %ds ("%s")',
		stepDurationsMs.hookSelector,
		hook.fileId,
		hook.trimStart,
		hook.duration,
		hook.purpose,
	);

	// ── Step 3: Body Composer ──────────────────────────────────────────
	logger.info('[pipeline-v2] Step 3/4: Composing body (%d beats planned)', arc.bodyBeats.length);
	const step3Start = Date.now();
	const body = await composeBody(input, arc, hook, logger);
	stepDurationsMs.bodyComposer = Date.now() - step3Start;
	logger.info(
		'[pipeline-v2] Step 3 done (%dms): %d clips (%d with slow-mo)',
		stepDurationsMs.bodyComposer,
		body.clips.length,
		body.slowMoIndices.length,
	);

	// ── Step 4: Close Composer ─────────────────────────────────────────
	logger.info('[pipeline-v2] Step 4/4: Composing close');
	const step4Start = Date.now();
	const close = await composeClose(input, arc, hook, body, logger);
	stepDurationsMs.closeComposer = Date.now() - step4Start;
	logger.info(
		'[pipeline-v2] Step 4 done (%dms): %d close clips, %d overlays',
		stepDurationsMs.closeComposer,
		close.closeClips.length,
		close.textOverlays.length,
	);

	// ── Cross-step dedup ──────────────────────────────────────────────
	// Each step (hook/body/close) enforces its own internal 3s separation rule,
	// but until now no step checked AGAINST the others. Result: the close
	// composer would routinely pick a timestamp the hook already used (e.g.
	// hook trimStart=17 for 9s, close trimStart=19 for 3s on the same source —
	// viewer sees identical footage at start and end). This pass enforces a
	// hard 3s-separation rule across ALL clips regardless of which step
	// produced them. Conflicts on close clips get shifted; conflicts on body
	// clips get logged (rarer because body composer already dedups internally).
	const MIN_SEPARATION = 3; // seconds
	function overlaps(a: { fileId: string; trimStart: number; duration: number }, b: { fileId: string; trimStart: number; duration: number }): boolean {
		if (a.fileId !== b.fileId) return false;
		const aEnd = a.trimStart + a.duration;
		const bEnd = b.trimStart + b.duration;
		return a.trimStart < bEnd + MIN_SEPARATION && aEnd + MIN_SEPARATION > b.trimStart;
	}
	// Resolve close clips against the rest of the timeline.
	const fixedClose = close.closeClips.map((c, i) => {
		const earlier = [hook, ...body.clips, ...close.closeClips.slice(0, i)];
		for (const e of earlier) {
			if (overlaps(c, e)) {
				// Shift close clip past the conflicting clip's end + buffer
				const newStart = e.trimStart + e.duration + MIN_SEPARATION;
				logger.warn(
					'[pipeline-v2] Close clip %d (%s @ %ds-%ds) overlaps earlier clip @ %ds-%ds. Shifting to %ds.',
					i, c.fileId.slice(0, 8), c.trimStart, c.trimStart + c.duration,
					e.trimStart, e.trimStart + e.duration, newStart,
				);
				return { ...c, trimStart: newStart };
			}
		}
		return c;
	});
	// Body clip cross-check (mostly a sanity log; body composer already dedups).
	body.clips.forEach((c, i) => {
		if (overlaps(c, hook)) {
			logger.warn(
				'[pipeline-v2] Body clip %d (%s @ %ds) overlaps hook (%s @ %ds-%ds). This shouldn\'t happen — body composer should\'ve caught it.',
				i, c.fileId.slice(0, 8), c.trimStart,
				hook.fileId.slice(0, 8), hook.trimStart, hook.trimStart + hook.duration,
			);
		}
	});

	// ── Assemble the final edit plan ───────────────────────────────────
	const allClips = [hook, ...body.clips, ...fixedClose];
	const totalDuration = allClips.reduce((sum, c) => {
		const effective = c.duration / (c.speed || 1);
		return sum + effective;
	}, 0);

	const totalDurationMs = Date.now() - startTime;
	logger.info(
		'[pipeline-v2] ✓ Assembled: %d clips, %.1fs total duration, took %dms',
		allClips.length,
		totalDuration,
		totalDurationMs,
	);

	// Mode-based defaults for transitions and music tier.
	// These can be overridden by the StoryArc fields if we extend the
	// planner later, but hardcoded defaults are fine for now.
	const transitions =
		arc.mode === 'game_day' ? 'fast_cuts' :
		arc.mode === 'our_story' ? 'crossfade' :
		arc.mode === 'quick_hit' ? 'fast_cuts' :
		'minimal';
	const musicTier = arc.mode === 'our_story' || arc.mode === 'showcase' ? 2 : 1;

	return {
		mode: arc.mode,
		clips: allClips,
		textOverlays: close.textOverlays,
		totalDuration: Math.round(totalDuration),
		transitions,
		musicTier,
		musicDirection: arc.musicDirection,
		_v2Meta: {
			storyArc: arc,
			generatedAt: new Date().toISOString(),
			stepDurationsMs,
		},
	};
}
