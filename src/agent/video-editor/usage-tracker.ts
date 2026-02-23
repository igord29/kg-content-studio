/**
 * Video Usage Tracking & Fresh Scene Selection
 *
 * Tracks which clips and scenes have been used in previous renders,
 * computes freshness scores, validates edit plans for deduplication,
 * and generates semantic tags for catalog entries.
 *
 * File: src/agent/video-editor/usage-tracker.ts
 */

import type { CatalogEntry } from './google-drive';

// --- Types ---

/** Individual clip usage record — one per clip per render */
export interface ClipUsageRecord {
	id: string;                    // unique: cu_${timestamp}_${random}
	renderId: string;              // which render used this clip
	renderDate: string;            // ISO timestamp
	fileId: string;                // Google Drive file ID
	filename: string;
	trimStart: number;             // seconds into source
	duration: number;              // seconds used
	trimEnd: number;               // trimStart + duration
	purpose: string;               // from edit plan
	editMode: string;              // game_day, our_story, etc.
	platform: string;              // tiktok, youtube, etc.
}

/** Time region that has been used from a source video */
export interface UsedRegion {
	trimStart: number;
	trimEnd: number;
	useCount: number;
	lastUsed: string;              // ISO timestamp
}

/** Video-level usage summary — one per fileId */
export interface VideoUsageSummary {
	fileId: string;
	filename: string;
	totalUses: number;             // how many clip segments used across all renders
	lastUsedDate: string;          // ISO timestamp
	usedRegions: UsedRegion[];     // which time regions have been used
	freshnessScore: number;        // 0.0 (overused) to 1.0 (never used)
}

/** Dedup validation result */
export interface DedupValidation {
	valid: boolean;
	duplicates: Array<{
		clipA: number;               // index in clips array
		clipB: number;               // index in clips array
		overlapSeconds: number;
	}>;
}

/** Unused time range in a video */
export interface UnusedRegion {
	start: number;
	end: number;
	duration: number;
}

// --- Freshness Scoring ---

/**
 * Compute freshness score for a video.
 * 0.0 = heavily overused, 1.0 = never used.
 *
 * Factors:
 * - Usage count: sigmoid decay (drops quickly after 3 uses, near 0 after 10)
 * - Time recovery: ~5% freshness per day since last use
 */
export function computeFreshnessScore(summary: VideoUsageSummary, now: Date = new Date()): number {
	if (summary.totalUses === 0) return 1.0;

	// Factor 1: Usage count penalty — sigmoid decay
	// At 0 uses: 1.0, at 3 uses: ~0.73, at 5 uses: ~0.31, at 10 uses: ~0.01
	const usagePenalty = 1 / (1 + Math.exp(0.8 * (summary.totalUses - 4)));

	// Factor 2: Time recovery — each day since last use recovers ~5%
	const daysSinceLastUse = (now.getTime() - new Date(summary.lastUsedDate).getTime()) / (1000 * 60 * 60 * 24);
	const timeRecovery = Math.min(1.0, daysSinceLastUse * 0.05);

	// Combined: weighted average
	const score = usagePenalty * 0.6 + timeRecovery * 0.4;
	return Math.max(0, Math.min(1.0, score));
}

/**
 * Get a human-readable freshness tier label.
 */
export function getFreshnessTier(score: number): { tier: string; label: string; color: string } {
	if (score >= 0.8) return { tier: 'FRESH', label: 'Fresh', color: '#4ade80' };
	if (score >= 0.5) return { tier: 'MODERATE', label: 'Moderate', color: '#facc15' };
	if (score >= 0.2) return { tier: 'STALE', label: 'Stale', color: '#fb923c' };
	return { tier: 'OVERUSED', label: 'Overused', color: '#f87171' };
}

// --- Region Analysis ---

/**
 * Check if two time regions overlap.
 */
export function regionsOverlap(
	a: { trimStart: number; trimEnd: number },
	b: { trimStart: number; trimEnd: number }
): boolean {
	return a.trimStart < b.trimEnd && a.trimEnd > b.trimStart;
}

