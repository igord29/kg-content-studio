/**
 * Tests for location coherence — one edit, one venue.
 *
 * The failure this prevents: the planner mixing footage from different site
 * locations in a single video ("pulled in videos from different site locations
 * and merged them poorly"). The partition runs BEFORE any planning step, so
 * these tests pin the filtering decisions themselves.
 *
 * Run: bun test-location-coherence.ts
 */

import { partitionByLocation, sameVenue } from './src/agent/video-editor/pipeline-v2/location-coherence';
import type { CatalogEntry } from './src/agent/video-editor/google-drive';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
	if (cond) { console.log('  PASS  ' + label); return; }
	failures++;
	console.log('  FAIL  ' + label + (detail ? ' — ' + detail : ''));
}

function entry(location: string | undefined, confidence: 'high' | 'medium' | 'low' = 'high'): CatalogEntry {
	return {
		suspectedLocation: location,
		locationConfidence: confidence,
	} as unknown as CatalogEntry;
}

function video(id: string, seconds: number): { id: string; name: string; duration: string } {
	return { id, name: id + '.mp4', duration: String(seconds * 1000) };
}

// --- 1. Fuzzy venue matching ----------------------------------------------
console.log('\n1. sameVenue fuzzy matching');
check('name variants of one venue match',
	sameVenue('US Open - Flushing Meadows', 'Flushing Meadows, Queens NY'));
check('distinct venues do not match',
	!sameVenue('US Open - Flushing Meadows', 'Prospect Park Tennis Center'));
check('generic words alone never match ("tennis court" vs "tennis center")',
	!sameVenue('outdoor tennis court', 'indoor tennis center'));
check('empty / unknown strings never match anything',
	!sameVenue('', 'Flushing Meadows') && !sameVenue('unknown', 'unknown'));

// --- 2. Mixed venues filter to the dominant one ---------------------------
console.log('\n2. Mixed venues are filtered to the dominant one');
{
	const catalog = new Map<string, CatalogEntry>([
		['a', entry('US Open, Flushing Meadows')],
		['b', entry('Flushing Meadows Queens')],
		['c', entry('US Open grounds, Flushing')],
		['d', entry('Prospect Park Tennis Center')],
	]);
	const p = partitionByLocation([video('a', 60), video('b', 90), video('c', 30), video('d', 120)], catalog);
	check('filtering happened', p.filtered);
	check('the three US Open videos are kept', JSON.stringify(p.kept) === JSON.stringify(['a', 'b', 'c']));
	check('the Prospect Park video is excluded',
		p.excluded.length === 1 && p.excluded[0]!.id === 'd');
	check('dominant location is reported', p.dominantLocation.toLowerCase().includes('flushing'));
}

// --- 3. Unknown locations are kept, never excluded ------------------------
console.log('\n3. Unknown-location videos are kept');
{
	const catalog = new Map<string, CatalogEntry>([
		['a', entry('US Open, Flushing Meadows')],
		['b', entry('Flushing Meadows Queens')],
		['u1', entry(undefined)],
		['u2', entry('Somewhere Court', 'low')],   // low confidence = unknown
		['d', entry('Prospect Park Tennis Center')],
	]);
	const p = partitionByLocation(
		[video('a', 60), video('b', 60), video('u1', 60), video('u2', 60), video('d', 60)],
		catalog,
	);
	check('unknowns survive the filter', p.kept.includes('u1') && p.kept.includes('u2'));
	check('unknowns are reported for the planner', p.unknownIds.length === 2);
	check('the other known venue is still excluded', p.excluded.some(e => e.id === 'd'));
}

// --- 4. Single venue: untouched -------------------------------------------
console.log('\n4. Single-venue selections are untouched');
{
	const catalog = new Map<string, CatalogEntry>([
		['a', entry('Flushing Meadows')],
		['b', entry('US Open, Flushing')],
	]);
	const p = partitionByLocation([video('a', 60), video('b', 60)], catalog);
	check('no filtering', !p.filtered && p.kept.length === 2 && p.excluded.length === 0);
}

// --- 5. Starvation guard ---------------------------------------------------
console.log('\n5. Never starves the edit');
{
	// Two videos, two different venues: filtering would leave 1 < minKept(2).
	const catalog = new Map<string, CatalogEntry>([
		['a', entry('Flushing Meadows')],
		['b', entry('Prospect Park')],
	]);
	const p = partitionByLocation([video('a', 60), video('b', 60)], catalog);
	check('falls back to keeping everything', !p.filtered && p.kept.length === 2);
}

// --- 6. Dominance tie broken by footage duration --------------------------
console.log('\n6. Equal counts: more footage wins');
{
	const catalog = new Map<string, CatalogEntry>([
		['a', entry('Flushing Meadows')],
		['b', entry('Flushing Meadows')],
		['c', entry('Prospect Park')],
		['d', entry('Prospect Park')],
		['u', entry(undefined)],
	]);
	const p = partitionByLocation(
		[video('a', 200), video('b', 200), video('c', 30), video('d', 30), video('u', 60)],
		catalog,
	);
	check('the venue with more footage is dominant',
		p.filtered && p.kept.includes('a') && p.kept.includes('b') && !p.kept.includes('c'));
	check('unknown rides along with the winner', p.kept.includes('u'));
}

console.log(failures === 0 ? '\nLocation coherence is enforced.' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
