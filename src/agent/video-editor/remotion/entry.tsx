/**
 * Remotion entry point — registers the CLC Video composition.
 * This file is the entryPoint for @remotion/bundler.
 */

import React from 'react';
import { registerRoot, Composition } from 'remotion';
import { CLCVideo } from './CLCVideo';
import { TransitionShowcase, SHOWCASE_DURATION_IN_FRAMES } from './TransitionShowcase';
import type { CLCVideoProps } from './types';
import { computeCompositionFrames } from './composition-timing';

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
					// Duration math lives in composition-timing.ts, which CLCVideo
					// also uses to lay out clips. Computing it separately here is what
					// silently truncated every render — see that file's header.
					const p = props as unknown as CLCVideoProps;
					const totalFrames = computeCompositionFrames(
						p.clips,
						p.fps,
						p.transitionDurationFrames,
					);

					return {
						durationInFrames: totalFrames,
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
