/**
 * Auto-Cataloging Engine for CLC Video Footage
 *
 * Downloads videos from Google Drive, extracts 4 keyframes using FFmpeg,
 * sends all frames to GPT-4o vision for analysis, and builds a structured
 * catalog with descriptions, locations, content types, quality ratings,
 * and suggested edit modes.
 *
 * Handles: batch processing, rate limiting, incremental saves,
 * graceful failure recovery, disk space management, temp file cleanup.
 *
 * File: src/agent/video-editor/cataloger.ts
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import {
	getAuth,
	listVideoFiles,
	getVideoMetadata,
	saveCatalog,
	fetchLatestCatalogFromDrive,
	fetchCatalogFromSupabase,
	fetchCatalogFromKV,
	type VideoFile,
	type CatalogEntry,
} from './google-drive';
import catalogSeedData from './catalog-seed.json';

// --- Constants ---

const TEMP_DIR = path.join(process.cwd(), '.temp-cataloger');
// Use persistent volume (/data) on Railway, fall back to cwd for local dev
const PERSISTENT_DIR = fs.existsSync('/data') ? '/data' : process.cwd();
const CATALOG_RESULTS_PATH = path.join(PERSISTENT_DIR, 'catalog-results.json');

const BATCH_SIZE = 5;               // Smaller batches -- each video is heavier now
const DELAY_BETWEEN_BATCHES = 5000; // 5 seconds between batches
const DELAY_BETWEEN_FILES = 2000;   // 2 seconds between files
const MAX_RETRIES = 2;
const SAVE_INTERVAL = 5;            // Save progress every 5 files

// Frame extraction points (percentage through video)
const FRAME_PERCENTAGES = [0.10, 0.33, 0.60, 0.85];

// --- Types ---

export interface CatalogProgress {
	total: number;
	completed: number;
	failed: number;
	skipped: number;
	currentFile?: string;
	catalog: CatalogEntry[];
	errors: Array<{ fileId: string; filename: string; error: string }>;
	startedAt: string;
	updatedAt: string;
}

export interface CatalogConfig {
	batchSize: number;
	delayBetweenFiles: number;
	delayBetweenBatches: number;
	maxRetries: number;
	saveInterval: number;
}

// --- Vision Prompt ---

const VISION_PROMPT = `You are analyzing frames extracted from a youth tennis and chess nonprofit (CLC) video. The footage was filmed at various locations across the NYC metro area, or at special events CLC kids attended.

Analyze ALL provided frames together and return a JSON object with these fields:

{
  "suspectedLocation": "See location instructions below",
  "locationConfidence": "high | medium | low | unknown",
  "locationClues": "What visual clues suggest this location (court type, building, signage, etc.)",
  "contentType": "tennis_action | chess | interview | event | establishing | mixed | unknown",
  "activity": "Brief description of what's happening (e.g., 'doubles match on outdoor hard court', 'chess tournament in gym', 'Kimberly speaking to camera')",
  "peopleCount": "Approximate number of visible people (e.g., '2-4', '10+', '0')",
  "quality": "excellent | good | fair | poor - based on lighting, focus, composition",
  "indoorOutdoor": "indoor | outdoor | unknown",
  "notableMoments": "Any notable action, emotion, or composition worth highlighting in an edit",
  "readableText": "List ALL readable text visible in ANY of the frames - signs, banners, shirts, scoreboards, building names, street signs, event branding. If no text is readable, say 'none'.",
  "suggestedModes": ["Array of edit modes this clip would work well in: game_day, our_story, quick_hit, showcase"]
}

ANCHOR MARKERS - Look specifically for these visual clues:
- Tournament/event branding: US Open, USTA, ATP, WTA logos or signage
- Venue signage: park names, facility names, street signs, building names
- CLC-specific markers: CLC banners, t-shirts, uniforms, branded equipment
- Court surface types: hard court (blue/green), clay (red/orange), indoor carpet
- Geographic clues: city skylines, beach/ocean, suburban parks, urban buildings
- Sponsor banners, event posters, trophies, medals
- School names, church names, community center signs
- Any readable text in the image (signs, shirts, banners, scoreboards)

If you see ANY readable text or recognizable branding in ANY frame, report it in both locationClues and readableText. This is critical for identifying where and when the footage was shot.

LOCATION CATEGORIES:

Known CLC program locations (CLC home sites):
- Hempstead: Large indoor facility, blue/green courts, CLC banners, "Hofstra" or "Nassau" signage
- Long Beach: Outdoor courts near beach, ocean/boardwalk visible, "Long Beach" signage, sandy areas
- Brooklyn: Urban setting, city buildings visible, smaller courts, brownstones, "Brooklyn" or "BK" markers
- Westchester: Suburban parks, green surroundings, "Westchester" county signage
- Connecticut: Various facilities, "CT" markers
- Newark NJ: Indoor facilities, "Newark" or "NJ" signage

Special event locations (not CLC home sites, but CLC kids attend):
- US Open / USTA Billie Jean King National Tennis Center, Flushing, Queens, NY: Look for US Open branding, USTA signage, blue hard courts with distinctive court colors, large stadium or professional venue appearance
- Other tournaments or events CLC kids attend: Identifiable by professional event branding, tournament signage, non-CLC venue markers

For suspectedLocation field, use one of:
- A CLC location name: "Hempstead", "Long Beach", "Brooklyn", "Westchester", "Connecticut", "Newark NJ"
- "US Open" if US Open / USTA Billie Jean King National Tennis Center branding is visible
- "Special Event: [event name]" if a non-CLC event is identifiable (e.g., "Special Event: Junior Masters Tournament")
- "Multi-Location" if multiple CLC locations appear in the same video
- "Unknown" only if there are truly no location clues whatsoever

Return ONLY valid JSON. No markdown, no explanation, just the JSON object.`;

// --- Temp Directory Management ---

function ensureTempDir(): string {
	if (!fs.existsSync(TEMP_DIR)) {
		fs.mkdirSync(TEMP_DIR, { recursive: true });
	}
	return TEMP_DIR;
}

/**
 * Clean up ALL temp files from previous runs
 */
function cleanupAllTempFiles(): void {
	if (fs.existsSync(TEMP_DIR)) {
		fs.rmSync(TEMP_DIR, { recursive: true, force: true });
		fs.mkdirSync(TEMP_DIR, { recursive: true });
	}
}

/**
 * Clean up downloaded video and extracted frames for a specific file
 */
function cleanupTempFiles(fileId: string): void {
	const tempDir = ensureTempDir();

	// Remove the downloaded video
	const videoPath = path.join(tempDir, fileId + '.mp4');
	if (fs.existsSync(videoPath)) {
		try { fs.unlinkSync(videoPath); } catch { /* ignore */ }
	}

	// Remove extracted frames
	for (let i = 0; i < 4; i++) {
		const framePath = path.join(tempDir, `${fileId}_frame_${i}.jpg`);
		if (fs.existsSync(framePath)) {
			try { fs.unlinkSync(framePath); } catch { /* ignore */ }
		}
	}
}

// --- Disk Space Check ---

/**
 * Check available disk space in temp directory.
 * Returns available space in GB, or -1 if unknown.
 */
function getAvailableDiskSpace(): number {
	try {
		// Works on both WSL and native Windows (Git Bash)
		const result = execSync(`df -BG "${TEMP_DIR}" | tail -1 | awk '{print $4}'`, {
			encoding: 'utf-8',
			timeout: 5000,
		});
		return parseInt(result.replace('G', '').trim()) || -1;
	} catch {
		return -1; // Unknown
	}
}

// --- Video Download ---

/**
 * Download a video from Google Drive to the temp directory.
 * Uses streaming write to handle large files without memory issues.
 * Skips download if file already exists (from a previous failed run).
 */
async function downloadVideoToTemp(video: VideoFile): Promise<string> {
	const tempDir = ensureTempDir();
	const localPath = path.join(tempDir, video.id + '.mp4');

	// Skip if already downloaded (from a previous failed run)
	if (fs.existsSync(localPath)) {
		const stat = fs.statSync(localPath);
		if (stat.size > 0) {
			return localPath;
		}
		// Remove empty/corrupt file
		fs.unlinkSync(localPath);
	}

	// Get auth token
	const auth = getAuth();
	const tokenResponse = await auth.authorize();
	const accessToken = tokenResponse.access_token || '';

	const downloadUrl = `https://www.googleapis.com/drive/v3/files/${video.id}?alt=media`;

	// Download with timeout (2 minutes for large files)
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 120000);

	try {
		const response = await fetch(downloadUrl, {
			headers: { 'Authorization': `Bearer ${accessToken}` },
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			throw new Error(`Download failed: ${response.status} ${response.statusText}`);
		}

		// Stream to file to avoid memory issues with large videos
		const fileStream = fs.createWriteStream(localPath);
		const reader = (response.body as ReadableStream<Uint8Array>).getReader();

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				fileStream.write(Buffer.from(value));
			}
		} finally {
			fileStream.end();
		}

		// Wait for file to be fully written
		await new Promise<void>((resolve, reject) => {
			fileStream.on('finish', resolve);
			fileStream.on('error', reject);
		});

		return localPath;
	} catch (err) {
		clearTimeout(timeoutId);
		// Clean up partial download
		if (fs.existsSync(localPath)) {
			try { fs.unlinkSync(localPath); } catch { /* ignore */ }
		}
		throw err;
	}
}

// --- FFmpeg Frame Extraction ---

/**
 * Get the duration of a video file in seconds using FFprobe
 */
