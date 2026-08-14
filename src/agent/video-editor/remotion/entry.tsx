/**
 * Remotion entry point — registers the CLC Video composition.
 * This file is the entryPoint for @remotion/bundler.
 */

import React from 'react';
import { registerRoot, Composition } from 'remotion';
import { CLCVideo, computeCompositionFrames } from './CLCVideo';
import { TransitionShowcase, SHOWCASE_DURATION_IN_FRAMES } from './TransitionShowcase';
import type { CLCVideoProps } from './types';

const RemotionRoot: React.FC = () => {
	// Cast component to satisfy Remotion's generic Composition typing
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const CLCVideoComponent = CLCVideo as any;

	return (
		<>
			<Composition
				id="CLCVideo"
				component={CLCVideoComponent}
				durationInFrames={900}      // overridden at render time via calculateMetadata
				fps={30}
				width={1080}
				height={1920}
				defaultProps={{
					clips: [],
					mode: 'game_day',
					width: 1080,
					height: 1920,
					fps: 30,
					textOverlays: [],
					bgColor: '#000000',
					transitionDurationFrames: 15,
				}}
				calculateMetadata={({ props }) => {
					const p = props as unknown as CLCVideoProps;
					// Delegate to the SAME helper CLCVideo uses to lay out the timeline.
					// These two numbers must agree exactly: if the registered duration is
					// short the tail of the video is cut off, and if it is long the render
					// ends on dead background frames. Computing it twice is how they drifted.
					return {
						durationInFrames: computeCompositionFrames(p.clips, p.fps, p.transitionDurationFrames),
						width: p.width,
						height: p.height,
						fps: p.fps,
					};
				}}
			/>

			{/* Dev-only preview — scrub every transition preset in one place:
			    `npx remotion studio` → pick "TransitionShowcase". Not used by the
			    production render path (renders target id="CLCVideo"). */}
			<Composition
				id="TransitionShowcase"
				component={TransitionShowcase}
				durationInFrames={SHOWCASE_DURATION_IN_FRAMES}
				fps={30}
				width={1080}
				height={1920}
			/>
		</>
	);
};

registerRoot(RemotionRoot);
