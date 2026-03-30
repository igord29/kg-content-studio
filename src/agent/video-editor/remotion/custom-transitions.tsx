/**
 * Custom Transition Presentations for CLC videos.
 *
 * All implement the TransitionPresentation interface from @remotion/transitions
 * and drop in directly alongside the built-in fade/slide/wipe transitions.
 *
 * Adapted from:
 * - remotion-dev/transitions-video (cube, clockWipe, circleWipe, wheelspin)
 * - remotion-dev/light-leak-example (lightLeak)
 */

import React, { useMemo } from 'react';
import { AbsoluteFill, interpolate } from 'remotion';
import type {
	TransitionPresentation,
	TransitionPresentationComponentProps,
} from '@remotion/transitions';

// --- Cube Transition ---

type CubeProps = {
	direction: 'from-left' | 'from-right' | 'from-top' | 'from-bottom';
	perspective?: number;
};

const CubePresentation: React.FC<TransitionPresentationComponentProps<CubeProps>> = ({
	children, presentationDirection, presentationProgress, passedProps,
}) => {
	const style: React.CSSProperties = useMemo(() => {
		const startRot = passedProps.direction === 'from-left' || passedProps.direction === 'from-bottom' ? 90 : -90;
		const endRot = passedProps.direction === 'from-left' || passedProps.direction === 'from-bottom' ? -90 : 90;
		const startPos = passedProps.direction === 'from-left' || passedProps.direction === 'from-top' ? 100 : -100;
		const exitPos = passedProps.direction === 'from-left' || passedProps.direction === 'from-top' ? -100 : 100;

		const originEnter = passedProps.direction === 'from-left' ? 'left'
			: passedProps.direction === 'from-top' ? 'top'
			: passedProps.direction === 'from-bottom' ? 'bottom' : 'right';
		const originExit = passedProps.direction === 'from-left' ? 'right'
			: passedProps.direction === 'from-top' ? 'bottom'
			: passedProps.direction === 'from-bottom' ? 'top' : 'left';

		const rotation = presentationDirection === 'entering'
			? interpolate(presentationProgress, [0, 1], [startRot, 0])
			: interpolate(presentationProgress, [0, 1], [0, endRot]);
		const translate = `${presentationDirection === 'entering'
			? interpolate(presentationProgress, [0, 1], [startPos, 0])
			: interpolate(presentationProgress, [0, 1], [0, exitPos])}%`;

		const isVertical = passedProps.direction === 'from-top' || passedProps.direction === 'from-bottom';
		return {
			width: '100%', height: '100%',
			transformOrigin: presentationDirection === 'entering' ? originEnter : originExit,
			transform: `${isVertical ? 'translateY' : 'translateX'}(${translate}) ${isVertical ? 'rotateX' : 'rotateY'}(${rotation}deg)`,
			backfaceVisibility: 'hidden' as const,
			WebkitBackfaceVisibility: 'hidden' as const,
		};
	}, [passedProps.direction, presentationDirection, presentationProgress]);

	return (
		<AbsoluteFill style={{ perspective: passedProps.perspective || 1000, transformStyle: 'preserve-3d' }}>
			<AbsoluteFill style={style}>{children}</AbsoluteFill>
		</AbsoluteFill>
	);
};

export const cube = (props: CubeProps): TransitionPresentation<CubeProps> => ({
	component: CubePresentation, props,
});

// --- Circle Wipe ---

type WipeProps = { width: number; height: number };

