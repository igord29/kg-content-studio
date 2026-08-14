/**
 * Preprocessor Lambda Client
 *
 * Invokes the dedicated FFmpeg preprocessor Lambda for each video clip.
 * Runs clips sequentially (concurrency 1) to minimize memory on the
 * resource-constrained Railway server.
 *
 * This runs on the Agentuity server. It:
 *   1. Takes raw clips already uploaded to S3 (from uploadClipsToS3)
 *   2. Invokes the preprocessor Lambda for each clip (FFmpeg deshake + sharpen + trim)
 *   3. Returns processed S3 URLs that Remotion Lambda can fetch
 *
 * IMPORTANT: Uses a single shared LambdaClient across all invocations.
 * Creating a new client per clip wastes ~50MB each (TLS context, connection
 * pool, HTTPS agent) which crashed the Railway server on 7-clip renders.
 *
 * File: src/agent/video-editor/remotion/preprocessor-invoke.ts
 */

import type { PreprocessRequest, PreprocessResult } from './preprocessor-lambda';
import type { S3UploadedClip } from './s3-upload';

// --- Types ---

interface Logger {
	info: (...args: any[]) => void;
	error?: (...args: any[]) => void;
	warn?: (...args: any[]) => void;
}

export interface PreprocessorClipConfig {
	fileId: string;              // Google Drive file ID (matches key in S3 upload map)
	filename?: string;           // For logging
	inputS3Key: string;          // S3 key of the raw uploaded clip
	trimStart: number;           // Seconds into source to start
	duration: number;            // Seconds of source to use
	speed?: number;              // Playback speed multiplier (default 1.0)
	sharpen?: boolean;           // Apply unsharp filter (default true)
	stabilize?: boolean;         // Apply deshake filter (default false — CPU-heavy, causes Lambda timeouts)
	// Smart-crop inputs (optional — when set, Lambda reframes to targetAspect using subjectPosition):
	targetAspect?: '9:16' | '1:1' | '4:5' | '16:9';
	subjectPosition?: string;    // e.g., 'bottom-center' — from GPT-4o cataloger
	sourceWidth?: number;        // Display width (after rotation)
	sourceHeight?: number;       // Display height (after rotation)
	extraZoom?: number;          // >1.0 tightens framing on subject (content-type driven)
	subjectFillRatio?: number;   // 0-1 from the cataloger's vision pass — drives extraZoom (see deriveExtraZoom).
	                             // Not sent to the Lambda; it only ever sees the resolved extraZoom.
	// Remotion-only metadata — not used by the Lambda; forwarded on the result
	// so render.ts can feed VideoClip without re-correlating clips from the edit plan.
	effect?: string;
	filter?: string;
	transitionType?: string;
	transitionDirection?: string;
	speedKeyframes?: Array<{ at: number; speed: number }>;
}

export interface PreprocessedS3Clip {
	fileId: string;              // Original Google Drive file ID
	inputS3Key: string;          // S3 key of raw clip
	outputS3Key: string;         // S3 key of processed clip
	outputS3Url: string;         // Full S3 URL of processed clip
	effectiveDuration: number;   // Duration after speed change
	outputSizeBytes: number;
	processingTimeMs: number;
	// Passthrough metadata — forwarded from edit plan so render.ts can feed
	// Remotion's VideoClip (effect, filter, transitions) without re-correlating clips.
	effect?: string;
	filter?: string;
	transitionType?: string;
	transitionDirection?: string;
	speedKeyframes?: Array<{ at: number; speed: number }>;
	originalTrimStart?: number;  // For audit / debugging — what source timestamp this came from
}

// --- Shared Lambda Client ---

/**
 * Cached LambdaClient — reused across all clip invocations.
 * Creating a new client per clip wasted ~50MB each (TLS context,
 * HTTPS agent, connection pool) and crashed the Railway server.
 */
let cachedLambdaClient: any = null;

async function getLambdaClient(region: string): Promise<any> {
	if (cachedLambdaClient) return cachedLambdaClient;

	const { LambdaClient } = await import('@aws-sdk/client-lambda');

	// DO NOT use NodeHttpHandler — Bun's Node.js HTTP compatibility layer
	// causes "socket hang up" on every Lambda invocation. The default SDK
	// handler uses Bun's native fetch which works correctly.
	cachedLambdaClient = new LambdaClient({
		region,
		credentials: {
			accessKeyId: process.env.REMOTION_AWS_ACCESS_KEY_ID!,
			secretAccessKey: process.env.REMOTION_AWS_SECRET_ACCESS_KEY!,
		},
	});

	return cachedLambdaClient;
}

