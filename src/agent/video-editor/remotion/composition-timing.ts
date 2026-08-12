/**
 * Composition timing — the single source of truth for how long a CLC video is.
 *
 * WHY THIS FILE EXISTS
 *
 * The composition length was computed in entry.tsx's calculateMetadata, while
 * the actual clip lengths were computed independently inside CLCVideo. The two
 * drifted apart and every rendered video was silently truncated. Two separate
 * divergences stacked up:
 *
 *   1. entry.tsx subtracted a transition overlap for EVERY clip boundary
 *      (`clips.length - 1`), but CLCVideo only renders a transition when that
 *      clip carries an explicit `transitionType`. The director prompt asks for
 *      ~80% hard cuts, so most boundaries had no overlap to subtract. On an
 *      8-clip our_story edit (transitionDuration 1.0s) that alone cut 7.0s off
 *      the end.
 *
 *   2. CLCVideo clamped each clip UP to `transitionDurationFrames * 2 + fps`
 *      frames, but entry.tsx summed the raw `clip.length`. Any clip shorter
 *      than the clamp rendered longer than the metadata accounted for.
 *
 * Both errors push the same way: the rendered content outlasts
 * `durationInFrames`, so Remotion stops early and the tail is lost. The tail is
 * the close beat — the CLC branding shot. Every video was ending mid-shot.
 *
 * The clamp itself was also too aggressive. It existed so a transition (which
 * consumes frames from BOTH neighbours) cannot swallow a clip whole. That
 * reasoning only applies to clips that actually participate in a transition;
 * applying it to hard-cut clips stretched a punchy 1.5s cut to 3.0s and is a
 * direct cause of sluggish pacing. It is now scoped to the clips that need it.
 *
 * Both entry.tsx and CLCVideo import from here. Keep it that way — if you change
 * per-clip length math, change it once, here.
 *
 * File: src/agent/video-editor/remotion/composition-timing.ts
 */

import type { CLCVideoProps } from './types';

type Clip = CLCVideoProps['clips'][number];

/**
 * Does the boundary entering `clips[index]` render a transition?
 *
 * Mirrors the condition in CLCVideo exactly: never before the first clip, only
 * when the plan asked for one, and only when there are frames to spend on it.
 */
export function hasIncomingTransition(
	clips: readonly Clip[],
	index: number,
	transitionDurationFrames: number,
): boolean {
	return index > 0 && transitionDurationFrames > 0 && !!clips[index]?.transitionType;
}

/**
 * Length of a single clip's TransitionSeries.Sequence, in frames.
 *
 * A transition overlaps its two neighbours, so a clip sitting between two of
 * them must be long enough to survive both plus a beat of its own. A clip on a
 * hard cut has nothing eating into it and is left exactly as planned.
 */
export function clipFramesFor(
	clips: readonly Clip[],
	index: number,
	fps: number,
	transitionDurationFrames: number,
): number {
	const clip = clips[index];
	if (!clip) return 1;

	// Math.round, not Math.ceil: ceil biases every clip upward, and across a
	// 10-clip edit that drift is visible against the music bed.
	const planned = Math.max(1, Math.round(clip.length * fps));

	const incoming = hasIncomingTransition(clips, index, transitionDurationFrames);
	const outgoing = hasIncomingTransition(clips, index + 1, transitionDurationFrames);

	const consumedByTransitions =
		(incoming ? transitionDurationFrames : 0) + (outgoing ? transitionDurationFrames : 0);

	// No transition touches this clip -> no floor. Honor the planned length so
	// deliberate short cuts stay short.
	if (consumedByTransitions === 0) return planned;

	// Otherwise guarantee the transitions plus ~1s of clip actually on screen.
	return Math.max(planned, consumedByTransitions + fps);
}

/**
 * Total composition length in frames.
 *
 * Sum every clip's rendered length, then subtract one overlap per transition
 * that genuinely exists — because TransitionSeries plays those frames twice,
 * once from each side.
 */
export function computeCompositionFrames(
	clips: readonly Clip[],
	fps: number,
	transitionDurationFrames: number,
): number {
	if (!clips || clips.length === 0) return 30;

	let total = 0;
	for (let i = 0; i < clips.length; i++) {
		total += clipFramesFor(clips, i, fps, transitionDurationFrames);
	}

	let transitionCount = 0;
	for (let i = 0; i < clips.length; i++) {
		if (hasIncomingTransition(clips, i, transitionDurationFrames)) transitionCount++;
	}
	total -= transitionCount * transitionDurationFrames;

	// Never hand Remotion a zero/negative duration.
	return Math.max(30, total);
}
