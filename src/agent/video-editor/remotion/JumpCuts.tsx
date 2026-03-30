/**
 * JumpCuts — sections-based video assembly without re-mounting OffthreadVideo.
 * Adapted from remotion-dev/video-with-jump-cuts.
 *
 * Maps the current Remotion frame to the correct startFrom offset in the
 * source video, allowing seamless jumps between scored timestamp regions.
 */

import React, { useMemo } from 'react';
import { OffthreadVideo, useCurrentFrame } from 'remotion';

export type Section = {
	startFrom: number; // frames
	endAt: number;     // frames
};

export function calculateSectionsDuration(sections: Section[]): number {
	return sections.reduce((acc, section) => acc + section.endAt - section.startFrom, 0);
}

export const JumpCuts: React.FC<{
	src: string;
	sections: Section[];
	style?: React.CSSProperties;
	playbackRate?: number;
}> = ({ src, sections, style, playbackRate }) => {
	const frame = useCurrentFrame();

	const startFrom = useMemo(() => {
		let summedUpDurations = 0;
		for (const section of sections) {
			summedUpDurations += section.endAt - section.startFrom;
			if (summedUpDurations > frame) {
				return section.endAt - summedUpDurations;
			}
		}
		return null;
	}, [frame, sections]);

	if (startFrom === null) {
		return null;
	}

	return (
		<OffthreadVideo
			pauseWhenBuffering
			startFrom={startFrom}
			playbackRate={playbackRate}
			// Prevent Remotion from adding auto time fragment
			src={`${src}#t=0,`}
			style={style}
			delayRenderTimeoutInMilliseconds={120_000}
		/>
	);
};