// --- Preprocessor Invocation ---

/**
 * Get the preprocessor Lambda function name from env var.
 */
function getPreprocessorFunctionName(): string {
	const name = process.env.PREPROCESSOR_FUNCTION_NAME;
	if (!name) {
		throw new Error(
			'PREPROCESSOR_FUNCTION_NAME env var not set. Run: bun scripts/deploy-preprocessor-lambda.ts'
		);
	}
	return name;
}

/**
 * Poll S3 for a processed clip to appear. The preprocessor Lambda writes
 * the output to a known S3 key — we just check until it exists.
 */
async function pollS3ForClip(
	bucketName: string,
	outputS3Key: string,
	region: string,
	maxWaitMs: number = 300_000,
	pollIntervalMs: number = 5_000,
	logger?: Logger,
): Promise<{ sizeBytes: number }> {
	const { S3Client, HeadObjectCommand } = await import('@aws-sdk/client-s3');
	const s3 = new S3Client({
		region,
		credentials: {
			accessKeyId: process.env.REMOTION_AWS_ACCESS_KEY_ID!,
			secretAccessKey: process.env.REMOTION_AWS_SECRET_ACCESS_KEY!,
		},
	});

	const startTime = Date.now();
	let attempts = 0;

	while (Date.now() - startTime < maxWaitMs) {
		attempts++;
		try {
			const head = await s3.send(new HeadObjectCommand({
				Bucket: bucketName,
				Key: outputS3Key,
			}));
			// File exists — preprocessing is done
			return { sizeBytes: head.ContentLength || 0 };
		} catch (err: any) {
			if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
				// Not ready yet — wait and retry
				if (attempts % 6 === 0) {
					const elapsed = Math.round((Date.now() - startTime) / 1000);
					logger?.info('[preprocessor] Still waiting for %s (%ds elapsed)...', outputS3Key.split('/').pop(), elapsed);
				}
				await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
			} else {
				throw err;
			}
		}
	}

	throw new Error(`Preprocessor timed out after ${Math.round(maxWaitMs / 1000)}s waiting for ${outputS3Key}`);
}

/**
 * Invoke the preprocessor Lambda for a single clip.
 * Uses ASYNC invocation (Event) + S3 polling to avoid Bun's socket timeout.
 *
 * Flow:
 *   1. Fire Lambda with InvocationType='Event' (returns 202 immediately)
 *   2. Lambda runs FFmpeg in background (60-120s)
 *   3. Lambda writes processed clip to predictable S3 key
 *   4. We poll S3 with HeadObject until the file appears
 */
