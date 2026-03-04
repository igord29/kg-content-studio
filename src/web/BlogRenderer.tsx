/**
 * BlogRenderer — Renders structured blog markdown with inline images.
 *
 * Handles: # H1, ## H2, > blockquotes (pull quotes), paragraphs,
 * and [HEADER_IMAGE] / [MID_IMAGE] / [CLOSING_IMAGE] placement markers.
 *
 * Falls back to plain text rendering if no image markers are found.
 */

import { Fragment, type ReactElement } from 'react';

// Design tokens matching the existing app palette
const B = {
	mono: "'Space Mono', monospace" as string,
	serif: "'Source Serif 4', Georgia, serif" as string,
	accent: '#2D6A4F',
	accentLight: '#52B788',
	textPrimary: '#e2e8f0',
	textSecondary: '#8892b0',
	textMuted: '#6272a4',
	borderColor: '#1e2538',
	bg: '#0a0d14',
};

interface BlogImage {
	imageUrl?: string;
	thumbnail?: string;
	styleName?: string;
}

interface BlogRendererProps {
	content: string;
	images?: BlogImage[];
}

const IMAGE_MARKERS = ['[HEADER_IMAGE]', '[MID_IMAGE]', '[CLOSING_IMAGE]'] as const;

/** Check if blog content contains image placement markers */
export function isBlogWithMarkers(content: string): boolean {
	return IMAGE_MARKERS.some((m) => content.includes(m));
}

/** Parse a text segment into rendered React elements (H1, H2, blockquote, paragraph) */
function renderMarkdownSegment(text: string, segmentKey: string) {
	const lines = text.split('\n');
	const elements: ReactElement[] = [];
	let paragraphBuffer: string[] = [];

	const flushParagraph = () => {
		if (paragraphBuffer.length === 0) return;
		const joined = paragraphBuffer.join(' ').trim();
		if (joined) {
			elements.push(
				<p key={`${segmentKey}-p-${elements.length}`} style={{
					fontFamily: B.serif, fontSize: 15, lineHeight: 1.8,
					color: B.textPrimary, margin: '0 0 18px', letterSpacing: '0.01em',
				}}>
					{joined}
				</p>,
			);
		}
		paragraphBuffer = [];
	};

	for (const line of lines) {
		const trimmed = line.trim();

		if (trimmed === '') {
			flushParagraph();
			continue;
		}

		// H1
		if (trimmed.startsWith('# ') && !trimmed.startsWith('## ')) {
			flushParagraph();
			elements.push(
				<h1 key={`${segmentKey}-h1-${elements.length}`} style={{
					fontFamily: B.serif, fontSize: 28, fontWeight: 700,
					color: B.textPrimary, margin: '0 0 6px',
					letterSpacing: '-0.02em', lineHeight: 1.3,
					paddingBottom: 14,
					borderBottom: `2px solid ${B.accent}`,
				}}>
					{trimmed.slice(2)}
				</h1>,
			);
			continue;
		}

		// H2
		if (trimmed.startsWith('## ')) {
			flushParagraph();
			elements.push(
				<h2 key={`${segmentKey}-h2-${elements.length}`} style={{
					fontFamily: B.serif, fontSize: 20, fontWeight: 600,
					color: B.textPrimary, margin: '28px 0 12px',
					letterSpacing: '-0.01em', lineHeight: 1.35,
					paddingTop: 14,
					borderTop: `1px solid ${B.borderColor}`,
				}}>
					{trimmed.slice(3)}
				</h2>,
			);
			continue;
		}

		// Blockquote / pull quote
		if (trimmed.startsWith('> ')) {
			flushParagraph();
			elements.push(
				<blockquote key={`${segmentKey}-bq-${elements.length}`} style={{
					fontFamily: B.serif, fontSize: 18, fontStyle: 'italic',
					color: B.accentLight, lineHeight: 1.7,
					margin: '24px 0', padding: '16px 24px',
					borderLeft: `3px solid ${B.accent}`,
					background: B.accent + '10',
					borderRadius: '0 8px 8px 0',
					letterSpacing: '0.01em',
				}}>
					{trimmed.slice(2)}
				</blockquote>,
			);
			continue;
		}

		// Regular text — accumulate into paragraph
		paragraphBuffer.push(trimmed);
	}

	flushParagraph();
	return elements;
}

/** Render an inline blog image */
function renderImage(image: BlogImage | undefined, position: string, key: string) {
	const src = image?.imageUrl || image?.thumbnail;
	if (!src) return null;

	return (
		<figure key={key} style={{ margin: '24px 0', textAlign: 'center' as const }}>
			<img
				src={src}
				alt={`${position} — ${image?.styleName || 'blog image'}`}
				style={{
					width: '100%', height: 'auto', display: 'block',
					borderRadius: 10, border: `1px solid ${B.borderColor}`,
				}}
			/>
			{image?.styleName && (
				<figcaption style={{
					fontFamily: B.mono, fontSize: 9, color: B.textMuted,
					letterSpacing: 1, textTransform: 'uppercase' as const,
					marginTop: 8,
				}}>
					{image.styleName}
				</figcaption>
			)}
		</figure>
	);
}

export function BlogRenderer({ content, images = [] }: BlogRendererProps) {
	// If no markers found, fall back to null (caller should use default rendering)
	if (!isBlogWithMarkers(content)) return null;

	// Split content on image markers, preserving order
	// Result: [textBefore, markerType, textAfter, markerType, textAfter, ...]
	const parts: { type: 'text' | 'image'; content: string; imageIndex: number }[] = [];
	let remaining = content;

	for (let i = 0; i < IMAGE_MARKERS.length; i++) {
		const marker = IMAGE_MARKERS[i]!;
		const idx = remaining.indexOf(marker);
		if (idx >= 0) {
			const before = remaining.slice(0, idx);
			if (before.trim()) {
				parts.push({ type: 'text', content: before, imageIndex: -1 });
			}
			parts.push({ type: 'image', content: marker, imageIndex: i });
			remaining = remaining.slice(idx + marker.length);
		}
	}
	// Remaining text after last marker
	if (remaining.trim()) {
		parts.push({ type: 'text', content: remaining, imageIndex: -1 });
	}

	return (
		<div style={{ padding: '4px 0' }}>
			{parts.map((part, idx) => {
				if (part.type === 'image') {
					return renderImage(images[part.imageIndex], IMAGE_MARKERS[part.imageIndex] || '', `img-${idx}`);
				}
				return (
					<Fragment key={`seg-${idx}`}>
						{renderMarkdownSegment(part.content, `seg-${idx}`)}
					</Fragment>
				);
			})}
		</div>
	);
}