const CircleWipePresentation: React.FC<TransitionPresentationComponentProps<WipeProps>> = ({
	children, presentationDirection, presentationProgress, passedProps,
}) => {
	const radius = Math.sqrt(passedProps.width ** 2 + passedProps.height ** 2) / 2;
	const r = radius * presentationProgress;
	const cx = passedProps.width / 2;
	const cy = passedProps.height / 2;
	// Deterministic ID — no useState (breaks in Remotion SSR/Lambda)
	const clipId = `circle-wipe-${presentationDirection}`;

	return (
		<AbsoluteFill>
			<AbsoluteFill style={{
				width: '100%', height: '100%',
				clipPath: presentationDirection === 'exiting' ? undefined : `url(#${clipId})`,
			}}>
				{children}
			</AbsoluteFill>
			{presentationDirection === 'exiting' ? null : (
				<AbsoluteFill>
					<svg width={0} height={0}>
						<defs>
							<clipPath id={clipId}>
								<circle cx={cx} cy={cy} r={r} />
							</clipPath>
						</defs>
					</svg>
				</AbsoluteFill>
			)}
		</AbsoluteFill>
	);
};

export const circleWipe = (props: WipeProps): TransitionPresentation<WipeProps> => ({
	component: CircleWipePresentation, props,
});

// --- Clock Wipe (uses SVG arc path) ---

const ClockWipePresentation: React.FC<TransitionPresentationComponentProps<WipeProps>> = ({
	children, presentationDirection, presentationProgress, passedProps,
}) => {
	const radius = Math.sqrt(passedProps.width ** 2 + passedProps.height ** 2) / 2;
	const cx = passedProps.width / 2;
	const cy = passedProps.height / 2;
	const clipId = `clock-wipe-${presentationDirection}`;

	// Build pie arc path
	const angle = presentationProgress * 360;
	const radians = (angle - 90) * Math.PI / 180;
	const x = cx + radius * Math.cos(radians);
	const y = cy + radius * Math.sin(radians);
	const largeArc = angle > 180 ? 1 : 0;
	const path = angle >= 360
		? `M ${cx} ${cy - radius} A ${radius} ${radius} 0 1 1 ${cx - 0.01} ${cy - radius} Z`
		: `M ${cx} ${cy} L ${cx} ${cy - radius} A ${radius} ${radius} 0 ${largeArc} 1 ${x} ${y} Z`;

	return (
		<AbsoluteFill>
			<AbsoluteFill style={{
				width: '100%', height: '100%',
				clipPath: presentationDirection === 'exiting' ? undefined : `url(#${clipId})`,
			}}>
				{children}
			</AbsoluteFill>
			{presentationDirection === 'exiting' ? null : (
				<AbsoluteFill>
					<svg width={0} height={0}>
						<defs>
							<clipPath id={clipId}>
								<path d={path} />
							</clipPath>
						</defs>
					</svg>
				</AbsoluteFill>
			)}
		</AbsoluteFill>
	);
};

export const clockWipe = (props: WipeProps): TransitionPresentation<WipeProps> => ({
	component: ClockWipePresentation, props,
});

// --- Wheelspin ---

type WheelspinProps = { anchor: 'left' | 'right' | 'top' | 'bottom' };

const WheelspinPresentation: React.FC<TransitionPresentationComponentProps<WheelspinProps>> = ({
	children, presentationDirection, presentationProgress, passedProps,
}) => {
	const style: React.CSSProperties = useMemo(() => {
		const angle = 15;
		const counterClockwise = passedProps.anchor === 'right' ? -angle : angle;
		const rotation = interpolate(
			presentationProgress, [0, 1],
			presentationDirection === 'entering' ? [-counterClockwise, 0] : [0, counterClockwise],
		);
		const origins: Record<string, string> = {
			left: '-400% 50%', top: '50% -400%', bottom: '50% 500%', right: '500% 50%',
		};
		return {
			width: '100%', height: '100%',
			transformOrigin: origins[passedProps.anchor] || '50% 50%',
			transform: `rotate(${rotation}deg)`,
		};
	}, [passedProps.anchor, presentationDirection, presentationProgress]);

	return (
		<AbsoluteFill>
			<AbsoluteFill style={style}>{children}</AbsoluteFill>
		</AbsoluteFill>
	);
};

export const wheelspin = (props: WheelspinProps): TransitionPresentation<WheelspinProps> => ({
	component: WheelspinPresentation, props,
});
