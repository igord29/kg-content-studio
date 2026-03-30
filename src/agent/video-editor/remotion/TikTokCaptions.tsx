/**
 * TikTok-Style Captions Component
 *
 * Renders word-level highlighted captions over video, TikTok-style.
 * Adapted from remotion-dev/template-tiktok's CaptionedVideo component.
 *
 * Uses @remotion/captions for page grouping and word-level timing.
 * Captions are passed as props (from Groq Whisper transcription),
 * not loaded from static files.
 */

import React, { useMemo } from 'react';
import {
	AbsoluteFill,
	Sequence,
	useCurrentFrame,
	useVideoConfig,
	interpolate,
	spring,
} from 'remotion';
import type { TikTokPage } from '@remotion/captions';
import { createTikTokStyleCaptions } from '@remotion/captions';

// --- Types ---

export interface CaptionWord {
	text: string;
	fromMs: number;
	toMs: number;
}

export interface TikTokCaptionsProps {
	captions: CaptionWord[];
	/** How many ms of words to group per page (default: 1200) */
	groupingMs?: number;
	/** Highlight color for the active word */
	highlightColor?: string;
	/** Font size in px */
	fontSize?: number;
	/** Position from bottom in px */
	bottomOffset?: number;
}

// --- Caption Page Component ---

const CaptionPage: React.FC<{
	page: TikTokPage;
	highlightColor: string;
	fontSize: number;
	bottomOffset: number;
}> = ({ page, highlightColor, fontSize, bottomOffset }) => {
	const frame = useCurrentFrame();
	const { fps, width } = useVideoConfig();

	// Spring entrance animation
	const enter = spring({
		frame,
		fps,
		config: { damping: 200 },
		durationInFrames: 5,
	});

	const timeInMs = (frame / fps) * 1000;

	// Scale font to fit width
	const maxWidth = width * 0.85;

	return (
		<AbsoluteFill
			style={{
				justifyContent: 'flex-end',
				alignItems: 'center',
				bottom: bottomOffset,
				top: undefined,
				height: 'auto',
				paddingBottom: bottomOffset,
			}}
		>
			<div
				style={{
					fontSize,
					color: 'white',
					WebkitTextStroke: '3px black',
					paintOrder: 'stroke',
					fontFamily: 'Montserrat, Inter, sans-serif',
					fontWeight: 900,
					textTransform: 'uppercase',
					textAlign: 'center',
					maxWidth,
					lineHeight: 1.2,
					transform: `scale(${interpolate(enter, [0, 1], [0.8, 1])}) translateY(${interpolate(enter, [0, 1], [30, 0])}px)`,
				}}
			>
				{page.tokens.map((t) => {
					const startRelative = t.fromMs - page.startMs;
					const endRelative = t.toMs - page.startMs;
					const active = startRelative <= timeInMs && endRelative > timeInMs;

					return (
						<span
							key={t.fromMs}
							style={{
								display: 'inline',
								whiteSpace: 'pre',
								color: active ? highlightColor : 'white',
								transition: 'color 0.1s',
							}}
						>
							{t.text}
						</span>
					);
				})}
			</div>
		</AbsoluteFill>
	);
};

// --- Main Component ---

export const TikTokCaptions: React.FC<TikTokCaptionsProps> = ({
	captions,
	groupingMs = 1200,
	highlightColor = '#39E508',
	fontSize = 64,
	bottomOffset = 200,
}) => {
	const { fps } = useVideoConfig();

	const { pages } = useMemo(() => {
		if (!captions || captions.length === 0) {
			return { pages: [] };
		}
		return createTikTokStyleCaptions({
			captions: captions.map(c => ({
				text: c.text,
				startMs: c.fromMs,
				endMs: c.toMs,
				timestampMs: c.fromMs,
				confidence: 1,
			})),
			combineTokensWithinMilliseconds: groupingMs,
		});
	}, [captions, groupingMs]);

	if (pages.length === 0) return null;

	return (
		<AbsoluteFill>
			{pages.map((page, index) => {
				const nextPage = pages[index + 1] ?? null;
				const startFrame = (page.startMs / 1000) * fps;
				const endFrame = Math.min(
					nextPage ? (nextPage.startMs / 1000) * fps : Infinity,
					startFrame + (groupingMs / 1000) * fps,
				);
				const durationInFrames = Math.max(1, Math.round(endFrame - startFrame));

				return (
					<Sequence
						key={index}
						from={Math.round(startFrame)}
						durationInFrames={durationInFrames}
					>
						<CaptionPage
							page={page}
							highlightColor={highlightColor}
							fontSize={fontSize}
							bottomOffset={bottomOffset}
						/>
					</Sequence>
				);
			})}
		</AbsoluteFill>
	);
};
