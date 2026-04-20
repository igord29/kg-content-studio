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
	stabilize?: boolean;         // Apply deshake filter (default true)
}

export interface PreprocessedS3Clip {
	fileId: string;              // Original Google Drive file ID
	inputS3Key: string;          // S3 key of raw clip
	outputS3Key: string;         // S3 key of processed clip
	outputS3Url: string;         // Full S3 URL of processed clip
	effectiveDuration: number;   // Duration after speed change
	outputSizeBytes: number;
	processingTimeMs: number;
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
	};

	logger?.info('[preprocessor] Firing async Lambda for %s (trim=%ds, dur=%ds, speed=%sx, stabilize=%s)...',
		clip.filename || clip.fileId, clip.trimStart, clip.duration,
		clip.speed ?? 1.0, clip.stabilize !== false ? 'yes' : 'no');

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
	};
}

/**
 * Invoke the preprocessor Lambda for multiple clips.
 *
 * Processes clips SEQUENTIALLY (concurrency 1) to minimize memory pressure
 * on the Railway server. Each Lambda invocation is just an HTTP call (~5KB),
 * but the server must stay alive for the full duration (up to 300s per clip).
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

	logger?.info('[preprocessor] Preprocessing %d clips via Lambda (sequential, prefix=%s)...',
		clips.length, renderPrefix);
	const startTime = Date.now();

	// Warm up the shared Lambda client once before processing clips
	await getLambdaClient(region);

	const results: PreprocessedS3Clip[] = [];
	const errors: string[] = [];

	// Process clips one at a time to minimize server memory usage.
	// Lambda does all the heavy work — we're just waiting on HTTP responses.
	for (let i = 0; i < clips.length; i++) {
		const clip = clips[i]!;

		logger?.info('[preprocessor] Processing clip %d/%d...', i + 1, clips.length);

		try {
			const result = await invokePreprocessorForClip(clip, bucketName, region, renderPrefix, logger);
			results.push(result);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			errors.push(`${clip.filename || clip.fileId}: ${msg}`);
			logger?.error?.('[preprocessor] Failed to preprocess %s: %s', clip.filename || clip.fileId, msg);
		}
	}

	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
	const totalOutputSize = results.reduce((s, r) => s + r.outputSizeBytes, 0);

	logger?.info('[preprocessor] Preprocessing complete: %d/%d clips, %dMB total output, %ss',
		results.length, clips.length,
		(totalOutputSize / (1024 * 1024)).toFixed(0), elapsed);

	if (errors.length > 0) {
		throw new Error(`Failed to preprocess ${errors.length} clips:\n${errors.join('\n')}`);
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
 * Build preprocessor clip configs from edit plan clips and raw S3 upload results.
 *
 * Maps each edit plan clip to its S3 key from the raw upload,
 * and adds preprocessing params (stabilize, sharpen, trim, speed).
 */
export function buildPreprocessorConfigs(
	clips: Array<{
		fileId: string;
		filename?: string;
		trimStart?: number;
		duration?: number;
		speed?: number;
	}>,
	s3Clips: Map<string, S3UploadedClip>,
	defaultDuration: number = 5,
): PreprocessorClipConfig[] {
	return clips.map((clip) => {
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
			sharpen: true,      // Always sharpen phone footage
			stabilize: true,    // Always stabilize for Enhanced render
		};
	});
}
