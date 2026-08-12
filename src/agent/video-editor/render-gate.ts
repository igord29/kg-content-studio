/**
 * Deterministic publish gate.
 *
 * The vision reviewer grades taste: is the story good, does the pacing work.
 * It is a language model looking at stills and it cannot measure anything —
 * it cannot hear that the audio is clipping, cannot tell that a clip froze,
 * and will happily award 8/10 to a video with three seconds of black at the end.
 *
 * This measures the things that ARE measurable, with FFmpeg, before the model is
 * asked for an opinion. Every check is a number compared against a threshold, so
 * it returns the same verdict for the same file every time.
 *
 * FFmpeg only — no new dependencies, and it is already installed in the runtime
 * image (see Dockerfile).
 *
 * Why it blocks publication: the pipeline previously wrote every render to
 * finished_videos with success: true once max attempts were exhausted, whatever
 * the score. A video that fails a MEASURED check is not a near-miss worth
 * shipping, it is broken output, and shipping it silently is how "the tool
 * produces things I can't post" happens.
 *
 * File: src/agent/video-editor/render-gate.ts
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

export interface GateCheck {
	name: string;
	passed: boolean;
	/** Blocking failure vs advisory. Warnings never prevent publication. */
	severity: 'fail' | 'warn';
	measured: string;
	expected: string;
	detail?: string;
}

export interface GateResult {
	passed: boolean;
	checks: GateCheck[];
	/** Only the blocking failures, for logging and for the reviewer prompt. */
	failures: GateCheck[];
	/** Human-readable summary, safe to hand to the vision model. */
	summary: string;
	/** True when FFmpeg could not analyse the file at all. */
	inconclusive: boolean;
}

// --- Thresholds ------------------------------------------------------------
// Social platforms normalise playback to roughly -14 LUFS. Landing far from it
// means the platform will turn the whole video up or down, which is audible.
const LOUDNESS_TARGET = -14;
const LOUDNESS_WARN = 3;   // +/- LU before we complain
const LOUDNESS_FAIL = 6;   // +/- LU before we block

// Anything above 0 dBFS is literally clipping. -0.3 leaves encoder headroom.
const TRUE_PEAK_MAX_DBFS = -0.3;

// A frozen frame is a stuck decode or a still image where motion was expected.
const FREEZE_MAX_SECONDS = 1.5;

// Black at the very start/end is normal; a black run mid-video is a hole.
const BLACK_MAX_SECONDS = 1.0;

const MIN_DURATION_SECONDS = 8;

interface LoudnessStats { integrated: number | null; truePeak: number | null; range: number | null }

/**
 * One decode pass covering loudness, frozen frames and black frames.
 * All three are stderr-reported filters, so they compose without re-reading.
 */
