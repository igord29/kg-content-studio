import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// --- Types ---

interface DriveVideo {
	id: string;
	name: string;
	mimeType: string;
	size: string;
	sizeBytes: string;
	created: string;
	thumbnail?: string;
	// Catalog fields
	description: string;
	suspectedLocation: string;
	locationConfidence: string;
	locationClues: string;
	contentType: string;
	quality: string;
	indoorOutdoor: string;
	duration: string;
	peopleCount: string;
	readableText: string;
	notableMoments: string;
	suggestedModes: string[];
	needsManualReview: boolean;
	reviewNotes: string;
}

interface FolderSummary {
	totalFiles: number;
	totalSizeGB: number;
	videoFormats: Record<string, number>;
	dateRange: { earliest: string; latest: string };
}

interface EditPlanResult {
	success: boolean;
	editPlan?: string;
	editPlanData?: any;
	videoCount?: number;
	videos?: Array<{ id: string; name: string }>;
	message?: string;
}

interface ReviewIssue {
	severity: 'critical' | 'warning' | 'suggestion';
	timestamp: string;
	category: 'pacing' | 'storytelling' | 'platform' | 'visual' | 'text';
	description: string;
	fix: string;
}

interface VideoReview {
	overallScore: number;
	storytellingScore: number;
	pacingScore: number;
	platformFitScore: number;
	storyArc: 'clear' | 'weak' | 'missing';
	hookEffectiveness: string;
	endingQuality: string;
	issues: ReviewIssue[];
	strengths: string[];
	summary: string;
}

interface RenderJob {
	platform: string;
	renderId?: string;
	status: 'pending' | 'submitting' | 'queued' | 'fetching' | 'rendering' | 'saving' | 'done' | 'failed';
	downloadUrl?: string;
	error?: string;
	method: 'shotstack' | 'ffmpeg';
	localOutputPath?: string;
	// The edit plan that produced this render (so review compares against the right plan)
	usedEditPlan?: any;
	// Review state
	review?: VideoReview | null;
	reviewStatus?: 'idle' | 'reviewing' | 'done' | 'failed';
	reviewError?: string;
	revisedEditPlan?: any;
	// Revision tracking
	revisionCount?: number;          // 0 = original, 1 = first revision, 2 = max
	previousScores?: number[];       // overall scores from prior renders
	originalDownloadUrl?: string;    // preserves the original render's download URL
}

const RENDER_STATUS_MESSAGES: Record<string, string> = {
	pending: 'Waiting to start...',
	submitting: 'Submitting render job...',
	queued: 'Queued - waiting to start...',
	fetching: 'Fetching source videos...',
	rendering: 'Rendering video...',
	saving: 'Saving final video...',
	done: 'Complete!',
	failed: 'Render failed.',
};

const PLATFORM_LABELS: Record<string, string> = {
	tiktok: 'TikTok (9:16)',
	'ig-reels': 'IG Reels (9:16)',
	'ig-feed': 'IG Feed (1:1)',
	youtube: 'YouTube (16:9)',
	facebook: 'Facebook (16:9)',
	linkedin: 'LinkedIn (16:9)',
};

// --- Constants ---

const MODES = [
	{ id: 'auto', label: 'Auto', desc: 'AI chooses the best mode', tier: 'AI' },
	{ id: 'game_day', label: 'Game Day', desc: 'Fast cuts, beat-synced, sports energy', tier: 'Tier 1' },
	{ id: 'our_story', label: 'Our Story', desc: 'Interview/testimonial, slow crossfades', tier: 'Tier 2' },
	{ id: 'quick_hit', label: 'Quick Hit', desc: 'Behind-the-scenes, text-heavy, vertical', tier: 'Tier 1' },
	{ id: 'showcase', label: 'Showcase', desc: 'Cinematic, donor/grant, professional', tier: 'Tier 2' },
];

const PLATFORMS = [
	{ id: 'tiktok', label: 'TikTok' },
	{ id: 'ig-reels', label: 'IG Reels' },
	{ id: 'ig-feed', label: 'IG Feed' },
	{ id: 'youtube', label: 'YouTube' },
	{ id: 'facebook', label: 'Facebook' },
	{ id: 'linkedin', label: 'LinkedIn' },
];

const LOCATION_COLORS: Record<string, { bg: string; text: string; border: string }> = {
	'US Open': { bg: '#92400e20', text: '#fbbf24', border: '#92400e' },
	'Hempstead': { bg: '#16653420', text: '#4ade80', border: '#166534' },
	'Brooklyn': { bg: '#1e3a5f20', text: '#60a5fa', border: '#1e3a5f' },
	'Long Beach': { bg: '#155e7520', text: '#22d3ee', border: '#155e75' },
	'Newark NJ': { bg: '#9a340020', text: '#fb923c', border: '#9a3400' },
	'Westchester': { bg: '#581c8720', text: '#c084fc', border: '#581c87' },
	'Connecticut': { bg: '#115e5920', text: '#2dd4bf', border: '#115e59' },
	'Unknown': { bg: '#3f3f4620', text: '#a1a1aa', border: '#3f3f46' },
};

const CONTENT_TYPE_COLORS: Record<string, { bg: string; text: string }> = {
	'tennis_action': { bg: '#16653420', text: '#4ade80' },
	'chess': { bg: '#1e3a5f20', text: '#60a5fa' },
	'event': { bg: '#92400e20', text: '#fbbf24' },
	'interview': { bg: '#581c8720', text: '#c084fc' },
	'establishing': { bg: '#3f3f4620', text: '#a1a1aa' },
	'mixed': { bg: '#115e5920', text: '#2dd4bf' },
	'unknown': { bg: '#7f1d1d20', text: '#f87171' },
};

const CONTENT_TYPE_LABELS: Record<string, string> = {
	'tennis_action': 'Tennis',
	'chess': 'Chess',
	'event': 'Event',
	'interview': 'Interview',
	'establishing': 'Establishing',
	'mixed': 'Mixed',
	'unknown': 'Unknown',
};

const ALL_LOCATIONS = ['US Open', 'Hempstead', 'Brooklyn', 'Long Beach', 'Newark NJ', 'Westchester', 'Connecticut', 'Unknown'];
const ALL_CONTENT_TYPES = ['tennis_action', 'chess', 'event', 'interview', 'mixed', 'establishing', 'unknown'];

type SortKey = 'name' | 'location' | 'contentType' | 'duration' | 'quality';
type SortDirection = 'asc' | 'desc';

// --- Styles ---

const S = {
	mono: "'Space Mono', monospace" as string,
	serif: "'Source Serif 4', Georgia, serif" as string,
	bg: '#0a0d14',
	cardBg: '#111520',
	borderColor: '#1e2538',
	textPrimary: '#e2e8f0',
	textMuted: '#4a5578',
	textDim: '#2a3148',
	accent: '#2D6A4F',
	accentLight: '#4a9e7a',
	orange: '#E67E22',
	red: '#f87171',
};

// --- Sub-components ---

function Label({ children }: { children: React.ReactNode }) {
	return (
		<label style={{
			display: 'block',
			fontFamily: S.mono,
			fontSize: 10,
			letterSpacing: 2,
			textTransform: 'uppercase' as const,
			color: S.textMuted,
			marginBottom: 8,
		}}>
			{children}
		</label>
	);
}

function StatusBadge({ connected }: { connected: boolean | null }) {
	if (connected === null) return null;
	return (
		<span style={{
			display: 'inline-flex',
			alignItems: 'center',
			gap: 6,
			padding: '4px 10px',
			borderRadius: 20,
			background: connected ? '#2D6A4F20' : '#5c262620',
			border: `1px solid ${connected ? '#2D6A4F' : '#5c2626'}`,
			fontFamily: S.mono,
			fontSize: 10,
			color: connected ? S.accentLight : S.red,
			letterSpacing: 0.5,
		}}>
			<span style={{
				width: 6,
				height: 6,
				borderRadius: '50%',
				background: connected ? S.accentLight : S.red,
			}} />
			{connected ? 'Drive Connected' : 'Drive Error'}
		</span>
	);
}