function getVideoDuration(filePath: string): number {
	try {
		const result = execSync(
			`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
			{ encoding: 'utf-8', timeout: 30000 },
		);
		return parseFloat(result.trim());
	} catch {
		return 0;
	}
}

/**
 * Extract 4 keyframes from a video at 10%, 33%, 60%, and 85%.
 * These percentages are chosen to:
 * - Skip the very start (often black/shaky)
 * - Capture early content (10%)
 * - Capture mid-content (33%, 60%)
 * - Capture late content (85%) -- often includes signage, group shots, celebrations
 *
 * Returns array of file paths to the extracted JPEG frames.
 */
function extractFrames(videoPath: string, fileId: string): string[] {
	const tempDir = ensureTempDir();
	const duration = getVideoDuration(videoPath);

	if (duration <= 0) {
		console.log(`[cataloger] Could not determine duration for ${videoPath}, using single frame at 1s`);
		const framePath = path.join(tempDir, `${fileId}_frame_0.jpg`);
		try {
			execSync(
				`ffmpeg -y -ss 1 -i "${videoPath}" -frames:v 1 -q:v 2 "${framePath}"`,
				{ timeout: 30000, stdio: 'pipe' },
			);
			return fs.existsSync(framePath) ? [framePath] : [];
		} catch {
			return [];
		}
	}

	const framePaths: string[] = [];

	for (let i = 0; i < FRAME_PERCENTAGES.length; i++) {
		const timestamp = duration * (FRAME_PERCENTAGES[i] ?? 0);
		const framePath = path.join(tempDir, `${fileId}_frame_${i}.jpg`);

		try {
			execSync(
				`ffmpeg -y -ss ${timestamp.toFixed(2)} -i "${videoPath}" -frames:v 1 -q:v 2 "${framePath}"`,
				{ timeout: 30000, stdio: 'pipe' },
			);

			if (fs.existsSync(framePath)) {
				framePaths.push(framePath);
			}
		} catch (err) {
			console.log(`[cataloger] Failed to extract frame ${i} at ${timestamp.toFixed(1)}s: ${err}`);
		}
	}

	return framePaths;
}

// --- Vision Analysis ---

/**
 * Analyze a video by downloading, extracting multiple frames, and
 * sending all frames to GPT-4o vision in a single request.
 * Returns a fully populated CatalogEntry.
 */
async function analyzeVideoFrames(
	video: VideoFile,
	retryCount: number = 0,
): Promise<CatalogEntry> {
	try {
		// Step 1: Download the video
		console.log(`[cataloger] Downloading: ${video.name} (${(parseInt(video.size) / (1024 * 1024)).toFixed(0)} MB)`);
		const videoPath = await downloadVideoToTemp(video);

		// Step 2: Get duration
		const duration = getVideoDuration(videoPath);
		console.log(`[cataloger] Duration: ${duration.toFixed(1)}s`);

		// Step 3: Extract frames
		console.log(`[cataloger] Extracting frames...`);
		const framePaths = extractFrames(videoPath, video.id);

		if (framePaths.length === 0) {
			console.log(`[cataloger] No frames extracted for ${video.name}`);
			cleanupTempFiles(video.id);
			return createBasicEntry(video, duration, 'Could not extract frames from video');
		}

		console.log(`[cataloger] Extracted ${framePaths.length} frames, sending to GPT-4o vision...`);

		// Step 4: Build the multi-image message content for Vercel AI SDK
		const contentParts: Array<{ type: 'image'; image: Uint8Array } | { type: 'text'; text: string }> = [];

		for (let i = 0; i < framePaths.length; i++) {
			const framePath = framePaths[i];
			if (!framePath) continue;
			const imageBuffer = fs.readFileSync(framePath);
			contentParts.push({
				type: 'image',
				image: new Uint8Array(imageBuffer),
			});
		}

		// Frame label text
		const pctLabels = ['10%', '33%', '60%', '85%'];
		const frameLabels = framePaths.map((_, i) =>
			`Frame ${i + 1}: ${pctLabels[i] || '?'} through the video`,
		).join('\n');

		contentParts.push({
			type: 'text',
			text: `${VISION_PROMPT}\n\nThese ${framePaths.length} frames are from the same video (${video.name}, ${duration.toFixed(0)} seconds long):\n${frameLabels}\n\nAnalyze ALL frames together to build a complete picture of this video's content. If signage, branding, or readable text appears in ANY frame, report it.`,
		});

		// Step 5: Send to GPT-4o via Vercel AI SDK
		const result = await generateText({
			model: openai('gpt-4o'),
			messages: [
				{
					role: 'user',
					content: contentParts,
				},
			],
		});

		// Step 6: Parse the response
		let jsonStr = result.text.trim();
		if (jsonStr.startsWith('```')) {
			jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
		}

		const analysis = JSON.parse(jsonStr);

		// Step 7: Run scene analysis (optional — don't fail cataloging if this fails)
		let sceneAnalysisResult: CatalogEntry['sceneAnalysis'] | undefined;
		try {
			// Run scene detection on the already-downloaded video (avoids re-downloading)
			sceneAnalysisResult = await analyzeVideoScenesFromPath(videoPath, duration);
			console.log(`[cataloger] Scene analysis: ${sceneAnalysisResult?.sceneChanges.length || 0} scene changes detected`);
		} catch (err) {
			console.warn(`[cataloger] Scene analysis skipped for ${video.name}: ${err}`);
		}

		// Step 7b: Semantic scene descriptions (optional — adds GPT-4o vision analysis at scene timestamps)
		if (sceneAnalysisResult && sceneAnalysisResult.sceneChanges.length > 0) {
			try {
				const { describeSceneTimestamps } = await import('./scene-analyzer');
				const descriptions = await describeSceneTimestamps(videoPath, sceneAnalysisResult as any, 6);
				if (descriptions.length > 0) {
					(sceneAnalysisResult as any).sceneDescriptions = descriptions;
					const actionCount = descriptions.filter(d => d.isAction).length;
					console.log(`[cataloger] Scene descriptions: ${descriptions.length} timestamps described, ${actionCount} action moments, ${descriptions.length - actionCount} non-action`);
				}
			} catch (err) {
				console.warn(`[cataloger] Scene descriptions skipped for ${video.name}: ${err}`);
			}
		}

		// Step 7c: Visual timeline via contact sheet (dense, cheap, high-coverage)
		// Generates a single contact sheet image with 20-30 thumbnails, then sends
		// it to GPT-4o-mini in ONE call — 10x cheaper than individual frame scoring
		// while providing 3-5x denser temporal coverage.
		// MUST run before step 7d: its frame timestamps are the densest boundary
		// source we have, and named segments are near-worthless without them on
		// static-camera sports footage — see the boundary-source comment in
		// generateNamedSegments (scene-analyzer.ts).
		let visualTimeline: CatalogEntry['visualTimeline'] | undefined;
		let timelineBoundaries: number[] = [];
		try {
			const { generateContactSheet, cleanupContactSheet } = await import('./contact-sheet');
			const { analyzeContactSheet } = await import('./visual-timeline');

			const contactSheet = await generateContactSheet(videoPath, video.id, duration);
			console.log(`[cataloger] Contact sheet: ${contactSheet.totalFrames} frames, ${contactSheet.gridCols}x${contactSheet.gridRows} grid, interval=${contactSheet.frameInterval}s`);

			const timeline = await analyzeContactSheet(contactSheet, analysis.activity || '');
			visualTimeline = timeline;
			timelineBoundaries = timeline.frames
				.map(f => f.timestamp)
				.filter(t => typeof t === 'number' && isFinite(t));

			const actionFrames = timeline.frames.filter(f => f.isAction).length;
			console.log(`[cataloger] Visual timeline: ${timeline.frames.length} frames analyzed, ${actionFrames} action, ${timeline.actionWindows.length} action windows, ${timeline.bestMoments.length} best moments`);

			cleanupContactSheet(contactSheet);
		} catch (err) {
			console.warn(`[cataloger] Visual timeline skipped for ${video.name}: ${err}`);
		}

		// Step 7d: Generate named segments (pure computation, no API calls)
		// Seeded with the step 7c timeline timestamps so boundaries come from the
		// dense 30-frame sampling, not just FFmpeg scene-change + <=6 scene frames.
		if (sceneAnalysisResult && sceneAnalysisResult.duration > 0) {
			try {
				const { generateNamedSegments } = await import('./scene-analyzer');
				const segments = generateNamedSegments(
					sceneAnalysisResult as any,
					analysis.activity || '',
					mapContentType(analysis.contentType),
					timelineBoundaries,
				);
				if (segments.length > 0) {
					(sceneAnalysisResult as any).namedSegments = segments;
					const actionSegs = segments.filter(s => s.type === 'action').length;
					const dialogueSegs = segments.filter(s => s.type === 'dialogue').length;
					console.log(`[cataloger] Named segments: ${segments.length} segments (${actionSegs} action, ${dialogueSegs} dialogue) from ${timelineBoundaries.length} timeline boundaries, full timeline coverage`);
				}
			} catch (err) {
				console.warn(`[cataloger] Named segments skipped for ${video.name}: ${err}`);
			}
		}

		// Step 7e: Timestamp-aware action scoring
		let timestampScores: CatalogEntry['timestampScores'] | undefined;
		try {
			timestampScores = await scoreVideoTimestamps(videoPath, video.id, duration);
			console.log(`[cataloger] Timestamp scores: ${timestampScores?.length || 0} timestamps scored`);
		} catch (err) {
			console.warn(`[cataloger] Timestamp scoring skipped for ${video.name}: ${err}`);
		}

		// Step 8: Clean up temp files
		cleanupTempFiles(video.id);

		// Step 9: Build catalog entry
		const locationConfidence = analysis.locationConfidence || 'unknown';

		return {
			fileId: video.id,
			filename: video.name,
			duration: duration > 0 ? `${Math.round(duration)}s` : undefined,
			suspectedLocation: analysis.suspectedLocation || 'Unknown',
			locationConfidence: locationConfidence as CatalogEntry['locationConfidence'],
			locationClues: analysis.locationClues || '',
			contentType: mapContentType(analysis.contentType),
			activity: analysis.activity || '',
			peopleCount: analysis.peopleCount || undefined,
			quality: mapQuality(analysis.quality),
			indoorOutdoor: analysis.indoorOutdoor || 'unknown',
			notableMoments: blankIfEmpty(analysis.notableMoments),
			readableText: blankIfEmpty(analysis.readableText),
			suggestedModes: filterValidModes(analysis.suggestedModes || []),
			thumbnailLink: video.thumbnailLink || undefined,
			needsManualReview:
				locationConfidence === 'low' ||
				locationConfidence === 'unknown',
			reviewNotes: buildReviewNotes(analysis),
			sceneAnalysis: sceneAnalysisResult,
			timestampScores,
			visualTimeline,
		};

	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);

		// Clean up on failure
		cleanupTempFiles(video.id);

		// Retry on transient failures
		if (retryCount < MAX_RETRIES) {
			console.log(`[cataloger] Retry ${retryCount + 1}/${MAX_RETRIES} for ${video.name}: ${errorMsg}`);
			await sleep(2000 * (retryCount + 1));
			return analyzeVideoFrames(video, retryCount + 1);
		}

		console.log(`[cataloger] Failed ${video.name} after ${MAX_RETRIES} retries: ${errorMsg}`);
		return createBasicEntry(video, 0, `Analysis failed: ${errorMsg}`);
	}
}

