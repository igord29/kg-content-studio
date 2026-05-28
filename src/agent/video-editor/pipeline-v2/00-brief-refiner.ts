/**
 * Step 0: Brief Refiner
 *
 * Takes the user's casual topic/purpose input and produces a structured
 * Sasha-style brief that every downstream step can lean on.
 *
 * Why this exists: the v2 Story Planner reads `input.topic` and
 * `input.purpose` raw — whatever the user typed lands directly in the
 * prompt. Casual input ("Tennis at the us open. Create a video for tiktok
 * of our kids playing redball tennis.") forces Sasha to invent context
 * (audience, tone, emotional arc, what to emphasize/avoid), and that
 * inference is where creative drift creeps in (e.g., the "Their first
 * rally" overreach we saw, or filter-mixing across beats).
 *
 * This step refines casual input into a documentary-editor brief BEFORE
 * Story Planner sees it. The orchestrator swaps the refined strings into
 * `input.topic` / `input.purpose` in place, so no downstream step needs
 * to know this layer exists.
 *
 * Cost: one extra Claude Sonnet call per render (~5-15s, ~$0.003-0.01).
 * If it fails, it throws — the orchestrator's existing v2-failure path
 * in auto-pipeline.ts catches it and falls back to v1 cleanly.
 *
 * File: src/agent/video-editor/pipeline-v2/00-brief-refiner.ts
 */

import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import type { PipelineInput, StepLogger } from './types';
import { EDITOR_PERSONA } from './editor-persona';

export interface RefinedBrief {
	/** Factual brief: subject + setting + who + what (1-2 sentences) */
	topic: string;
	/** Editorial brief: audience + emotional arc + tone (2-3 sentences) */
	purpose: string;
	/** Who's watching this video */
	audience: string;
	/** Editorial tone in 3-6 words */
	tone: string;
	/** 1-3 specific moments to lean into */
	emphasize: string[];
	/** 1-3 things to avoid (unverified claims, manipulative beats, etc.) */
	avoid: string[];
	/** Optional question for the user IF the refiner cannot proceed without more input */
	clarifyingQuestion?: string;
	/** Refiner's own honest assessment of how grounded this brief is */
	confidence: 'high' | 'medium' | 'low';
}

const BRIEF_REFINER_SYSTEM_PROMPT = `
${EDITOR_PERSONA}

# YOUR JOB IN THIS STEP

You are taking a casual user request and producing the kind of brief YOU would write for yourself if you were preparing to edit this video. Every downstream step (Story Planner, Hook Selector, Body Composer, Close Composer) will read this brief — make it specific enough that they can do their work without guessing what you wanted.

# WORKING RULES

1. **Enrich, don't invent.** Use the catalog summary to ground details (locations, people counts, content type, activities). NEVER invent narrative the catalog hasn't verified — don't claim it's "their first rally" if nothing tells you it's their first anything. Unverified narrative is the *quiet* version of manufactured inspiration; reject it.

2. **If the user already provided a rich brief, preserve their wording** with minor structural cleanup only. Refinement is not rewriting for its own sake.

3. **Set confidence honestly.**
   - "high" — you have enough to write a specific, catalog-grounded brief.
   - "medium" — you can infer reasonable defaults but some editorial choices are guesses.
   - "low" — the input is too vague to brief well; you cannot pick a defensible tone or audience without more input.

4. **clarifyingQuestion** is for cases where you genuinely cannot proceed without user input — ONE short question (under 100 chars). Omit the field if you can proceed.

5. **emphasize / avoid** must be SPECIFIC to this video, not generic editing rules. "Lean into the moment a kid finally connects on a rally" is specific. "Show real effort" is generic — skip generic items.

# OUTPUT

Output VALID JSON, no markdown fences, no prose around it:

{
  "topic": "<factual: 1-2 sentences. Subject + setting + who + what>",
  "purpose": "<editorial: 2-3 sentences. Audience + emotional arc + tone>",
  "audience": "<who watches this>",
  "tone": "<3-6 words>",
  "emphasize": ["<specific moment 1>", "<specific moment 2>"],
  "avoid": ["<thing 1>", "<thing 2>"],
  "clarifyingQuestion": "<omit unless you genuinely need user input>",
  "confidence": "high" | "medium" | "low"
}
`.trim();

