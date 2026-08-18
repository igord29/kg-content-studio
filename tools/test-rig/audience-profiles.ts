/**
 * Audience-aware role scoring for the rig planner.
 *
 * A single generic "score" ranks technically-good footage; it cannot tell a
 * scroll-stopping hook from the calm group shot that should carry the donate
 * ask. Each edit role gets its own scoring function over the catalog's
 * existing per-moment signals (emotion, valence, beat, people, movement, the
 * GPT-written briefs) plus locally-detected audio cheer spikes — weighted for
 * who is watching: parents (is my kid safe, seen, and lit up here?) or donors
 * (does my money visibly change kids' lives, at scale?).
 *
 * File: tools/test-rig/audience-profiles.ts
 */

import type { VettedSegment } from '../../src/agent/video-editor/pipeline-v2/shot-list';
import type { CatalogEntry } from '../../src/agent/video-editor/google-drive';

export type Audience = 'parents' | 'donors';
export type Role = 'hook' | 'establish' | 'skill' | 'connection' | 'climax' | 'cta';

// Semantic hints mined from the briefs GPT-4o already wrote per moment.
const CELEBRATION = /celebrat|cheer|excit|jump|fist|high.?five|hug|clap|smil|laugh|happy|joy|win|winning|triumph|react|point/i;
const FOCUS = /focus|concentrat|think|study|careful|intens|serious|strateg|plan|consider|contemplat/i;
const COACHING = /coach|instruct|teach|help|guid|demonstrat|explain|mentor|adult|volunteer/i;
const GROUP = /group|kids|children|team|crowd|together|several|many|class/i;
const PLAY = /serve|swing|forehand|backhand|rally|hit|move|play|match|game|volley|chess|piece|board/i;

export interface SegmentContext {
	/** All in-span sample briefs, joined — the semantic layer of the catalog */
	briefs: string;
	/** Valence of the highest-emotion sample in the span */
	peakValence: string;
	/** Timestamp of the highest-emotion sample — the cold-open anchor */
	peakEmotionTs: number;
	/** 1-5 movement axis, max over the span */
	maxMovement: number;
	/** An audio cheer/laughter loudness spike lands inside the span */
	hasSpike: boolean;
}

export function contextFor(entry: CatalogEntry, seg: VettedSegment, spikes: number[]): SegmentContext {
	const inSpan = (entry.timestampScores ?? []).filter(s => s.timestamp >= seg.start && s.timestamp <= seg.end);
	const peak = inSpan.length
		? inSpan.reduce((a, b) => (((a.emotion ?? 0) >= (b.emotion ?? 0)) ? a : b))
		: undefined;
	return {
		briefs: inSpan.map(s => s.brief ?? '').join(' '),
		peakValence: peak?.valence ?? 'neutral',
		peakEmotionTs: peak?.timestamp ?? seg.start,
		maxMovement: Math.max(0, ...inSpan.map(s => s.movement ?? 0)),
		hasSpike: spikes.some(t => t >= seg.start - 0.5 && t <= seg.end + 0.5),
	};
}

/**
 * Role-specific desirability. Scales are informal — only the ordering within
 * one role matters, never comparisons across roles.
 */
export function scoreForRole(seg: VettedSegment, ctx: SegmentContext, role: Role, audience: Audience): number {
	const close = seg.meanFill >= 0.45 ? 3 : seg.meanFill >= 0.35 ? 1.5 : 0;
	const wide = seg.meanFill < 0.40 ? 2.5 : 0;
	const midFill = seg.meanFill >= 0.30 && seg.meanFill <= 0.55 ? 1.5 : 0;
	const positive = ctx.peakValence === 'positive';

	switch (role) {
		case 'hook': {
			// Job: stop the thumb inside 2 seconds. Emotion on a visible face,
			// mid-action, ideally with an audible reason to believe it.
			let s = 2.2 * seg.peakEmotion + seg.meanQuality + close;
			if (seg.beat === 'triumph') s += 3;
			else if (seg.beat === 'hook') s += 2;
			else if (seg.beat === 'turn') s += 1;
			if (CELEBRATION.test(ctx.briefs)) s += 2.5;
			if (ctx.hasSpike) s += 3;
			if (positive) s += 1;
			else if (ctx.peakValence === 'negative') s -= 1.5;
			if (ctx.maxMovement >= 4) s += 1;
			s += audience === 'parents'
				? (seg.peakPeople <= 3 && seg.meanFill >= 0.40 ? 1.5 : 0) // one kid, seen up close
				: (seg.peakPeople >= 4 ? 1.5 : 0);                        // a room full of energy
			return s;
		}
		case 'establish': {
			// Job: where are we, who is here. Wide, populated.
			let s = seg.meanQuality + wide + (seg.peakPeople >= 4 ? 2 : 0) + (GROUP.test(ctx.briefs) ? 1.5 : 0);
			if (seg.beat === 'community') s += 1.5;
			if (audience === 'donors' && seg.peakPeople >= 4) s += 1.5; // scale is the donor's proof
			return s;
		}
		case 'skill': {
			// Job: real learning is happening — focus, form, actual play.
			let s = 1.2 * seg.meanQuality + midFill;
			if (FOCUS.test(ctx.briefs)) s += 3;
			if (PLAY.test(ctx.briefs)) s += 2;
			if (ctx.maxMovement >= 3) s += 1;
			return s;
		}
		case 'connection': {
			// Job: a kid is not alone here. Coach-with-kid is THE parent signal.
			let s = 0.8 * seg.meanQuality + 0.8 * seg.peakEmotion;
			if (COACHING.test(ctx.briefs)) s += audience === 'parents' ? 5 : 3.5;
			if (GROUP.test(ctx.briefs)) s += 1;
			if (seg.beat === 'community') s += 2;
			else if (seg.beat === 'reflection') s += 1;
			return s;
		}
		case 'climax': {
			// Job: the payoff the hook promised. Loudest, happiest moment available.
			let s = 2.5 * seg.peakEmotion + 0.8 * seg.meanQuality;
			if (seg.beat === 'triumph') s += 4;
			if (CELEBRATION.test(ctx.briefs)) s += 3;
			if (ctx.hasSpike) s += 4;
			if (positive) s += 1.5;
			return s;
		}
		case 'cta': {
			// Job: hold still and carry the ask. Calm, warm, group, room for text.
			let s = 0.5 * seg.meanQuality + midFill + (seg.peakPeople >= 3 ? 3 : 0);
			if (seg.beat === 'community') s += 3;
			else if (seg.beat === 'reflection') s += 2;
			if (ctx.maxMovement <= 2) s += 2.5;
			else if (ctx.maxMovement === 3) s += 1;
			if (GROUP.test(ctx.briefs)) s += 1.5;
			if (positive) s += 1;
			return s;
		}
	}
}

/** The close overlay IS the CTA — one line, audience-addressed. */
export const CTA_TEXT: Record<Audience, string> = {
	parents: 'Give your child this focus — enroll at CLC',
	donors: 'Your gift puts a kid at the board — give today',
};
