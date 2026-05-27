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
import { cube, circleWipe, clockWipe as clockWipeCustom, wheelspin, zoomPunch, glitchSlam, stripedSlam, diagonalReveal, brandBurst, verticalShutter } from './custom-transitions';

// Map Shotstack transition names → Remotion transition presentations
// Using `any` for return type because Remotion's transition generic types
// are incompatible across different presentation types (slide vs fade vs wipe etc.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getRemotionTransition(
	transitionType?: string,
	direction?: string,
	// Real composition dimensions — circle/clock wipes derive their radius and
	// center from these, so passing the actual canvas size keeps the geometry
	// correct on every aspect ratio (9:16, 1:1, 4:5, 16:9). Defaults preserve
	// the historical 9:16 behavior for any caller that doesn't pass them.
	width = 1080,
	height = 1920,
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
			return circleWipe({ width, height });
		case 'clockWipe':
			return clockWipeCustom({ width, height });
		case 'wheelspin':
			return wheelspin({
				anchor: (direction as 'left' | 'right' | 'top' | 'bottom') || 'left',
			});
		case 'zoomPunch':
			return zoomPunch();
		case 'glitchSlam':
			return glitchSlam();
		case 'stripedSlam':
			return stripedSlam();
		case 'diagonalReveal':
			return diagonalReveal();
		case 'brandBurst':
		case 'emeraldBurst':
			return brandBurst();
		case 'verticalShutter':
			return verticalShutter();
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
		{ type: 'zoomPunch' },
		{ type: 'cube', direction: 'from-right' },
		{ type: 'slide', direction: 'from-left' },
		{ type: 'circleWipe' },
		{ type: 'glitchSlam' },
		{ type: 'wheelspin', direction: 'left' },
		{ type: 'clockWipe' },
		{ type: 'zoomPunch' },
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
