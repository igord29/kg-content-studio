/**
 * PanelFrame — a vertical layout where the footage sits as a deliberate panel
 * and typography carries the meaning.
 *
 * WHY THIS EXISTS
 *
 * The library is 247 clips averaging 152 seconds, almost all locked-off wide
 * shots. Measured on delivered renders: median subject size 1.0%-13.4% of frame,
 * and 9-31% of frames contain no person at all. The catalog describes zero
 * celebrations, zero reactions, one face.
 *
 * Cropping a wide 16:9 master to 9:16 throws away two thirds of the image and
 * STILL leaves the subject small — you pay the resolution and get nothing for
 * it. Presenting the same footage as a full-width panel inside a designed frame
 * inverts that: the wide framing stops reading as a mistake and starts reading
 * as a choice, the discarded pixels stay in shot, and the vertical space that
 * cropping was wasting becomes room for the message.
 *
 * It also fixes two other things for free: text lands in a fixed zone well clear
 * of the TikTok/Reels UI rail, and every video shares one visual signature —
 * which is what actually reads as "brand with a budget."
 *
 * Use for program/scale stories ("400+ kids, on the courts the pros use"),
 * which is what this footage genuinely supports. For intimate single-subject
 * arcs, use the full-bleed layout and better footage.
 */
import React from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';

import '@fontsource/montserrat/latin-400.css';
import '@fontsource/montserrat/latin-600.css';
import '@fontsource/montserrat/latin-800.css';
import '@fontsource/montserrat/latin-900.css';

const MONTSERRAT = 'Montserrat, sans-serif';

/** Brand constants — one grade, one type system, every video. */
export const PANEL_THEME = {
	bg: '#0B1A16',        // deep forest, matches the CLC green family
	accent: '#C9A84C',    // gold
	text: '#FFFFFF',
	muted: '#A0BEAF',
};

export interface PanelFrameProps {
	/** 2-3 short lines. The hook — this does the work the picture cannot. */
	headline?: string[];
	/** Rendered in the accent colour as the final headline line. */
	headlineAccent?: string;
	/** The proof: "400+ kids. Every week." */
	statLine?: string;
	/** Context: "Hempstead → US Open" */
	subLine?: string;
	/** Fixed brand lockup. */
	brandLine?: string;
	/** Where the panel's top edge sits, as a fraction of frame height. */
	panelTop?: number;
	children: React.ReactNode;
}

export const PanelFrame: React.FC<PanelFrameProps> = ({
	headline = [],
	headlineAccent,
	statLine,
	subLine,
	brandLine = 'COMMUNITY LITERACY CLUB',
	panelTop = 0.32,
	children,
}) => {
	const { width, height } = useVideoConfig();

	// The panel is full-width 16:9. Everything else is positioned off its edges
	// so the layout holds at any composition size, not just 1080x1920.
	const panelH = Math.round((width * 9) / 16);
	const panelY = Math.round(height * panelTop);
	const pad = Math.round(width * 0.065);
	const rule = Math.max(3, Math.round(height * 0.002));

	const headlineSize = Math.round(width * 0.089);
	const statSize = Math.round(width * 0.057);
	const subSize = Math.round(width * 0.042);
	const brandSize = Math.round(width * 0.034);

	const belowY = panelY + panelH + Math.round(height * 0.046);

	return (
		<AbsoluteFill style={{ backgroundColor: PANEL_THEME.bg }}>
			{/*
			 * Blurred, darkened copy of the footage behind everything. Without it
			 * the frame reads as a slide with a video stuck in it; with it the
			 * whole frame feels like one image and the colour of the scene carries
			 * top to bottom.
			 */}
			<AbsoluteFill
				style={{
					// Desaturated, not boosted: the backdrop must never compete with the
					// panel or the type. A saturated source (blue courts, colour bars)
					// otherwise turns the frame into a light show.
					filter: 'blur(52px) saturate(0.5) brightness(0.26)',
					transform: 'scale(1.25)',   // hide the blur's soft edges
				}}
			>
				{children}
			</AbsoluteFill>

			{/* Headline zone */}
			<div
				style={{
					position: 'absolute',
					top: Math.round(height * 0.105),
					left: pad,
					right: pad,
					fontFamily: MONTSERRAT,
					fontWeight: 900,
					fontSize: headlineSize,
					lineHeight: 1.07,
					letterSpacing: '-0.02em',
					color: PANEL_THEME.text,
					textTransform: 'uppercase',
				}}
			>
				{headline.map((line, i) => (
					<div key={i}>{line}</div>
				))}
				{headlineAccent ? <div style={{ color: PANEL_THEME.accent }}>{headlineAccent}</div> : null}
			</div>

			{/* The footage, presented deliberately */}
			<div
				style={{
					position: 'absolute',
					top: panelY,
					left: 0,
					width,
					height: panelH,
					overflow: 'hidden',
				}}
			>
				<AbsoluteFill>{children}</AbsoluteFill>
			</div>

			{/* Gold rules top and bottom — the single strongest brand cue here */}
			<div style={{ position: 'absolute', top: panelY - rule, left: 0, width, height: rule, backgroundColor: PANEL_THEME.accent }} />
			<div style={{ position: 'absolute', top: panelY + panelH, left: 0, width, height: rule, backgroundColor: PANEL_THEME.accent }} />

			{/* Proof zone. Sits far above the platform UI rail by construction. */}
			<div style={{ position: 'absolute', top: belowY, left: pad, right: pad, fontFamily: MONTSERRAT }}>
				{statLine ? (
					<div style={{ fontWeight: 800, fontSize: statSize, color: PANEL_THEME.text, lineHeight: 1.15 }}>
						{statLine}
					</div>
				) : null}
				{subLine ? (
					<div style={{ fontWeight: 400, fontSize: subSize, color: PANEL_THEME.muted, marginTop: Math.round(height * 0.012) }}>
						{subLine}
					</div>
				) : null}
				<div
					style={{
						width: Math.round(width * 0.14),
						height: rule,
						backgroundColor: PANEL_THEME.accent,
						marginTop: Math.round(height * 0.026),
					}}
				/>
				<div
					style={{
						fontWeight: 800,
						fontSize: brandSize,
						color: PANEL_THEME.text,
						letterSpacing: '0.08em',
						marginTop: Math.round(height * 0.018),
					}}
				>
					{brandLine}
				</div>
			</div>
		</AbsoluteFill>
	);
};