// --- Helper Functions ---

/**
 * Normalize a free-text field from the vision response to `undefined` when it
 * carries no information. GPT-4o does not honour the prompt's lowercase 'none'
 * sentinel consistently — it returns "None", "N/A", "Unknown" and empty strings
 * too, and a strict `!== 'none'` check let those literals leak into downstream
 * edit prompts (confirmed in 15 of 247 catalog entries).
 */
const blankIfEmpty = (v: unknown): string | undefined => {
	if (typeof v !== 'string') return undefined;
	const trimmed = v.trim();
	if (trimmed === '') return undefined;
	const normalized = trimmed.toLowerCase();
	if (normalized === 'none' || normalized === 'n/a' || normalized === 'unknown') return undefined;
	return trimmed;
};

/**
 * Map content type string from GPT response to valid enum value
 */
function mapContentType(raw: string): CatalogEntry['contentType'] {
	const valid: CatalogEntry['contentType'][] = [
		'tennis_action', 'chess', 'interview', 'event', 'establishing', 'mixed', 'unknown',
	];
	const normalized = (raw || 'unknown').toLowerCase().replace(/\s+/g, '_');
	return valid.includes(normalized as CatalogEntry['contentType'])
		? (normalized as CatalogEntry['contentType'])
		: 'unknown';
}

/**
 * Map quality string from GPT response to valid enum value
 */
function mapQuality(raw: string): CatalogEntry['quality'] {
	const valid: CatalogEntry['quality'][] = ['excellent', 'good', 'fair', 'poor'];
	const normalized = (raw || 'good').toLowerCase();
	return valid.includes(normalized as CatalogEntry['quality'])
		? (normalized as CatalogEntry['quality'])
		: 'good';
}

/**
 * Filter suggested modes to only include valid values
 */
function filterValidModes(modes: string[]): CatalogEntry['suggestedModes'] {
	const validModes = ['game_day', 'our_story', 'quick_hit', 'showcase'];
	return modes.filter((m) => validModes.includes(m)) as CatalogEntry['suggestedModes'];
}

/**
 * Build review notes based on analysis confidence
 */
function buildReviewNotes(analysis: Record<string, unknown>): string {
	const parts: string[] = [];
	if (analysis.locationConfidence === 'high') {
		parts.push('High confidence location match');
	} else if (analysis.locationConfidence === 'medium') {
		parts.push('Medium confidence - verify location');
	} else {
		parts.push('Low/unknown confidence - needs human review');
	}
	if (analysis.readableText && analysis.readableText !== 'none') {
		parts.push('Readable text found in frames');
	}
	return parts.join('. ');
}

/**
 * Create a basic/placeholder catalog entry when analysis fails
 */
function createBasicEntry(video: VideoFile, duration: number, reason: string): CatalogEntry {
	const entry: CatalogEntry = {
		fileId: video.id,
		filename: video.name,
		duration: duration > 0 ? `${Math.round(duration)}s` : undefined,
		suspectedLocation: 'Unknown',
		locationConfidence: 'unknown',
		locationClues: '',
		contentType: 'unknown',
		activity: '',
		quality: 'good',
		indoorOutdoor: 'unknown',
		suggestedModes: [],
		thumbnailLink: video.thumbnailLink || undefined,
		needsManualReview: true,
		reviewNotes: reason,
	};

	// Try to extract clues from filename
	applyFilenameHeuristics(entry, video.name);

	return entry;
}

/**
 * Apply filename-based heuristics for location and content type
 */
function applyFilenameHeuristics(entry: CatalogEntry, filename: string): void {
	const lower = filename.toLowerCase();

	// Location from filename
	if (entry.suspectedLocation === 'Unknown') {
		if (lower.includes('us open') || lower.includes('usopen') || lower.includes('usta')) {
			entry.suspectedLocation = 'US Open';
			entry.locationClues += ' (filename match)';
		} else if (lower.includes('hempstead') || lower.includes('hmp')) {
			entry.suspectedLocation = 'Hempstead';
			entry.locationClues += ' (filename match)';
		} else if (lower.includes('long beach') || lower.includes('lb')) {
			entry.suspectedLocation = 'Long Beach';
			entry.locationClues += ' (filename match)';
		} else if (lower.includes('brooklyn') || lower.includes('bk')) {
			entry.suspectedLocation = 'Brooklyn';
			entry.locationClues += ' (filename match)';
		} else if (lower.includes('westchester') || lower.includes('wc')) {
			entry.suspectedLocation = 'Westchester';
			entry.locationClues += ' (filename match)';
		} else if (lower.includes('connecticut') || lower.includes('ct')) {
			entry.suspectedLocation = 'Connecticut';
			entry.locationClues += ' (filename match)';
		} else if (lower.includes('newark') || lower.includes('nj')) {
			entry.suspectedLocation = 'Newark NJ';
			entry.locationClues += ' (filename match)';
		}
	}

	// Content type from filename
	if (entry.contentType === 'unknown') {
		if (lower.includes('tennis') || lower.includes('match') || lower.includes('rally')) {
			entry.contentType = 'tennis_action';
		} else if (lower.includes('chess')) {
			entry.contentType = 'chess';
		} else if (lower.includes('interview') || lower.includes('talk')) {
			entry.contentType = 'interview';
		} else if (lower.includes('event') || lower.includes('ceremony') || lower.includes('gala')) {
			entry.contentType = 'event';
		}
	}
}

// --- Timestamp-Aware Action Scoring ---

