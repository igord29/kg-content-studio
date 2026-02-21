/**
 * Media Library — Unified archive of all generated content
 * Tabs: Text Posts | Videos | Audio | Images
 */

import { useState, useEffect, useCallback, useMemo } from 'react';

// --- Types ---

interface LibraryImage {
	styleId: string;
	styleName: string;
	thumbnail: string;
	imagePrompt: string;
}

interface LibraryEntry {
	id: string;
	createdAt: string;
	platform: string;
	content: string;
	topic: string;
	images?: LibraryImage[];
}

interface VideoLibraryEntry {
	id: string;
	createdAt: string;
	renderId: string;
	downloadUrl: string;
	platform: string;
	renderMode: string;
	topic: string;
	clipCount: number;
	editPlanSummary?: string;
}

interface GalleryImage extends LibraryImage {
	parentEntryId: string;
	parentPlatform: string;
	parentCreatedAt: string;
	parentTopic: string;
}

type MediaTab = 'text' | 'video' | 'audio' | 'images';

// --- Design tokens (matching VideoEditor / App) ---

const S = {
	mono: "'Space Mono', monospace" as string,
	serif: "'Source Serif 4', Georgia, serif" as string,
	bg: '#0a0d14',
	cardBg: '#111520',
	cardBgHover: '#141824',
	borderColor: '#1e2538',
	borderHover: '#2a3550',
	textPrimary: '#e2e8f0',
	textSecondary: '#8892b0',
	textMuted: '#4a5578',
	textDim: '#2a3148',
	accent: '#2D6A4F',
	accentLight: '#4a9e7a',
	orange: '#E67E22',
	red: '#f87171',
	teal: '#1ABC9C',
	indigo: '#6366f1',
};

const PLATFORM_COLORS: Record<string, string> = {
	Instagram: '#E1306C',
	TikTok: '#00f2ea',
	YouTube: '#FF0000',
	Facebook: '#1877F2',
	LinkedIn: '#0077B5',
	Twitter: '#1DA1F2',
	Blog: S.accent,
	Newsletter: S.orange,
	tiktok: '#00f2ea',
	youtube: '#FF0000',
	'ig-reels': '#E1306C',
	'youtube-shorts': '#FF0000',
	facebook: '#1877F2',
	linkedin: '#0077B5',
};

const PLATFORM_ICONS: Record<string, string> = {
	Instagram: 'IG',
	TikTok: 'TT',
	YouTube: 'YT',
	Facebook: 'FB',
	LinkedIn: 'LI',
	Twitter: 'TW',
	Blog: 'BL',
	Newsletter: 'NL',
	tiktok: 'TT',
	youtube: 'YT',
	'ig-reels': 'IG',
	'youtube-shorts': 'YT',
	facebook: 'FB',
	linkedin: 'LI',
};

const MODE_LABELS: Record<string, string> = {
	game_day: 'Game Day',
	our_story: 'Our Story',
	quick_hit: 'Quick Hit',
	showcase: 'Showcase',
};

const TAB_CONFIG: { id: MediaTab; label: string; color: string }[] = [
	{ id: 'text', label: 'Text Posts', color: S.accent },
	{ id: 'video', label: 'Videos', color: S.orange },
	{ id: 'audio', label: 'Audio', color: S.indigo },
	{ id: 'images', label: 'Images', color: S.teal },
];

// --- Sub-components ---

function TabBar({
	activeTab,
	onTabChange,
	counts,
}: {
	activeTab: MediaTab;
	onTabChange: (tab: MediaTab) => void;
	counts: Record<MediaTab, number>;
}) {
	return (
		<div style={{
			display: 'flex',
			gap: 0,
			borderBottom: `1px solid ${S.borderColor}`,
			padding: '0 28px',
		}}>
			{TAB_CONFIG.map((tab) => {
				const active = activeTab === tab.id;
				return (
					<button
						key={tab.id}
						onClick={() => onTabChange(tab.id)}
						style={{
							padding: '14px 20px 12px',
							border: 'none',
							borderBottom: `2px solid ${active ? tab.color : 'transparent'}`,
							background: 'transparent',
							color: active ? tab.color : S.textMuted,
							fontFamily: S.mono,
							fontSize: 11,
							fontWeight: active ? 700 : 400,
							letterSpacing: 0.5,
							cursor: 'pointer',
							transition: 'all 0.2s',
							display: 'flex',
							alignItems: 'center',
							gap: 8,
						}}
						type="button"
					>
						{tab.label}
						<span style={{
							background: active ? tab.color + '25' : S.borderColor,
							borderRadius: 3,
							padding: '1px 6px',
							fontSize: 9,
							color: active ? tab.color : S.textDim,
							transition: 'all 0.2s',
						}}>
							{counts[tab.id]}
						</span>
					</button>
				);
			})}
		</div>
	);
}

function FilterChip({
	label,
	active,
	count,
	color,
	onClick,
}: {
	label: string;
	active: boolean;
	count?: number;
	color?: string;
	onClick: () => void;
}) {
	return (
		<button
			onClick={onClick}
			style={{
				padding: '5px 12px',
				borderRadius: 4,
				border: `1px solid ${active ? (color || S.accent) + '88' : S.borderColor}`,
				background: active ? (color || S.accent) + '18' : 'transparent',
				color: active ? (color || S.accentLight) : S.textMuted,
				fontFamily: S.mono,
				fontSize: 10,
				letterSpacing: 0.5,
				cursor: 'pointer',
				transition: 'all 0.2s',
				display: 'flex',
				alignItems: 'center',
				gap: 6,
			}}
			type="button"
		>
			{label}
			{count !== undefined && count > 0 && (
				<span style={{
					background: active ? (color || S.accent) + '33' : S.borderColor,
					borderRadius: 3,
					padding: '1px 5px',
					fontSize: 9,
					color: active ? (color || S.accentLight) : S.textDim,
				}}>
					{count}
				</span>
			)}
		</button>
	);
}

