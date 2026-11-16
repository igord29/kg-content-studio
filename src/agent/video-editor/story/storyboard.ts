/**
 * Storyboard: a shot for every beat of the narration.
 *
 * Each narration line gets one or more ~2s shots. Candidate shots come from the
 * footage index as RUNS of consecutive usable seconds (a body-worn camera can
 * be on a kid at t=40 and on the floor at t=41, so a shot must sit inside a run
 * at least as long as the shot). A language model matches runs to lines using
 * each line's "visual" note; code then enforces the rules: fits the run, no
 * moment used twice, subject framing from the index, alternatives for swapping.
 *
 * File: src/agent/video-editor/story/storyboard.ts
 */

import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { footageEnd } from './voice';
import type { FootageMoment, Shot, StoryProject } from './types';

export interface Run { id: number; fileId: string; start: number; end: number; best: FootageMoment; score: number }

const usable = (m: FootageMoment) => m.quality >= 2 && m.people >= 1;

/** Consecutive usable seconds, per source, with their best frame. */
export function findRuns(moments: FootageMoment[]): Run[] {
	const byFile = new Map<string, FootageMoment[]>();
	for (const m of moments) {
		if (!byFile.has(m.fileId)) byFile.set(m.fileId, []);
		byFile.get(m.fileId)!.push(m);
	}
	const runs: Run[] = [];
	for (const [fileId, ms] of byFile) {
		ms.sort((a, b) => a.t - b.t);
		let cur: FootageMoment[] = [];
		const flush = () => {
			if (cur.length >= 2) {
				const best = [...cur].sort((a, b) => score(b) - score(a))[0]!;
				runs.push({ id: 0, fileId, start: cur[0]!.t, end: cur[cur.length - 1]!.t + 1, best, score: score(best) + Math.min(cur.length, 6) * 0.2 });
			}
			cur = [];
		};
		for (const m of ms) {
			if (usable(m) && (cur.length === 0 || m.t === cur[cur.length - 1]!.t + 1)) cur.push(m);
			else { flush(); if (usable(m)) cur.push(m); }
		}
		flush();
	}
	runs.sort((a, b) => b.score - a.score);
	runs.forEach((r, i) => { r.id = i + 1; });
	return runs;
}

function score(m: FootageMoment): number {
	const actionBonus = ['hitting', 'swinging', 'rally', 'moving-piece', 'handshake', 'celebrating', 'smiling', 'playing-chess', 'coach-teaching', 'coach-feeding', 'serving']
		.includes(m.action) ? 1.5 : 0;
	return m.people * 1.5 + m.quality + actionBonus;
}

interface Slot { start: number; dur: number; line: number; text: string; visual: string }

export function planSlots(p: StoryProject): Slot[] {
	const segs = p.voice?.segments ?? [];
	const lines = p.script?.lines ?? [];
	const end = footageEnd(p);
	const slots: Slot[] = [];
	for (let i = 0; i < segs.length; i++) {
		const a = i === 0 ? 0 : segs[i]!.start - 0.12;          // cut just before the words
		const b = i + 1 < segs.length ? segs[i + 1]!.start - 0.12 : end;
		const len = b - a;
		const n = Math.max(1, Math.round(len / 2.2));
		for (let k = 0; k < n; k++) {
			slots.push({ start: +(a + (len * k) / n).toFixed(3), dur: +(len / n).toFixed(3), line: i, text: lines[i]?.text ?? '', visual: lines[i]?.visual ?? '' });
		}
	}
	return slots;
}

const SYSTEM = `You are a video editor picking footage for a narrated social video about a youth program. You get the narration split into SLOTS (each needs one shot) and a list of CLIPS (usable stretches of footage with a description of their best frame).

Rules:
- Match each slot to the clip that best shows its line / visual note. Literal matches win: if the line says hitting, show a kid hitting; if it names the program, show the coach or the group; faces and real play beat empty wide shots.
- The first slot is the hook: the most engaging, clearest clip (faces, action, close).
- Prefer people=3 (close) and real activity. Avoid repeating the same clip, and vary sources so it doesn't look like one long take.
- A clip's length must be at least the slot's duration.
- For every slot also list 4 alternative clip ids.

Return ONLY JSON: [{"slot":0,"clip":12,"alts":[3,7,9,15]}]`;

