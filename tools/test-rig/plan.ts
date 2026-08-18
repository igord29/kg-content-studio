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
import { contextFor, scoreForRole, CTA_TEXT, type Audience, type Role, type SegmentContext } from './audience-profiles';

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

// ---------------------------------------------------------------------------
// Audience-aware planner: every slot in the edit has a JOB (hook / establish /
// skill / connection / climax / cta) and each job scores candidates with its
// own function from audience-profiles.ts. Same determinism guarantee as the
// baseline planner — same catalog + same spikes → same plan.
// ---------------------------------------------------------------------------

interface Candidate {
	seg: VettedSegment;
	fileId: string;
	entry: CatalogEntry;
	ctx: SegmentContext;
}

/** Coefficient of variation of clip lengths — the gate's cut-rhythm metric. */
function rhythmCv(lengths: number[]): number {
	const m = lengths.reduce((a, b) => a + b, 0) / lengths.length;
	const sd = Math.sqrt(lengths.reduce((s, v) => s + (v - m) ** 2, 0) / lengths.length);
	return m > 0 ? sd / m : 0;
}

/**
 * The gate requires cutLengthCv >= 0.30 (uniform cuts read as automated).
 * Deterministically widen the spread: grow the longest clip into its vetted
 * run's free tail (bounded, so same-source separation buffers survive), else
 * shave the shortest toward 2.0s.
 */
function enforceRhythm(clips: RigClip[], runEnds: number[]): void {
	const grown = new Map<number, number>();
	let guard = 0;
	while (rhythmCv(clips.map(c => c.duration)) < 0.33 && guard++ < 12) {
		let iMax = 0, iMin = 0;
		clips.forEach((c, i) => {
			if (c.duration > clips[iMax]!.duration) iMax = i;
			if (c.duration < clips[iMin]!.duration) iMin = i;
		});
		const c = clips[iMax]!;
		const canGrow = (grown.get(iMax) ?? 0) < 2.5
			&& c.duration + 0.5 <= 8
			&& c.trimStart + c.duration + 0.5 <= runEnds[iMax]!;
		if (canGrow) {
			c.duration = Math.round((c.duration + 0.5) * 10) / 10;
			grown.set(iMax, (grown.get(iMax) ?? 0) + 0.5);
			continue;
		}
		if (clips[iMin]!.duration > 2.0) {
			clips[iMin]!.duration = Math.round((clips[iMin]!.duration - 0.3) * 10) / 10;
			continue;
		}
		break;
	}
}

export interface ShakeCheck {
	metric: number;
	jitter: number;
	tooShaky: boolean;
}

