/**
 * Video Editor Agent
 * Generates video scripts, FFmpeg commands, edit plans, and manages
 * Google Drive footage library and Shotstack cloud rendering.
 */

import { createAgent } from '@agentuity/runtime';
import { s } from '@agentuity/schema';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
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
	type VideoFile,
	type CatalogEntry,
} from './google-drive';
import {
	runFullCatalog,
	catalogSingleVideo,
	getCatalogSummary,
	loadExistingCatalog,
	updateCatalogEntry,
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
import {
	selectTrack,
	shouldAddMusic,
	getAllTracks,
	getTracksForMode,
	createCustomMusicSelection,
	type MusicTrack,
} from './music';
import { formatSceneAnalysisForPrompt } from './scene-analyzer';
import { reviewRenderedVideo, generateRevisedEditPlan } from './video-reviewer';

const AgentInput = s.object({
	// Task type: determines which workflow to run
	task: s.string().optional(), // 'list-videos' | 'folder-summary' | 'catalog' | 'edit' | 'render' | 'render-status' | 'render-local' | 'download-render' | 'test-connection' | 'test-shotstack' | 'legacy'

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

	// Internal: passed by API route for proxy URL construction
	appUrl: s.string().optional(),
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
	localOutputPath: s.string().optional(),

	// Download render fields
	filename: s.string().optional(),
	mimeType: s.string().optional(),
	base64Data: s.string().optional(),
	fileSize: s.number().optional(),

	// Review output fields
	review: s.any().optional(),
	revisedEditPlanData: s.any().optional(),

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

				// Auto-revise if requested and there are critical/warning issues
				if (autoRevise && originalPlan) {
					const hasSignificantIssues = review.issues.some(
						i => i.severity === 'critical' || i.severity === 'warning'
					);

					if (hasSignificantIssues) {
						ctx.logger.info('[video-editor] Auto-revising edit plan based on %d issues...', review.issues.length);

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
						ctx.logger.info('[video-editor] No critical/warning issues — skipping auto-revise');
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

				// Update catalog entry with scene data
				const updatedEntry = updateCatalogEntry(videoId, {} as any);
				if (updatedEntry) {
					// Directly update the scene analysis on the entry and re-persist
					updatedEntry.sceneAnalysis = analysis;
					const catalog = loadExistingCatalog();
					const idx = catalog.findIndex(e => e.fileId === videoId);
					if (idx !== -1) {
						catalog[idx] = updatedEntry;
						const fs = await import('fs');
						const catalogPath = await import('path');
						const resultsPath = catalogPath.join(process.cwd(), 'catalog-results.json');
						fs.writeFileSync(resultsPath, JSON.stringify(catalog, null, 2), 'utf-8');
					}
				}

				return {
					success: true,
					message: `Scene analysis complete: ${analysis.sceneChanges.length} scene changes, ${analysis.highMotionMoments.length} action moments, ${analysis.recommendedHooks.length} recommended hooks`,
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

			return {
				success: true,
				count: videos.length,
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
					};
				}),
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
			const videoIds = input.videoIds || [];
			const topic = input.topic || 'General CLC content';
			const purpose = input.purpose || 'social';
			const editMode = input.editMode || 'auto';

			ctx.logger.info('[video-editor] Generating edit plan for %d videos, topic: %s', videoIds.length, topic);

			// Load catalog data for context
			const catalog = loadExistingCatalog();
			const catalogMap = new Map(catalog.map(entry => [entry.fileId, entry]));

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
					return `Clip ${index + 1}: ${v.name} (${durationStr}, ${resStr})
  - Google Drive fileId: ${v.id}
  - Description: ${ce.activity}
  - Location: ${ce.suspectedLocation} (${ce.locationConfidence} confidence)
  - Content Type: ${ce.contentType}
  - Quality: ${ce.quality}
  - Indoor/Outdoor: ${ce.indoorOutdoor}
  - People: ${ce.peopleCount || 'Unknown'}
  - Readable Text: ${readableText}
  - Notable: ${ce.notableMoments || 'None'}
  - Suggested Modes: ${ce.suggestedModes?.join(', ') || 'None'}${ce.sceneAnalysis ? '\n  SCENE ANALYSIS (use these real timestamps for trim points):\n' + formatSceneAnalysisForPrompt(ce.sceneAnalysis) : '\n  SCENE ANALYSIS: Not available — trim points are estimates, flag for human review'}`;
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

STORYTELLING INSTRUCTIONS:
- STEP 1: Read ALL clip descriptions first. Understand the full picture before you start cutting.
- STEP 2: Find the story. What happened at this location? What's the emotional center? What moment would make someone stop scrolling?
- STEP 3: Build an arc around that center — context → anticipation → the moment → the impact.
- STEP 4: Give each clip enough time to land. The viewer needs to SEE and UNDERSTAND each shot before you cut away.
  - 30-second video: 5-7 clips at 4-5 seconds each. NOT 12 clips at 2 seconds each.
  - 45-second video: 7-10 clips, mix of 3-6 second holds.
  - 60+ second video: 10-15 clips with breathing room, establishing shots, and reactions.
- STEP 5: The hook should INVITE the viewer into the story, not just shock them. A child's focused face or a wide shot of kids gathering is more compelling than a random action flash.

EDITING RULES:
- Scrub through the ENTIRE duration of each source video — don't just grab the first few seconds.
- The same fileId CAN appear multiple times with different trimStart values to pull different moments.
- Each clip entry uses trimStart (seconds into the source) and duration (seconds to use).
- Hold clips long enough for the viewer to process them. A 4-second clip of a kid concentrating is more powerful than two 2-second flashes of random action.
- Include quiet/breathing moments between high-energy clips. The contrast makes both stronger.
- End with intention — the last clip should feel like a resolution, not like you ran out of footage.
- TARGET DURATION should match platform guidelines:
  - TikTok/IG Reels: 30-45 seconds
  - IG Feed: 30-45 seconds
  - YouTube: 60-120 seconds
  - Facebook: 45-60 seconds
  - LinkedIn: 30-45 seconds

Use your knowledge of each clip's content, location, and quality to make intelligent sequencing decisions. Group location-specific clips together. Avoid using poor-quality clips in hero positions. Prioritize moments that show real human connection over generic action.

Generate:
1. THE STORY — What narrative are you telling? What's the emotional arc? (2-3 sentences explaining your creative vision)
2. Mode selection with reasoning
3. Clip sequencing with timestamps and purpose — EXPLAIN YOUR EDITORIAL THINKING (why this moment, why this order, what it adds to the story)
4. Platform variant breakdown (duration, aspect ratio, music tier, CTA)
5. Music approach
6. Text overlay content (aligned with Kimberly's voice, use real location names and readable text from clips)
7. Review summary for approval
8. REQUIRED: A structured JSON block wrapped in \`\`\`json fences containing: mode, clips (with fileId, filename, trimStart, duration, purpose), textOverlays (with text, start, duration, position), transitions, totalDuration, musicTier, and musicDirection. The render engine depends on this JSON — the edit plan is incomplete without it.

IMPORTANT JSON RULES:
- clips[].fileId must be the Google Drive fileId provided for each clip (a long alphanumeric string like "1aBcDeFg..."), NOT the filename.
- Copy the fileId exactly from the "Google Drive fileId" field listed for each clip.
- Aim for 6-10 clip segments with meaningful duration (3-5s each). Quality over quantity.
- Vary trimStart values across the full duration of each source video — do NOT cluster all clips in the first 20 seconds.
- totalDuration should match the platform target durations listed above, NOT default to 15 seconds.
`;

			const result = await generateText({
				model: openai('gpt-4o'),
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

			return {
				success: true,
				editPlan: result.text,           // human-readable markdown for UI display
				editPlanData: structuredPlan,    // structured JSON for render engine
				videoCount: videoDetails.length,
				videos: videoDetails,
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
				model: openai('gpt-5-mini'),
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
				model: openai('gpt-5-mini'),
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
				model: openai('gpt-5-mini'),
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
