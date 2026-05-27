/**
 * TransitionShowcase — a self-contained composition for previewing EVERY
 * transition preset back-to-back, labeled, with no real footage required.
 *
 * Open it in `npx remotion studio` → pick "TransitionShowcase" and scrub: each
 * transition plays between two colored brand cards, and the landing card names
 * the transition you just saw. This lets you compare all presets in ONE pass
 * instead of wiring each into a mode pool and doing a full Lambda render per
 * preset.
 *
 * NOT part of the production render path — purely a dev/preview tool. It is
 * registered as its own composition in entry.tsx (id="TransitionShowcase").
 */

import React from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';
import { TransitionSeries, springTiming, linearTiming } from '@remotion/transitions';
import { getRemotionTransition } from './transitions';

type ShowcaseItem = {
	name: string;
	type: string;
	direction?: string;
	/** Transition duration in frames. MUST stay <= SCENE_FRAMES. */
	frames: number;
	/** springTiming (physics, eased) vs linearTiming (frame-perfect). */
	spring?: boolean;
};

// Every transition the pipeline knows about, ordered roughly calm → chaos.
// Add a preset here (one line) and it shows up in the showcase automatically.
const SHOWCASE: ShowcaseItem[] = [
	{ name: 'Fade', type: 'fade', frames: 20 },
	{ name: 'Slide', type: 'slide', direction: 'from-right', frames: 24, spring: true },
	{ name: 'Wipe', type: 'wipe', direction: 'from-left', frames: 24 },
	{ name: 'Cube', type: 'cube', direction: 'from-right', frames: 30, spring: true },
	{ name: 'Circle Wipe', type: 'circleWipe', frames: 28 },
	{ name: 'Clock Wipe', type: 'clockWipe', frames: 30 },
	{ name: 'Wheelspin', type: 'wheelspin', direction: 'left', frames: 28, spring: true },
	{ name: 'Zoom Punch', type: 'zoomPunch', frames: 35, spring: true },
	{ name: 'Diagonal Reveal', type: 'diagonalReveal', frames: 40 },
	{ name: 'Brand Burst', type: 'brandBurst', frames: 40 },
	{ name: 'Vertical Shutter', type: 'verticalShutter', frames: 35 },
	{ name: 'Striped Slam', type: 'stripedSlam', frames: 50 },
	{ name: 'Glitch Slam', type: 'glitchSlam', frames: 30 },
];

// Each card must be at least as long as the longest transition (50f) so
// TransitionSeries can fit the transition inside its adjacent sequences.
const SCENE_FRAMES = 70;

// Total length is derived from the array: (N cards + 1 intro) * SCENE_FRAMES,
// minus the frames each transition overlaps its neighbours. Exported so
// entry.tsx can size the composition.
export const SHOWCASE_DURATION_IN_FRAMES =
	(SHOWCASE.length + 1) * SCENE_FRAMES -
	SHOWCASE.reduce((sum, t) => sum + t.frames, 0);

// Rotating card backgrounds so consecutive cards differ — makes every cut visible.
const CARD_BGS = ['#1B4D3E', '#0a0a0a', '#243B33', '#2A2118'];

const Card: React.FC<{ label: string; sub: string; bg: string }> = ({ label, sub, bg }) => (
	<AbsoluteFill
		style={{
			backgroundColor: bg,
			justifyContent: 'center',
			alignItems: 'center',
			textAlign: 'center',
			padding: 48,
			fontFamily: "'Montserrat', sans-serif",
		}}
	>
		<div style={{ color: '#C9A84C', fontSize: 30, fontWeight: 700, letterSpacing: 4, marginBottom: 20 }}>
			{sub}
		</div>
		<div style={{ color: '#fff', fontSize: 96, fontWeight: 900, textTransform: 'uppercase', lineHeight: 1.05 }}>
			{label}
		</div>
	</AbsoluteFill>
);

export const TransitionShowcase: React.FC = () => {
	const { width, height } = useVideoConfig();

	return (
		<AbsoluteFill style={{ backgroundColor: '#000' }}>
			<TransitionSeries>
				<TransitionSeries.Sequence durationInFrames={SCENE_FRAMES}>
					<Card label="Transitions" sub={`${SHOWCASE.length} presets — scrub to compare`} bg={CARD_BGS[0]!} />
				</TransitionSeries.Sequence>
				{SHOWCASE.flatMap((t, i) => [
					<TransitionSeries.Transition
						key={`t-${i}`}
						presentation={getRemotionTransition(t.type, t.direction, width, height)}
						timing={
							t.spring
								? springTiming({ config: { damping: 200 }, durationInFrames: t.frames })
								: linearTiming({ durationInFrames: t.frames })
						}
					/>,
					<TransitionSeries.Sequence key={`s-${i}`} durationInFrames={SCENE_FRAMES}>
						<Card label={t.name} sub={`${i + 1} / ${SHOWCASE.length}`} bg={CARD_BGS[(i + 1) % CARD_BGS.length]!} />
					</TransitionSeries.Sequence>,
				])}
			</TransitionSeries>
		</AbsoluteFill>
	);
};
