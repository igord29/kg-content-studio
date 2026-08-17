/**
 * Shot-list builder — deterministic segment vetting for the composers.
 *
 * The composers previously received the top-N individual FRAME scores and
 * picked trim points "near" them. A frame snapshot says nothing about the 4
 * seconds around it: the subject can leave, the camera can whip, a hard cut
 * can land mid-segment. Result: edits assembled from moments that looked good
 * for one frame and terrible in motion (operator verdict on the first
 * measured render: 0/10, "poor quality shots").
 *
 * This module converts a video's dense timestamp samples + scene boundaries
 * into VETTED SEGMENTS — contiguous spans where every sample clears quality
 * and subject-visibility floors and no scene change interrupts — and the
 * composers are constrained to cut only inside them. Taste stays with the
 * model; material quality becomes math, like the render gate. The contract is
 * ENFORCED in validatePlanBeforeRender, not just asserted in prompts.
 *
 * File: src/agent/video-editor/pipeline-v2/shot-list.ts
 */

import type { CatalogEntry } from '../google-drive';

// --- Tunables ---
// Floors are deliberately permissive-but-real: fill 0.30 rejects wall shots
// (the catalog's own fillMultiplier calls <0.35 "not the focal point"), and
// quality 5 rejects the empty-court/blur tier without starving thin videos.
const MIN_FILL = 0.30;
const MIN_QUALITY = 5;
const MIN_SEGMENT_SEC = 2.5;   // shorter than this can't hold a beat
const MAX_SEGMENT_SEC = 8;     // long runs split for ranking; run extent kept for hooks
const SCENE_CHANGE_PAD_SEC = 0.4; // keep cuts clear of hard camera cuts

export interface VettedSegment {
	start: number;
	end: number;
	/** Full extent of the parent floor-passing run — hooks may use up to this */
	runStart: number;
	runEnd: number;
	/** Composite rank: mean quality + 1.2x best emotion + beat bonus */
	score: number;
	minQuality: number;
	meanQuality: number;
	minFill: number;
	meanFill: number;
	peakEmotion: number;
	peakPeople: number;
	/** Most emotionally significant beat inside the span, if any */
	beat?: string;
	/** Brief from the highest-emotion sample inside the span */
	why: string;
}

export interface ShotList {
	segments: VettedSegment[];
	/** true when the entry HAD timestamp samples — distinguishes "measured and
	 * nothing passed" from "never measured" (sub-15s clips, pre-backfill data) */
	sampled: boolean;
	/** true when scene-change data existed to wall off camera cuts */
	hasSceneData: boolean;
	/** Seconds of vetted material vs total duration — thin sources get exposed */
	usableSec: number;
	totalSec: number;
}

type Sample = NonNullable<CatalogEntry['timestampScores']>[number] & {
	emotion?: number;
	beat?: string;
};

const BEAT_BONUS: Record<string, number> = {
	triumph: 2.5,
	hook: 2.0,
	turn: 1.5,
	community: 0.8,
	reflection: 0.5,
};

function passesFloors(s: Sample): boolean {
	// Missing fill defaults to 0.30 — the CatalogEntry contract for pre-field
	// data (google-drive.ts) promises 0.30, and old entries must not be
	// blanket-rejected for lacking a field that didn't exist when scored.
	const fill = typeof s.subjectFillRatio === 'number' ? s.subjectFillRatio : 0.30;
	return (s.actionQuality ?? 0) >= MIN_QUALITY && fill >= MIN_FILL;
}