/**
 * Calculate overlap duration between two regions (0 if no overlap).
 */
export function overlapDuration(
	a: { trimStart: number; trimEnd: number },
	b: { trimStart: number; trimEnd: number }
): number {
	const overlap = Math.min(a.trimEnd, b.trimEnd) - Math.max(a.trimStart, b.trimStart);
	return Math.max(0, overlap);
}

/**
 * Merge overlapping used regions into consolidated ranges.
 * Adjacent or overlapping regions from the same video get merged.
 */
export function mergeOverlappingRegions(regions: UsedRegion[]): UsedRegion[] {
	if (regions.length === 0) return [];

	// Sort by start time
	const sorted = [...regions].sort((a, b) => a.trimStart - b.trimStart);
	const first = sorted[0]!;
	const merged: UsedRegion[] = [{
		trimStart: first.trimStart,
		trimEnd: first.trimEnd,
		useCount: first.useCount,
		lastUsed: first.lastUsed,
	}];

	for (let i = 1; i < sorted.length; i++) {
		const current = sorted[i]!;
		const last = merged[merged.length - 1]!;

		// Merge if overlapping or adjacent (within 1 second buffer)
		if (current.trimStart <= last.trimEnd + 1) {
			last.trimEnd = Math.max(last.trimEnd, current.trimEnd);
			last.useCount = Math.max(last.useCount, current.useCount);
			last.lastUsed = last.lastUsed > current.lastUsed ? last.lastUsed : current.lastUsed;
		} else {
			merged.push({
				trimStart: current.trimStart,
				trimEnd: current.trimEnd,
				useCount: current.useCount,
				lastUsed: current.lastUsed,
			});
		}
	}

	return merged;
}

/**
 * Find unused time regions in a video given its used regions and total duration.
 */
export function findUnusedRegions(usedRegions: UsedRegion[], totalDurationSeconds: number): UnusedRegion[] {
	if (usedRegions.length === 0) {
		return [{ start: 0, end: totalDurationSeconds, duration: totalDurationSeconds }];
	}

	const merged = mergeOverlappingRegions(usedRegions);
	const unused: UnusedRegion[] = [];

	// Gap before first used region
	const firstMerged = merged[0];
	if (firstMerged && firstMerged.trimStart > 1) {
		const dur = firstMerged.trimStart;
		unused.push({ start: 0, end: firstMerged.trimStart, duration: dur });
	}

	// Gaps between used regions
	for (let i = 0; i < merged.length - 1; i++) {
		const curr = merged[i]!;
		const next = merged[i + 1]!;
		const gapStart = curr.trimEnd;
		const gapEnd = next.trimStart;
		const dur = gapEnd - gapStart;
		if (dur > 1) { // Only include gaps > 1 second
			unused.push({ start: gapStart, end: gapEnd, duration: dur });
		}
	}

	// Gap after last used region
	const lastMerged = merged[merged.length - 1];
	const lastEnd = lastMerged ? lastMerged.trimEnd : 0;
	if (totalDurationSeconds - lastEnd > 1) {
		const dur = totalDurationSeconds - lastEnd;
		unused.push({ start: lastEnd, end: totalDurationSeconds, duration: dur });
	}

	return unused;
}

// --- Usage Summary Building ---

/**
 * Build a Map of VideoUsageSummary from raw clip usage records.
 */
