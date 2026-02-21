/**
 * TextOverlay — mode-specific styled text overlays for CLC videos.
 *
 * Replicates the text styling from getTextStyle() in shotstack.ts,
 * but uses React/CSS instead of Shotstack HTML assets.
 *
 * Brand colors:
 *   Primary: #1B4D3E (deep forest green)
 *   Secondary: #C9A84C (gold)
 *   Text: #FFFFFF (white)
 *   Dark: #1A1A1A (near-black)
 */

import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';

interface TextOverlayProps {
	text: string;
	mode: string;
	position: 'top' | 'center' | 'bottom';
	isFirst: boolean;
	isLast: boolean;
}

const BRAND_GREEN = '#1B4D3E';
const BRAND_GOLD = '#C9A84C';

export const TextOverlay: React.FC<TextOverlayProps> = ({ text, mode, position, isFirst, isLast }) => {
	const frame = useCurrentFrame();
	const { durationInFrames } = useVideoConfig();

	// Fade in/out animation (8 frames fade in, 8 frames fade out)
	const fadeInFrames = 8;
	const fadeOutFrames = 8;
	const opacity = interpolate(
		frame,
		[0, fadeInFrames, Math.max(fadeInFrames + 1, durationInFrames - fadeOutFrames), durationInFrames],
		[0, 1, 1, 0],
		{ extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
	);

	// Position styles
	const positionStyle: React.CSSProperties = {
		position: 'absolute',
		left: 0,
		right: 0,
		display: 'flex',
		justifyContent: 'center',
		...(position === 'top' ? { top: '8%' } : {}),
		...(position === 'center' ? { top: '50%', transform: 'translateY(-50%)' } : {}),
		...(position === 'bottom' ? { bottom: '8%' } : {}),
	};

	// Mode-specific text styling
	const textStyle = getTextStyle(mode, isFirst, isLast);

	return (
		<AbsoluteFill style={{ opacity }}>
			<div style={positionStyle}>
				<div style={textStyle}>
					{mode === 'game_day' || mode === 'quick_hit' ? text.toUpperCase() : text}
				</div>
			</div>
		</AbsoluteFill>
	);
};

function getTextStyle(mode: string, isFirst: boolean, isLast: boolean): React.CSSProperties {
	const baseStyle: React.CSSProperties = {
		fontFamily: "'Montserrat', sans-serif",
		color: '#FFFFFF',
		textAlign: 'center' as const,
		margin: 0,
		maxWidth: '85%',
	};

	switch (mode) {
		case 'game_day':
			// Bold, high-energy — uppercase, green bg, gold border-left
			return {
				...baseStyle,
				fontSize: 38,
				fontWeight: 800,
				letterSpacing: 2,
				backgroundColor: 'rgba(27, 77, 62, 0.85)',
				padding: '12px 28px',
				borderLeft: `5px solid ${BRAND_GOLD}`,
			};

		case 'our_story':
			// Warm, intimate — subtle bg, gold underline
			return {
				...baseStyle,
				fontSize: 30,
				fontWeight: 400,
				lineHeight: 1.4,
				backgroundColor: 'rgba(0, 0, 0, 0.55)',
				padding: '14px 32px',
				borderBottom: `3px solid ${BRAND_GOLD}`,
			};

		case 'quick_hit':
			// Bold, centered, TikTok-native — large text, text shadow, no bg
			return {
				...baseStyle,
				fontSize: 44,
				fontWeight: 900,
				letterSpacing: 1,
				textShadow: '3px 3px 6px rgba(0, 0, 0, 0.8)',
				WebkitTextStroke: '2px rgba(0, 0, 0, 0.6)',
				padding: '8px 20px',
			};

		case 'showcase':
			if (isLast) {
				// CTA card — brand green bg, gold text
				return {
					...baseStyle,
					fontSize: 32,
					fontWeight: 600,
					color: BRAND_GOLD,
					backgroundColor: 'rgba(27, 77, 62, 0.9)',
					padding: '16px 40px',
					letterSpacing: 1,
				};
			}
			// Premium, cinematic — clean, minimal
			return {
				...baseStyle,
				fontSize: 34,
				fontWeight: 500,
				backgroundColor: 'rgba(0, 0, 0, 0.45)',
				padding: '14px 36px',
				borderBottom: `2px solid ${BRAND_GOLD}`,
				letterSpacing: 0.5,
			};

		default:
			return {
				...baseStyle,
				fontSize: 32,
				fontWeight: 600,
				backgroundColor: 'rgba(0, 0, 0, 0.6)',
				padding: '12px 28px',
			};
	}
}
