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
	stabilize?: boolean;       // Apply deshake filter (default false — opt in; CPU-heavy)
	// Smart crop inputs (optional — applied before deshake/sharpen when all 4 are present):
	targetAspect?: '9:16' | '1:1' | '4:5' | '16:9';
	subjectPosition?: string;
	sourceWidth?: number;      // Display width (after rotation)
	sourceHeight?: number;     // Display height (after rotation)
	// Extra zoom multiplier on top of the fill-minimum scale. >1.0 tightens the
	// frame on the subject (fewer empty bleachers / less blue court). Typical
	// values: 1.25-1.4 for wide tennis action, 1.0 for interview / chess /
	// establishing shots where context matters. Driven per-clip by content type.
	extraZoom?: number;
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

// Subject positions mapped to normalized (x, y) coordinates in the source frame.
// Rule-of-thirds offsets for off-center subjects keep them off the edges.
const SUBJECT_POSITION_MAP: Record<string, { x: number; y: number }> = {
	'center':        { x: 0.50, y: 0.50 },
	'left':          { x: 0.33, y: 0.50 },
	'right':         { x: 0.67, y: 0.50 },
	'top-center':    { x: 0.50, y: 0.33 },
	'bottom-center': { x: 0.50, y: 0.67 },
	'top-left':      { x: 0.33, y: 0.33 },
	'top-right':     { x: 0.67, y: 0.33 },
	'bottom-left':   { x: 0.33, y: 0.67 },
	'bottom-right':  { x: 0.67, y: 0.67 },
};

// 4K preprocessor output dimensions — matches PLATFORM_SETTINGS in shotstack.ts.
// Source is 2K (2560x1440), so this is a mild upscale at the FFmpeg crop stage;
// preserves more detail than downscaling to 1080 and forcing Remotion to upscale.
const ASPECT_DIMS: Record<string, { w: number; h: number }> = {
	'9:16': { w: 2160, h: 3840 },
	'1:1':  { w: 2160, h: 2160 },
	'4:5':  { w: 2160, h: 2700 },
	'16:9': { w: 3840, h: 2160 },
};

function roundEven(n: number): number {
	const r = Math.round(n);
	return r % 2 === 0 ? r : r + 1;
}

/**
 * Build a smart-crop filter that reframes source to targetAspect using
 * subjectPosition to offset the crop window. Returns empty string if
 * any required input is missing (caller should fall back to plain scale).
 *
 * TWIN NOTE: this MUST stay in sync with computeCrop() in src/agent/video-editor/smart-crop.ts.
 * Lambda bundling prevents importing the shared TS file into this Lambda entry,
 * so both copies of the algorithm need to be updated together.
 *
 * The `extraZoom` multiplier pulls the subject larger in the output frame on top
 * of the fill-minimum scale. The subject-centering constraints (kCenterX/kCenterY)
 * solve the old Y-axis-has-no-effect bug: for 16:9 → 9:16 with scaleH = targetH
 * exactly, there's zero vertical slack and cropY always clamps to 0, so the
 * subjectPosition Y ordinate is ignored. Solving for "subject lands at output
 * center" requires K >= targetH / (2 * min(pos.y, 1-pos.y) * sourceH).
 */
function buildSmartCropFilter(
	sourceW: number,
	sourceH: number,
	targetAspect: string,
	subjectPosition: string | undefined,
	extraZoom: number = 1.0,
): string {
	const target = ASPECT_DIMS[targetAspect];
	if (!target) return '';
	const { w: targetW, h: targetH } = target;

	const sourceAR = sourceW / sourceH;
	const targetAR = targetW / targetH;

	// Aspect already matches AND no extra zoom requested — just scale.
	if (Math.abs(sourceAR - targetAR) < 0.01 && extraZoom <= 1.001) {
		return `scale=${targetW}:${targetH}`;
	}

	const pos = SUBJECT_POSITION_MAP[subjectPosition?.toLowerCase()?.trim() || 'center']
		|| SUBJECT_POSITION_MAP['center']!;

	// Fill minimum — K so that scaledW >= targetW AND scaledH >= targetH.
	const kFillX = targetW / sourceW;
	const kFillY = targetH / sourceH;
	const kFill = Math.max(kFillX, kFillY);
	// Subject-centering constraints — K so the crop window can slide enough
	// on each axis to put the subject at the output center.
	const marginX = Math.max(0.1, Math.min(pos.x, 1 - pos.x));
	const marginY = Math.max(0.1, Math.min(pos.y, 1 - pos.y));
	const kCenterX = targetW / (2 * marginX * sourceW);
	const kCenterY = targetH / (2 * marginY * sourceH);
	// Apply extraZoom to the fill baseline, then take the max of all constraints.
	const kZoomed = kFill * Math.max(1.0, extraZoom);
	const K = Math.max(kZoomed, kCenterX, kCenterY);

	const scaleW = roundEven(sourceW * K);
	const scaleH = roundEven(sourceH * K);

	let cropX = roundEven(pos.x * scaleW - targetW / 2);
	let cropY = roundEven(pos.y * scaleH - targetH / 2);
	cropX = Math.max(0, Math.min(cropX, scaleW - targetW));
	cropY = Math.max(0, Math.min(cropY, scaleH - targetH));

	return `scale=${scaleW}:${scaleH},crop=${targetW}:${targetH}:${cropX}:${cropY}`;
}

/**
 * Build the video filter chain.
 * Order: smart crop (if requested) OR plain scale → stabilize → sharpen → speed.
 * Crop-first means deshake/sharpen operate on the final framed region.
 */
function buildVideoFilter(config: {
	stabilize?: boolean;
	sharpen?: boolean;
	speed?: number;
	targetAspect?: string;
	subjectPosition?: string;
	sourceWidth?: number;
	sourceHeight?: number;
	extraZoom?: number;
}): string {
	const filters: string[] = [];

	// Framing: smart crop to target aspect, or fallback scale cap.
	const cropFilter = (config.targetAspect && config.sourceWidth && config.sourceHeight)
		? buildSmartCropFilter(config.sourceWidth, config.sourceHeight, config.targetAspect, config.subjectPosition, config.extraZoom)
		: '';
	if (cropFilter) {
		filters.push(cropFilter);
	} else {
		filters.push('scale=min(iw\\,2160):-2');
	}

	// Stabilization — OPT IN. Default off because deshake on 2K source at 2048MB Lambda
	// routinely blows past the 300s timeout.
	if (config.stabilize === true) {
		filters.push('deshake=x=-1:y=-1:w=-1:h=-1:rx=32:ry=32');
	}

	if (config.sharpen !== false) {
		filters.push('unsharp=5:5:0.8:5:5:0.4');
	}

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
			targetAspect: event.targetAspect,
			subjectPosition: event.subjectPosition,
			sourceWidth: event.sourceWidth,
			sourceHeight: event.sourceHeight,
			extraZoom: event.extraZoom,
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

		// Step 4: Upload processed clip to S3.
		// Buffer upload (not streaming) — stream uploads hit "socket hang up" on
		// Node 20 + AWS SDK v3, killing most renders. Processed clips are small
		// (~20MB) and Lambda has plenty of memory.
		console.log('[preprocessor] Uploading to s3://%s/%s...', event.bucketName, event.outputS3Key);
		const upStart = Date.now();

		const { readFileSync } = await import('fs');
		const outputBuffer = readFileSync(outputPath);
		await s3.send(new PutObjectCommand({
			Bucket: event.bucketName,
			Key: event.outputS3Key,
			Body: outputBuffer,
			ContentLength: outputBuffer.length,
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
