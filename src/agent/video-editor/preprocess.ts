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
import { buildCropFilter, type TargetAspect } from './smart-crop';

// --- Types ---

export interface PreprocessClipConfig {
	fileId: string;
	filename?: string;
	trimStart: number;
	duration: number;
	speed?: number;       // Playback speed multiplier. Default 1.0. 0.5 = slow-mo, 2.0 = fast.
	sharpen?: boolean;    // Apply sharpening filter. Default true.
	stabilize?: boolean;  // Apply deshake stabilization. Default false.
	targetAspect?: TargetAspect;        // Target aspect ratio for smart crop (e.g., '9:16' for TikTok).
	subjectPosition?: string;           // Where subject sits in frame — from GPT-4o catalog (e.g., 'bottom-center').
	sourceWidth?: number;               // Source dimensions if already known (skips ffprobe).
	sourceHeight?: number;
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
 * Order: smart crop (aspect + subject-aware) → downscale cap → stabilize → sharpen → speed.
 * Crop runs FIRST so deshake and sharpen operate on the final framing region.
 */
function buildVideoFilter(config: PreprocessClipConfig): string {
	const filters: string[] = [];

	// Smart crop — uses GPT-4o subjectPosition to keep players in frame when
	// reframing from 16:9 source to vertical/square targets.
	if (config.targetAspect && config.sourceWidth && config.sourceHeight) {
		filters.push(
			buildCropFilter(
				config.sourceWidth,
				config.sourceHeight,
				config.targetAspect,
				config.subjectPosition,
			),
		);
	} else {
		// Fallback: cap at 1080p without aspect change.
		filters.push('scale=min(iw\\,1080):-2');
	}

	// Stabilization — deshake (built into FFmpeg, single-pass).
	// Applied AFTER crop so we stabilize the framed region, not the full source.
	if (config.stabilize) {
		filters.push('deshake=x=-1:y=-1:w=-1:h=-1:rx=32:ry=32');
	}

	// Sharpening — moderate settings for phone footage.
	// 5x5 kernel, 0.8 luma, 0.4 chroma — crisp but not noisy.
	if (config.sharpen !== false) {
		filters.push('unsharp=5:5:0.8:5:5:0.4');
	}

	// Speed ramping — setpts changes presentation timestamps.
	const speed = config.speed ?? 1.0;
	if (speed !== 1.0) {
		const ptsFactor = 1.0 / speed;
		filters.push(`setpts=PTS*${ptsFactor.toFixed(4)}`);
	}

	return filters.join(',');
}

/**
 * Probe a local video file for its width and height using ffprobe.
 * Returns null if probing fails — caller should fall back to default scaling.
 */
async function probeSourceDimensions(
	localPath: string,
): Promise<{ width: number; height: number } | null> {
	const { execSync } = await import('child_process');
	try {
		const output = execSync(
			`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${localPath}"`,
			{ stdio: 'pipe', timeout: 10000 },
		).toString().trim();
		const match = output.match(/^(\d+)x(\d+)$/);
		if (!match) return null;
		return { width: parseInt(match[1]!, 10), height: parseInt(match[2]!, 10) };
	} catch {
		return null;
	}
}

/**
 * Build the audio filter chain for a clip. Three jobs, applied in order:
 *
 *   1. atempo — pitch-preserving speed compensation. FFmpeg requires each
 *      atempo stage to sit in 0.5–2.0, so extreme speeds chain multiple stages.
 *   2. loudnorm — delivered videos measured as clipping (true peak +0.1 to
 *      +0.2 dBFS) with 3.4 LU of spread between them. Per-clip normalization to
 *      -16 LUFS with a -1.5 dBTP ceiling fixes both and leaves headroom for the
 *      music sum; the final mix is normalized to -14 downstream.
 *   3. afade — 15ms ramps at both ends kill the clicks at clip splice points.
 *
 * The aresample after loudnorm is NOT optional: loudnorm's single-pass dynamic
 * mode resamples internally to 192kHz, and since the AAC encoder tops out at
 * 96kHz, ffmpeg silently negotiates the output up to 96kHz without it. Pinning to
 * 48k also standardizes every clip to one rate for the downstream concat/mix.
 *
 * TWIN NOTE: keep in sync with buildAudioFilter() in remotion/preprocessor-lambda.ts.
 *
 * @param outputDuration - Clip length AFTER the speed change. The fades run
 *   downstream of atempo, so they sit on the output timeline, not the source one.
 * @returns The filter chain, or '' if there is genuinely nothing to do.
 */
function buildAudioFilter(speed: number, outputDuration?: number): string {
	const filters: string[] = [];

	// Speed compensation — unchanged; simply skipped at 1.0x instead of
	// short-circuiting the whole chain, since normalization now always applies.
	if (speed !== 1.0) {
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
	}

	// Loudness + true-peak ceiling, then undo loudnorm's internal upsample.
	filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');
	filters.push('aresample=48000');

	// De-click the splice points. Skipped on clips too short to hold both
	// ramps, where a fade would eat a meaningful share of the clip.
	const FADE = 0.015;
	if (typeof outputDuration === 'number' && Number.isFinite(outputDuration) && outputDuration > FADE * 3) {
		filters.push(`afade=t=in:st=0:d=${FADE}`);
		filters.push(`afade=t=out:st=${(outputDuration - FADE).toFixed(3)}:d=${FADE}`);
	}

	return filters.length > 0 ? filters.join(',') : '';
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
		'[preprocess] Clip %s: downloading %s (trim=%ds, dur=%ds, speed=%sx, sharpen=%s, stabilize=%s, aspect=%s, subject=%s)',
		config.filename || config.fileId,
		config.fileId,
		config.trimStart,
		config.duration,
		speed,
		config.sharpen !== false ? 'yes' : 'no',
		config.stabilize ? 'yes' : 'no',
		config.targetAspect || 'source',
		config.subjectPosition || 'center',
	);

