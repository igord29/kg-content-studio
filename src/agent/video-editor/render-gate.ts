/**
 * render-gate.ts — deterministic publish gate for finished renders.
 *
 * The existing reviewer (video-reviewer.ts) grades pacing, transitions and
 * music from eight still JPEGs and no audio, then publishes anyway after three
 * attempts. None of those properties are observable in a still sample every
 * ~5s: a 1-second clip is invisible to the sampler, a 15-frame transition will
 * essentially never be caught, and with no audio extracted it cannot hear the
 * music at all.
 *
 * Everything here is measured with FFmpeg — already installed in the runtime
 * image — so there is no model to hallucinate a pass. Keep the AI reviewer for
 * taste; gate publication on these numbers.
 *
 * Deliberately NOT included: subject-size and empty-frame checks. Those need
 * person detection, which would mean shipping torch into the Railway image.
 * Run `tools/quality-gate.py` for the full set (including framing) locally or
 * in CI; this module covers everything achievable with FFmpeg alone.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface GateCheck {
	metric: string;
	label: string;
	value: number | null;
	min?: number;
	max?: number;
	ok: boolean;
	detail?: string;
}

export interface GateResult {
	pass: boolean;
	checks: GateCheck[];
	failures: string[];
	metrics: Record<string, number | null>;
	/** One-line summary suitable for a log line or a Supabase column. */
	summary: string;
}

export interface GateThresholds {
	integratedLufs: [number, number];
	truePeakDbtp: [number | null, number];
	loudnessRangeLu: [number, number];
	longestFreezeSec: [null, number];
	blackFrameSec: [null, number];
	/** Derived from the edit plan's clip lengths, NOT from pixels — see measureCutRhythm. */
	cutLengthCv: [number, null];
	durationSec: [number, number];
}

/** Bar a render must clear to publish without a human looking at it. */
export const PUBLISH_THRESHOLDS: GateThresholds = {
	integratedLufs: [-15.5, -12.5], // platform target is -14
	truePeakDbtp: [null, -0.5],     // above 0 is clipping; delivered files measured +0.2
	loudnessRangeLu: [2.0, 14.0],
	longestFreezeSec: [null, 1.2],  // held/frozen frames read as a broken render
	blackFrameSec: [null, 0.5],
	cutLengthCv: [0.30, null],      // rhythm must vary; uniform cuts read as automated
	durationSec: [8.0, 185.0],
};

export const DRAFT_THRESHOLDS: GateThresholds = {
	integratedLufs: [-17.0, -11.5],
	truePeakDbtp: [null, -0.2],
	loudnessRangeLu: [1.5, 18.0],
	longestFreezeSec: [null, 2.5],
	blackFrameSec: [null, 1.5],
	cutLengthCv: [0.20, null],
	durationSec: [5.0, 200.0],
};

/**
 * Metrics that are legitimately unavailable in some contexts. A missing value
 * on these is a skip; on anything else it is a failure.
 */
const OPTIONAL_METRICS = new Set<string>(['cutLengthCv']);

const LABELS: Record<string, string> = {
	integratedLufs: 'integrated loudness',
	truePeakDbtp: 'true peak',
	loudnessRangeLu: 'loudness range',
	longestFreezeSec: 'longest frozen run',
	blackFrameSec: 'black frames',
	cutLengthCv: 'cut rhythm variation',
	durationSec: 'duration',
};

function ff(args: string): string {
	try {
		// FFmpeg writes its analysis to stderr; merge so the parsers see everything.
		return execSync(`ffmpeg -hide_banner -nostats ${args} 2>&1`, {
			encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
		});
	} catch (err: any) {
		// Non-zero exit still carries usable analysis output for -f null runs.
		return (err?.stdout ?? '') + (err?.stderr ?? '');
	}
}

function last(re: RegExp, text: string): number | null {
	const m = [...text.matchAll(re)];
	if (!m.length) return null;
	const v = parseFloat(m[m.length - 1]![1]!);
	return Number.isFinite(v) ? v : null;
}

let gateSeq = 0;

async function download(url: string, timeoutMs = 120_000): Promise<string> {
	// pid + counter, not Date.now() alone: two pipeline runs in the same
	// millisecond would otherwise share a path, and the finally-block unlink
	// would delete the other run's file mid-analysis.
	const dest = path.join(os.tmpdir(), `gate_${process.pid}_${Date.now()}_${gateSeq++}.mp4`);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
		fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
		return dest;
	} finally {
		clearTimeout(timer);
	}
}

function probeDuration(file: string): number {
	const out = execSync(
		`ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`,
		{ encoding: 'utf8', timeout: 60_000 },
	);
	const v = parseFloat(out.trim());
	if (!Number.isFinite(v)) throw new Error('could not read duration');
	return v;
}

/**
 * Coefficient of variation of shot lengths — low CV means every cut is the same
 * length, which is what "automated" looks like.
 *
 * This is computed from the EDIT PLAN'S clip lengths, not from the pixels.
 * Pixel-based scene detection cannot see this pipeline's cuts: Remotion renders
 * through TransitionSeries, and a soft transition's frame-to-frame delta never
 * reaches a scene threshold. Measured on a real 18.5s multi-clip render:
 *   scene>0.18 -> 1 cut     (misses every transition)
 *   scene>0.08 -> 24 cuts   (now counting camera motion, not edits)
 *   scene>0.04 -> 72 cuts
 * There is no threshold that counts edit cuts on this content, because the
 * signal is subject motion, not edit structure. The plan already knows the
 * answer exactly, so ask it.
 */
