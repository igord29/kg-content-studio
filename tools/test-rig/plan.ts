/**
 * Deterministic edit planner for the local test rig.
 *
 * Builds an edit plan ALGORITHMICALLY from vetted shot lists — no LLM, no API
 * spend, same inputs → same plan. This is what makes the rig a test model
 * rather than a slot machine: change a floor, a filter, or the framing logic
 * and the diff in the measured output is attributable to that change alone.
 *
 * Structure mirrors the v2 composers' contract: hook (7-8s from a
 * hook-capable vetted run), escalating body (establish → showcase → climax by
 * emotion peak), close (community/reflection beat). Segments are never reused
 * and same-source cuts keep >=3s separation.
 *
 * File: tools/test-rig/plan.ts
 */

import { buildShotList, type ShotList, type VettedSegment } from '../../src/agent/video-editor/pipeline-v2/shot-list';
import type { CatalogEntry } from '../../src/agent/video-editor/google-drive';

export interface RigClip {
	fileId: string;
	trimStart: number;
	duration: number;
	speed: number;
	purpose: string;
	filter: string;
	effect: string | null;
	extraZoom: number;
	/** carried for preprocessing */
	subjectPosition?: string;
	meanFill: number;
	why: string;
}

export interface RigPlan {
	mode: string;
	clips: RigClip[];
	textOverlays: Array<{ text: string; start: number; duration: number; position: string; animation: string }>;
}

const SEPARATION_SEC = 3;

function overlapsUsed(used: Map<string, Array<[number, number]>>, fileId: string, start: number, end: number): boolean {
	const ranges = used.get(fileId) ?? [];
	return ranges.some(([a, b]) => a - SEPARATION_SEC < end && b + SEPARATION_SEC > start);
}

function commit(used: Map<string, Array<[number, number]>>, fileId: string, start: number, end: number): void {
	const arr = used.get(fileId) ?? [];
	arr.push([start, end]);
	used.set(fileId, arr);
}

/** Extra zoom from how wide the vetted span is — mirrors deriveExtraZoom's intent. */
function zoomFor(seg: VettedSegment): number {
	if (seg.meanFill < 0.35) return 1.35;
	if (seg.meanFill < 0.45) return 1.2;
	return 1.05;
}

function subjectPositionNear(entry: CatalogEntry, ts: number): string | undefined {
	const rows = entry.timestampScores ?? [];
	let best: { d: number; pos?: string } = { d: Infinity };
	for (const r of rows) {
		const d = Math.abs(r.timestamp - ts);
		if (d < best.d) best = { d, pos: r.subjectPosition };
	}
	return best.pos;
}

