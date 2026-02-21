/**
 * VideoClip — renders a single video clip with Ken Burns effect and optional color filter.
 *
 * Uses OffthreadVideo for efficient server-side rendering of local files.
 * Ken Burns effects are CSS transform animations driven by useCurrentFrame().
 */

import React from 'react';
import { AbsoluteFill, OffthreadVideo, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';

interface VideoClipProps {
	src: string;
	effect?: string;   // 'zoomIn' | 'zoomOut' | 'slideRight' | 'slideLeft'
	filter?: string;   // 'boost' | undefined
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

export const VideoClip: React.FC<VideoClipProps> = ({ src, effect, filter }) => {
	const frame = useCurrentFrame();
	const { durationInFrames } = useVideoConfig();
	const progress = frame / Math.max(1, durationInFrames);

	// Ken Burns effects — subtle camera motion on every clip
	let transform = '';
	switch (effect) {
		case 'zoomIn': {
			const scale = interpolate(progress, [0, 1], [1.0, 1.15]);
			transform = `scale(${scale})`;
			break;
		}
		case 'zoomOut': {
			const scale = interpolate(progress, [0, 1], [1.15, 1.0]);
			transform = `scale(${scale})`;
			break;
		}
		case 'slideRight': {
			const x = interpolate(progress, [0, 1], [-3, 3]);
			const scale = interpolate(progress, [0, 1], [1.05, 1.1]);
			transform = `translateX(${x}%) scale(${scale})`;
			break;
		}
		case 'slideLeft': {
			const x = interpolate(progress, [0, 1], [3, -3]);
			const scale = interpolate(progress, [0, 1], [1.05, 1.1]);
			transform = `translateX(${x}%) scale(${scale})`;
			break;
		}
		default: {
			// Subtle default zoom to prevent static feel
			const scale = interpolate(progress, [0, 1], [1.0, 1.05]);
			transform = `scale(${scale})`;
		}
	}

	// Color filter for mode-specific look
	let cssFilter = '';
	if (filter === 'boost') {
		cssFilter = 'saturate(1.15) contrast(1.1)';
	}

	return (
		<AbsoluteFill>
			<OffthreadVideo
				src={src}
				style={{
					width: '100%',
					height: '100%',
					objectFit: 'cover',
					transform,
					transformOrigin: 'center center',
					filter: cssFilter || undefined,
				}}
			/>
		</AbsoluteFill>
	);
};