export function cutRhythmFromPlan(clipLengths: number[]): number | null {
	const lens = clipLengths.filter((n) => Number.isFinite(n) && n > 0);
	if (lens.length < 2) return null;   // null = not assessable, NOT a failure
	const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
	if (!mean) return null;
	const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
	return sd / mean;
}

/**
 * Measure a rendered video. Accepts an https URL (the S3 render output) or a
 * local path. Downloads to /tmp and cleans up after itself.
 */
export async function gateRender(
	urlOrPath: string,
	thresholds: GateThresholds = PUBLISH_THRESHOLDS,
	/**
	 * Clip lengths (seconds) from the edit plan. Cut rhythm is derived from
	 * these, not from pixels. Omit and the rhythm check is SKIPPED, not failed —
	 * see OPTIONAL_METRICS.
	 */
	plannedClipLengths?: number[],
): Promise<GateResult> {
	const isUrl = /^https?:\/\//i.test(urlOrPath);
	const file = isUrl ? await download(urlOrPath) : urlOrPath;

	try {
		const durationSec = probeDuration(file);

		const loud = ff(`-i "${file}" -af ebur128=peak=true -f null -`);
		const integratedLufs = last(/I:\s+(-?[\d.]+)\s+LUFS/g, loud);
		const loudnessRangeLu = last(/LRA:\s+(-?[\d.]+)\s+LU/g, loud);
		const truePeakDbtp = last(/Peak:\s+(-?[\d.]+)\s+dBFS/g, loud);

		// freezedetect reports every run of visually identical frames — this is
		// how the min-clip-clamp freeze frames become visible without a model.
		// freezedetect only emits freeze_duration when the freeze ENDS. A freeze
		// that runs to end-of-file — a held final frame, the single most common
		// broken-render shape and the exact thing the min-clip clamp used to
		// produce — emits only freeze_start. Reading durations alone reports 0
		// and passes the check green. Pair any unterminated start with EOF.
		const freeze = ff(`-i "${file}" -vf "freezedetect=n=-60dB:d=1.0" -map 0:v -f null -`);
		const freezeRuns = [...freeze.matchAll(/freeze_duration:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]!));
		const freezeStarts = [...freeze.matchAll(/freeze_start:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]!));
		if (freezeStarts.length > freezeRuns.length) {
			const lastStart = freezeStarts[freezeStarts.length - 1]!;
			if (Number.isFinite(lastStart) && durationSec > lastStart) {
				freezeRuns.push(durationSec - lastStart);   // freeze ran to EOF
			}
		}
		const longestFreezeSec = freezeRuns.length ? Math.max(...freezeRuns) : 0;

		const black = ff(`-i "${file}" -vf "blackdetect=d=0.2:pix_th=0.10" -an -f null -`);
		const blackRuns = [...black.matchAll(/black_duration:([\d.]+)/g)].map((m) => parseFloat(m[1]!));
		const blackFrameSec = blackRuns.reduce((a, b) => a + b, 0);

		const cutLengthCv = plannedClipLengths ? cutRhythmFromPlan(plannedClipLengths) : null;

		const metrics: Record<string, number | null> = {
			durationSec, integratedLufs, loudnessRangeLu, truePeakDbtp,
			longestFreezeSec, blackFrameSec, cutLengthCv,
		};

		const checks: GateCheck[] = (Object.keys(thresholds) as Array<keyof GateThresholds>).map((key) => {
			const [min, max] = thresholds[key];
			const value = metrics[key] ?? null;
			// An OPTIONAL metric with no value is SKIPPED, not failed. Failing on
			// "we could not measure this" is how a gate blocks perfectly good work:
			// cut rhythm needs the edit plan, and a caller that has no plan should
			// not have publication denied over it. Required metrics still fail
			// closed — an unreadable loudness genuinely means something is wrong.
			const optional = OPTIONAL_METRICS.has(key);
			const ok = value === null
				? optional
				: (min === null || min === undefined || value >= min)
					&& (max === null || max === undefined || value <= max);
			return {
				metric: key, label: LABELS[key] ?? key, value,
				min: min ?? undefined, max: max ?? undefined, ok,
				detail: value === null ? (optional ? 'skipped — not assessable' : 'NOT MEASURABLE') : undefined,
			};
		});

		const failures = checks.filter((c) => !c.ok).map((c) => c.metric);
		const pass = failures.length === 0;
		const rhythmNote = cutLengthCv === null ? 'cut CV n/a (no plan)' : `cut CV ${cutLengthCv.toFixed(2)}`;
		const summary = pass
			? `gate PASS — ${integratedLufs?.toFixed(1)} LUFS, peak ${truePeakDbtp?.toFixed(1)} dBTP, ${rhythmNote}`
			: `gate FAIL (${failures.length}): ` + checks.filter((c) => !c.ok)
				.map((c) => `${c.label}=${c.value === null ? 'n/a' : c.value.toFixed(2)}`).join(', ');

		return { pass, checks, failures, metrics, summary };
	} finally {
		if (isUrl) { try { fs.unlinkSync(file); } catch { /* best effort */ } }
	}
}

/** Multi-line report for logs. */
export function formatGateResult(r: GateResult): string {
	const lines = r.checks.map((c) => {
		const bound = [
			c.min !== undefined ? `>= ${c.min}` : null,
			c.max !== undefined ? `<= ${c.max}` : null,
		].filter(Boolean).join(' and ');
		const val = c.value === null ? 'n/a' : c.value.toFixed(2);
		return `  ${c.ok ? 'PASS' : 'FAIL'}  ${c.label.padEnd(24)} ${val.padStart(9)}   (need ${bound})`;
	});
	return [r.pass ? 'RENDER GATE: PASS' : 'RENDER GATE: FAIL', ...lines].join('\n');
}
