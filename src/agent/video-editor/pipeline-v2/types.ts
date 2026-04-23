/**
 * Shared types for the v2 multi-step video-editor pipeline.
 *
 * The v1 pipeline stuffs ALL editorial decisions — mode choice, story arc,
 * hook selection, body composition, slow-mo placement, music direction,
 * text overlays — into a single 14K-token mega-prompt that runs in one
 * generateText call. This saturates the model's attention and makes it
 * impossible to debug WHICH decision went wrong when the output is bad.
 *
 * The v2 pipeline breaks these into 4 focused steps, each with a ~500-
 * 1500-token system prompt, each with a typed input and output:
 *
 *   1. Story Planner  — picks mode, identifies emotional center, assigns
 *                       setup/turn/response roles to specific videos.
 *                       DOES NOT pick trim points.
 *
 *   2. Hook Selector  — takes story arc + scene data for the setup source,
 *                       picks the single hook clip with exact trim points.
 *                       Enforces STORY HOOK ARC RULE in code.
 *
 *   3. Body Composer  — takes story arc + hook + scene data for body
 *                       sources, composes 4-6 clips covering establish →
 *                       showcase → climax. Enforces SLOW-MO WINDOWING.
 *
 *   4. Close Composer — takes everything so far, writes community + close
 *                       clips + all text overlays.
 *
 * Each step can fail independently. The orchestrator logs which step
 * produced which clip so you can trace a bad cut to a specific step.
 *
 * File: src/agent/video-editor/pipeline-v2/types.ts
 */

import type { CatalogEntry } from '../google-drive';

// --- Pipeline input (shared by all steps) ---

export interface PipelineInput {
	videoIds: string[];
	catalog: Map<string, CatalogEntry>;
	videoMetadata: VideoMeta[];
	topic: string;
	purpose: string;
	platform: string;
	editMode: 'game_day' | 'our_story' | 'quick_hit' | 'showcase' | 'auto';
	/** Optional override — omit for mode default */
	totalDurationTarget?: number;
}

export interface VideoMeta {
	id: string;
	name: string;
	/** Duration in milliseconds as a string (Drive API format) */
	duration?: string;
	width?: number;
	height?: number;
}

// --- Step 1 output: the story arc ---

export interface StoryArc {
	mode: 'game_day' | 'our_story' | 'quick_hit' | 'showcase';
	/** One-sentence description of the emotional center */
	emotionalCenter: string;
	/** Which video holds the SETUP of the story hook */
	setupSourceId: string;
	/** Which video holds the TURN (often same as setup) */
	turnSourceId: string;
	/** Which video holds the RESPONSE (often same as setup) */
	responseSourceId: string;
	/** Ordered list of beats AFTER the hook */
	bodyBeats: BodyBeat[];
	/** Intent for the closing shot — not a trim point yet */
	closeIntent: string;
	/** Music direction hint for the full video */
	musicDirection: string;
	/** Set by code, not model — was scene analysis available for any source? */
	hasSceneAnalysis: boolean;
}

export interface BodyBeat {
	role: 'establish' | 'showcase' | 'climax' | 'community';
	sourceId: string;
	/** Editorial intent for this beat — NOT a trim point */
	intent: string;
}

// --- Step 2 output: the hook clip ---

export interface HookClip {
	fileId: string;
	filename?: string;
	trimStart: number;
	duration: number;
	speed?: number;
	filter?: string;
	effect?: string;
	purpose: string;
	editNote: string;
}

// --- Step 3 output: body clips ---

export interface BodyClips {
	clips: ClipPick[];
	/** Indices (into clips array) that use slow-mo, for downstream validation */
	slowMoIndices: number[];
}

export interface ClipPick {
	fileId: string;
	filename?: string;
	trimStart: number;
	duration: number;
	speed?: number;
	filter?: string;
	effect?: string;
	transitionType?: string;
	transitionDirection?: string;
	purpose: string;
	editNote?: string;
	freshnessNote?: string;
}

// --- Step 4 output: close + overlays ---

export interface ClosePlan {
	closeClips: ClipPick[];
	textOverlays: TextOverlay[];
}

export interface TextOverlay {
	text: string;
	start: number;
	duration: number;
	position: 'top' | 'center' | 'bottom';
	animation?: string;
}

// --- Final assembled edit plan (drop-in compatible with v1 EditPlan shape) ---

export interface EditPlanV2 {
	mode: string;
	clips: ClipPick[];
	textOverlays: TextOverlay[];
	totalDuration: number;
	transitions: string;
	musicTier?: number;
	musicDirection: string;
	/** Provenance metadata — which step produced what, for debugging */
	_v2Meta?: {
		storyArc: StoryArc;
		generatedAt: string;
		stepDurationsMs: Record<string, number>;
	};
}

export type StepLogger = {
	info: (msg: string, ...args: unknown[]) => void;
	warn: (msg: string, ...args: unknown[]) => void;
	error: (msg: string, ...args: unknown[]) => void;
};
