/**
 * Step 0.5: Beat Finder
 *
 * Re-interprets each source video's `visualTimeline.frames` (pre-computed at
 * cataloging time, brief-AGNOSTIC) through the lens of the refined brief
 * (brief-AWARE) and tags candidate narrative beats — setup / action /
 * resolution / quiet / community — for the downstream composers to pick from.
 *
 * Why this exists: the cataloger scores frames generically ("energy=5, rally
 * in progress"). The composers then pick the highest-scored frames. But that
 * scoring is BLIND to narrative roles — especially "resolution" moments
 * (the point won, the unposed grin, the follow-through). Vision-based
 * scoring catches *action density*, not *narrative payoff*. The Beat Finder
 * closes that gap by re-reading the existing frame descriptions with the
 * brief in hand.
 *
 * Cost & latency: one Claude Sonnet TEXT call per selected video, in
 * parallel. ~5-15s each, ~$0.003-0.01 each. For a 3-video render, that's
 * roughly +15s and +$0.03. No vision, no FFmpeg, no video re-download.
 *
 * Degrades gracefully: if a video has no `visualTimeline` (older catalog
 * entry), Beat Finder skips it and downstream steps fall back to the raw
 * timestamp scoring they already used.
 *
 * File: src/agent/video-editor/pipeline-v2/00.5-beat-finder.ts
 */

import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import type { CatalogEntry } from '../google-drive';
import type { PipelineInput, StepLogger } from './types';
import { EDITOR_PERSONA } from './editor-persona';

// ─────────────────────────────────────────────────────────────────────────
// TODO ── EDITORIAL TASTE (the most important 5-10 lines you write here)
// ─────────────────────────────────────────────────────────────────────────
//
// What does "resolution" look like in YOUR videos? This const is interpolated
// directly into the Beat Finder prompt — it tells the model what kinds of
// moments to SURFACE as resolution candidates. Vision-based scoring is BLIND
// to resolution (action density != narrative payoff), so this is the prompt
// fragment that closes the gap.
//
// The default below is written generically for youth sports. Refine it to
// match the kind of payoff moments YOU actually want in the cut:
//   - "the moment the kid finally connects on a rally after struggling"
//   - "the coach's audible 'let's go' after a kid pushes through a miss"
//   - "a clean stroke ending a drill, racket high, breath visible"
//   - "the unposed grin or fist pump immediately after"
//   - "the chess move that resolves a long exchange"
//
// Be specific. Be visceral. The more concrete you are, the more reliably the
// Beat Finder finds those moments in the visualTimeline frame descriptions.
//
const RESOLUTION_TASTE = `
Look for moments where an action arc COMPLETES. Specific visual signals to
hunt for in the frame descriptions: follow-through poses after a swing, the
ball landing or being struck cleanly, kids' hands raised, a brief stillness
immediately following peak energy, unposed expressions right after a rally
ends, an immediate group reaction (huddle, high-five, coach's 'let's go').
The frame after a high-energy frame is often the resolution. THIS is where
the story earns its place — every other beat is in service to this one.
`.trim();

// ─────────────────────────────────────────────────────────────────────────

const BEAT_FINDER_SYSTEM_PROMPT = `
${EDITOR_PERSONA}

# YOUR JOB IN THIS STEP

You are reading the visual timeline of ONE source video through the lens of the brief, and tagging which moments serve which narrative role. You are NOT picking clips — that's the composers' job downstream. You are surfacing candidate moments they should consider.

The frame data you'll see was generated WITHOUT the brief in mind (the cataloger ran offline and scored generically: action density, energy 1-5, hook potential). Your job is to RE-INTERPRET those frame descriptions specifically for THIS brief. A timestamp scored generic-action-level-4 by the cataloger might be a RESOLUTION moment for this brief; a high-energy-5 might be generic bustle that doesn't serve the story.

# WORKING RULES

1. **Read the brief first.** emphasize/avoid drive your priorities. If the brief says "find the rally where the kid won the point," you are hunting for resolution moments — not the highest-energy mid-rally frames.

2. **Tag every plausible moment, not just the best one per role.** Composers downstream apply their own filters. Be generous; give them options.

3. **The five roles you tag:**

   - **setup** — preparation, anticipation, characters in position BEFORE action begins. Quiet, low energy. Signals the story is about to start.

   - **action** — peak action. Rallies in progress, drills underway, high energy. Generic vision scoring catches this fine.

   - **resolution** — THE MOMENT OF OUTCOME. ${RESOLUTION_TASTE} **This is the role vision-scoring is BLIND to — you have to INFER it from sequence context.**

   - **quiet** — unposed between-beats. Adjusting grip, looking around, catching breath, walking to the line. Low energy, real, unguarded. NOT the same as setup — quiet moments can happen between actions, not just before.

   - **community** — multiple people present, group activity, coach-player interaction, collective scenes. The "we" beat.

4. **Confidence is honest.**
   - "high" — clearly described in the frame, role-aligned, brief-aligned.
   - "medium" — plausible but inferred from context.
   - "low" — thin evidence, you're stretching.

5. **Suggest duration per beat** based on what serves the role:
   - setup: 4-6s (let it breathe)
   - action: 3-5s (cut on energy)
   - resolution: 4-7s (carry the reaction)
   - quiet: 3-5s (don't linger past honesty)
   - community: 4-6s (group needs time to read)

# WHAT THE COMPOSERS DO WITH YOUR OUTPUT

The Story Planner picks the overall arc using your tags (which video has the strongest setup, which has the strongest resolution, etc.). The Hook Selector leans on your "resolution" or "action" tags for the opening. The Body Composer fills body slots by role. The Close Composer prefers your "quiet" tags.

If you tag a moment as resolution with HIGH confidence, you are essentially recommending it as a CLIMAX candidate. Be deliberate.

# OUTPUT

Output VALID JSON. No markdown fences. No prose around it. Schema:

{
  "setup":      [{ "timestamp": number, "duration": number, "description": "string", "confidence": "high"|"medium"|"low" }, ...],
  "action":     [...],
  "resolution": [...],
  "quiet":      [...],
  "community":  [...]
}

If a role has no candidates in this video, return [] — do not invent.
`.trim();

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Tag narrative beats for a single video by re-reading its visualTimeline
 * through the lens of the refined brief.
 *
 * Returns null if the catalog entry lacks visualTimeline (graceful skip).
 */
