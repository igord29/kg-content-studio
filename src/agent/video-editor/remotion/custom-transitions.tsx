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

// Shared clamp options for multi-point interpolations.
const CLAMP = { extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const };

// Transitions that take no configuration.
type NoProps = Record<string, never>;

// CLC brand palette for colored transitions (mirrors TextOverlay.tsx).
const CLC_DARK = '#0a0a0a';
const CLC_GREEN = '#1B4D3E';
const CLC_GOLD = '#C9A84C';

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

// --- Zoom Punch (camera-cut feel: new scene punches in, old scene retreats) ---
// From the remotion-transitions catalog. Medium-high energy; pairs with
// springTiming({ damping: 200 }). All motion is presentationProgress-driven
// (transitions Golden Rule #2 — never useCurrentFrame inside a transition).

const ZoomPunchPresentation: React.FC<TransitionPresentationComponentProps<NoProps>> = ({
	children, presentationDirection, presentationProgress,
}) => {
	if (presentationDirection === 'entering') {
		const p = presentationProgress;
		// Cubic ease-in-out for a smooth but deliberate punch.
		const pe = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
		const scale = interpolate(pe, [0, 1], [0.86, 1]);
		return (
			<AbsoluteFill style={{ opacity: presentationProgress, transform: `scale(${scale})` }}>
				{children}
			</AbsoluteFill>
		);
	}
	// Exiting scene retreats slightly as it fades.
	const scale = interpolate(presentationProgress, [0, 1], [1, 1.08]);
	return (
		<AbsoluteFill style={{ opacity: 1 - presentationProgress, transform: `scale(${scale})` }}>
			{children}
		</AbsoluteFill>
	);
};

export const zoomPunch = (): TransitionPresentation<NoProps> => ({
	component: ZoomPunchPresentation, props: {},
});

// --- Glitch Slam (max-energy: shake + RGB tear strips, new scene hard-pops) ---
// From the remotion-transitions catalog. Use sparingly (punctuation / pre-CTA).
// Deterministic: the shake is sin(progress), NOT Math.random(), so it renders
// identically on every Lambda frame instead of strobing.

const GLITCH_STRIPS = [
	{ top: '18%', h: '4%', dx: 28, color: 'rgba(239,68,68,0.55)' },    // red
	{ top: '37%', h: '2%', dx: -22, color: 'rgba(16,185,129,0.55)' },  // emerald
	{ top: '58%', h: '5%', dx: 36, color: 'rgba(59,130,246,0.5)' },    // blue
	{ top: '76%', h: '2%', dx: -18, color: 'rgba(255,255,255,0.35)' }, // white
];

const GlitchSlamPresentation: React.FC<TransitionPresentationComponentProps<NoProps>> = ({
	children, presentationDirection, presentationProgress,
}) => {
	if (presentationDirection === 'entering') {
		// Hard pop-in at 12%, with a small scale punch that settles.
		const opacity = interpolate(presentationProgress, [0, 0.12, 1], [0, 1, 1], CLAMP);
		const scale = interpolate(presentationProgress, [0, 0.25, 1], [1.05, 1.01, 1], CLAMP);
		return (
			<AbsoluteFill style={{ opacity, transform: `scale(${scale})` }}>
				{children}
			</AbsoluteFill>
		);
	}
	// Exiting: horizontal shake with fast-decaying amplitude + RGB tear strips.
	const shake = Math.sin(presentationProgress * Math.PI * 12) * 30 * Math.pow(1 - presentationProgress, 1.5);
	const opacity = 1 - Math.pow(presentationProgress, 0.5);
	const stripOpacity = interpolate(presentationProgress, [0, 0.3, 0.8, 1], [0, 1, 0.6, 0], CLAMP);

	return (
		<AbsoluteFill style={{ opacity, transform: `translateX(${shake}px)` }}>
			{children}
			{GLITCH_STRIPS.map((s, i) => (
				<div key={i} style={{
					position: 'absolute',
					top: s.top, left: 0, right: 0,
					height: s.h,
					background: s.color,
					transform: `translateX(${s.dx * presentationProgress * 2}px)`,
					opacity: stripOpacity,
					pointerEvents: 'none',
					mixBlendMode: 'screen',
				}} />
			))}
		</AbsoluteFill>
	);
};

