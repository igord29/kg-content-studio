/**
 * CLCVideo — main Remotion composition for Community Literacy Club videos.
 *
 * Receives the same edit plan data as Shotstack but renders using React components
 * with per-frame control, custom transitions, and CSS-driven effects.
 *
 * Layers (back to front):
 *   1. Background color fill (prevents black frames)
 *   2. Video clips with transitions + Ken Burns effects
 *   3. Text overlays with mode-specific styling
 *   4. Audio soundtrack with volume interpolation
 */

import React from 'react';
import {
	AbsoluteFill,
	Audio,
	Sequence,
	useVideoConfig,
	interpolate,
	useCurrentFrame,
} from 'remotion';
import { TransitionSeries, springTiming } from '@remotion/transitions';
import type { CLCVideoProps } from './types';
import { VideoClip, getEffectForClip } from './VideoClip';
import { TextOverlay } from './TextOverlay';
import { getRemotionTransition } from './transitions';
import { PanelFrame } from './PanelFrame';

/**
 * How many frames a single clip occupies in its own TransitionSeries.Sequence,
 * and whether it is preceded by a transition.
 *
 * Deliberately a single shared helper: the picture timeline and the overlay
 * time remap below BOTH need these numbers, and if the two ever computed them
 * differently the overlays would silently desync from the video again.
 *
 * The transition-related floor applies ONLY to clips that actually carry a
 * transition. It used to apply unconditionally, which padded every clip up to
 * (2 * transitionDuration + 1s) — in our_story (1.0s transitions) a planned
 * 1.5s beat was forced out to 3.0s and the extra 1.5s rendered as a FROZEN
 * last frame.
 *
 * Math.round (not Math.ceil) because clip.length is a float: 5 / 0.3 * 30
 * evaluates to 500.00000000000006, and ceil turns that into a spurious held frame.
 */
export function planClip(
	clip: CLCVideoProps['clips'][number],
	index: number,
	fps: number,
	transitionDurationFrames: number,
): { clipFrames: number; hasTransition: boolean } {
	const hasTransition = index > 0 && transitionDurationFrames > 0 && !!clip.transitionType;
	const clipFrames = Math.max(
		Math.round(clip.length * fps),
		hasTransition ? transitionDurationFrames * 2 + Math.round(fps * 0.3) : Math.round(fps * 0.4),
	);
	return { clipFrames, hasTransition };
}

/**
 * Total frames the composition occupies. THIS is the number
 * `calculateMetadata` in entry.tsx must register — it has to agree with the
 * tree built below or the video is cut short (or padded with dead frames).
 *
 * The previous entry.tsx formula subtracted overlap for EVERY clip boundary
 * (`clips.length - 1`), assuming a transition on every cut. But a transition
 * is only emitted when `clip.transitionType` is set, and the director is told
 * to make ~80% of cuts hard. An 8-clip our_story edit with 2 real transitions
 * therefore had 7 x 30 frames subtracted instead of 2 x 30 — five seconds of
 * finished video silently truncated off the end.
 *
 * It also summed raw `clip.length`, ignoring the per-clip minimum floor that
 * planClip applies, so short clips desynced the two clocks further.
 */
export function computeCompositionFrames(
	clips: CLCVideoProps['clips'],
	fps: number,
	transitionDurationFrames: number,
): number {
	let total = 0;
	let transitionCount = 0;
	clips.forEach((clip, index) => {
		const { clipFrames, hasTransition } = planClip(clip, index, fps, transitionDurationFrames);
		total += clipFrames;
		if (hasTransition) transitionCount++;
	});
	// Each transition pulls its clip back onto its predecessor, shortening the
	// timeline by exactly one transition duration.
	return Math.max(30, total - transitionCount * transitionDurationFrames);
}