	// 1. Download raw source from Google Drive
	try {
		await downloadVideo(config.fileId, rawPath);
	} catch (err) {
		throw new Error(
			`Failed to download clip ${config.filename || config.fileId}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// 1b. Probe source dimensions for smart crop (only if needed and not provided).
	let effectiveConfig = config;
	if (config.targetAspect && (!config.sourceWidth || !config.sourceHeight)) {
		const probed = await probeSourceDimensions(rawPath);
		if (probed) {
			effectiveConfig = { ...config, sourceWidth: probed.width, sourceHeight: probed.height };
		} else {
			logger?.error?.(
				'[preprocess] ffprobe failed for %s — smart crop disabled, falling back to scale-only',
				config.filename || config.fileId,
			);
			effectiveConfig = { ...config, targetAspect: undefined };
		}
	}

	// 2. Build FFmpeg command
	// Output length after the speed change — the audio fades are placed on this
	// timeline (they run after atempo), and step 5 reports the same number.
	// speed=0.5 means 4s of source becomes 8s of output (slow-mo)
	// speed=2.0 means 4s of source becomes 2s of output (fast)
	const effectiveDuration = config.duration / speed;
	const videoFilter = buildVideoFilter(effectiveConfig);
	const audioFilter = buildAudioFilter(speed, effectiveDuration);

	const ffmpegArgs: string[] = [
		'ffmpeg', '-y',
		'-ss', String(config.trimStart),
		'-t', String(config.duration),
		'-i', `"${rawPath}"`,
	];

	if (videoFilter) {
		ffmpegArgs.push('-vf', `'${videoFilter}'`);
	}
	if (audioFilter) {
		ffmpegArgs.push('-af', `'${audioFilter}'`);
	}

	ffmpegArgs.push(
		'-c:v', 'libx264',
		'-preset', 'ultrafast',  // Speed over size — intermediate file for Shotstack/Remotion
		'-crf', '20',            // high quality (lower = better, 20 is very good)
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

	// 5. effectiveDuration was computed in step 2 — the audio fades are
	// positioned against it, so both must reference the same value.

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
