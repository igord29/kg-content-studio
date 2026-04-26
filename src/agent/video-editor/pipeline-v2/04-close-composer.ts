/**
 * Step 4: Close Composer
 *
 * Given the hook + body + story arc, writes:
 *  - 1-2 closing clips (community beat + CLC branding shot)
 *  - All text overlays with position and timing synced to the timeline
 *
 * This step has full timeline context (knows exact seconds each clip
 * lives at) so it can place overlays precisely without guessing.
 *
 * File: src/agent/video-editor/pipeline-v2/04-close-composer.ts
 */

import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import type { PipelineInput, StoryArc, HookClip, BodyClips, ClosePlan, StepLogger } from './types';
import { EDITOR_PERSONA } from './editor-persona';

const CLOSE_COMPOSER_SYSTEM_PROMPT = `
${EDITOR_PERSONA}

# YOUR JOB IN THIS STEP

You are the Close Composer for Community Literacy Club video edits.

Your job is to write:
1. The COMMUNITY beat (1 clip, 3-5s): faces, handshakes, coaches with kids
2. The CLOSE beat (1 clip, 3-5s): final landing moment + CLC branding shot
3. TEXT OVERLAYS for the full video: location tag at opening, CLC branding at close, optional mid-video stat/quote

TEXT OVERLAY GUIDELINES:
- Location tag: bottom position, slideUp animation, starts at ~1s, 3s duration
- Mid-video stat (optional): center position, typewriter animation, mid-timeline, 3-4s duration
- CLC branding: bottom position, scaleUp animation, starts in last 5s, 4s duration

OVERLAY TIMING:
The current timeline length (hook + body) is provided in the prompt. Place overlays at absolute timeline seconds (NOT source timestamps). Use the "start" field for when each overlay appears on screen.

Output VALID JSON:
{
  "closeClips": [
    {
      "fileId": "<videoId>",
      "trimStart": <seconds>,
      "duration": <seconds>,
      "speed": 1.0,
      "filter": "dramatic" | "cinematic" | "warm" | "documentary" | "boost",
      "effect": "zoomOut" | "zoomIn",
      "purpose": "<community | close>",
      "editNote": "<reasoning>"
    }
  ],
  "textOverlays": [
    {
      "text": "<the text to display>",
      "start": <seconds into output timeline>,
      "duration": <seconds>,
      "position": "top" | "center" | "bottom",
      "animation": "fade" | "slideUp" | "slideDown" | "scaleUp" | "bounce" | "typewriter"
    }
  ]
}

Return JSON only.
`.trim();