function LocationBadge({ location, needsReview, editable, videoId, onUpdate }: {
	location: string;
	needsReview?: boolean;
	editable?: boolean;
	videoId?: string;
	onUpdate?: (videoId: string, field: 'location' | 'contentType', value: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const normalized = ALL_LOCATIONS.includes(location) ? location : 'Unknown';
	const fallback = { bg: '#2a2a2a', text: '#999', border: '#444' };
	const colors = LOCATION_COLORS[normalized] ?? LOCATION_COLORS['Unknown'] ?? fallback;
	const label = normalized === 'Unknown' && needsReview
		? 'Unknown - Review'
		: normalized;

	if (!editable || !videoId || !onUpdate) {
		return (
			<span style={{
				display: 'inline-block',
				padding: '1px 5px',
				borderRadius: 3,
				background: colors.bg,
				border: `1px solid ${colors.border}`,
				color: colors.text,
				fontFamily: S.mono,
				fontSize: 8,
				letterSpacing: 0.3,
				whiteSpace: 'nowrap',
			}}>
				{label}
			</span>
		);
	}

	return (
		<span style={{ position: 'relative', display: 'inline-block' }}>
			<span
				onClick={(e) => {
					e.stopPropagation();
					setOpen(!open);
				}}
				style={{
					display: 'inline-block',
					padding: '1px 5px',
					borderRadius: 3,
					background: colors.bg,
					border: `1px solid ${open ? colors.text : colors.border}`,
					color: colors.text,
					fontFamily: S.mono,
					fontSize: 8,
					letterSpacing: 0.3,
					whiteSpace: 'nowrap',
					cursor: 'pointer',
					userSelect: 'none',
				}}
				title="Click to change location"
			>
				{label} &#9662;
			</span>
			{open && (
				<div
					onClick={(e) => e.stopPropagation()}
					style={{
						position: 'absolute',
						top: '100%',
						left: 0,
						zIndex: 100,
						marginTop: 2,
						background: '#1a1f2e',
						border: '1px solid #2a3148',
						borderRadius: 6,
						padding: '4px 0',
						boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
						minWidth: 130,
					}}
				>
					{ALL_LOCATIONS.map((loc) => {
						const locColors = LOCATION_COLORS[loc] ?? LOCATION_COLORS['Unknown'] ?? fallback;
						const isActive = loc === normalized;
						return (
							<div
								key={loc}
								onClick={(e) => {
									e.stopPropagation();
									onUpdate(videoId, 'location', loc);
									setOpen(false);
								}}
								style={{
									padding: '5px 10px',
									fontFamily: S.mono,
									fontSize: 9,
									color: isActive ? locColors.text : '#94a3b8',
									background: isActive ? `${locColors.bg}` : 'transparent',
									cursor: 'pointer',
									display: 'flex',
									alignItems: 'center',
									gap: 6,
								}}
								onMouseEnter={(e) => {
									(e.currentTarget as HTMLDivElement).style.background = '#252d3d';
								}}
								onMouseLeave={(e) => {
									(e.currentTarget as HTMLDivElement).style.background = isActive ? `${locColors.bg}` : 'transparent';
								}}
							>
								<span style={{
									width: 6,
									height: 6,
									borderRadius: '50%',
									background: locColors.text,
									flexShrink: 0,
								}} />
								{loc}
								{isActive && <span style={{ marginLeft: 'auto', fontSize: 8 }}>&#10003;</span>}
							</div>
						);
					})}
				</div>
			)}
		</span>
	);
}

function ContentTypeBadge({ type, editable, videoId, onUpdate }: {
	type: string;
	editable?: boolean;
	videoId?: string;
	onUpdate?: (videoId: string, field: 'location' | 'contentType', value: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const ctFallback = { bg: '#2a2a2a', text: '#999' };
	const colors = CONTENT_TYPE_COLORS[type] ?? CONTENT_TYPE_COLORS['unknown'] ?? ctFallback;
	const label = CONTENT_TYPE_LABELS[type] || 'Unknown';

	if (!editable || !videoId || !onUpdate) {
		return (
			<span style={{
				display: 'inline-block',
				padding: '1px 5px',
				borderRadius: 3,
				background: colors.bg,
				color: colors.text,
				fontFamily: S.mono,
				fontSize: 8,
				letterSpacing: 0.3,
				whiteSpace: 'nowrap',
			}}>
				{label}
			</span>
		);
	}

	return (
		<span style={{ position: 'relative', display: 'inline-block' }}>
			<span
				onClick={(e) => {
					e.stopPropagation();
					setOpen(!open);
				}}
				style={{
					display: 'inline-block',
					padding: '1px 5px',
					borderRadius: 3,
					background: colors.bg,
					color: colors.text,
					fontFamily: S.mono,
					fontSize: 8,
					letterSpacing: 0.3,
					whiteSpace: 'nowrap',
					cursor: 'pointer',
					userSelect: 'none',
				}}
				title="Click to change content type"
			>
				{label} &#9662;
			</span>
			{open && (
				<div
					onClick={(e) => e.stopPropagation()}
					style={{
						position: 'absolute',
						top: '100%',
						left: 0,
						zIndex: 100,
						marginTop: 2,
						background: '#1a1f2e',
						border: '1px solid #2a3148',
						borderRadius: 6,
						padding: '4px 0',
						boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
						minWidth: 130,
					}}
				>
					{ALL_CONTENT_TYPES.map((ct) => {
						const ctColors = CONTENT_TYPE_COLORS[ct] ?? CONTENT_TYPE_COLORS['unknown'] ?? ctFallback;
						const ctLabel = CONTENT_TYPE_LABELS[ct] || ct;
						const isActive = ct === type;
						return (
							<div
								key={ct}
								onClick={(e) => {
									e.stopPropagation();
									onUpdate(videoId, 'contentType', ct);
									setOpen(false);
								}}
								style={{
									padding: '5px 10px',
									fontFamily: S.mono,
									fontSize: 9,
									color: isActive ? ctColors.text : '#94a3b8',
									background: isActive ? `${ctColors.bg}` : 'transparent',
									cursor: 'pointer',
									display: 'flex',
									alignItems: 'center',
									gap: 6,
								}}
								onMouseEnter={(e) => {
									(e.currentTarget as HTMLDivElement).style.background = '#252d3d';
								}}
								onMouseLeave={(e) => {
									(e.currentTarget as HTMLDivElement).style.background = isActive ? `${ctColors.bg}` : 'transparent';
								}}
							>
								<span style={{
									width: 6,
									height: 6,
									borderRadius: '50%',
									background: ctColors.text,
									flexShrink: 0,
								}} />
								{ctLabel}
								{isActive && <span style={{ marginLeft: 'auto', fontSize: 8 }}>&#10003;</span>}
							</div>
						);
					})}
				</div>
			)}
		</span>
	);
}

function FilterButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
	return (
		<button
			onClick={onClick}
			style={{
				padding: '3px 8px',
				borderRadius: 4,
				border: `1px solid ${active ? S.accent : S.borderColor}`,
				background: active ? '#2D6A4F20' : 'transparent',
				color: active ? S.accentLight : S.textMuted,
				cursor: 'pointer',
				fontFamily: S.mono,
				fontSize: 9,
				transition: 'all 0.15s',
				whiteSpace: 'nowrap',
			}}
			type="button"
		>
			{label}
		</button>
	);
}

// --- Utility ---

function getQualityOrder(q: string): number {
	const order: Record<string, number> = { excellent: 0, good: 1, fair: 2, poor: 3, unknown: 4 };
	return order[q] ?? 4;
}

function parseDurationSeconds(d: string): number {
	if (!d) return 0;
	const n = parseInt(d.replace('s', ''));
	return isNaN(n) ? 0 : n;
}

// --- Smart Suggestions ---

function getModeSuggestion(selected: DriveVideo[]): { mode: string; reason: string } | null {
	if (selected.length === 0) return null;

	const types: Record<string, number> = {};
	for (const v of selected) {
		types[v.contentType] = (types[v.contentType] || 0) + 1;
	}

	const total = selected.length;
	const tennisCount = types['tennis_action'] || 0;
	const chessCount = types['chess'] || 0;
	const interviewCount = types['interview'] || 0;
	const eventCount = types['event'] || 0;

	if (tennisCount >= total * 0.6) {
		return { mode: 'game_day', reason: `${tennisCount} tennis action clip${tennisCount > 1 ? 's' : ''} selected` };
	}
	if (chessCount >= total * 0.6) {
		return { mode: 'game_day', reason: `${chessCount} chess clip${chessCount > 1 ? 's' : ''} selected` };
	}
	if (interviewCount >= 1 && (tennisCount + eventCount) >= 1) {
		return { mode: 'our_story', reason: 'Mix of interviews and action footage' };
	}
	if (interviewCount >= total * 0.5) {
		return { mode: 'our_story', reason: `${interviewCount} interview clip${interviewCount > 1 ? 's' : ''} selected` };
	}
	if (total === 1 && parseDurationSeconds(selected[0]!.duration) <= 30) {
		return { mode: 'quick_hit', reason: 'Single short clip selected' };
	}
	if (eventCount >= total * 0.5) {
		return { mode: 'showcase', reason: `${eventCount} event clip${eventCount > 1 ? 's' : ''} selected` };
	}
	return null;
}

function getTopicSuggestion(selected: DriveVideo[]): string {
	if (selected.length === 0) return '';

	const locations = new Set(selected.map(v => v.suspectedLocation).filter(l => l && l !== 'Unknown' && l !== 'unknown'));
	const types = new Set(selected.map(v => v.contentType));

	if (locations.size === 1) {
		const loc = [...locations][0]!;
		if (types.has('tennis_action') && types.size <= 2) return `Tennis at ${loc}`;
		if (types.has('chess')) return `CLC Chess - ${loc}`;
		if (types.has('event')) return `CLC Event - ${loc}`;
		return `CLC at ${loc}`;
	}

	if (locations.has('US Open')) return 'CLC at the US Open';

	if (types.size === 1) {
		const type = [...types][0]!;
		if (type === 'tennis_action') return 'CLC Tennis Highlights';
		if (type === 'chess') return 'CLC Chess Program';
		if (type === 'event') return 'CLC Event Highlights';
		if (type === 'interview') return 'CLC Stories';
	}

	return '';
}

// --- Main Component ---

interface VideoEditorProps {
	onBack: () => void;
}

export function VideoEditor({ onBack }: VideoEditorProps) {
	// Connection
	const [driveConnected, setDriveConnected] = useState<boolean | null>(null);

	// Video library
	const [videos, setVideos] = useState<DriveVideo[]>([]);
	const [summary, setSummary] = useState<FolderSummary | null>(null);
	const [loadingVideos, setLoadingVideos] = useState(false);
	const [videoError, setVideoError] = useState<string | null>(null);
	const [searchQuery, setSearchQuery] = useState('');

	// Filters
	const [filterLocation, setFilterLocation] = useState<string | null>(null);
	const [filterContentType, setFilterContentType] = useState<string | null>(null);
	const [filterQuality, setFilterQuality] = useState<string | null>(null);
	const [sortBy, setSortBy] = useState<SortKey>('name');
	const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

	// Selection
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [hoveredVideoId, setHoveredVideoId] = useState<string | null>(null);

	// Edit config
	const [selectedMode, setSelectedMode] = useState('auto');
	const [topic, setTopic] = useState('');
	const [purpose, setPurpose] = useState('social');
	const [enabledPlatforms, setEnabledPlatforms] = useState<Set<string>>(
		new Set(PLATFORMS.map((p) => p.id)),
	);

	// Edit plan / result
	const [editPlan, setEditPlan] = useState<string | null>(null);
	const [editPlanData, setEditPlanData] = useState<any>(null);
	const [generating, setGenerating] = useState(false);
	const [genError, setGenError] = useState<string | null>(null);

	// Copy feedback
	const [copied, setCopied] = useState(false);

	// Music state
	const [customMusicUrl, setCustomMusicUrl] = useState('');
	const [musicEnabled, setMusicEnabled] = useState(true); // auto-add music for Tier 2+ platforms

	// Render state
	const [renderJobs, setRenderJobs] = useState<RenderJob[]>([]);
	const [renderingAll, setRenderingAll] = useState(false);
	const [ffmpegAvailable, setFfmpegAvailable] = useState<boolean | null>(null);
	const [shotstackConnected, setShotstackConnected] = useState<boolean | null>(null);

	// Catalog state
	const [catalogRunning, setCatalogRunning] = useState(false);
	const [catalogProgress, setCatalogProgress] = useState<{
		total: number;
		completed: number;
		failed: number;
	} | null>(null);
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const [analyzingSingle, setAnalyzingSingle] = useState<string | null>(null);

	// Auto-catalog detection
	const [autoCatalogDetected, setAutoCatalogDetected] = useState(false);
	const [uncatalogedCount, setUncatalogedCount] = useState(0);
	const [autoCatalogDismissed, setAutoCatalogDismissed] = useState(false);

	// Thumbnail refresh
	const [refreshingThumbnails, setRefreshingThumbnails] = useState(false);
	const [thumbnailRefreshResult, setThumbnailRefreshResult] = useState<string | null>(null);

	// --- Catalog summary computed from enriched videos ---

	const catalogSummary = useMemo(() => {
		if (videos.length === 0) return null;

		const byLocation: Record<string, number> = {};
		const byContentType: Record<string, number> = {};
		const byQuality: Record<string, number> = {};
		let needsReview = 0;

		for (const v of videos) {
			const loc = v.suspectedLocation || 'Unknown';
			byLocation[loc] = (byLocation[loc] || 0) + 1;
			const ct = v.contentType || 'unknown';
			byContentType[ct] = (byContentType[ct] || 0) + 1;
			const q = v.quality || 'unknown';
			byQuality[q] = (byQuality[q] || 0) + 1;
			if (v.needsManualReview) needsReview++;
		}

		return { byLocation, byContentType, byQuality, needsReview };
	}, [videos]);

	// --- Load videos on mount ---

	useEffect(() => {
		loadVideos();
	}, []);

	// Auto-catalog: trigger when uncataloged videos are detected
	useEffect(() => {
		if (
			autoCatalogDetected &&
			!autoCatalogDismissed &&
			!catalogRunning &&
			uncatalogedCount > 0 &&
			driveConnected === true
		) {
			const timer = setTimeout(() => {
				handleRunFullCatalog();
			}, 3000);
			return () => clearTimeout(timer);
		}
	}, [autoCatalogDetected, autoCatalogDismissed, catalogRunning, uncatalogedCount, driveConnected]);

	const loadVideos = useCallback(async () => {
		setLoadingVideos(true);
		setVideoError(null);
		try {
			// Test connection
			const connResp = await fetch('/api/video-editor', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ task: 'test-connection' }),
			});
			const connData = await connResp.json();
			setDriveConnected(connData.success === true);

			if (!connData.success) {
				setVideoError(connData.message || 'Failed to connect to Google Drive');
				setLoadingVideos(false);
				return;
			}

			// Check render capabilities in background (non-blocking)
			Promise.all([
				fetch('/api/video-editor', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ task: 'test-shotstack' }),
				}).then(r => r.json()).then(d => {
					const connected = d.shotstackConnected === true || d.success === true;
					setShotstackConnected(connected);
				}).catch(() => setShotstackConnected(false)),
				fetch('/api/video-editor', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ task: 'check-ffmpeg' }),
				}).then(r => r.json()).then(d => setFfmpegAvailable(d.ffmpegAvailable === true)).catch(() => setFfmpegAvailable(false)),
			]);

			// Load summary and video list in parallel
			const [summaryResp, videosResp] = await Promise.all([
				fetch('/api/video-editor', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ task: 'folder-summary' }),
				}),
				fetch('/api/video-editor', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ task: 'list-videos' }),
				}),
			]);

			const summaryData = await summaryResp.json();
			const videosData = await videosResp.json();

			if (summaryData.success && summaryData.summary) {
				setSummary(summaryData.summary);
			}

			if (videosData.success && videosData.videos) {
				setVideos(videosData.videos);

				// Auto-detect uncataloged videos
				const uncataloged = (videosData.videos as DriveVideo[]).filter(
					(v) => !v.description && (!v.suspectedLocation || v.suspectedLocation === 'Unknown' || v.suspectedLocation === 'unknown')
				);
				if (uncataloged.length > 0) {
					setUncatalogedCount(uncataloged.length);
					setAutoCatalogDetected(true);
				} else {
					setUncatalogedCount(0);
					setAutoCatalogDetected(false);
				}
			}
		} catch (err) {
			setVideoError(err instanceof Error ? err.message : 'Failed to load videos');
			setDriveConnected(false);
		} finally {
			setLoadingVideos(false);
		}
	}, []);

	// --- Handlers ---

	const toggleVideo = useCallback((id: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}, []);

	const togglePlatform = useCallback((id: string) => {
		setEnabledPlatforms((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}, []);

	const handleGenerate = useCallback(async () => {
		if (!topic.trim()) return;
		setGenerating(true);
		setGenError(null);
		setEditPlan(null);
		setEditPlanData(null);

		try {
			const response = await fetch('/api/video-editor', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					task: 'edit',
					videoIds: Array.from(selectedIds),
					topic: topic.trim(),
					purpose,
					editMode: selectedMode,
					platforms: Array.from(enabledPlatforms),
				}),
			});

			if (!response.ok) {
				throw new Error('Failed to generate edit plan');
			}

			const data: EditPlanResult = await response.json();

			if (data.success && data.editPlan) {
				setEditPlan(data.editPlan);
				setEditPlanData(data.editPlanData || null);
			} else {
				setGenError(data.message || 'No edit plan was generated');
			}
		} catch (err) {
			setGenError(err instanceof Error ? err.message : 'Something went wrong');
		} finally {
			setGenerating(false);
		}
	}, [selectedIds, topic, purpose, selectedMode, enabledPlatforms]);

	const handleCopyPlan = useCallback(() => {
		if (editPlan) {
			navigator.clipboard?.writeText(editPlan);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	}, [editPlan]);

	const handleReset = useCallback(() => {
		setEditPlan(null);
		setEditPlanData(null);
		setGenError(null);
		setTopic('');
		setSelectedIds(new Set());
		setSelectedMode('auto');
		setRenderJobs([]);
	}, []);

	// --- Render handlers ---

	// Ref to hold latest triggerReview so pollRenderStatus can call it stably
	const triggerReviewRef = useRef<(downloadUrl: string, platform: string, mode: string) => void>(() => {});

	const pollRenderStatus = useCallback(async (
		renderId: string,
		platform: string,
		renderMeta?: { mode: string; topic: string; clipCount: number; editPlanSummary?: string },
	) => {
		const pollInterval = 5000;
		const maxAttempts = 120; // 10 minutes max
		let attempts = 0;

		const poll = async () => {
			attempts++;
			if (attempts > maxAttempts) {
				setRenderJobs(prev => prev.map(j =>
					j.platform === platform && j.renderId === renderId
						? { ...j, status: 'failed' as const, error: 'Timed out waiting for render' }
						: j
				));
				return;
			}

			try {
				const resp = await fetch('/api/video-editor', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ task: 'render-status', renderId }),
				});
				const data = await resp.json();

				if (data.success) {
					const newStatus = data.renderStatus as RenderJob['status'];
					setRenderJobs(prev => prev.map(j =>
						j.platform === platform && j.renderId === renderId
							? { ...j, status: newStatus, downloadUrl: data.downloadUrl, error: data.error }
							: j
					));

					// Auto-save to video library when render completes
					if (newStatus === 'done' && data.downloadUrl && renderMeta) {
						try {
							await fetch('/api/video-library', {
								method: 'POST',
								headers: { 'Content-Type': 'application/json' },
								body: JSON.stringify({
									id: `vl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
									createdAt: new Date().toISOString(),
									renderId,
									downloadUrl: data.downloadUrl,
									platform,
									renderMode: renderMeta.mode,
									topic: renderMeta.topic,
									clipCount: renderMeta.clipCount,
									editPlanSummary: renderMeta.editPlanSummary,
								}),
							});
						} catch {
							// best-effort save — don't block the UI
						}

						// Auto-trigger AI review of the rendered video
						triggerReviewRef.current(data.downloadUrl, platform, renderMeta.mode);
					}

					if (newStatus !== 'done' && newStatus !== 'failed') {
						setTimeout(poll, pollInterval);
					}
				} else {
					setTimeout(poll, pollInterval);
				}
			} catch {
				setTimeout(poll, pollInterval);
			}
		};

		setTimeout(poll, pollInterval);
	}, []);

	// --- AI Review ---

	const triggerReview = useCallback(async (downloadUrl: string, platform: string, mode: string) => {
		// Get the edit plan that was actually used for this render (stored on the job)
		let planForReview: any = null;
		setRenderJobs(prev => {
			const job = prev.find(j => j.platform === platform && j.method === 'shotstack' && j.status === 'done');
			planForReview = job?.usedEditPlan || editPlanData || null;
			return prev.map(j =>
				j.platform === platform && j.method === 'shotstack' && j.status === 'done'
					? { ...j, reviewStatus: 'reviewing' as const }
					: j
			);
		});

		try {
			const resp = await fetch('/api/video-editor', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					task: 'review-render',
					reviewUrl: downloadUrl,
					platform,
					editMode: mode,
					originalEditPlan: planForReview,
					autoRevise: true,
				}),
			});

			const data = await resp.json();

			if (data.success && data.review) {
				setRenderJobs(prev => prev.map(j =>
					j.platform === platform && j.method === 'shotstack' && j.reviewStatus === 'reviewing'
						? {
							...j,
							reviewStatus: 'done' as const,
							review: data.review as VideoReview,
							revisedEditPlan: data.revisedEditPlanData || null,
						}
						: j
				));
			} else {
				setRenderJobs(prev => prev.map(j =>
					j.platform === platform && j.method === 'shotstack' && j.reviewStatus === 'reviewing'
						? { ...j, reviewStatus: 'failed' as const, reviewError: data.error || 'Review failed' }
						: j
				));
			}
		} catch (err) {
			setRenderJobs(prev => prev.map(j =>
				j.platform === platform && j.method === 'shotstack' && j.reviewStatus === 'reviewing'
					? { ...j, reviewStatus: 'failed' as const, reviewError: err instanceof Error ? err.message : 'Network error' }
					: j
			));
		}
	}, [editPlanData]);

	// Keep the ref in sync with the latest triggerReview
	triggerReviewRef.current = triggerReview;

	const handleRenderPlatform = useCallback(async (platform: string, method: 'shotstack' | 'ffmpeg') => {
		// Capture the current edit plan at the moment of render submission
		const currentEditPlan = editPlanData;

		// Add or update job entry — store which plan was used
		setRenderJobs(prev => {
			const existing = prev.find(j => j.platform === platform && j.method === method);
			if (existing) {
				return prev.map(j =>
					j.platform === platform && j.method === method
						? { ...j, status: 'submitting' as const, error: undefined, downloadUrl: undefined, renderId: undefined, usedEditPlan: currentEditPlan }
						: j
				);
			}
			return [...prev, { platform, method, status: 'submitting' as const, usedEditPlan: currentEditPlan }];
		});

		const taskType = method === 'ffmpeg' ? 'render-local' : 'render';

		try {
			const resp = await fetch('/api/video-editor', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					task: taskType,
					videoIds: Array.from(selectedIds),
					editPlan: editPlanData || null,
					platform,
					editMode: selectedMode === 'auto' ? 'game_day' : selectedMode,
					// Music: pass custom URL if provided, disable if user turned off
					musicUrl: musicEnabled ? (customMusicUrl.trim() || undefined) : undefined,
					musicDisabled: !musicEnabled,
				}),
			});

			const data = await resp.json();

			if (data.success) {
				const renderMeta = {
					mode: selectedMode === 'auto' ? 'game_day' : selectedMode,
					topic,
					clipCount: Array.isArray(editPlanData?.clips) ? editPlanData.clips.length : 0,
					editPlanSummary: editPlan ? editPlan.slice(0, 200) : undefined,
				};

				// Helper to save completed render to video library
				const saveToLibrary = async (dlUrl: string, rId?: string) => {
					try {
						await fetch('/api/video-library', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								id: `vl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
								createdAt: new Date().toISOString(),
								renderId: rId || `local_${Date.now()}`,
								downloadUrl: dlUrl,
								platform,
								renderMode: renderMeta.mode,
								topic: renderMeta.topic,
								clipCount: renderMeta.clipCount,
								editPlanSummary: renderMeta.editPlanSummary,
							}),
						});
					} catch {
						// best-effort save
					}
				};

				if (method === 'ffmpeg') {
					// FFmpeg renders complete synchronously
					setRenderJobs(prev => prev.map(j =>
						j.platform === platform && j.method === method
							? { ...j, status: 'done' as const, localOutputPath: data.localOutputPath }
							: j
					));
					// Save local render to library
					if (data.localOutputPath) {
						saveToLibrary(`/api/video-editor/download?path=${encodeURIComponent(data.localOutputPath)}`);
					}
				} else {
					// Shotstack render - may already be done or needs polling
					if (data.downloadUrl) {
						setRenderJobs(prev => prev.map(j =>
							j.platform === platform && j.method === method
								? { ...j, status: 'done' as const, renderId: data.renderId, downloadUrl: data.downloadUrl }
								: j
						));
						// Immediately done — save to library now
						saveToLibrary(data.downloadUrl, data.renderId);
						// Auto-trigger AI review
						triggerReviewRef.current(data.downloadUrl, platform, renderMeta.mode);
					} else if (data.renderId) {
						setRenderJobs(prev => prev.map(j =>
							j.platform === platform && j.method === method
								? { ...j, status: 'queued' as const, renderId: data.renderId }
								: j
						));
						pollRenderStatus(data.renderId, platform, renderMeta);
					}
				}
			} else {
				setRenderJobs(prev => prev.map(j =>
					j.platform === platform && j.method === method
						? { ...j, status: 'failed' as const, error: data.error || data.message || 'Render failed' }
						: j
				));
			}
		} catch (err) {
			const errorMsg = method === 'ffmpeg'
				? 'Request timed out. Local render may take too long for cloud deployment. Try cloud render instead.'
				: (err instanceof Error ? err.message : 'Network error');
			setRenderJobs(prev => prev.map(j =>
				j.platform === platform && j.method === method
					? { ...j, status: 'failed' as const, error: errorMsg }
					: j
			));
		}
	}, [selectedIds, selectedMode, editPlan, editPlanData, topic, pollRenderStatus, triggerReview]);

	const handleReviseAndRerender = useCallback(async (platform: string) => {
		// Find the job with a revised edit plan
		const job = renderJobs.find(j => j.platform === platform && j.method === 'shotstack' && j.revisedEditPlan);
		if (!job?.revisedEditPlan) return;

		// Enforce revision cap
		const currentRevision = job.revisionCount || 0;
		if (currentRevision >= 2) return;

		// Swap the edit plan data to the revised version
		setEditPlanData(job.revisedEditPlan);

		// Track the current score and preserve original download URL
		const currentScore = job.review?.overallScore;
		const prevScores = [...(job.previousScores || [])];
		if (currentScore !== undefined) {
			prevScores.push(currentScore);
		}
		const origUrl = job.originalDownloadUrl || job.downloadUrl;

		// Clear the old review state and reset render status — store revised plan as the one being used
		setRenderJobs(prev => prev.map(j =>
			j.platform === platform && j.method === 'shotstack'
				? {
					...j,
					status: 'submitting' as const,
					review: null,
					reviewStatus: 'idle' as const,
					revisedEditPlan: undefined,
					reviewError: undefined,
					downloadUrl: undefined,
					error: undefined,
					renderId: undefined,
					usedEditPlan: job.revisedEditPlan,
					revisionCount: currentRevision + 1,
					previousScores: prevScores,
					originalDownloadUrl: origUrl,
				}
				: j
		));

		// Re-submit the render with the revised edit plan
		try {
			const resp = await fetch('/api/video-editor', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					task: 'render',
					videoIds: Array.from(selectedIds),
					editPlan: job.revisedEditPlan,
					platform,
					editMode: selectedMode === 'auto' ? 'game_day' : selectedMode,
					musicUrl: musicEnabled ? (customMusicUrl.trim() || undefined) : undefined,
					musicDisabled: !musicEnabled,
				}),
			});

			const data = await resp.json();

			if (data.success && data.renderId) {
				const renderMeta = {
					mode: selectedMode === 'auto' ? 'game_day' : selectedMode,
					topic,
					clipCount: Array.isArray(job.revisedEditPlan.clips) ? job.revisedEditPlan.clips.length : 0,
					editPlanSummary: 'Revised edit plan from AI review',
				};

				setRenderJobs(prev => prev.map(j =>
					j.platform === platform && j.method === 'shotstack'
						? { ...j, status: 'queued' as const, renderId: data.renderId }
						: j
				));

				pollRenderStatus(data.renderId, platform, renderMeta);
			} else {
				setRenderJobs(prev => prev.map(j =>
					j.platform === platform && j.method === 'shotstack'
						? { ...j, status: 'failed' as const, error: data.error || 'Re-render failed' }
						: j
				));
			}
		} catch (err) {
			setRenderJobs(prev => prev.map(j =>
				j.platform === platform && j.method === 'shotstack'
					? { ...j, status: 'failed' as const, error: err instanceof Error ? err.message : 'Network error' }
					: j
			));
		}
	}, [renderJobs, selectedIds, selectedMode, topic, musicEnabled, customMusicUrl, pollRenderStatus]);

	const handleRenderAll = useCallback(async (method: 'shotstack' | 'ffmpeg') => {
		setRenderingAll(true);
		const platforms = Array.from(enabledPlatforms);

		for (const platform of platforms) {
			await handleRenderPlatform(platform, method);
		}

		setRenderingAll(false);
	}, [enabledPlatforms, handleRenderPlatform]);

	// --- Download handler for local renders ---

	const [downloadingRender, setDownloadingRender] = useState<string | null>(null);

	const handleDownloadRender = useCallback(async (filePath: string, filename: string) => {
		setDownloadingRender(filePath);
		try {
			const response = await fetch('/api/video-editor', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					task: 'download-render',
					filePath: filePath,
				}),
			});
			const data = await response.json();

			if (data.success && data.base64Data) {
				const byteCharacters = atob(data.base64Data);
				const byteNumbers = new Array(byteCharacters.length);
				for (let i = 0; i < byteCharacters.length; i++) {
					byteNumbers[i] = byteCharacters.charCodeAt(i);
				}
				const byteArray = new Uint8Array(byteNumbers);
				const blob = new Blob([byteArray], { type: data.mimeType || 'video/mp4' });

				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = data.filename || filename || 'render.mp4';
				document.body.appendChild(a);
				a.click();
				document.body.removeChild(a);
				URL.revokeObjectURL(url);
			} else {
				console.error('[VideoEditor] Download failed:', data.error);
			}
		} catch (err) {
			console.error('[VideoEditor] Download error:', err);
		} finally {
			setDownloadingRender(null);
		}
	}, []);

	// --- Catalog handlers ---

	const handleRunFullCatalog = useCallback(async () => {
		setCatalogRunning(true);
		setCatalogError(null);
		setCatalogProgress({ total: videos.length || 247, completed: 0, failed: 0 });

		try {
			const response = await fetch('/api/video-editor', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					task: 'catalog',
					catalogAction: 'run-full',
					batchSize: 10,
				}),
			});

			if (!response.ok) {
				throw new Error(`Catalog request failed (${response.status})`);
			}

			const data = await response.json();

			if (data.success) {
				setCatalogProgress({
					total: data.progress?.total || 0,
					completed: data.progress?.completed || 0,
					failed: data.progress?.failed || 0,
				});
				// Reload videos to get enriched data (will re-evaluate uncataloged count)
				setAutoCatalogDetected(false);
				setUncatalogedCount(0);
				await loadVideos();
			} else {
				setCatalogError(data.message || 'Catalog failed');
			}
		} catch (err) {
			setCatalogError(err instanceof Error ? err.message : 'Catalog request failed');
		} finally {
			setCatalogRunning(false);
		}
	}, [videos.length, loadVideos]);

	// Refresh thumbnails for videos that are missing previews
	const handleRefreshThumbnails = useCallback(async () => {
		const missingIds = videos
			.filter(v => !v.thumbnail)
			.map(v => v.id);

		if (missingIds.length === 0) {
			setThumbnailRefreshResult('All videos already have thumbnails');
			setTimeout(() => setThumbnailRefreshResult(null), 3000);
			return;
		}

		setRefreshingThumbnails(true);
		setThumbnailRefreshResult(null);

		try {
			const resp = await fetch('/api/video-editor', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					task: 'fetch-missing-thumbnails',
					videoIds: missingIds,
				}),
			});
			const data = await resp.json();

			if (data.success && data.results) {
				// Update videos in state with newly fetched thumbnails
				const thumbMap = new Map<string, string>();
				for (const r of data.results) {
					if (r.thumbnail) thumbMap.set(r.videoId, r.thumbnail);
				}
				if (thumbMap.size > 0) {
					setVideos(prev => prev.map(v =>
						thumbMap.has(v.id) ? { ...v, thumbnail: thumbMap.get(v.id) } : v
					));
				}
				setThumbnailRefreshResult(`Found ${data.found} of ${data.total} thumbnails`);
			} else {
				setThumbnailRefreshResult(data.message || 'Failed to fetch thumbnails');
			}
		} catch {
			setThumbnailRefreshResult('Network error — try again');
		} finally {
			setRefreshingThumbnails(false);
			setTimeout(() => setThumbnailRefreshResult(null), 5000);
		}
	}, [videos]);

	const handleAnalyzeSingle = useCallback(async (videoId: string) => {
		setAnalyzingSingle(videoId);
		setCatalogError(null);

		try {
			const response = await fetch('/api/video-editor', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					task: 'catalog',
					catalogAction: 'analyze-single',
					videoId,
				}),
			});

			if (!response.ok) {
				throw new Error(`Analysis failed (${response.status})`);
			}

			const data = await response.json();

			if (data.success && data.catalog?.length > 0) {
				// Reload to get fresh enriched data
				await loadVideos();
			} else {
				setCatalogError(data.message || 'Analysis returned no results');
			}
		} catch (err) {
			setCatalogError(err instanceof Error ? err.message : 'Analysis failed');
		} finally {
			setAnalyzingSingle(null);
		}
	}, [loadVideos]);

	// --- Catalog entry update handler ---

	const [updatingEntry, setUpdatingEntry] = useState<string | null>(null);

	const handleUpdateCatalogEntry = useCallback(async (
		videoId: string,
		field: 'location' | 'contentType',
		value: string,
	) => {
		setUpdatingEntry(videoId);

		// Optimistic update - immediately reflect in UI
		setVideos((prev) =>
			prev.map((v) => {
				if (v.id !== videoId) return v;
				if (field === 'location') {
					return {
						...v,
						suspectedLocation: value,
						locationConfidence: 'high',
						needsManualReview: false,
					};
				}
				return {
					...v,
					contentType: value,
					needsManualReview: false,
				};
			}),
		);

		try {
			const response = await fetch('/api/video-editor', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					task: 'catalog',
					catalogAction: 'update-entry',
					videoId,
					catalogData: [{
						fileId: videoId,
						suspectedLocation: field === 'location' ? value : '',
						contentType: field === 'contentType' ? value : '',
						activity: '',
					}],
				}),
			});

			if (!response.ok) {
				throw new Error(`Update failed (${response.status})`);
			}

			const data = await response.json();
			if (!data.success) {
				console.error('[VideoEditor] Catalog update failed:', data.message);
				// Revert optimistic update by reloading
				await loadVideos();
			}
		} catch (err) {
			console.error('[VideoEditor] Failed to update catalog entry:', err);
			// Revert optimistic update by reloading
			await loadVideos();
		} finally {
			setUpdatingEntry(null);
		}
	}, [loadVideos]);

	// --- Filtered and sorted videos ---

	const filteredVideos = useMemo(() => {
		let result = videos;

		// Text search across description, name, readableText, location
		if (searchQuery.trim()) {
			const q = searchQuery.toLowerCase();
			result = result.filter((v) =>
				v.name.toLowerCase().includes(q) ||
				v.description.toLowerCase().includes(q) ||
				v.readableText.toLowerCase().includes(q) ||
				v.suspectedLocation.toLowerCase().includes(q) ||
				v.notableMoments.toLowerCase().includes(q)
			);
		}

		// Location filter
		if (filterLocation) {
			if (filterLocation === 'Unknown') {
				result = result.filter((v) =>
					v.suspectedLocation === 'Unknown' || v.suspectedLocation === 'unknown' || !v.suspectedLocation
				);
			} else {
				result = result.filter((v) => v.suspectedLocation === filterLocation);
			}
		}

		// Content type filter
		if (filterContentType) {
			result = result.filter((v) => v.contentType === filterContentType);
		}

		// Quality filter
		if (filterQuality) {
			if (filterQuality === 'good+') {
				result = result.filter((v) => v.quality === 'excellent' || v.quality === 'good');
			} else if (filterQuality === 'fair+') {
				result = result.filter((v) => v.quality === 'excellent' || v.quality === 'good' || v.quality === 'fair');
			} else {
				result = result.filter((v) => v.quality === filterQuality);
			}
		}

		// Sort
		const dir = sortDirection === 'desc' ? -1 : 1;
		result = [...result].sort((a, b) => {
			let cmp = 0;
			switch (sortBy) {
				case 'location':
					cmp = a.suspectedLocation.localeCompare(b.suspectedLocation);
					break;
				case 'contentType':
					cmp = a.contentType.localeCompare(b.contentType);
					break;
				case 'duration':
					cmp = parseDurationSeconds(a.duration) - parseDurationSeconds(b.duration);
					break;
				case 'quality':
					cmp = getQualityOrder(a.quality) - getQualityOrder(b.quality);
					break;
				default:
					cmp = a.name.localeCompare(b.name);
			}
			return cmp * dir;
		});

		return result;
	}, [videos, searchQuery, filterLocation, filterContentType, filterQuality, sortBy, sortDirection]);

	// --- Selected videos for smart suggestions ---

	const selectedVideos = useMemo(
		() => videos.filter((v) => selectedIds.has(v.id)),
		[videos, selectedIds],
	);

	const modeSuggestion = useMemo(() => getModeSuggestion(selectedVideos), [selectedVideos]);
	const topicSuggestion = useMemo(() => getTopicSuggestion(selectedVideos), [selectedVideos]);

	const poorQualityClips = useMemo(
		() => selectedVideos.filter((v) => v.quality === 'poor'),
		[selectedVideos],
	);

	const selectedLocations = useMemo(() => {
		const locs = new Set(selectedVideos.map((v) => v.suspectedLocation).filter(Boolean));
		locs.delete('Unknown');
		locs.delete('unknown');
		return locs;
	}, [selectedVideos]);

	// --- Render ---

	return (
		<div style={{
			minHeight: '100vh',
			background: S.bg,
			color: S.textPrimary,
			fontFamily: S.serif,
		}}>
			{/* Header */}
			<header style={{
				padding: '20px 28px',
				borderBottom: `1px solid ${S.borderColor}`,
				display: 'flex',
				justifyContent: 'space-between',
				alignItems: 'center',
			}}>
				<div>
					<button
						onClick={onBack}
						style={{
							background: 'none',
							border: 'none',
							color: S.textMuted,
							cursor: 'pointer',
							fontFamily: S.mono,
							fontSize: 11,
							marginBottom: 6,
							letterSpacing: 0.5,
							padding: 0,
						}}
						type="button"
					>
						&larr; Back to Content Studio
					</button>
					<h1 style={{
						fontSize: 20,
						fontWeight: 700,
						letterSpacing: '-0.02em',
						color: '#ffffff',
					}}>
						Video Editor
					</h1>
					<p style={{
						fontFamily: S.mono,
						fontSize: 10,
						color: S.textMuted,
						marginTop: 2,
						letterSpacing: 0.5,
					}}>
						Google Drive footage library + AI edit plans + cloud rendering
					</p>
				</div>
				<StatusBadge connected={driveConnected} />
			</header>

			{/* Three-panel layout */}
			<div style={{
				display: 'grid',
				gridTemplateColumns: '380px 1fr 400px',
				height: 'calc(100vh - 96px)',
				overflow: 'hidden',
			}}>

				{/* LEFT PANEL: Video Library */}
				<div style={{
					borderRight: `1px solid ${S.borderColor}`,
					display: 'flex',
					flexDirection: 'column',
					overflow: 'hidden',
				}}>
					{/* Library header */}
					<div style={{ padding: '12px 14px 10px', borderBottom: `1px solid ${S.borderColor}` }}>
						<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
							<Label>Video Library</Label>
							<button
								onClick={loadVideos}
								disabled={loadingVideos}
								style={{
									padding: '4px 10px',
									borderRadius: 4,
									border: `1px solid ${S.borderColor}`,
									background: 'transparent',
									color: S.textMuted,
									cursor: loadingVideos ? 'not-allowed' : 'pointer',
									fontFamily: S.mono,
									fontSize: 9,
									letterSpacing: 0.5,
								}}
								type="button"
							>
								{loadingVideos ? 'Loading...' : 'Refresh'}
							</button>
						</div>

						{/* Summary stats bar */}
						{summary && (
							<div style={{
								marginBottom: 8,
								padding: '8px 10px',
								borderRadius: 6,
								background: S.cardBg,
								border: `1px solid ${S.borderColor}`,
							}}>
								<div style={{
									display: 'flex',
									gap: 10,
									marginBottom: 6,
									fontFamily: S.mono,
									fontSize: 10,
								}}>
									<span style={{ color: S.accentLight }}>{summary.totalFiles} videos</span>
									<span style={{ color: S.textMuted }}>|</span>
									<span style={{ color: S.orange }}>{summary.totalSizeGB} GB</span>
								</div>

								{/* Location breakdown */}
								{catalogSummary && (
									<div style={{ fontFamily: S.mono, fontSize: 9, color: S.textMuted, lineHeight: 1.6 }}>
										<div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 8px' }}>
											{Object.entries(catalogSummary.byLocation)
												.sort((a, b) => b[1] - a[1])
												.map(([loc, count]) => (
													<span key={loc}>
														<span style={{ color: (LOCATION_COLORS[loc] ?? LOCATION_COLORS['Unknown'] ?? { text: '#999' }).text }}>
															{count}
														</span>
														{' '}{loc}
													</span>
												))}
										</div>
										<div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 8px', marginTop: 2 }}>
											{Object.entries(catalogSummary.byContentType)
												.sort((a, b) => b[1] - a[1])
												.map(([ct, count]) => (
													<span key={ct}>
														<span style={{ color: (CONTENT_TYPE_COLORS[ct] ?? CONTENT_TYPE_COLORS['unknown'] ?? { text: '#999' }).text }}>
															{count}
														</span>
														{' '}{CONTENT_TYPE_LABELS[ct] ?? ct}
													</span>
												))}
										</div>
									</div>
								)}
							</div>
						)}

						{/* Search */}
						<input
							type="text"
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							placeholder="Search descriptions, text, locations..."
							style={{
								width: '100%',
								padding: '7px 10px',
								borderRadius: 6,
								border: `1px solid ${S.borderColor}`,
								background: S.bg,
								color: S.textPrimary,
								fontSize: 11,
								fontFamily: S.mono,
								outline: 'none',
								marginBottom: 8,
							}}
						/>

						{/* Filter controls */}
						<div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
							{/* Location filters */}
							<div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
								<FilterButton
									label="All Locations"
									active={filterLocation === null}
									onClick={() => setFilterLocation(null)}
								/>
								{ALL_LOCATIONS.map((loc) => (
									<FilterButton
										key={loc}
										label={loc}
										active={filterLocation === loc}
										onClick={() => setFilterLocation(filterLocation === loc ? null : loc)}
									/>
								))}
							</div>

							{/* Content type filters */}
							<div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
								<FilterButton
									label="All Types"
									active={filterContentType === null}
									onClick={() => setFilterContentType(null)}
								/>
								{ALL_CONTENT_TYPES.map((ct) => (
									<FilterButton
										key={ct}
										label={CONTENT_TYPE_LABELS[ct] || ct}
										active={filterContentType === ct}
										onClick={() => setFilterContentType(filterContentType === ct ? null : ct)}
									/>
								))}
							</div>

							{/* Quality + Sort */}
							<div style={{ display: 'flex', gap: 3, alignItems: 'center', flexWrap: 'wrap' }}>
								<FilterButton
									label="All Quality"
									active={filterQuality === null}
									onClick={() => setFilterQuality(null)}
								/>
								<FilterButton
									label="Good+"
									active={filterQuality === 'good+'}
									onClick={() => setFilterQuality(filterQuality === 'good+' ? null : 'good+')}
								/>
								<FilterButton
									label="Fair+"
									active={filterQuality === 'fair+'}
									onClick={() => setFilterQuality(filterQuality === 'fair+' ? null : 'fair+')}
								/>
								<FilterButton
									label="Poor"
									active={filterQuality === 'poor'}
									onClick={() => setFilterQuality(filterQuality === 'poor' ? null : 'poor')}
								/>

								<span style={{ fontFamily: S.mono, fontSize: 8, color: S.textMuted, margin: '0 2px' }}>|</span>

								<span style={{ fontFamily: S.mono, fontSize: 8, color: S.textMuted }}>Sort:</span>
								{(['name', 'location', 'contentType', 'duration', 'quality'] as SortKey[]).map((key) => {
									const baseLabel = key === 'contentType' ? 'Type' : key.charAt(0).toUpperCase() + key.slice(1);
									const dirIndicator = sortBy === key ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : '';
									return (
										<FilterButton
											key={key}
											label={`${baseLabel}${dirIndicator}`}
											active={sortBy === key}
											onClick={() => {
												if (sortBy === key) {
													setSortDirection((prev) => prev === 'asc' ? 'desc' : 'asc');
												} else {
													setSortBy(key);
													setSortDirection('asc');
												}
											}}
										/>
									);
								})}
							</div>
						</div>

						{/* Selection + results count */}
						<div style={{
							display: 'flex',
							justifyContent: 'space-between',
							marginTop: 8,
							fontFamily: S.mono,
							fontSize: 9,
						}}>
							<span style={{ color: S.textMuted }}>
								{filteredVideos.length} of {videos.length} shown
							</span>
							{selectedIds.size > 0 && (
								<span style={{ color: S.accentLight }}>
									{selectedIds.size} selected
								</span>
							)}
						</div>
					</div>

					{/* Video list */}
					<div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
						{loadingVideos && (
							<div style={{ padding: 20, textAlign: 'center', color: S.textMuted, fontFamily: S.mono, fontSize: 11 }}>
								Loading videos from Google Drive...
							</div>
						)}

						{videoError && (
							<div style={{ padding: 16, color: S.red, fontFamily: S.mono, fontSize: 11 }}>
								{videoError}
							</div>
						)}

						{!loadingVideos && !videoError && filteredVideos.length === 0 && (
							<div style={{ padding: 20, textAlign: 'center', color: S.textMuted, fontFamily: S.mono, fontSize: 11 }}>
								{searchQuery || filterLocation || filterContentType || filterQuality
									? 'No matching videos'
									: 'No videos found'}
							</div>
						)}

						{/* Auto-catalog notification banner */}
						{autoCatalogDetected && uncatalogedCount > 0 && !autoCatalogDismissed && (
							<div style={{
								margin: '0 10px 8px',
								padding: '10px 12px',
								borderRadius: 6,
								background: '#1a2332',
								border: `1px solid ${S.orange}40`,
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'space-between',
								gap: 8,
							}}>
								<div>
									<div style={{
										fontFamily: S.mono,
										fontSize: 10,
										color: S.orange,
										fontWeight: 700,
										marginBottom: 2,
									}}>
										{uncatalogedCount} new video{uncatalogedCount !== 1 ? 's' : ''} detected
									</div>
									<div style={{
										fontFamily: S.mono,
										fontSize: 9,
										color: S.textMuted,
									}}>
										{catalogRunning
											? 'Auto-cataloging in progress...'
											: 'Auto-cataloging will begin shortly...'}
									</div>
								</div>
								{!catalogRunning && (
									<button
										onClick={(e) => { e.stopPropagation(); setAutoCatalogDismissed(true); }}
										style={{
											padding: '4px 8px',
											borderRadius: 4,
											border: `1px solid ${S.borderColor}`,
											background: 'transparent',
											color: S.textMuted,
											cursor: 'pointer',
											fontFamily: S.mono,
											fontSize: 9,
											flexShrink: 0,
										}}
										type="button"
									>
										Dismiss
									</button>
								)}
							</div>
						)}

						{filteredVideos.map((video) => {
							const isSelected = selectedIds.has(video.id);
							const hasCatalog = video.description || (video.suspectedLocation && video.suspectedLocation !== 'Unknown');

							return (
								<button
									key={video.id}
									onClick={() => toggleVideo(video.id)}
									onMouseEnter={() => setHoveredVideoId(video.id)}
									onMouseLeave={() => setHoveredVideoId(null)}
									style={{
										width: '100%',
										padding: '8px 12px',
										background: isSelected ? '#2D6A4F12' : 'transparent',
										border: 'none',
										borderBottom: `1px solid ${S.borderColor}`,
										borderLeft: isSelected ? '3px solid #2D6A4F' : '3px solid transparent',
										cursor: 'pointer',
										textAlign: 'left',
										transition: 'all 0.15s',
										display: 'flex',
										gap: 8,
										position: 'relative',
									}}
									type="button"
								>
									{/* Checkbox */}
									<div style={{
										width: 14,
										height: 14,
										borderRadius: 3,
										border: `1px solid ${isSelected ? S.accent : S.borderColor}`,
										background: isSelected ? S.accent : 'transparent',
										display: 'flex',
										alignItems: 'center',
										justifyContent: 'center',
										flexShrink: 0,
										marginTop: 2,
									}}>
										{isSelected && (
											<span style={{ color: '#fff', fontSize: 9, lineHeight: 1 }}>&#10003;</span>
										)}
									</div>

									{/* Thumbnail — always reserve space; show placeholder when missing */}
									<div style={{
										width: 56,
										height: 42,
										borderRadius: 4,
										overflow: 'hidden',
										flexShrink: 0,
										background: '#0d1017',
										border: `1px solid ${S.borderColor}`,
										position: 'relative',
									}}>
										{/* Fallback placeholder — always rendered underneath, visible when no thumbnail or image fails */}
										<div style={{
											position: 'absolute',
											inset: 0,
											display: 'flex',
											flexDirection: 'column',
											alignItems: 'center',
											justifyContent: 'center',
											zIndex: 0,
										}}>
											<svg width="18" height="14" viewBox="0 0 24 20" fill="none" style={{ opacity: 0.35 }}>
												<rect x="1" y="3" width="16" height="14" rx="2" stroke="#4a5578" strokeWidth="1.5" fill="none" />
												<path d="M17 8l5-3v10l-5-3V8z" stroke="#4a5578" strokeWidth="1.5" fill="none" />
											</svg>
											{!video.thumbnail && (
												<span style={{
													fontFamily: S.mono,
													fontSize: 6,
													color: '#4a5578',
													marginTop: 1,
													letterSpacing: 0.3,
												}}>
													NO PREVIEW
												</span>
											)}
										</div>
										{/* Actual thumbnail image sits above the placeholder */}
										{video.thumbnail && (
											<img
												src={video.thumbnail}
												alt=""
												loading="lazy"
												style={{
													position: 'absolute',
													inset: 0,
													width: '100%',
													height: '100%',
													objectFit: 'cover',
													display: 'block',
													zIndex: 1,
												}}
												onError={(e) => {
													// Remove broken image to reveal the placeholder underneath
													(e.currentTarget as HTMLImageElement).remove();
												}}
											/>
										)}
									</div>
									{/* Hover preview: enlarged thumbnail tooltip — outside overflow:hidden container */}
									{video.thumbnail && hoveredVideoId === video.id && (
										<div
											style={{
												position: 'absolute',
												top: -10,
												left: 90,
												zIndex: 200,
												width: 280,
												borderRadius: 8,
												overflow: 'hidden',
												boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
												border: `1px solid ${S.borderColor}`,
												background: S.cardBg,
												pointerEvents: 'none',
											}}
										>
											<img
												src={video.thumbnail.replace(/=s\d+$/, '=s400')}
												alt={video.name}
												style={{
													width: '100%',
													height: 'auto',
													display: 'block',
												}}
											/>
											<div style={{
												padding: '6px 10px',
												fontFamily: S.mono,
												fontSize: 9,
												color: S.textMuted,
												background: '#0d1017',
											}}>
												{video.name}
											</div>
										</div>
									)}

									{/* Rich card content */}
									<div style={{ flex: 1, minWidth: 0 }}>
										{/* Row 1: Location + Content Type badges (editable) */}
										<div style={{ display: 'flex', gap: 4, marginBottom: 3, flexWrap: 'wrap' }}>
											<LocationBadge
												location={video.suspectedLocation}
												needsReview={video.needsManualReview}
												editable={true}
												videoId={video.id}
												onUpdate={handleUpdateCatalogEntry}
											/>
											<ContentTypeBadge
												type={video.contentType}
												editable={true}
												videoId={video.id}
												onUpdate={handleUpdateCatalogEntry}
											/>
											{updatingEntry === video.id && (
												<span style={{
													fontFamily: S.mono,
													fontSize: 7,
													color: S.accentLight,
													alignSelf: 'center',
												}}>
													saving...
												</span>
											)}
										</div>

										{/* Row 2: Description */}
										<div style={{
											fontFamily: S.serif,
											fontSize: 11,
											color: isSelected ? '#fff' : (hasCatalog ? S.textPrimary : S.textMuted),
											lineHeight: 1.3,
											whiteSpace: 'nowrap',
											overflow: 'hidden',
											textOverflow: 'ellipsis',
											marginBottom: 2,
										}}>
											{video.description || video.name}
										</div>

										{/* Row 3: Duration | Quality | People */}
										<div style={{
											display: 'flex',
											gap: 6,
											fontFamily: S.mono,
											fontSize: 9,
											color: S.textMuted,
											marginBottom: 1,
										}}>
											{video.duration && <span>{video.duration}</span>}
											{video.duration && video.quality && <span>|</span>}
											{video.quality && video.quality !== 'unknown' && (
												<span style={{
													color: video.quality === 'poor' ? S.red
														: video.quality === 'excellent' ? S.accentLight
														: S.textMuted,
												}}>
													{video.quality}
												</span>
											)}
											{video.peopleCount && <span>|</span>}
											{video.peopleCount && <span>{video.peopleCount} people</span>}
											<span>|</span>
											<span>{video.size}</span>
										</div>

										{/* Row 4: Readable text */}
										{video.readableText && video.readableText !== 'None' && video.readableText !== 'none' && (
											<div style={{
												fontFamily: S.mono,
												fontSize: 8,
												color: '#6b7280',
												whiteSpace: 'nowrap',
												overflow: 'hidden',
												textOverflow: 'ellipsis',
											}}>
												&quot;{video.readableText}&quot;
											</div>
										)}
									</div>

									{/* Analyze single button */}
									<div
										onClick={(e) => {
											e.stopPropagation();
											handleAnalyzeSingle(video.id);
										}}
										style={{
											padding: '3px 6px',
											borderRadius: 3,
											border: `1px solid ${analyzingSingle === video.id ? S.accent : S.borderColor}`,
											background: 'transparent',
											color: analyzingSingle === video.id ? S.accentLight : S.textMuted,
											cursor: analyzingSingle === video.id ? 'not-allowed' : 'pointer',
											fontFamily: S.mono,
											fontSize: 8,
											flexShrink: 0,
											letterSpacing: 0.3,
											alignSelf: 'flex-start',
											marginTop: 2,
										}}
									>
										{analyzingSingle === video.id ? '...' : 'AI'}
									</div>
								</button>
							);
						})}
					</div>
				</div>

				{/* CENTER PANEL: Edit Configuration */}
				<div style={{
					borderRight: `1px solid ${S.borderColor}`,
					overflow: 'auto',
					padding: '20px 24px',
				}}>
					<Label>Edit Configuration</Label>

					{/* Smart suggestions */}
					{selectedIds.size > 0 && (modeSuggestion || topicSuggestion || poorQualityClips.length > 0 || selectedLocations.size > 2) && (
						<div style={{
							marginBottom: 16,
							padding: '10px 12px',
							borderRadius: 8,
							border: `1px solid ${S.borderColor}`,
							background: '#111827',
						}}>
							<div style={{
								fontFamily: S.mono,
								fontSize: 9,
								color: S.textMuted,
								letterSpacing: 1,
								marginBottom: 6,
							}}>
								SMART SUGGESTIONS
							</div>

							{modeSuggestion && selectedMode === 'auto' && (
								<div style={{
									fontFamily: S.mono,
									fontSize: 10,
									color: S.accentLight,
									marginBottom: 4,
									cursor: 'pointer',
								}}
									onClick={() => setSelectedMode(modeSuggestion.mode)}
								>
									Suggested mode: {MODES.find(m => m.id === modeSuggestion.mode)?.label || modeSuggestion.mode}
									<span style={{ color: S.textMuted }}> - {modeSuggestion.reason}</span>
								</div>
							)}

							{topicSuggestion && !topic.trim() && (
								<div style={{
									fontFamily: S.mono,
									fontSize: 10,
									color: '#60a5fa',
									marginBottom: 4,
									cursor: 'pointer',
								}}
									onClick={() => setTopic(topicSuggestion)}
								>
									Suggested topic: {topicSuggestion}
									<span style={{ color: S.textMuted }}> - click to use</span>
								</div>
							)}

							{poorQualityClips.length > 0 && (
								<div style={{
									fontFamily: S.mono,
									fontSize: 10,
									color: S.orange,
									marginBottom: 4,
								}}>
									{poorQualityClips.length} clip{poorQualityClips.length > 1 ? 's' : ''} rated poor quality - consider replacing
								</div>
							)}

							{selectedLocations.size > 2 && (
								<div style={{
									fontFamily: S.mono,
									fontSize: 10,
									color: '#a78bfa',
								}}>
									Clips from {selectedLocations.size} locations - intentional for Our Story montage?
								</div>
							)}
						</div>
					)}

					{/* Mode selector */}
					<div style={{ marginBottom: 20 }}>
						<div style={{
							fontFamily: S.mono,
							fontSize: 10,
							color: S.textMuted,
							marginBottom: 8,
							letterSpacing: 1,
						}}>
							EDITING MODE
						</div>
						<div style={{
							display: 'grid',
							gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
							gap: 8,
						}}>
							{MODES.map((m) => {
								const active = selectedMode === m.id;
								const isSuggested = modeSuggestion?.mode === m.id && selectedMode === 'auto';
								return (
									<button
										key={m.id}
										onClick={() => setSelectedMode(m.id)}
										style={{
											padding: '12px 14px',
											borderRadius: 8,
											border: `1px solid ${active ? S.accent : isSuggested ? '#2D6A4F60' : S.borderColor}`,
											background: active ? '#2D6A4F15' : S.cardBg,
											cursor: 'pointer',
											textAlign: 'left',
											transition: 'all 0.15s',
										}}
										type="button"
									>
										<div style={{
											display: 'flex',
											justifyContent: 'space-between',
											alignItems: 'center',
											marginBottom: 4,
										}}>
											<span style={{
												fontFamily: S.mono,
												fontSize: 11,
												fontWeight: 700,
												color: active ? S.accentLight : '#fff',
											}}>
												{m.label}
											</span>
											<span style={{
												fontFamily: S.mono,
												fontSize: 9,
												padding: '2px 6px',
												borderRadius: 3,
												background: '#1e253860',
												color: S.textMuted,
											}}>
												{m.tier}
											</span>
										</div>
										<div style={{
											fontFamily: S.mono,
											fontSize: 9,
											color: S.textMuted,
											lineHeight: 1.4,
										}}>
											{m.desc}
										</div>
									</button>
								);
							})}
						</div>
					</div>

					{/* Topic */}
					<div style={{ marginBottom: 20 }}>
						<Label>Topic / Purpose</Label>
						<textarea
							value={topic}
							onChange={(e) => setTopic(e.target.value)}
							placeholder={topicSuggestion || 'Saturday tennis clinic highlights, tournament recap, coach interview...'}
							rows={3}
							style={{
								width: '100%',
								padding: '12px 14px',
								borderRadius: 8,
								border: `1px solid ${S.borderColor}`,
								background: S.cardBg,
								color: S.textPrimary,
								fontSize: 13,
								fontFamily: S.serif,
								lineHeight: 1.6,
								resize: 'vertical',
								outline: 'none',
							}}
						/>
					</div>

					{/* Purpose */}
					<div style={{ marginBottom: 20 }}>
						<Label>Content Purpose</Label>
						<select
							value={purpose}
							onChange={(e) => setPurpose(e.target.value)}
							style={{
								width: '100%',
								padding: '10px 14px',
								borderRadius: 8,
								border: `1px solid ${S.borderColor}`,
								background: S.cardBg,
								color: S.textPrimary,
								fontSize: 13,
								fontFamily: S.serif,
								outline: 'none',
								cursor: 'pointer',
							}}
						>
							<option value="social">Social Media</option>
							<option value="donor">Donor Appeal</option>
							<option value="grant">Grant Application</option>
							<option value="tournament-recap">Tournament Recap</option>
							<option value="recruitment">Student Recruitment</option>
							<option value="internal">Internal / Training</option>
						</select>
					</div>

					{/* Platform checkboxes */}
					<div style={{ marginBottom: 20 }}>
						<Label>Target Platforms</Label>
						<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
							{PLATFORMS.map((p) => {
								const enabled = enabledPlatforms.has(p.id);
								return (
									<button
										key={p.id}
										onClick={() => togglePlatform(p.id)}
										style={{
											padding: '6px 12px',
											borderRadius: 6,
											border: `1px solid ${enabled ? S.accent : S.borderColor}`,
											background: enabled ? '#2D6A4F20' : 'transparent',
											color: enabled ? S.accentLight : S.textMuted,
											cursor: 'pointer',
											fontFamily: S.mono,
											fontSize: 10,
											transition: 'all 0.15s',
										}}
										type="button"
									>
										{p.label}
									</button>
								);
							})}
						</div>
					</div>

					{/* Catalog section */}
					<div style={{
						marginBottom: 20,
						padding: '14px 14px',
						borderRadius: 8,
						border: `1px solid ${S.borderColor}`,
						background: S.cardBg,
					}}>
						<Label>Auto-Catalog (AI Vision)</Label>
						<p style={{
							fontFamily: S.mono,
							fontSize: 10,
							color: S.textMuted,
							lineHeight: 1.5,
							marginBottom: 10,
						}}>
							Analyze all videos with GPT-4o vision to identify locations, content types, and quality.
						</p>

						<button
							onClick={handleRunFullCatalog}
							disabled={catalogRunning || !driveConnected}
							style={{
								width: '100%',
								padding: '10px',
								borderRadius: 6,
								border: `1px solid ${catalogRunning ? S.borderColor : S.orange}`,
								background: catalogRunning ? S.borderColor : 'transparent',
								color: catalogRunning ? S.textMuted : S.orange,
								cursor: catalogRunning || !driveConnected ? 'not-allowed' : 'pointer',
								fontFamily: S.mono,
								fontSize: 10,
								fontWeight: 700,
								letterSpacing: 0.5,
								transition: 'all 0.15s',
								marginBottom: 8,
							}}
							type="button"
						>
							{catalogRunning ? 'Cataloging in progress...' : 'Run Full Catalog (All Videos)'}
						</button>

						{/* Refresh Thumbnails button */}
						{(() => {
							const missingCount = videos.filter(v => !v.thumbnail).length;
							return missingCount > 0 || refreshingThumbnails || thumbnailRefreshResult ? (
								<div style={{ marginBottom: 8 }}>
									<button
										onClick={handleRefreshThumbnails}
										disabled={refreshingThumbnails || !driveConnected}
										style={{
											width: '100%',
											padding: '8px',
											borderRadius: 6,
											border: `1px solid ${S.borderColor}`,
											background: 'transparent',
											color: refreshingThumbnails ? S.textMuted : S.textPrimary,
											cursor: refreshingThumbnails || !driveConnected ? 'not-allowed' : 'pointer',
											fontFamily: S.mono,
											fontSize: 9,
											letterSpacing: 0.5,
											transition: 'all 0.15s',
										}}
										type="button"
									>
										{refreshingThumbnails
											? 'Fetching thumbnails...'
											: `Refresh Missing Thumbnails (${missingCount})`}
									</button>
									{thumbnailRefreshResult && (
										<div style={{
											fontFamily: S.mono,
											fontSize: 9,
											color: S.accentLight,
											marginTop: 4,
											textAlign: 'center',
										}}>
											{thumbnailRefreshResult}
										</div>
									)}
								</div>
							) : null;
						})()}

						{/* Progress bar */}
						{catalogProgress && (
							<div style={{ marginBottom: 8 }}>
								<div style={{
									height: 4,
									borderRadius: 2,
									background: S.borderColor,
									overflow: 'hidden',
									marginBottom: 4,
								}}>
									<div style={{
										height: '100%',
										borderRadius: 2,
										background: catalogRunning
											? `linear-gradient(90deg, ${S.accent}, ${S.accentLight})`
											: S.accentLight,
										width: catalogProgress.total > 0
											? `${((catalogProgress.completed + catalogProgress.failed) / catalogProgress.total) * 100}%`
											: '0%',
										transition: 'width 0.5s ease',
									}} />
								</div>
								<div style={{
									display: 'flex',
									justifyContent: 'space-between',
									fontFamily: S.mono,
									fontSize: 9,
									color: S.textMuted,
								}}>
									<span>{catalogProgress.completed}/{catalogProgress.total} analyzed</span>
									{catalogProgress.failed > 0 && (
										<span style={{ color: S.red }}>{catalogProgress.failed} failed</span>
									)}
								</div>
							</div>
						)}

						{catalogError && (
							<div style={{
								padding: '8px 10px',
								borderRadius: 6,
								background: '#2d1a1a',
								border: '1px solid #5c2626',
								color: S.red,
								fontFamily: S.mono,
								fontSize: 10,
							}}>
								{catalogError}
							</div>
						)}
					</div>

					{/* Selected clips summary */}
					{selectedIds.size > 0 && (
						<div style={{
							marginBottom: 20,
							padding: '12px 14px',
							borderRadius: 8,
							border: `1px solid ${S.borderColor}`,
							background: S.cardBg,
						}}>
							<Label>Selected Clips ({selectedIds.size})</Label>
							<div style={{ maxHeight: 140, overflow: 'auto' }}>
								{selectedVideos.map((v) => (
									<div key={v.id} style={{
										display: 'flex',
										alignItems: 'center',
										gap: 6,
										padding: '3px 0',
									}}>
										<LocationBadge location={v.suspectedLocation} />
										<span style={{
											fontFamily: S.mono,
											fontSize: 9,
											color: S.textPrimary,
											flex: 1,
											whiteSpace: 'nowrap',
											overflow: 'hidden',
											textOverflow: 'ellipsis',
										}}>
											{v.description || v.name}
										</span>
										{v.duration && (
											<span style={{
												fontFamily: S.mono,
												fontSize: 8,
												color: S.textMuted,
												flexShrink: 0,
											}}>
												{v.duration}
											</span>
										)}
									</div>
								))}
							</div>
						</div>
					)}

					{/* Generate button */}
					<button
						onClick={handleGenerate}
						disabled={!topic.trim() || generating}
						style={{
							width: '100%',
							padding: '14px',
							borderRadius: 8,
							border: 'none',
							background: topic.trim() && !generating ? S.accent : S.borderColor,
							color: topic.trim() && !generating ? '#ffffff' : S.textMuted,
							cursor: topic.trim() && !generating ? 'pointer' : 'not-allowed',
							fontFamily: S.mono,
							fontSize: 12,
							fontWeight: 700,
							letterSpacing: 0.5,
							transition: 'all 0.2s',
						}}
						type="button"
					>
						{generating ? 'Generating Edit Plan...' : 'Generate Edit Plan'}
					</button>

					{genError && (
						<div style={{
							marginTop: 12,
							padding: '10px 14px',
							borderRadius: 8,
							background: '#2d1a1a',
							border: '1px solid #5c2626',
							color: S.red,
							fontFamily: S.mono,
							fontSize: 11,
						}}>
							{genError}
						</div>
					)}
				</div>

				{/* RIGHT PANEL: Edit Plan / Review */}
				<div style={{
					overflow: 'auto',
					padding: '20px 20px',
					display: 'flex',
					flexDirection: 'column',
				}}>
					<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
						<Label>Edit Plan</Label>
						{editPlan && (
							<button
								onClick={handleCopyPlan}
								style={{
									padding: '4px 10px',
									borderRadius: 4,
									border: `1px solid ${S.accent}`,
									background: 'transparent',
									color: S.accent,
									cursor: 'pointer',
									fontFamily: S.mono,
									fontSize: 9,
								}}
								type="button"
							>
								{copied ? 'Copied' : 'Copy'}
							</button>
						)}
					</div>

					{/* Generating state */}
					{generating && (
						<div style={{
							flex: 1,
							display: 'flex',
							flexDirection: 'column',
							alignItems: 'center',
							justifyContent: 'center',
							gap: 12,
						}}>
							<div style={{
								fontFamily: S.mono,
								fontSize: 11,
								color: S.accent,
								letterSpacing: 2,
								background: `linear-gradient(90deg, ${S.accent}, ${S.accentLight}, ${S.accent})`,
								backgroundSize: '200% auto',
								WebkitBackgroundClip: 'text',
								WebkitTextFillColor: 'transparent',
								animation: 'shimmer 2s linear infinite',
							}}>
								GENERATING EDIT PLAN...
							</div>
							<div style={{ fontFamily: S.mono, fontSize: 10, color: S.textMuted }}>
								Analyzing {selectedIds.size} clips with AI director
							</div>
							{selectedIds.size > 0 && (
								<div style={{
									fontFamily: S.mono,
									fontSize: 9,
									color: S.textMuted,
									textAlign: 'center',
									maxWidth: 300,
									lineHeight: 1.5,
								}}>
									Catalog data for each clip is being sent to the AI for smarter sequencing
								</div>
							)}
						</div>
					)}

					{/* Empty state */}
					{!generating && !editPlan && (
						<div style={{
							flex: 1,
							display: 'flex',
							flexDirection: 'column',
							alignItems: 'center',
							justifyContent: 'center',
							gap: 8,
							color: S.textDim,
						}}>
							<div style={{ fontFamily: S.mono, fontSize: 11, letterSpacing: 1 }}>
								SELECT CLIPS AND GENERATE AN EDIT PLAN
							</div>
							<div style={{ fontFamily: S.mono, fontSize: 10, color: S.textMuted, textAlign: 'center', maxWidth: 280 }}>
								Choose videos from the library, set the mode and topic, then generate. AI uses catalog data to make smart sequencing decisions.
							</div>
						</div>
					)}

					{/* Edit plan result */}
					{editPlan && !generating && (
						<div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
							<pre style={{
								color: '#c8d0e0',
								fontSize: 12,
								lineHeight: 1.7,
								whiteSpace: 'pre-wrap',
								wordBreak: 'break-word',
								fontFamily: S.serif,
								background: S.cardBg,
								border: `1px solid ${S.borderColor}`,
								borderRadius: 8,
								padding: 16,
								maxHeight: 'calc(100vh - 520px)',
								overflow: 'auto',
								flex: '0 1 auto',
							}}>
								{editPlan}
							</pre>

							{/* Action buttons */}
							<div style={{ display: 'flex', gap: 8 }}>
								<button
									onClick={handleReset}
									style={{
										flex: 1,
										padding: '10px',
										borderRadius: 8,
										border: `1px solid ${S.borderColor}`,
										background: 'transparent',
										color: S.textMuted,
										cursor: 'pointer',
										fontFamily: S.mono,
										fontSize: 10,
									}}
									type="button"
								>
									New Edit
								</button>
								<button
									onClick={handleGenerate}
									style={{
										flex: 1,
										padding: '10px',
										borderRadius: 8,
										border: `1px solid ${S.orange}`,
										background: 'transparent',
										color: S.orange,
										cursor: 'pointer',
										fontFamily: S.mono,
										fontSize: 10,
									}}
									type="button"
								>
									Regenerate
								</button>
							</div>

							{/* --- Render Video Section --- */}
							<div style={{
								padding: '14px',
								borderRadius: 8,
								border: `1px solid ${S.borderColor}`,
								background: S.cardBg,
							}}>
								<div style={{
									fontFamily: S.mono,
									fontSize: 10,
									letterSpacing: 2,
									textTransform: 'uppercase' as const,
									color: S.textMuted,
									marginBottom: 10,
								}}>
									Render Video
								</div>

								{/* Render capability status */}
								<div style={{
									display: 'flex',
									gap: 10,
									marginBottom: 12,
									fontFamily: S.mono,
									fontSize: 9,
								}}>
									<span style={{
										display: 'inline-flex',
										alignItems: 'center',
										gap: 4,
										color: shotstackConnected ? S.accentLight : (shotstackConnected === null ? S.textMuted : S.red),
									}}>
										<span style={{
											width: 5,
											height: 5,
											borderRadius: '50%',
											background: shotstackConnected ? S.accentLight : (shotstackConnected === null ? S.textMuted : S.red),
										}} />
										Cloud Render {shotstackConnected ? 'Available' : shotstackConnected === null ? 'Checking...' : 'Unavailable'}
									</span>
									<span style={{
										display: 'inline-flex',
										alignItems: 'center',
										gap: 4,
										color: ffmpegAvailable ? S.accentLight : (ffmpegAvailable === null ? S.textMuted : '#6b7280'),
									}}>
										<span style={{
											width: 5,
											height: 5,
											borderRadius: '50%',
											background: ffmpegAvailable ? S.accentLight : (ffmpegAvailable === null ? S.textMuted : '#6b7280'),
										}} />
										Local Render {ffmpegAvailable ? 'Available' : ffmpegAvailable === null ? 'Checking...' : 'Unavailable'}
									</span>
								</div>

								{/* Music controls */}
								<div style={{
									padding: '10px',
									borderRadius: 6,
									border: `1px solid ${S.borderColor}`,
									background: '#0d1117',
									marginBottom: 10,
								}}>
									<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
										<span style={{ fontFamily: S.mono, fontSize: 9, color: S.textMuted, letterSpacing: 1, textTransform: 'uppercase' as const }}>
											Music
										</span>
										<button
											onClick={() => setMusicEnabled(!musicEnabled)}
											style={{
												padding: '2px 8px',
												borderRadius: 4,
												border: `1px solid ${musicEnabled ? S.accent : S.borderColor}`,
												background: musicEnabled ? S.accent + '22' : 'transparent',
												color: musicEnabled ? S.accentLight : S.textMuted,
												cursor: 'pointer',
												fontFamily: S.mono,
												fontSize: 8,
											}}
											type="button"
										>
											{musicEnabled ? 'AUTO' : 'OFF'}
										</button>
									</div>
									{musicEnabled && (
										<>
											<div style={{ fontFamily: S.mono, fontSize: 8, color: S.textMuted, marginBottom: 6 }}>
												Auto-selects royalty-free music for Tier 2 platforms (YouTube, FB, LinkedIn, IG Feed). TikTok/Reels export without music.
											</div>
											<input
												type="text"
												placeholder="Custom music URL (optional)"
												value={customMusicUrl}
												onChange={e => setCustomMusicUrl(e.target.value)}
												style={{
													width: '100%',
													padding: '6px 8px',
													borderRadius: 4,
													border: `1px solid ${S.borderColor}`,
													background: '#0a0d14',
													color: S.textPrimary,
													fontFamily: S.mono,
													fontSize: 9,
													boxSizing: 'border-box' as const,
												}}
											/>
											{customMusicUrl.trim() && (
												<div style={{ fontFamily: S.mono, fontSize: 8, color: S.orange, marginTop: 4 }}>
													Custom track will override auto-selection
												</div>
											)}
										</>
									)}
								</div>

								{/* Per-platform render buttons */}
								<div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
									{Array.from(enabledPlatforms).map(platformId => {
										const label = PLATFORM_LABELS[platformId] || platformId;
										const shotstackJob = renderJobs.find(j => j.platform === platformId && j.method === 'shotstack');
										const ffmpegJob = renderJobs.find(j => j.platform === platformId && j.method === 'ffmpeg');
										const isRendering = shotstackJob?.status === 'submitting' || shotstackJob?.status === 'queued' ||
											shotstackJob?.status === 'fetching' || shotstackJob?.status === 'rendering' || shotstackJob?.status === 'saving' ||
											ffmpegJob?.status === 'submitting';

										return (
											<div key={platformId} style={{
												padding: '8px 10px',
												borderRadius: 6,
												border: `1px solid ${S.borderColor}`,
												background: '#0d1117',
											}}>
												<div style={{
													display: 'flex',
													justifyContent: 'space-between',
													alignItems: 'center',
													marginBottom: shotstackJob || ffmpegJob ? 6 : 0,
												}}>
													<span style={{
														fontFamily: S.mono,
														fontSize: 10,
														color: S.textPrimary,
													}}>
														{label}
													</span>
													<div style={{ display: 'flex', gap: 4 }}>
														{shotstackConnected && (
															<button
																onClick={() => handleRenderPlatform(platformId, 'shotstack')}
																disabled={isRendering || renderingAll}
																style={{
																	padding: '3px 8px',
																	borderRadius: 4,
																	border: `1px solid ${isRendering ? S.borderColor : S.accent}`,
																	background: 'transparent',
																	color: isRendering ? S.textMuted : S.accentLight,
																	cursor: isRendering ? 'not-allowed' : 'pointer',
																	fontFamily: S.mono,
																	fontSize: 8,
																}}
																type="button"
															>
																{shotstackJob?.status === 'submitting' ? 'Submitting...' : 'Cloud'}
															</button>
														)}
														{ffmpegAvailable && (
															<button
																onClick={() => handleRenderPlatform(platformId, 'ffmpeg')}
																disabled={isRendering || renderingAll}
																style={{
																	padding: '3px 8px',
																	borderRadius: 4,
																	border: `1px solid ${isRendering ? S.borderColor : '#6366f1'}`,
																	background: 'transparent',
																	color: isRendering ? S.textMuted : '#818cf8',
																	cursor: isRendering ? 'not-allowed' : 'pointer',
																	fontFamily: S.mono,
																	fontSize: 8,
																}}
																type="button"
															>
																{ffmpegJob?.status === 'submitting' ? 'Rendering...' : 'Local'}
															</button>
														)}
													</div>
												</div>

												{/* Shotstack render status */}
												{shotstackJob && (
													<div style={{
														fontFamily: S.mono,
														fontSize: 9,
														color: shotstackJob.status === 'done' ? S.accentLight
															: shotstackJob.status === 'failed' ? S.red
															: S.textMuted,
														marginBottom: shotstackJob.downloadUrl ? 4 : 0,
													}}>
														Cloud: {RENDER_STATUS_MESSAGES[shotstackJob.status] || shotstackJob.status}
														{shotstackJob.error && (
															<span style={{ color: S.red }}> - {shotstackJob.error}</span>
														)}
													</div>
												)}
												{shotstackJob?.downloadUrl && (
													<a
														href={shotstackJob.downloadUrl}
														target="_blank"
														rel="noopener noreferrer"
														style={{
															display: 'inline-block',
															padding: '4px 10px',
															borderRadius: 4,
															background: '#2D6A4F20',
															border: `1px solid ${S.accent}`,
															color: S.accentLight,
															fontFamily: S.mono,
															fontSize: 9,
															textDecoration: 'none',
															marginRight: 6,
														}}
													>
														Download
													</a>
												)}

												{/* AI Review section */}
												{shotstackJob?.reviewStatus === 'reviewing' && (
													<div style={{
														marginTop: 6,
														padding: '6px 8px',
														borderRadius: 4,
														border: `1px solid ${S.borderColor}`,
														background: '#0a0d14',
														fontFamily: S.mono,
														fontSize: 9,
														color: S.orange,
													}}>
														Reviewing render with AI...
													</div>
												)}

												{shotstackJob?.reviewStatus === 'failed' && (
													<div style={{
														marginTop: 6,
														fontFamily: S.mono,
														fontSize: 9,
														color: S.red,
													}}>
														Review failed: {shotstackJob.reviewError}
													</div>
												)}

												{shotstackJob?.reviewStatus === 'done' && shotstackJob.review && (() => {
													const r = shotstackJob.review;
													const revisionCount = shotstackJob.revisionCount || 0;
													const previousScores = shotstackJob.previousScores || [];
													const lastPrevScore: number | null = previousScores.length > 0 ? (previousScores[previousScores.length - 1] ?? null) : null;
													const scoreRegressed = lastPrevScore !== null && r.overallScore < lastPrevScore;
													const maxRevisionsReached = revisionCount >= 2;
													const scoreColor = (score: number) =>
														score >= 8 ? S.accentLight : score >= 5 ? S.orange : S.red;
													const severityColor = (sev: string) =>
														sev === 'critical' ? S.red : sev === 'warning' ? S.orange : S.textMuted;
													const hasCritical = r.issues.some(i => i.severity === 'critical' || i.severity === 'warning');

													return (
														<div style={{
															marginTop: 8,
															padding: '8px',
															borderRadius: 6,
															border: `1px solid ${hasCritical ? '#92400e' : S.accent}`,
															background: hasCritical ? '#92400e10' : '#2D6A4F10',
														}}>
															{/* Revision tracking header */}
															{revisionCount > 0 && (
																<div style={{
																	fontFamily: S.mono,
																	fontSize: 8,
																	color: S.textMuted,
																	marginBottom: 4,
																	display: 'flex',
																	justifyContent: 'space-between',
																}}>
																	<span>Revision {revisionCount} of 2</span>
																	{lastPrevScore !== null && (
																		<span>
																			Previous: <span style={{ color: scoreColor(lastPrevScore), fontWeight: 700 }}>{lastPrevScore}/10</span>
																			{' → '}
																			<span style={{ color: scoreColor(r.overallScore), fontWeight: 700 }}>{r.overallScore}/10</span>
																			{scoreRegressed && <span style={{ color: S.red, marginLeft: 4 }}>↓</span>}
																		</span>
																	)}
																</div>
															)}

															{/* Score regression warning */}
															{scoreRegressed && shotstackJob.originalDownloadUrl && (
																<div style={{
																	padding: '4px 8px',
																	borderRadius: 4,
																	border: `1px solid ${S.red}`,
																	background: '#7f1d1d20',
																	marginBottom: 6,
																	fontFamily: S.mono,
																	fontSize: 8,
																	color: S.red,
																	display: 'flex',
																	justifyContent: 'space-between',
																	alignItems: 'center',
																}}>
																	<span>Score dropped from {lastPrevScore}/10 to {r.overallScore}/10</span>
																	<a
																		href={shotstackJob.originalDownloadUrl}
																		target="_blank"
																		rel="noopener noreferrer"
																		style={{
																			color: S.orange,
																			textDecoration: 'underline',
																			fontSize: 8,
																			fontWeight: 700,
																		}}
																	>
																		Download Original
																	</a>
																</div>
															)}

															{/* Score row */}
															<div style={{
																display: 'flex',
																gap: 10,
																marginBottom: 6,
																flexWrap: 'wrap',
															}}>
																{[
																	{ label: 'Overall', score: r.overallScore },
																	{ label: 'Story', score: r.storytellingScore },
																	{ label: 'Pacing', score: r.pacingScore },
																	{ label: 'Platform', score: r.platformFitScore },
																].map(({ label: lbl, score }) => (
																	<div key={lbl} style={{
																		fontFamily: S.mono,
																		fontSize: 9,
																		color: S.textMuted,
																	}}>
																		{lbl}:{' '}
																		<span style={{
																			color: scoreColor(score),
																			fontWeight: 700,
																		}}>
																			{score}/10
																		</span>
																	</div>
																))}
															</div>

															{/* Story arc */}
															<div style={{
																fontFamily: S.mono,
																fontSize: 8,
																color: S.textMuted,
																marginBottom: 4,
															}}>
																Arc: <span style={{
																	color: r.storyArc === 'clear' ? S.accentLight
																		: r.storyArc === 'weak' ? S.orange : S.red,
																}}>{r.storyArc}</span>
																{' · '}Hook: {r.hookEffectiveness}
																{' · '}End: {r.endingQuality}
															</div>

															{/* Summary */}
															<div style={{
																fontFamily: S.serif,
																fontSize: 10,
																color: S.textPrimary,
																lineHeight: 1.4,
																marginBottom: r.issues.length > 0 ? 6 : 0,
															}}>
																{r.summary}
															</div>

															{/* Issues */}
															{r.issues.length > 0 && (
																<div style={{ marginBottom: 6 }}>
																	<div style={{
																		fontFamily: S.mono,
																		fontSize: 8,
																		color: S.textMuted,
																		letterSpacing: 1,
																		textTransform: 'uppercase' as const,
																		marginBottom: 3,
																	}}>
																		Issues ({r.issues.length})
																	</div>
																	{r.issues.slice(0, 5).map((issue, idx) => (
																		<div key={idx} style={{
																			fontFamily: S.mono,
																			fontSize: 8,
																			color: severityColor(issue.severity),
																			padding: '2px 0',
																			borderBottom: idx < Math.min(r.issues.length, 5) - 1
																				? `1px solid ${S.borderColor}` : 'none',
																		}}>
																			<span style={{ textTransform: 'uppercase' as const, fontWeight: 700 }}>
																				{issue.severity}
																			</span>
																			{' '}[{issue.category}] {issue.description}
																			<div style={{ color: S.textMuted, paddingLeft: 8 }}>
																				Fix: {issue.fix}
																			</div>
																		</div>
																	))}
																	{r.issues.length > 5 && (
																		<div style={{
																			fontFamily: S.mono,
																			fontSize: 8,
																			color: S.textDim,
																			marginTop: 2,
																		}}>
																			+{r.issues.length - 5} more issues
																		</div>
																	)}
																</div>
															)}

															{/* Strengths */}
															{r.strengths.length > 0 && (
																<div style={{ marginBottom: 6 }}>
																	<div style={{
																		fontFamily: S.mono,
																		fontSize: 8,
																		color: S.textMuted,
																		letterSpacing: 1,
																		textTransform: 'uppercase' as const,
																		marginBottom: 3,
																	}}>
																		Strengths
																	</div>
																	{r.strengths.slice(0, 3).map((s_item, idx) => (
																		<div key={idx} style={{
																			fontFamily: S.mono,
																			fontSize: 8,
																			color: S.accentLight,
																			padding: '1px 0',
																		}}>
																			+ {s_item}
																		</div>
																	))}
																</div>
															)}

															{/* Revise & Re-render button or max reached message */}
															{maxRevisionsReached ? (
																<div style={{
																	width: '100%',
																	padding: '6px 10px',
																	borderRadius: 4,
																	border: `1px solid ${S.borderColor}`,
																	background: '#1a1f2e',
																	color: S.textMuted,
																	fontFamily: S.mono,
																	fontSize: 9,
																	textAlign: 'center' as const,
																}}>
																	Maximum revisions reached (2/2)
																</div>
															) : hasCritical && shotstackJob.revisedEditPlan && (
																<button
																	onClick={() => handleReviseAndRerender(platformId)}
																	style={{
																		width: '100%',
																		padding: '6px 10px',
																		borderRadius: 4,
																		border: `1px solid ${S.orange}`,
																		background: '#92400e20',
																		color: S.orange,
																		cursor: 'pointer',
																		fontFamily: S.mono,
																		fontSize: 9,
																		fontWeight: 700,
																		letterSpacing: 0.5,
																	}}
																	type="button"
																>
																	Revise &amp; Re-render{revisionCount > 0 ? ` (${revisionCount + 1}/2)` : ''}
																</button>
															)}
														</div>
													);
												})()}

												{/* FFmpeg render status */}
												{ffmpegJob && (
													<div style={{
														fontFamily: S.mono,
														fontSize: 9,
														color: ffmpegJob.status === 'done' ? '#818cf8'
															: ffmpegJob.status === 'failed' ? S.red
															: S.textMuted,
													}}>
														Local: {RENDER_STATUS_MESSAGES[ffmpegJob.status] || ffmpegJob.status}
														{ffmpegJob.error && (
															<span style={{ color: S.red }}> - {ffmpegJob.error}</span>
														)}
														{ffmpegJob.status === 'done' && ffmpegJob.localOutputPath && (
															<div style={{ marginTop: 4 }}>
																<button
																	onClick={() => handleDownloadRender(
																		ffmpegJob.localOutputPath!,
																		'CLC_' + platformId + '_' + (selectedMode === 'auto' ? 'game_day' : selectedMode) + '.mp4'
																	)}
																	disabled={downloadingRender === ffmpegJob.localOutputPath}
																	style={{
																		padding: '4px 12px',
																		borderRadius: 4,
																		background: '#6366f120',
																		border: '1px solid #6366f1',
																		color: '#818cf8',
																		cursor: downloadingRender === ffmpegJob.localOutputPath ? 'not-allowed' : 'pointer',
																		fontFamily: S.mono,
																		fontSize: 9,
																		letterSpacing: 0.3,
																	}}
																	type="button"
																>
																	{downloadingRender === ffmpegJob.localOutputPath ? 'Downloading...' : 'Download'}
																</button>
															</div>
														)}
													</div>
												)}
											</div>
										);
									})}
								</div>

								{/* Render All buttons */}
								<div style={{ display: 'flex', gap: 6 }}>
									{shotstackConnected && (
										<button
											onClick={() => handleRenderAll('shotstack')}
											disabled={renderingAll || enabledPlatforms.size === 0}
											style={{
												flex: 1,
												padding: '10px',
												borderRadius: 6,
												border: `1px solid ${renderingAll ? S.borderColor : S.accent}`,
												background: renderingAll ? S.borderColor : '#2D6A4F20',
												color: renderingAll ? S.textMuted : S.accentLight,
												cursor: renderingAll || enabledPlatforms.size === 0 ? 'not-allowed' : 'pointer',
												fontFamily: S.mono,
												fontSize: 10,
												fontWeight: 700,
												letterSpacing: 0.5,
											}}
											type="button"
										>
											{renderingAll ? 'Rendering...' : 'Render All (Cloud)'}
										</button>
									)}
									{ffmpegAvailable && (
										<button
											onClick={() => handleRenderAll('ffmpeg')}
											disabled={renderingAll || enabledPlatforms.size === 0}
											style={{
												flex: 1,
												padding: '10px',
												borderRadius: 6,
												border: `1px solid ${renderingAll ? S.borderColor : '#6366f1'}`,
												background: renderingAll ? S.borderColor : '#6366f120',
												color: renderingAll ? S.textMuted : '#818cf8',
												cursor: renderingAll || enabledPlatforms.size === 0 ? 'not-allowed' : 'pointer',
												fontFamily: S.mono,
												fontSize: 10,
												fontWeight: 700,
												letterSpacing: 0.5,
											}}
											type="button"
										>
											{renderingAll ? 'Rendering...' : 'Render All (Local)'}
										</button>
									)}
								</div>

								{!shotstackConnected && !ffmpegAvailable && shotstackConnected !== null && ffmpegAvailable !== null && (
									<div style={{
										marginTop: 8,
										padding: '8px 10px',
										borderRadius: 6,
										background: '#2d1a1a',
										border: '1px solid #5c2626',
										color: S.red,
										fontFamily: S.mono,
										fontSize: 10,
									}}>
										No render engines available. Cloud rendering requires API configuration. Local rendering requires system dependencies.
									</div>
								)}
							</div>
						</div>
					)}
				</div>
			</div>

			<style>{`
				@keyframes fadeSlideUp {
					from { opacity: 0; transform: translateY(12px); }
					to { opacity: 1; transform: translateY(0); }
				}
				@keyframes shimmer {
					0% { background-position: -200% center; }
					100% { background-position: 200% center; }
				}
				* { box-sizing: border-box; }
				::-webkit-scrollbar { width: 6px; }
				::-webkit-scrollbar-track { background: transparent; }
				::-webkit-scrollbar-thumb { background: #1e2538; border-radius: 3px; }
				::-webkit-scrollbar-thumb:hover { background: #2a3148; }
			`}</style>
		</div>
	);
}
