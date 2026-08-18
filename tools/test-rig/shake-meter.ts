/**
 * Camera-shake meter — vidstab two-pass analysis, measurement half.
 *
 * The catalog is stills-scored and therefore blind to shake: a sharp frame
 * from a wobbly clip ranks high (operator verdict on parents-v1: "a lot of
 * noise and shaky video"). This measures actual per-frame global motion so
 * the planner can reject spans the catalog can't see are bad.
 *
 * Calibration (2560x1440 handheld sources, analyzed at 640px width):
 * observed range 1.3 (tripod-calm) to 6.6 (edge-doubling shaky). Reject at
 * metric > 4.0, or jitter > 3.0 — jitter is the high-frequency residual
 * after removing a 15-frame moving average, i.e. shake with intentional
 * panning factored out.
 *
 * File: tools/test-rig/shake-meter.ts
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const SHAKE_REJECT = 4.0;  // mean |dx|+|dy| px/frame @640px
export const JITTER_REJECT = 3.0; // px/frame residual after de-panning

export interface ShakeReading {
	/** mean per-frame |dx|+|dy| in px at 640px analysis width */
	metric: number;
	/** high-frequency residual after removing 15-frame moving average */
	jitter: number;
	peak: number;
	frames: number;
}

const LM_RE = /\(LM (-?\d+) (-?\d+) (-?\d+) (-?\d+) \d+ [\d.eE+-]+ [\d.eE+-]+\)/g;

function median(nums: number[]): number {
	const s = [...nums].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)]!;
}

function movavg(seq: number[], w = 15): number[] {
	return seq.map((_, i) => {
		const lo = Math.max(0, i - Math.floor(w / 2));
		const hi = Math.min(seq.length, i + Math.floor(w / 2) + 1);
		let sum = 0;
		for (let j = lo; j < hi; j++) sum += seq[j]!;
		return sum / (hi - lo);
	});
}

/**
 * Measure shake over [startSec, startSec+durSec] of a local file.
 * One reduced-scale vidstabdetect pass (~seconds); null if it fails.
 */
export function measureShake(file: string, startSec: number, durSec: number): ShakeReading | null {
	const trf = path.join(os.tmpdir(), `rig-shake-${process.pid}-${Math.round(startSec * 10)}.trf`);
	try {
		const res = spawnSync(
			'ffmpeg',
			['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
				'-ss', String(startSec), '-t', String(durSec), '-i', file,
				'-vf', `scale=640:-2,vidstabdetect=result=${trf}`, '-an', '-f', 'null', '-'],
			{ encoding: 'utf8', timeout: 120_000 },
		);
		if (res.error || !fs.existsSync(trf)) return null;

		const dxs: number[] = [];
		const dys: number[] = [];
		for (const line of fs.readFileSync(trf, 'utf8').split('\n')) {
			if (!line.startsWith('Frame ')) continue;
			const lms = [...line.matchAll(LM_RE)];
			if (lms.length < 4) {
				dxs.push(0); dys.push(0);
				continue;
			}
			dxs.push(median(lms.map(m => parseInt(m[1]!, 10))));
			dys.push(median(lms.map(m => parseInt(m[2]!, 10))));
		}
		if (dxs.length === 0) return null;

		const mags = dxs.map((x, i) => Math.abs(x) + Math.abs(dys[i]!));
		const sx = movavg(dxs);
		const sy = movavg(dys);
		const jitter = dxs.reduce((s, x, i) => s + Math.abs(x - sx[i]!) + Math.abs(dys[i]! - sy[i]!), 0) / dxs.length;
		return {
			metric: Math.round((mags.reduce((a, b) => a + b, 0) / mags.length) * 100) / 100,
			jitter: Math.round(jitter * 100) / 100,
			peak: Math.round(Math.max(...mags) * 10) / 10,
			frames: dxs.length,
		};
	} finally {
		fs.rmSync(trf, { force: true });
	}
}

export function isTooShaky(r: ShakeReading): boolean {
	return r.metric > SHAKE_REJECT || r.jitter > JITTER_REJECT;
}
