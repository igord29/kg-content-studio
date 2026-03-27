/**
 * Video Editor Agent
 * Generates video scripts, FFmpeg commands, edit plans, and manages
 * Google Drive footage library and Shotstack cloud rendering.
 */

import { createAgent } from '@agentuity/runtime';
import { s } from '@agentuity/schema';
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import {
	VIDEO_TEMPLATES,
	getTemplateById,
	getTemplateRecommendations,
	generateVideoScript,
	type VideoClip,
	type TextOverlay,
	type AudioTrack,
} from './video-skill';
import { generateBatchScript, estimateBatchTime, type BatchConfig } from './batch';
import { videoDirectorPrompt } from './video-director-prompt';
import {
	listVideoFiles,
	getFolderSummary,
	getVideoMetadata,
	getVideoThumbnail,
	getHighResThumbnailUrl,
	downloadVideo,
	generateBlankCatalog,
	saveCatalog,
	createCatalogFolderStructure,
	testConnection,
	getOrCreateDateFolder,
	uploadVideoFromUrl,
	uploadVideoFile,
	type VideoFile,
	type CatalogEntry,
} from './google-drive';
import {
	runFullCatalog,
	catalogSingleVideo,
	getCatalogSummary,
	loadExistingCatalog,
	updateCatalogEntry,
	startBackgroundCatalog,
	getCatalogJobStatus,
	getProcessedFileIds,
	type CatalogProgress,
} from './cataloger';
import {
	testShotstackConnection,
	submitRenderTimeline,
	checkStatus,
	buildRenderTimeline,
	getTemporaryPublicUrl,
	revokePublicUrl,
	PLATFORM_SETTINGS,
	MODE_RENDER_SETTINGS,
	type RenderConfig,
} from './shotstack';
import { buildDriveProxyUrl, buildProcessedFileProxyUrl } from './drive-proxy';
import { preprocessAllClips, cleanupProcessedFiles, type PreprocessClipConfig, type PreprocessedClip } from './preprocess';
// Remotion imports are dynamic to prevent Vite from bundling @remotion/renderer
// (which transitively imports @remotion/studio → @remotion/web-renderer)
// import { submitRemotionRender, checkRemotionStatus, testRemotionAvailability } from './remotion/render';
import {
	selectTrack,
	shouldAddMusic,
	getAllTracks,
	getTracksForMode,
	createCustomMusicSelection,
	type MusicTrack,
} from './music';
import { formatSceneAnalysisForPrompt, formatSegmentTimelineForPrompt, generateNamedSegments } from './scene-analyzer';
import { reviewRenderedVideo, generateRevisedEditPlan, type VideoReview } from './video-reviewer';
import {
	type VideoUsageSummary,
	type ClipUsageRecord,
	formatUsageContextForPrompt,
	validateEditPlanDedup,
	generateSemanticTags,
	scoreSearchMatch,
	buildUsageSummaryMap,
} from './usage-tracker';

const AgentInput = s.object({
	// Task type: determines which workflow to run
	task: s.string().optional(), // 'list-videos' | 'folder-summary' | 'catalog' | 'edit' | 'render' | 'render-status' | 'save-render-to-drive' | 'instant-edit' | 'auto-process' | 'render-local' | 'download-render' | 'test-connection' | 'test-shotstack' | 'legacy'

	// Legacy fields (original video-editor interface)
	videoType: s.string().optional(), // 'highlight', 'intro', 'recap', 'testimonial', 'promo', 'story'
	platform: s.string().optional(), // 'tiktok', 'youtube', 'instagram', etc.
	topic: s.string().optional(),
	clips: s.array(s.object({
		path: s.string(),
		startTime: s.number().optional(),
		endTime: s.number().optional(),
		label: s.string().optional(),
	})).optional(),
	templateId: s.string().optional(),
	overlays: s.array(s.object({
		text: s.string(),
		startTime: s.number(),
		duration: s.number(),
		position: s.string(),
	})).optional(),
	backgroundMusic: s.object({
		path: s.string(),
		volume: s.number().optional(),
		fadeOut: s.number().optional(),
	}).optional(),
	mode: s.string().optional(), // 'script' | 'ffmpeg' | 'batch' | 'full'

	// Edit task fields
	videoIds: s.array(s.string()).optional(),
	purpose: s.string().optional(),
	editMode: s.string().optional(), // 'game_day' | 'our_story' | 'quick_hit' | 'showcase' | 'auto'
	platforms: s.array(s.string()).optional(),

	// Render task fields
	editPlan: s.any().optional(), // The AI-generated edit plan with clip info
	renderId: s.string().optional(), // For render-status polling
	renderEngine: s.string().optional(), // 'shotstack' | 'remotion' — which render engine to use

	// Catalog task fields
	catalogAction: s.string().optional(), // 'generate' | 'save' | 'organize' | 'run-full' | 'analyze-single' | 'update-entry'
	catalogData: s.array(s.object({
		fileId: s.string(),
		suspectedLocation: s.string(),
		contentType: s.string(),
		activity: s.string(),
	})).optional(),

	// Single video analysis
	videoId: s.string().optional(),

	// Download render fields
	filePath: s.string().optional(),

	// Catalog config overrides
	batchSize: s.number().optional(),

	// Review task fields
	reviewUrl: s.string().optional(), // Shotstack download URL of rendered video
	originalEditPlan: s.any().optional(), // The edit plan that produced this render
	autoRevise: s.boolean().optional(), // Whether to auto-generate a revised edit plan
	review: s.any().optional(), // Previous review data for generate-revision task

	// Internal: passed by API route for proxy URL construction
	appUrl: s.string().optional(),

	// Usage tracking: passed by API route for freshness-aware edit plans
	usageSummary: s.array(s.any()).optional(),

	// Search catalog query
	query: s.string().optional(),

	// Smart select / generate-segments
	count: s.number().optional(),
	force: s.boolean().optional(),

	// Music fields
	musicUrl: s.string().optional(),
	musicDisabled: s.boolean().optional(),

	// Save-render-to-drive fields
	downloadUrl: s.string().optional(),
});

const AgentOutput = s.object({
	success: s.boolean().optional(),
	message: s.string().optional(),
	error: s.string().optional(),

	// Data results
	count: s.number().optional(),
	videos: s.any().optional(),
	summary: s.any().optional(),
	catalog: s.any().optional(),
	link: s.string().optional(),
	folders: s.any().optional(),
	editPlan: s.string().optional(),
	editPlanData: s.any().optional(),
	videoCount: s.number().optional(),
	progress: s.any().optional(),
	catalogSummary: s.any().optional(),

	// Render output fields
	renderId: s.string().optional(),
	downloadUrl: s.string().optional(),
	renderStatus: s.string().optional(),
	renderPlatform: s.string().optional(),
	renderMode: s.string().optional(),
	ffmpegAvailable: s.boolean().optional(),
	shotstackConnected: s.boolean().optional(),
	remotionAvailable: s.boolean().optional(),
	localOutputPath: s.string().optional(),

	// Download render fields
	filename: s.string().optional(),
	mimeType: s.string().optional(),
	base64Data: s.string().optional(),
	fileSize: s.number().optional(),

	// Review output fields
	review: s.any().optional(),
	revisedEditPlanData: s.any().optional(),

	// Drive save output fields
	fileId: s.string().optional(),
	webViewLink: s.string().optional(),
	folderPath: s.string().optional(),

	// Legacy output fields
	videoScript: s.string().optional(),
	ffmpegCommands: s.string().optional(),
	batchScript: s.string().optional(),
	template: s.object({
		id: s.string(),
		name: s.string(),
		aspectRatio: s.string(),
		duration: s.number(),
	}).optional(),
	recommendations: s.array(s.object({
		templateId: s.string(),
		templateName: s.string(),
		reason: s.string(),
	})).optional(),
	caption: s.string().optional(),
	hashtags: s.array(s.string()).optional(),
	estimatedTime: s.object({
		minutes: s.number(),
		description: s.string(),
	}).optional(),
});