const TIMESTAMP_SCORING_PROMPT = `You are scoring frames from a youth tennis/chess nonprofit (CLC) video for video editing. Each frame is from a specific timestamp. Score each frame on the axes below. Note the scales differ: movement, people, tennis and energy are 1-5; subjectFillRatio is 0.0-1.0; emotion is 0-10; valence and beat are labels, not numbers.

- movement: How much physical motion/action is visible? (1=static/empty/ground/sky, 2=slight movement, 3=moderate activity, 4=active gameplay, 5=peak action like serve/rally/celebration)
- people: Are KIDS/PLAYERS actively visible and engaged? (1=empty/no people/backs only, 2=distant figures, 3=people visible but passive/spectating, 4=kids clearly visible and active, 5=close-up of kids playing/celebrating)
  IMPORTANT: Spectators sitting and watching = 2-3, NOT 4-5. We want clips of kids PLAYING, not crowds watching.
  CRITICAL FRAMING RULE: people score CANNOT exceed 3 if the subject occupies less than ~25% of the frame. A kid as a small figure in the corner of a wide stadium shot = people 2 max, regardless of how clearly visible they are. We only call people 4-5 when the player IS the visual focal point of the frame.

- subjectFillRatio: How much of the frame does the dominant subject (player/kid/coach) occupy? Score 0.0 to 1.0:
  - 0.0-0.10: subject barely visible / signage-or-court-dominated frame / no clear subject
  - 0.10-0.20: subject is a small element (corner of wide shot, distant figure)
  - 0.20-0.35: subject is clearly visible but not dominant (medium-wide shot)
  - 0.35-0.60: subject is the visual focal point (medium shot, half-body)
  - 0.60-1.00: subject fills the frame (close-up, action shot)
  Score this HONESTLY. A frame with a J.P. Morgan banner taking 70% of the image and a kid in the corner = subjectFillRatio 0.10, NOT higher. A tequila wall with no people = 0.0.
- tennis: How directly does this show tennis/chess GAMEPLAY? (1=irrelevant/empty space, 2=court visible but no play, 3=people near court/equipment, 4=active drills/practice, 5=rally/match/direct gameplay)
  IMPORTANT: An empty court or people standing around = 1-2. Actual ball-hitting, serving, rallying = 4-5.
- energy: How visually compelling is this for a social media clip? (1=boring/static/empty, 2=mildly interesting, 3=decent content, 4=engaging action, 5=viral-worthy moment)

- emotion: 0-10. How much visible HUMAN FEELING is in this frame, INDEPENDENT of athletic quality.
  - 0-2: neutral. Walking, waiting, standing, listening.
  - 3-4: mild engagement. Focused concentration, a small smile.
  - 5-6: clear feeling. Laughing, visible effort, encouragement between kids.
  - 7-8: strong. Celebration, a coach's hand on a shoulder, visible frustration, a kid's face lighting up.
  - 9-10: peak. Tears, arms thrown up, a hug, a total crash-out.
  IMPORTANT: Score emotion on the FACE and BODY LANGUAGE of the people, not on how exciting the sport action is. A perfectly struck forehand with a blank expression is emotion 2, athletic 5. A kid missing an easy shot and covering their face is emotion 8, athletic 1. ("athletic" here means the movement/tennis axes above — emotion is scored separately from them, and the two often disagree.)
  If no people are visible at all (signage, empty court, shadows, ground/sky), emotion is 0 and valence is "neutral".
  Faces you cannot read are not evidence of feeling — backs turned, distant figures, or motion blur where no expression is legible cap emotion at 3, no matter what the body is doing.

- valence: the emotional DIRECTION of the feeling. One of "positive" | "neutral" | "negative".
  - "positive": joy, pride, encouragement, celebration, warmth, focus that looks eager.
  - "neutral": no clear direction — routine play, waiting, walking, b-roll, no legible faces.
  - "negative": frustration, disappointment, exhaustion, tears, slumping, a kid pulling away.
  Valence describes the FEELING, not the quality of the footage. A kid slumping after losing a point is a GREAT clip with "negative" valence — do not soften it to "neutral" because it looks sad.

- beat: the narrative role this moment could play in an edited story. One of: "hook" | "setup" | "struggle" | "turn" | "triumph" | "reflection" | "community" | "none".
  - "hook": arresting enough to open on — a face mid-reaction, a ball being struck clean, a striking angle.
  - "setup": establishes who and where — arrivals, courts filling, a coach starting a drill.
  - "struggle": visible effort or difficulty — a missed shot, frustration, fatigue, resetting to try again.
  - "turn": the moment something changes — the shot that finally lands, an expression flipping mid-frame.
  - "triumph": the payoff — celebration, a point won, a high five, arms up.
  - "reflection": quiet aftermath — catching breath, a look off-court, sitting down, a private smile.
  - "community": people together — huddles, group shots, a coach beside a kid, teammates side by side.
  - "none": nothing an editor could use — signage, empty court, shadows, blurred transitions.
  Pick the SINGLE strongest role. If you would not put this frame in any edit, use "none" — "none" is the correct answer for most b-roll frames.

CRITICAL — BE SKEPTICAL BY DEFAULT:
Most frames in these source videos are b-roll: signage, shadows, empty courts, ground/sky, transitions between plays, videographer setup. Those ARE the dominant content, not the exception. Your default score should be LOW.

Do NOT inflate scores based on CONTEXT. Tennis branding, stadium logos, court paint, coach's back, or a distant figure walking near a court all fail the test of "is tennis ACTUALLY being played in this exact frame". If you are not literally looking at a player striking a ball, chess piece being moved, or a kid in mid-celebration, then:
  - movement MUST be <=2
  - tennis MUST be <=2
  - people MUST be <=2 (even if you see silhouettes/shadows implying people)
  - energy MUST be <=3 (signage can be visually striking but it's not GAMEPLAY energy)

Examples of common failure patterns — score these HONESTLY LOW:
  - "US Open signage" / any stadium banner = movement 1, tennis 1, people 1, energy 2, subjectFillRatio 0.0 (even if branding looks cool)
  - "Tequila/sponsor wall with no people" = movement 1, tennis 1, people 1, energy 1, subjectFillRatio 0.0
  - "Wide stadium shot with kid as small figure on right side" = movement 2, people 2, tennis 2, energy 2, subjectFillRatio 0.10 (kid is visible but NOT the focal point)
  - "Videographer's shadow on court" = movement 1, people 1, tennis 1, energy 1, subjectFillRatio 0.0
  - "Empty court with paint/lines visible" = movement 1, people 1, tennis 2, energy 1, subjectFillRatio 0.0
  - "People sitting watching" = movement 2, people 3, tennis 2, energy 2, subjectFillRatio 0.30
  - "Kid walking on court holding racket" = movement 2, people 3, tennis 3, energy 2, subjectFillRatio 0.30 — NOT 4-5

Only score 4-5 on tennis/movement when you can IDENTIFY the specific action happening (e.g. "forehand swing", "serve toss", "chess piece being moved"). If you cannot name the specific action, score <=3.

Also provide:
- brief: 10-word-max description. Be specific and LITERAL — "signage, no players visible" is correct for signage. Do NOT write "tennis action" unless you can see the action. Describe only what is visible in THIS frame.
- subjectPosition: Where are the main subjects (people/action) in the frame? Use one of: "center", "bottom-center", "bottom-left", "bottom-right", "top-center", "left", "right". If no subject is visible (empty/signage/shadows), use "center" as a safe default.

Return ONLY a JSON array, one object per frame in the order provided:
[{"timestamp": 5.0, "movement": 3, "people": 4, "tennis": 5, "energy": 4, "subjectFillRatio": 0.45, "emotion": 6, "valence": "positive", "beat": "turn", "brief": "Two kids rallying on hard court", "subjectPosition": "bottom-center"}]

No markdown, no explanation, just the JSON array.`;

// Upper bound on frames sent to the scorer per video. Keeps the per-video cost
// bounded on long clips while still allowing dense sampling on short ones.
const MAX_SCORED_FRAMES = 26;

// --- Content-aware frame selection (overextract → dedup → even-sample) ---
// A uniform grid spends the 26-frame budget on the clock, not the content: on
// the interview clips it lands on walls and ceilings between camera moves.
// Instead: extract tiny grayscale thumbnails on a dense candidate grid, drop
// frames nearly identical to the last kept one, and even-sample the survivors
// down to the budget. Thumbnails are extracted with one fast seek per
// candidate (the same -ss pattern the scoring loop uses) rather than a single
// full-decode pass: full decode of a 3-minute clip exceeds any sane timeout on
// the cloud vCPU, and a seeked frame sits exactly at its recorded timestamp,
// so the frame judged for novelty IS the frame later scored. Cost stays capped
// at MAX_SCORED_FRAMES but short clips (<~150s) now use more of the budget
// than the old sparse grid did (~1.4-2.6x frames there), spent on distinct
// moments.
const DENSE_GRID_SECONDS = 2;    // candidate spacing floor
const CANDIDATE_TARGET = 60;     // max thumbnail seeks per video; spacing widens on long clips
const DEDUP_THUMB = 16;          // thumbnail edge in px; 16x16 gray = 256 bytes
const DEDUP_THRESHOLD = 2.0;     // mean abs pixel diff (0-255) below which frames are "the same"
const MIN_SCORED_FRAMES = 12;    // floor so static videos still yield a usable timeline map

/**
 * A scored timestamp plus the emotional axes.
 *
 * The base element type lives on CatalogEntry in google-drive.ts; the three
 * emotional fields are layered on here so they survive serialization into the
 * catalog without widening the shared type. Widen
 * CatalogEntry['timestampScores'] with the same three optional fields when you
 * want downstream consumers (pipeline-v2 composers) to read them type-safely.
 */
type ScoredTimestamp = NonNullable<CatalogEntry['timestampScores']>[number] & {
	emotion?: number;
	valence?: string;
	beat?: string;
};

/**
 * Choose a sampling interval based on video duration.
 * The editor cuts 4-second clips, so a flat 10s interval (18 samples on a 180s
 * clip) is far too coarse to actually locate "the 4 good seconds". Sample
 * denser on short clips, then widen as needed so the frame count stays under
 * MAX_SCORED_FRAMES.
 */
function chooseInterval(duration: number): number {
	const base = duration <= 60 ? 5 : duration <= 150 ? 6 : 8;
	// Widen if the base interval would blow the frame budget (e.g. a 300s clip
	// at 8s would be ~36 frames; ceil(300/26) = 12s keeps it at ~24).
	const budgeted = Math.ceil(duration / MAX_SCORED_FRAMES);
	return Math.max(base, budgeted);
}

/** Evenly pick `target` items from a sorted array, always keeping first and last. */
function evenSample<T>(items: T[], target: number): T[] {
	if (items.length <= target) return items;
	if (target <= 1) return [items[0]!];
	const picked: T[] = [];
	const seen = new Set<number>();
	for (let i = 0; i < target; i++) {
		const idx = Math.round((i * (items.length - 1)) / (target - 1));
		if (!seen.has(idx)) {
			seen.add(idx);
			picked.push(items[idx]!);
		}
	}
	return picked;
}

/**
 * Pick scoring timestamps by visual novelty instead of the clock.
 *
 * Extracts a 16x16 grayscale thumbnail at each candidate timestamp (fast seek
 * per candidate, exact frame); a greedy walk drops frames whose mean pixel
 * diff vs the LAST KEPT frame is below DEDUP_THRESHOLD (near-identical), and
 * survivors are even-sampled down to MAX_SCORED_FRAMES. If dedup collapses a
 * static video below MIN_SCORED_FRAMES, survivors are topped up with an even
 * spread over all candidates — survivors are never dropped by the floor, so a
 * lone distinct moment always stays.
 *
 * Returns null when extraction fails for >20% of candidates (broken ffmpeg,
 * truncated file) so the caller can fall back to the uniform grid rather than
 * score a partially-covered timeline. Exported for local testing.
 */
