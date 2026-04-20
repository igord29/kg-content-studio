/**
 * Contact Sheet Generator
 *
 * Uses FFmpeg to extract dense frames from a video and stitch them into
 * a single contact sheet image with timestamp labels. This gives vision
 * models a full visual timeline of the video in ONE image — dramatically
 * cheaper and denser than sending individual frames.
 *
 * Cost comparison (60s video):
 *   Individual frames: ~16 images across 3+ API calls → ~$0.02-0.05
 *   Contact sheet: 1 image, 1 API call → ~$0.002-0.005
 *
 * NOTE: Uses async exec (not execSync) because Bun's execSync can trigger
 * process.exit(0) on child process completion, which crashes Agentuity's runtime.
 *
 * File: src/agent/video-editor/contact-sheet.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

// --- Types ---

export interface ContactSheet {
	imagePath: string;        // path to the contact sheet JPEG
	timestamps: number[];     // timestamps represented (left-to-right, top-to-bottom)
	frameInterval: number;    // seconds between frames
	gridCols: number;
	gridRows: number;
	thumbnailWidth: number;
	totalFrames: number;
}

export interface ContactSheetOptions {
	maxFrames?: number;       // cap total frames (default: 30)
	thumbnailWidth?: number;  // width per thumbnail in pixels (default: 192)
	gridCols?: number;        // columns in grid (default: 6)
	quality?: number;         // JPEG quality 1-31, lower=better (default: 5)
}

// --- Constants ---

const DEFAULT_MAX_FRAMES = 30;
const DEFAULT_THUMBNAIL_WIDTH = 192;
const DEFAULT_GRID_COLS = 6;
const DEFAULT_QUALITY = 5;

// --- Helpers ---

/**
 * Run a shell command asynchronously. Returns stdout on success.
 * Unlike execSync, this does not trigger process.exit() on Bun.
 */
function runCmd(cmd: string, timeoutMs: number = 60000): Promise<string> {
	return new Promise((resolve, reject) => {
		exec(cmd, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				// FFmpeg writes to stderr even on success — check if the error is real
				reject(new Error(stderr || error.message));
			} else {
				resolve(stdout);
			}
		});
	});
}

/**
 * Run a shell command, but don't reject on non-zero exit — just return.
 * Used for FFmpeg commands that write to stderr on success.
 */
function runCmdSoft(cmd: string, timeoutMs: number = 60000): Promise<void> {
	return new Promise((resolve) => {
		exec(cmd, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, () => {
			resolve();
		});
	});
}

/**
 * Calculate the optimal frame interval based on video duration.
 * Shorter videos get denser sampling; longer videos get wider spacing.
 */
function calculateFrameInterval(durationSeconds: number, maxFrames: number): number {
	if (durationSeconds <= 0) return 2;

	// Target: fill up to maxFrames, but never sample faster than every 2s
	const idealInterval = durationSeconds / maxFrames;
	const interval = Math.max(2, idealInterval);

	// Round to nearest 0.5s for cleaner timestamps
	return Math.round(interval * 2) / 2;
}

/**
 * Generate a contact sheet from a video file.
 *
 * Creates a grid of thumbnails with timestamps burned in, using a single
 * FFmpeg command. The result is one JPEG image that shows the entire
 * video's visual progression.
 */
export async function generateContactSheet(
	videoPath: string,
	fileId: string,
	duration: number,
	options?: ContactSheetOptions,
): Promise<ContactSheet> {
	const maxFrames = options?.maxFrames ?? DEFAULT_MAX_FRAMES;
	const thumbWidth = options?.thumbnailWidth ?? DEFAULT_THUMBNAIL_WIDTH;
	const gridCols = options?.gridCols ?? DEFAULT_GRID_COLS;
	const quality = options?.quality ?? DEFAULT_QUALITY;

	const frameInterval = calculateFrameInterval(duration, maxFrames);

	// Skip first 1s and last 1s to avoid black frames
	const startOffset = Math.min(1, duration * 0.02);
	const endOffset = Math.min(1, duration * 0.02);
	const usableDuration = duration - startOffset - endOffset;
	const maxPossibleFrames = Math.min(maxFrames, Math.floor(usableDuration / frameInterval) + 1);

	// Build the timestamps array first, then derive grid dimensions from actual count
	const timestamps: number[] = [];
	for (let i = 0; i < maxPossibleFrames; i++) {
		const ts = startOffset + (i * frameInterval);
		if (ts < duration - endOffset) {
			timestamps.push(Math.round(ts * 10) / 10);
		}
	}

	const totalFrames = timestamps.length;
	const gridRows = Math.ceil(totalFrames / gridCols);

	// Output path
	const tempDir = path.join(process.cwd(), '.temp-cataloger');
	if (!fs.existsSync(tempDir)) {
		fs.mkdirSync(tempDir, { recursive: true });
	}
	const outputPath = path.join(tempDir, `contact_${fileId}_${Date.now()}.jpg`);

	// Build FFmpeg filter chain
	const fpsRate = 1 / frameInterval;
	const filterChain = [
		`fps=${fpsRate.toFixed(4)}`,
		`scale=${thumbWidth}:-1`,
		`drawbox=x=0:y=ih-18:w=iw:h=18:color=black@0.6:t=fill`,
		`drawtext=text=%{pts}s:fontsize=11:fontcolor=white:x=3:y=h-15`,
		`tile=${gridCols}x${gridRows}`,
	].join(',');

	const cmd = `ffmpeg -y -ss ${startOffset.toFixed(2)} -i "${videoPath}" -frames:v ${totalFrames} -vf "${filterChain}" -q:v ${quality} "${outputPath}"`;

	await runCmdSoft(cmd, 60000);

	if (!fs.existsSync(outputPath)) {
		throw new Error('Contact sheet file was not created');
	}

	return {
		imagePath: outputPath,
		timestamps,
		frameInterval,
		gridCols,
		gridRows,
		thumbnailWidth: thumbWidth,
		totalFrames: timestamps.length,
	};
}

