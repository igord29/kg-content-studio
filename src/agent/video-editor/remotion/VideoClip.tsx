/**
 * VideoClip — renders a single video clip with Ken Burns effect, color grading, and speed ramping.
 *
 * Uses OffthreadVideo for efficient server-side rendering of local files.
 * Ken Burns effects are CSS transform animations driven by useCurrentFrame().
 * Color grading uses CSS filter chains for distinct visual looks per mode.
 * Speed ramping interpolates playbackRate across keyframes within a clip.
 */

import React from 'react';
import { AbsoluteFill, OffthreadVideo, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import type { SpeedKeyframe } from './types';

interface VideoClipProps {
	src: string;
	effect?: string;   // 'zoomIn' | 'zoomOut' | 'slideRight' | 'slideLeft'
	filter?: string;   // color grade name
	speedKeyframes?: SpeedKeyframe[];
}

// Effect pool (mirrors CLIP_EFFECT_POOLS from shotstack.ts)
const EFFECT_POOLS: Record<string, string[]> = {
	game_day: ['zoomIn', 'slideRight', 'slideLeft', 'zoomOut'],
	our_story: ['zoomIn', 'zoomOut'],
	quick_hit: ['slideRight', 'slideLeft'],
	showcase: ['zoomIn', 'zoomOut', 'slideRight'],
};

export function getEffectForClip(mode: string, index: number): string {
	const pool = EFFECT_POOLS[mode] || EFFECT_POOLS['game_day']!;
	return pool[index % pool.length]!;
}

/**
 * Color grading profiles — CSS filter chains that create distinct visual looks.
 *
 * Each profile is a combination of CSS filter functions that, when applied together,
 * create a professional color grade without needing LUT files.
 */
const COLOR_GRADES: Record<string, string> = {
	// Original: punchy, slightly saturated — good for action
	boost: 'saturate(1.15) contrast(1.1)',

	// Teal/orange cinema look — desaturated with lifted contrast + cool shadows
	cinematic: 'saturate(0.85) contrast(1.2) brightness(0.95)',

	// Golden hour warmth — slightly warm, soft, inviting
	warm: 'saturate(1.1) sepia(0.12) brightness(1.05) contrast(1.05)',

	// High-impact sports — punchy blacks, vivid color
	dramatic: 'contrast(1.3) brightness(0.9) saturate(1.25)',

	// Natural, grounded — slightly pulled back, honest
	documentary: 'saturate(0.9) contrast(1.1) brightness(1.02)',

	// Nostalgic, aged look — warm sepia tones with reduced vibrance
	vintage: 'sepia(0.2) saturate(0.8) contrast(1.1) brightness(1.05)',

	// Cool-toned editorial — blue-shifted, clean, modern
	cool: 'saturate(0.9) brightness(1.02) contrast(1.1) hue-rotate(10deg)',
};

/**
 * Default color grade per editing mode — used when no explicit filter is set.
 * This ensures each mode has a distinct visual identity out of the box.
 */
const MODE_DEFAULT_GRADE: Record<string, string> = {
	game_day: 'dramatic',
	our_story: 'warm',
	quick_hit: 'boost',
	showcase: 'cinematic',
};

export function getDefaultGradeForMode(mode: string): string {
	return MODE_DEFAULT_GRADE[mode] || 'boost';
}

/**
 * Compute playback rate at a given frame based on speed keyframes.
 *
 * Speed keyframes define speed changes at specific progress points (0.0-1.0).
 * Between keyframes, speed is linearly interpolated for smooth ramps.
 *
 * Example: [{ at: 0, speed: 1 }, { at: 0.4, speed: 0.3 }, { at: 0.6, speed: 0.3 }, { at: 1, speed: 1 }]
 * This creates a slow-mo ramp in the middle 20% of the clip.
 */
/**
 * Compute a single constant playback rate from speed keyframes.
 * Uses weighted average across the keyframe segments.
 * This is the safe approach for OffthreadVideo (which needs a constant rate).
 */
function getConstantPlaybackRate(keyframes?: SpeedKeyframe[]): number {
	if (!keyframes || keyframes.length === 0) return 1;
	if (keyframes.length === 1) return Math.max(0.01, keyframes[0]!.speed);

	const sorted = [...keyframes].sort((a, b) => a.at - b.at);
	let weightedSum = 0;
	let totalWeight = 0;

	for (let i = 0; i < sorted.length - 1; i++) {
		const segLength = sorted[i + 1]!.at - sorted[i]!.at;
		const avgSpeed = (sorted[i]!.speed + sorted[i + 1]!.speed) / 2;
		weightedSum += avgSpeed * segLength;
		totalWeight += segLength;
	}

	return Math.max(0.01, totalWeight > 0 ? weightedSum / totalWeight : sorted[0]!.speed);
}

/**
 * Per-frame playback rate interpolation (for future FFmpeg preprocessing use).
 * NOT safe for direct OffthreadVideo playbackRate — produces incorrect seeks.
 */
function getPlaybackRate(progress: number, keyframes?: SpeedKeyframe[]): number {
	if (!keyframes || keyframes.length === 0) return 1;
	if (keyframes.length === 1) return Math.max(0.01, keyframes[0]!.speed);

	// Sort by position and deduplicate (same `at` values crash interpolate)
	const sorted = [...keyframes].sort((a, b) => a.at - b.at);
	const deduped = sorted.filter((k, i) => i === 0 || k.at > sorted[i - 1]!.at);
	if (deduped.length === 1) return Math.max(0.01, deduped[0]!.speed);

	// Clamp progress to keyframe range
	if (progress <= deduped[0]!.at) return Math.max(0.01, deduped[0]!.speed);
	if (progress >= deduped[deduped.length - 1]!.at) return Math.max(0.01, deduped[deduped.length - 1]!.speed);

	// Find surrounding keyframes and interpolate
	const inputRange = deduped.map(k => k.at);
	const outputRange = deduped.map(k => k.speed);

	return Math.max(0.01, interpolate(progress, inputRange, outputRange, {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	}));
}

export const VideoClip: React.FC<VideoClipProps> = ({ src, effect, filter, speedKeyframes }) => {
	const frame = useCurrentFrame();
	const { durationInFrames } = useVideoConfig();
	const progress = frame / Math.max(1, durationInFrames);

	// Ken Burns effects — zoomed in on court level to focus on players.
	// Base scale 1.6x crops out banners/sky, keeping action in frame.
	// Transform origin at 65% vertical centers on court-level action.
	const BASE_SCALE = 1.6;
	let transform = '';
	switch (effect) {
		case 'zoomIn': {
			const scale = interpolate(progress, [0, 1], [BASE_SCALE, BASE_SCALE + 0.15]);
			transform = `scale(${scale})`;
			break;
		}
		case 'zoomOut': {
			const scale = interpolate(progress, [0, 1], [BASE_SCALE + 0.15, BASE_SCALE]);
			transform = `scale(${scale})`;
			break;
		}
		case 'slideRight': {
			const x = interpolate(progress, [0, 1], [-3, 3]);
			const scale = interpolate(progress, [0, 1], [BASE_SCALE, BASE_SCALE + 0.1]);
			transform = `translateX(${x}%) scale(${scale})`;
			break;
		}
		case 'slideLeft': {
			const x = interpolate(progress, [0, 1], [3, -3]);
			const scale = interpolate(progress, [0, 1], [BASE_SCALE, BASE_SCALE + 0.1]);
			transform = `translateX(${x}%) scale(${scale})`;
			break;
		}
		default: {
			const scale = interpolate(progress, [0, 1], [BASE_SCALE, BASE_SCALE + 0.05]);
			transform = `scale(${scale})`;
		}
	}

	// Color grading — resolve filter name to CSS filter chain
	const cssFilter = filter ? (COLOR_GRADES[filter] || COLOR_GRADES['boost']) : '';

	// Speed — OffthreadVideo requires a constant playbackRate (dynamic per-frame rates
	// produce incorrect seek positions). If speedKeyframes are provided, compute a
	// single effective rate. For true variable-speed ramping, preprocess with FFmpeg.
	const playbackRate = getConstantPlaybackRate(speedKeyframes);

	return (
		<AbsoluteFill>
			<OffthreadVideo
				src={src}
				playbackRate={playbackRate}
				delayRenderTimeoutInMilliseconds={120_000}
				style={{
					width: '100%',
					height: '100%',
					objectFit: 'cover',
					// Focus crop on lower-center of frame where players are,
					// not upper-center where banners/signage tend to be
					objectPosition: 'center 65%',
					transform,
					transformOrigin: 'center 65%',
					filter: cssFilter || undefined,
				}}
			/>
		</AbsoluteFill>
	);
};