function EmptyState({ message, submessage }: { message: string; submessage: string }) {
	return (
		<div style={{
			display: 'flex',
			flexDirection: 'column',
			alignItems: 'center',
			justifyContent: 'center',
			padding: '80px 40px',
			textAlign: 'center',
		}}>
			<div style={{
				width: 80,
				height: 80,
				borderRadius: 20,
				background: S.cardBg,
				border: `1px dashed ${S.borderColor}`,
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				marginBottom: 24,
				fontSize: 32,
				opacity: 0.6,
			}}>
				{'  '}
			</div>
			<h3 style={{
				fontFamily: S.serif,
				fontSize: 22,
				fontWeight: 300,
				color: S.textPrimary,
				marginBottom: 10,
				letterSpacing: '-0.01em',
			}}>
				{message}
			</h3>
			<p style={{
				fontFamily: S.mono,
				fontSize: 11,
				color: S.textMuted,
				maxWidth: 360,
				lineHeight: 1.7,
				letterSpacing: 0.3,
			}}>
				{submessage}
			</p>
		</div>
	);
}

// --- Text Content Card ---

function ContentCard({
	entry,
	onClick,
}: {
	entry: LibraryEntry;
	onClick: () => void;
}) {
	const [hovered, setHovered] = useState(false);
	const platformColor = PLATFORM_COLORS[entry.platform] || S.accent;
	const platformIcon = PLATFORM_ICONS[entry.platform] || entry.platform.slice(0, 2).toUpperCase();
	const preview = entry.content.length > 140
		? entry.content.slice(0, 140).trim() + '...'
		: entry.content;

	const date = new Date(entry.createdAt);
	const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

	return (
		<button
			onClick={onClick}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			style={{
				display: 'block',
				width: '100%',
				textAlign: 'left',
				padding: 0,
				borderRadius: 10,
				border: `1px solid ${hovered ? S.borderHover : S.borderColor}`,
				background: hovered ? S.cardBgHover : S.cardBg,
				cursor: 'pointer',
				transition: 'all 0.25s ease',
				transform: hovered ? 'translateY(-1px)' : 'none',
				overflow: 'hidden',
				position: 'relative',
			}}
			type="button"
		>
			<div style={{
				position: 'absolute', top: 0, left: 0, right: 0, height: 2,
				background: platformColor,
				opacity: hovered ? 0.8 : 0.4,
				transition: 'opacity 0.25s',
			}} />

			{entry.images && entry.images.length > 0 && (
				<div style={{ display: 'flex', gap: 1, height: 120, overflow: 'hidden' }}>
					{entry.images.slice(0, 3).map((img, i) => (
						<div
							key={img.styleId + i}
							style={{
								flex: 1,
								backgroundImage: `url(${img.thumbnail})`,
								backgroundSize: 'cover',
								backgroundPosition: 'center',
								filter: hovered ? 'brightness(1.05)' : 'brightness(0.85)',
								transition: 'filter 0.25s',
							}}
						/>
					))}
				</div>
			)}

			<div style={{ padding: '14px 16px 16px' }}>
				<div style={{
					display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10,
				}}>
					<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
						<span style={{
							fontFamily: S.mono, fontSize: 9, fontWeight: 700, letterSpacing: 1,
							color: platformColor, background: platformColor + '15',
							padding: '3px 7px', borderRadius: 3, textTransform: 'uppercase',
						}}>
							{platformIcon}
						</span>
						<span style={{ fontFamily: S.mono, fontSize: 10, color: S.textMuted, letterSpacing: 0.3 }}>
							{entry.platform}
						</span>
					</div>
					<span style={{ fontFamily: S.mono, fontSize: 9, color: S.textDim, letterSpacing: 0.3 }}>
						{dateStr} {timeStr}
					</span>
				</div>

				<p style={{
					fontFamily: S.serif, fontSize: 13, lineHeight: 1.55,
					color: S.textSecondary, margin: 0, overflow: 'hidden',
				}}>
					{preview}
				</p>

				<div style={{
					display: 'flex', alignItems: 'center', gap: 12,
					marginTop: 10, paddingTop: 10, borderTop: `1px solid ${S.borderColor}`,
				}}>
					{entry.images && entry.images.length > 0 && (
						<span style={{ fontFamily: S.mono, fontSize: 9, color: S.textDim, letterSpacing: 0.5 }}>
							{entry.images.length} image{entry.images.length > 1 ? 's' : ''}
						</span>
					)}
					<span style={{ fontFamily: S.mono, fontSize: 9, color: S.textDim, letterSpacing: 0.5 }}>
						{entry.content.split(/\s+/).length} words
					</span>
				</div>
			</div>
		</button>
	);
}

// --- Video Card ---