/**
 * Generate a contact sheet from specific timestamps (e.g., scene change points).
 *
 * Unlike the regular contact sheet which samples at fixed intervals, this
 * version extracts frames at exact timestamps — useful for showing what
 * each scene change looks like.
 */
export async function generateContactSheetAtTimestamps(
	videoPath: string,
	fileId: string,
	timestamps: number[],
	options?: Omit<ContactSheetOptions, 'maxFrames'>,
): Promise<ContactSheet> {
	const thumbWidth = options?.thumbnailWidth ?? DEFAULT_THUMBNAIL_WIDTH;
	const gridCols = options?.gridCols ?? DEFAULT_GRID_COLS;
	const quality = options?.quality ?? DEFAULT_QUALITY;

	if (timestamps.length === 0) {
		throw new Error('No timestamps provided for contact sheet');
	}

	const totalFrames = timestamps.length;
	const gridRows = Math.ceil(totalFrames / gridCols);

	const tempDir = path.join(process.cwd(), '.temp-cataloger');
	if (!fs.existsSync(tempDir)) {
		fs.mkdirSync(tempDir, { recursive: true });
	}

	// Extract individual frames then stitch — fps filter only does uniform intervals
	const framePaths: string[] = [];
	const extractedTimestamps: number[] = [];

	for (let i = 0; i < totalFrames; i++) {
		const ts = timestamps[i]!;
		const framePath = path.join(tempDir, `cs_frame_${fileId}_${i}.jpg`);

		try {
			await runCmdSoft(
				`ffmpeg -y -ss ${ts.toFixed(2)} -i "${videoPath}" -frames:v 1 -vf "scale=${thumbWidth}:-1,drawbox=x=0:y=ih-18:w=iw:h=18:color=black@0.6:t=fill,drawtext=text=${ts.toFixed(1)}s:fontsize=11:fontcolor=white:x=3:y=h-15" -q:v ${quality} "${framePath}"`,
				15000,
			);
			if (fs.existsSync(framePath)) {
				framePaths.push(framePath);
				extractedTimestamps.push(ts);
			}
		} catch {
			// Skip failed extractions
		}
	}

	if (framePaths.length === 0) {
		throw new Error('No frames could be extracted for contact sheet');
	}

	// Stitch individual frames into a grid
	const outputPath = path.join(tempDir, `contact_scenes_${fileId}_${Date.now()}.jpg`);
	const actualRows = Math.ceil(framePaths.length / gridCols);

	const inputArgs = framePaths.map(p => `-i "${p}"`).join(' ');
	const filterInputs = framePaths.map((_, i) => `[${i}:v]`).join('');
	const concatFilter = `${filterInputs}concat=n=${framePaths.length}:v=1:a=0[v];[v]tile=${gridCols}x${actualRows}`;

	await runCmdSoft(
		`ffmpeg -y ${inputArgs} -filter_complex "${concatFilter}" -q:v ${quality} "${outputPath}"`,
		30000,
	);

	// Clean up individual frames
	for (const fp of framePaths) {
		try { fs.unlinkSync(fp); } catch { /* best effort */ }
	}

	if (!fs.existsSync(outputPath)) {
		throw new Error('Scene contact sheet file was not created');
	}

	return {
		imagePath: outputPath,
		timestamps: extractedTimestamps,
		frameInterval: 0, // not uniform
		gridCols,
		gridRows: actualRows,
		thumbnailWidth: thumbWidth,
		totalFrames: framePaths.length,
	};
}

/**
 * Clean up a contact sheet file after it's been used.
 */
export function cleanupContactSheet(contactSheet: ContactSheet): void {
	try {
		if (fs.existsSync(contactSheet.imagePath)) {
			fs.unlinkSync(contactSheet.imagePath);
		}
	} catch { /* best effort */ }
}