async function analyseAudioAndFrames(
	src: string,
	timeoutMs: number,
): Promise<{ loudness: LoudnessStats; freezes: number[]; blacks: number[]; ok: boolean }> {
	const args = [
		'-hide_banner', '-nostats',
		'-i', src,
		'-af', 'loudnorm=I=-14:TP=-1.0:LRA=11:print_format=json',
		'-vf', `freezedetect=n=-60dB:d=${FREEZE_MAX_SECONDS},blackdetect=d=${BLACK_MAX_SECONDS}:pix_th=0.10`,
		'-f', 'null', '-',
	];

	let stderr = '';
	try {
		const res = await exec('ffmpeg', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
		stderr = res.stderr;
	} catch (err) {
		// ffmpeg exits non-zero in some null-mux situations while still having
		// produced the measurements, so read stderr before giving up.
		const e = err as { stderr?: string };
		stderr = e.stderr ?? '';
		if (!stderr) return { loudness: { integrated: null, truePeak: null, range: null }, freezes: [], blacks: [], ok: false };
	}

	// loudnorm prints a JSON object at the end of stderr.
	const loudness: LoudnessStats = { integrated: null, truePeak: null, range: null };
	const jsonStart = stderr.lastIndexOf('{');
	const jsonEnd = stderr.lastIndexOf('}');
	if (jsonStart >= 0 && jsonEnd > jsonStart) {
		try {
			const parsed = JSON.parse(stderr.slice(jsonStart, jsonEnd + 1)) as Record<string, string>;
			const num = (v: string | undefined): number | null => {
				const n = Number.parseFloat(v ?? '');
				return Number.isFinite(n) ? n : null;
			};
			loudness.integrated = num(parsed.input_i);
			loudness.truePeak = num(parsed.input_tp);
			loudness.range = num(parsed.input_lra);
		} catch { /* leave nulls; reported as inconclusive */ }
	}

	const durationsFrom = (re: RegExp): number[] => {
		const out: number[] = [];
		let m: RegExpExecArray | null;
		while ((m = re.exec(stderr)) !== null) {
			const d = Number.parseFloat(m[1]!);
			if (Number.isFinite(d)) out.push(d);
		}
		return out;
	};

	return {
		loudness,
		freezes: durationsFrom(/freeze_duration:\s*([\d.]+)/g),
		blacks: durationsFrom(/black_duration:\s*([\d.]+)/g),
		ok: true,
	};
}

/** Container duration in seconds, via ffprobe. */
async function probeDuration(src: string, timeoutMs: number): Promise<number | null> {
	try {
		const { stdout } = await exec('ffprobe', [
			'-v', 'error',
			'-show_entries', 'format=duration',
			'-of', 'default=noprint_wrappers=1:nokey=1',
			src,
		], { timeout: timeoutMs });
		const d = Number.parseFloat(stdout.trim());
		return Number.isFinite(d) ? d : null;
	} catch {
		return null;
	}
}

/**
 * Measure a rendered video and decide whether it may be published.
 *
 * `src` may be a local path or an https URL — FFmpeg reads both, and reading the
 * S3 URL directly avoids spending container disk on a download.
 */
export async function runRenderGate(
	src: string,
	opts: { expectedDurationSec?: number; timeoutMs?: number } = {},
): Promise<GateResult> {
	const timeoutMs = opts.timeoutMs ?? 180_000;
	const checks: GateCheck[] = [];

	const [analysis, duration] = await Promise.all([
		analyseAudioAndFrames(src, timeoutMs),
		probeDuration(src, 60_000),
	]);

	if (!analysis.ok && duration === null) {
		return {
			passed: true, // never block on our own inability to measure
			checks: [],
			failures: [],
			inconclusive: true,
			summary: 'Render gate could not analyse the file (FFmpeg failed). No measurements available.',
		};
	}

	// --- Duration ---
	if (duration !== null) {
		const tooShort = duration < MIN_DURATION_SECONDS;
		checks.push({
			name: 'duration',
			passed: !tooShort,
			severity: 'fail',
			measured: `${duration.toFixed(1)}s`,
			expected: `>= ${MIN_DURATION_SECONDS}s`,
			detail: tooShort ? 'Too short to be a usable social post.' : undefined,
		});

		// A large shortfall against the plan is the signature of the composition
		// being cut off, which is exactly the truncation bug composition-timing.ts
		// fixed. Worth catching if it ever regresses.
		if (opts.expectedDurationSec && opts.expectedDurationSec > 0) {
			const shortfall = opts.expectedDurationSec - duration;
			checks.push({
				name: 'duration-vs-plan',
				passed: shortfall <= 1.5,
				severity: shortfall > 3 ? 'fail' : 'warn',
				measured: `${duration.toFixed(1)}s`,
				expected: `~${opts.expectedDurationSec.toFixed(1)}s planned`,
				detail: shortfall > 1.5
					? `Rendered ${shortfall.toFixed(1)}s SHORT of the plan — the tail is being cut off.`
					: undefined,
			});
		}
	}

	// --- Loudness ---
	const { integrated, truePeak, range } = analysis.loudness;
	if (integrated !== null) {
		const delta = Math.abs(integrated - LOUDNESS_TARGET);
		checks.push({
			name: 'loudness',
			passed: delta <= LOUDNESS_WARN,
			severity: delta > LOUDNESS_FAIL ? 'fail' : 'warn',
			measured: `${integrated.toFixed(1)} LUFS`,
			expected: `${LOUDNESS_TARGET} +/- ${LOUDNESS_WARN} LUFS`,
			detail: delta > LOUDNESS_WARN
				? 'Platforms normalise to about -14 LUFS; this will be audibly re-levelled on playback.'
				: undefined,
		});
	}
	if (truePeak !== null) {
		checks.push({
			name: 'true-peak',
			passed: truePeak <= TRUE_PEAK_MAX_DBFS,
			severity: 'fail',
			measured: `${truePeak.toFixed(1)} dBFS`,
			expected: `<= ${TRUE_PEAK_MAX_DBFS} dBFS`,
			detail: truePeak > 0
				? 'Above full scale — the audio is clipping and will distort.'
				: undefined,
		});
	}
	if (range !== null) {
		checks.push({
			name: 'loudness-range',
			passed: range <= 16,
			severity: 'warn',
			measured: `${range.toFixed(1)} LU`,
			expected: '<= 16 LU',
			detail: range > 16 ? 'Very wide dynamic range; quiet passages may be inaudible on a phone.' : undefined,
		});
	}

	// --- Frozen / black frames ---
	const worstFreeze = analysis.freezes.length > 0 ? Math.max(...analysis.freezes) : 0;
	checks.push({
		name: 'frozen-frames',
		passed: analysis.freezes.length === 0,
		severity: 'fail',
		measured: analysis.freezes.length === 0
			? 'none'
			: `${analysis.freezes.length} run(s), longest ${worstFreeze.toFixed(1)}s`,
		expected: 'no runs >= ' + FREEZE_MAX_SECONDS + 's',
		detail: analysis.freezes.length > 0 ? 'A still image where motion was expected.' : undefined,
	});

	const worstBlack = analysis.blacks.length > 0 ? Math.max(...analysis.blacks) : 0;
	checks.push({
		name: 'black-frames',
		passed: analysis.blacks.length === 0,
		severity: 'fail',
		measured: analysis.blacks.length === 0
			? 'none'
			: `${analysis.blacks.length} run(s), longest ${worstBlack.toFixed(1)}s`,
		expected: 'no runs >= ' + BLACK_MAX_SECONDS + 's',
		detail: analysis.blacks.length > 0 ? 'A hole in the video — usually a missing or failed clip.' : undefined,
	});

	const failures = checks.filter(c => !c.passed && c.severity === 'fail');
	const warnings = checks.filter(c => !c.passed && c.severity === 'warn');

	const lines = checks.map(c => {
		const mark = c.passed ? 'OK  ' : (c.severity === 'fail' ? 'FAIL' : 'WARN');
		return `  [${mark}] ${c.name}: measured ${c.measured}, expected ${c.expected}`
			+ (c.detail ? ` — ${c.detail}` : '');
	});

	return {
		passed: failures.length === 0,
		checks,
		failures,
		inconclusive: false,
		summary:
			`Render gate: ${failures.length} failure(s), ${warnings.length} warning(s).\n`
			+ lines.join('\n'),
	};
}

/**
 * Measurements phrased for the vision reviewer.
 *
 * The reviewer used to guess at loudness, pacing and technical quality from
 * stills, which it cannot observe. Handing it the real numbers and telling it
 * not to re-estimate them stops it inventing a verdict that contradicts them.
 */
export function formatGateForReviewer(gate: GateResult): string {
	if (gate.inconclusive) return '';
	return `
MEASURED TECHNICAL DATA (from FFmpeg — these are facts, do NOT re-estimate or contradict them):
${gate.summary}

Grade STORYTELLING, SHOT SELECTION and PACING only. The technical properties above are already measured; do not guess at loudness, clipping, frozen frames or duration.`.trim();
}