export function buildUsageSummaryMap(records: ClipUsageRecord[]): Map<string, VideoUsageSummary> {
	const summaryMap = new Map<string, VideoUsageSummary>();

	for (const record of records) {
		let summary = summaryMap.get(record.fileId);

		if (!summary) {
			summary = {
				fileId: record.fileId,
				filename: record.filename,
				totalUses: 0,
				lastUsedDate: record.renderDate,
				usedRegions: [],
				freshnessScore: 1.0,
			};
			summaryMap.set(record.fileId, summary);
		}

		summary.totalUses++;

		// Update last used date
		if (record.renderDate > summary.lastUsedDate) {
			summary.lastUsedDate = record.renderDate;
		}

		// Add or merge the used region
		const existingRegion = summary.usedRegions.find(r =>
			overlapDuration(r, { trimStart: record.trimStart, trimEnd: record.trimEnd }) > 1
		);

		if (existingRegion) {
			// Expand existing region and bump count
			existingRegion.trimStart = Math.min(existingRegion.trimStart, record.trimStart);
			existingRegion.trimEnd = Math.max(existingRegion.trimEnd, record.trimEnd);
			existingRegion.useCount++;
			if (record.renderDate > existingRegion.lastUsed) {
				existingRegion.lastUsed = record.renderDate;
			}
		} else {
			summary.usedRegions.push({
				trimStart: record.trimStart,
				trimEnd: record.trimEnd,
				useCount: 1,
				lastUsed: record.renderDate,
			});
		}
	}

	// Compute freshness scores and merge overlapping regions
	const now = new Date();
	for (const summary of summaryMap.values()) {
		summary.usedRegions = mergeOverlappingRegions(summary.usedRegions);
		summary.freshnessScore = computeFreshnessScore(summary, now);
	}

	return summaryMap;
}

/**
 * Create a ClipUsageRecord from render data.
 */