async function invokePreprocessorForClip(
	clip: PreprocessorClipConfig,
	bucketName: string,
	region: string,
	renderPrefix: string,
	logger?: Logger,
): Promise<PreprocessedS3Clip> {
	const { InvokeCommand } = await import('@aws-sdk/client-lambda');

	const functionName = getPreprocessorFunctionName();
	// Use a deterministic key so we know where to poll
	const outputS3Key = `temp-clips/${renderPrefix}/processed_${clip.fileId}_t${clip.trimStart}.mp4`;

	const payload: PreprocessRequest = {
		bucketName,
		region,
		inputS3Key: clip.inputS3Key,
		outputS3Key,
		trimStart: clip.trimStart,
		duration: clip.duration,
		speed: clip.speed,
		sharpen: clip.sharpen,
		stabilize: clip.stabilize,
		targetAspect: clip.targetAspect,
		subjectPosition: clip.subjectPosition,
		sourceWidth: clip.sourceWidth,
		sourceHeight: clip.sourceHeight,
		extraZoom: clip.extraZoom,
	};

	logger?.info('[preprocessor] Firing async Lambda for %s (trim=%ds, dur=%ds, speed=%sx, stabilize=%s, aspect=%s, subject=%s, fill=%s, zoom=%sx)...',
		clip.filename || clip.fileId, clip.trimStart, clip.duration,
		clip.speed ?? 1.0, clip.stabilize === true ? 'yes' : 'no',
		clip.targetAspect || 'source',
		// Show explicitly when subjectPosition is unset vs explicitly 'center'
		// so we can distinguish "lookup failed" from "catalog says center."
		clip.subjectPosition === undefined ? 'UNSET→center' : clip.subjectPosition,
		// fill drives zoom (see deriveExtraZoom) — log both so an over-zoomed or
		// under-zoomed clip traces back to the cataloger's fill estimate.
		typeof clip.subjectFillRatio === 'number' ? clip.subjectFillRatio.toFixed(3) : 'UNSET',
		(clip.extraZoom ?? 1.0).toFixed(2));

	const lambda = await getLambdaClient(region);
	const startTime = Date.now();

	// Fire-and-forget: InvocationType 'Event' returns 202 immediately.
	// The Lambda runs asynchronously — no socket to hang up.
	const result = await lambda.send(new InvokeCommand({
		FunctionName: functionName,
		InvocationType: 'Event',
		Payload: Buffer.from(JSON.stringify(payload)),
	}));

	if (result.StatusCode !== 202) {
		throw new Error(`Preprocessor async invoke failed for ${clip.filename || clip.fileId}: status ${result.StatusCode}`);
	}

	logger?.info('[preprocessor] Lambda invoked (202). Polling S3 for output: %s', outputS3Key.split('/').pop());

	// Poll S3 until the processed clip appears (up to 5 minutes)
	const { sizeBytes } = await pollS3ForClip(bucketName, outputS3Key, region, 300_000, 5_000, logger);

	const elapsed = Date.now() - startTime;
	const outputS3Url = `https://${bucketName}.s3.${region}.amazonaws.com/${outputS3Key}`;
	const effectiveDuration = clip.duration / (clip.speed ?? 1.0);

	logger?.info('[preprocessor] %s ready: %dMB, effectiveDur=%ds, total=%dms',
		clip.filename || clip.fileId,
		(sizeBytes / (1024 * 1024)).toFixed(1),
		effectiveDuration.toFixed(1),
		elapsed);

	return {
		fileId: clip.fileId,
		inputS3Key: clip.inputS3Key,
		outputS3Key,
		outputS3Url,
		effectiveDuration,
		outputSizeBytes: sizeBytes,
		processingTimeMs: elapsed,
		// Forward edit-plan metadata so render.ts can wire Remotion effects without re-correlating.
		effect: clip.effect,
		filter: clip.filter,
		transitionType: clip.transitionType,
		transitionDirection: clip.transitionDirection,
		speedKeyframes: clip.speedKeyframes,
		originalTrimStart: clip.trimStart,
	};
}

/**
 * Invoke the preprocessor Lambda for multiple clips.
 *
 * Fires ALL Lambdas in PARALLEL (async invocation returns instantly),
 * then polls S3 for all outputs simultaneously. This is dramatically
 * faster than sequential processing: 11 clips finish in ~120s total
 * instead of ~120s × 11 = ~22 minutes.
 *
 * @param clips - Clip configs with S3 keys from raw upload
 * @param bucketName - S3 bucket (same as Remotion bucket)
 * @param region - AWS region
 * @param logger - Optional logger
 * @returns Array of preprocessed clip results
 */
