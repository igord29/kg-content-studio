/**
 * Story Studio — narrated social videos built from catalogued footage.
 *
 * The flow mirrors how the hand-made CLC story videos were produced:
 *   1. facts + footage   → 2. script (editable lines)   → 3. voice-over per line
 *   → 4. storyboard (a shot for every beat, swappable)  → 5. render (9:16 + 16:9,
 *   captions, emoji, sound effects, transitions, logo card, SRT, thumbnail, post copy)
 *
 * File: src/agent/video-editor/story/types.ts
 */

export type StoryStatus = 'draft' | 'scripted' | 'voiced' | 'storyboarded' | 'rendered';

export interface StoryLine {
	text: string;
	/** Pause after this line, seconds (beats for titles / sound effects). */
	pauseAfter?: number;
	/** Emoji (code from the asset set) to pop when this line is spoken. */
	emoji?: string;
	/** Word in the line the emoji pops on (defaults to the first highlighted word). */
	emojiWord?: string;
	/** Words to highlight in yellow in the captions. */
	highlight?: string[];
	/** Optional sound effect on this line: clack | tick | ding | page-turn | whoosh | school-bell. */
	sfx?: string;
	/** Optional big title slam shown while this line plays. */
	title?: string;
	/** What footage should show on this line (guides shot picking). */
	visual?: string;
}

export interface VoiceSegment {
	/** Index into script.lines. */
	line: number;
	/** Start / end on the final video timeline, seconds. */
	start: number;
	end: number;
	file: string;
}

export interface FootageMoment {
	fileId: string;
	t: number;
	/** 0 nobody · 1 far/small · 2 medium · 3 close, face readable. */
	people: number;
	/** 0 unusable (blocked/blurred/floor) … 3 clean. */
	quality: number;
	action: string;
	/** Horizontal position of the main subject, 0 left … 1 right. */
	x: number;
	desc: string;
}

export interface SourceInfo {
	fileId: string;
	name: string;
	width: number;
	height: number;
	duration: number;
	indexedAt?: string;
}

export interface Shot {
	/** Timeline position, seconds. */
	start: number;
	dur: number;
	/** Script line this shot plays under. */
	line: number;
	fileId: string;
	t: number;
	/** Subject position 0..1 used to centre the vertical crop. */
	x: number;
	zoom: number;
	/** Brighten dark footage. */
	lift?: boolean;
	/** Transition INTO the next shot. */
	trans?: 'cut' | 'zoomin' | 'fadewhite' | 'slideleft' | 'slideup' | 'smoothleft' | 'wipeleft';
	note?: string;
	/** Alternatives the user can swap to. */
	alternatives?: Array<{ fileId: string; t: number; x: number; desc: string }>;
}

export interface StoryOutputs {
	vertical?: string;
	wide?: string;
	srt?: string;
	thumbnail?: string;
	thumbnailWide?: string;
	postKit?: string;
}

export interface StoryProject {
	id: string;
	createdAt: string;
	updatedAt: string;
	title: string;
	/** What happened, who it's for, anything the narrator must say. */
	facts: string;
	audience: string;
	callToAction: string;
	targetSeconds: number;
	/** Headline on the logo end card (default "Follow the journey"). */
	cardText?: string;
	videoIds: string[];
	status: StoryStatus;
	script?: { lines: StoryLine[]; openingTitle?: string };
	voice?: { provider: string; voiceId: string; segments: VoiceSegment[]; totalSeconds: number };
	sources?: SourceInfo[];
	storyboard?: Shot[];
	outputs?: StoryOutputs;
	/** Long-running step currently executing, if any. */
	job?: { step: string; state: 'running' | 'done' | 'failed'; progress: string; error?: string; startedAt: string };
}