export function buildAudiencePlan(
	pool: Array<{ entry: CatalogEntry; durationSec: number }>,
	audience: Audience,
	spikesByFile: Record<string, number[]> = {},
	/** Measures camera shake over a candidate span; null = unmeasurable (skip check) */
	shakeFn?: (fileId: string, start: number, dur: number) => ShakeCheck | null,
): RigPlan {
	const lists = pool
		.map(p => ({ ...p, list: buildShotList(p.entry, p.durationSec) }))
		.filter(p => p.list.segments.length > 0);
	if (lists.length === 0) throw new Error('rig planner: no vetted segments in the pool');

	const all: Candidate[] = lists.flatMap(p =>
		p.list.segments.map(seg => ({
			seg,
			fileId: p.entry.fileId!,
			entry: p.entry,
			ctx: contextFor(p.entry, seg, spikesByFile[p.entry.fileId!] ?? []),
		})),
	);

	const used = new Map<string, Array<[number, number]>>();
	const fresh = () => all.filter(s => !overlapsUsed(used, s.fileId, s.seg.start, s.seg.end));
	const ranked = (role: Role): Candidate[] => fresh()
		.map(s => ({ s, v: scoreForRole(s.seg, s.ctx, role, audience) }))
		.sort((a, b) => b.v - a.v)
		.map(r => r.s);

	// Reserve in scarcity order (a great hook / climax / calm CTA shot is rare;
	// establish material is everywhere), assemble in narrative order below.
	// Each role walks its ranking and takes the first candidate that passes the
	// shake meter — the catalog is stills-scored and blind to shake, so this is
	// the planner's only motion sense. If everything tried is shaky, take the
	// least-shaky (it gets stabilized in preprocessing regardless).
	const SHAKE_TRIES = 12;
	const picks = new Map<Role, { c: Candidate; trimStart: number; duration: number }>();
	const take = (role: Role, wantDur: number, place?: (c: Candidate, dur: number) => number) => {
		let fallback: { c: Candidate; start: number; dur: number; badness: number } | null = null;
		for (const c of ranked(role).slice(0, SHAKE_TRIES)) {
			// Clips may use the full vetted RUN, not just the ranking split.
			const runLen = c.seg.runEnd - c.seg.start;
			const dur = Math.round(Math.min(wantDur, runLen) * 10) / 10;
			if (dur < 2) continue;
			const start = place ? place(c, dur) : c.seg.start;
			const shake = shakeFn ? shakeFn(c.fileId, start, dur) : null;
			if (shake?.tooShaky) {
				console.log(`  [shake] ${role}: rejected ${c.fileId.slice(0, 8)} ${start}s (metric ${shake.metric}, jitter ${shake.jitter}) — "${c.seg.why}"`);
				const badness = shake.metric + shake.jitter;
				if (!fallback || badness < fallback.badness) fallback = { c, start, dur, badness };
				continue;
			}
			picks.set(role, { c, trimStart: Math.round(start * 10) / 10, duration: dur });
			commit(used, c.fileId, start, start + dur);
			return;
		}
		if (fallback) {
			console.log(`  [shake] ${role}: all candidates shaky — keeping least-shaky ${fallback.c.fileId.slice(0, 8)} (stabilizer will carry it)`);
			picks.set(role, { c: fallback.c, trimStart: Math.round(fallback.start * 10) / 10, duration: fallback.dur });
			commit(used, fallback.c.fileId, fallback.start, fallback.start + fallback.dur);
		}
	};

	// Hook cold-opens ~1s before the span's emotional peak so the payoff lands
	// inside the viewer's 2-second decision window.
	take('hook', 2.5, (c, dur) => Math.max(c.seg.runStart, Math.min(c.ctx.peakEmotionTs - 1.0, c.seg.runEnd - dur)));
	take('climax', 6);
	take('cta', 4);
	take('connection', 3);
	take('skill', 3.5);
	take('establish', 3);

	const ORDER: Role[] = ['hook', 'establish', 'skill', 'connection', 'climax', 'cta'];
	const clips: RigClip[] = [];
	const runEnds: number[] = [];
	for (const role of ORDER) {
		const p = picks.get(role);
		if (!p) continue;
		const { c, trimStart, duration } = p;
		const isWide = c.seg.meanFill < 0.40;
		clips.push({
			fileId: c.fileId,
			trimStart,
			duration,
			speed: 1.0,
			purpose: role,
			filter: role === 'hook' ? 'documentary' : role === 'cta' ? 'warm' : 'cinematic',
			effect:
				role === 'hook' ? (isWide ? 'punchIn' : 'zoomIn')
				: role === 'establish' || role === 'cta' ? 'zoomOut'
				: role === 'climax' ? (c.seg.meanFill < 0.45 ? 'punchIn' : 'pushIn')
				: 'pushIn',
			extraZoom: role === 'establish' || role === 'cta' ? 1.0 : zoomFor(c.seg),
			subjectPosition: subjectPositionNear(c.entry, trimStart + duration / 2),
			meanFill: c.seg.meanFill,
			why: `[${audience}] ${c.seg.why}${c.ctx.hasSpike ? ' +cheer' : ''}`,
		});
		runEnds.push(c.seg.runEnd);
	}
	if (clips.length < 4) throw new Error(`rig planner: only ${clips.length} role slots filled — pool too thin for an audience plan`);

	enforceRhythm(clips, runEnds);

	const total = clips.reduce((s, c) => s + c.duration, 0);
	const ctaDur = clips.at(-1)!.purpose === 'cta' ? clips.at(-1)!.duration : 4;
	return {
		mode: 'our_story',
		clips,
		textOverlays: [
			{ text: 'Community Literacy Club', start: 1, duration: 2.5, position: 'bottom', animation: 'slideUp' },
			{ text: CTA_TEXT[audience], start: Math.max(4, total - ctaDur + 0.4), duration: Math.max(2.5, ctaDur - 0.6), position: 'bottom', animation: 'scaleUp' },
		],
	};
}
