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
import { cube, circleWipe, clockWipe as clockWipeCustom, wheelspin } from './custom-transitions';

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
		case 'cube':
			return cube({
				direction: (direction as 'from-left' | 'from-right' | 'from-top' | 'from-bottom') || 'from-right',
				perspective: 1000,
			});
		case 'circleWipe':
			return circleWipe({ width: 2160, height: 3840 });
		case 'clockWipe':
			return clockWipeCustom({ width: 2160, height: 3840 });
		case 'wheelspin':
			return wheelspin({
				anchor: (direction as 'left' | 'right' | 'top' | 'bottom') || 'left',
			});
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
		{ type: 'cube', direction: 'from-right' },
		{ type: 'slide', direction: 'from-left' },
		{ type: 'circleWipe' },
		{ type: 'fade' },
		{ type: 'wheelspin', direction: 'left' },
		{ type: 'clockWipe' },
	],
	our_story: [
		{ type: 'fade' },
		{ type: 'fade' },
		{ type: 'circleWipe' },
		{ type: 'fade' },
	],
	quick_hit: [
		{ type: 'cube', direction: 'from-right' },
		{ type: 'fade' },
		{ type: 'circleWipe' },
		{ type: 'wheelspin', direction: 'right' },
	],
	showcase: [
		{ type: 'fade' },
		{ type: 'circleWipe' },
		{ type: 'clockWipe' },
		{ type: 'slide', direction: 'from-right' },
		{ type: 'fade' },
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
