/**
 * transcribe-library.ts — Whisper-transcribe the whole source library.
 *
 * This is the highest-return unbuilt feature in the repo. The editor currently
 * has NO access to audio at all: it cannot find a soundbite, cannot avoid
 * cutting mid-sentence, and cannot produce word-level captions — even though
 * TikTokCaptions.tsx is already written and waiting for CaptionWord[].
 *
 * ~627 minutes of footage at $0.006/min is roughly $4 to transcribe everything.
 * Set GROQ_API_KEY to route through Groq's whisper-large-v3 instead (~3x cheaper).
 *
 *   bun tools/transcribe-library.ts              # all uncatalogued clips
 *   bun tools/transcribe-library.ts --limit 5    # try it on five first
 *   bun tools/transcribe-library.ts --force      # re-transcribe everything
 *
 * Writes transcripts/<fileId>.json and updates the catalog in place.
 * Safe to interrupt and re-run: it skips anything already done.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import OpenAI from 'openai';
import { downloadVideo, type CatalogEntry } from '../src/agent/video-editor/google-drive';
import { loadExistingCatalog } from '../src/agent/video-editor/cataloger';

const TRANSCRIPT_DIR = process.env.TRANSCRIPT_DIR || 'transcripts';
const CATALOG_PATH = process.env.CATALOG_PATH || 'catalog.json';
const TMP = process.env.TMPDIR || '/tmp';
// With GROQ_API_KEY set, transcription goes through Groq's OpenAI-compatible
// endpoint (whisper-large-v3, ~3x cheaper, same word+segment timestamps).
// Without it, nothing changes: OpenAI whisper-1 as before.
const GROQ_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.WHISPER_MODEL || (GROQ_KEY ? 'whisper-large-v3' : 'whisper-1');

export interface CaptionWord {
	text: string;
	startMs: number;
	endMs: number;
}

export interface ClipTranscript {
	fileId: string;
	filename: string;
	/** Full flat text — cheap to grep, cheap to put in a prompt. */
	text: string;
	/** Sentence-level, for finding a soundbite you can cut cleanly around. */
	segments: Array<{ start: number; end: number; text: string }>;
	/** Word-level, for karaoke captions and for never cutting mid-word. */
	words: CaptionWord[];
	durationSec: number;
	/** true when the track is effectively silent — skip these downstream. */
	silent: boolean;
}

// maxRetries: 0 — withRetry below is the single retry layer; the SDK's own
// retries would otherwise stack under it (up to 4x3 requests per clip).
const client = GROQ_KEY
	? new OpenAI({ apiKey: GROQ_KEY, baseURL: 'https://api.groq.com/openai/v1', maxRetries: 0 })
	: new OpenAI({ maxRetries: 0 });

/**
 * Groq rate-limits by audio-seconds and OpenAI by requests; either can 429
 * mid-batch. Honor Retry-After when present (capped so a pathological header
 * can't stall the run), otherwise back off exponentially. Retries rate-limit,
 * server, and connection errors — a 400 fails fast.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 4): Promise<T> {
	for (let i = 1; ; i++) {
		try {
			return await fn();
		} catch (err: any) {
			const status = err?.status;
			const retryable = status === 429 || (status >= 500 && status < 600)
				|| err instanceof OpenAI.APIConnectionError;
			if (!retryable || i >= attempts) throw err;
			// openai v6 exposes a WHATWG Headers instance; bracket access would be undefined.
			const h = err?.headers;
			const retryAfter = Number(typeof h?.get === 'function' ? h.get('retry-after') : h?.['retry-after']);
			const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
				? Math.min(retryAfter * 1000, 120_000)
				: 2000 * 2 ** (i - 1);
			console.warn(`[transcribe] ${label}: ${status ?? err?.name ?? 'error'}, retry ${i}/${attempts - 1} in ${Math.round(waitMs / 1000)}s`);
			await new Promise((r) => setTimeout(r, waitMs));
		}
	}
}

/** Pull a compressed mono 16k track out of the video. Whisper wants nothing more. */
function extractAudio(videoPath: string, outPath: string): boolean {
	try {
		execSync(
			`ffmpeg -y -loglevel error -i "${videoPath}" -vn -ac 1 -ar 16000 -c:a libmp3lame -q:a 6 "${outPath}"`,
			{ timeout: 180_000, stdio: 'pipe' },
		);
		return fs.existsSync(outPath) && fs.statSync(outPath).size > 2048;
	} catch {
		return false;
	}
}

/** Mean volume in dB. Below the floor there is no speech worth paying for. */
function isEffectivelySilent(audioPath: string, floorDb = -46): boolean {
	try {
		const out = execSync(
			`ffmpeg -hide_banner -nostats -i "${audioPath}" -af volumedetect -f null - 2>&1`,
			{ encoding: 'utf8', timeout: 60_000 },
		);
		const m = out.match(/mean_volume:\s*(-?[\d.]+) dB/);
		return m ? parseFloat(m[1]!) < floorDb : false;
	} catch {
		return false;
	}
}