export function selectScoringTimestamps(videoPath: string, duration: number): number[] | null {
	try {
		const frameBytes = DEDUP_THUMB * DEDUP_THUMB;
		const step = Math.max(DENSE_GRID_SECONDS, Math.ceil((duration - 4) / CANDIDATE_TARGET));
		const candidateTs: number[] = [];
		for (let t = DENSE_GRID_SECONDS; t < duration - 2; t += step) {
			candidateTs.push(t);
		}
		if (candidateTs.length === 0) return null;

		const candidates: Array<{ ts: number; thumb: Buffer }> = [];
		let failures = 0;
		for (const ts of candidateTs) {
			try {
				const raw = execSync(
					`ffmpeg -y -loglevel error -ss ${ts.toFixed(2)} -i "${videoPath}" -frames:v 1 -vf "scale=${DEDUP_THUMB}:${DEDUP_THUMB},format=gray" -f rawvideo -`,
					{ timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 },
				) as unknown as Buffer;
				if (raw.length >= frameBytes) {
					candidates.push({ ts, thumb: raw.subarray(0, frameBytes) });
				} else {
					failures++;
				}
			} catch {
				failures++;
			}
		}

		// A high failure rate means the environment (not the video) is the problem;
		// score the uniform grid instead of a partially-covered timeline.
		if (candidates.length === 0 || failures > candidateTs.length * 0.2) {
			console.warn(
				`[cataloger] sampler extracted ${candidates.length}/${candidateTs.length} thumbnails (${failures} failures) — falling back to uniform grid`,
			);
			return null;
		}

		// Greedy dedup: keep a frame only if it differs enough from the last kept one.
		const kept: Array<{ ts: number; thumb: Buffer }> = [candidates[0]!];
		for (let i = 1; i < candidates.length; i++) {
			const prev = kept[kept.length - 1]!.thumb;
			const cur = candidates[i]!.thumb;
			let diff = 0;
			for (let p = 0; p < frameBytes; p++) {
				diff += Math.abs(cur[p]! - prev[p]!);
			}
			if (diff / frameBytes > DEDUP_THRESHOLD) {
				kept.push(candidates[i]!);
			}
		}

		let selected = evenSample(kept, MAX_SCORED_FRAMES).map(c => c.ts);
		if (selected.length < MIN_SCORED_FRAMES && candidates.length > selected.length) {
			// Static video: dedup collapsed almost everything. Keep every survivor
			// and top up with an even spread so the timeline map stays usable.
			const floor = evenSample(candidates, Math.min(MIN_SCORED_FRAMES, candidates.length)).map(c => c.ts);
			selected = [...new Set([...selected, ...floor])].sort((a, b) => a - b);
		}

		console.log(
			`[cataloger] sampling: ${candidates.length} candidates -> ${kept.length} after dedup -> ${selected.length} selected (budget ${MAX_SCORED_FRAMES})`,
		);
		return selected;
	} catch (err) {
		console.warn(`[cataloger] content-aware sampling failed, falling back to uniform grid: ${err}`);
		return null;
	}
}

/**
 * Score video timestamps for action quality using GPT-4o vision.
 * Extracts a frame every intervalSeconds, batches them, and scores.
 * When intervalSeconds is omitted, timestamps are chosen by visual novelty
 * via selectScoringTimestamps() (falling back to the uniform grid on failure);
 * passing intervalSeconds explicitly still forces the uniform grid.
 * Returns sorted array of timestamp scores.
 */
async function scoreVideoTimestamps(
	videoPath: string,
	fileId: string,
	duration: number,
	intervalSeconds?: number,
	batchSize: number = 6,
): Promise<CatalogEntry['timestampScores']> {
	if (duration < 15) {
		console.log('[cataloger] Video too short for timestamp scoring (<15s)');
		return undefined;
	}

	const tempDir = ensureTempDir();

	// Content-aware selection unless an explicit interval forces the uniform grid.
	const smartTimestamps = intervalSeconds === undefined
		? selectScoringTimestamps(videoPath, duration)
		: null;

	let timestamps: number[];
	if (smartTimestamps && smartTimestamps.length > 0) {
		timestamps = smartTimestamps;
		console.log(`[cataloger] Scoring ${timestamps.length} timestamps (content-aware, duration ${duration.toFixed(0)}s)...`);
	} else {
		const interval = intervalSeconds ?? chooseInterval(duration);
		timestamps = [];
		for (let t = interval; t < duration - 2; t += interval) {
			timestamps.push(t);
		}
		console.log(`[cataloger] Scoring ${timestamps.length} timestamps (every ${interval}s, duration ${duration.toFixed(0)}s)...`);
	}

	const allScores: ScoredTimestamp[] = [];

	// Process in batches
	for (let batchIdx = 0; batchIdx < timestamps.length; batchIdx += batchSize) {
		// Memory safety check
		const heap = process.memoryUsage().heapUsed;
		if (heap > 800 * 1024 * 1024) {
			console.warn(`[cataloger] Heap at ${Math.round(heap / 1024 / 1024)}MB, stopping timestamp scoring`);
			break;
		}

		const batch = timestamps.slice(batchIdx, batchIdx + batchSize);
		const framePaths: Array<{ timestamp: number; path: string }> = [];

		// Extract frames for this batch (low-res to save memory)
		for (const ts of batch) {
			const framePath = path.join(tempDir, `${fileId}_score_${ts.toFixed(0)}.jpg`);
			try {
				execSync(
					`ffmpeg -y -ss ${ts.toFixed(2)} -i "${videoPath}" -frames:v 1 -vf scale=512:-1 -q:v 5 "${framePath}"`,
					{ timeout: 15000, stdio: 'pipe' },
				);
				if (fs.existsSync(framePath)) {
					framePaths.push({ timestamp: ts, path: framePath });
				}
			} catch {
				// Skip failed frames
			}
		}

		if (framePaths.length === 0) continue;

		// Build vision request
		const contentParts: Array<{ type: 'image'; image: Uint8Array } | { type: 'text'; text: string }> = [];
		for (const fp of framePaths) {
			contentParts.push({
				type: 'image',
				image: new Uint8Array(fs.readFileSync(fp.path)),
			});
		}

		const frameLabels = framePaths.map(fp => `Frame at ${fp.timestamp.toFixed(0)}s`).join(', ');
		contentParts.push({
			type: 'text',
			text: `${TIMESTAMP_SCORING_PROMPT}\n\nFrames (in order): ${frameLabels}\n\nTimestamps: ${framePaths.map(fp => fp.timestamp).join(', ')}`,
		});

		// Call GPT-4o
		try {
			// Model rationale: reverted from gpt-4o-mini to gpt-4o after confirming the
			// cheaper model produces false-positive high scores on signage/shadows/empty-
			// court frames — it conflates "tennis context" (branding, court paint) with
			// "tennis gameplay" (actual play). gpt-4o discriminates these far more
			// reliably. Score cost is bounded (one-time per video) and dominated by
			// downstream rendering cost, so the per-token premium is worth it.
			// Diagnosis history: 2026-04-22 — usopen2.mp4 render allocated 8s of output
			// to "confirmed rally action, energy 5/5" at a frame that was actually
			// stadium signage, tracked back to gpt-4o-mini hallucinating that score.
			const result = await generateText({
				model: openai('gpt-4o'),
				// A hung scoring request froze the whole rescore loop behind the
				// in-flight guard (observed 2026-08-15: flat for 90+ min with Drive
				// healthy). Kill the request itself rather than racing it.
				abortSignal: AbortSignal.timeout(120_000),
				messages: [{ role: 'user', content: contentParts }],
			});

			let jsonStr = result.text.trim();
			if (jsonStr.startsWith('```')) {
				jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
			}

			const scores = JSON.parse(jsonStr) as Array<{
				timestamp: number;
				movement: number;
				people: number;
				tennis: number;
				energy: number;
				brief: string;
				subjectPosition?: string;
				subjectFillRatio?: number;
				emotion?: number;
				valence?: string;
				beat?: string;
			}>;

			// Use original timestamps (not model-returned ones) to avoid hallucinated values
			for (let k = 0; k < scores.length && k < framePaths.length; k++) {
				const score = scores[k]!;
				const originalTs = framePaths[k]!.timestamp;

				// Weight tennis and movement higher — we want gameplay, not spectators.
				// subjectFillRatio gates the score: a frame where the player occupies
				// <20% of the image is fundamentally a wall shot regardless of how
				// "active" the GPT-4o description sounds, so we cap actionQuality
				// when the subject isn't actually the focal point.
				const fillRatio = typeof score.subjectFillRatio === 'number'
					? Math.max(0, Math.min(1, score.subjectFillRatio))
					: 0.30; // default for old data without the field
				const rawScore = Math.round(
					(score.movement * 1.5 + score.people + score.tennis * 1.5 + score.energy) / 5 * 2,
				);
				// Apply subjectFillRatio as a multiplier — a wall shot can't score above ~3
				// even if other axes are inflated. Curve: 0.0→0.3x, 0.20→0.6x, 0.35→0.85x, 0.5+→1.0x
				const fillMultiplier = fillRatio < 0.10 ? 0.30
					: fillRatio < 0.20 ? 0.60
					: fillRatio < 0.35 ? 0.85
					: 1.0;
				const finalScore = Math.min(10, Math.max(1, Math.round(rawScore * fillMultiplier)));
				// Emotional axes. These deliberately do NOT feed actionQuality — the
				// composite formula above is unchanged. They ride alongside it so the
				// editor can find "the kid celebrating" separately from "the best
				// tennis". Labels are lowercased so downstream exact-match filters
				// don't trip over "Positive" / "Triumph".
				const emotion = typeof score.emotion === 'number' && isFinite(score.emotion)
					? Math.max(0, Math.min(10, Math.round(score.emotion)))
					: undefined;
				const valence = typeof score.valence === 'string' && score.valence.trim() !== ''
					? score.valence.trim().toLowerCase()
					: undefined;
				const beat = typeof score.beat === 'string' && score.beat.trim() !== ''
					? score.beat.trim().toLowerCase()
					: undefined;
				// Per-frame diagnostic log — makes it visible during rescore whether the
				// model is producing believable scores. Format chosen to be greppable
				// in Railway logs: look for "[cataloger] score ts=" prefix.
				console.log(
					`[cataloger] score ts=${originalTs}s q=${finalScore}/10 m=${score.movement} p=${score.people} t=${score.tennis} e=${score.energy} fill=${fillRatio.toFixed(2)} emo=${emotion ?? '-'}/10 val=${valence || '-'} beat=${beat || '-'} pos=${score.subjectPosition || 'bottom-center'} brief="${(score.brief || '').slice(0, 60)}"`,
				);
				allScores.push({
					timestamp: originalTs,
					actionQuality: finalScore,
					movement: score.movement,
					people: score.people,
					tennis: score.tennis,
					energy: score.energy,
					subjectFillRatio: fillRatio,
					brief: score.brief,
					subjectPosition: score.subjectPosition || 'center',
					emotion,
					valence,
					beat,
				});
			}
		} catch (err) {
			console.warn(`[cataloger] Scoring batch failed (ts ${batch[0]}-${batch[batch.length - 1]}s): ${err}`);
		}

		// Clean up frame files immediately
		for (const fp of framePaths) {
			try { fs.unlinkSync(fp.path); } catch { /* ignore */ }
		}

		// Rate limit between batches
		if (batchIdx + batchSize < timestamps.length) {
			await sleep(1000);
		}
	}

	// Sort by actionQuality descending
	allScores.sort((a, b) => b.actionQuality - a.actionQuality);
	console.log(`[cataloger] Scored ${allScores.length} timestamps. Top: ${allScores.slice(0, 3).map(s => `${s.timestamp}s=${s.actionQuality}/10`).join(', ')}`);

	return allScores.length > 0 ? allScores : undefined;
}

