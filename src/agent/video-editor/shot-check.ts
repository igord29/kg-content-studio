/**
 * Shot check — look at every shot of a rendered edit and cull the empty ones.
 *
 * Shots are chosen from catalogue scores, and a score is one frame's opinion.
 * Most of the library is body-worn camera footage that swings onto a sponsor
 * board or the court surface a moment later, and the catalogue's `people`
 * score has proved too generous to rely on: after anchoring every shot to a
 * scored moment, a recap render still opened on a wall and carried several
 * shots of empty court.
 *
 * The only reliable test is to look at what was actually rendered. This samples
 * two frames from each shot of the finished video, asks a vision model whether
 * a person is clearly the subject of both, and returns the plan with the
 * failing shots removed and the strongest remaining shot moved to the front,
 * ready to render again.
 *
 * File: src/agent/video-editor/shot-check.ts
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

const exec = promisify(execFile);

export interface ShotVerdict {
	shot: number;
	keep: boolean;
	/** 1-5: how well this shot would open the video (faces to camera, clear action). */
	opener: number;
	reason: string;
}

interface PlanClip { fileId: string; trimStart: number; duration: number; speed?: number; [k: string]: unknown }
interface PlanOverlay { text: string; start: number; duration: number; position: string; [k: string]: unknown }
export interface CheckablePlan { clips: PlanClip[]; textOverlays?: PlanOverlay[]; totalDuration?: number; [k: string]: unknown }

/** Where in each shot to sample. Two points catch a camera that swings away mid-shot. */
const SAMPLE_POINTS = [0.3, 0.8];
const MIN_SHOTS_AFTER_CULL = 6;

const PROMPT = `You are checking the shots of a youth tennis program's social video before it is published.
For each shot you are given two frames (A earlier, B later).

KEEP a shot only if, in BOTH frames, at least one person is clearly the subject:
- recognisably a person, large enough to see what they are doing
- their head is in the frame (a torso or legs with the head cut off does not count)
- not just tiny figures far in the background

REJECT a shot if EITHER frame is mostly a wall, sponsor board, fence, court surface, sky,
or an object or body part blocking the lens, or shows only distant specks of people.

Also rate "opener" from 1 to 5: how strongly the shot would open the video. 5 = faces toward
the camera or a clear, readable piece of play up close. 1 = a rejected or weak shot.

Return ONLY a JSON array, one object per shot, in order:
[{"shot": 0, "keep": true, "opener": 4, "reason": "<six words or fewer>"}]`;

async function grabFrame(src: string, atSec: number, out: string): Promise<boolean> {
	try {
		await exec('ffmpeg', [
			'-hide_banner', '-loglevel', 'error', '-y',
			'-ss', atSec.toFixed(2), '-i', src,
			'-frames:v', '1', '-vf', 'scale=512:-2', '-q:v', '5', out,
		], { timeout: 60_000 });
		return fs.existsSync(out);
	} catch {
		return false;
	}
}

/** Timeline start of each shot, in output seconds. */
export function shotStarts(clips: PlanClip[]): number[] {
	const starts: number[] = [];
	let t = 0;
	for (const c of clips) { starts.push(t); t += c.duration / (c.speed || 1); }
	return starts;
}

export async function checkShots(
	videoSrc: string,
	plan: CheckablePlan,
	log: (msg: string) => void,
): Promise<ShotVerdict[]> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-check-'));
	try {
		const starts = shotStarts(plan.clips);
		const jobs: Array<{ shot: number; label: string; file: string; at: number }> = [];
		plan.clips.forEach((c, i) => {
			const len = c.duration / (c.speed || 1);
			SAMPLE_POINTS.forEach((p, k) => jobs.push({
				shot: i, label: k === 0 ? 'A' : 'B',
				file: path.join(dir, `s${i}_${k}.jpg`), at: starts[i]! + len * p,
			}));
		});

		// Bounded concurrency: each grab is a ranged read of the remote file.
		const ok = new Array<boolean>(jobs.length).fill(false);
		let next = 0;
		await Promise.all(Array.from({ length: 6 }, async () => {
			for (let j = next++; j < jobs.length; j = next++) ok[j] = await grabFrame(videoSrc, jobs[j]!.at, jobs[j]!.file);
		}));
		const grabbed = ok.filter(Boolean).length;
		log(`sampled ${grabbed}/${jobs.length} frames from ${plan.clips.length} shots`);
		if (grabbed < jobs.length) throw new Error(`could only read ${grabbed}/${jobs.length} frames from the render`);

		const content: Array<{ type: 'text'; text: string } | { type: 'image'; image: Buffer }> = [{ type: 'text', text: PROMPT }];
		for (const j of jobs) {
			content.push({ type: 'text', text: `Shot ${j.shot} frame ${j.label}:` });
			content.push({ type: 'image', image: fs.readFileSync(j.file) });
		}

		const result = await generateText({
			model: anthropic('claude-sonnet-4-6'),
			messages: [{ role: 'user', content }],
			maxOutputTokens: 3000,
			abortSignal: AbortSignal.timeout(150_000),
		});
		const raw = result.text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
		const parsed = JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1)) as ShotVerdict[];

		// Trust positions, not the model's own numbering; a shot it skipped is rejected.
		return plan.clips.map((_, i) => {
			const v = parsed.find(p => p.shot === i);
			return v
				? { shot: i, keep: !!v.keep, opener: Math.max(1, Math.min(5, Math.round(Number(v.opener) || 1))), reason: String(v.reason ?? '') }
				: { shot: i, keep: false, opener: 1, reason: 'no verdict returned' };
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Apply verdicts: drop rejected shots, lead with the strongest opener, and
 * re-time the overlays to the shorter cut. Returns null when too little would
 * survive to be worth rendering.
 */
export function cullPlan(plan: CheckablePlan, verdicts: ShotVerdict[]): CheckablePlan | null {
	const kept = plan.clips
		.map((clip, i) => ({ clip, v: verdicts[i] }))
		.filter(x => x.v?.keep);
	if (kept.length < MIN_SHOTS_AFTER_CULL) return null;

	// Lead with the best opener. Ties go to the earliest, which keeps the order
	// of the day intact whenever the original opening shot was already good.
	let best = 0;
	kept.forEach((x, i) => { if ((x.v?.opener ?? 0) > (kept[best]!.v?.opener ?? 0)) best = i; });
	const ordered = best === 0 ? kept : [kept[best]!, ...kept.slice(0, best), ...kept.slice(best + 1)];
	const clips = ordered.map(x => x.clip);

	const total = clips.reduce((s, c) => s + c.duration / (c.speed || 1), 0);
	const textOverlays = (plan.textOverlays ?? []).map(o => {
		if (o.start <= 0.01 && o.duration >= (plan.totalDuration ?? total) - 1.5) return { ...o, duration: Math.ceil(total) }; // watermark
		if (o.start > 4) return { ...o, start: Math.max(0, Math.round((total - 1.5) * 10) / 10), duration: 1.5 };     // closing card
		return o;                                                                                                       // opening title
	});

	return { ...plan, clips, textOverlays, totalDuration: Math.round(total) };
}