export const CLCVideo: React.FC<CLCVideoProps> = ({
	clips,
	mode,
	width,
	height,
	fps,
	textOverlays,
	musicSrc,
	musicVolume = 0.3,
	bgColor,
	transitionDurationFrames,
	layout = 'fill',
	panel,
}) => {
	const { durationInFrames, width: compWidth, height: compHeight } = useVideoConfig();

	// Build the transition + clip element tree ONCE per prop change instead of on
	// every rendered frame. It depends only on clips / mode / timing / dimensions —
	// never on the current frame — so without memoization Remotion re-runs this
	// flatMap and RE-CREATES every transition presentation object on all N frames
	// of the render. Memoizing keeps transition instances stable (Remotion
	// transitions skill, Golden Rule #4) and removes per-frame allocations.
	const clipTimeline = React.useMemo(
		() =>
			clips.flatMap((clip, index) => {
				const { clipFrames, hasTransition } = planClip(clip, index, fps, transitionDurationFrames);

				// Get effect for this clip position
				const effect = clip.effect || getEffectForClip(mode, index);

				// Build transition element (between clips, not before first)
				const elements: React.ReactNode[] = [];

				// Add a transition ONLY when the edit plan deliberately asks for one
				// (clip.transitionType is set). Omitting it = a HARD CUT: no transition
				// element, so this sequence butts directly against the previous one.
				// This honors the director prompt's "80% hard cuts — reserve transitions
				// for deliberate moments" rule. (Previously an omitted type fell through
				// to the mode pool, forcing a transition on EVERY cut, which reads amateur.)
				if (hasTransition) {
					elements.push(
						<TransitionSeries.Transition
							key={`transition-${index}`}
							// Real composition dimensions so circle/clock wipes are
							// geometrically correct on every aspect ratio, not just 9:16.
							presentation={getRemotionTransition(clip.transitionType, clip.transitionDirection, compWidth, compHeight)}
							timing={springTiming({
								durationInFrames: transitionDurationFrames,
								config: { damping: 200 },
							})}
						/>,
					);
				}

				// Add the clip sequence.
				// clipLengthFrames is threaded so VideoClip can compute Ken Burns progress
				// against its own sequence length rather than the whole composition — see
				// VideoClipProps.clipLengthFrames for the background on why this matters.
				elements.push(
					<TransitionSeries.Sequence
						key={`clip-${index}`}
						durationInFrames={clipFrames}
					>
						<VideoClip
							src={clip.src}
							effect={effect}
							filter={clip.filter}
							speedKeyframes={clip.speedKeyframes}
							trimStart={clip.trimStart}
							cropX={clip.cropX}
							cropY={clip.cropY}
							zoom={clip.zoom}
							clipLengthFrames={clipFrames}
						/>
					</TransitionSeries.Sequence>,
				);

				return elements;
			}),
		[clips, mode, fps, transitionDurationFrames, compWidth, compHeight],
	);

	/**
	 * Overlay clock remap — fixes text overlays drifting LATE.
	 *
	 * TransitionSeries does not ADD time for a transition, it OVERLAPS the two
	 * adjacent sequences by transitionDurationFrames. So the real picture
	 * timeline is SHORTER than the naive sum of clip lengths by
	 * (number of transitions x transitionDurationFrames).
	 *
	 * Overlay startFrame values are computed upstream in render.ts as
	 * Math.round(overlay.start * fps) against a BUTT-JOINED timeline that knows
	 * nothing about that overlap. With 4 transitions at 1.0s @30fps, an overlay
	 * meant for the last clip lands 120 frames — 4 SECONDS — late, frequently
	 * past the end of the composition entirely.
	 *
	 * Fix: build both clocks side by side, find which clip a given butt-joined
	 * frame falls into, and re-express the same offset-within-that-clip on the
	 * actual (transition-compressed) clock.
	 */
	const remapOverlayFrame = React.useMemo(() => {
		// For each clip: its start on the butt-joined clock, its start on the
		// actual clock, and its own length.
		const starts: Array<{ butt: number; actual: number; frames: number }> = [];
		let butt = 0;
		let actual = 0;
		for (let i = 0; i < clips.length; i++) {
			const { clipFrames, hasTransition } = planClip(clips[i]!, i, fps, transitionDurationFrames);
			// A transition pulls this clip BACK onto its predecessor by
			// transitionDurationFrames. That subtraction is the entire drift.
			if (hasTransition) actual -= transitionDurationFrames;
			starts.push({ butt, actual, frames: clipFrames });
			butt += clipFrames;
			actual += clipFrames;
		}

		return (buttFrame: number): number => {
			if (starts.length === 0) return Math.max(0, buttFrame);
			// Walk backwards to the first clip that starts at or before this frame.
			for (let i = starts.length - 1; i >= 0; i--) {
				const s = starts[i]!;
				if (buttFrame >= s.butt) {
					// Preserve the offset into the clip (clamped to the clip's own length
					// so a stale/overlong startFrame can't run past the clip it belongs to).
					const offset = Math.min(buttFrame - s.butt, s.frames);
					return Math.max(0, s.actual + offset);
				}
			}
			return Math.max(0, buttFrame);
		};
	}, [clips, fps, transitionDurationFrames]);

	if (clips.length === 0) {
		return (
			<AbsoluteFill style={{ background: bgColor, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
				<div style={{ color: '#fff', fontFamily: 'Montserrat, sans-serif', fontSize: 32 }}>
					No clips provided
				</div>
			</AbsoluteFill>
		);
	}

	// The picture layers. In 'panel' layout these get composited inside
	// PanelFrame instead of filling the frame — see PanelFrame.tsx for why that
	// is the right call on wide, subject-small source footage.
	const picture = (
		<>
			<AbsoluteFill style={{ background: bgColor }} />
			<TransitionSeries>{clipTimeline}</TransitionSeries>
		</>
	);

	return (
		<AbsoluteFill>
			{layout === 'panel' ? (
				<PanelFrame
					headline={panel?.headline}
					headlineAccent={panel?.headlineAccent}
					statLine={panel?.statLine}
					subLine={panel?.subLine}
					brandLine={panel?.brandLine}
				>
					{picture}
				</PanelFrame>
			) : (
				picture
			)}

			{/* Layer 3: Text overlays — startFrame is on the butt-joined clock, so it
			    must be remapped onto the transition-compressed picture timeline. */}
			{textOverlays.map((overlay, index) => {
				const from = remapOverlayFrame(overlay.startFrame);
				// Anything landing at or past the end used to be clamped to
				// (durationInFrames - 1), which flashed the card for a single frame.
				// A 1-frame title card reads as a glitch — drop it instead.
				if (from >= durationInFrames - 1) return null;
				// Still clamp the tail so the Sequence cannot run past the composition.
				const durationFrames = Math.max(1, Math.min(overlay.durationFrames, durationInFrames - from));
				return (
					<Sequence
						key={`text-${index}`}
						from={from}
						durationInFrames={durationFrames}
					>
						<TextOverlay
							text={overlay.text}
							mode={mode}
							position={overlay.position}
							isFirst={overlay.isFirst}
							isLast={overlay.isLast}
							animation={overlay.animation}
						/>
					</Sequence>
				);
			})}

			{/* Layer 4: Music soundtrack with fade in/out */}
			{musicSrc && (
				<Audio
					src={musicSrc}
					volume={(f) => {
						// Fade in over 1 second, fade out over 2 seconds
						const fadeInFrames = fps;
						const fadeOutFrames = fps * 2;
						// Guard: ensure inputRange is monotonically increasing
						// If durationInFrames is too short, skip the hold phase
						if (durationInFrames <= fadeInFrames + fadeOutFrames + 2) {
							const mid = Math.floor(durationInFrames / 2);
							if (mid <= 0 || durationInFrames <= 1) return musicVolume;
							return interpolate(
								f,
								[0, mid, durationInFrames],
								[0, musicVolume, 0],
								{ extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
							);
						}
						return interpolate(
							f,
							[0, fadeInFrames, durationInFrames - fadeOutFrames, durationInFrames],
							[0, musicVolume, musicVolume, 0],
							{ extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
						);
					}}
				/>
			)}
		</AbsoluteFill>
	);
};