export async function buildStoryboard(p: StoryProject, moments: FootageMoment[]): Promise<Shot[]> {
	const slots = planSlots(p);
	const runs = findRuns(moments).slice(0, 220);
	if (runs.length === 0) throw new Error('No usable footage found in the selected videos');
	const nameOf = new Map((p.sources ?? []).map(s => [s.fileId, s.name]));
	const clipList = runs.map(r => `${r.id}: ${(nameOf.get(r.fileId) ?? r.fileId).slice(0, 18)} ${r.start}-${r.end}s len=${r.end - r.start} people=${r.best.people} action=${r.best.action} "${r.best.desc}"`).join('\n');
	const slotList = slots.map((s, i) => `${i}: ${s.dur.toFixed(1)}s  line="${s.text}"  visual="${s.visual}"`).join('\n');

	let picks: Array<{ slot: number; clip: number; alts: number[] }> = [];
	try {
		const res = await generateText({
			model: anthropic('claude-sonnet-4-6'),
			system: SYSTEM,
			prompt: `SLOTS:\n${slotList}\n\nCLIPS:\n${clipList}`,
			maxOutputTokens: 6000,
			abortSignal: AbortSignal.timeout(150_000),
		});
		const raw = res.text.trim();
		picks = JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1));
	} catch {
		picks = []; // fall back to the greedy pass below
	}

	const byId = new Map(runs.map(r => [r.id, r]));
	// Subject position over the seconds a shot actually uses (body cameras move, so one frame's x is not enough).
	const momentsByFile = new Map<string, FootageMoment[]>();
	for (const m of moments) { if (!momentsByFile.has(m.fileId)) momentsByFile.set(m.fileId, []); momentsByFile.get(m.fileId)!.push(m); }
	const xAt = (fileId: string, t: number, dur: number, fallback: number): number => {
		const xs = (momentsByFile.get(fileId) ?? []).filter(m => m.people >= 1 && m.t >= Math.floor(t) && m.t <= t + dur).map(m => m.x).sort((a, b) => a - b);
		return xs.length ? +xs[Math.floor(xs.length / 2)]!.toFixed(2) : fallback;
	};
	const used: Array<{ fileId: string; a: number; b: number }> = [];
	const free = (fileId: string, a: number, b: number) => !used.some(u => u.fileId === fileId && a < u.b + 1 && b > u.a - 1);

	/** A free start time inside the run: nearest the run's best frame first, then anywhere it fits. */
	const place = (r: Run, dur: number): { t: number } | null => {
		if (r.end - r.start < dur - 0.05) return null;
		const ideal = Math.max(r.start, Math.min(r.end - dur, r.best.t - dur * 0.4));
		const options: number[] = [ideal];
		for (let t = r.start; t <= r.end - dur + 1e-6; t += 0.5) options.push(t);
		options.sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal));
		const t = options.find(o => free(r.fileId, o, o + dur));
		return t === undefined ? null : { t: +t.toFixed(2) };
	};
	const uses = new Map<string, number>();

	const shots: Shot[] = [];
	slots.forEach((s, i) => {
		const pick = picks.find(x => x.slot === i);
		const order = [pick?.clip, ...(pick?.alts ?? [])].map(id => (id ? byId.get(id) : undefined)).filter((r): r is Run => !!r);
		const prevFile = shots[i - 1]?.fileId;
		// Fallback: long-enough runs, least-used source first, never the previous shot's source if avoidable.
		const fallback = runs.filter(r => r.end - r.start >= s.dur - 0.05)
			.sort((a, b) => ((a.fileId === prevFile ? 100 : 0) + (uses.get(a.fileId) ?? 0) * 3 - a.score)
				- ((b.fileId === prevFile ? 100 : 0) + (uses.get(b.fileId) ?? 0) * 3 - b.score));
		let chosen: { r: Run; t: number } | null = null;
		for (const r of [...order, ...fallback]) {
			const pl = place(r, s.dur);
			if (pl) { chosen = { r, t: pl.t }; break; }
		}
		if (!chosen) {
			// Footage ran out: reuse the longest run rather than leave a hole.
			const r = [...runs].sort((a, b) => (b.end - b.start) - (a.end - a.start))[0]!;
			chosen = { r, t: Math.max(r.start, Math.min(r.end - s.dur, r.start)) };
		}
		used.push({ fileId: chosen.r.fileId, a: chosen.t, b: chosen.t + s.dur });
		uses.set(chosen.r.fileId, (uses.get(chosen.r.fileId) ?? 0) + 1);
		const alternatives = [...order, ...fallback].filter(r => r !== chosen!.r).slice(0, 6)
			.map(r => { const t = +Math.max(r.start, Math.min(r.end - s.dur, r.best.t - s.dur * 0.4)).toFixed(2); return { fileId: r.fileId, t, x: xAt(r.fileId, t, s.dur, r.best.x), desc: r.best.desc }; });
		shots.push({
			start: s.start, dur: s.dur, line: s.line, fileId: chosen.r.fileId, t: chosen.t,
			x: xAt(chosen.r.fileId, chosen.t, s.dur, chosen.r.best.x), zoom: 1, note: chosen.r.best.desc, trans: 'cut', alternatives,
		});
	});
	assignTransitions(p, shots);
	return shots;
}

/** Mostly hard cuts; a punchy transition at line changes every few lines, a flash after titled lines. */
export function assignTransitions(p: StoryProject, shots: Shot[]): void {
	const lines = p.script?.lines ?? [];
	const cycle: Shot['trans'][] = ['zoomin', 'slideleft', 'smoothleft', 'slideup', 'wipeleft'];
	let k = 0;
	for (let i = 0; i < shots.length - 1; i++) {
		const lineChange = shots[i + 1]!.line !== shots[i]!.line;
		const nextLine = lines[shots[i + 1]!.line];
		if (!lineChange) shots[i]!.trans = 'cut';
		else if (nextLine?.title || (lines[shots[i]!.line]?.pauseAfter ?? 0) >= 0.5) shots[i]!.trans = 'fadewhite';
		else if (shots[i + 1]!.line % 3 === 0) shots[i]!.trans = cycle[k++ % cycle.length];
		else shots[i]!.trans = 'cut';
	}
	if (shots.length) shots[shots.length - 1]!.trans = 'cut';
}