// --- Resume/Skip Logic ---

/**
 * Load existing catalog from local file if it exists,
 * falling back to the bundled seed data from catalog-seed.json
 */
/** Set once per process so we only ever hit Drive on a cold start. */
let catalogHydrated = false;
/** After a failed restore, wait this long before trying Drive again. */
const HYDRATE_RETRY_COOLDOWN_MS = 60_000;
let hydrateCooldownUntil = 0;
/** Guards against N concurrent cold-start requests all fetching the same file. */
let hydrateInFlight: Promise<void> | null = null;

/**
 * Restore the runtime catalog from Drive when the local copy is missing.
 *
 * MUST be awaited once before anything calls loadExistingCatalog(), which is
 * synchronous (24 call sites) and cannot itself download. Cheap and idempotent:
 * after the first successful run it is a no-op for the life of the process.
 *
 * The failure this prevents: PERSISTENT_DIR falls back to process.cwd() when
 * /data is not mounted, so on Railway the enriched catalog sits on an ephemeral
 * filesystem. A redeploy wipes it, loadExistingCatalog() finds nothing, and
 * quietly returns the bundled 247-entry seed with none of the emotion scores or
 * timestamps. Nothing errors. The videos just go back to guessing.
 */
export async function hydrateCatalogFromDrive(force = false): Promise<{
	restored: boolean;
	count: number;
	source: 'local' | 'kv' | 'supabase' | 'drive' | 'seed' | 'skipped';
}> {
	if (catalogHydrated && !force) return { restored: false, count: 0, source: 'skipped' };
	if (!force && Date.now() < hydrateCooldownUntil) {
		return { restored: false, count: 0, source: 'skipped' };
	}
	// Collapse concurrent cold-start callers onto one Drive fetch.
	if (hydrateInFlight && !force) {
		await hydrateInFlight;
		return { restored: false, count: 0, source: 'skipped' };
	}

	// A healthy local file means nothing to do.
	if (!force && fs.existsSync(CATALOG_RESULTS_PATH)) {
		try {
			const existing = JSON.parse(fs.readFileSync(CATALOG_RESULTS_PATH, 'utf-8')) as CatalogEntry[];
			if (Array.isArray(existing) && existing.length > 0) {
				catalogHydrated = true;
				return { restored: false, count: existing.length, source: 'local' };
			}
		} catch { /* fall through and re-fetch */ }
	}

	// Loud, because running on an ephemeral filesystem is the root cause of the
	// silent-revert failure and the operator should see it in the logs.
	if (!fs.existsSync('/data')) {
		console.warn(
			'[cataloger] /data is NOT mounted — the catalog is being written to an EPHEMERAL filesystem (%s). '
			+ 'Mount a Railway volume at /data, or every redeploy discards catalog enrichment.',
			PERSISTENT_DIR,
		);
	}

	// Platform KV first — the credential-free backup (see saveCatalog).
	const fromKV = await fetchCatalogFromKV();
	if (fromKV && fromKV.length > 0) {
		try {
			fs.mkdirSync(path.dirname(CATALOG_RESULTS_PATH), { recursive: true });
			fs.writeFileSync(CATALOG_RESULTS_PATH, JSON.stringify(fromKV, null, 2), 'utf-8');
		} catch { /* restored in-memory; cache write retries next time */ }
		catalogHydrated = true;
		console.log('[cataloger] Catalog restored from KV (%d entries)', fromKV.length);
		return { restored: true, count: fromKV.length, source: 'kv' };
	}

	// Then Supabase (works when creds are present; Drive uploads fail silently
	// on service-account storage quota; see saveCatalog).
	const fromSupabase = await fetchCatalogFromSupabase();
	if (fromSupabase && fromSupabase.length > 0) {
		try {
			fs.mkdirSync(path.dirname(CATALOG_RESULTS_PATH), { recursive: true });
			fs.writeFileSync(CATALOG_RESULTS_PATH, JSON.stringify(fromSupabase, null, 2), 'utf-8');
		} catch { /* still restored in-memory; next load retries the cache write */ }
		catalogHydrated = true;
		console.log('[cataloger] Catalog restored from Supabase (%d entries)', fromSupabase.length);
		return { restored: true, count: fromSupabase.length, source: 'supabase' };
	}

	const restored = await fetchLatestCatalogFromDrive();
	if (!restored || restored.catalog.length === 0) {
		// Deliberately do NOT set catalogHydrated. A transient Drive failure (429,
		// 503, token refresh) on the first request after a redeploy would
		// otherwise pin this process to the bundled seed for its entire life —
		// which is exactly the silent regression this function exists to prevent.
		// Back off instead, so we retry without hammering Drive on every request.
		hydrateCooldownUntil = Date.now() + HYDRATE_RETRY_COOLDOWN_MS;
		console.warn('[cataloger] Could not restore catalog from Drive — using the bundled seed for now. '
			+ 'If you have run a backfill, its results are NOT loaded. Retrying in %ds.',
			Math.round(HYDRATE_RETRY_COOLDOWN_MS / 1000));
		return { restored: false, count: 0, source: 'seed' };
	}

	try {
		fs.mkdirSync(path.dirname(CATALOG_RESULTS_PATH), { recursive: true });
		fs.writeFileSync(CATALOG_RESULTS_PATH, JSON.stringify(restored.catalog, null, 2), 'utf-8');
		console.log('[cataloger] Catalog restored from Drive (%s) -> %s (%d entries)',
			restored.fileName, CATALOG_RESULTS_PATH, restored.catalog.length);
	} catch (err) {
		// Even if the cache write fails, the data is in memory-adjacent Drive and
		// the next call will retry. Don't mark hydrated so we try again.
		console.warn('[cataloger] Restored from Drive but could not cache locally:', (err as Error).message);
		return { restored: true, count: restored.catalog.length, source: 'drive' };
	}

	catalogHydrated = true;
	return { restored: true, count: restored.catalog.length, source: 'drive' };
}

export function loadExistingCatalog(): CatalogEntry[] {
	// Try runtime file first (written by saveCatalog during live cataloging)
	if (fs.existsSync(CATALOG_RESULTS_PATH)) {
		try {
			const catalogJson = fs.readFileSync(CATALOG_RESULTS_PATH, 'utf-8');
			const catalog = JSON.parse(catalogJson) as CatalogEntry[];
			console.log(`[cataloger] Loaded ${catalog.length} existing entries from ${CATALOG_RESULTS_PATH}`);
			return catalog;
		} catch (err) {
			console.warn('[cataloger] Failed to load runtime catalog:', err);
		}
	}

	// Fall back to bundled seed data (embedded at build time)
	if (catalogSeedData && Array.isArray(catalogSeedData) && catalogSeedData.length > 0) {
		console.log(`[cataloger] Loaded ${catalogSeedData.length} entries from bundled catalog seed`);
		return catalogSeedData as CatalogEntry[];
	}

	return [];
}

/**
 * Build a set of fileIds that already have catalog entries
 */
function buildProcessedFileSet(catalog: CatalogEntry[]): Set<string> {
	return new Set(catalog.map(entry => entry.fileId));
}

// --- Exported Core Functions ---

/**
 * Catalog a single video file using multi-frame extraction.
 * Accepts either a VideoFile object or a file ID string.
 */
export async function catalogSingleVideo(videoOrId: VideoFile | string): Promise<CatalogEntry> {
	let video: VideoFile;

	if (typeof videoOrId === 'string') {
		// Fetch metadata to build VideoFile object
		const metadata = await getVideoMetadata(videoOrId);
		video = {
			id: metadata.id!,
			name: metadata.name!,
			mimeType: metadata.mimeType!,
			size: metadata.size || '0',
			createdTime: metadata.createdTime!,
			modifiedTime: metadata.modifiedTime!,
			thumbnailLink: metadata.thumbnailLink || undefined,
			webViewLink: metadata.webViewLink || undefined,
			webContentLink: metadata.webContentLink || undefined,
			parentFolderId: (metadata.parents && metadata.parents[0]) || '',
		};
	} else {
		video = videoOrId;
	}

	return analyzeVideoFrames(video);
}

/**
 * Run the full catalog pipeline on all videos in the folder.
 * Downloads each video, extracts 4 frames via FFmpeg, analyzes with GPT-4o,
 * then cleans up temp files. Processes in batches with rate limiting
 * and incremental saves.
 * 
 * Resume support: If catalog-results.json exists, loads it and skips
 * videos that have already been processed.
 */