function parseNum(v: unknown): number {
	if (typeof v === 'number') return v;
	const n = parseInt(String(v ?? ''), 10);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Build the vetted shot list for one catalog entry.
 * Returns an empty list (not an error) when nothing clears the floors —
 * "this source has no usable material" is a first-class answer, and the
 * `sampled` flag says whether that answer was measured or is mere absence.
 */
export function buildShotList(entry: CatalogEntry, durationSec: number): ShotList {
	// NOTE: the cataloger stores timestampScores sorted by actionQuality DESC;
	// time order must be rebuilt here.
	const samples = ([...(entry.timestampScores ?? [])] as Sample[])
		.filter(s => typeof s.timestamp === 'number')
		.sort((a, b) => a.timestamp - b.timestamp);

	const total = durationSec > 0 ? durationSec : (samples.at(-1)?.timestamp ?? 0) + 4;
	const hasSceneData = Boolean(entry.sceneAnalysis?.sceneChanges?.length);
	if (samples.length === 0) {
		return { segments: [], sampled: false, hasSceneData, usableSec: 0, totalSec: Math.round(total) };
	}

	// Scene-change walls: no emitted span may contain one (a hard camera cut
	// mid-clip reads as broken editing).
	const walls = ((entry.sceneAnalysis?.sceneChanges ?? []) as Array<{ timestamp: number }>)
		.map(sc => sc.timestamp)
		.filter(t => typeof t === 'number')
		.sort((a, b) => a - b);

	// Group consecutive floor-passing samples into runs. A wall anywhere
	// between two samples (unpadded — even at a sample's own timestamp)
	// breaks the run; padding safety is enforced again on the emitted span.
	const runs: Sample[][] = [];
	let current: Sample[] = [];
	for (const s of samples) {
		if (!passesFloors(s)) {
			if (current.length > 0) runs.push(current);
			current = [];
			continue;
		}
		if (current.length > 0) {
			const prev = current[current.length - 1]!;
			const crossesWall = walls.some(w => w >= prev.timestamp && w <= s.timestamp);
			// Samples arrive every 2-3s; a gap beyond 8s means unverified territory.
			if (crossesWall || s.timestamp - prev.timestamp > 8) {
				runs.push(current);
				current = [];
			}
		}
		current.push(s);
	}
	if (current.length > 0) runs.push(current);

	const segments: VettedSegment[] = [];
	for (const run of runs) {
		const first = run[0]!.timestamp;
		const last = run[run.length - 1]!.timestamp;
		// A run vouches for first..last plus a short lead-in/out — but padding
		// must never cross a scene wall, so clamp against the nearest walls.
		const prevWall = walls.filter(w => w < first).at(-1);
		const nextWall = walls.find(w => w > last);
		const runStartRaw = Math.max(
			0,
			first - 1,
			prevWall !== undefined ? prevWall + SCENE_CHANGE_PAD_SEC : 0,
		);
		const runEndRaw = Math.min(
			total,
			last + 1.5,
			nextWall !== undefined ? nextWall - SCENE_CHANGE_PAD_SEC : Number.POSITIVE_INFINITY,
		);
		const runStart = Math.round(runStartRaw * 10) / 10;
		const runEnd = Math.round(runEndRaw * 10) / 10;
		if (runEnd - runStart < MIN_SEGMENT_SEC) continue;

		// Split long runs into <= MAX_SEGMENT_SEC pieces so ranking stays local.
		// Sample attribution is half-open [cursor, pieceEnd) so no sample is
		// double-counted across pieces (the final piece's end exceeds the last
		// sample timestamp, so strict < still includes it).
		let cursor = runStart;
		while (cursor < runEnd - 0.5) {
			const pieceEnd = Math.min(runEnd, cursor + MAX_SEGMENT_SEC);
			const inside = run.filter(s => s.timestamp >= cursor && s.timestamp < pieceEnd);
			if (inside.length > 0 && pieceEnd - cursor >= MIN_SEGMENT_SEC) {
				const qualities = inside.map(s => s.actionQuality ?? 0);
				const fills = inside.map(s => (typeof s.subjectFillRatio === 'number' ? s.subjectFillRatio : 0.30));
				const emotions = inside.map(s => s.emotion ?? 0);
				const peakEmotion = Math.max(...emotions);
				const peakPeople = Math.max(...inside.map(s => parseNum(s.people)));
				const bestEmoSample = inside.reduce((a, b) => ((a.emotion ?? 0) >= (b.emotion ?? 0) ? a : b));
				const beat = inside
					.map(s => s.beat)
					.filter((b): b is string => !!b && b !== 'none')
					.sort((a, b) => (BEAT_BONUS[b] ?? 0) - (BEAT_BONUS[a] ?? 0))[0];
				const meanQuality = qualities.reduce((s, v) => s + v, 0) / qualities.length;
				const meanFill = fills.reduce((s, v) => s + v, 0) / fills.length;
				segments.push({
					start: Math.round(cursor * 10) / 10,
					end: Math.round(pieceEnd * 10) / 10,
					runStart,
					runEnd,
					score: Math.round((meanQuality + peakEmotion * 1.2 + (beat ? BEAT_BONUS[beat] ?? 0 : 0)) * 10) / 10,
					minQuality: Math.min(...qualities),
					meanQuality: Math.round(meanQuality * 10) / 10,
					minFill: Math.round(Math.min(...fills) * 100) / 100,
					meanFill: Math.round(meanFill * 100) / 100,
					peakEmotion,
					peakPeople,
					beat,
					why: (bestEmoSample.brief || '').slice(0, 70),
				});
			}
			cursor = pieceEnd;
		}
	}

	segments.sort((a, b) => b.score - a.score);
	const usableSec = Math.round(segments.reduce((s, seg) => s + (seg.end - seg.start), 0));
	return { segments, sampled: true, hasSceneData, usableSec, totalSec: Math.round(total) };
}

/**
 * True when [start, end] lies entirely inside some vetted run.
 * Containment is against RUN extents (not the ranking splits) so a clip may
 * straddle two pieces of the same continuous vetted run.
 */
export function isInsideVettedSpan(list: ShotList, start: number, end: number): boolean {
	return list.segments.some(seg => start >= seg.runStart - 0.05 && end <= seg.runEnd + 0.05);
}

/**
 * Clamp [trimStart, duration] into the nearest vetted run that can hold it,
 * shrinking duration to the run length when nothing fits. Returns null when
 * the list has no segments at all.
 */
export function snapIntoVettedSpan(
	list: ShotList,
	trimStart: number,
	duration: number,
): { trimStart: number; duration: number } | null {
	if (list.segments.length === 0) return null;
	// Unique runs, preferring the one nearest the requested start.
	const runs = [...new Map(list.segments.map(s => [`${s.runStart}-${s.runEnd}`, s])).values()]
		.map(s => ({ start: s.runStart, end: s.runEnd, len: s.runEnd - s.runStart }))
		.sort((a, b) => {
			const da = Math.abs((a.start + a.end) / 2 - (trimStart + duration / 2));
			const db = Math.abs((b.start + b.end) / 2 - (trimStart + duration / 2));
			return da - db;
		});
	const fitting = runs.find(r => r.len >= duration - 0.05);
	const target = fitting ?? runs.reduce((a, b) => (a.len >= b.len ? a : b));
	const dur = Math.min(duration, Math.round(target.len * 10) / 10);
	const start = Math.max(target.start, Math.min(trimStart, target.end - dur));
	return { trimStart: Math.round(start * 10) / 10, duration: dur };
}

/**
 * Render a shot list as prompt text for the composers. Explicit about the
 * contract — and honest about the difference between "measured and nothing
 * passed" and "never measured".
 */
export function formatShotListForPrompt(list: ShotList, opts?: { max?: number }): string {
	if (!list.sampled) {
		return '  ⚠️ No timestamp scores for this source (short clip or pre-backfill entry) — UNVETTED. '
			+ 'Use conservative even-spread trims guided by the scene timeline and treat trim choices as estimated.';
	}
	if (list.segments.length === 0) {
		return '  ❌ NO VETTED SEGMENTS — this source was measured and no span clears the subject-visibility and quality floors. DO NOT cut clips from this source.';
	}
	const max = opts?.max ?? 10;
	const lines = list.segments.slice(0, max).map(seg => {
		const wide = seg.meanFill < 0.40 ? ', WIDE — prefer punchIn' : '';
		const runNote = (seg.runStart !== seg.start || seg.runEnd !== seg.end)
			? ` [part of continuous vetted run ${seg.runStart}s-${seg.runEnd}s]`
			: '';
		return `    ${seg.start}s-${seg.end}s (score ${seg.score}, quality>=${seg.minQuality}, fill>=${seg.minFill}, people<=${seg.peakPeople}` +
			`${seg.peakEmotion > 0 ? `, emotion peak ${seg.peakEmotion}` : ''}${seg.beat ? `, beat=${seg.beat}` : ''}${wide}) — "${seg.why}"${runNote}`;
	}).join('\n');
	const sceneCaution = list.hasSceneData
		? ''
		: '\n    NOTE: no scene-change data for this source — spans are floor-vetted only and may contain camera cuts; prefer shorter clips near span centers.';
	return `  ✅ VETTED SEGMENTS (${list.usableSec}s usable of ${list.totalSec}s total). Every clip's [trimStart, trimStart+duration] MUST lie inside one vetted run — out-of-span clips are snapped back in code:\n${lines}${sceneCaution}`;
}
