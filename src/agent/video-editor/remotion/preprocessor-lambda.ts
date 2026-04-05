/**
 * FFmpeg Preprocessor Lambda Handler
 *
 * A standalone AWS Lambda function that preprocesses video clips:
 *   1. Downloads a raw clip from S3
 *   2. Applies FFmpeg filters: deshake (stabilization) + sharpen + trim + speed
 *   3. Uploads the processed clip back to S3
 *   4. Returns the result
 *
 * This runs on a dedicated Lambda (separate from Remotion render) because:
 *   - Agentuity server has 60s timeout / 500m CPU (can't run FFmpeg on 300MB files)
 *   - Remotion Lambda has 30s delayRender timeout (too short for transcoding)
 *   - This Lambda: 3072MB RAM, 300s timeout, 2048MB disk — ideal for FFmpeg
 *
 * FFmpeg binary comes from a Lambda Layer at /opt/bin/ffmpeg.
 *
 * File: src/agent/video-editor/remotion/preprocessor-lambda.ts
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { execSync } from 'child_process';
import { createReadStream, createWriteStream, unlinkSync, existsSync, statSync } from 'fs';
import { pipeline } from 'stream/promises';
import type { Readable } from 'stream';

// --- Types ---

export interface PreprocessRequest {
	bucketName: string;
	region: string;
	inputS3Key: string;        // S3 key of the raw clip
	outputS3Key: string;       // S3 key for the processed clip
	trimStart: number;         // Seconds into source to start
	duration: number;          // Seconds of source to use
	speed?: number;            // Playback speed multiplier (default 1.0)
	sharpen?: boolean;         // Apply unsharp filter (default true)
	stabilize?: boolean;       // Apply deshake filter (default true)
}

export interface PreprocessResult {
	success: boolean;
	outputS3Key: string;
	outputS3Url: string;
	outputSizeBytes: number;
	effectiveDuration: number; // Duration after speed change
	processingTimeMs: number;
	error?: string;
}

// --- FFmpeg Filter Builders ---
// (Adapted from preprocess.ts — self-contained, no external imports)

/**
 * Build the video filter chain.
 * Order: scale (downscale 4K→1080p) → stabilize (deshake) → sharpen (unsharp) → speed (setpts)
 *
 * Scale is applied FIRST so that expensive filters (deshake, unsharp) operate
 * on 1080p frames instead of 4K — reducing processing time ~4x and memory ~4x.
 * Output is always mobile content, so 1080p is the maximum useful resolution.
 */
function buildVideoFilter(config: {
	stabilize?: boolean;
	sharpen?: boolean;
	speed?: number;
}): string {
	const filters: string[] = [];

	// Downscale to 1080p max — preserves aspect ratio, only scales if larger.
	// -2 ensures height is divisible by 2 (required for H.264 encoding).
	// If source is ≤1080p wide, this is a no-op thanks to min().
	filters.push('scale=min(iw\\,1080):-2');

	// Stabilization — deshake (single-pass, built into FFmpeg)
	// Must come BEFORE sharpening so we sharpen the stabilized image
	// rx=32:ry=32 = 32px search radius (generous for phone sports footage)
	if (config.stabilize !== false) {
		filters.push('deshake=x=-1:y=-1:w=-1:h=-1:rx=32:ry=32');
	}

	// Sharpening — moderate settings for phone footage
	// 5x5 kernel, 0.8 luma strength, 0.4 chroma strength
	if (config.sharpen !== false) {
		filters.push('unsharp=5:5:0.8:5:5:0.4');
	}

	// Speed ramping — setpts changes presentation timestamps
	const speed = config.speed ?? 1.0;
	if (speed !== 1.0) {
		const ptsFactor = 1.0 / speed;
		filters.push(`setpts=PTS*${ptsFactor.toFixed(4)}`);
	}

	return filters.join(',');
}

/**
 * Build the audio filter chain for speed adjustment.
 * atempo preserves pitch while changing speed.
 * FFmpeg requires atempo values between 0.5 and 100.0.
 */
function buildAudioFilter(speed: number): string {
	if (speed === 1.0) return '';

	const filters: string[] = [];
	let remaining = speed;

	while (remaining > 2.0) {
		filters.push('atempo=2.0');
		remaining /= 2.0;
	}
	while (remaining < 0.5) {
		filters.push('atempo=0.5');
		remaining /= 0.5;
	}
	filters.push(`atempo=${remaining.toFixed(4)}`);

	return filters.join(',');
}

// --- Determine FFmpeg binary path ---

/**
 * Find the FFmpeg binary.
 * Priority: bundled in zip (./bin/ffmpeg) > Lambda layer (/opt/bin/ffmpeg) > system PATH
 */
function getFFmpegPath(): string {
	const path = require('path');
	// Bundled binary (deployed alongside index.js in the zip package)
	const bundled = path.join(__dirname, 'bin', 'ffmpeg');
	if (existsSync(bundled)) {
		try { require('fs').chmodSync(bundled, 0o755); } catch { /* Windows dev */ }
		return bundled;
	}
	// Lambda layer provides FFmpeg at /opt/bin/ffmpeg
	if (existsSync('/opt/bin/ffmpeg')) {
		return '/opt/bin/ffmpeg';
	}
	// Fallback to system PATH (for local testing)
	return 'ffmpeg';
}

