/**
 * Location coherence — keep one edit at one venue.
 *
 * The catalog records suspectedLocation per video and every planning step could
 * see it, but nothing ENFORCED it. The planner would build a hook at the US
 * Open, a body clip at a local court and a close somewhere else. Each cut can
 * be individually fine and the video still reads as randomly stitched footage,
 * because the audience recognises the venues even when the model treats the
 * location line as trivia. This is the "pulled in videos from different site
 * locations and merged them poorly" failure, and prompt guidance alone does not
 * fix it — it has to be constrained before the model chooses.
 *
 * Strategy: group the user's selected videos by (fuzzy) location, pick the
 * dominant group, and hand ONLY that group plus unknown-location videos to the
 * pipeline. Unknowns are kept because an absent label is not evidence the
 * footage is from elsewhere — and the planner is told which ones they are.
 *
 * File: src/agent/video-editor/pipeline-v2/location-coherence.ts
 */

import type { CatalogEntry } from '../google-drive';

export interface LocationPartition {
	/** Videos the pipeline should use: dominant venue + unknown-location. */
	kept: string[];
	/** Videos excluded for being at a DIFFERENT known venue. */
	excluded: Array<{ id: string; name: string; location: string }>;
	/** Human-readable label of the dominant venue ('' when nothing known). */
	dominantLocation: string;
	/** ids in `kept` whose location is unknown — surfaced to the planner. */
	unknownIds: string[];
	/** Whether any filtering actually happened. */
	filtered: boolean;
}

// Words that appear in almost every location string and therefore say nothing
// about WHICH venue it is. Matching on these would merge everything.
const GENERIC_TOKENS = new Set([
	'tennis', 'court', 'courts', 'center', 'centre', 'club', 'park', 'field',
	'stadium', 'arena', 'facility', 'indoor', 'outdoor', 'academy', 'school',
	'the', 'and', 'new', 'york', 'city', 'north', 'south', 'east', 'west',
	// Unknown-ish placeholders are not venue names — without these, two videos
	// both labelled "unknown" would count as the same venue.
	'unknown', 'unclear', 'various', 'venue', 'location', 'possibly', 'likely',
]);

function significantTokens(location: string): Set<string> {
	return new Set(
		location
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, ' ')
			.split(/\s+/)
			.filter(t => t.length >= 4 && !GENERIC_TOKENS.has(t)),
	);
}

/** Two location strings refer to the same venue if they share any distinctive token. */
export function sameVenue(a: string, b: string): boolean {
	const ta = significantTokens(a);
	const tb = significantTokens(b);
	if (ta.size === 0 || tb.size === 0) return false;
	for (const t of ta) if (tb.has(t)) return true;
	return false;
}

function isUnknownLocation(entry: CatalogEntry | undefined): boolean {
	const loc = entry?.suspectedLocation?.trim() ?? '';
	if (loc === '') return true;
	const lower = loc.toLowerCase();
	if (['unknown', 'n/a', 'none', 'unclear', 'various'].some(u => lower.includes(u))) return true;
	// A low-confidence guess is not evidence the footage is from a different
	// venue — treat it like no label rather than excluding on a hunch.
	return entry?.locationConfidence === 'low';
}

/**
 * Partition selected videos into a location-coherent working set.
 *
 * Never starves the edit: if filtering would leave fewer than `minKept` videos,
 * nothing is excluded and the caller should fall back to prompt-level guidance.
 */
export function partitionByLocation(
	videos: Array<{ id: string; name: string; duration?: string }>,
	catalog: Map<string, CatalogEntry>,
	minKept = 2,
): LocationPartition {
	const unknownIds: string[] = [];
	const known: Array<{ id: string; name: string; location: string; durationSec: number }> = [];

	for (const v of videos) {
		const entry = catalog.get(v.id);
		if (isUnknownLocation(entry)) {
			unknownIds.push(v.id);
		} else {
			known.push({
				id: v.id,
				name: v.name,
				location: entry!.suspectedLocation!.trim(),
				durationSec: v.duration ? Math.round(parseInt(v.duration) / 1000) : 0,
			});
		}
	}

	const noFilter = (dominant: string): LocationPartition => ({
		kept: videos.map(v => v.id),
		excluded: [],
		dominantLocation: dominant,
		unknownIds,
		filtered: false,
	});

	if (known.length === 0) return noFilter('');

	// Greedy fuzzy grouping: a video joins the first group whose label shares a
	// distinctive token with its location.
	const groups: Array<{ label: string; members: typeof known }> = [];
	for (const v of known) {
		const group = groups.find(g =>
			g.members.some(m => sameVenue(m.location, v.location)),
		);
		if (group) group.members.push(v);
		else groups.push({ label: v.location, members: [v] });
	}

	if (groups.length <= 1) return noFilter(groups[0]!.label);

	// Dominant venue: most videos, then most footage.
	groups.sort((a, b) =>
		b.members.length - a.members.length
		|| b.members.reduce((s, m) => s + m.durationSec, 0)
		- a.members.reduce((s, m) => s + m.durationSec, 0),
	);
	const dominant = groups[0]!;

	const keptIds = new Set([...dominant.members.map(m => m.id), ...unknownIds]);
	if (keptIds.size < minKept) return noFilter(dominant.label);

	const excluded = groups
		.slice(1)
		.flatMap(g => g.members)
		.map(m => ({ id: m.id, name: m.name, location: m.location }));

	return {
		kept: videos.map(v => v.id).filter(id => keptIds.has(id)),
		excluded,
		dominantLocation: dominant.label,
		unknownIds,
		filtered: true,
	};
}