export const glitchSlam = (): TransitionPresentation<NoProps> => ({
	component: GlitchSlamPresentation, props: {},
});

// --- Striped Slam (alternating brand bars slam in from both sides, then retract) ---
// From the remotion-transitions catalog. Maximum energy; best as an opener.
// Pairs with linearTiming({ durationInFrames: ~50 }).

type StripeProps = { stripes: number };
const STRIPE_COLORS = [CLC_GREEN, CLC_GOLD];

const StripedSlamPresentation: React.FC<TransitionPresentationComponentProps<StripeProps>> = ({
	children, presentationDirection, presentationProgress, passedProps,
}) => {
	const stripes = passedProps.stripes;
	const bars = Array.from({ length: stripes }, (_, i) => {
		const h = 100 / stripes;
		const color = STRIPE_COLORS[i % STRIPE_COLORS.length]!;
		const fromLeft = i % 2 === 0; // alternate which side each bar enters from
		const stagger = (i / stripes) * 0.3;
		const p = Math.max(0, Math.min(1, (presentationProgress - stagger) / (1 - stagger)));
		const pe = 1 - Math.pow(1 - p, 3); // cubic ease-out
		let x: number;
		if (presentationDirection === 'exiting') {
			// Slam IN: bars travel from off-screen → park at 0.
			x = fromLeft ? interpolate(pe, [0, 1], [-112, 0]) : interpolate(pe, [0, 1], [112, 0]);
		} else {
			// Retract: reverse stagger, bars exit back where they came from.
			const revStagger = ((stripes - 1 - i) / stripes) * 0.3;
			const rp = Math.max(0, Math.min(1, (presentationProgress - revStagger) / (1 - revStagger)));
			const rpe = 1 - Math.pow(1 - rp, 3);
			x = fromLeft ? interpolate(rpe, [0, 1], [0, -112]) : interpolate(rpe, [0, 1], [0, 112]);
		}
		return (
			<div key={i} style={{
				position: 'absolute',
				top: `${i * h}%`,
				left: 0,
				width: '112%',
				height: `${h + 0.4}%`, // +0.4% overlap kills hairline gaps
				background: color,
				transform: `translateX(${x}%)`,
				pointerEvents: 'none',
			}} />
		);
	});
	return <AbsoluteFill>{children}{bars}</AbsoluteFill>;
};

export const stripedSlam = (stripes = 8): TransitionPresentation<StripeProps> => ({
	component: StripedSlamPresentation, props: { stripes },
});

// --- Diagonal Reveal (dark panel sweeps across with a glowing gold blade edge) ---
// From the catalog. Cinematic; good mid-sequence for a "reveal" beat.

const DiagonalRevealPresentation: React.FC<TransitionPresentationComponentProps<NoProps>> = ({
	children, presentationDirection, presentationProgress,
}) => {
	if (presentationDirection === 'exiting') {
		return (
			<AbsoluteFill style={{ opacity: 1 - Math.pow(presentationProgress, 0.6) }}>
				{children}
			</AbsoluteFill>
		);
	}
	// Sweep boundary: off-left (-12%) → past the right edge (116%).
	const pe = 1 - Math.pow(1 - presentationProgress, 2.5);
	const bx = interpolate(pe, [0, 1], [-12, 116]);
	return (
		<AbsoluteFill>
			{children}
			{/* Dark cover — left + right:0 (never negative width) so it can't collapse. */}
			<div style={{ position: 'absolute', top: 0, bottom: 0, left: `${bx}%`, right: 0, background: CLC_DARK, pointerEvents: 'none' }} />
			{/* Skewed leading-edge softener. */}
			<div style={{ position: 'absolute', top: '-10%', bottom: '-10%', left: `${bx - 7}%`, width: '10%', background: CLC_DARK, transform: 'skewX(-9deg)', transformOrigin: 'top left', pointerEvents: 'none' }} />
			{/* Glowing gold blade at the leading edge. */}
			<div style={{ position: 'absolute', top: 0, bottom: 0, left: `${bx - 0.5}%`, width: 3, background: CLC_GOLD, transform: 'skewX(-9deg)', boxShadow: `0 0 14px ${CLC_GOLD}, 0 0 32px rgba(201,168,76,0.45)`, pointerEvents: 'none' }} />
		</AbsoluteFill>
	);
};