function VideoCard({
	entry,
	onClick,
}: {
	entry: VideoLibraryEntry;
	onClick: () => void;
}) {
	const [hovered, setHovered] = useState(false);
	const platformColor = PLATFORM_COLORS[entry.platform] || S.orange;

	const date = new Date(entry.createdAt);
	const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

	return (
		<button
			onClick={onClick}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			style={{
				display: 'block',
				width: '100%',
				textAlign: 'left',
				padding: 0,
				borderRadius: 10,
				border: `1px solid ${hovered ? S.borderHover : S.borderColor}`,
				background: hovered ? S.cardBgHover : S.cardBg,
				cursor: 'pointer',
				transition: 'all 0.25s ease',
				transform: hovered ? 'translateY(-1px)' : 'none',
				overflow: 'hidden',
				position: 'relative',
			}}
			type="button"
		>
			<div style={{
				position: 'absolute', top: 0, left: 0, right: 0, height: 2,
				background: S.orange,
				opacity: hovered ? 0.8 : 0.4,
				transition: 'opacity 0.25s',
			}} />

			{/* Video play icon area */}
			<div style={{
				height: 100,
				background: '#0d1017',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				position: 'relative',
			}}>
				<div style={{
					width: 48,
					height: 48,
					borderRadius: '50%',
					background: S.orange + (hovered ? '40' : '20'),
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					transition: 'all 0.25s',
				}}>
					<div style={{
						width: 0,
						height: 0,
						borderTop: '10px solid transparent',
						borderBottom: '10px solid transparent',
						borderLeft: `16px solid ${S.orange}`,
						marginLeft: 4,
						opacity: hovered ? 1 : 0.6,
						transition: 'opacity 0.25s',
					}} />
				</div>
			</div>

			<div style={{ padding: '14px 16px 16px' }}>
				{/* Platform + Mode badges */}
				<div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
					<span style={{
						fontFamily: S.mono, fontSize: 9, fontWeight: 700, letterSpacing: 1,
						color: platformColor, background: platformColor + '15',
						padding: '3px 7px', borderRadius: 3, textTransform: 'uppercase',
					}}>
						{PLATFORM_ICONS[entry.platform] || entry.platform.slice(0, 2).toUpperCase()}
					</span>
					<span style={{
						fontFamily: S.mono, fontSize: 9, letterSpacing: 0.5,
						color: S.accentLight, background: S.accent + '15',
						padding: '3px 7px', borderRadius: 3,
					}}>
						{MODE_LABELS[entry.renderMode] || entry.renderMode}
					</span>
				</div>

				{/* Topic */}
				<p style={{
					fontFamily: S.serif, fontSize: 13, lineHeight: 1.55,
					color: S.textSecondary, margin: 0, overflow: 'hidden',
				}}>
					{entry.topic ? (entry.topic.length > 120 ? entry.topic.slice(0, 120) + '...' : entry.topic) : 'Untitled render'}
				</p>

				{/* Footer */}
				<div style={{
					display: 'flex', alignItems: 'center', gap: 12,
					marginTop: 10, paddingTop: 10, borderTop: `1px solid ${S.borderColor}`,
					fontFamily: S.mono, fontSize: 9, color: S.textDim, letterSpacing: 0.5,
				}}>
					<span>{entry.clipCount} clip{entry.clipCount !== 1 ? 's' : ''}</span>
					<span>{dateStr} {timeStr}</span>
				</div>
			</div>
		</button>
	);
}

// --- Image Gallery Card ---