export function buildDeterministicPlan(
	pool: Array<{ entry: CatalogEntry; durationSec: number }>,
	opts?: { bodyClips?: number },
): RigPlan {
	const lists = pool
		.map(p => ({ ...p, list: buildShotList(p.entry, p.durationSec) }))
		.filter(p => p.list.segments.length > 0);
	if (lists.length === 0) throw new Error('rig planner: no vetted segments in the pool');

	const used = new Map<string, Array<[number, number]>>();
	const clips: RigClip[] = [];
	const allSegments = lists.flatMap(p =>
		p.list.segments.map(seg => ({ seg, fileId: p.entry.fileId!, entry: p.entry })),
	);

	// --- Hook: best hook-capable run (>=7s), highest score ---
	const hookCandidates = allSegments
		.filter(s => s.seg.runEnd - s.seg.runStart >= 7)
		.sort((a, b) => b.seg.score - a.seg.score);
	const hook = hookCandidates[0] ?? allSegments.sort((a, b) => b.seg.score - a.seg.score)[0]!;
	const hookLen = Math.min(8, Math.round((hook.seg.runEnd - hook.seg.runStart) * 10) / 10);
	clips.push({
		fileId: hook.fileId,
		trimStart: hook.seg.runStart,
		duration: hookLen,
		speed: 1.0,
		purpose: 'hook',
		filter: 'documentary',
		effect: hook.seg.meanFill < 0.4 ? 'punchIn' : 'zoomIn',
		extraZoom: zoomFor(hook.seg),
		subjectPosition: subjectPositionNear(hook.entry, hook.seg.runStart + hookLen / 2),
		meanFill: hook.seg.meanFill,
		why: hook.seg.why,
	});
	commit(used, hook.fileId, hook.seg.runStart, hook.seg.runStart + hookLen);

	// --- Body: escalate by emotion peak; climax = highest emotion available ---
	const bodyCount = opts?.bodyClips ?? 4;
	const fresh = () => allSegments
		.filter(s => !overlapsUsed(used, s.fileId, s.seg.start, s.seg.end))
		.sort((a, b) => b.seg.score - a.seg.score);

	const climaxPick = [...fresh()].sort((a, b) => b.seg.peakEmotion - a.seg.peakEmotion || b.seg.score - a.seg.score)[0];
	const bodyPool = fresh().filter(s => s !== climaxPick);
	// ascending emotion so the body escalates into the climax
	const establishAndShowcase = bodyPool
		.slice(0, Math.max(bodyCount * 2, 6))
		.sort((a, b) => a.seg.peakEmotion - b.seg.peakEmotion)
		.slice(0, bodyCount - 1);

	establishAndShowcase.forEach((s, i) => {
		const role = i < establishAndShowcase.length - 1 ? 'establish' : 'showcase';
		const dur = Math.min(role === 'establish' ? 4 : 4.5, s.seg.end - s.seg.start);
		if (dur < 2 || overlapsUsed(used, s.fileId, s.seg.start, s.seg.start + dur)) return;
		clips.push({
			fileId: s.fileId,
			trimStart: s.seg.start,
			duration: Math.round(dur * 10) / 10,
			speed: 1.0,
			purpose: role,
			filter: 'cinematic',
			effect: role === 'showcase' && s.seg.meanFill < 0.4 ? 'punchIn' : role === 'establish' ? 'zoomOut' : 'pushIn',
			extraZoom: role === 'establish' ? 1.0 : zoomFor(s.seg),
			subjectPosition: subjectPositionNear(s.entry, s.seg.start + dur / 2),
			meanFill: s.seg.meanFill,
			why: s.seg.why,
		});
		commit(used, s.fileId, s.seg.start, s.seg.start + dur);
	});

	if (climaxPick) {
		const dur = Math.min(5, climaxPick.seg.end - climaxPick.seg.start);
		if (dur >= 2 && !overlapsUsed(used, climaxPick.fileId, climaxPick.seg.start, climaxPick.seg.start + dur)) {
			clips.push({
				fileId: climaxPick.fileId,
				trimStart: climaxPick.seg.start,
				duration: Math.round(dur * 10) / 10,
				speed: 1.0,
				purpose: 'climax',
				filter: 'cinematic',
				effect: climaxPick.seg.meanFill < 0.45 ? 'punchIn' : 'pushIn',
				extraZoom: zoomFor(climaxPick.seg),
				subjectPosition: subjectPositionNear(climaxPick.entry, climaxPick.seg.start + dur / 2),
				meanFill: climaxPick.seg.meanFill,
				why: climaxPick.seg.why,
			});
			commit(used, climaxPick.fileId, climaxPick.seg.start, climaxPick.seg.start + dur);
		}
	}

	// --- Close: community/reflection beat, else lowest-energy fresh segment ---
	const closePick =
		fresh().find(s => s.seg.beat === 'community' || s.seg.beat === 'reflection') ?? fresh().at(-1);
	if (closePick) {
		const dur = Math.min(3.5, closePick.seg.end - closePick.seg.start);
		if (dur >= 2) {
			clips.push({
				fileId: closePick.fileId,
				trimStart: closePick.seg.start,
				duration: Math.round(dur * 10) / 10,
				speed: 1.0,
				purpose: 'close',
				filter: 'warm',
				effect: 'zoomOut',
				extraZoom: 1.0,
				subjectPosition: subjectPositionNear(closePick.entry, closePick.seg.start + dur / 2),
				meanFill: closePick.seg.meanFill,
				why: closePick.seg.why,
			});
		}
	}

	const total = clips.reduce((s, c) => s + c.duration, 0);
	return {
		mode: 'our_story',
		clips,
		textOverlays: [
			{ text: 'Community Literacy Club', start: 1, duration: 3, position: 'bottom', animation: 'slideUp' },
			{ text: 'CLC — where kids find their focus', start: Math.max(4, total - 4.5), duration: 4, position: 'bottom', animation: 'scaleUp' },
		],
	};
}
