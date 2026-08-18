/**
 * Audio cheer/laughter detection — the $0 moment finder.
 *
 * The catalog's frame scores are stills-based and cannot see motion; the
 * soundtrack can. In kids' sports footage a momentary-loudness spike (cheer,
 * laugh, shout, applause) almost always marks a genuine highlight. One local
 * audio-only FFmpeg pass per source yields spike timestamps the planner uses
 * to boost hook/climax candidates.
 *
 * File: tools/test-rig/audio-events.ts
 */

import { execSync } from 'node:child_process';

/**
 * Momentary-loudness spike timestamps via ebur128 (100ms resolution).
 * Highpass strips wind/handling rumble so spikes mean voices, not gusts.
 * Spike = 6+ LU over the clip's own median; events within 2s merge.
 */
export function detectAudioSpikes(file: string): number[] {
	let out = '';
	try {
		out = execSync(
			`ffmpeg -hide_banner -nostats -i "${file}" -vn -af "highpass=f=250,ebur128" -f null - 2>&1`,
			{ encoding: 'utf8', maxBuffer: 64e6, timeout: 180_000 },
		);
	} catch {
		return []; // no/broken audio track — planner just loses the bonus signal
	}
	const points: Array<{ t: number; m: number }> = [];
	for (const match of out.matchAll(/t:\s*([\d.]+).*?M:\s*(-?[\d.]+)/g)) {
		const t = parseFloat(match[1]!);
		const m = parseFloat(match[2]!);
		// Drop near-silence readings so they can't drag the median floor down.
		if (Number.isFinite(t) && Number.isFinite(m) && m > -70) points.push({ t, m });
	}
	if (points.length < 50) return [];
	const sorted = points.map(p => p.m).sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)]!;
	const threshold = median + 8;
	// Merge over-threshold readings into events, keeping each event's peak so
	// only the genuinely loudest moments survive — a spike every few seconds
	// is just a noisy room, and a bonus everything gets is a bonus nothing gets.
	const events: Array<{ t: number; peak: number; last: number }> = [];
	for (const p of points) {
		if (p.m < threshold) continue;
		const cur = events.at(-1);
		if (cur && p.t - cur.last <= 2) {
			cur.peak = Math.max(cur.peak, p.m);
			cur.last = p.t;
		} else {
			events.push({ t: Math.round(p.t * 10) / 10, peak: p.m, last: p.t });
		}
	}
	return events
		.sort((a, b) => b.peak - a.peak)
		.slice(0, 6)
		.map(e => e.t)
		.sort((a, b) => a - b);
}
