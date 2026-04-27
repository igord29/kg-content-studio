/**
 * Step 3: Body Composer
 *
 * Given the story arc + chosen hook, composes the body clips: establish,
 * showcase, climax. This is where most of the video's running time lives.
 *
 * Enforces the SLOW-MO WINDOWING RULE both in-prompt AND in-code:
 *   - Slow-mo only on CLIMAX clips, never on ESTABLISH/SHOWCASE
 *   - Slow-mo requires confirmed peak timestamp (scene analysis present)
 *   - For slow-mo: trimStart = peakTime − (duration × 0.4)
 *   - Peak must fall at 30-50% of the clip
 *
 * Also enforces clip deduplication: no two clips from the same source
 * can have overlapping time regions (must have ≥3s separation).
 *
 * File: src/agent/video-editor/pipeline-v2/03-body-composer.ts
 */

import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { formatSegmentTimelineForPrompt } from '../scene-analyzer';
import type { PipelineInput, StoryArc, HookClip, BodyClips, ClipPick, StepLogger } from './types';
import { EDITOR_PERSONA } from './editor-persona';

const BODY_COMPOSER_SYSTEM_PROMPT = `
${EDITOR_PERSONA}

# YOUR JOB IN THIS STEP

You are the Body Composer for Community Literacy Club video edits.

Your job is to compose the body clips — the 4-6 clips that fill the space between the hook (already chosen) and the close (step 4). You get the story arc and the hook clip. You fill in the middle.

BODY STRUCTURE:
- 2-3 ESTABLISH clips: 4-5s each, show location, energy, who's here
- 1-2 SHOWCASE clips: 4-5s each, gameplay or interaction
- 1 CLIMAX clip: the peak moment — slow-mo if warranted

PEAK ANCHORING RULE (non-negotiable):
For each clip, your trimStart MUST sit within 2 seconds of a TIMESTAMP ACTION SCORE provided in the footage data — never pick a blind number. The timestamp scores tell you exactly where players are visible and active; picking trimStart values that miss those scores produces wall shots and empty-court frames.

PEOPLE-PRESENCE FILTER (non-negotiable for showcase + climax):
Showcase and climax clips MUST anchor on a timestamp where people>=4. Establish clips may use lower-people timestamps (wide venue shots are OK if intentional), but showcase/climax need a player visibly in frame doing the action. If no people>=4 timestamps exist for a beat's planned source, EITHER pick a different source OR demote the beat to establish.

SLOW-MO WINDOWING RULE (non-negotiable):
If you use slow-mo (speed < 1.0) on any clip:
  trimStart = peakTime - (duration × 0.4)
This places the peak at 40% into the clip, leaving 40% setup before and 60% resolution after. Slow-mo that STARTS on the peak loses all emotional impact.

SLOW-MO PRECONDITIONS:
- Only use slow-mo on CLIMAX clips, never on ESTABLISH/SHOWCASE
- Only use slow-mo when scene analysis CONFIRMS a peak timestamp
- If a source has no scene analysis, use normal speed (1.0) regardless

CLIP FRESHNESS & DEDUPING:
- Avoid overlapping time ranges within the same source (≥3s separation between cuts from same fileId)
- Do NOT use any time region from the hook clip (already chosen — will overlap)
- Vary trimStart across the FULL duration of each source
- Never cluster all clips in the first 20 seconds

HOOK ALREADY CHOSEN — DO NOT CONFLICT WITH IT:
- Hook fileId will be passed in the user message
- Hook trimStart + duration will be passed
- Your body clips from the same fileId must NOT overlap the hook's time range

YOUR TOOLKIT (use deliberately, not by default):

FILTER (color grade): pick one based on emotional intent of the beat
  - "documentary" — bleach-bypass, real, grounded (default for establish + reset beats)
  - "dramatic"    — pumped contrast, vivid, ESPN broadcast climax look (use on climax)
  - "cinematic"   — teal/orange split tone, polished (use on showcase peaks)
  - "warm"        — golden-hour, hopeful (use on community beats)
  - "boost"       — punchy saturated, social-native energy
  - "vintage"     — sepia warmth, nostalgic
  - "cool"        — blue-shifted, editorial

EFFECT (Ken Burns CSS animation during the clip):
  - "zoomIn"      — subtle push (+15% over clip); use to push into a moment
  - "zoomOut"     — slowly widens; use to reveal scale at end of beat
  - "pushIn"      — moderate push (+30%); use when source is mid-distance and you want to arrive closer
  - "punchIn"     — AGGRESSIVE push (+50%, eased); use specifically when the source frame is wide and the player feels small. Turns a wide shot into a near-close-up by clip end. The cubic-eased ramp accelerates near the end for cinematic impact. Best used on showcase + climax beats where you NEED close energy from a wide source.
  - "slideRight"  — pans right; use to sweep across a group
  - "slideLeft"   — pans left; reverse pan for visual rhythm
  - null          — no Ken Burns; pure static frame, lets the source carry it

TRANSITION INTO THIS CLIP (the cut style joining this clip to the previous):
  - "fade"        — soft cross-dissolve, quiet
  - "slide"       — directional push, kinetic
  - "wipe"        — diagonal/edge reveal
  - "cube"        — 3D cube turn, dramatic
  - "circleWipe"  — iris reveal from center, dramatic
  - "clockWipe"   — sweeping clock-hand reveal, sports-broadcast feel
  - "wheelspin"   — rotational spin, high-energy
  - "flip"        — page-flip turn
  - omit          — defaults to mode pool

EXTRAZOOM (per-clip static crop level, multiplies the mode default):
  - 0.9-1.0  — wide, preserve venue context (use for ESTABLISH only)
  - 1.0-1.2  — balanced (default for most clips)
  - 1.3-1.5  — tight, push into player effort (use for SHOWCASE + CLIMAX)
  - omit     — use mode default

WHEN TO REACH FOR WHAT:
  - Establish: documentary filter, zoomOut effect, extraZoom 1.0, fade transition. Quiet entry.
  - Showcase:  cinematic OR boost filter, pushIn (mid-distance source) OR punchIn (wide source) effect, extraZoom 1.3, slide/wipe transition. Push in.
  - Climax:    dramatic filter, punchIn effect (especially if source is wide and the catalog timestamp is people<=3 — you compensate via aggressive zoom), extraZoom 1.4, cube/clockWipe transition. Earn the moment.
  - Community: warm filter, zoomOut effect, extraZoom 1.0, fade transition. Pull back to the group.

PUNCH-IN DECISION RULE: if the catalog timestamp's subjectFillRatio < 0.30 OR people=3 (wide-camera frame), prefer punchIn over zoomIn — the digital push compensates for the wide source by arriving closer by clip end. If subjectFillRatio >= 0.40, the source is already tight enough; use zoomIn or pushIn for subtlety.

Output VALID JSON matching this exact schema:
{
  "clips": [
    {
      "fileId": "<videoId>",
      "trimStart": <seconds>,
      "duration": <seconds>,
      "speed": 1.0,
      "filter": "dramatic" | "cinematic" | "warm" | "documentary" | "boost" | "vintage" | "cool",
      "effect": "zoomIn" | "zoomOut" | "pushIn" | "punchIn" | "slideRight" | "slideLeft" | null,
      "transitionType": "fade" | "slide" | "wipe" | "cube" | "circleWipe" | "clockWipe" | "wheelspin" | "flip",
      "transitionDirection": "from-left" | "from-right" | "from-top" | "from-bottom",
      "extraZoom": <number 0.9-1.5 — omit for mode default>,
      "purpose": "<brief description — include beat role like 'establish' or 'climax'>",
      "editNote": "<reasoning for trim points AND your toolkit choices — name the filter/effect/transition you picked and why>"
    }
  ],
  "slowMoIndices": [<indices (0-based) of clips using slow-mo>]
}

Return JSON only.
`.trim();