export async function refineBrief(
	input: PipelineInput,
	logger: StepLogger,
): Promise<RefinedBrief> {
	// Compact catalog summary so the refiner can ground details without
	// inventing them. Capped at 8 videos to keep the prompt small.
	const footageSummary = input.videoMetadata.slice(0, 8).map((v, i) => {
		const ce = input.catalog.get(v.id);
		if (!ce) return `[${i + 1}] ${v.name} (no catalog data)`;
		return `[${i + 1}] ${v.name}: ${ce.activity || 'unknown activity'} | type=${ce.contentType || '?'} | people=${ce.peopleCount || '?'} | location=${ce.suspectedLocation || '?'}`;
	}).join('\n');

	const userPrompt = `User wrote:
Topic: ${input.topic}
Purpose: ${input.purpose}
Mode: ${input.editMode}
Platform: ${input.platform}

Available footage (catalog summary, first 8):
${footageSummary}

Refine into a structured brief. Use catalog facts. Do not invent narrative. Return JSON only.`;

	const result = await generateText({
		model: anthropic('claude-sonnet-4-6'),
		system: BRIEF_REFINER_SYSTEM_PROMPT,
		prompt: userPrompt,
		maxOutputTokens: 800,
		abortSignal: AbortSignal.timeout(45_000),
	});

	const raw = result.text.trim();
	const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/);
	const jsonText = jsonMatch?.[1] ?? raw;

	let brief: RefinedBrief;
	try {
		brief = JSON.parse(jsonText.trim()) as RefinedBrief;
	} catch (err) {
		logger.error('[brief-refiner] Failed to parse JSON: %s', String(err));
		logger.error('[brief-refiner] Raw output (first 500 chars): %s', raw.slice(0, 500));
		throw new Error(`Brief Refiner output was not valid JSON: ${String(err)}`);
	}

	// ─────────────────────────────────────────────────────────────────────
	// TODO ── ASK vs ASSUME (your editorial UX call — write 5-10 lines here)
	// ─────────────────────────────────────────────────────────────────────
	//
	// The refiner sets `brief.confidence` ('high' | 'medium' | 'low') and may
	// emit a `brief.clarifyingQuestion` when the user input is too vague to
	// proceed cleanly. Below is the point in the code where YOU decide what
	// happens in the borderline cases.
	//
	// Three approaches worth considering:
	//
	//   (a) SILENT / always-assume. Never surface the question. Just use the
	//       refiner's best guess and proceed. Fastest, most "magical."
	//       Risk: the brief drifts from what the user actually wanted, and
	//       Sasha confidently edits a video the user didn't ask for.
	//
	//   (b) CAUTIOUS / surface on low. If confidence === 'low' OR a
	//       clarifyingQuestion exists, throw a structured error that the API
	//       handler can turn into a UI prompt back to the user. Slowest,
	//       safest. Best when wasted renders are expensive (Lambda time,
	//       AWS spend, the auto-review loop running on bad output).
	//
	//   (c) HYBRID. Only surface a question if the user explicitly toggled
	//       an "interactive brief refinement" setting (e.g., an env flag
	//       VIDEO_EDITOR_INTERACTIVE_BRIEF=true, or a UI checkbox).
	//       Pros: opt-in UX. Cons: another flag to manage.
	//
	// Default below is (a) — silent, always-proceed — so the pipeline is
	// FUNCTIONAL OUT OF THE BOX. Replace this with your preferred logic.
	//
	if (brief.confidence === 'low' && brief.clarifyingQuestion) {
		// YOUR LOGIC GOES HERE. Current default = SILENT (option a):
		logger.warn(
			'[brief-refiner] Low confidence brief. Proceeding silently. Refiner question was: "%s"',
			brief.clarifyingQuestion,
		);
	}
	// ─────────────────────────────────────────────────────────────────────

	logger.info(
		'[brief-refiner] Refined (confidence=%s): topic="%s"; purpose="%s"',
		brief.confidence,
		brief.topic.slice(0, 80),
		brief.purpose.slice(0, 80),
	);

	return brief;
}