// --- Lambda Handler ---

export async function handler(event: PreprocessRequest): Promise<PreprocessResult> {
	const startTime = Date.now();
	const ffmpegPath = getFFmpegPath();

	console.log('[preprocessor] Processing clip: input=%s, trim=%ds, dur=%ds, speed=%sx, stabilize=%s, sharpen=%s',
		event.inputS3Key, event.trimStart, event.duration,
		event.speed ?? 1.0, event.stabilize !== false ? 'yes' : 'no', event.sharpen !== false ? 'yes' : 'no');

	const inputPath = '/tmp/input.mp4';
	const outputPath = '/tmp/output.mp4';

	try {
		// Step 1: Stream raw clip from S3 directly to disk (avoids loading into memory)
		console.log('[preprocessor] Downloading from s3://%s/%s...', event.bucketName, event.inputS3Key);
		const dlStart = Date.now();

		const s3 = new S3Client({ region: event.region });

		const getResult = await s3.send(new GetObjectCommand({
			Bucket: event.bucketName,
			Key: event.inputS3Key,
		}));

		// Stream to disk — avoids the ~600MB double-buffer that caused OOM kills
		await pipeline(getResult.Body! as Readable, createWriteStream(inputPath));

		const inputSize = statSync(inputPath).size;
		const dlTime = ((Date.now() - dlStart) / 1000).toFixed(1);
		console.log('[preprocessor] Downloaded: %dMB in %ss',
			(inputSize / (1024 * 1024)).toFixed(1), dlTime);

		// Step 2: Build FFmpeg command
		const speed = event.speed ?? 1.0;
		const videoFilter = buildVideoFilter({
			stabilize: event.stabilize,
			sharpen: event.sharpen,
			speed,
		});
		const audioFilter = buildAudioFilter(speed);

		const ffmpegArgs: string[] = [
			ffmpegPath, '-y',
			'-ss', String(event.trimStart),
			'-t', String(event.duration),
			'-i', inputPath,
		];

		if (videoFilter) {
			ffmpegArgs.push('-vf', `'${videoFilter}'`);
		}
		if (audioFilter) {
			ffmpegArgs.push('-af', `'${audioFilter}'`);
		}

		ffmpegArgs.push(
			'-c:v', 'libx264',
			'-preset', 'ultrafast',  // Speed over size — this is an intermediate file for Remotion
			'-crf', '20',
			'-c:a', 'aac',
			'-b:a', '128k',
			outputPath,
		);

		const cmd = ffmpegArgs.join(' ');
		console.log('[preprocessor] Running FFmpeg: %s', cmd);

		// Step 3: Run FFmpeg
		const ffStart = Date.now();
		execSync(cmd, {
			stdio: 'pipe',
			timeout: 240_000, // 4 minute timeout (leaves 1 min for upload)
		});

		const ffTime = ((Date.now() - ffStart) / 1000).toFixed(1);
		const outputSize = statSync(outputPath).size;
		console.log('[preprocessor] FFmpeg complete: %dMB output in %ss',
			(outputSize / (1024 * 1024)).toFixed(1), ffTime);

		// Step 4: Stream processed clip from disk to S3 (avoids loading into memory)
		console.log('[preprocessor] Uploading to s3://%s/%s...', event.bucketName, event.outputS3Key);
		const upStart = Date.now();

		const outputSize2 = statSync(outputPath).size;
		await s3.send(new PutObjectCommand({
			Bucket: event.bucketName,
			Key: event.outputS3Key,
			Body: createReadStream(outputPath),
			ContentLength: outputSize2,
			ContentType: 'video/mp4',
		}));

		const upTime = ((Date.now() - upStart) / 1000).toFixed(1);
		console.log('[preprocessor] Uploaded in %ss', upTime);

		// Step 5: Clean up /tmp
		try { unlinkSync(inputPath); } catch { /* best effort */ }
		try { unlinkSync(outputPath); } catch { /* best effort */ }

		// Calculate effective duration after speed change
		const effectiveDuration = event.duration / speed;

		const totalTime = Date.now() - startTime;
		const outputS3Url = `https://${event.bucketName}.s3.${event.region}.amazonaws.com/${event.outputS3Key}`;

		console.log('[preprocessor] Done: %dMB → %dMB, effectiveDur=%ds, total=%dms',
			(inputSize / (1024 * 1024)).toFixed(1),
			(outputSize / (1024 * 1024)).toFixed(1),
			effectiveDuration.toFixed(1),
			totalTime);

		return {
			success: true,
			outputS3Key: event.outputS3Key,
			outputS3Url,
			outputSizeBytes: outputSize,
			effectiveDuration,
			processingTimeMs: totalTime,
		};

	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[preprocessor] FAILED: %s', msg);

		// Clean up on failure
		try { if (existsSync(inputPath)) unlinkSync(inputPath); } catch { /* */ }
		try { if (existsSync(outputPath)) unlinkSync(outputPath); } catch { /* */ }

		return {
			success: false,
			outputS3Key: event.outputS3Key,
			outputS3Url: '',
			outputSizeBytes: 0,
			effectiveDuration: 0,
			processingTimeMs: Date.now() - startTime,
			error: msg,
		};
	}
}
