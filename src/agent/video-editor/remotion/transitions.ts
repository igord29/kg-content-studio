/**
 * Transition mapper — converts Shotstack transition names to Remotion presentations.
 *
 * Uses the same TRANSITION_POOLS per mode from shotstack.ts to cycle transitions,
 * but maps them to Remotion's @remotion/transitions API.
 */

import { slide } from '@remotion/transitions/slide';
import { fade } from '@remotion/transitions/fade';
import { wipe } from '@remotion/transitions/wipe';
import { flip } from '@remotion/transitions/flip';

// Map Shotstack transition names → Remotion transition presentations
// Using `any` for return type because Remotion's transition generic types
// are incompatible across different presentation types (slide vs fade vs wipe etc.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getRemotionTransition(
	transitionType?: string,
	direction?: string,
): any {
	switch (transitionType) {
		case 'slide':
			return slide({
				direction: (direction as 'from-left' | 'from-right' | 'from-top' | 'from-bottom') || 'from-right',
			});
		case 'wipe':
			return wipe({
				direction: (direction as 'from-left' | 'from-right' | 'from-top-left' | 'from-bottom-right') || 'from-left',
			});
		case 'clockWipe':
			// clockWipe requires width/height props — use wipe as substitute
			return wipe({ direction: 'from-top-left' });
		case 'flip':
			return flip({ direction: 'from-right' });
		case 'fade':
		default:
			return fade();
	}
}

// Maps Shotstack transition names to Remotion equivalents
interface TransitionMapping {
	type: string;
	direction?: string;
}

const SHOTSTACK_TO_REMOTION: Record<string, TransitionMapping> = {
	'carouselRight': { type: 'slide', direction: 'from-right' },
	'carouselLeft': { type: 'slide', direction: 'from-left' },
	'slideRight': { type: 'slide', direction: 'from-right' },
	'slideLeft': { type: 'slide', direction: 'from-left' },
	'slideUp': { type: 'slide', direction: 'from-top' },
	'slideDown': { type: 'slide', direction: 'from-bottom' },
	'wipeRight': { type: 'wipe', direction: 'from-left' },
	'wipeLeft': { type: 'wipe', direction: 'from-right' },
	'fade': { type: 'fade' },
	'fadeSlow': { type: 'fade' },
	'fadeFast': { type: 'fade' },
	'zoom': { type: 'fade' },      // no direct Remotion equivalent, fade is closest
	'reveal': { type: 'wipe', direction: 'from-top-left' },
};

// Per-mode transition pools (mirrors shotstack.ts TRANSITION_POOLS)
const MODE_TRANSITION_POOLS: Record<string, TransitionMapping[]> = {
	game_day: [
		{ type: 'slide', direction: 'from-right' },
		{ type: 'slide', direction: 'from-left' },
		{ type: 'wipe', direction: 'from-left' },
		{ type: 'fade' },
		{ type: 'wipe', direction: 'from-top-left' },  // clockWipe substitute
	],
	our_story: [
		{ type: 'fade' },
		{ type: 'fade' },
		{ type: 'wipe', direction: 'from-top-left' },
		{ type: 'fade' },
	],
	quick_hit: [
		{ type: 'slide', direction: 'from-right' },
		{ type: 'fade' },
		{ type: 'wipe', direction: 'from-left' },
		{ type: 'wipe', direction: 'from-top-left' },  // clockWipe substitute
	],
	showcase: [
		{ type: 'fade' },
		{ type: 'fade' },
		{ type: 'wipe', direction: 'from-top-left' },
		{ type: 'slide', direction: 'from-right' },
		{ type: 'wipe', direction: 'from-top-left' },  // clockWipe substitute
	],
};

/**
 * Get transition for a clip at a given index, cycling through the mode's pool.
 */
export function getTransitionForClip(
	mode: string,
	clipIndex: number,
): TransitionMapping {
	const pool = MODE_TRANSITION_POOLS[mode] || MODE_TRANSITION_POOLS['game_day']!;
	return pool[clipIndex % pool.length]!;
}

/**
 * Convert a Shotstack transition name to a Remotion TransitionMapping.
 */
export function mapShotstackTransition(shotstackName: string): TransitionMapping {
	return SHOTSTACK_TO_REMOTION[shotstackName] || { type: 'fade' };
}
