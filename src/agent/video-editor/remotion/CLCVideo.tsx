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
import { getRemotionTransition, getTransitionForClip } from './transitions';

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
}) => {
	const { durationInFrames } = useVideoConfig();

	if (clips.length === 0) {
		return (
			<AbsoluteFill style={{ background: bgColor, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
				<div style={{ color: '#fff', fontFamily: 'Montserrat, sans-serif', fontSize: 32 }}>
					No clips provided
				</div>
			</AbsoluteFill>
		);
	}

	return (
		<AbsoluteFill>
			{/* Layer 1: Background color (prevents black during transitions) */}
			<AbsoluteFill style={{ background: bgColor }} />

			{/* Layer 2: Video clips with transitions */}
			<TransitionSeries>
				{clips.map((clip, index) => {
					const clipFrames = Math.max(
						Math.ceil(clip.length * fps),
						transitionDurationFrames * 2 + fps, // min: 2 transitions + 1 second
					);

					// Get effect for this clip position
					const effect = clip.effect || getEffectForClip(mode, index);

					// Build transition element (between clips, not before first)
					const elements: React.ReactNode[] = [];

					// Add transition before this clip (except for the first clip)
					if (index > 0) {
						const mapping = clip.transitionType
							? { type: clip.transitionType, direction: clip.transitionDirection }
							: getTransitionForClip(mode, index);

						elements.push(
							<TransitionSeries.Transition
								key={`transition-${index}`}
								presentation={getRemotionTransition(mapping.type, mapping.direction)}
								timing={springTiming({
									durationInFrames: transitionDurationFrames,
									config: { damping: 200 },
								})}
							/>,
						);
					}

					// Add the clip sequence
					elements.push(
						<TransitionSeries.Sequence
							key={`clip-${index}`}
							durationInFrames={clipFrames}
						>
							<VideoClip
								src={clip.src}
								effect={effect}
								filter={clip.filter}
							/>
						</TransitionSeries.Sequence>,
					);

					return elements;
				})}
			</TransitionSeries>

			{/* Layer 3: Text overlays */}
			{textOverlays.map((overlay, index) => (
				<Sequence
					key={`text-${index}`}
					from={Math.min(overlay.startFrame, durationInFrames - 1)}
					durationInFrames={Math.min(
						overlay.durationFrames,
						durationInFrames - Math.min(overlay.startFrame, durationInFrames - 1),
					)}
				>
					<TextOverlay
						text={overlay.text}
						mode={mode}
						position={overlay.position}
						isFirst={overlay.isFirst}
						isLast={overlay.isLast}
					/>
				</Sequence>
			))}

			{/* Layer 4: Music soundtrack with fade in/out */}
			{musicSrc && (
				<Audio
					src={musicSrc}
					volume={(f) => {
						// Fade in over 1 second, fade out over 2 seconds
						const fadeInFrames = fps;
						const fadeOutFrames = fps * 2;
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
