/**
 * FFmpeg Pre-Processing Pipeline
 *
 * Downloads clips from Google Drive, applies sharpening and speed ramping
 * via FFmpeg, and outputs processed files for Shotstack to consume.
 *
 * Pipeline: Google Drive → download → FFmpeg (sharpen + speed) → .temp-cataloger/
 *
 * File: src/agent/video-editor/preprocess.ts
 */

import { downloadVideo } from './google-drive';

// --- Types ---

export interface PreprocessClipConfig {
	fileId: string;
	filename?: string;
	trimStart: number;
	duration: number;
	speed?: number;     // Playback speed multiplier. Default 1.0. 0.5 = slow-mo, 2.0 = fast.
	sharpen?: boolean;  // Apply sharpening filter. Default true.
}

export interface PreprocessedClip {
	processedId: string;       // Unique ID used in proxy URL
	localPath: string;         // Absolute path on disk
	originalFileId: string;    // Source Google Drive file ID
	effectiveDuration: number; // Duration AFTER speed change (what Shotstack sees)
	speed: number;             // Speed multiplier that was applied
}

interface Logger {
	info: (...args: any[]) => void;
	error?: (...args: any[]) => void;
}

// --- FFmpeg Filter Builders ---

/**
 * Build the video filter chain for a clip.
 * Combines sharpening and speed adjustment.
 */
function buildVideoFilter(config: PreprocessClipConfig): string {
	const filters: string[] = [];

	// Sharpening — moderate settings for phone footage
	// unsharp=luma_size_x:luma_size_y:luma_amount:chroma_size_x:chroma_size_y:chroma_amount
	// 5x5 kernel, 0.8 luma strength, 0.4 chroma strength — crisp but not noisy
	if (config.sharpen !== false) {
		filters.push('unsharp=5:5:0.8:5:5:0.4');
	}

	// Speed ramping — setpts changes presentation timestamps
	// For speed=2.0 (2x fast): PTS * 0.5 (timestamps compressed)
	// For speed=0.5 (slow-mo): PTS * 2.0 (timestamps stretched)
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
 * FFmpeg requires atempo values between 0.5 and 100.0,
 * so we chain multiple filters for extreme values.
 */
function buildAudioFilter(speed: number): string {
	if (speed === 1.0) return '';

	const filters: string[] = [];
	let remaining = speed;

	// Chain atempo filters to stay within 0.5–2.0 range
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

// --- Core Pre-Processing ---

/**
 * Pre-process a single clip: download from Google Drive, apply FFmpeg filters.
 *
 * The trimStart/duration are applied during pre-processing (-ss/-t),
 * so the output file contains ONLY the trimmed, processed segment.
 * Shotstack uses trim=0 since the file is already trimmed.
 */
export async function preprocessClip(
	config: PreprocessClipConfig,
	logger?: Logger,
): Promise<PreprocessedClip> {
	const fs = await import('fs');
	const path = await import('path');
	const { execSync } = await import('child_process');

	const speed = config.speed ?? 1.0;
	const processedId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	const tempDir = path.join(process.cwd(), '.temp-cataloger');

	if (!fs.existsSync(tempDir)) {
		fs.mkdirSync(tempDir, { recursive: true });
	}

	const rawPath = path.join(tempDir, `raw_${processedId}.mp4`);
	const processedPath = path.join(tempDir, `processed_${processedId}.mp4`);

	logger?.info(
		'[preprocess] Clip %s: downloading %s (trim=%ds, dur=%ds, speed=%sx, sharpen=%s)',
		config.filename || config.fileId,
		config.fileId,
		config.trimStart,
		config.duration,
		speed,
		config.sharpen !== false ? 'yes' : 'no',
	);

	// 1. Download raw source from Google Drive
	try {
		await downloadVideo(config.fileId, rawPath);
	} catch (err) {
		throw new Error(
			`Failed to download clip ${config.filename || config.fileId}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// 2. Build FFmpeg command
	const videoFilter = buildVideoFilter(config);
	const audioFilter = buildAudioFilter(speed);

	const ffmpegArgs: string[] = [
		'ffmpeg', '-y',
		'-ss', String(config.trimStart),
		'-t', String(config.duration),
		'-i', `"${rawPath}"`,
	];

	if (videoFilter) {
		ffmpegArgs.push('-vf', `"${videoFilter}"`);
	}
	if (audioFilter) {
		ffmpegArgs.push('-af', `"${audioFilter}"`);
	}

	ffmpegArgs.push(
		'-c:v', 'libx264',
		'-preset', 'fast',
		'-crf', '20',       // high quality (lower = better, 20 is very good)
		'-c:a', 'aac',
		'-b:a', '128k',
		`"${processedPath}"`,
	);

	const cmd = ffmpegArgs.join(' ');

	// 3. Run FFmpeg
	try {
		execSync(cmd, { stdio: 'pipe', timeout: 180000 }); // 3 minute timeout per clip
	} catch (err) {
		// Clean up raw file on failure
		try { if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath); } catch { /* best effort */ }
		throw new Error(
			`FFmpeg pre-processing failed for ${config.filename || config.fileId}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// 4. Clean up raw download (keep only processed file)
	try {
		if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
	} catch { /* best effort */ }

	// 5. Calculate effective duration
	// speed=0.5 means 4s of source becomes 8s of output (slow-mo)
	// speed=2.0 means 4s of source becomes 2s of output (fast)
	const effectiveDuration = config.duration / speed;

	// Verify processed file exists and get its size
	if (!fs.existsSync(processedPath)) {
		throw new Error(`Pre-processed file not created: ${processedPath}`);
	}
	const stat = fs.statSync(processedPath);

	logger?.info(
		'[preprocess] Clip %s: done (%s, effectiveDur=%ds, %dMB)',
		config.filename || config.fileId,
		processedId,
		effectiveDuration.toFixed(1),
		(stat.size / (1024 * 1024)).toFixed(1),
	);

	return {
		processedId,
		localPath: processedPath,
		originalFileId: config.fileId,
		effectiveDuration,
		speed,
	};
}

/**
 * Pre-process all clips in an edit plan.
 * Downloads each clip from Google Drive, applies sharpen + speed,
 * returns processed clip info needed for timeline building.
 *
 * Processes clips sequentially to avoid overwhelming disk I/O and memory.
 */
export async function preprocessAllClips(
	clips: PreprocessClipConfig[],
	logger?: Logger,
): Promise<PreprocessedClip[]> {
	const startTime = Date.now();
	logger?.info('[preprocess] Starting pre-processing of %d clips...', clips.length);

	const results: PreprocessedClip[] = [];

	for (let i = 0; i < clips.length; i++) {
		const clip = clips[i]!;
		logger?.info('[preprocess] Processing clip %d/%d...', i + 1, clips.length);

		try {
			const result = await preprocessClip(clip, logger);
			results.push(result);
		} catch (err) {
			// Clean up any already-processed files on failure
			await cleanupProcessedFiles(results);
			throw err;
		}
	}

	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
	logger?.info(
		'[preprocess] All %d clips processed in %ss',
		clips.length,
		elapsed,
	);

	return results;
}

/**
 * Clean up all pre-processed files from disk.
 * Call this after the render completes or fails.
 */
export async function cleanupProcessedFiles(
	clips: PreprocessedClip[],
): Promise<void> {
	const fs = await import('fs');

	for (const clip of clips) {
		try {
			if (fs.existsSync(clip.localPath)) {
				fs.unlinkSync(clip.localPath);
			}
		} catch { /* best effort */ }
	}
}