function ImageGalleryCard({
	image,
	onClick,
}: {
	image: GalleryImage;
	onClick: () => void;
}) {
	const [hovered, setHovered] = useState(false);
	const platformColor = PLATFORM_COLORS[image.parentPlatform] || S.teal;

	return (
		<button
			onClick={onClick}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			style={{
				display: 'block',
				width: '100%',
				textAlign: 'left',
				padding: 0,
				borderRadius: 8,
				border: `1px solid ${hovered ? S.borderHover : S.borderColor}`,
				background: hovered ? S.cardBgHover : S.cardBg,
				cursor: 'pointer',
				transition: 'all 0.25s ease',
				transform: hovered ? 'translateY(-1px)' : 'none',
				overflow: 'hidden',
			}}
			type="button"
		>
			<img
				src={image.thumbnail}
				alt={image.styleName}
				style={{
					width: '100%',
					height: 'auto',
					display: 'block',
					filter: hovered ? 'brightness(1.05)' : 'brightness(0.9)',
					transition: 'filter 0.25s',
				}}
			/>
			<div style={{ padding: '8px 12px 10px' }}>
				<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
					<span style={{
						fontFamily: S.mono, fontSize: 9, fontWeight: 700,
						color: S.teal, letterSpacing: 1, textTransform: 'uppercase',
					}}>
						{image.styleName}
					</span>
					<span style={{
						fontFamily: S.mono, fontSize: 8,
						color: platformColor, letterSpacing: 0.5,
					}}>
						{PLATFORM_ICONS[image.parentPlatform] || image.parentPlatform.slice(0, 2)}
					</span>
				</div>
				<div style={{
					fontFamily: S.mono, fontSize: 8, color: S.textDim, marginTop: 4,
				}}>
					{new Date(image.parentCreatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
				</div>
			</div>
		</button>
	);
}

// --- Detail Views ---

function TextDetailView({
	entry,
	onClose,
	onDelete,
}: {
	entry: LibraryEntry;
	onClose: () => void;
	onDelete: () => void;
}) {
	const [copied, setCopied] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [expandedImage, setExpandedImage] = useState<number | null>(null);
	const platformColor = PLATFORM_COLORS[entry.platform] || S.accent;

	const date = new Date(entry.createdAt);
	const fullDate = date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
	const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

	const handleCopy = () => {
		navigator.clipboard?.writeText(entry.content);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	return (
		<div style={{
			position: 'fixed', inset: 0, zIndex: 1000,
			display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
			background: 'rgba(5, 7, 12, 0.85)', backdropFilter: 'blur(8px)',
			padding: '40px 20px', overflow: 'auto',
		}}>
			<div style={{
				width: '100%', maxWidth: 720, background: S.cardBg,
				borderRadius: 14, border: `1px solid ${S.borderColor}`, overflow: 'hidden',
			}}>
				{/* Header */}
				<div style={{
					padding: '20px 24px', borderBottom: `1px solid ${S.borderColor}`,
					display: 'flex', alignItems: 'center', justifyContent: 'space-between',
				}}>
					<div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
						<span style={{
							fontFamily: S.mono, fontSize: 10, fontWeight: 700, letterSpacing: 1,
							color: platformColor, background: platformColor + '15',
							padding: '4px 10px', borderRadius: 4, textTransform: 'uppercase',
						}}>
							{entry.platform}
						</span>
						<span style={{ fontFamily: S.mono, fontSize: 10, color: S.textMuted, letterSpacing: 0.3 }}>
							{fullDate} at {timeStr}
						</span>
					</div>
					<button onClick={onClose} style={{
						background: 'none', border: 'none', color: S.textMuted, cursor: 'pointer',
						fontFamily: S.mono, fontSize: 18, padding: '4px 8px', borderRadius: 4, lineHeight: 1,
					}} type="button">
						{'  '}
					</button>
				</div>

				{/* Topic */}
				{entry.topic && (
					<div style={{ padding: '12px 24px', borderBottom: `1px solid ${S.borderColor}`, background: S.bg }}>
						<span style={{ fontFamily: S.mono, fontSize: 9, color: S.textDim, letterSpacing: 1.5, textTransform: 'uppercase' }}>Topic</span>
						<p style={{ fontFamily: S.mono, fontSize: 11, color: S.textMuted, margin: '6px 0 0', lineHeight: 1.6, letterSpacing: 0.2 }}>
							{entry.topic.length > 200 ? entry.topic.slice(0, 200) + '...' : entry.topic}
						</p>
					</div>
				)}

				{/* Full content */}
				<div style={{ padding: '20px 24px' }}>
					<pre style={{
						fontFamily: S.serif, fontSize: 14, lineHeight: 1.7, color: S.textPrimary,
						whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, letterSpacing: '0.01em',
					}}>
						{entry.content}
					</pre>
				</div>

				{/* Images */}
				{entry.images && entry.images.length > 0 && (
					<div style={{ padding: '0 24px 20px' }}>
						<div style={{ fontFamily: S.mono, fontSize: 9, color: S.textDim, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 12 }}>
							Generated Images
						</div>
						<div style={{
							display: 'grid', gridTemplateColumns: entry.images.length === 1 ? '1fr' : '1fr 1fr', gap: 12,
						}}>
							{entry.images.map((img, idx) => (
								<div key={img.styleId + idx} style={{
									borderRadius: 8, overflow: 'hidden', border: `1px solid ${S.borderColor}`, background: S.bg,
								}}>
									<img
										src={img.thumbnail} alt={`${img.styleName} style`}
										style={{ width: '100%', height: 'auto', display: 'block', cursor: 'pointer' }}
										onClick={() => setExpandedImage(expandedImage === idx ? null : idx)}
									/>
									<div style={{ padding: '8px 12px' }}>
										<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
											<span style={{ fontFamily: S.mono, fontSize: 9, fontWeight: 700, color: S.accent, letterSpacing: 1, textTransform: 'uppercase' }}>
												{img.styleName}
											</span>
											<a href={img.thumbnail} target="_blank" rel="noopener noreferrer" style={{
												fontFamily: S.mono, fontSize: 9, color: S.textDim, textDecoration: 'none', letterSpacing: 0.5,
											}}>
												Open
											</a>
										</div>
										{expandedImage === idx && img.imagePrompt && (
											<p style={{ fontFamily: S.mono, fontSize: 9, color: S.textMuted, marginTop: 8, lineHeight: 1.5, letterSpacing: 0.2 }}>
												{img.imagePrompt}
											</p>
										)}
									</div>
								</div>
							))}
						</div>
					</div>
				)}

				{/* Action bar */}
				<div style={{
					padding: '16px 24px', borderTop: `1px solid ${S.borderColor}`,
					display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
				}}>
					<button onClick={handleCopy} style={{
						padding: '8px 16px', borderRadius: 6, border: `1px solid ${S.accent}`,
						background: copied ? S.accent : 'transparent', color: copied ? '#fff' : S.accentLight,
						fontFamily: S.mono, fontSize: 10, letterSpacing: 0.5, cursor: 'pointer', transition: 'all 0.2s',
					}} type="button">
						{copied ? 'Copied!' : 'Copy Text'}
					</button>
					<div>
						{confirmDelete ? (
							<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
								<span style={{ fontFamily: S.mono, fontSize: 10, color: S.red, letterSpacing: 0.3 }}>Delete forever?</span>
								<button onClick={onDelete} style={{
									padding: '8px 14px', borderRadius: 6, border: `1px solid ${S.red}`,
									background: S.red + '20', color: S.red, fontFamily: S.mono, fontSize: 10,
									letterSpacing: 0.5, cursor: 'pointer',
								}} type="button">Yes</button>
								<button onClick={() => setConfirmDelete(false)} style={{
									padding: '8px 14px', borderRadius: 6, border: `1px solid ${S.borderColor}`,
									background: 'transparent', color: S.textMuted, fontFamily: S.mono, fontSize: 10,
									letterSpacing: 0.5, cursor: 'pointer',
								}} type="button">Cancel</button>
							</div>
						) : (
							<button onClick={() => setConfirmDelete(true)} style={{
								padding: '8px 14px', borderRadius: 6, border: `1px solid ${S.borderColor}`,
								background: 'transparent', color: S.textDim, fontFamily: S.mono, fontSize: 10,
								letterSpacing: 0.5, cursor: 'pointer', transition: 'all 0.2s',
							}} type="button">Delete</button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

function VideoDetailView({
	entry,
	onClose,
	onDelete,
}: {
	entry: VideoLibraryEntry;
	onClose: () => void;
	onDelete: () => void;
}) {
	const [confirmDelete, setConfirmDelete] = useState(false);
	const platformColor = PLATFORM_COLORS[entry.platform] || S.orange;

	const date = new Date(entry.createdAt);
	const fullDate = date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
	const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

	return (
		<div style={{
			position: 'fixed', inset: 0, zIndex: 1000,
			display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
			background: 'rgba(5, 7, 12, 0.85)', backdropFilter: 'blur(8px)',
			padding: '40px 20px', overflow: 'auto',
		}}>
			<div style={{
				width: '100%', maxWidth: 720, background: S.cardBg,
				borderRadius: 14, border: `1px solid ${S.borderColor}`, overflow: 'hidden',
			}}>
				{/* Header */}
				<div style={{
					padding: '20px 24px', borderBottom: `1px solid ${S.borderColor}`,
					display: 'flex', alignItems: 'center', justifyContent: 'space-between',
				}}>
					<div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
						<span style={{
							fontFamily: S.mono, fontSize: 10, fontWeight: 700, letterSpacing: 1,
							color: S.orange, background: S.orange + '15',
							padding: '4px 10px', borderRadius: 4, textTransform: 'uppercase',
						}}>Video</span>
						<span style={{ fontFamily: S.mono, fontSize: 10, color: S.textMuted, letterSpacing: 0.3 }}>
							{fullDate} at {timeStr}
						</span>
					</div>
					<button onClick={onClose} style={{
						background: 'none', border: 'none', color: S.textMuted, cursor: 'pointer',
						fontFamily: S.mono, fontSize: 18, padding: '4px 8px', borderRadius: 4, lineHeight: 1,
					}} type="button">{'  '}</button>
				</div>

				{/* Metadata grid */}
				<div style={{
					display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16,
					padding: '20px 24px', borderBottom: `1px solid ${S.borderColor}`,
				}}>
					<div>
						<div style={{ fontFamily: S.mono, fontSize: 9, color: S.textDim, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 6 }}>Platform</div>
						<span style={{ fontFamily: S.mono, fontSize: 11, fontWeight: 700, color: platformColor, letterSpacing: 0.5 }}>
							{entry.platform}
						</span>
					</div>
					<div>
						<div style={{ fontFamily: S.mono, fontSize: 9, color: S.textDim, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 6 }}>Edit Mode</div>
						<span style={{ fontFamily: S.mono, fontSize: 11, color: S.textPrimary, letterSpacing: 0.3 }}>
							{MODE_LABELS[entry.renderMode] || entry.renderMode}
						</span>
					</div>
					<div>
						<div style={{ fontFamily: S.mono, fontSize: 9, color: S.textDim, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 6 }}>Clips Used</div>
						<span style={{ fontFamily: S.mono, fontSize: 11, color: S.textPrimary, letterSpacing: 0.3 }}>
							{entry.clipCount}
						</span>
					</div>
				</div>

				{/* Topic */}
				{entry.topic && (
					<div style={{ padding: '16px 24px', borderBottom: `1px solid ${S.borderColor}` }}>
						<div style={{ fontFamily: S.mono, fontSize: 9, color: S.textDim, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 6 }}>Topic</div>
						<p style={{ fontFamily: S.serif, fontSize: 14, lineHeight: 1.6, color: S.textPrimary, margin: 0 }}>
							{entry.topic}
						</p>
					</div>
				)}

				{/* Edit plan summary */}
				{entry.editPlanSummary && (
					<div style={{ padding: '16px 24px', borderBottom: `1px solid ${S.borderColor}` }}>
						<div style={{ fontFamily: S.mono, fontSize: 9, color: S.textDim, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 6 }}>Edit Plan</div>
						<pre style={{
							fontFamily: S.mono, fontSize: 11, lineHeight: 1.6, color: S.textSecondary,
							whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0,
						}}>
							{entry.editPlanSummary}
						</pre>
					</div>
				)}

				{/* Action bar */}
				<div style={{
					padding: '16px 24px', borderTop: `1px solid ${S.borderColor}`,
					display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
				}}>
					<a href={entry.downloadUrl} target="_blank" rel="noopener noreferrer" style={{
						padding: '8px 16px', borderRadius: 6, border: `1px solid ${S.orange}`,
						background: 'transparent', color: S.orange, fontFamily: S.mono, fontSize: 10,
						letterSpacing: 0.5, textDecoration: 'none', display: 'inline-block',
					}}>
						Download Video
					</a>
					<div>
						{confirmDelete ? (
							<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
								<span style={{ fontFamily: S.mono, fontSize: 10, color: S.red, letterSpacing: 0.3 }}>Delete forever?</span>
								<button onClick={onDelete} style={{
									padding: '8px 14px', borderRadius: 6, border: `1px solid ${S.red}`,
									background: S.red + '20', color: S.red, fontFamily: S.mono, fontSize: 10,
									letterSpacing: 0.5, cursor: 'pointer',
								}} type="button">Yes</button>
								<button onClick={() => setConfirmDelete(false)} style={{
									padding: '8px 14px', borderRadius: 6, border: `1px solid ${S.borderColor}`,
									background: 'transparent', color: S.textMuted, fontFamily: S.mono, fontSize: 10,
									letterSpacing: 0.5, cursor: 'pointer',
								}} type="button">Cancel</button>
							</div>
						) : (
							<button onClick={() => setConfirmDelete(true)} style={{
								padding: '8px 14px', borderRadius: 6, border: `1px solid ${S.borderColor}`,
								background: 'transparent', color: S.textDim, fontFamily: S.mono, fontSize: 10,
								letterSpacing: 0.5, cursor: 'pointer', transition: 'all 0.2s',
							}} type="button">Delete</button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

function ImageLightbox({
	image,
	onClose,
}: {
	image: GalleryImage;
	onClose: () => void;
}) {
	const platformColor = PLATFORM_COLORS[image.parentPlatform] || S.teal;
	const [showPrompt, setShowPrompt] = useState(false);

	return (
		<div
			style={{
				position: 'fixed', inset: 0, zIndex: 1000,
				display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
				background: 'rgba(5, 7, 12, 0.9)', backdropFilter: 'blur(8px)',
				padding: '40px 20px', overflow: 'auto',
			}}
			onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
		>
			<div style={{
				width: '100%', maxWidth: 680, background: S.cardBg,
				borderRadius: 14, border: `1px solid ${S.borderColor}`, overflow: 'hidden',
			}}>
				<img src={image.thumbnail} alt={image.styleName} style={{ width: '100%', height: 'auto', display: 'block' }} />
				<div style={{ padding: '16px 20px' }}>
					<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
						<div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
							<span style={{ fontFamily: S.mono, fontSize: 10, fontWeight: 700, color: S.teal, letterSpacing: 1, textTransform: 'uppercase' }}>
								{image.styleName}
							</span>
							<span style={{
								fontFamily: S.mono, fontSize: 9, color: platformColor,
								background: platformColor + '15', padding: '2px 6px', borderRadius: 3, letterSpacing: 0.5,
							}}>
								{image.parentPlatform}
							</span>
						</div>
						<button onClick={onClose} style={{
							background: 'none', border: 'none', color: S.textMuted, cursor: 'pointer',
							fontFamily: S.mono, fontSize: 18, padding: '4px 8px', borderRadius: 4, lineHeight: 1,
						}} type="button">{'  '}</button>
					</div>

					{image.parentTopic && (
						<p style={{ fontFamily: S.mono, fontSize: 10, color: S.textMuted, margin: '0 0 10px', lineHeight: 1.5, letterSpacing: 0.2 }}>
							{image.parentTopic.length > 150 ? image.parentTopic.slice(0, 150) + '...' : image.parentTopic}
						</p>
					)}

					<div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
						<a href={image.thumbnail} target="_blank" rel="noopener noreferrer" style={{
							fontFamily: S.mono, fontSize: 10, color: S.teal, letterSpacing: 0.5, textDecoration: 'none',
						}}>
							Open Full Size
						</a>
						{image.imagePrompt && (
							<button onClick={() => setShowPrompt(!showPrompt)} style={{
								background: 'none', border: `1px solid ${S.borderColor}`,
								color: S.textMuted, fontFamily: S.mono, fontSize: 9,
								padding: '4px 10px', borderRadius: 4, cursor: 'pointer', letterSpacing: 0.5,
							}} type="button">
								{showPrompt ? 'Hide Prompt' : 'Show Prompt'}
							</button>
						)}
					</div>

					{showPrompt && image.imagePrompt && (
						<pre style={{
							fontFamily: S.mono, fontSize: 10, color: S.textMuted,
							marginTop: 12, lineHeight: 1.5, letterSpacing: 0.2,
							whiteSpace: 'pre-wrap', wordBreak: 'break-word',
							padding: 12, background: S.bg, borderRadius: 6,
							border: `1px solid ${S.borderColor}`,
						}}>
							{image.imagePrompt}
						</pre>
					)}
				</div>
			</div>
		</div>
	);
}

// --- Main Component ---

export function ContentLibrary({ onBack }: { onBack: () => void }) {
	const [activeTab, setActiveTab] = useState<MediaTab>('text');

	// Text entries
	const [entries, setEntries] = useState<LibraryEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// Video entries
	const [videoEntries, setVideoEntries] = useState<VideoLibraryEntry[]>([]);
	const [loadingVideos, setLoadingVideos] = useState(true);

	// Text tab filters
	const [searchQuery, setSearchQuery] = useState('');
	const [filterPlatform, setFilterPlatform] = useState<string | null>(null);
	const [sortDirection, setSortDirection] = useState<'newest' | 'oldest'>('newest');

	// Selection states
	const [selectedEntry, setSelectedEntry] = useState<LibraryEntry | null>(null);
	const [selectedVideo, setSelectedVideo] = useState<VideoLibraryEntry | null>(null);
	const [selectedImage, setSelectedImage] = useState<GalleryImage | null>(null);

	// Fetch all library data
	const fetchAllEntries = useCallback(async () => {
		try {
			setLoading(true);
			setLoadingVideos(true);

			const [textResp, videoResp] = await Promise.all([
				fetch('/api/content-library'),
				fetch('/api/video-library'),
			]);

			if (textResp.ok) {
				const textData = await textResp.json() as { entries: LibraryEntry[]; count: number };
				setEntries(textData.entries || []);
			}

			if (videoResp.ok) {
				const videoData = await videoResp.json() as { entries: VideoLibraryEntry[]; count: number };
				setVideoEntries(videoData.entries || []);
			}

			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to load library');
		} finally {
			setLoading(false);
			setLoadingVideos(false);
		}
	}, []);

	useEffect(() => {
		fetchAllEntries();
	}, [fetchAllEntries]);

	// Delete handlers
	const handleDeleteText = useCallback(async (id: string) => {
		try {
			const resp = await fetch(`/api/content-library/${id}`, { method: 'DELETE' });
			if (resp.ok) {
				setEntries((prev) => prev.filter((e) => e.id !== id));
				setSelectedEntry(null);
			}
		} catch { /* best-effort */ }
	}, []);

	const handleDeleteVideo = useCallback(async (id: string) => {
		try {
			const resp = await fetch(`/api/video-library/${id}`, { method: 'DELETE' });
			if (resp.ok) {
				setVideoEntries((prev) => prev.filter((e) => e.id !== id));
				setSelectedVideo(null);
			}
		} catch { /* best-effort */ }
	}, []);

	// Computed: gallery images
	const galleryImages = useMemo<GalleryImage[]>(() => {
		return entries.flatMap((entry) =>
			(entry.images || []).map((img) => ({
				...img,
				parentEntryId: entry.id,
				parentPlatform: entry.platform,
				parentCreatedAt: entry.createdAt,
				parentTopic: entry.topic,
			})),
		);
	}, [entries]);

	// Tab counts
	const tabCounts = useMemo<Record<MediaTab, number>>(() => ({
		text: entries.length,
		video: videoEntries.length,
		audio: 0,
		images: galleryImages.length,
	}), [entries.length, videoEntries.length, galleryImages.length]);

	// Text platform counts for filter chips
	const platformCounts = useMemo(() => {
		const counts: Record<string, number> = {};
		for (const e of entries) {
			counts[e.platform] = (counts[e.platform] || 0) + 1;
		}
		return counts;
	}, [entries]);

	const platforms = useMemo(() =>
		Object.keys(platformCounts).sort((a, b) => (platformCounts[b] || 0) - (platformCounts[a] || 0)),
		[platformCounts],
	);

	// Filtered + sorted text entries
	const filteredEntries = useMemo(() => {
		let result = [...entries];
		if (filterPlatform) result = result.filter((e) => e.platform === filterPlatform);
		if (searchQuery.trim()) {
			const q = searchQuery.toLowerCase();
			result = result.filter((e) =>
				e.content.toLowerCase().includes(q) || e.topic.toLowerCase().includes(q) || e.platform.toLowerCase().includes(q),
			);
		}
		result.sort((a, b) => {
			const diff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
			return sortDirection === 'newest' ? diff : -diff;
		});
		return result;
	}, [entries, filterPlatform, searchQuery, sortDirection]);

	// Sorted video entries
	const sortedVideoEntries = useMemo(() => {
		return [...videoEntries].sort((a, b) => {
			const diff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
			return sortDirection === 'newest' ? diff : -diff;
		});
	}, [videoEntries, sortDirection]);

	// Stats
	const totalImages = useMemo(() => entries.reduce((sum, e) => sum + (e.images?.length || 0), 0), [entries]);

	const isLoading = loading || loadingVideos;

	return (
		<div style={{ minHeight: '100vh', background: S.bg, color: S.textPrimary, fontFamily: S.serif }}>
			{/* Header */}
			<header style={{
				padding: '20px 28px', borderBottom: `1px solid ${S.borderColor}`,
				display: 'flex', justifyContent: 'space-between', alignItems: 'center',
			}}>
				<div>
					<button onClick={onBack} style={{
						background: 'none', border: 'none', color: S.textMuted, cursor: 'pointer',
						fontFamily: S.mono, fontSize: 11, marginBottom: 6, letterSpacing: 0.5, padding: 0,
					}} type="button">
						{'<-'} Back to Content Studio
					</button>
					<h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', margin: 0 }}>
						Media Library
					</h1>
					<p style={{ fontFamily: S.mono, fontSize: 11, color: S.textMuted, marginTop: 4, letterSpacing: 0.3 }}>
						Unified archive of all generated content
					</p>
				</div>

				{(entries.length > 0 || videoEntries.length > 0) && (
					<div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
						{[
							{ value: entries.length, label: 'Posts', color: S.accent },
							{ value: videoEntries.length, label: 'Videos', color: S.orange },
							{ value: totalImages, label: 'Images', color: S.teal },
							{ value: platforms.length, label: 'Platforms', color: S.accentLight },
						].map((stat) => (
							<div key={stat.label} style={{ textAlign: 'center' }}>
								<div style={{ fontFamily: S.mono, fontSize: 20, fontWeight: 700, color: stat.color }}>
									{stat.value}
								</div>
								<div style={{ fontFamily: S.mono, fontSize: 9, color: S.textDim, letterSpacing: 1, textTransform: 'uppercase' }}>
									{stat.label}
								</div>
							</div>
						))}
					</div>
				)}
			</header>

			{/* Tab Bar */}
			<TabBar activeTab={activeTab} onTabChange={setActiveTab} counts={tabCounts} />

			{/* Content area */}
			<main style={{ padding: '24px 28px', maxWidth: 1200, margin: '0 auto' }}>
				{isLoading && (
					<div style={{ padding: 60, textAlign: 'center', fontFamily: S.mono, fontSize: 12, color: S.textMuted, letterSpacing: 1 }}>
						Loading library...
					</div>
				)}

				{error && (
					<div style={{ padding: 20, textAlign: 'center', fontFamily: S.mono, fontSize: 12, color: S.red }}>
						{error}
					</div>
				)}

				{/* ===== TEXT TAB ===== */}
				{!isLoading && !error && activeTab === 'text' && (
					<>
						{entries.length === 0 ? (
							<EmptyState message="No text posts yet" submessage="Content you create with the Content Creator will automatically appear here. Go write something brilliant." />
						) : (
							<>
								<div style={{ marginBottom: 20 }}>
									<input
										type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
										placeholder="Search content, topics, platforms..."
										style={{
											width: '100%', padding: '10px 14px', borderRadius: 8,
											border: `1px solid ${S.borderColor}`, background: S.bg,
											color: S.textPrimary, fontFamily: S.mono, fontSize: 12,
											letterSpacing: 0.3, outline: 'none', marginBottom: 12,
										}}
									/>
									<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
										<div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
											<FilterChip label="All" active={filterPlatform === null} count={entries.length} onClick={() => setFilterPlatform(null)} />
											{platforms.map((p) => (
												<FilterChip key={p} label={p} active={filterPlatform === p} count={platformCounts[p]} color={PLATFORM_COLORS[p]} onClick={() => setFilterPlatform(filterPlatform === p ? null : p)} />
											))}
										</div>
										<button onClick={() => setSortDirection((prev) => prev === 'newest' ? 'oldest' : 'newest')} style={{
											padding: '5px 10px', borderRadius: 4, border: `1px solid ${S.borderColor}`,
											background: 'transparent', color: S.textMuted, fontFamily: S.mono, fontSize: 9,
											letterSpacing: 0.5, cursor: 'pointer',
										}} type="button">
											{sortDirection === 'newest' ? 'Newest First \u2193' : 'Oldest First \u2191'}
										</button>
									</div>
								</div>
								<div style={{ fontFamily: S.mono, fontSize: 9, color: S.textDim, letterSpacing: 0.5, marginBottom: 16 }}>
									{filteredEntries.length} of {entries.length} entries
								</div>
								{filteredEntries.length === 0 ? (
									<div style={{ padding: 60, textAlign: 'center', fontFamily: S.mono, fontSize: 12, color: S.textMuted }}>
										No content matches your search
									</div>
								) : (
									<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
										{filteredEntries.map((entry) => (
											<ContentCard key={entry.id} entry={entry} onClick={() => setSelectedEntry(entry)} />
										))}
									</div>
								)}
							</>
						)}
					</>
				)}

				{/* ===== VIDEO TAB ===== */}
				{!isLoading && !error && activeTab === 'video' && (
					<>
						{videoEntries.length === 0 ? (
							<EmptyState message="No videos yet" submessage="Completed video renders from the Video Editor will automatically appear here. Go create a video." />
						) : (
							<>
								<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
									<div style={{ fontFamily: S.mono, fontSize: 9, color: S.textDim, letterSpacing: 0.5 }}>
										{videoEntries.length} video{videoEntries.length !== 1 ? 's' : ''}
									</div>
									<button onClick={() => setSortDirection((prev) => prev === 'newest' ? 'oldest' : 'newest')} style={{
										padding: '5px 10px', borderRadius: 4, border: `1px solid ${S.borderColor}`,
										background: 'transparent', color: S.textMuted, fontFamily: S.mono, fontSize: 9,
										letterSpacing: 0.5, cursor: 'pointer',
									}} type="button">
										{sortDirection === 'newest' ? 'Newest First \u2193' : 'Oldest First \u2191'}
									</button>
								</div>
								<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
									{sortedVideoEntries.map((entry) => (
										<VideoCard key={entry.id} entry={entry} onClick={() => setSelectedVideo(entry)} />
									))}
								</div>
							</>
						)}
					</>
				)}

				{/* ===== AUDIO TAB ===== */}
				{!isLoading && !error && activeTab === 'audio' && (
					<EmptyState message="Audio coming soon" submessage="Audio content will appear here when audio generation is added. Stay tuned for voiceovers, music, and sound design." />
				)}

				{/* ===== IMAGES TAB ===== */}
				{!isLoading && !error && activeTab === 'images' && (
					<>
						{galleryImages.length === 0 ? (
							<EmptyState message="No images yet" submessage="Generated images from the Content Creator will appear here as a browsable gallery. Create some content with images to get started." />
						) : (
							<>
								<div style={{ fontFamily: S.mono, fontSize: 9, color: S.textDim, letterSpacing: 0.5, marginBottom: 16 }}>
									{galleryImages.length} image{galleryImages.length !== 1 ? 's' : ''} across {entries.filter((e) => e.images && e.images.length > 0).length} posts
								</div>
								<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
									{galleryImages.map((img, idx) => (
										<ImageGalleryCard key={`${img.parentEntryId}-${img.styleId}-${idx}`} image={img} onClick={() => setSelectedImage(img)} />
									))}
								</div>
							</>
						)}
					</>
				)}
			</main>

			{/* Detail overlays */}
			{selectedEntry && (
				<TextDetailView entry={selectedEntry} onClose={() => setSelectedEntry(null)} onDelete={() => handleDeleteText(selectedEntry.id)} />
			)}
			{selectedVideo && (
				<VideoDetailView entry={selectedVideo} onClose={() => setSelectedVideo(null)} onDelete={() => handleDeleteVideo(selectedVideo.id)} />
			)}
			{selectedImage && (
				<ImageLightbox image={selectedImage} onClose={() => setSelectedImage(null)} />
			)}
		</div>
	);
}

export default ContentLibrary;