export async function runFullCatalog(
	config: Partial<CatalogConfig> = {},
	onProgress?: (progress: CatalogProgress) => void,
): Promise<CatalogProgress> {
	const cfg: CatalogConfig = {
		batchSize: config.batchSize || BATCH_SIZE,
		delayBetweenFiles: config.delayBetweenFiles || DELAY_BETWEEN_FILES,
		delayBetweenBatches: config.delayBetweenBatches || DELAY_BETWEEN_BATCHES,
		maxRetries: config.maxRetries || MAX_RETRIES,
		saveInterval: config.saveInterval || SAVE_INTERVAL,
	};

	console.log('[cataloger] Starting full catalog run (multi-frame extraction)...');
	console.log(`[cataloger] Config: batch=${cfg.batchSize}, fileDelay=${cfg.delayBetweenFiles}ms, batchDelay=${cfg.delayBetweenBatches}ms`);

	// Load existing catalog for resume support
	const existingCatalog = loadExistingCatalog();
	const processedFileIds = buildProcessedFileSet(existingCatalog);

	// Clean up any leftover temp files from previous runs
	cleanupAllTempFiles();

	// Check disk space
	const availableGB = getAvailableDiskSpace();
	if (availableGB >= 0 && availableGB < 2) {
		console.log(`[cataloger] WARNING: Only ${availableGB}GB available. Need at least 2GB for video processing.`);
		return {
			total: 0,
			completed: 0,
			failed: 0,
			skipped: 0,
			catalog: existingCatalog,
			errors: [{ fileId: '', filename: '', error: `Insufficient disk space: ${availableGB}GB available, need 2GB` }],
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
	}
	if (availableGB > 0) {
		console.log(`[cataloger] Disk space available: ${availableGB}GB`);
	}

	// Get all videos
	const allVideos = await listVideoFiles();
	
	// Filter out videos that have already been processed
	const videosToProcess = allVideos.filter(video => !processedFileIds.has(video.id));
	const skippedCount = allVideos.length - videosToProcess.length;

	console.log(`[cataloger] Found ${allVideos.length} total videos`);
	console.log(`[cataloger] Skipping ${skippedCount} already processed videos`);
	console.log(`[cataloger] Need to process ${videosToProcess.length} videos`);

	if (videosToProcess.length === 0) {
		console.log('[cataloger] All videos already processed! Nothing to do.');
		return {
			total: allVideos.length,
			completed: existingCatalog.length,
			failed: 0,
			skipped: skippedCount,
			catalog: existingCatalog,
			errors: [],
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
	}

	const progress: CatalogProgress = {
		total: allVideos.length,
		completed: existingCatalog.length,
		failed: 0,
		skipped: skippedCount,
		catalog: [...existingCatalog], // Start with existing entries
		errors: [],
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	// Process in batches (only unprocessed videos)
	for (let batchStart = 0; batchStart < videosToProcess.length; batchStart += cfg.batchSize) {
		const batchEnd = Math.min(batchStart + cfg.batchSize, videosToProcess.length);
		const batch = videosToProcess.slice(batchStart, batchEnd);
		const batchNum = Math.floor(batchStart / cfg.batchSize) + 1;
		const totalBatches = Math.ceil(videosToProcess.length / cfg.batchSize);

		console.log(`[cataloger] --- Batch ${batchNum}/${totalBatches} (${batchStart + 1}-${batchEnd} of ${videosToProcess.length} remaining) ---`);

		for (const video of batch) {
			progress.currentFile = video.name;
			progress.updatedAt = new Date().toISOString();

			if (onProgress) onProgress({ ...progress });

			try {
				const entry = await catalogSingleVideo(video);
				progress.catalog.push(entry);
				progress.completed++;

				console.log(
					`[cataloger] [${progress.completed}/${progress.total}] ${video.name} -> ${entry.suspectedLocation} / ${entry.contentType} (${entry.locationConfidence})${entry.readableText ? ' [TEXT FOUND]' : ''}`,
				);
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				console.error(`[cataloger] Failed: ${video.name}: ${errorMsg}`);
				progress.failed++;
				progress.errors.push({
					fileId: video.id,
					filename: video.name,
					error: errorMsg,
				});

				// Add placeholder entry
				progress.catalog.push(
					createBasicEntry(video, 0, `Cataloging failed: ${errorMsg}`),
				);
			}

			// Delay between files
			await sleep(cfg.delayBetweenFiles);

			// Incremental save
			if (progress.completed > 0 && progress.completed % cfg.saveInterval === 0) {
				console.log(`[cataloger] Saving incremental progress (${progress.completed} files)...`);
				try {
					await saveCatalog(progress.catalog);
					console.log('[cataloger] Incremental save complete');
				} catch (err) {
					console.warn('[cataloger] Incremental save failed:', err);
				}
			}
		}

		// Delay between batches (unless this is the last batch)
		if (batchEnd < videosToProcess.length) {
			console.log(`[cataloger] Batch ${batchNum} complete. Pausing ${cfg.delayBetweenBatches / 1000}s before next batch...`);
			await sleep(cfg.delayBetweenBatches);
		}
	}

	// Final save
	progress.currentFile = undefined;
	progress.updatedAt = new Date().toISOString();

	console.log('[cataloger] Saving final catalog...');
	try {
		const link = await saveCatalog(progress.catalog);
		console.log(`[cataloger] Final catalog saved: ${link}`);
	} catch (err) {
		console.error('[cataloger] Final save failed:', err);
	}

	// Clean up temp directory
	cleanupAllTempFiles();

	console.log(`[cataloger] Catalog complete!`);
	console.log(`[cataloger]   Total: ${progress.total}`);
	console.log(`[cataloger]   Completed: ${progress.completed}`);
	console.log(`[cataloger]   Failed: ${progress.failed}`);
	console.log(`[cataloger]   Skipped: ${progress.skipped}`);

	if (onProgress) onProgress({ ...progress });

	return progress;
}

/**
 * Get a summary of catalog results
 */
export function getCatalogSummary(catalog: CatalogEntry[]): {
	total: number;
	byLocation: Record<string, number>;
	byContentType: Record<string, number>;
	byQuality: Record<string, number>;
	needsReview: number;
	confidenceBreakdown: Record<string, number>;
	withReadableText: number;
} {
	const byLocation: Record<string, number> = {};
	const byContentType: Record<string, number> = {};
	const byQuality: Record<string, number> = {};
	const confidenceBreakdown: Record<string, number> = {};
	let needsReview = 0;
	let withReadableText = 0;

	for (const entry of catalog) {
		byLocation[entry.suspectedLocation] = (byLocation[entry.suspectedLocation] || 0) + 1;
		byContentType[entry.contentType] = (byContentType[entry.contentType] || 0) + 1;
		byQuality[entry.quality] = (byQuality[entry.quality] || 0) + 1;
		confidenceBreakdown[entry.locationConfidence] = (confidenceBreakdown[entry.locationConfidence] || 0) + 1;
		if (entry.needsManualReview) needsReview++;
		if (entry.readableText) withReadableText++;
	}

	return {
		total: catalog.length,
		byLocation,
		byContentType,
		byQuality,
		needsReview,
		confidenceBreakdown,
		withReadableText,
	};
}

// --- Single Entry Update ---

/**
 * Update a single catalog entry's location or content type.
 * Loads the existing catalog, finds the entry by fileId,
 * applies the updates, and persists the result.
 *
 * Returns the updated entry, or null if not found.
 */
export function updateCatalogEntry(
	fileId: string,
	updates: {
		suspectedLocation?: string;
		contentType?: string;
	},
): CatalogEntry | null {
	const catalog = loadExistingCatalog();
	const index = catalog.findIndex((entry) => entry.fileId === fileId);

	if (index === -1) {
		console.warn(`[cataloger] updateCatalogEntry: fileId ${fileId} not found in catalog`);
		return null;
	}

	const entry = catalog[index]!;

	if (updates.suspectedLocation !== undefined) {
		entry.suspectedLocation = updates.suspectedLocation;
		entry.locationConfidence = 'high';
	}

	if (updates.contentType !== undefined) {
		entry.contentType = updates.contentType as CatalogEntry['contentType'];
	}

	// Mark as manually reviewed
	entry.needsManualReview = false;
	entry.reviewNotes = `Manually updated: ${[
		updates.suspectedLocation ? `location → ${updates.suspectedLocation}` : '',
		updates.contentType ? `type → ${updates.contentType}` : '',
	].filter(Boolean).join(', ')}`;

	// Persist changes
	try {
		fs.writeFileSync(CATALOG_RESULTS_PATH, JSON.stringify(catalog, null, 2), 'utf-8');
		console.log(`[cataloger] Updated entry ${fileId}: ${entry.reviewNotes}`);
	} catch (err) {
		console.error('[cataloger] Failed to persist catalog update:', err);
	}

	return entry;
}

// --- Background Catalog Job ---

export interface CatalogJobStatus {
	state: 'idle' | 'running' | 'completed' | 'error';
	total: number;
	completed: number;
	failed: number;
	skipped: number;
	currentFile?: string;
	startedAt?: string;
	updatedAt?: string;
	errorMessage?: string;
}

let _catalogJob: CatalogJobStatus = { state: 'idle', total: 0, completed: 0, failed: 0, skipped: 0 };

/**
 * Get the current background catalog job status.
 */
export function getCatalogJobStatus(): CatalogJobStatus {
	return { ..._catalogJob };
}

/**
 * Start a background catalog run. Returns immediately with the job status.
 * The catalog processes asynchronously — poll getCatalogJobStatus() for updates.
 * If a job is already running, returns false.
 */
export function startBackgroundCatalog(config: Partial<CatalogConfig> = {}): boolean {
	if (_catalogJob.state === 'running') {
		console.log('[cataloger] Background job already running, ignoring start request');
		return false;
	}

	_catalogJob = {
		state: 'running',
		total: 0,
		completed: 0,
		failed: 0,
		skipped: 0,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	// Fire and forget — the promise runs in the background
	runFullCatalog(config, (progress) => {
		_catalogJob.total = progress.total;
		_catalogJob.completed = progress.completed;
		_catalogJob.failed = progress.failed;
		_catalogJob.skipped = progress.skipped;
		_catalogJob.currentFile = progress.currentFile;
		_catalogJob.updatedAt = new Date().toISOString();
	}).then((finalProgress) => {
		_catalogJob.state = 'completed';
		_catalogJob.total = finalProgress.total;
		_catalogJob.completed = finalProgress.completed;
		_catalogJob.failed = finalProgress.failed;
		_catalogJob.skipped = finalProgress.skipped;
		_catalogJob.currentFile = undefined;
		_catalogJob.updatedAt = new Date().toISOString();
		console.log(`[cataloger] Background job completed: ${finalProgress.completed}/${finalProgress.total}`);
	}).catch((err) => {
		_catalogJob.state = 'error';
		_catalogJob.errorMessage = err instanceof Error ? err.message : String(err);
		_catalogJob.updatedAt = new Date().toISOString();
		console.error('[cataloger] Background job failed:', err);
	});

	return true;
}

/**
 * Get the set of fileIds that have already been cataloged.
 * Used by the frontend to distinguish "never analyzed" from "analyzed but unknown".
 */
export function getProcessedFileIds(): string[] {
	const catalog = loadExistingCatalog();
	return catalog.map(entry => entry.fileId);
}

/**
 * Re-score existing catalog entries with timestamp-aware action scoring.
 * Downloads each video, runs scoreVideoTimestamps, saves scores to catalog.
 * Skips entries that already have timestampScores unless force=true.
 */
/**
 * Guards against concurrent rescore loops: each HTTP re-trigger of the
 * rescore task previously started ANOTHER full loop over the same entries,
 * multiplying Drive downloads exactly when a stalled run tempts the operator
 * (or a driver script) to re-trigger. Mirrors the _catalogJob running guard.
 */
let _rescoreInFlight = false;

/**
 * Reject if a promise takes longer than ms. The underlying operation is not
 * aborted (Drive downloads have no cancel path here) — the point is to keep
 * the rescore LOOP moving: without this, one stalled download on a throttled
 * Drive connection hangs the loop forever, and the in-flight guard then
 * blocks every recovery re-trigger as a duplicate.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
		p.then(
			v => { clearTimeout(t); resolve(v); },
			e => { clearTimeout(t); reject(e); },
		);
	});
}

export async function rescoreExistingCatalog(
	options: { force?: boolean; fileIds?: string[] } = {},
	onProgress?: (completed: number, total: number, currentFile: string) => void,
): Promise<{ scored: number; skipped: number; failed: number }> {
	if (_rescoreInFlight) {
		console.log('[cataloger] Re-score already running — ignoring duplicate trigger');
		return { scored: 0, skipped: 0, failed: 0 };
	}
	_rescoreInFlight = true;
	try {
		return await rescoreExistingCatalogInner(options, onProgress);
	} finally {
		_rescoreInFlight = false;
	}
}

async function rescoreExistingCatalogInner(
	options: { force?: boolean; fileIds?: string[] } = {},
	onProgress?: (completed: number, total: number, currentFile: string) => void,
): Promise<{ scored: number; skipped: number; failed: number }> {
	const catalog = loadExistingCatalog();
	let toScore = catalog;

	if (options.fileIds && options.fileIds.length > 0) {
		const ids = new Set(options.fileIds);
		toScore = catalog.filter(e => ids.has(e.fileId));
	}

	if (!options.force) {
		toScore = toScore.filter(e => !e.timestampScores || e.timestampScores.length === 0);
	}

	console.log(`[cataloger] Re-scoring ${toScore.length} entries (${catalog.length} total, force=${!!options.force})`);

	let scored = 0;
	let skipped = 0;
	let failed = 0;

	for (const entry of toScore) {
		const duration = entry.duration ? parseInt(entry.duration) : 0;
		if (duration < 15) {
			skipped++;
			continue;
		}

		if (onProgress) onProgress(scored + failed + skipped, toScore.length, entry.filename);

		try {
			// Download video to temp (bounded — see withTimeout)
			const video = await withTimeout(getVideoMetadata(entry.fileId), 60_000, `metadata ${entry.filename}`);
			const videoFile: VideoFile = {
				id: entry.fileId,
				name: entry.filename,
				mimeType: video.mimeType || 'video/mp4',
				size: video.size || '0',
				createdTime: video.createdTime || '',
				modifiedTime: video.modifiedTime || '',
				parentFolderId: (video.parents && video.parents[0]) || '',
			};

			const videoPath = await withTimeout(downloadVideoToTemp(videoFile), 10 * 60_000, `download ${entry.filename}`);
			const actualDuration = getVideoDuration(videoPath);

			// Run timestamp scoring. The outer ceiling guarantees no video —
			// whatever the failure mode inside — can freeze the loop; a video
			// that blows it fails alone and the next sweep retries it.
			const scores = await withTimeout(
				scoreVideoTimestamps(videoPath, entry.fileId, actualDuration),
				25 * 60_000,
				`scoring ${entry.filename}`,
			);

			// Update the entry in the catalog
			const catalogIndex = catalog.findIndex(e => e.fileId === entry.fileId);
			if (catalogIndex >= 0 && scores) {
				catalog[catalogIndex]!.timestampScores = scores;
				scored++;
				console.log(`[cataloger] Scored ${entry.filename}: ${scores.length} timestamps, top=${scores[0]?.actionQuality}/10 at ${scores[0]?.timestamp}s`);
			} else {
				skipped++;
			}

			// Clean up
			cleanupTempFiles(entry.fileId);

			// Rate limit
			await sleep(2000);
		} catch (err) {
			failed++;
			console.error(`[cataloger] Re-score failed for ${entry.filename}: ${err}`);
			cleanupTempFiles(entry.fileId);
		}

		// Incremental save every 5
		if ((scored + failed) % 5 === 0 && scored > 0) {
			try {
				await saveCatalog(catalog);
				console.log(`[cataloger] Incremental re-score save (${scored} scored)`);
			} catch { /* continue */ }
		}
	}

	// Final save
	if (scored > 0) {
		try {
			await saveCatalog(catalog);
		} catch (err) {
			console.error('[cataloger] Failed to save re-scored catalog:', err);
		}
	}

	console.log(`[cataloger] Re-score complete: ${scored} scored, ${skipped} skipped, ${failed} failed`);
	return { scored, skipped, failed };
}