export async function composeClose(
	input: PipelineInput,
	arc: StoryArc,
	hook: HookClip,
	body: BodyClips,
	logger: StepLogger,
): Promise<ClosePlan> {
	// ┌─────────────────────────────────────────────────────────────────┐
	// │ TODO(Ian) — DESIGN DECISION: text overlay generation location    │
	// │                                                                  │
	// │ Should text overlays be generated here (with full timeline       │
	// │ context) or in a separate step 5? Today: here, because overlays  │
	// │ need to know the total timeline to place stats mid-video and     │
	// │ branding at the end. Trade-off: this step does more than its     │
	// │ name suggests.                                                   │
	// └─────────────────────────────────────────────────────────────────┘

	// Calculate current timeline length (hook + body) to give the close
	// composer accurate overlay placement.
	const timelineSoFar = [hook, ...body.clips];
	const currentDuration = timelineSoFar.reduce((sum, c) => {
		return sum + (c.duration / (c.speed || 1));
	}, 0);

	// Pick a close source from arc.bodyBeats (community beat) with fallback
	// to an unused video or the first video.
	const usedSources = new Set(timelineSoFar.map(c => c.fileId));
	const unusedSources = input.videoMetadata.filter(v => !usedSources.has(v.id));
	const communityBeat = arc.bodyBeats.find(b => b.role === 'community');
	const closeSourceId =
		communityBeat?.sourceId ??
		unusedSources[0]?.id ??
		input.videoMetadata[0]?.id ??
		arc.setupSourceId;

	const closeSource = input.videoMetadata.find(v => v.id === closeSourceId);
	const closeCatalog = input.catalog.get(closeSourceId);
	const closeDurSec = closeSource?.duration
		? Math.round(parseInt(closeSource.duration) / 1000)
		: 0;

	const prompt = `Story arc:
- Mode: ${arc.mode}
- Emotional center: ${arc.emotionalCenter}
- Close intent: ${arc.closeIntent}

Current timeline so far: ${Math.round(currentDuration)}s (hook + body)
Final video target: ~${Math.round(currentDuration + 6)}s (add 6s for close + community)

Close source: ${closeSourceId} (${closeSource?.name ?? 'unknown'}, ${closeDurSec}s duration)
- Activity: ${closeCatalog?.activity ?? 'unknown'}
- Location: ${closeCatalog?.suspectedLocation ?? 'unknown'}
- Notable: ${closeCatalog?.notableMoments ?? 'None'}

Topic: ${input.topic}
Platform: ${input.platform}

Write the closing clips (community + close) and all text overlays for the full timeline.
Return JSON only.`;

	const result = await generateText({
		model: anthropic('claude-sonnet-4-6'),
		system: CLOSE_COMPOSER_SYSTEM_PROMPT,
		prompt,
		maxOutputTokens: 1500,
		abortSignal: AbortSignal.timeout(60_000),
	});

	const raw = result.text.trim();
	const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/);
	const jsonText = jsonMatch?.[1] ?? raw;

	let close: ClosePlan;
	try {
		close = JSON.parse(jsonText.trim()) as ClosePlan;
	} catch (err) {
		logger.error('[close-composer] Raw output: %s', raw.slice(0, 500));
		throw new Error(`Close composer returned invalid JSON: ${String(err)}`);
	}

	// Code-level slow-mo discipline for close clips. The Body Composer enforces
	// this for body clips; the Close Composer was missing the equivalent rule,
	// which let stray slow-mo land on speculative "celebration" moments without
	// a confirmed action peak. Rule: close-clip speed < 1.0 requires a
	// timestampScore with actionQuality >= 7 INSIDE the clip's trim range.
	// Otherwise force speed=1.0.
	close.closeClips = close.closeClips.map((c, i) => {
		if (!c.speed || c.speed >= 1.0) return c;
		const ce = input.catalog.get(c.fileId);
		const clipStart = c.trimStart;
		const clipEnd = c.trimStart + c.duration;
		const peakInRange = ce?.timestampScores?.find(
			s =>
				s.timestamp >= clipStart && s.timestamp <= clipEnd && s.actionQuality >= 7,
		);
		if (!peakInRange) {
			logger.warn(
				'[close-composer] Close clip %d at speed=%s has no confirmed action peak (actionQuality>=7) within %ds-%ds on source %s. Forcing speed=1.0.',
				i,
				c.speed,
				clipStart,
				clipEnd,
				c.fileId,
			);
			return { ...c, speed: 1.0 };
		}
		logger.info(
			'[close-composer] Close clip %d slow-mo allowed: peak at %ds (actionQuality=%d) within range.',
			i,
			peakInRange.timestamp,
			peakInRange.actionQuality,
		);
		return c;
	});

	// Sanity-check overlay start times — clamp any that land past the
	// final timeline so we don't render a stale overlay.
	const maxTimeline = currentDuration + 10; // 10s buffer for close clips
	close.textOverlays = close.textOverlays.map(o => {
		if (o.start > maxTimeline) {
			logger.warn(
				'[close-composer] Overlay "%s" starts at %ds, past timeline max %ds. Clamping.',
				o.text, o.start, Math.round(maxTimeline),
			);
			return { ...o, start: Math.max(0, maxTimeline - o.duration - 1) };
		}
		return o;
	});

	return close;
}