export async function findBeats(
	videoName: string,
	catalog: CatalogEntry,
	refinedBrief: string,
	logger: StepLogger,
): Promise<NonNullable<CatalogEntry['narrativeBeats']> | null> {
	if (!catalog.visualTimeline || catalog.visualTimeline.frames.length === 0) {
		logger.warn('[beat-finder] %s — no visualTimeline available, skipping', videoName);
		return null;
	}

	// Build the per-timestamp evidence the model will reason over.
	const framesSummary = catalog.visualTimeline.frames.map((f) => {
		const flags: string[] = [`energy=${f.energy}`];
		if (f.isAction) flags.push('ACTION');
		if (f.hookPotential) flags.push('HOOK');
		return `T=${f.timestamp}s [${f.actionType}, ${flags.join(', ')}]: ${f.description}`;
	}).join('\n');

	const actionWindowsSummary = catalog.visualTimeline.actionWindows
		.map((w) => `${w.start}s-${w.end}s [${w.type}, peak=${w.peakEnergy}]`)
		.join('; ');

	const userPrompt = `Brief context:
${refinedBrief}

─── This video ───
File: ${videoName}
Activity: ${catalog.activity || 'unknown'}
Content type: ${catalog.contentType}
People: ${catalog.peopleCount || '?'}
${catalog.notableMoments ? `Cataloger's notable moments: ${catalog.notableMoments}` : ''}
${catalog.visualTimeline.summary ? `Visual summary: ${catalog.visualTimeline.summary}` : ''}

Action windows detected: ${actionWindowsSummary || 'none'}

Per-timestamp visual timeline (your evidence — read carefully):
${framesSummary}

Tag the narrative beats in THIS video that serve THIS BRIEF. Return JSON only.`;

	const result = await generateText({
		model: anthropic('claude-sonnet-4-6'),
		system: BEAT_FINDER_SYSTEM_PROMPT,
		prompt: userPrompt,
		maxOutputTokens: 1500,
		abortSignal: AbortSignal.timeout(45_000),
	});

	const raw = result.text.trim();
	const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/);
	const jsonText = jsonMatch?.[1] ?? raw;

	try {
		const parsed = JSON.parse(jsonText.trim()) as Partial<NonNullable<CatalogEntry['narrativeBeats']>>;
		return {
			setup: parsed.setup || [],
			action: parsed.action || [],
			resolution: parsed.resolution || [],
			quiet: parsed.quiet || [],
			community: parsed.community || [],
			generatedAt: new Date().toISOString(),
		};
	} catch (err) {
		// Graceful degrade — don't fail the whole pipeline because one video's
		// beats couldn't be parsed. Downstream composers fall back to raw scores.
		logger.error('[beat-finder] Failed to parse JSON for %s: %s', videoName, String(err));
		logger.error('[beat-finder] Raw output (first 400): %s', raw.slice(0, 400));
		return null;
	}
}

/**
 * Orchestrator helper — run Beat Finder for every selected video in parallel.
 * Mutates `input.catalog` in place, attaching `narrativeBeats` to each entry
 * that successfully produced beats. Downstream steps read those mutated entries.
 */
export async function findBeatsForAll(
	input: PipelineInput,
	refinedBrief: string,
	logger: StepLogger,
): Promise<{ totalBeats: number; videosWithBeats: number }> {
	let totalBeats = 0;
	let videosWithBeats = 0;

	// Each video's beat-finding is independent — run in parallel.
	const tasks = input.videoMetadata.map(async (v) => {
		const entry = input.catalog.get(v.id);
		if (!entry) return;
		const beats = await findBeats(v.name, entry, refinedBrief, logger);
		if (beats) {
			entry.narrativeBeats = beats;
			const count =
				beats.setup.length + beats.action.length + beats.resolution.length +
				beats.quiet.length + beats.community.length;
			if (count > 0) videosWithBeats++;
			totalBeats += count;
		}
	});

	await Promise.all(tasks);

	return { totalBeats, videosWithBeats };
}
