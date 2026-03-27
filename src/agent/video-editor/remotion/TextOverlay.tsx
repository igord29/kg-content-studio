/**
 * TextOverlay — mode-specific styled text overlays with animated entry/exit.
 *
 * Supports 6 animation styles: fade, slideUp, slideDown, scaleUp, bounce, typewriter.
 * Default animation is mode-aware: game_day gets scaleUp, quick_hit gets bounce, etc.
 *
 * Brand colors:
 *   Primary: #1B4D3E (deep forest green)
 *   Secondary: #C9A84C (gold)
 *   Text: #FFFFFF (white)
 */

import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import type { TextAnimation } from './types';

interface TextOverlayProps {
	text: string;
	mode: string;
	position: 'top' | 'center' | 'bottom';
	isFirst: boolean;
	isLast: boolean;
	animation?: TextAnimation;
}

const BRAND_GREEN = '#1B4D3E';
const BRAND_GOLD = '#C9A84C';

/** Default animation per mode — each mode gets a distinct text feel */
const MODE_DEFAULT_ANIMATION: Record<string, TextAnimation> = {
	game_day: 'scaleUp',
	our_story: 'fade',
	quick_hit: 'bounce',
	showcase: 'slideUp',
};

export const TextOverlay: React.FC<TextOverlayProps> = ({ text, mode, position, isFirst, isLast, animation }) => {
	const frame = useCurrentFrame();
	const { durationInFrames, fps } = useVideoConfig();

	const anim = animation || MODE_DEFAULT_ANIMATION[mode] || 'fade';

	// Compute entry/exit animation values
	const { opacity, transform: animTransform } = computeAnimation(anim, frame, durationInFrames, fps);

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

	// For typewriter, render partial text
	const displayText = anim === 'typewriter'
		? getTypewriterText(text, frame, durationInFrames, fps, mode)
		: (mode === 'game_day' || mode === 'quick_hit' ? text.toUpperCase() : text);

	return (
		<AbsoluteFill style={{ opacity }}>
			<div style={positionStyle}>
				<div style={{
					...textStyle,
					transform: animTransform,
				}}>
					{displayText}
				</div>
			</div>
		</AbsoluteFill>
	);
};

/**
 * Compute opacity and transform for each animation type.
 *
 * Entry animation plays over the first ~12 frames.
 * Exit animation (fade out) plays over the last ~8 frames.
 * The hold phase in between keeps the text fully visible.
 */
function computeAnimation(
	animation: TextAnimation,
	frame: number,
	durationInFrames: number,
	fps: number,
): { opacity: number; transform: string } {
	const entryFrames = Math.min(12, Math.floor(durationInFrames * 0.3));
	const exitFrames = Math.min(8, Math.floor(durationInFrames * 0.2));

	// Exit fade (shared across all animations)
	const exitOpacity = durationInFrames <= exitFrames + 2
		? 1
		: interpolate(
			frame,
			[Math.max(0, durationInFrames - exitFrames), durationInFrames],
			[1, 0],
			{ extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
		);

	switch (animation) {
		case 'slideUp': {
			const y = interpolate(frame, [0, entryFrames], [40, 0], {
				extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
			});
			const entryOpacity = interpolate(frame, [0, entryFrames], [0, 1], {
				extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
			});
			return {
				opacity: Math.min(entryOpacity, exitOpacity),
				transform: `translateY(${y}px)`,
			};
		}

		case 'slideDown': {
			const y = interpolate(frame, [0, entryFrames], [-40, 0], {
				extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
			});
			const entryOpacity = interpolate(frame, [0, entryFrames], [0, 1], {
				extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
			});
			return {
				opacity: Math.min(entryOpacity, exitOpacity),
				transform: `translateY(${y}px)`,
			};
		}

		case 'scaleUp': {
			const scale = interpolate(frame, [0, entryFrames], [0.5, 1.0], {
				extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
			});
			const entryOpacity = interpolate(frame, [0, Math.max(1, Math.floor(entryFrames * 0.6))], [0, 1], {
				extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
			});
			return {
				opacity: Math.min(entryOpacity, exitOpacity),
				transform: `scale(${scale})`,
			};
		}

		case 'bounce': {
			// Spring-based bounce — overshoots then settles
			const springValue = spring({
				frame,
				fps,
				config: {
					damping: 8,
					stiffness: 200,
					mass: 0.5,
				},
				durationInFrames: entryFrames + 6,
			});
			return {
				opacity: exitOpacity,
				transform: `scale(${springValue})`,
			};
		}

		case 'typewriter': {
			// Typewriter uses opacity only for exit, no transform
			return {
				opacity: exitOpacity,
				transform: '',
			};
		}

		case 'fade':
		default: {
			// Original simple fade in/out
			let entryOpacity: number;
			if (durationInFrames <= entryFrames + exitFrames + 2) {
				entryOpacity = durationInFrames <= 1
					? 1
					: interpolate(
						frame,
						[0, Math.floor(durationInFrames / 2), durationInFrames],
						[0, 1, 0],
						{ extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
					);
				return { opacity: entryOpacity, transform: '' };
			}
			entryOpacity = interpolate(
				frame,
				[0, entryFrames, durationInFrames - exitFrames, durationInFrames],
				[0, 1, 1, 0],
				{ extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
			);
			return { opacity: entryOpacity, transform: '' };
		}
	}
}

/**
 * Typewriter effect — reveals text character by character.
 * Completes typing at 60% of duration, holds the full text for the remaining 40%.
 */
function getTypewriterText(
	text: string,
	frame: number,
	durationInFrames: number,
	fps: number,
	mode: string,
): string {
	const typingDuration = Math.floor(durationInFrames * 0.6);
	const charsToShow = Math.min(
		text.length,
		Math.floor(interpolate(frame, [0, typingDuration], [0, text.length], {
			extrapolateLeft: 'clamp',
			extrapolateRight: 'clamp',
		})),
	);

	const partial = text.slice(0, charsToShow);
	return (mode === 'game_day' || mode === 'quick_hit') ? partial.toUpperCase() : partial;
}

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