// --- Scene Analysis Helper ---

/**
 * Run scene analysis on an already-downloaded video file.
 * Avoids re-downloading the video since the cataloger already has it locally.
 */
async function analyzeVideoScenesFromPath(
	videoPath: string,
	duration: number,
): Promise<CatalogEntry['sceneAnalysis']> {
	// Scene detection using FFmpeg — same logic as scene-analyzer.ts
	// but operates on a local path instead of downloading from Drive

	// Use metadata=print to capture actual scene scores instead of hardcoding
	let sceneOutput = '';
	try {
		sceneOutput = execSync(
			`ffmpeg -i "${videoPath}" -vf "select='gt(scene,0.3)',metadata=print:key=lavfi.scene_score" -f null - 2>&1`,
			{ encoding: 'utf-8', timeout: 120000 },
		);
	} catch (err: any) {
		if (err.stderr) {
			sceneOutput = err.stderr.toString();
		} else if (err.stdout) {
			sceneOutput = err.stdout.toString();
		}
	}

	const sceneChanges: Array<{ timestamp: number; score: number }> = [];
	// Parse timestamps and scores from FFmpeg output
	const ptsRegex = /pts_time:\s*(\d+\.?\d*)/g;
	const scoreRegex = /lavfi\.scene_score=(\d+\.?\d*)/g;
	const timestamps: number[] = [];
	const scores: number[] = [];

	let match;
	while ((match = ptsRegex.exec(sceneOutput)) !== null) {
		const ts = parseFloat(match[1]!);
		if (!isNaN(ts)) timestamps.push(ts);
	}
	while ((match = scoreRegex.exec(sceneOutput)) !== null) {
		const sc = parseFloat(match[1]!);
		if (!isNaN(sc)) scores.push(sc);
	}

	for (let i = 0; i < timestamps.length; i++) {
		sceneChanges.push({
			timestamp: Math.round(timestamps[i]! * 10) / 10,
			score: Math.round((scores[i] ?? 0.5) * 1000) / 1000, // real score or fallback
		});
	}

	const highMotionMoments = sceneChanges
		.filter(sc => sc.timestamp > 2 && sc.timestamp < duration * 0.8)
		.map(sc => sc.timestamp);

	const quietMoments: number[] = [];
	const sorted = [...sceneChanges].sort((a, b) => a.timestamp - b.timestamp);

	if (sorted.length > 0 && sorted[0]!.timestamp > 5) {
		quietMoments.push(sorted[0]!.timestamp / 2);
	}
	for (let i = 0; i < sorted.length - 1; i++) {
		const gap = sorted[i + 1]!.timestamp - sorted[i]!.timestamp;
		if (gap > 5) {
			quietMoments.push(sorted[i]!.timestamp + gap / 2);
		}
	}
	if (sorted.length > 0) {
		const last = sorted[sorted.length - 1]!;
		if (duration - last.timestamp > 5) {
			quietMoments.push(last.timestamp + (duration - last.timestamp) / 2);
		}
	}

	const earlyScenes = sceneChanges.filter(sc => sc.timestamp < duration * 0.3);
	const recommendedHooks = earlyScenes.slice(0, 5).map(sc => sc.timestamp);

	// If no hooks found from scene changes, suggest evenly spaced timestamps in first 30%
	if (recommendedHooks.length === 0 && duration > 3) {
		const hookWindow = duration * 0.3;
		recommendedHooks.push(
			Math.round(hookWindow * 0.2 * 10) / 10,
			Math.round(hookWindow * 0.5 * 10) / 10,
			Math.round(hookWindow * 0.8 * 10) / 10,
		);
	}

	return {
		duration,
		sceneChanges,
		highMotionMoments,
		quietMoments,
		recommendedHooks,
	};
}

// --- Utility ---

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