export async function invokePreprocessorForClips(
	clips: PreprocessorClipConfig[],
	bucketName: string,
	region: string,
	logger?: Logger,
): Promise<PreprocessedS3Clip[]> {
	const renderPrefix = `render_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

	logger?.info('[preprocessor] Preprocessing %d clips via Lambda (PARALLEL fire + poll, prefix=%s)...',
		clips.length, renderPrefix);
	const startTime = Date.now();

	// Warm up the shared Lambda client once before firing
	await getLambdaClient(region);

	// Fire ALL Lambdas in parallel — each returns 202 instantly
	const promises = clips.map((clip) =>
		invokePreprocessorForClip(clip, bucketName, region, renderPrefix, logger)
			.catch((err): PreprocessedS3Clip | null => {
				const msg = err instanceof Error ? err.message : String(err);
				logger?.error?.('[preprocessor] Failed to preprocess %s: %s', clip.filename || clip.fileId, msg);
				return null;
			}),
	);

	const settled = await Promise.all(promises);
	const results = settled.filter((r): r is PreprocessedS3Clip => r !== null);
	const failedCount = settled.length - results.length;

	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
	const totalOutputSize = results.reduce((s, r) => s + r.outputSizeBytes, 0);

	logger?.info('[preprocessor] Preprocessing complete: %d/%d clips, %dMB total output, %ss (parallel)',
		results.length, clips.length,
		(totalOutputSize / (1024 * 1024)).toFixed(0), elapsed);

	if (failedCount > 0 && results.length === 0) {
		throw new Error(`All ${failedCount} clips failed to preprocess`);
	}
	if (failedCount > 0) {
		logger?.warn?.('[preprocessor] %d/%d clips failed preprocessing — continuing with %d successful clips',
			failedCount, clips.length, results.length);
	}

	return results;
}

/**
 * Check if the preprocessor Lambda is available.
 *
 * Re-enabled: switched from synchronous invocation (which caused Bun socket
 * timeouts) to async invocation (InvocationType: 'Event') + S3 polling.
 * The Lambda fires instantly and we poll for the result — no long-lived
 * HTTP connections needed.
 */
export function isPreprocessorAvailable(): boolean {
	return !!process.env.PREPROCESSOR_FUNCTION_NAME;
}

/**
 * Per-mode default extraZoom applied during smart crop.
 *
 * Tightens the framing on whatever the catalog's subjectPosition points at.
 * Why mode-based and not catalog-contentType-based: the director picks clips
 * across all content types (wide action, reaction shots, establishing, b-roll)
 * so a single mode-wide default gives consistent visual tone without needing
 * the director to remember to set per-clip zoom. Values tuned for vertical
 * (9:16) output where empty court / sidelines make the subject feel distant.
 *
 * game_day:  1.25 — tennis action, subjects tend to be ~50% of source height,
 *                    needs extra zoom to feel punchy on phone screens
 * quick_hit: 1.30 — punchiest; social-native, fast-read
 * our_story: 1.15 — subtle; preserves environment for emotional context
 * showcase:  1.15 — subtle; preserves the "showing off the program" wide view
 */
const MODE_DEFAULT_EXTRA_ZOOM: Record<string, number> = {
	game_day:  1.35,  // Bumped from 1.25 — tighter crop hides shake at frame edges
	                  // and pulls focus onto the player. Trade-off: less venue context,
	                  // but smart-crop with bottom-center subjectPosition centers on
	                  // the player so the zoom doesn't push them out of frame.
	quick_hit: 1.40,  // Bumped from 1.30 — same reasoning, even punchier for fast social
	our_story: 1.18,  // Slight bump — preserve environment but tighten slightly
	showcase:  1.18,  // Slight bump — keep wide context for the program-showcase feel
};

/**
 * Punch-in should be driven by how small the subject actually is, not by mode.
 * subjectFillRatio comes from the cataloger's vision pass (0-1).
 * A kid filling 5% of a wide frame needs a real push; a close-up needs none.
 * The mode value acts as a floor so each mode keeps its baseline character.
 */
/** Empirically the point where a 9:16 crop from 2K source starts to visibly soften. */
const MAX_DERIVED_ZOOM = 3.0;

function deriveExtraZoom(subjectFillRatio: number | undefined, modeZoom: number): number {
	if (typeof subjectFillRatio !== 'number' || !Number.isFinite(subjectFillRatio)) return modeZoom;
	const r = Math.max(0, Math.min(1, subjectFillRatio));
	// Target ~40% of frame area. Raised from 27% after measuring the actual
	// degradation: a punch-in ladder on delivered footage stays clean through
	// 2.2x and is acceptable at 3.0x — and that test punched into the ALREADY
	// cropped 1080x1920 output. From the 2560x1440 source there is more headroom
	// again. 27% was leaving the cheapest available quality win unclaimed:
	// measured median subject size on shipped video was 1.0%-13.4% of frame.
	// Area scales with zoom^2, so linear zoom is the sqrt of the area ratio.
	const TARGET_FILL = 0.40;
	const needed = r > 0.005 ? Math.sqrt(TARGET_FILL / r) : 3.0;
	return Math.max(modeZoom, Math.min(MAX_DERIVED_ZOOM, needed));
}

/**
 * Nudged framings used to make repeated cuts from ONE locked-off wide shot read
 * as different cameras. Order matters: the first use of a source keeps whatever
 * the cataloger said, and later uses step through these.
 */
const FRAMING_VARIANTS = ['center', 'left', 'right', 'bottom-center', 'top-center'] as const;

/**
 * Give clips that share a source different framings.
 *
 * The library is 247 clips averaging 152 seconds, most of them locked-off wide
 * shots — 0 clips in the catalog describe a close-up or a reaction. A single
 * static wide shot is the only coverage available for a whole beat, so when an
 * edit cuts back to the same source twice it currently shows the identical
 * framing twice and reads as a mistake.
 *
 * Varying the crop window turns one wide master into several apparent shots:
 * the wide, the punch to the near player, the push toward the coach. This is
 * the standard documentary answer to thin coverage, and it costs nothing
 * because the preprocessor is already cropping every clip anyway.
 *
 * Deterministic (index-based, no randomness) so the same plan always renders
 * the same way and a re-render is comparable to the last one.
 */
export function diversifyFraming<T extends { fileId?: string; subjectPosition?: string; extraZoom?: number }>(
	clips: T[],
): T[] {
	const seen = new Map<string, number>();
	return clips.map((clip) => {
		const id = clip.fileId;
		if (!id) return clip;
		const n = seen.get(id) ?? 0;
		seen.set(id, n + 1);
		if (n === 0) return clip;   // first use keeps the cataloger's framing

		// Later uses step through variants and tighten slightly, so a repeat is
		// both differently placed AND differently sized — one alone still reads
		// as the same shot.
		const variant = FRAMING_VARIANTS[n % FRAMING_VARIANTS.length]!;
		const tighten = 1 + Math.min(n, 3) * 0.22;
		const base = typeof clip.extraZoom === 'number' ? clip.extraZoom : 1.0;
		return {
			...clip,
			subjectPosition: variant,
			extraZoom: Math.min(MAX_DERIVED_ZOOM, Math.max(base, base * tighten)),
		};
	});
}

/**
 * Build preprocessor clip configs from edit plan clips and raw S3 upload results.
 *
 * Maps each edit plan clip to its S3 key from the raw upload,
 * and adds preprocessing params (stabilize, sharpen, trim, speed, smart crop).
 *
 * Stabilize defaults to FALSE: FFmpeg deshake on 2K source at 2048MB Lambda
 * routinely blows past the 300s timeout. Opt in per-clip if you need it.
 */
export function buildPreprocessorConfigs(
	clips: Array<{
		fileId: string;
		filename?: string;
		trimStart?: number;
		duration?: number;
		speed?: number;
		subjectPosition?: string;
		effect?: string;
		filter?: string;
		transitionType?: string;
		transitionDirection?: string;
		speedKeyframes?: Array<{ at: number; speed: number }>;
		extraZoom?: number;  // Per-clip override from director; wins over the derived zoom.
		subjectFillRatio?: number;  // 0-1 from the cataloger; derives extraZoom when no override.
		stabilize?: boolean;        // Opt in per-clip; see note above — default stays off.
	}>,
	s3Clips: Map<string, S3UploadedClip>,
	defaultDuration: number = 5,
	targetAspect?: '9:16' | '1:1' | '4:5' | '16:9',
	mode: string = 'game_day',
): PreprocessorClipConfig[] {
	const modeExtraZoom = MODE_DEFAULT_EXTRA_ZOOM[mode] ?? MODE_DEFAULT_EXTRA_ZOOM['game_day']!;
	// Repeated cuts from one locked-off wide shot get different framings so they
	// read as different cameras rather than the same shot pasted twice.
	// Applied BEFORE zoom derivation so a diversified clip's tightened zoom is
	// treated as an explicit override and survives.
	return diversifyFraming(clips).map((clip) => {
		const s3Info = s3Clips.get(clip.fileId);
		if (!s3Info) {
			throw new Error(`S3 upload missing for clip ${clip.fileId} — was it uploaded?`);
		}

		return {
			fileId: clip.fileId,
			filename: clip.filename,
			inputS3Key: s3Info.s3Key,
			trimStart: clip.trimStart || 0,
			duration: clip.duration || defaultDuration,
			speed: clip.speed,
			sharpen: true,       // Phone footage benefits from light sharpening.
			// Default stays OFF (deshake on 2K source @ 2048MB Lambda times out), but
			// the documented per-clip opt-in is now actually reachable instead of being
			// overwritten by a hardcoded false.
			stabilize: clip.stabilize === true,
			targetAspect,
			subjectPosition: clip.subjectPosition,
			sourceWidth: s3Info.width,
			sourceHeight: s3Info.height,
			// Tighten framing — explicit per-clip override wins, else derive from how
			// small the subject actually is, with the mode default as a floor.
			extraZoom: typeof clip.extraZoom === 'number'
				? clip.extraZoom
				: deriveExtraZoom(clip.subjectFillRatio, modeExtraZoom),
			subjectFillRatio: clip.subjectFillRatio,
			// Remotion-only metadata forwarded on the preprocess result:
			effect: clip.effect,
			filter: clip.filter,
			transitionType: clip.transitionType,
			transitionDirection: clip.transitionDirection,
			speedKeyframes: clip.speedKeyframes,
		};
	});
}
