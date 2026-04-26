/**
 * Step 1: Story Planner
 *
 * Given raw footage, identifies the narrative ARC before any specific
 * trim points are chosen. Output: a StoryArc describing the emotional
 * center, which videos play each role, and the overall mode.
 *
 * This step does NOT pick trim points. That happens in steps 2/3.
 *
 * Why separate from the rest:
 * - Different videos need different stories; this is where creative
 *   judgment happens with zero trim-point details to distract from it.
 * - When this step produces a weak arc, every subsequent step inherits
 *   the weakness. Isolating it lets us evaluate arc quality on its own.
 * - ~400 tokens of system prompt vs 14K in the monolith — focused.
 *
 * File: src/agent/video-editor/pipeline-v2/01-story-planner.ts
 */

import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import type { PipelineInput, StoryArc, StepLogger } from './types';
import { EDITOR_PERSONA } from './editor-persona';

const STORY_PLANNER_SYSTEM_PROMPT = `
${EDITOR_PERSONA}

# YOUR JOB IN THIS STEP

You are the Story Planner for Community Literacy Club video edits.

Your ONLY job is to identify the narrative structure of a video BEFORE any specific clips are chosen. You do NOT pick trim points. You do NOT pick specific timestamps. You pick WHICH STORY to tell and WHICH VIDEOS hold which beats.

CLC serves youth (ages 6-26) through tennis, chess, and academic programs. The stories that resonate are:
- A kid struggling and then persevering
- A coach supporting a player through a hard moment
- The quiet focus before a big action
- A group moment showing community
- A transformation arc (warmup → peak → celebration)

Your workflow:
1. READ every video's catalog entry carefully
2. Find the EMOTIONAL CENTER — the single most human moment across all videos
3. Identify which video holds the SETUP (the state before the turn)
4. Identify which video holds the TURN (the shift — often the same video as setup)
5. Identify which video holds the RESPONSE (what happens next)
6. Plan the body: 2-3 establish, 1-2 showcase, 1 climax, 1 community beats
7. Pick the mode: game_day (action) / our_story (testimonials) / quick_hit (short social) / showcase (donor-facing)

STRICT RULES:
- setupSourceId, turnSourceId, responseSourceId MUST be IDs from the provided video list
- Prefer videos with coach-player interactions as the story hook source
- Body beats MUST be 4-6 items covering establish/showcase/climax/community
- If no clear narrative exists, pick the best available micro-story and mention it in emotionalCenter
- Never pick an ID not in the input list

Output VALID JSON matching this exact schema — no markdown fences, no prose, JSON only:
{
  "mode": "game_day" | "our_story" | "quick_hit" | "showcase",
  "emotionalCenter": "one sentence describing the heart of the video",
  "setupSourceId": "<videoId from input list>",
  "turnSourceId": "<videoId from input list>",
  "responseSourceId": "<videoId from input list>",
  "bodyBeats": [
    { "role": "establish" | "showcase" | "climax" | "community", "sourceId": "<videoId>", "intent": "brief description" }
  ],
  "closeIntent": "brief description of the closing shot",
  "musicDirection": "genre, BPM, and emotional tone"
}
`.trim();

export async function planStoryArc(
	input: PipelineInput,
	logger: StepLogger,
): Promise<StoryArc> {
	// Build a COMPACT footage summary. This is intentionally much lighter
	// than the v1 footageContext — the Story Planner doesn't need scene
	// timelines (it's not picking trim points yet). Just catalog summary.
	const footageSummary = input.videoMetadata.map((v, i) => {
		const ce = input.catalog.get(v.id);
		if (!ce) {
			return `[${i + 1}] ${v.id}: ${v.name} (no catalog data)`;
		}
		const hasScenes = Boolean(ce.sceneAnalysis);
		const durSec = v.duration ? Math.round(parseInt(v.duration) / 1000) : 0;
		return `[${i + 1}] ${v.id}: ${v.name} (${durSec}s, ${ce.contentType || 'unknown'})
  - Activity: ${ce.activity}
  - Location: ${ce.suspectedLocation || 'unknown'}
  - People: ${ce.peopleCount || '?'}
  - Notable moments: ${ce.notableMoments || 'None'}
  - Scene analysis: ${hasScenes ? 'AVAILABLE' : 'MISSING'}`;
	}).join('\n\n');

	const anyHasScenes = input.videoMetadata.some(v => {
		const ce = input.catalog.get(v.id);
		return Boolean(ce?.sceneAnalysis);
	});

	const prompt = `Topic: ${input.topic}
Purpose: ${input.purpose}
Target mode: ${input.editMode}
Target platform: ${input.platform}

Available footage (${input.videoMetadata.length} videos):
${footageSummary}

Pick the story arc. Return JSON only, no prose.`;

	logger.info(
		'[story-planner] Planning with %d videos, anyHasScenes=%s',
		input.videoMetadata.length,
		String(anyHasScenes),
	);

	const result = await generateText({
		model: anthropic('claude-sonnet-4-6'),
		system: STORY_PLANNER_SYSTEM_PROMPT,
		prompt,
		maxOutputTokens: 1500,
		abortSignal: AbortSignal.timeout(60_000),
	});

	// Parse JSON. Prompt asks for raw JSON but some responses wrap in fences.
	const raw = result.text.trim();
	const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/);
	const jsonText = jsonMatch?.[1] ?? raw;

	let arc: StoryArc;
	try {
		arc = JSON.parse(jsonText.trim()) as StoryArc;
	} catch (err) {
		logger.error('[story-planner] Failed to parse JSON: %s', String(err));
		logger.error('[story-planner] Raw output (first 500 chars): %s', raw.slice(0, 500));
		throw new Error(`Story planner returned invalid JSON: ${String(err)}`);
	}

	// Validate that all source IDs exist in input. The prompt says this is a
	// strict rule, but models occasionally ignore it — enforce at the code level.
	const videoIdSet = new Set(input.videoIds);
	const checkId = (id: string, role: string) => {
		if (!videoIdSet.has(id)) {
			throw new Error(
				`Story planner picked ${role}="${id}" which is not in input videoIds. ` +
				`Valid IDs: ${input.videoIds.join(', ')}`,
			);
		}
	};
	checkId(arc.setupSourceId, 'setupSourceId');
	checkId(arc.turnSourceId, 'turnSourceId');
	checkId(arc.responseSourceId, 'responseSourceId');
	arc.bodyBeats.forEach((b, i) => checkId(b.sourceId, `bodyBeats[${i}].sourceId`));

	// Override the model's guess about scene analysis with the real answer.
	// (We don't ask the model to track this — we just know from the catalog.)
	arc.hasSceneAnalysis = anyHasScenes;

	return arc;
}
