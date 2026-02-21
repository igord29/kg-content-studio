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
	type VideoFile,
	type CatalogEntry,
} from './google-drive';
import catalogSeedData from './catalog-seed.json';

// --- Constants ---

const TEMP_DIR = path.join(process.cwd(), '.temp-cataloger');
const CATALOG_RESULTS_PATH = path.join(process.cwd(), 'catalog-results.json');

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
			notableMoments: analysis.notableMoments !== 'none' ? analysis.notableMoments : undefined,
			readableText: analysis.readableText !== 'none' ? analysis.readableText : undefined,
			suggestedModes: filterValidModes(analysis.suggestedModes || []),
			thumbnailLink: video.thumbnailLink || undefined,
			needsManualReview:
				locationConfidence === 'low' ||
				locationConfidence === 'unknown',
			reviewNotes: buildReviewNotes(analysis),
			sceneAnalysis: sceneAnalysisResult,
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

// --- Resume/Skip Logic ---

/**
 * Load existing catalog from local file if it exists,
 * falling back to the bundled seed data from catalog-seed.json
 */
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

	let sceneOutput = '';
	try {
		sceneOutput = execSync(
			`ffmpeg -i "${videoPath}" -vf "select='gt(scene,0.3)',showinfo" -f null - 2>&1`,
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
	const sceneRegex = /pts_time:\s*(\d+\.?\d*)/g;
	let match;
	while ((match = sceneRegex.exec(sceneOutput)) !== null) {
		const ts = parseFloat(match[1]!);
		if (!isNaN(ts)) {
			sceneChanges.push({ timestamp: ts, score: 0.5 });
		}
	}

	const motionPeaks = sceneChanges
		.filter(sc => sc.timestamp > 1 && sc.timestamp < duration - 1)
		.map(sc => ({ timestamp: sc.timestamp, intensity: sc.score }));

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
	const recommendedHooks = earlyScenes.slice(0, 3).map(sc => sc.timestamp);
	const recommendedCloseups = quietMoments.filter(t => t < duration * 0.5).slice(0, 3);

	return {
		duration,
		sceneChanges,
		motionPeaks,
		quietMoments,
		recommendedHooks,
		recommendedCloseups,
	};
}

// --- Utility ---

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