export const diagonalReveal = (): TransitionPresentation<NoProps> => ({
	component: DiagonalRevealPresentation, props: {},
});

// --- Brand Burst (radial flash on the cut — white core → CLC gold → green) ---
// From the catalog's "Emerald Burst", recolored to CLC. High impact; reveal beats.

const BrandBurstPresentation: React.FC<TransitionPresentationComponentProps<NoProps>> = ({
	children, presentationDirection, presentationProgress,
}) => {
	const entering = presentationDirection === 'entering';
	// Flash: full on entry then clears fast; on exit it builds late.
	const burstOpacity = entering
		? interpolate(presentationProgress, [0, 0.2, 1], [1, 0, 0], CLAMP)
		: interpolate(presentationProgress, [0, 0.8, 1], [0, 0, 1], CLAMP);
	const sceneStyle = entering
		? { opacity: interpolate(presentationProgress, [0, 0.25, 1], [0, 1, 1], CLAMP) }
		: { opacity: 1 - Math.pow(presentationProgress, 2) };
	return (
		<AbsoluteFill>
			<AbsoluteFill style={sceneStyle}>{children}</AbsoluteFill>
			<AbsoluteFill style={{
				background: `radial-gradient(circle at 50% 50%, #ffffff 0%, ${CLC_GOLD} 18%, rgba(27,77,62,0.55) 40%, transparent 62%)`,
				opacity: burstOpacity,
				pointerEvents: 'none',
			}} />
		</AbsoluteFill>
	);
};

export const brandBurst = (): TransitionPresentation<NoProps> => ({
	component: BrandBurstPresentation, props: {},
});

// --- Vertical Shutter (venetian-blind panels snap shut, then open) ---
// From the catalog. High-energy, graphic / stop-motion feel.

type ShutterProps = { panels: number };

const VerticalShutterPresentation: React.FC<TransitionPresentationComponentProps<ShutterProps>> = ({
	children, presentationDirection, presentationProgress, passedProps,
}) => {
	const panels = passedProps.panels;
	const w = 100 / panels;
	const shutters = Array.from({ length: panels }, (_, i) => {
		const stagger = (i / panels) * 0.25;
		const p = Math.max(0, Math.min(1, (presentationProgress - stagger) / (1 - stagger)));
		const pe = 1 - Math.pow(1 - p, 3);
		// Exiting: panels CLOSE (scaleX 0→1). Entering: panels OPEN (scaleX 1→0).
		const scaleX = presentationDirection === 'exiting'
			? interpolate(pe, [0, 1], [0, 1])
			: interpolate(pe, [0, 1], [1, 0]);
		const color = i % 2 === 0 ? CLC_GREEN : CLC_GOLD;
		return (
			<div key={i} style={{
				position: 'absolute',
				top: 0, bottom: 0,
				left: `${i * w}%`,
				width: `${w + 0.3}%`, // +0.3% overlap kills gaps
				background: color,
				transform: `scaleX(${scaleX})`,
				transformOrigin: 'left center',
				pointerEvents: 'none',
			}} />
		);
	});
	return <AbsoluteFill>{children}{shutters}</AbsoluteFill>;
};

export const verticalShutter = (panels = 7): TransitionPresentation<ShutterProps> => ({
	component: VerticalShutterPresentation, props: { panels },
});
