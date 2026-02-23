/**
 * Preprocessor Lambda Client
 *
 * Invokes the dedicated FFmpeg preprocessor Lambda for each video clip.
 * Runs clips in parallel (concurrency 3) and returns processed S3 URLs.
 *
 * This runs on the Agentuity server. It:
 *   1. Takes raw clips already uploaded to S3 (from uploadClipsToS3)
 *   2. Invokes the preprocessor Lambda for each clip (FFmpeg deshake + sharpen + trim)
 *   3. Returns processed S3 URLs that Remotion Lambda can fetch
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
	const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');

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

	const lambda = new LambdaClient({
		region,
		credentials: {
			accessKeyId: process.env.REMOTION_AWS_ACCESS_KEY_ID!,
			secretAccessKey: process.env.REMOTION_AWS_SECRET_ACCESS_KEY!,
		},
	});

	const result = await lambda.send(new InvokeCommand({
		FunctionName: functionName,
		InvocationType: 'RequestResponse', // Synchronous — wait for result
		Payload: Buffer.from(JSON.stringify(payload)),
	}));

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
 * Invoke the preprocessor Lambda for multiple clips in parallel.
 *
 * Processes clips with concurrency limit to avoid overwhelming Lambda.
 * Returns a list of preprocessed clip results in the same order as input.
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
	const concurrency = 3;

	logger?.info('[preprocessor] Preprocessing %d clips via Lambda (concurrency=%d, prefix=%s)...',
		clips.length, concurrency, renderPrefix);
	const startTime = Date.now();

	const results: PreprocessedS3Clip[] = new Array(clips.length);
	const errors: string[] = [];

	// Process in batches of `concurrency`
	for (let i = 0; i < clips.length; i += concurrency) {
		const batch = clips.slice(i, i + concurrency);
		const batchIndices = batch.map((_, j) => i + j);

		logger?.info('[preprocessor] Processing batch %d/%d (clips %d-%d)...',
			Math.floor(i / concurrency) + 1,
			Math.ceil(clips.length / concurrency),
			i + 1, Math.min(i + concurrency, clips.length));

		const batchResults = await Promise.allSettled(
			batch.map((clip) =>
				invokePreprocessorForClip(clip, bucketName, region, renderPrefix, logger)
			),
		);

		for (let j = 0; j < batchResults.length; j++) {
			const result = batchResults[j]!;
			const clipIndex = batchIndices[j]!;
			const clip = batch[j]!;

			if (result.status === 'fulfilled') {
				results[clipIndex] = result.value;
			} else {
				const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
				errors.push(`${clip.filename || clip.fileId}: ${msg}`);
				logger?.error?.('[preprocessor] Failed to preprocess %s: %s', clip.filename || clip.fileId, msg);
			}
		}
	}

	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
	const totalOutputSize = results
		.filter(Boolean)
		.reduce((s, r) => s + r.outputSizeBytes, 0);

	logger?.info('[preprocessor] Preprocessing complete: %d/%d clips, %dMB total output, %ss',
		results.filter(Boolean).length, clips.length,
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