async function transcribeOne(entry: CatalogEntry): Promise<ClipTranscript | null> {
	const fileId = entry.fileId!;
	const videoPath = path.join(TMP, `${fileId}.mp4`);
	const audioPath = path.join(TMP, `${fileId}.mp3`);

	try {
		if (!fs.existsSync(videoPath)) await downloadVideo(fileId, videoPath);
		if (!extractAudio(videoPath, audioPath)) {
			console.warn(`[transcribe] ${entry.filename}: no usable audio track, skipping`);
			return null;
		}

		if (isEffectivelySilent(audioPath)) {
			console.log(`[transcribe] ${entry.filename}: silent, skipping the API call`);
			return {
				fileId, filename: entry.filename ?? '', text: '', segments: [], words: [],
				durationSec: 0, silent: true,
			};
		}

		const res: any = await withRetry(
			() => client.audio.transcriptions.create({
				file: fs.createReadStream(audioPath) as any,
				model: MODEL,
				response_format: 'verbose_json',
				timestamp_granularities: ['word', 'segment'],
			}),
			entry.filename ?? fileId,
		);

		return {
			fileId,
			filename: entry.filename ?? '',
			text: (res.text ?? '').trim(),
			segments: (res.segments ?? []).map((s: any) => ({
				start: s.start, end: s.end, text: (s.text ?? '').trim(),
			})),
			words: (res.words ?? []).map((w: any) => ({
				text: w.word, startMs: Math.round(w.start * 1000), endMs: Math.round(w.end * 1000),
			})),
			durationSec: res.duration ?? 0,
			silent: false,
		};
	} catch (err) {
		console.error(`[transcribe] ${entry.filename}: ${(err as Error).message}`);
		return null;
	} finally {
		for (const p of [videoPath, audioPath]) {
			try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* best effort */ }
		}
	}
}

/**
 * Pick the lines worth building an edit around. Short fragments and filler are
 * noise; what you want is a complete thought a kid or coach actually said.
 */
export function pickSoundbites(t: ClipTranscript, minWords = 5, maxSec = 12) {
	return t.segments
		.filter((s) => {
			const dur = s.end - s.start;
			const words = s.text.split(/\s+/).filter(Boolean).length;
			return words >= minWords && dur > 0.8 && dur <= maxSec && /[a-z]{3}/i.test(s.text);
		})
		.map((s) => ({ ...s, durationSec: +(s.end - s.start).toFixed(2) }));
}

async function main() {
	const args = process.argv.slice(2);
	const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
	const force = args.includes('--force');

	fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
	const catalog = loadExistingCatalog();
	if (!catalog.length) {
		console.error('No catalog found. Run the cataloger first.');
		process.exit(1);
	}

	const todo = catalog.filter((e) => {
		if (!e.fileId) return false;
		return force || !fs.existsSync(path.join(TRANSCRIPT_DIR, `${e.fileId}.json`));
	}).slice(0, limit);

	console.log(`[transcribe] provider: ${GROQ_KEY ? 'groq' : 'openai'}, model: ${MODEL}`);
	console.log(`[transcribe] ${catalog.length} clips in catalog, ${todo.length} to process`);
	let done = 0, spoken = 0, silent = 0, failed = 0;

	for (const entry of todo) {
		const t = await transcribeOne(entry);
		if (!t) { failed++; continue; }
		fs.writeFileSync(path.join(TRANSCRIPT_DIR, `${t.fileId}.json`), JSON.stringify(t, null, 2));

		// Fold the useful parts back into the catalog so the editor sees them.
		const bites = pickSoundbites(t);
		(entry as any).transcript = t.text.slice(0, 4000);
		(entry as any).soundbites = bites.slice(0, 12);
		(entry as any).hasSpeech = !t.silent && t.text.length > 20;

		done++;
		t.silent ? silent++ : spoken++;
		if (bites.length) {
			console.log(`[transcribe] ${entry.filename}: ${bites.length} soundbite(s) — "${bites[0]!.text.slice(0, 70)}"`);
		}
		if (done % 10 === 0) {
			fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));
			console.log(`[transcribe] checkpoint: ${done}/${todo.length}`);
		}
	}

	fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));
	console.log(`\n[transcribe] done. ${done} processed — ${spoken} with speech, ${silent} silent, ${failed} failed/skipped (re-run to retry those).`);
	console.log(`[transcribe] transcripts in ${TRANSCRIPT_DIR}/, catalog updated at ${CATALOG_PATH}`);
}

if (import.meta.main) {
	main().catch((e) => { console.error(e); process.exit(1); });
}