export function createClipUsageRecord(
	clip: { fileId: string; filename?: string; trimStart: number; duration: number; purpose?: string },
	renderMeta: { renderId: string; renderDate?: string; editMode?: string; platform?: string }
): ClipUsageRecord {
	return {
		id: `cu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
		renderId: renderMeta.renderId,
		renderDate: renderMeta.renderDate || new Date().toISOString(),
		fileId: clip.fileId,
		filename: clip.filename || '',
		trimStart: clip.trimStart || 0,
		duration: clip.duration || 0,
		trimEnd: (clip.trimStart || 0) + (clip.duration || 0),
		purpose: clip.purpose || '',
		editMode: renderMeta.editMode || '',
		platform: renderMeta.platform || '',
	};
}

// --- Deduplication Validation ---

/**
 * Validate an edit plan's clips for scene deduplication.
 * Two clips from the same fileId are duplicates if their time ranges overlap by >2 seconds.
 */
export function validateEditPlanDedup(
	clips: Array<{ fileId: string; trimStart: number; duration: number }>
): DedupValidation {
	const duplicates: DedupValidation['duplicates'] = [];

	for (let i = 0; i < clips.length; i++) {
		for (let j = i + 1; j < clips.length; j++) {
			const clipA = clips[i]!;
			const clipB = clips[j]!;
			if (clipA.fileId !== clipB.fileId) continue;

			const aStart = clipA.trimStart;
			const aEnd = aStart + clipA.duration;
			const bStart = clipB.trimStart;
			const bEnd = bStart + clipB.duration;
			const overlap = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);

			if (overlap > 2) {
				duplicates.push({ clipA: i, clipB: j, overlapSeconds: Math.round(overlap * 10) / 10 });
			}
		}
	}

	return { valid: duplicates.length === 0, duplicates };
}

// --- Prompt Formatting ---

/**
 * Format usage context for a single video's footage context in the AI prompt.
 * Returns a string block to append to the clip description.
 */
export function formatUsageContextForPrompt(
	summary: VideoUsageSummary | undefined,
	catalogEntry: CatalogEntry | undefined,
): string {
	if (!summary || summary.totalUses === 0) {
		return `  USAGE HISTORY:
    - Freshness Score: 1.0 (FRESH — never used, prioritize this clip!)`;
	}

	const tier = getFreshnessTier(summary.freshnessScore);
	const daysSinceLastUse = Math.round(
		(Date.now() - new Date(summary.lastUsedDate).getTime()) / (1000 * 60 * 60 * 24)
	);
	const lastUsedStr = daysSinceLastUse === 0 ? 'today' :
		daysSinceLastUse === 1 ? 'yesterday' : `${daysSinceLastUse} days ago`;

	// Format used regions
	const regionsStr = summary.usedRegions
		.map(r => `${r.trimStart.toFixed(1)}-${r.trimEnd.toFixed(1)}s (${r.useCount}x)`)
		.join(', ');

	// Find unused regions (if we know the total duration)
	let unusedStr = '';
	const totalDuration = catalogEntry?.sceneAnalysis?.duration ||
		(catalogEntry?.duration ? parseFloat(catalogEntry.duration) : 0);

	if (totalDuration > 0) {
		const unusedRegions = findUnusedRegions(summary.usedRegions, totalDuration);
		if (unusedRegions.length > 0) {
			unusedStr = unusedRegions
				.map(r => `${r.start.toFixed(1)}-${r.end.toFixed(1)}s`)
				.join(', ');
		} else {
			unusedStr = 'None — all regions have been used';
		}
	}

	const tierNote = summary.freshnessScore < 0.3
		? ' — prefer other clips or find NEW regions'
		: summary.freshnessScore < 0.5
			? ' — try to find unused regions'
			: '';

	let result = `  USAGE HISTORY:
    - Freshness Score: ${summary.freshnessScore.toFixed(2)} (${tier.tier}${tierNote})
    - Used ${summary.totalUses} time${summary.totalUses !== 1 ? 's' : ''} in previous renders
    - Last used: ${lastUsedStr}
    - Previously used regions: [${regionsStr}]`;

	if (unusedStr) {
		result += `\n    - UNUSED regions to explore: [${unusedStr}]`;
	}

	return result;
}

// --- Semantic Tags ---

/** Common CLC-relevant keywords to extract from activity descriptions */
const ACTIVITY_KEYWORDS = [
	'forehand', 'backhand', 'serve', 'rally', 'volley', 'doubles', 'singles',
	'redball', 'red-ball', 'greenball', 'green-ball', 'orangeball', 'orange-ball',
	'kids', 'children', 'child', 'youth', 'teen', 'teenager', 'adult',
	'coach', 'coaching', 'instructor', 'teacher', 'mentor',
	'practice', 'drill', 'lesson', 'training', 'warmup', 'warm-up',
	'match', 'tournament', 'competition', 'game', 'play', 'playing',
	'celebration', 'trophy', 'award', 'ceremony', 'graduation',
	'chess', 'board', 'checkmate', 'opening', 'endgame',
	'literacy', 'reading', 'book', 'library', 'tutor', 'tutoring',
	'volunteer', 'community', 'family', 'parent', 'group',
	'court', 'gym', 'park', 'field', 'classroom',
	'racket', 'ball', 'net', 'baseline',
	'smile', 'laugh', 'cheer', 'clap', 'hug', 'high-five',
	'interview', 'speaking', 'talking', 'testimonial',
	'setup', 'preparation', 'arrival', 'departure',
];

/** Location aliases for consistent tagging */
const LOCATION_TAGS: Record<string, string[]> = {
	'hempstead': ['hempstead', 'long-island'],
	'long beach': ['long-beach', 'long-island', 'beach'],
	'brooklyn': ['brooklyn', 'nyc'],
	'bronx': ['bronx', 'nyc'],
	'queens': ['queens', 'nyc'],
	'us open': ['us-open', 'usta', 'tournament', 'flushing'],
	'manhattan': ['manhattan', 'nyc'],
	'nassau': ['nassau', 'long-island'],
	'flushing': ['flushing', 'queens', 'nyc'],
};

/**
 * Generate semantic tags for a catalog entry.
 * Extracts meaningful keywords from activity, location, content type, etc.
 */
export function generateSemanticTags(entry: CatalogEntry): string[] {
	const tags = new Set<string>();

	// From contentType
	switch (entry.contentType) {
		case 'tennis_action':
			tags.add('tennis'); tags.add('sports'); tags.add('action');
			break;
		case 'chess':
			tags.add('chess'); tags.add('strategy'); tags.add('board-game');
			break;
		case 'interview':
			tags.add('interview'); tags.add('testimonial'); tags.add('talking');
			break;
		case 'event':
			tags.add('event'); tags.add('gathering');
			break;
		case 'establishing':
			tags.add('establishing'); tags.add('wide-shot'); tags.add('location');
			break;
		case 'mixed':
			tags.add('mixed');
			break;
	}

	// From location
	const locLower = (entry.suspectedLocation || '').toLowerCase();
	for (const [pattern, locationTags] of Object.entries(LOCATION_TAGS)) {
		if (locLower.includes(pattern)) {
			for (const tag of locationTags) tags.add(tag);
		}
	}
	// Also add the raw location as a tag
	if (locLower && locLower !== 'unknown') {
		tags.add(locLower.replace(/\s+/g, '-'));
	}

	// From activity description — keyword extraction
	const activityLower = (entry.activity || '').toLowerCase();
	const words = activityLower.split(/[\s,;.!?()]+/).filter(w => w.length > 2);
	for (const word of words) {
		// Check against our keyword list
		for (const keyword of ACTIVITY_KEYWORDS) {
			if (word === keyword || word === keyword.replace(/-/g, '')) {
				tags.add(keyword.replace(/-/g, ''));
				break;
			}
		}
	}
	// Also check for multi-word phrases
	for (const keyword of ACTIVITY_KEYWORDS) {
		if (keyword.includes('-') && activityLower.includes(keyword.replace(/-/g, ' '))) {
			tags.add(keyword.replace(/-/g, ''));
		}
	}

	// From readableText
	if (entry.readableText) {
		const textStr = Array.isArray(entry.readableText)
			? (entry.readableText as unknown as string[]).join(' ')
			: entry.readableText;
		const textLower = textStr.toLowerCase();
		// Extract meaningful words
		const textWords = textLower.split(/[\s,;.!?()]+/).filter(w => w.length > 3);
		for (const w of textWords) {
			if (['none', 'unknown', 'n/a', 'null', 'undefined'].includes(w)) continue;
			tags.add(w);
		}
	}

	// From indoor/outdoor
	if (entry.indoorOutdoor && entry.indoorOutdoor !== 'unknown') {
		tags.add(entry.indoorOutdoor);
	}

	// From quality
	if (entry.quality) {
		tags.add(`quality-${entry.quality}`);
	}

	// From suggested modes
	if (entry.suggestedModes) {
		for (const mode of entry.suggestedModes) {
			tags.add(mode.replace(/_/g, '-'));
		}
	}

	// From people count
	const pc = entry.peopleCount?.toLowerCase() || '';
	if (pc.includes('group') || pc.includes('many') || parseInt(pc) > 5) {
		tags.add('group');
	} else if (pc.includes('1') || pc.includes('one') || pc.includes('single')) {
		tags.add('individual');
	} else if (pc.includes('2') || pc.includes('two') || pc.includes('pair')) {
		tags.add('pair');
	}

	return Array.from(tags).sort();
}

/**
 * Score how well a catalog entry matches a search query.
 * Higher score = better match.
 */
export function scoreSearchMatch(entry: CatalogEntry, queryTokens: string[]): number {
	const tags = entry.semanticTags || generateSemanticTags(entry);
	const activityLower = (entry.activity || '').toLowerCase();
	const locLower = (entry.suspectedLocation || '').toLowerCase();

	let score = 0;
	for (const token of queryTokens) {
		const t = token.toLowerCase();
		// Exact tag match = 3 points
		if (tags.includes(t)) score += 3;
		// Partial tag match = 1 point
		else if (tags.some(tag => tag.includes(t) || t.includes(tag))) score += 1;
		// Activity description match = 2 points
		if (activityLower.includes(t)) score += 2;
		// Location match = 1 point
		if (locLower.includes(t)) score += 1;
	}

	return score;
}
