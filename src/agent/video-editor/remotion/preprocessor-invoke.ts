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
 * Invoke the preprocessor Lambda for a single clip.
 * Uses synchronous invocation (RequestResponse) — waits for result.
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
	const outputS3Key = `temp-clips/${renderPrefix}/processed_${clip.fileId}_${Date.now()}.mp4`;

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

	logger?.info('[preprocessor] Invoking Lambda for %s (trim=%ds, dur=%ds, speed=%sx, stabilize=%s)...',
		clip.filename || clip.fileId, clip.trimStart, clip.duration,
		clip.speed ?? 1.0, clip.stabilize !== false ? 'yes' : 'no');

	const lambda = await getLambdaClient(region);

	// AbortController timeout: 350s (safely above Lambda's 300s max).
	// This replaces NodeHttpHandler's requestTimeout which broke in Bun.
	const abortController = new AbortController();
	const timeout = setTimeout(() => abortController.abort(), 350_000);

	let result;
	try {
		result = await lambda.send(new InvokeCommand({
			FunctionName: functionName,
			InvocationType: 'RequestResponse', // Synchronous — wait for result
			Payload: Buffer.from(JSON.stringify(payload)),
		}), { abortSignal: abortController.signal });
	} finally {
		clearTimeout(timeout);
	}

	// Parse Lambda response
	if (result.FunctionError) {
		const errorPayload = result.Payload
			? JSON.parse(Buffer.from(result.Payload).toString())
			: { errorMessage: 'Unknown Lambda error' };
		throw new Error(`Preprocessor Lambda error for ${clip.filename || clip.fileId}: ${errorPayload.errorMessage || JSON.stringify(errorPayload)}`);
	}

	if (!result.Payload) {
		throw new Error(`Preprocessor Lambda returned no payload for ${clip.filename || clip.fileId}`);
	}

	const response: PreprocessResult = JSON.parse(Buffer.from(result.Payload).toString());

	if (!response.success) {
		throw new Error(`Preprocessor failed for ${clip.filename || clip.fileId}: ${response.error}`);
	}

	logger?.info('[preprocessor] %s processed: %dMB, effectiveDur=%ds, took %dms',
		clip.filename || clip.fileId,
		(response.outputSizeBytes / (1024 * 1024)).toFixed(1),
		response.effectiveDuration.toFixed(1),
		response.processingTimeMs);

	return {
		fileId: clip.fileId,
		inputS3Key: clip.inputS3Key,
		outputS3Key: response.outputS3Key,
		outputS3Url: response.outputS3Url,
		effectiveDuration: response.effectiveDuration,
		outputSizeBytes: response.outputSizeBytes,
		processingTimeMs: response.processingTimeMs,
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
 * Returns true if the env var is set.
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