const agent = createAgent('video-editor', {
	description: 'Creates video scripts, editing instructions, FFmpeg commands, and manages Google Drive footage library with cloud rendering',
	schema: {
		input: AgentInput,
		output: AgentOutput,
	},
	handler: async (ctx, input) => {
		const task = input.task || 'legacy';
		ctx.logger.info('[video-editor] Task: %s', task);

		// --- Direct data tasks (no AI needed) ---

		if (task === 'test-connection') {
			const result = await testConnection();
			return { success: result.success, message: result.message };
		}

		if (task === 'test-shotstack') {
			ctx.logger.info('[test-shotstack] API key present: %s', !!process.env.SHOTSTACK_API_KEY);
			ctx.logger.info('[test-shotstack] API key length: %d', (process.env.SHOTSTACK_API_KEY || '').length);
			ctx.logger.info('[test-shotstack] ENV: %s', process.env.SHOTSTACK_ENV || '(not set)');

			try {
				const result = await testShotstackConnection();
				ctx.logger.info('[test-shotstack] Result: %s', JSON.stringify(result));
				return {
					success: result.success,
					shotstackConnected: result.success,
					message: result.message,
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.logger.error('[test-shotstack] Error: %s', msg);
				return {
					success: false,
					shotstackConnected: false,
					message: msg,
				};
			}
		}

		if (task === 'test-remotion') {
			ctx.logger.info('[test-remotion] Checking Remotion availability...');
			try {
				const { testRemotionAvailability } = await import('./remotion/render');
				const result = await testRemotionAvailability(ctx.logger);
				return {
					success: result.available,
					remotionAvailable: result.available,
					message: result.message,
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.logger.error('[test-remotion] Error: %s', msg);
				return {
					success: false,
					remotionAvailable: false,
					message: msg,
				};
			}
		}

		if (task === 'setup-remotion-lambda') {
			ctx.logger.info('[setup-remotion-lambda] Setting up Lambda infrastructure...');
			try {
				const { setupLambdaInfra } = await import('./remotion/render');
				const result = await setupLambdaInfra(ctx.logger);
				return {
					success: result.success,
					remotionAvailable: result.success,
					message: result.message,
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.logger.error('[setup-remotion-lambda] Error: %s', msg);
				return { success: false, remotionAvailable: false, message: msg };
			}
		}

		if (task === 'download-render') {
			const { filePath } = input;

			if (!filePath) {
				return { success: false, error: 'No file path provided' };
			}

			try {
				const fs = await import('fs');
				const path = await import('path');

				// Security: only allow downloads from the temp render directory
				const allowedDir = path.resolve('.temp-cataloger');
				const resolvedPath = path.resolve(filePath);

				if (!resolvedPath.startsWith(allowedDir)) {
					return { success: false, error: 'Access denied: file not in render directory' };
				}

				if (!fs.existsSync(resolvedPath)) {
					return { success: false, error: 'File not found: ' + filePath };
				}

				const fileBuffer = fs.readFileSync(resolvedPath);
				const base64 = fileBuffer.toString('base64');
				const filename = path.basename(resolvedPath);

				ctx.logger.info('[download-render] Serving file: %s (%d bytes)', filename, fileBuffer.length);

				return {
					success: true,
					filename,
					mimeType: 'video/mp4',
					base64Data: base64,
					fileSize: fileBuffer.length,
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.logger.error('[download-render] Error: %s', msg);
				return { success: false, error: 'Download failed: ' + msg };
			}
		}

		// --- Render tasks ---

		if (task === 'render') {
			const rawEditPlan = input.editPlan;
			const platform = input.platform || 'tiktok';
			const editMode = input.editMode || 'game_day';
			const appUrl = input.appUrl;
			const renderEngine = (input as any).renderEngine as string | undefined;

			// editPlan should be the structured JSON from the edit task's editPlanData
			const editPlanObj = (rawEditPlan && typeof rawEditPlan === 'object')
				? rawEditPlan as Record<string, unknown>
				: null;

			if (!editPlanObj || !Array.isArray(editPlanObj.clips) || editPlanObj.clips.length === 0) {
				return {
					success: false,
					error: 'No structured edit plan provided. Generate an edit plan first, then render.',
				};
			}

			// --- Remotion Lambda render path ---
			if (renderEngine === 'remotion') {
				if (!appUrl) {
					return {
						success: false,
						error: 'App URL not available. Cannot build proxy URLs for Remotion Lambda.',
					};
				}

				const rawClips = editPlanObj.clips as Array<{
					fileId: string;
					filename?: string;
					trimStart?: number;
					duration?: number;
					purpose?: string;
					speed?: number;
				}>;

				// Validate and fix file IDs against catalog — Claude can hallucinate
				// characters in long Google Drive IDs. Match by filename or fuzzy ID.
				const catalogForValidation = loadExistingCatalog();
				const catalogByFile = new Map(catalogForValidation.map(e => [e.filename, e.fileId]));
				const catalogIds = new Set(catalogForValidation.map(e => e.fileId));

				const clips = rawClips.map(clip => {
					if (catalogIds.has(clip.fileId)) return clip; // ID is valid
					// Try matching by filename
					if (clip.filename && catalogByFile.has(clip.filename)) {
						const correctId = catalogByFile.get(clip.filename)!;
						ctx.logger.warn('[render] Fixed hallucinated fileId for %s: %s → %s',
							clip.filename, clip.fileId, correctId);
						return { ...clip, fileId: correctId };
					}
					// Fuzzy match: find the catalog ID with the smallest edit distance
					let bestMatch = '';
					let bestScore = 0;
					for (const catId of catalogIds) {
						// Count matching characters in same positions
						let matches = 0;
						for (let i = 0; i < Math.min(catId.length, clip.fileId.length); i++) {
							if (catId[i] === clip.fileId[i]) matches++;
						}
						if (matches > bestScore) {
							bestScore = matches;
							bestMatch = catId;
						}
					}
					if (bestScore > clip.fileId.length * 0.7) {
						ctx.logger.warn('[render] Fuzzy-matched fileId %s → %s (%d/%d chars match)',
							clip.fileId, bestMatch, bestScore, clip.fileId.length);
						return { ...clip, fileId: bestMatch };
					}
					ctx.logger.warn('[render] Could not validate fileId: %s (filename: %s)', clip.fileId, clip.filename);
					return clip;
				});

				const overlays = (editPlanObj.textOverlays || []) as Array<{
					text: string;
					start: number;
					duration: number;
					position?: string;
				}>;

				// Music selection (same logic as Shotstack path)
				const musicDisabled = (input as any).musicDisabled === true;
				const editPlanMusicUrl = (editPlanObj.musicUrl as string) || null;
				const editPlanMusicTier = (editPlanObj.musicTier as number) || undefined;
				const editPlanMusicDirection = (editPlanObj.musicDirection as string) || undefined;
				const customMusicUrl = (input as any).musicUrl as string | undefined;

				let musicUrl: string | null = musicDisabled ? null : editPlanMusicUrl;
				if (!musicDisabled && !musicUrl && customMusicUrl) {
					musicUrl = customMusicUrl;
				}
				if (!musicDisabled && !musicUrl && shouldAddMusic(platform, editPlanMusicTier)) {
					const selection = selectTrack(editMode, editPlanMusicDirection);
					if (selection) {
						musicUrl = selection.track.url;
						ctx.logger.info('[render-remotion] Auto-selected music: "%s" by %s',
							selection.track.title, selection.track.artist);
					}
				}

				const totalEditDuration = clips.reduce((sum, c) => sum + (c.duration || 0), 0);
				ctx.logger.info('[render-remotion] Starting Remotion Lambda render: %d clips, platform: %s, mode: %s, total: %ds',
					clips.length, platform, editMode, totalEditDuration);

				// --- Render Pipeline Selection ---
				// Force direct pipeline (skip preprocessor) until preprocessor reliability is fixed.
				// The preprocessor Lambda invocations hang during batch processing, causing renders
				// to sit at "still preprocessing" forever. Direct pipeline works: Drive → S3 → Remotion Lambda.
				const usePreprocessor = false;

				if (usePreprocessor) {
					// --- Preprocessed Pipeline (Drive → S3 → FFmpeg Lambda → S3 → Remotion Lambda) ---
					// Pre-register render ID immediately so frontend polling works during the
					// multi-minute pipeline (upload → preprocess → render). The async block runs
					// independently of the Agentuity 60s session timeout.
					const {
						preRegisterRender,
						submitRemotionRenderWithPreprocessing,
					} = await import('./remotion/render');

					const renderId = `remotion_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
					preRegisterRender(renderId);

					ctx.logger.info('[render-remotion] Pre-registered render %s. Starting preprocessed pipeline (async)...', renderId);

					// Fire-and-forget: runs asynchronously beyond the session timeout.
					// The render registry tracks progress; frontend polls via render-status.
					submitRemotionRenderWithPreprocessing(
						{
							clips,
							textOverlays: overlays,
							musicUrl,
							mode: editMode,
							platform,
						},
						renderId,
						ctx.logger,
					).catch((err) => {
						const msg = err instanceof Error ? err.message : String(err);
						ctx.logger.error('[render-remotion] Async pipeline error: %s', msg);
					});

					return {
						success: true,
						renderId,
						renderPlatform: platform,
						renderMode: editMode,
						message: `Remotion Lambda render submitted: ${clips.length} clips (stabilized + sharpened via preprocessor Lambda)`,
					};

				} else {
					// --- Direct Pipeline (Drive → S3 → Remotion Lambda) ---
					// No preprocessor Lambda deployed. Upload raw clips directly.
					ctx.logger.info('[render-remotion] Preprocessor Lambda not configured. Using direct S3 upload (no stabilization).');
					const { submitRemotionRenderDirect } = await import('./remotion/render');

					const renderId = await submitRemotionRenderDirect(
						{
							clips,
							textOverlays: overlays,
							musicUrl,
							mode: editMode,
							platform,
						},
						appUrl,
						ctx.logger,
					);
					ctx.logger.info('[render-remotion] Submitted to Lambda. Render ID: %s', renderId);

					return {
						success: true,
						renderId,
						renderPlatform: platform,
						renderMode: editMode,
						message: `Remotion Lambda render submitted: ${clips.length} clips (raw → S3 → Lambda, no stabilization)`,
					};
				}
			}

			// --- Shotstack render path (default) ---

			if (!appUrl) {
				return {
					success: false,
					error: 'App URL not available. Cannot build proxy URLs for Shotstack.',
				};
			}

			const clips = editPlanObj.clips as Array<{
				fileId: string;
				filename?: string;
				trimStart?: number;
				duration?: number;
				purpose?: string;
				speed?: number;
			}>;

			const overlays = (editPlanObj.textOverlays || []) as Array<{
				text: string;
				start: number;
				duration: number;
				position?: string;
			}>;

			// --- Music selection ---
			// Priority: explicit musicUrl from edit plan > custom URL from input > auto-select from library
			// If user disabled music in UI, skip entirely
			const musicDisabled = (input as any).musicDisabled === true;
			const editPlanMusicUrl = (editPlanObj.musicUrl as string) || null;
			const editPlanMusicTier = (editPlanObj.musicTier as number) || undefined;
			const editPlanMusicDirection = (editPlanObj.musicDirection as string) || undefined;
			const customMusicUrl = (input as any).musicUrl as string | undefined;

			let musicUrl: string | null = musicDisabled ? null : editPlanMusicUrl;
			let musicSource = musicDisabled ? 'disabled' : 'edit-plan';

			if (!musicDisabled && !musicUrl && customMusicUrl) {
				// User provided a custom music URL via the UI
				musicUrl = customMusicUrl;
				musicSource = 'custom';
			}

			if (!musicDisabled && !musicUrl && shouldAddMusic(platform, editPlanMusicTier)) {
				// Auto-select from curated library based on mode and mood
				const selection = selectTrack(editMode, editPlanMusicDirection);
				if (selection) {
					musicUrl = selection.track.url;
					musicSource = `auto:${selection.track.id}`;
					ctx.logger.info('[render] Auto-selected music: "%s" by %s (mood: %s)',
						selection.track.title, selection.track.artist, selection.track.mood.join(', '));
				} else {
					ctx.logger.info('[render] No music track found for mode=%s, skipping', editMode);
				}
			} else if (!musicUrl) {
				ctx.logger.info('[render] Music skipped: tier=%s, platform=%s', editPlanMusicTier, platform);
			}

			const totalEditDuration = clips.reduce((sum, c) => sum + (c.duration || 0), 0);
			ctx.logger.info('[render] Starting cloud render: %d clips, platform: %s, mode: %s, total planned duration: %ds, music: %s',
				clips.length, platform, editMode, totalEditDuration, musicUrl ? musicSource : 'none');

			// --- FFmpeg Pre-Processing Pipeline ---
			// Download each clip from Google Drive, apply sharpening + speed ramping,
			// then serve the processed files via proxy URLs for Shotstack to fetch.
			// This replaces the old direct-proxy approach where raw clips went to Shotstack.

			const preprocessConfigs: PreprocessClipConfig[] = clips.map((clip) => ({
				fileId: clip.fileId,
				filename: clip.filename,
				trimStart: clip.trimStart || 0,
				duration: clip.duration || MODE_RENDER_SETTINGS[editMode]?.defaultClipLength || 5,
				speed: clip.speed,     // undefined = 1.0 (default)
				sharpen: true,         // always sharpen phone footage
				stabilize: false,      // disabled: deshake too slow on 500m CPU
			}));

			let processedClips: PreprocessedClip[];
			try {
				ctx.logger.info('[render] Pre-processing %d clips (sharpen + speed ramp)...', preprocessConfigs.length);
				processedClips = await preprocessAllClips(preprocessConfigs, ctx.logger);
				ctx.logger.info('[render] Pre-processing complete: %d clips ready', processedClips.length);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.logger.error('[render] Pre-processing failed: %s', msg);
				return {
					success: false,
					error: 'FFmpeg pre-processing failed: ' + msg,
				};
			}

			// Build proxy URLs for processed files — Shotstack fetches from our API,
			// which streams the pre-processed (sharpened + speed-ramped) files from disk.
			// trim=0 because pre-processing already applied trimStart/duration.
			const renderClips: Array<{ src: string; trim: number; length: number }> = [];

			for (let i = 0; i < processedClips.length; i++) {
				const processed = processedClips[i]!;
				const originalClip = clips[i]!;

				const proxyUrl = buildProcessedFileProxyUrl(appUrl, processed.processedId);
				ctx.logger.info('[render] Clip %d/%d: %s (%s) processed=%s effectiveDur=%ds speed=%sx purpose="%s"',
					i + 1, processedClips.length, processed.originalFileId, originalClip.filename || 'unknown',
					processed.processedId, processed.effectiveDuration.toFixed(1), processed.speed,
					originalClip.purpose || 'unspecified');

				renderClips.push({
					src: proxyUrl,
					trim: 0,  // already trimmed during pre-processing
					length: processed.effectiveDuration,
				});
			}

			// Build the Shotstack timeline
			const timeline = buildRenderTimeline({
				clips: renderClips,
				mode: editMode,
				platform,
				textOverlays: overlays,
				musicUrl,
			});

			ctx.logger.info('[render] Timeline built with %d clips, %d overlays, music: %s',
				renderClips.length, overlays.length, musicUrl ? 'yes' : 'none');

			// Submit to Shotstack
			try {
				const renderId = await submitRenderTimeline(timeline);
				ctx.logger.info('[render] Submitted. Render ID: %s', renderId);

				// Schedule background cleanup of processed files after Shotstack fetches them.
				// Shotstack typically fetches within 30-60s of submission, so we wait 10 minutes
				// to be safe, then delete the processed files from disk.
				setTimeout(async () => {
					ctx.logger.info('[render] Cleaning up %d pre-processed files...', processedClips.length);
					await cleanupProcessedFiles(processedClips);
					ctx.logger.info('[render] Cleanup complete');
				}, 10 * 60 * 1000);

				return {
					success: true,
					renderId,
					renderStatus: 'queued',
					renderPlatform: platform,
					renderMode: editMode,
					message: `Render submitted: ${clips.length} clips (pre-processed with sharpening${clips.some(c => c.speed && c.speed !== 1.0) ? ' + speed ramping' : ''}), ${overlays.length} overlays`,
				};
			} catch (err) {
				// Clean up processed files on submission failure
				await cleanupProcessedFiles(processedClips);
				const msg = err instanceof Error ? err.message : String(err);
				ctx.logger.error('[render] Submission failed: %s', msg);
				return {
					success: false,
					error: 'Cloud render submission failed: ' + msg,
				};
			}
		}

		if (task === 'render-status') {
			const renderId = input.renderId;
			if (!renderId) {
				return { success: false, error: 'renderId is required for render-status' };
			}

			// Auto-detect engine by render ID prefix
			if (renderId.startsWith('remotion_')) {
				const { checkRemotionStatus } = await import('./remotion/render');
				const status = await checkRemotionStatus(renderId, ctx.logger);
				return {
					success: true,
					renderId: status.id,
					renderStatus: status.status,
					downloadUrl: status.url,
					error: status.error,
				};
			}

			// Shotstack render (default)
			try {
				const status = await checkStatus(renderId);
				return {
					success: true,
					renderId: status.id,
					renderStatus: status.status,
					downloadUrl: status.url,
					error: status.error,
				};
			} catch (err) {
				return {
					success: false,
					error: 'Status check failed: ' + (err instanceof Error ? err.message : String(err)),
				};
			}
		}

		// --- Save render to Google Drive ---
		if (task === 'save-render-to-drive') {
			const url = input.downloadUrl as string | undefined;
			const renderId = input.renderId || `render_${Date.now()}`;
			const platform = input.platform || 'tiktok';
			const editMode = input.editMode || 'game_day';
			const topic = input.topic || 'CLC';

			if (!url) {
				return { success: false, error: 'downloadUrl is required' };
			}

			ctx.logger.info('[save-render-to-drive] Saving render %s to Drive: platform=%s, mode=%s', renderId, platform, editMode);

			try {
				const { folderId, path: folderPath } = await getOrCreateDateFolder();
				const now = new Date();
				const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
				const safeTopic = topic.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
				const filename = `CLC_${safeTopic}_${platform}_${editMode}_${ts}.mp4`;

				const result = await uploadVideoFromUrl(url, filename, folderId);

				ctx.logger.info('[save-render-to-drive] Saved to Drive: fileId=%s, folder=%s', result.fileId, folderPath);

				return {
					success: true,
					message: `Video saved to Google Drive: ${folderPath}/${filename}`,
					fileId: result.fileId,
					webViewLink: result.webViewLink,
					folderPath,
					filename,
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.logger.error('[save-render-to-drive] Failed: %s', msg);
				return { success: false, error: 'Failed to save render to Drive: ' + msg };
			}
		}

		// --- Instant edit: upload → analyze → segment → generate edit plan ---
		if (task === 'instant-edit') {
			const videoId = input.videoId;
			const platform = input.platform || 'tiktok';
			const editMode = input.editMode || 'game_day';
			const topic = input.topic || 'CLC Quick Edit';

			if (!videoId) {
				return { success: false, error: 'videoId is required for instant-edit' };
			}

			ctx.logger.info('[instant-edit] Starting pipeline for video %s: platform=%s, mode=%s', videoId, platform, editMode);

			try {
				// Step 1: Run scene analysis (FFmpeg-based)
				ctx.logger.info('[instant-edit] Step 1/4: Analyzing scenes...');
				const { analyzeVideoScenes } = await import('./scene-analyzer');
				const analysis = await analyzeVideoScenes(videoId, videoId);
				ctx.logger.info('[instant-edit] Scene analysis done: %d changes, %d hooks', analysis.sceneChanges.length, analysis.recommendedHooks.length);

				// Step 2: Generate named segments
				ctx.logger.info('[instant-edit] Step 2/4: Generating named segments...');
				const meta = await getVideoMetadata(videoId);
				const vmm = (meta as any).videoMediaMetadata;
				const segments = generateNamedSegments(
					analysis as any,
					topic,
					'mixed',
				);
				ctx.logger.info('[instant-edit] Generated %d named segments', segments.length);

				// Step 3: Save to catalog
				ctx.logger.info('[instant-edit] Step 3/4: Saving to catalog...');
				const catalog = loadExistingCatalog();
				let entry = catalog.find(e => e.fileId === videoId);
				if (!entry) {
					// Create a minimal catalog entry for this video
					const sugMode = (['game_day', 'our_story', 'quick_hit', 'showcase'].includes(editMode) ? editMode : 'game_day') as 'game_day' | 'our_story' | 'quick_hit' | 'showcase';
					entry = {
						fileId: videoId,
						filename: meta.name || videoId,
						suspectedLocation: 'Unknown',
						locationConfidence: 'low' as const,
						locationClues: '',
						contentType: 'mixed' as const,
						activity: `Quick edit video: ${topic}`,
						quality: 'good' as const,
						indoorOutdoor: 'unknown' as const,
						duration: vmm?.durationMillis ? String(Math.round(parseInt(vmm.durationMillis) / 1000)) + 's' : 'unknown',
						peopleCount: 'unknown',
						readableText: '',
						notableMoments: '',
						suggestedModes: [sugMode],
						needsManualReview: false,
						reviewNotes: 'Auto-created by instant-edit',
						sceneAnalysis: analysis as any,
					};
					entry.sceneAnalysis!.namedSegments = segments as any;
					catalog.push(entry);
				} else {
					entry.sceneAnalysis = analysis as any;
					entry.sceneAnalysis!.namedSegments = segments as any;
				}
				await saveCatalog(catalog);
				ctx.logger.info('[instant-edit] Catalog saved with %d entries', catalog.length);

				// Step 4: Return the analyzed video info so the frontend can generate an edit plan
				ctx.logger.info('[instant-edit] Step 4/4: Pipeline complete — returning video data');

				return {
					success: true,
					message: `Video analyzed: ${segments.length} segments found. Ready for edit plan generation.`,
					catalog: [entry],
					videos: [{
						id: videoId,
						name: meta.name || videoId,
						mimeType: meta.mimeType,
						size: meta.size,
						duration: vmm?.durationMillis,
						width: vmm?.width,
						height: vmm?.height,
					}],
					count: 1,
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.logger.error('[instant-edit] Pipeline failed: %s', msg);
				return { success: false, error: 'Instant edit failed: ' + msg };
			}
		}

		// --- Autonomous quality loop: edit → render → grade → revise → save ---
		if (task === 'auto-process') {
			const videoIds = input.videoIds || [];
			const platform = input.platform || 'tiktok';
			const editMode = input.editMode || 'game_day';
			const topic = input.topic || 'CLC Content';
			const purpose = input.purpose || 'social media';
			const minScore = (input as any).minScore || 8;
			const maxAttempts = (input as any).maxAttempts || 3;

			if (videoIds.length === 0) {
				return { success: false, error: 'videoIds is required for auto-process' };
			}

			ctx.logger.info('[auto-process] Starting autonomous pipeline: %d videos, platform=%s, mode=%s, minScore=%d, maxAttempts=%d',
				videoIds.length, platform, editMode, minScore, maxAttempts);

			try {
				const { runAutoPipeline } = await import('./auto-pipeline');
				const result = await runAutoPipeline(
					{ videoIds, platform, editMode, topic, purpose, minScore, maxAttempts },
					ctx.logger,
				);

				return {
					success: result.success,
					message: result.success
						? `Pipeline complete: score ${result.score}/10 after ${result.attempts} attempt(s). Saved to library.`
						: `Pipeline failed after ${result.attempts} attempt(s): ${result.error}`,
					renderId: result.renderId,
					downloadUrl: result.downloadUrl,
					score: result.score,
					attempts: result.attempts,
					review: result.review,
					supabaseId: result.supabaseId,
					publicUrl: result.publicUrl,
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.logger.error('[auto-process] Pipeline error: %s', msg);
				return { success: false, error: 'Auto-process pipeline failed: ' + msg };
			}
		}

		// --- Review rendered video ---
		if (task === 'review-render') {
			const reviewUrl = input.reviewUrl as string | undefined;
			const platform = input.platform || 'tiktok';
			const editMode = input.editMode || 'game_day';
			const originalPlan = (input.originalEditPlan && typeof input.originalEditPlan === 'object')
				? input.originalEditPlan as Record<string, unknown>
				: null;
			const autoRevise = (input as any).autoRevise === true;

			if (!reviewUrl) {
				return { success: false, error: 'reviewUrl is required — provide the Shotstack download URL of the rendered video' };
			}

			ctx.logger.info('[video-editor] Reviewing render: platform=%s, mode=%s, autoRevise=%s', platform, editMode, autoRevise);

			try {
				const review = await reviewRenderedVideo(reviewUrl, originalPlan, editMode, platform);

				ctx.logger.info('[video-editor] Review complete: overall=%d/10, storytelling=%d/10, pacing=%d/10, platform=%d/10, issues=%d',
					review.overallScore, review.storytellingScore, review.pacingScore, review.platformFitScore, review.issues.length);

				let revisedPlan: Record<string, unknown> | null = null;

				// Auto-revise if requested and score is below threshold or has significant issues
				if (autoRevise && originalPlan) {
					const hasSignificantIssues = review.issues.some(
						i => i.severity === 'critical' || i.severity === 'warning'
					);
					const scoreBelowThreshold = review.overallScore < 8;

					if (hasSignificantIssues || scoreBelowThreshold) {
						ctx.logger.info('[video-editor] Auto-revising edit plan: score=%d/10, issues=%d (significant=%s)...',
							review.overallScore, review.issues.length, hasSignificantIssues);

						// Build footage context from catalog for the original clips
						const catalog = loadExistingCatalog();
						const catalogMap = new Map(catalog.map(entry => [entry.fileId, entry]));
						const originalClips = Array.isArray(originalPlan.clips) ? originalPlan.clips as Array<{ fileId: string; filename?: string; trimStart?: number; duration?: number; purpose?: string }> : [];

						const footageContext = originalClips.map((clip, index) => {
							const ce = catalogMap.get(clip.fileId);
							if (ce) {
								// Build inline scene analysis with specific timestamps for the reviser
								let sceneTimestamps = '';
								if (ce.sceneAnalysis) {
									const sa = ce.sceneAnalysis;
									const sceneChanges = sa.sceneChanges?.map((sc: any) => typeof sc === 'number' ? `${sc.toFixed(1)}s` : `${(sc.timestamp || sc).toFixed?.(1) || sc}s`).join(', ') || 'none';
									const highMotion = sa.highMotionMoments?.map((hm: any) => typeof hm === 'number' ? `${hm.toFixed(1)}s` : `${(hm.timestamp || hm).toFixed?.(1) || hm}s`).join(', ') || 'none';
									const hooks = sa.recommendedHooks?.map((h: any) => typeof h === 'number' ? `${h.toFixed(1)}s` : `${(h.timestamp || h).toFixed?.(1) || h}s`).join(', ') || 'none';
									sceneTimestamps = `
    Available trim points (USE THESE for trimStart changes):
      * Scene Changes: [${sceneChanges}]
      * High-Action Moments: [${highMotion}]
      * Recommended Hooks: [${hooks}]`;

									// Include scene descriptions if available
									if (sa.sceneDescriptions && Array.isArray(sa.sceneDescriptions)) {
										const descLines = sa.sceneDescriptions.map((d: any) =>
											`      * ${d.timestamp.toFixed(1)}s: [${d.isAction ? 'ACTION' : 'NON-ACTION'}] ${d.description} (energy: ${d.energyLevel}/5, type: ${d.actionType || '?'})`
										).join('\n');
										sceneTimestamps += `\n    Content at timestamps (GPT-4o confirmed):\n${descLines}`;

										// Highlight best action timestamps
										const bestAction = sa.sceneDescriptions
											.filter((d: any) => d.isAction && d.energyLevel >= 4)
											.map((d: any) => `${d.timestamp.toFixed(1)}s`);
										if (bestAction.length > 0) {
											sceneTimestamps += `\n    ⭐ BEST ACTION for trimStart: [${bestAction.join(', ')}]`;
										}
									}
								}

								return `Clip ${index + 1}: ${clip.filename || clip.fileId}
  - Current: trimStart=${clip.trimStart || 0}s, duration=${clip.duration || 'default'}s, purpose="${clip.purpose || 'unspecified'}"
  - Source Duration: ${ce.duration || 'unknown'}
  - Description: ${ce.activity}
  - Location: ${ce.suspectedLocation}
  - Content Type: ${ce.contentType}
  - Quality: ${ce.quality}
  - Notable: ${ce.notableMoments || 'None'}${sceneTimestamps}`;
							}
							return `Clip ${index + 1}: ${clip.filename || clip.fileId}
  - Current: trimStart=${clip.trimStart || 0}s, duration=${clip.duration || 'default'}s
  — no catalog data`;
						}).join('\n\n');

						revisedPlan = await generateRevisedEditPlan(review, originalPlan, footageContext, editMode, platform);

						if (revisedPlan) {
							ctx.logger.info('[video-editor] Revised edit plan generated with %d clips',
								Array.isArray(revisedPlan.clips) ? revisedPlan.clips.length : 0);
						} else {
							ctx.logger.warn('[video-editor] Failed to generate revised edit plan');
						}
					} else {
						ctx.logger.info('[video-editor] Score %d/10 >= 8 and no critical/warning issues — skipping auto-revise', review.overallScore);
					}
				}

				return {
					success: true,
					review,
					revisedEditPlanData: revisedPlan,
					message: `Review complete: ${review.overallScore}/10 overall. ${review.issues.length} issues found.${revisedPlan ? ' Revised edit plan generated.' : ''}`,
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.logger.error('[video-editor] Review failed: %s', msg);
				return { success: false, error: 'Video review failed: ' + msg };
			}
		}

		// --- Generate revision on demand (when auto-revise didn't produce one) ---
		if (task === 'generate-revision') {
			const platform = input.platform || 'tiktok';
			const editMode = input.editMode || 'game_day';
			const originalPlan = (input.originalEditPlan && typeof input.originalEditPlan === 'object')
				? input.originalEditPlan as Record<string, unknown>
				: null;
			const reviewData = (input.review && typeof input.review === 'object')
				? input.review as VideoReview
				: null;

			if (!reviewData || !originalPlan) {
				return { success: false, error: 'review and originalEditPlan are required for generate-revision' };
			}

			ctx.logger.info('[video-editor] On-demand revision: platform=%s, mode=%s, score=%d/10',
				platform, editMode, reviewData.overallScore);

			try {
				// Build footage context from catalog for the original clips
				const catalog = loadExistingCatalog();
				const catalogMap = new Map(catalog.map(entry => [entry.fileId, entry]));
				const originalClips = Array.isArray(originalPlan.clips) ? originalPlan.clips as Array<{ fileId: string; filename?: string; trimStart?: number; duration?: number; purpose?: string }> : [];

				const footageContext = originalClips.map((clip, index) => {
					const ce = catalogMap.get(clip.fileId);
					if (ce) {
						let sceneTimestamps = '';
						if (ce.sceneAnalysis) {
							const sa = ce.sceneAnalysis;
							const sceneChanges = sa.sceneChanges?.map((sc: any) => typeof sc === 'number' ? `${sc.toFixed(1)}s` : `${(sc.timestamp || sc).toFixed?.(1) || sc}s`).join(', ') || 'none';
							const highMotion = sa.highMotionMoments?.map((hm: any) => typeof hm === 'number' ? `${hm.toFixed(1)}s` : `${(hm.timestamp || hm).toFixed?.(1) || hm}s`).join(', ') || 'none';
							const hooks = sa.recommendedHooks?.map((h: any) => typeof h === 'number' ? `${h.toFixed(1)}s` : `${(h.timestamp || h).toFixed?.(1) || h}s`).join(', ') || 'none';
							sceneTimestamps = `
    Available trim points (USE THESE for trimStart changes):
      * Scene Changes: [${sceneChanges}]
      * High-Action Moments: [${highMotion}]
      * Recommended Hooks: [${hooks}]`;

							// Include scene descriptions if available
							if ((sa as any).sceneDescriptions && Array.isArray((sa as any).sceneDescriptions)) {
								const descs = (sa as any).sceneDescriptions as Array<{ timestamp: number; description: string; isAction: boolean; actionType?: string; energyLevel: number }>;
								const descLines = descs.map(d =>
									`      * ${d.timestamp.toFixed(1)}s: [${d.isAction ? 'ACTION' : 'NON-ACTION'}] ${d.description} (energy: ${d.energyLevel}/5, type: ${d.actionType || '?'})`
								).join('\n');
								sceneTimestamps += `\n    Content at timestamps:\n${descLines}`;
							}
						}

						return `Clip ${index + 1}: ${clip.filename || clip.fileId}
  - Current: trimStart=${clip.trimStart || 0}s, duration=${clip.duration || 'default'}s, purpose="${clip.purpose || 'unspecified'}"
  - Source Duration: ${ce.duration || 'unknown'}
  - Description: ${ce.activity}
  - Location: ${ce.suspectedLocation}
  - Content Type: ${ce.contentType}
  - Quality: ${ce.quality}
  - Notable: ${ce.notableMoments || 'None'}${sceneTimestamps}`;
					}
					return `Clip ${index + 1}: ${clip.filename || clip.fileId}
  - Current: trimStart=${clip.trimStart || 0}s, duration=${clip.duration || 'default'}s
  — no catalog data`;
				}).join('\n\n');

				const revisedPlan = await generateRevisedEditPlan(reviewData, originalPlan, footageContext, editMode, platform);

				if (revisedPlan) {
					ctx.logger.info('[video-editor] On-demand revision generated with %d clips',
						Array.isArray(revisedPlan.clips) ? revisedPlan.clips.length : 0);
					return {
						success: true,
						revisedEditPlanData: revisedPlan,
						message: `Revision generated: ${Array.isArray(revisedPlan.clips) ? revisedPlan.clips.length : 0} clips`,
					};
				} else {
					ctx.logger.warn('[video-editor] On-demand revision failed to generate');
					return { success: false, error: 'Failed to generate revised edit plan — GPT-4o did not return valid JSON' };
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.logger.error('[video-editor] On-demand revision failed: %s', msg);
				return { success: false, error: 'Revision generation failed: ' + msg };
			}
		}

		if (task === 'render-local') {
			const videoIds = input.videoIds || [];
			const rawEditPlan = input.editPlan;
			const platform = input.platform || 'tiktok';
			const editMode = input.editMode || 'game_day';

			if (videoIds.length === 0) {
				return { success: false, error: 'No video IDs provided for local rendering' };
			}

			// Check if FFmpeg is available
			let ffmpegAvailable = false;
			try {
				const { execSync } = await import('child_process');
				execSync('ffmpeg -version', { stdio: 'pipe' });
				ffmpegAvailable = true;
			} catch {
				return {
					success: false,
					ffmpegAvailable: false,
					error: 'Local render engine is not available on this system. Use cloud rendering instead.',
				};
			}

			ctx.logger.info('[video-editor] Starting local render for %d videos, platform: %s', videoIds.length, platform);

			const fs = await import('fs');
			const path = await import('path');
			const { execSync } = await import('child_process');

			// Create temp directory for downloads
			const tempDir = path.join(process.cwd(), '.temp-cataloger');
			if (!fs.existsSync(tempDir)) {
				fs.mkdirSync(tempDir, { recursive: true });
			}

			// Build FFmpeg command from edit plan
			// editPlan may be a string (raw AI text), a structured object, or null
			const editPlanObj = (rawEditPlan && typeof rawEditPlan === 'object') ? rawEditPlan as Record<string, unknown> : null;
			const platformConfig = PLATFORM_SETTINGS[platform] || PLATFORM_SETTINGS['youtube']!;
			const modeConfig = MODE_RENDER_SETTINGS[editMode] || MODE_RENDER_SETTINGS['game_day']!;
			const editPlanClips = editPlanObj?.clips as Array<{ fileId?: string; trimStart?: number; duration?: number; speed?: number }> | undefined;

			// --- Pre-process clips: download from Drive, apply sharpen + speed ---
			const preprocessConfigs: PreprocessClipConfig[] = [];

			if (editPlanClips && editPlanClips.length > 0) {
				// Use edit plan clip configs (includes trimStart, duration, speed)
				for (const clip of editPlanClips) {
					preprocessConfigs.push({
						fileId: clip.fileId || videoIds[0]!,
						trimStart: clip.trimStart || 0,
						duration: clip.duration || modeConfig.defaultClipLength,
						speed: clip.speed,
						sharpen: true,
					});
				}
			} else {
				// Fallback: use raw videoIds with default trim
				for (const fileId of videoIds) {
					preprocessConfigs.push({
						fileId,
						trimStart: 0,
						duration: modeConfig.defaultClipLength,
						sharpen: true,
					});
				}
			}

			let processedClips: PreprocessedClip[];
			try {
				ctx.logger.info('[render-local] Pre-processing %d clips (sharpen + speed ramp)...', preprocessConfigs.length);
				processedClips = await preprocessAllClips(preprocessConfigs, ctx.logger);
				ctx.logger.info('[render-local] Pre-processing complete: %d clips ready', processedClips.length);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.logger.error('[render-local] Pre-processing failed: %s', msg);
				return {
					success: false,
					ffmpegAvailable: true,
					error: 'FFmpeg pre-processing failed: ' + msg,
				};
			}

			const outputFilename = `render_${platform}_${editMode}_${Date.now()}.mp4`;
			const outputPath = path.join(tempDir, outputFilename);

			// Build filter_complex for concatenation — clips are already trimmed + enhanced
			const inputArgs: string[] = [];
			const filterParts: string[] = [];

			for (let i = 0; i < processedClips.length; i++) {
				const pc = processedClips[i]!;
				// No -ss/-t needed — pre-processed files are already trimmed
				inputArgs.push('-i', `"${pc.localPath}"`);
				filterParts.push(
					`[${i}:v]scale=${platformConfig.width}:${platformConfig.height}:force_original_aspect_ratio=decrease,` +
					`pad=${platformConfig.width}:${platformConfig.height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`
				);
			}

			// Concatenate all scaled clips
			const concatInputs = processedClips.map((_, i) => `[v${i}]`).join('');
			filterParts.push(`${concatInputs}concat=n=${processedClips.length}:v=1:a=0[outv]`);

			const filterComplex = filterParts.join('; ');
			const ffmpegCmd = `ffmpeg -y ${inputArgs.join(' ')} -filter_complex "${filterComplex}" -map "[outv]" -c:v libx264 -preset fast -crf 23 -r 30 "${outputPath}"`;

			try {
				ctx.logger.info('[render-local] Running FFmpeg concat render...');
				execSync(ffmpegCmd, { stdio: 'pipe', timeout: 300000 });

				// Clean up pre-processed intermediates
				await cleanupProcessedFiles(processedClips);

				return {
					success: true,
					ffmpegAvailable: true,
					localOutputPath: outputPath,
					renderPlatform: platform,
					renderMode: editMode,
					message: `Local render complete (with sharpening): ${outputPath}`,
				};
			} catch (err) {
				// Clean up on failure too
				await cleanupProcessedFiles(processedClips);
				return {
					success: false,
					ffmpegAvailable: true,
					error: 'FFmpeg render failed: ' + (err instanceof Error ? err.message : String(err)),
				};
			}
		}

		if (task === 'check-ffmpeg') {
			let ffmpegAvailable = false;
			let ffmpegVersion = '';
			try {
				const { execSync } = await import('child_process');
				const output = execSync('ffmpeg -version', { stdio: 'pipe' }).toString();
				ffmpegAvailable = true;
				const versionMatch = output.match(/ffmpeg version (\S+)/);
				ffmpegVersion = versionMatch?.[1] || 'unknown';
			} catch {
				ffmpegAvailable = false;
			}

			return {
				success: true,
				ffmpegAvailable,
				message: ffmpegAvailable
					? `FFmpeg available: version ${ffmpegVersion}`
					: 'FFmpeg not available on this system',
			};
		}

		// --- Scene analysis task ---
		if (task === 'analyze-scenes') {
			const videoId = input.videoId;
			if (!videoId) {
				return { success: false, error: 'videoId is required for scene analysis' };
			}

			ctx.logger.info('[video-editor] Running scene analysis for: %s', videoId);

			try {
				const { analyzeVideoScenes } = await import('./scene-analyzer');
				const analysis = await analyzeVideoScenes(videoId, videoId);

				// Update catalog entry with scene data and persist to Google Drive
				const catalog = loadExistingCatalog();
				const idx = catalog.findIndex(e => e.fileId === videoId);
				let updatedEntry = idx !== -1 ? catalog[idx] : undefined;
				if (updatedEntry && idx !== -1) {
					updatedEntry.sceneAnalysis = analysis;

					// Also generate named segments immediately
					const { generateNamedSegments: genSegs } = await import('./scene-analyzer');
					const segments = genSegs(
						analysis as any,
						updatedEntry.activity || '',
						updatedEntry.contentType || 'unknown',
					);
					if (segments.length > 0) {
						(updatedEntry.sceneAnalysis as any).namedSegments = segments;
					}

					catalog[idx] = updatedEntry;

					// Save to Google Drive (persistent storage)
					const { saveCatalog: saveCat } = await import('./google-drive');
					await saveCat(catalog);
					ctx.logger.info('[video-editor] Scene analysis saved to Google Drive for: %s', videoId);
				}

				const segCount = (updatedEntry?.sceneAnalysis as any)?.namedSegments?.length || 0;
				return {
					success: true,
					message: `Scene analysis complete: ${analysis.sceneChanges.length} scene changes, ${analysis.highMotionMoments.length} action moments, ${analysis.recommendedHooks.length} recommended hooks, ${segCount} named segments`,
					catalog: updatedEntry ? [updatedEntry] : [],
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { success: false, error: 'Scene analysis failed: ' + msg };
			}
		}

		// List available music tracks for the UI
		if (task === 'list-music') {
			const mode = input.editMode || undefined;
			const tracks = mode ? getTracksForMode(mode) : getAllTracks();
			return {
				success: true,
				count: tracks.length,
				videos: tracks, // reuse 'videos' field for simplicity
				message: `${tracks.length} music tracks available${mode ? ` for ${mode}` : ''}`,
			};
		}

		// Fetch thumbnail for a single video on-demand (for videos missing previews)
		if (task === 'fetch-thumbnail') {
			const videoId = input.videoId as string;
			if (!videoId) {
				return { success: false, message: 'videoId is required' };
			}
			ctx.logger.info(`[video-editor] Fetching thumbnail for video ${videoId}...`);
			try {
				const thumbnail = await getVideoThumbnail(videoId);
				if (thumbnail) {
					const highRes = getHighResThumbnailUrl(thumbnail, 320);
					return { success: true, videoId, thumbnail: highRes };
				}
				return { success: false, videoId, message: 'Google Drive has not generated a thumbnail for this video yet. Try again later.' };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { success: false, videoId, message: `Failed to fetch thumbnail: ${msg}` };
			}
		}

		// Batch-fetch thumbnails for all videos missing previews
		if (task === 'fetch-missing-thumbnails') {
			const videoIds = input.videoIds as string[] | undefined;
			if (!videoIds || !Array.isArray(videoIds) || videoIds.length === 0) {
				return { success: false, message: 'videoIds array is required' };
			}
			ctx.logger.info(`[video-editor] Fetching thumbnails for ${videoIds.length} videos...`);
			const results: Array<{ videoId: string; thumbnail?: string; error?: string }> = [];
			for (const vid of videoIds) {
				try {
					const thumbnail = await getVideoThumbnail(vid);
					if (thumbnail) {
						results.push({ videoId: vid, thumbnail: getHighResThumbnailUrl(thumbnail, 320) });
					} else {
						results.push({ videoId: vid, error: 'No thumbnail available' });
					}
				} catch (err) {
					results.push({ videoId: vid, error: err instanceof Error ? err.message : String(err) });
				}
			}
			const found = results.filter(r => r.thumbnail).length;
			return { success: true, total: videoIds.length, found, results };
		}

		if (task === 'list-videos') {
			ctx.logger.info('[video-editor] Listing videos from Google Drive...');
			const videos = await listVideoFiles();

			// Load catalog data and merge with video list
			const catalog = loadExistingCatalog();
			const catalogMap = new Map(catalog.map(entry => [entry.fileId, entry]));
			// Send the set of processed fileIds so frontend can distinguish
			// "never analyzed" from "analyzed but location unknown"
			const processedFileIds = [...catalogMap.keys()];

			return {
				success: true,
				count: videos.length,
				processedFileIds,
				videos: videos.map((v: VideoFile) => {
					const ce = catalogMap.get(v.id);
					return {
						id: v.id,
						name: v.name,
						mimeType: v.mimeType,
						size: `${(parseInt(v.size) / (1024 * 1024)).toFixed(1)} MB`,
						sizeBytes: v.size,
						created: v.createdTime,
						thumbnail: getHighResThumbnailUrl(v.thumbnailLink, 320),
						// Catalog fields
						description: ce?.activity || '',
						suspectedLocation: ce?.suspectedLocation || 'Unknown',
						locationConfidence: ce?.locationConfidence || 'unknown',
						locationClues: ce?.locationClues || '',
						contentType: ce?.contentType || 'unknown',
						quality: ce?.quality || 'unknown',
						indoorOutdoor: ce?.indoorOutdoor || 'unknown',
						duration: ce?.duration || '',
						peopleCount: ce?.peopleCount || '',
						readableText: Array.isArray(ce?.readableText)
							? (ce.readableText as unknown as string[]).join(', ')
							: (ce?.readableText || ''),
						notableMoments: ce?.notableMoments || '',
						suggestedModes: ce?.suggestedModes || [],
						needsManualReview: ce?.needsManualReview ?? true,
						reviewNotes: ce?.reviewNotes || '',
						semanticTags: ce?.semanticTags || [],
						// Named segments summary for timeline visualization
						namedSegments: ce?.sceneAnalysis?.namedSegments
							? (ce.sceneAnalysis.namedSegments as any[]).map((s: any) => ({
								id: s.id,
								label: s.label,
								startTime: s.startTime,
								endTime: s.endTime,
								type: s.type,
								energy: s.energy,
								hookPotential: s.hookPotential,
							}))
							: undefined,
					};
				}),
			};
		}

		// --- Background catalog job endpoints ---

		if (task === 'catalog-start') {
			ctx.logger.info('[video-editor] Starting background catalog job...');
			const batchSize = input.batchSize || 5;
			const started = startBackgroundCatalog({ batchSize });
			if (!started) {
				const status = getCatalogJobStatus();
				return {
					success: true,
					message: 'Catalog job already running',
					alreadyRunning: true,
					status,
				};
			}
			return {
				success: true,
				message: 'Background catalog job started',
				alreadyRunning: false,
				status: getCatalogJobStatus(),
			};
		}

		if (task === 'catalog-status') {
			const status = getCatalogJobStatus();
			return {
				success: true,
				status,
			};
		}

		if (task === 'get-catalog') {
			ctx.logger.info('[video-editor] Returning full catalog data...');
			const catalog = loadExistingCatalog();
			const summary = getCatalogSummary(catalog);
			return {
				success: true,
				catalog,
				catalogSummary: summary,
				count: catalog.length,
			};
		}

		if (task === 'folder-summary') {
			ctx.logger.info('[video-editor] Getting folder summary...');
			const summary = await getFolderSummary();
			return { success: true, summary };
		}

		// --- Catalog tasks ---

		if (task === 'catalog') {
			const action = input.catalogAction || 'generate';
			ctx.logger.info('[video-editor] Catalog action: %s', action);

			if (action === 'generate') {
				const catalog = await generateBlankCatalog();
				return {
					success: true,
					message: `Generated catalog for ${catalog.length} videos. All entries need AI analysis and human review.`,
					catalog,
					count: catalog.length,
				};
			}

			if (action === 'save' && input.catalogData) {
				const link = await saveCatalog(input.catalogData as unknown as CatalogEntry[]);
				return {
					success: true,
					message: 'Catalog saved to Google Drive',
					link,
				};
			}

			if (action === 'organize') {
				const folderStructure = await createCatalogFolderStructure();
				return {
					success: true,
					message: 'Folder structure created in Google Drive',
					folders: folderStructure,
				};
			}

			if (action === 'run-full') {
				ctx.logger.info('[video-editor] Starting full auto-catalog run...');
				const batchSize = input.batchSize || 5;

				const progress = await runFullCatalog(
					{ batchSize },
					(p: CatalogProgress) => {
						ctx.logger.info(
							'[video-editor] Catalog progress: %d/%d completed, %d failed',
							p.completed, p.total, p.failed,
						);
					},
				);

				const summary = getCatalogSummary(progress.catalog);

				return {
					success: true,
					message: `Catalog complete: ${progress.completed}/${progress.total} analyzed, ${progress.failed} failed`,
					catalog: progress.catalog,
					count: progress.completed,
					progress: {
						total: progress.total,
						completed: progress.completed,
						failed: progress.failed,
						skipped: progress.skipped,
						errors: progress.errors,
						startedAt: progress.startedAt,
						updatedAt: progress.updatedAt,
					},
					catalogSummary: summary,
				};
			}

			if (action === 'analyze-single') {
				const videoId = input.videoId;
				if (!videoId) {
					return { success: false, message: 'videoId is required for analyze-single' };
				}

				ctx.logger.info('[video-editor] Analyzing single video: %s', videoId);

				// Find the video in the file list
				const videos = await listVideoFiles();
				const video = videos.find((v: VideoFile) => v.id === videoId);

				if (!video) {
					return { success: false, message: `Video not found: ${videoId}` };
				}

				const entry = await catalogSingleVideo(video);

				return {
					success: true,
					message: `Analyzed: ${entry.filename} -> ${entry.suspectedLocation} / ${entry.contentType}`,
					catalog: [entry],
					count: 1,
				};
			}

			if (action === 'update-entry') {
				const videoId = input.videoId;
				if (!videoId) {
					return { success: false, message: 'videoId is required for update-entry' };
				}

				// Get the first catalogData entry for update fields
				const updateData = input.catalogData?.[0];
				if (!updateData) {
					return { success: false, message: 'catalogData with update fields is required for update-entry' };
				}

				ctx.logger.info('[video-editor] Updating catalog entry: %s', videoId);

				const updatedEntry = updateCatalogEntry(videoId, {
					suspectedLocation: updateData.suspectedLocation || undefined,
					contentType: updateData.contentType || undefined,
				});

				if (!updatedEntry) {
					return { success: false, message: `Video not found in catalog: ${videoId}` };
				}

				return {
					success: true,
					message: `Updated: ${updatedEntry.filename} → ${updatedEntry.suspectedLocation} / ${updatedEntry.contentType}`,
					catalog: [updatedEntry],
					count: 1,
				};
			}

			return { success: false, message: `Unknown catalog action: ${action}` };
		}

		// --- AI-powered edit plan generation ---

		if (task === 'edit') {
			let videoIds: string[] = input.videoIds || [];
			const topic = input.topic || 'General CLC content';
			const purpose = input.purpose || 'social';
			const editMode = input.editMode || 'auto';

			// Load catalog data for context
			const catalog = loadExistingCatalog();
			const catalogMap = new Map(catalog.map(entry => [entry.fileId, entry]));

			// Auto-select: when no videos are explicitly selected, search the catalog
			// using the topic as a query and pick the best matches
			if (videoIds.length === 0 && catalog.length > 0) {
				ctx.logger.info('[video-editor] No videos selected — auto-searching catalog for: %s', topic);
				const topicLower = topic.toLowerCase();
				// Tokenize but also normalize common compound terms (e.g. "usopen" → "us open")
				const queryTokens = topicLower.split(/[\s,]+/).filter((t: string) => t.length > 1);

				const scored = catalog
					.map(entry => {
						let score = scoreSearchMatch(entry, queryTokens);
						// Also do full-phrase matching against location and activity
						// This catches "us open" when user types "usopen" or vice versa
						const locLower = (entry.suspectedLocation || '').toLowerCase();
						const actLower = (entry.activity || '').toLowerCase();
						const readableText = Array.isArray(entry.readableText)
							? entry.readableText.join(' ').toLowerCase()
							: (entry.readableText || '').toLowerCase();
						const searchable = `${locLower} ${actLower} ${readableText}`;

						// Check if topic (or normalized variants) appears in searchable text
						const normalized = topicLower.replace(/\s+/g, '');
						for (const field of [locLower, actLower, readableText]) {
							const fieldNorm = field.replace(/\s+/g, '');
							if (fieldNorm.includes(normalized) || normalized.includes(fieldNorm.replace(/[^a-z0-9]/g, ''))) {
								score += 5;
							}
						}
						// Boost high quality clips
						if (entry.quality === 'excellent') score += 2;
						else if (entry.quality === 'good') score += 1;

						return { fileId: entry.fileId, score };
					})
					.filter(r => r.score > 0)
					.sort((a, b) => b.score - a.score);

				// Take top matches (up to 10 clips to give the AI enough footage to work with)
				const autoSelected = scored.slice(0, 10).map(r => r.fileId);
				if (autoSelected.length > 0) {
					videoIds = autoSelected;
					ctx.logger.info('[video-editor] Auto-selected %d clips from catalog (top scores: %s)',
						autoSelected.length,
						scored.slice(0, 3).map(r => `${r.fileId.slice(0, 8)}..=${r.score}`).join(', '),
					);
				} else {
					ctx.logger.warn('[video-editor] No catalog matches for topic: %s', topic);
				}
			}

			ctx.logger.info('[video-editor] Generating edit plan for %d videos, topic: %s', videoIds.length, topic);

			// Load usage data for freshness context (best-effort — won't block if unavailable)
			let usageSummaryMap = new Map<string, VideoUsageSummary>();
			try {
				// Usage data is passed from the API layer via input, or we build from scratch
				if (input.usageSummary && Array.isArray(input.usageSummary)) {
					for (const s of input.usageSummary as VideoUsageSummary[]) {
						usageSummaryMap.set(s.fileId, s);
					}
				}
				ctx.logger.info('[video-editor] Loaded usage data for %d videos', usageSummaryMap.size);
			} catch (err) {
				ctx.logger.warn('[video-editor] Could not load usage data: %s', err);
			}

			// Gather metadata for selected videos
			const videoDetails = [];
			for (const id of videoIds) {
				try {
					const meta = await getVideoMetadata(id);
					const vmm = (meta as any).videoMediaMetadata;
					videoDetails.push({
						id: meta.id,
						name: meta.name,
						mimeType: meta.mimeType,
						size: meta.size,
						duration: vmm?.durationMillis,
						width: vmm?.width,
						height: vmm?.height,
					});
				} catch (err) {
					videoDetails.push({ id, name: 'Unknown', error: String(err) });
				}
			}

			// Build footage context from catalog data
			const footageContext = videoDetails.map((v, index) => {
				const ce = catalogMap.get(v.id || '');
				const durationStr = v.duration
					? Math.round(parseInt(v.duration) / 1000) + 's'
					: (ce?.duration || 'duration unknown');
				const resStr = `${v.width || '?'}x${v.height || '?'}`;

				if (ce) {
					const readableText = Array.isArray(ce.readableText)
						? (ce.readableText as unknown as string[]).join(', ')
						: (ce.readableText || 'None');
					const totalDurSec = v.duration ? Math.round(parseInt(v.duration) / 1000) : (ce.duration ? parseInt(ce.duration) : 0);
					const sceneSection = ce.sceneAnalysis
						? '\n  SCENE ANALYSIS (use segment IDs and cut safety for trim points):\n' + formatSegmentTimelineForPrompt(ce.sceneAnalysis as any)
						: `\n  ⚠️ SCENE ANALYSIS: NOT AVAILABLE — you do NOT know what happens at specific timestamps. All trim points are ESTIMATES. Spread them across the ${totalDurSec}s duration. Do NOT invent specific actions.`;
					return `Clip ${index + 1}: ${v.name} (${durationStr}, ${resStr})
  - Google Drive fileId: ${v.id}
  - WHAT THE CATALOG DESCRIBES (this is ALL you know about this clip): ${ce.activity}
  - Location: ${ce.suspectedLocation} (${ce.locationConfidence} confidence)
  - Content Type: ${ce.contentType}
  - Quality: ${ce.quality}
  - Indoor/Outdoor: ${ce.indoorOutdoor}
  - People: ${ce.peopleCount || 'Unknown'}
  - Readable Text Visible In Frames: ${readableText}
  - Notable Moments Flagged: ${ce.notableMoments || 'None — no specific moments identified'}
  - Suggested Modes: ${ce.suggestedModes?.join(', ') || 'None'}${sceneSection}
${formatUsageContextForPrompt(usageSummaryMap.get(v.id || ''), ce)}`;
				} else {
					return `Clip ${index + 1}: ${v.name} (${durationStr}, ${resStr}) - Google Drive fileId: ${v.id} - no catalog data available`;
				}
			}).join('\n\n');

			// Calculate total available footage duration for context
			const totalFootageDuration = videoDetails.reduce((sum, v) => {
				const dur = v.duration ? parseInt(v.duration) / 1000 : 0;
				return sum + dur;
			}, 0);

			const userMessage = `
Task: Generate a complete edit plan that tells a compelling story. Read ALL the footage descriptions first, find the narrative thread, and build an edit that lets the viewer understand and feel what's happening — not just see a montage of clips.

Topic: ${topic}
Purpose: ${purpose}
Requested Mode: ${editMode === 'auto' ? 'Choose the best mode based on the footage and purpose' : editMode}
Target Platforms: ${input.platforms?.join(', ') || 'All (TikTok, IG Reels, IG Feed, YouTube, Facebook, LinkedIn)'}

Available footage (${videoDetails.length} source files, ~${Math.round(totalFootageDuration)}s total):
${footageContext}

⚠️ CRITICAL — DO NOT HALLUCINATE CLIP CONTENT:
The catalog descriptions above tell you the GENERAL activity in each clip (e.g., "Kids playing tennis on outdoor courts"). You do NOT know what specific action happens at any particular second. DO NOT invent specific moments like "close-up of a forehand shot" or "winning point celebration" — the catalog does not describe second-by-second content.

Your clip purposes MUST use language directly from the catalog's Description, Notable, and Readable Text fields. For example:
- If catalog says "Kids playing tennis on outdoor courts, instruction by coach" → your purpose should say "tennis activity with coach instruction (estimated region)"
- If catalog says "Kids participating in a tennis event" → your purpose should say "tennis event activity (estimated region)"
- NEVER write "close-up of forehand" or "winning point celebration" unless the catalog explicitly mentions those specific moments.

When NAMED SCENE SEGMENTS are available (SCENE TIMELINE with S1, S2, S3...), you MUST:
- Reference segment IDs in your clip purposes (e.g., "hook — serve action (S2)")
- Use each segment's bestEntryPoint as your trimStart
- Calculate duration to reach the segment's bestExitPoint
- Include "segment" and "editNote" fields in your clips JSON
- NEVER violate cut safety warnings — if it says "Let action complete", your clip must not end mid-action
- NEVER cut during dialogue without letting the speaker finish
When segments are NOT available, fall back to timestamp-based editing. When it's NOT available, all trim points are ESTIMATES and you must say so.

The user's topic "${topic}" describes what they WANT the video to be about. Select clips whose catalog descriptions MATCH that topic. If the catalog says "Kids playing tennis" and the topic asks for "redball tennis tournament", that's a reasonable match — but you still can't invent specific gameplay moments that aren't in the catalog description.

STORYTELLING INSTRUCTIONS:
- STEP 1: Read ALL clip descriptions first. Understand the full picture before you start cutting.
- STEP 2: Find the story based on what the catalog ACTUALLY describes. Don't invent a narrative that requires footage you can't confirm exists.
- STEP 3: Build an arc using the general activities described — context → activity → energy → resolution.
- STEP 4: Give each clip enough time to land. The viewer needs to SEE and UNDERSTAND each shot before you cut away.
  - 30-second video: 5-7 clips at 4-5 seconds each. NOT 12 clips at 2 seconds each.
  - 45-second video: 7-10 clips, mix of 3-6 second holds.
  - 60+ second video: 10-15 clips with breathing room, establishing shots, and reactions.
- STEP 5: The hook should INVITE the viewer into the story, not just shock them. A child's focused face or a wide shot of kids gathering is more compelling than a random action flash.

EDITING RULES:
- Scrub through the ENTIRE duration of each source video — don't just grab the first few seconds.
- The same fileId CAN appear multiple times with different trimStart values to pull different moments.
- Each clip entry uses trimStart (seconds into the source) and duration (seconds to use).
- When scene analysis is NOT available, SPREAD trim points across the video duration:
  - For a 60s clip: sample regions around 5s, 15s, 25s, 35s, 45s, 55s
  - For a 100s clip: sample regions around 8s, 20s, 35s, 50s, 65s, 80s
  - This maximizes variety since you can't know what's at each timestamp.
- Hold clips long enough for the viewer to process them. A 4-second clip is more powerful than two 2-second flashes.
- Include quiet/breathing moments between high-energy clips. The contrast makes both stronger.
- End with intention — the last clip should feel like a resolution, not like you ran out of footage.
- DURATION IS STORY-DRIVEN, NOT PLATFORM-LOCKED:
  The video should be as long as the story needs to be told well. Don't artificially truncate a compelling narrative just to hit a short target. Use the MODE-SPECIFIC duration ranges from your system instructions (Game Day, Our Story, Quick Hit, Showcase) as your guide — they vary significantly by mode.

  General minimums to tell a real story:
  - TikTok/IG Reels: 30-60s (aim for 45s+ when the footage supports a narrative arc)
  - IG Feed: 30-60s
  - YouTube: 60-180s (use the space — establish, build, pay off)
  - Facebook: 45-90s
  - LinkedIn: 30-60s

  NEVER default to 15 seconds unless the mode is Quick Hit AND the footage only has one moment. A 15-second video is a clip, not a story. CLC's audience engages with narrative — give them a beginning, middle, and end.

Use your knowledge of each clip's content, location, and quality to make intelligent sequencing decisions. Group location-specific clips together. Avoid using poor-quality clips in hero positions. Prioritize moments that show real human connection over generic action.

Generate:
1. THE STORY — What narrative are you telling based on the ACTUAL catalog descriptions? What's the emotional arc? (2-3 sentences — describe your creative INTENT, but be honest about what's confirmed vs estimated)
2. Mode selection with reasoning
3. Clip sequencing with timestamps and purpose — PURPOSES MUST REFERENCE CATALOG DESCRIPTIONS, NOT INVENTED MOMENTS. Flag estimated timestamps as estimates.
4. Platform variant breakdown (duration, aspect ratio, music tier, CTA)
5. Music approach
6. Text overlay content (aligned with Kimberly's voice, use real location names and readable text from clips)
7. Review summary for approval
8. REQUIRED: A structured JSON block wrapped in \`\`\`json fences containing: mode, clips (with fileId, filename, trimStart, duration, purpose, and when segments are available: segment, editNote), textOverlays (with text, start, duration, position), transitions, totalDuration, musicTier, and musicDirection. The render engine depends on this JSON — the edit plan is incomplete without it.

IMPORTANT JSON RULES:
- clips[].fileId must be the Google Drive fileId provided for each clip (a long alphanumeric string like "1aBcDeFg..."), NOT the filename.
- Copy the fileId exactly from the "Google Drive fileId" field listed for each clip.
- clips[].purpose MUST reference catalog data. NEVER invent specific actions not in the catalog.
- Aim for 6-10 clip segments with meaningful duration (3-5s each). Quality over quantity.
- Vary trimStart values across the full duration of each source video — do NOT cluster all clips in the first 20 seconds.
- totalDuration should match the platform target durations listed above, NOT default to 15 seconds.
`;

			const result = await generateText({
				model: anthropic('claude-sonnet-4-6'),
				system: videoDirectorPrompt,
				prompt: userMessage,
			});

			// Parse structured edit plan from AI response
			let structuredPlan = null;
			const jsonMatch = result.text.match(/```json\s*([\s\S]*?)```/);
			if (jsonMatch?.[1]) {
				try {
					structuredPlan = JSON.parse(jsonMatch[1].trim());
				} catch (e) {
					ctx.logger.warn('[video-editor] Failed to parse structured edit plan JSON: %s', e);
				}
			}

			// Validate edit plan for scene deduplication
			let dedupWarnings: any[] = [];
			if (structuredPlan?.clips && Array.isArray(structuredPlan.clips)) {
				const dedupResult = validateEditPlanDedup(structuredPlan.clips);
				if (!dedupResult.valid) {
					ctx.logger.warn(
						'[video-editor] Edit plan has %d duplicate scene(s): %s',
						dedupResult.duplicates.length,
						dedupResult.duplicates.map(d =>
							`Clip ${d.clipA + 1} & ${d.clipB + 1} overlap by ${d.overlapSeconds}s`
						).join(', ')
					);
					dedupWarnings = dedupResult.duplicates;
					structuredPlan._dedupWarnings = dedupResult.duplicates;
				}
			}

			return {
				success: true,
				editPlan: result.text,           // human-readable markdown for UI display
				editPlanData: structuredPlan,    // structured JSON for render engine
				videoCount: videoDetails.length,
				videos: videoDetails,
				dedupWarnings: dedupWarnings.length > 0 ? dedupWarnings : undefined,
			};
		}

		// --- Generate semantic tags for all catalog entries ---

		if (task === 'generate-tags') {
			ctx.logger.info('[video-editor] Generating semantic tags for catalog entries');

			const catalog = loadExistingCatalog();
			if (catalog.length === 0) {
				return { success: false, message: 'No catalog entries found' };
			}

			let tagged = 0;
			for (const entry of catalog) {
				const tags = generateSemanticTags(entry);
				entry.semanticTags = tags;
				tagged++;
			}

			// Save updated catalog
			const { saveCatalog: saveCat } = await import('./google-drive');
			const saveResult = await saveCat(catalog);
			ctx.logger.info('[video-editor] Tagged %d entries, saved to: %s', tagged, saveResult);

			return {
				success: true,
				message: `Generated semantic tags for ${tagged} catalog entries`,
				taggedCount: tagged,
				sampleTags: catalog.slice(0, 3).map(e => ({
					filename: e.filename,
					tags: e.semanticTags?.slice(0, 10),
				})),
			};
		}

		// --- Describe scene timestamps with GPT-4o vision ---
		if (task === 'describe-scenes') {
			const videoId = input.videoId;
			const catalog = loadExistingCatalog();

			if (videoId) {
				// Single video mode
				const entry = catalog.find(e => e.fileId === videoId);
				if (!entry) {
					return { success: false, error: `Video ${videoId} not found in catalog` };
				}
				if (!entry.sceneAnalysis || entry.sceneAnalysis.sceneChanges.length === 0) {
					return { success: false, error: `Video ${videoId} has no scene analysis data. Run analyze-scenes first.` };
				}
				if (entry.sceneAnalysis.sceneDescriptions && entry.sceneAnalysis.sceneDescriptions.length > 0) {
					return { success: true, message: `Video ${entry.filename} already has ${entry.sceneAnalysis.sceneDescriptions.length} scene descriptions`, catalog: [entry] };
				}

				ctx.logger.info('[video-editor] Describing scenes for: %s (%s)', entry.filename, videoId);

				try {
					const { describeSceneTimestamps } = await import('./scene-analyzer');
					const { downloadVideo } = await import('./google-drive');
					const fs = await import('fs');
					const path = await import('path');

					const tempDir = path.join(process.cwd(), '.temp-cataloger');
					if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
					const videoPath = path.join(tempDir, `describe_${videoId}.mp4`);

					await downloadVideo(videoId, videoPath);
					const descriptions = await describeSceneTimestamps(videoPath, entry.sceneAnalysis as any, 6);

					// Clean up
					try { if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath); } catch { /* best effort */ }

					if (descriptions.length > 0) {
						(entry.sceneAnalysis as any).sceneDescriptions = descriptions;
						const { saveCatalog: saveCat } = await import('./google-drive');
						await saveCat(catalog);

						const actionCount = descriptions.filter(d => d.isAction).length;
						ctx.logger.info('[video-editor] Scene descriptions for %s: %d total, %d action, %d non-action',
							entry.filename, descriptions.length, actionCount, descriptions.length - actionCount);

						return {
							success: true,
							message: `Described ${descriptions.length} scene timestamps for ${entry.filename}: ${actionCount} action, ${descriptions.length - actionCount} non-action`,
							descriptions,
						};
					} else {
						return { success: false, error: 'Could not generate scene descriptions — GPT-4o returned no valid data' };
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					ctx.logger.error('[video-editor] Scene description failed for %s: %s', entry.filename, msg);
					return { success: false, error: 'Scene description failed: ' + msg };
				}
			} else {
				// Batch mode — describe all videos that have scene analysis but no descriptions
				const needsDescription = catalog.filter(e =>
					e.sceneAnalysis &&
					e.sceneAnalysis.sceneChanges.length > 0 &&
					(!e.sceneAnalysis.sceneDescriptions || e.sceneAnalysis.sceneDescriptions.length === 0)
				);

				if (needsDescription.length === 0) {
					const alreadyDone = catalog.filter(e => e.sceneAnalysis?.sceneDescriptions && e.sceneAnalysis.sceneDescriptions.length > 0).length;
					return { success: true, message: `All ${alreadyDone} videos with scene analysis already have descriptions. Nothing to do.` };
				}

				ctx.logger.info('[video-editor] Batch describing scenes for %d videos', needsDescription.length);

				let described = 0;
				let failed = 0;
				for (const entry of needsDescription) {
					try {
						const { describeSceneTimestamps } = await import('./scene-analyzer');
						const { downloadVideo } = await import('./google-drive');
						const fs = await import('fs');
						const path = await import('path');

						const tempDir = path.join(process.cwd(), '.temp-cataloger');
						if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
						const videoPath = path.join(tempDir, `describe_${entry.fileId}.mp4`);

						await downloadVideo(entry.fileId, videoPath);
						const descriptions = await describeSceneTimestamps(videoPath, entry.sceneAnalysis as any, 6);

						try { if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath); } catch { /* best effort */ }

						if (descriptions.length > 0) {
							(entry.sceneAnalysis as any).sceneDescriptions = descriptions;
							described++;
							ctx.logger.info('[video-editor] Described %s: %d timestamps (%d/%d)',
								entry.filename, descriptions.length, described, needsDescription.length);
						} else {
							failed++;
						}
					} catch (err) {
						failed++;
						ctx.logger.warn('[video-editor] Scene description failed for %s: %s', entry.filename, err);
					}
				}

				// Save all at once
				if (described > 0) {
					const { saveCatalog: saveCat } = await import('./google-drive');
					await saveCat(catalog);
				}

				return {
					success: true,
					message: `Described scenes for ${described}/${needsDescription.length} videos (${failed} failed)`,
					described,
					failed,
					total: needsDescription.length,
				};
			}
		}

		// --- Generate named segments for catalog entries ---

		if (task === 'generate-segments') {
			ctx.logger.info('[video-editor] Generating named segments for catalog entries');

			const catalog = loadExistingCatalog();
			if (catalog.length === 0) {
				return { success: false, message: 'No catalog entries found' };
			}

			const forceRegenerate = input.force === true;
			let segmented = 0;
			let skipped = 0;

			for (const entry of catalog) {
				if (!entry.sceneAnalysis || !entry.sceneAnalysis.duration || entry.sceneAnalysis.duration <= 0) {
					skipped++;
					continue;
				}
				// Skip if already has segments (unless force regenerate)
				if (!forceRegenerate && entry.sceneAnalysis.namedSegments && entry.sceneAnalysis.namedSegments.length > 0) {
					skipped++;
					continue;
				}

				const segments = generateNamedSegments(
					entry.sceneAnalysis as any,
					entry.activity || '',
					entry.contentType || 'unknown',
				);
				if (segments.length > 0) {
					(entry.sceneAnalysis as any).namedSegments = segments;
					segmented++;
				}
			}

			// Save updated catalog
			if (segmented > 0) {
				const { saveCatalog: saveCat } = await import('./google-drive');
				await saveCat(catalog);
			}

			ctx.logger.info('[video-editor] Named segments: %d generated, %d skipped', segmented, skipped);

			return {
				success: true,
				message: `Generated named segments for ${segmented} videos (${skipped} skipped${forceRegenerate ? ', force mode' : ''})`,
				segmentedCount: segmented,
				skippedCount: skipped,
				sampleSegments: catalog
					.filter(e => e.sceneAnalysis?.namedSegments && e.sceneAnalysis.namedSegments.length > 0)
					.slice(0, 2)
					.map(e => ({
						filename: e.filename,
						segmentCount: e.sceneAnalysis!.namedSegments!.length,
						segments: e.sceneAnalysis!.namedSegments!.map(s => `${s.id} [${s.startTime.toFixed(1)}-${s.endTime.toFixed(1)}s] ${s.type.toUpperCase()} — ${s.label.substring(0, 50)}`),
					})),
			};
		}

		// --- Search catalog by semantic query ---

		if (task === 'search-catalog') {
			const query = input.query || '';
			if (!query.trim()) {
				return { success: false, message: 'Search query is required' };
			}

			ctx.logger.info('[video-editor] Searching catalog for: %s', query);

			const catalog = loadExistingCatalog();
			const queryTokens = query.toLowerCase().split(/[\s,]+/).filter((t: string) => t.length > 1);

			const scored = catalog
				.map(entry => ({
					fileId: entry.fileId,
					filename: entry.filename,
					activity: entry.activity,
					location: entry.suspectedLocation,
					contentType: entry.contentType,
					quality: entry.quality,
					tags: entry.semanticTags || [],
					score: scoreSearchMatch(entry, queryTokens),
				}))
				.filter(r => r.score > 0)
				.sort((a, b) => b.score - a.score);

			return {
				success: true,
				query,
				tokens: queryTokens,
				results: scored.slice(0, 20),
				totalMatches: scored.length,
			};
		}

		// --- Smart select: AI-powered clip selection by concept ---

		if (task === 'smart-select') {
			const query = input.query || '';
			const count = input.count || 5;

			if (!query.trim()) {
				return { success: false, message: 'Search query is required. Describe the concept (e.g., "high-energy tennis action with kids")' };
			}

			ctx.logger.info('[video-editor] Smart select: "%s" (top %d)', query, count);

			const catalog = loadExistingCatalog();
			const queryTokens = query.toLowerCase().split(/[\s,]+/).filter((t: string) => t.length > 1);

			const scored = catalog
				.map(entry => ({
					fileId: entry.fileId,
					filename: entry.filename,
					activity: entry.activity,
					location: entry.suspectedLocation,
					contentType: entry.contentType,
					quality: entry.quality,
					tags: entry.semanticTags || [],
					segmentCount: entry.sceneAnalysis?.namedSegments?.length || 0,
					hasSegments: !!(entry.sceneAnalysis?.namedSegments && entry.sceneAnalysis.namedSegments.length > 0),
					score: scoreSearchMatch(entry, queryTokens),
				}))
				.filter(r => r.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, count);

			return {
				success: true,
				query,
				selectedIds: scored.map(s => s.fileId),
				selectedCount: scored.length,
				results: scored,
			};
		}

		// --- Legacy video editor workflow ---

		const {
			videoType = 'highlight',
			platform = 'instagram',
			topic = '',
			clips = [],
			templateId,
			overlays = [],
			backgroundMusic,
			mode = 'full',
		} = input;

		ctx.logger.info('[video-editor] Legacy mode: %s for %s', videoType, platform);

		// Get template recommendations
		const recommendations = getTemplateRecommendations(platform, videoType);
		ctx.logger.info('[video-editor] Template recommendations: %s', recommendations.map((r) => r.templateName).join(', '));

		// Select template
		const selectedTemplateId = templateId || recommendations[0]?.templateId || 'square-promo';
		const template = getTemplateById(selectedTemplateId);

		if (!template) {
			throw new Error(`Template not found: ${selectedTemplateId}`);
		}

		ctx.logger.info('[video-editor] Using template: %s', template.name);

		let videoScript: string | undefined;
		let ffmpegCommands: string | undefined;
		let batchScript: string | undefined;
		let caption: string | undefined;
		let hashtags: string[] | undefined;
		let estimatedTime: { minutes: number; description: string } | undefined;

		// Generate video script (human-readable editing instructions)
		if (mode === 'script' || mode === 'full') {
			ctx.logger.info('[video-editor] Generating video script...');

			const { text: generatedScript } = await generateText({
				model: anthropic('claude-sonnet-4-6'),
				system: videoDirectorPrompt,
				prompt: `Create a video editing script for:

Video Type: ${videoType}
Platform: ${platform}
Topic: ${topic}
Template: ${template.name} (${template.aspectRatio}, ~${template.duration}s)
Style: ${template.style}

${clips.length > 0 ? `Available clips:\n${clips.map((c, i) => `${i + 1}. ${c.label || c.path}${c.startTime !== undefined ? ` (${c.startTime}s - ${c.endTime}s)` : ''}`).join('\n')}` : 'No specific clips provided - suggest shot list.'}

Write a clear, actionable video script:`,
			});

			videoScript = generatedScript;
		}

		// Generate FFmpeg commands
		if (mode === 'ffmpeg' || mode === 'full') {
			ctx.logger.info('[video-editor] Generating FFmpeg commands...');

			const textOverlays: TextOverlay[] = overlays.map((o) => ({
				text: o.text,
				startTime: o.startTime,
				duration: o.duration,
				position: o.position as TextOverlay['position'],
				fontSize: 32,
				fontColor: 'white',
				animation: 'fade' as const,
			}));

			const videoClips: VideoClip[] = clips.map((c) => ({
				path: c.path,
				startTime: c.startTime,
				endTime: c.endTime,
				label: c.label,
			}));

			if (videoClips.length === 0) {
				videoClips.push({
					path: 'input_video.mp4',
					label: 'Main footage',
				});
			}

			const bgMusic: AudioTrack | undefined = backgroundMusic
				? {
					path: backgroundMusic.path,
					volume: backgroundMusic.volume ?? 0.3,
					fadeOut: backgroundMusic.fadeOut ?? 2,
				}
				: undefined;

			ffmpegCommands = generateVideoScript(
				template,
				videoClips,
				textOverlays.length > 0 ? textOverlays : undefined,
				bgMusic,
			);
		}

		// Generate batch script if multiple clips
		if (mode === 'batch' && clips.length > 1) {
			ctx.logger.info('[video-editor] Generating batch processing script...');

			const batchConfig: BatchConfig = {
				template,
				overlays: overlays.map((o) => ({
					text: o.text,
					startTime: o.startTime,
					duration: o.duration,
					position: o.position as TextOverlay['position'],
					fontSize: 32,
					fontColor: 'white',
					animation: 'fade' as const,
				})),
				outputFormat: 'mp4',
				quality: 'standard',
				outputDirectory: './processed_videos',
				namingPattern: 'timestamped',
			};

			batchScript = generateBatchScript(
				clips.map((c) => c.path),
				batchConfig,
			);

			estimatedTime = estimateBatchTime(clips.map((c) => c.path), 'standard');
		}

		// Generate caption and hashtags
		if (mode === 'full' && topic) {
			ctx.logger.info('[video-editor] Generating social caption...');

			const { text: generatedCaption } = await generateText({
				model: anthropic('claude-sonnet-4-6'),
				system: videoDirectorPrompt,
				prompt: `Write a short social media caption for a ${platform} video about:

${topic}

Video style: ${template.style}
Duration: ~${template.duration} seconds

Keep it authentic to Kimberly's voice. Include a call to action if appropriate.
DO NOT use banned words or generic nonprofit language.
Just the caption text, nothing else:`,
			});

			caption = generatedCaption.trim();

			const platformHashtagCounts: Record<string, number> = {
				instagram: 15,
				tiktok: 5,
				twitter: 3,
				linkedin: 5,
				facebook: 5,
				youtube: 10,
			};

			const hashtagCount = platformHashtagCounts[platform.toLowerCase()] || 5;

			const { text: generatedHashtags } = await generateText({
				model: anthropic('claude-haiku-4-5-20251001'),
				prompt: `Generate ${hashtagCount} relevant hashtags for a ${platform} video about "${topic}" for a youth tennis and chess nonprofit.

Include a mix of:
- Specific (tennis, chess, youth development)
- Location-based (NYC, LongIsland, Brooklyn, Connecticut)
- Community/nonprofit
- Platform-appropriate trending tags

Return ONLY the hashtags, one per line, with # prefix:`,
			});

			hashtags = generatedHashtags
				.trim()
				.split('\n')
				.map((h) => h.trim())
				.filter((h) => h.startsWith('#'))
				.slice(0, hashtagCount);
		}

		return {
			success: true,
			videoScript,
			ffmpegCommands,
			batchScript,
			template: {
				id: template.id,
				name: template.name,
				aspectRatio: template.aspectRatio,
				duration: template.duration,
			},
			recommendations,
			caption,
			hashtags,
			estimatedTime,
		};
	},
});

export default agent;