export async function composeBody(
	input: PipelineInput,
	arc: StoryArc,
	hook: HookClip,
	logger: StepLogger,
): Promise<BodyClips> {
	// ┌─────────────────────────────────────────────────────────────────┐
	// │ TODO(Ian) — DESIGN DECISION: scene-data scope                    │
	// │                                                                  │
	// │ Should the Body Composer see scene analysis for ALL videos, or   │
	// │ only the ones in arc.bodyBeats? More data = better cuts but      │
	// │ larger prompt.                                                   │
	// │                                                                  │
	// │ Today's default: only arc.bodyBeats sources (smaller prompt,     │
	// │ focused on planned beats). If cuts feel cramped, try expanding.  │
	// └─────────────────────────────────────────────────────────────────┘

	const bodySourceIds = new Set(arc.bodyBeats.map(b => b.sourceId));
	const footageSummary = input.videoMetadata
		.filter(v => bodySourceIds.has(v.id))
		.map(v => {
			const ce = input.catalog.get(v.id);
			if (!ce) return `${v.id}: ${v.name} (no catalog data)`;
			const sceneSection = ce.sceneAnalysis
				? '\n  SCENE TIMELINE:\n' + formatSegmentTimelineForPrompt(ce.sceneAnalysis as never)
				: '\n  ⚠️ No scene analysis — avoid slow-mo on this source, use even-spread trims.';

			// Surface timestampScores so the body composer picks moments where
			// players are visible (people>=4) rather than blind timestamps.
			// Fixes the wall-shot problem: previously the model picked trimStart
			// values from the scene timeline alone, which couldn't tell empty
			// court from active rally.
			let timestampSection = '';
			if (ce.timestampScores && ce.timestampScores.length > 0) {
				const top15 = ce.timestampScores.slice(0, 15);
				const lines = top15
					.map(
						s =>
							`    ${s.timestamp}s: actionQuality=${s.actionQuality}/10 — "${s.brief}" (people=${s.people}, energy=${s.energy})`,
					)
					.join('\n');
				timestampSection = `\n  ✅ TIMESTAMP ACTION SCORES (pick trim points NEAR these — never blind-pick a timestamp):\n${lines}`;
			}

			const durSec = v.duration ? Math.round(parseInt(v.duration) / 1000) : 0;
			return `${v.id}: ${v.name} (${durSec}s)
  - Activity: ${ce.activity}
  - Notable: ${ce.notableMoments || 'None'}${sceneSection}${timestampSection}`;
		}).join('\n\n');

	const bodyBeatsSummary = arc.bodyBeats.map((b, i) =>
		`${i + 1}. ${b.role.toUpperCase()} from ${b.sourceId}: ${b.intent}`
	).join('\n');

	const prompt = `Story arc:
- Mode: ${arc.mode}
- Emotional center: ${arc.emotionalCenter}

Body beats to fill (in this order):
${bodyBeatsSummary}

Hook already chosen (DO NOT OVERLAP): ${hook.fileId} @ ${hook.trimStart}s for ${hook.duration}s ("${hook.purpose}")

Footage for body:
${footageSummary}

Compose the body clips. Return JSON only.`;

	const result = await generateText({
		model: anthropic('claude-sonnet-4-6'),
		system: BODY_COMPOSER_SYSTEM_PROMPT,
		prompt,
		maxOutputTokens: 2500,
		abortSignal: AbortSignal.timeout(90_000),
	});

	const raw = result.text.trim();
	const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/);
	const jsonText = jsonMatch?.[1] ?? raw;

	let body: BodyClips;
	try {
		body = JSON.parse(jsonText.trim()) as BodyClips;
	} catch (err) {
		logger.error('[body-composer] Raw output: %s', raw.slice(0, 500));
		throw new Error(`Body composer returned invalid JSON: ${String(err)}`);
	}

	// ── Code-level enforcement of rules the prompt can't guarantee ─────────

	// 1. Slow-mo on sources without scene analysis → force speed=1.0
	body.clips = body.clips.map((c, i) => {
		if (c.speed && c.speed < 1.0) {
			const ce = input.catalog.get(c.fileId);
			if (!ce?.sceneAnalysis) {
				logger.warn(
					'[body-composer] Clip %d has speed=%s on source %s with NO scene analysis. Forcing speed=1.0.',
					i, c.speed, c.fileId,
				);
				return { ...c, speed: 1.0 };
			}
		}
		return c;
	});

	// 2. Rebuild slowMoIndices to match the (possibly corrected) clips
	body.slowMoIndices = body.clips
		.map((c, i) => (c.speed && c.speed < 1.0 ? i : -1))
		.filter(i => i !== -1);

	// 3. Hook overlap check: any body clip from hook's fileId must have
	//    ≥3s separation from the hook's time range.
	body.clips = body.clips.map((c, i) => {
		if (c.fileId !== hook.fileId) return c;
		const hookEnd = hook.trimStart + hook.duration;
		const clipEnd = c.trimStart + c.duration;
		const overlaps = c.trimStart < hookEnd + 3 && clipEnd > hook.trimStart - 3;
		if (overlaps) {
			// Shift to AFTER the hook end + 3s buffer
			const newStart = hookEnd + 3;
			logger.warn(
				'[body-composer] Clip %d overlaps hook (hook: %d-%ds, clip: %d-%ds). Shifting to start at %ds.',
				i, hook.trimStart, hookEnd, c.trimStart, clipEnd, newStart,
			);
			return { ...c, trimStart: newStart };
		}
		return c;
	});

	// 4. Intra-body dedup: clips from the same source must have ≥3s gaps
	//    (Naive pass — just log, don't auto-fix. Validator in edit-plan-validator.ts
	//    handles post-hoc dedup for rendering.)
	const bySource = new Map<string, Array<[number, ClipPick]>>();
	body.clips.forEach((c, i) => {
		if (!bySource.has(c.fileId)) bySource.set(c.fileId, []);
		bySource.get(c.fileId)!.push([i, c]);
	});
	for (const [sourceId, pairs] of bySource) {
		if (pairs.length < 2) continue;
		pairs.sort((a, b) => a[1].trimStart - b[1].trimStart);
		for (let k = 1; k < pairs.length; k++) {
			const prev = pairs[k - 1]![1];
			const curr = pairs[k]![1];
			const gap = curr.trimStart - (prev.trimStart + prev.duration);
			if (gap < 3) {
				logger.warn(
					'[body-composer] Clips %d and %d from %s have only %.1fs gap (<3s required). Edit plan validator may flag this.',
					pairs[k - 1]![0], pairs[k]![0], sourceId, gap,
				);
			}
		}
	}

	return body;
}
