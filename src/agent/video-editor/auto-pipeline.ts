/**
 * Autonomous Quality Loop Pipeline
 * Chains: edit plan → render → grade → revise (max 3 attempts, min score 8/10) → save to Supabase
 *
 * File: src/agent/video-editor/auto-pipeline.ts
 */

import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { videoDirectorPrompt } from './video-director-prompt';
import { getVideoMetadata, type CatalogEntry } from './google-drive';
import { loadExistingCatalog } from './cataloger';
import { formatSegmentTimelineForPrompt } from './scene-analyzer';
import { reviewRenderedVideo, generateRevisedEditPlan, type VideoReview } from './video-reviewer';
import { selectTrack, shouldAddMusic } from './music';
import { supabaseAdmin } from '../../lib/supabase';

// --- Types ---

export interface PipelineConfig {
	videoIds: string[];
	platform: string;
	editMode: string;
	topic: string;
	purpose?: string;
	minScore?: number;
	maxAttempts?: number;
	appUrl: string;  // Public URL for Lambda webhook callbacks (e.g. https://app.railway.app)
}

export interface PipelineResult {
	success: boolean;
	renderId: string;
	downloadUrl?: string;
	score?: number;
	attempts: number;
	review?: VideoReview;
	supabaseId?: string;
	publicUrl?: string;
	error?: string;
}

type PipelineLogger = {
	info: (msg: string, ...args: any[]) => void;
	warn: (msg: string, ...args: any[]) => void;
	error: (msg: string, ...args: any[]) => void;
};

// --- Edit Plan Generation ---

async function generateEditPlan(
	videoIds: string[],
	platform: string,
	editMode: string,
	topic: string,
	purpose: string,
	logger: PipelineLogger,
): Promise<Record<string, unknown>> {
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

	// V2 PIPELINE FEATURE FLAG.
	// When VIDEO_EDITOR_USE_V2_PIPELINE=true, route through the multi-step
	// pipeline (4 focused Claude calls instead of one 14K-token monolith).
	// Any v2 failure falls through to v1 below — so enabling v2 is safe.
	if (process.env.VIDEO_EDITOR_USE_V2_PIPELINE === 'true') {
		try {
			const { generateEditPlanV2 } = await import('./pipeline-v2');
			logger.info('[auto-pipeline] VIDEO_EDITOR_USE_V2_PIPELINE=true → using v2 multi-step pipeline');
			const plan = await generateEditPlanV2(
				{
					videoIds,
					catalog: catalogMap,
					videoMetadata: videoDetails.filter((v): v is typeof v & { id: string; name: string } => !('error' in v)),
					topic,
					purpose,
					platform,
					editMode: editMode as 'auto' | 'game_day' | 'our_story' | 'quick_hit' | 'showcase',
				},
				logger,
			);
			return plan as unknown as Record<string, unknown>;
		} catch (err) {
			logger.warn(
				'[auto-pipeline] ⚠️ V2 pipeline failed (%s) — falling back to V1 monolith. Set VIDEO_EDITOR_USE_V2_PIPELINE=false to silence.',
				String(err),
			);
			// fall through to v1
		}
	}

	// Build footage context. We also track how many clips lack scene analysis so
	// we can surface a loud operator-visible warning below — without scene data
	// the Director falls back to even-spread estimates, which is exactly how we
	// got the usopen4.mp4 failure mode (slow-mo on warmup footage because the
	// "peak" was guessed instead of detected).
	let clipsMissingSceneAnalysis = 0;
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
			let sceneSection: string;
			if (ce.sceneAnalysis) {
				sceneSection = '\n  SCENE ANALYSIS:\n' + formatSegmentTimelineForPrompt(ce.sceneAnalysis as any);
			} else {
				clipsMissingSceneAnalysis++;
				// Stronger guidance than the old one-line spread message. The Director
				// now knows: (1) estimates only, (2) mark every purpose as estimated,
				// (3) NEVER use this source for slow-mo peaks (slow-mo requires a
				// confirmed peak timestamp per the SLOW-MO WINDOWING RULE).
				sceneSection = `\n  ⚠️ SCENE ANALYSIS: NOT AVAILABLE for this clip.\n    → Use an EVEN SPREAD of timestamps across ${totalDurSec}s source duration.\n    → Mark every clip purpose as "estimated" — no confident peak claims.\n    → DO NOT use this source for a slow-mo peak clip — slow-mo requires a confirmed peakTimestamp (see SLOW-MO WINDOWING RULE).`;
			}
			return `Clip ${index + 1}: ${v.name} (${durationStr}, ${resStr})
  - Google Drive fileId: ${v.id}
  - Description: ${ce.activity}
  - Location: ${ce.suspectedLocation} (${ce.locationConfidence} confidence)
  - Content Type: ${ce.contentType}
  - Quality: ${ce.quality}
  - Indoor/Outdoor: ${ce.indoorOutdoor}
  - People: ${ce.peopleCount || 'Unknown'}
  - Readable Text: ${readableText}
  - Notable Moments: ${ce.notableMoments || 'None'}
  - Suggested Modes: ${ce.suggestedModes?.join(', ') || 'None'}${sceneSection}`;
		}
		return `Clip ${index + 1}: ${v.name} (${durationStr}, ${resStr}) - fileId: ${v.id} - no catalog data`;
	}).join('\n\n');

	// Operator warning: if any clips are missing scene analysis, tell Ian what
	// to run to fix it. Without this warning the pipeline silently produces
	// weaker edits and the failure mode is invisible until someone audits the
	// render.
	if (clipsMissingSceneAnalysis > 0) {
		logger.warn(
			'[auto-pipeline] ⚠️ %d of %d clips have NO scene analysis — Director will use even-spread estimates and skip slow-mo on these sources. For richer cuts, run: POST /video-editor { task: "rescore-timestamps", videoIds: [...], force: true }',
			clipsMissingSceneAnalysis,
			videoDetails.length,
		);
	}

	const totalFootageDuration = videoDetails.reduce((sum, v) => {
		const dur = v.duration ? parseInt(v.duration) / 1000 : 0;
		return sum + dur;
	}, 0);

	const prompt = `Task: Generate a complete edit plan that tells a compelling story.

Topic: ${topic}
Purpose: ${purpose}
Mode: ${editMode === 'auto' ? 'Choose the best mode based on footage' : editMode}
Target Platform: ${platform}

Available footage (${videoDetails.length} files, ~${Math.round(totalFootageDuration)}s total):
${footageContext}

Return a JSON edit plan with: clips (array of {fileId, filename, trimStart, duration, purpose, speed}), textOverlays (array of {text, start, duration, position}), totalDuration, mode, musicDirection, transitions.

Wrap the JSON in \`\`\`json fences.`;

	logger.info('[auto-pipeline] Generating edit plan with Claude: %d videos, platform=%s, mode=%s', videoIds.length, platform, editMode);

	// Same timeout/maxOutputTokens bounds as generateRevisedEditPlan — see the long
	// comment in video-reviewer.ts. This prompt is ~30% shorter than the revision
	// prompt (no original-edit-plan JSON), so hangs are less common, but the
	// failure mode is identical when they happen: Railway/Agentuity drop the
	// stream mid-flight and the pipeline retry loop spins without a clear error.
	// 90s hard abort + bounded output = fail-fast with a readable message.
	// (Note: AI SDK v6 renamed maxTokens → maxOutputTokens.)
	const result = await generateText({
		model: anthropic('claude-sonnet-4-6'),
		system: videoDirectorPrompt,
		prompt,
		maxOutputTokens: 6000,
		abortSignal: AbortSignal.timeout(90_000),
	});

	const jsonMatch = result.text.match(/```json\s*([\s\S]*?)```/);
	if (!jsonMatch?.[1]) {
		throw new Error('Claude did not return a valid JSON edit plan');
	}

	return JSON.parse(jsonMatch[1].trim());
}

// --- Render Submission + Polling ---

async function submitAndPollRender(
	editPlan: Record<string, unknown>,
	platform: string,
	editMode: string,
	appUrl: string,
	logger: PipelineLogger,
): Promise<{ renderId: string; downloadUrl: string }> {
	const { preRegisterRender, submitRemotionRenderWithPreprocessing, checkRemotionStatus } = await import('./remotion/render');

	const clips = (editPlan.clips || []) as Array<{
		fileId: string;
		filename?: string;
		trimStart?: number;
		duration?: number;
		purpose?: string;
		speed?: number;
	}>;

	const overlays = (editPlan.textOverlays || []) as Array<{
		text: string;
		start: number;
		duration: number;
		position?: string;
	}>;

	// Music selection
	const musicDirection = (editPlan.musicDirection as string) || undefined;
	const musicTier = (editPlan.musicTier as number) || undefined;
	let musicUrl: string | null = (editPlan.musicUrl as string) || null;
	if (!musicUrl && shouldAddMusic(platform, musicTier)) {
		const selection = selectTrack(editMode, musicDirection);
		if (selection) {
			musicUrl = selection.track.url;
			logger.info('[auto-pipeline] Auto-selected music: "%s"', selection.track.title);
		}
	}

	const renderId = `remotion_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	preRegisterRender(renderId);

	logger.info('[auto-pipeline] Submitting Remotion render %s: %d clips', renderId, clips.length);

	// Fire the async render pipeline
	await submitRemotionRenderWithPreprocessing(
		{ clips, textOverlays: overlays, musicUrl, mode: editMode, platform },
		renderId,
		appUrl,
		logger as any,
	);

	// Poll until done or failed (max ~10 minutes)
	const maxPolls = 60;
	const pollInterval = 10_000;

	for (let i = 0; i < maxPolls; i++) {
		await new Promise(resolve => setTimeout(resolve, pollInterval));

		const status = await checkRemotionStatus(renderId, logger as any);

		if (status.status === 'done' && status.url) {
			logger.info('[auto-pipeline] Render %s complete: %s', renderId, status.url);
			return { renderId, downloadUrl: status.url };
		}

		if (status.status === 'failed') {
			throw new Error(`Render failed: ${status.error || 'unknown error'}`);
		}

		logger.info('[auto-pipeline] Render %s in progress... (poll %d/%d)', renderId, i + 1, maxPolls);
	}

	throw new Error(`Render timed out after ${maxPolls * pollInterval / 1000}s`);
}

// --- Build Footage Context for Revisions ---

function buildFootageContext(editPlan: Record<string, unknown>): string {
	const catalog = loadExistingCatalog();
	const catalogMap = new Map(catalog.map(entry => [entry.fileId, entry]));
	const clips = Array.isArray(editPlan.clips)
		? editPlan.clips as Array<{ fileId: string; filename?: string; trimStart?: number; duration?: number; purpose?: string }>
		: [];

	return clips.map((clip, index) => {
		const ce = catalogMap.get(clip.fileId);
		if (ce) {
			let sceneTimestamps = '';
			if (ce.sceneAnalysis) {
				const sa = ce.sceneAnalysis;
				const changes = sa.sceneChanges?.map((sc: any) => typeof sc === 'number' ? `${sc.toFixed(1)}s` : `${(sc.timestamp || sc).toFixed?.(1) || sc}s`).join(', ') || 'none';
				const motion = sa.highMotionMoments?.map((hm: any) => typeof hm === 'number' ? `${hm.toFixed(1)}s` : `${(hm.timestamp || hm).toFixed?.(1) || hm}s`).join(', ') || 'none';
				const hooks = sa.recommendedHooks?.map((h: any) => typeof h === 'number' ? `${h.toFixed(1)}s` : `${(h.timestamp || h).toFixed?.(1) || h}s`).join(', ') || 'none';
				sceneTimestamps = `\n    Trim points: Scenes=[${changes}], Action=[${motion}], Hooks=[${hooks}]`;
			}
			return `Clip ${index + 1}: ${clip.filename || clip.fileId}
  - trimStart=${clip.trimStart || 0}s, duration=${clip.duration || 'default'}s
  - ${ce.activity} | ${ce.suspectedLocation} | ${ce.contentType}${sceneTimestamps}`;
		}
		return `Clip ${index + 1}: ${clip.filename || clip.fileId} — no catalog data`;
	}).join('\n\n');
}

// --- Save to Supabase ---

async function saveToSupabase(
	downloadUrl: string,
	editPlan: Record<string, unknown>,
	review: VideoReview,
	platform: string,
	editMode: string,
	topic: string,
	renderId: string,
	revisionCount: number,
	videoIds: string[],
	logger: PipelineLogger,
): Promise<{ supabaseId: string; publicUrl: string }> {
	// Upload video to Supabase Storage
	logger.info('[auto-pipeline] Downloading render for Supabase upload...');
	const videoResponse = await fetch(downloadUrl);
	if (!videoResponse.ok) throw new Error(`Failed to download render: ${videoResponse.status}`);
	const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());

	const now = new Date();
	const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
	const safeTopic = topic.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
	const filename = `CLC_${safeTopic}_${platform}_${editMode}_${ts}.mp4`;
	const storagePath = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${filename}`;

	logger.info('[auto-pipeline] Uploading to Supabase Storage: %s (%d bytes)', storagePath, videoBuffer.length);

	const { error: uploadError } = await supabaseAdmin.storage
		.from('finished-videos')
		.upload(storagePath, videoBuffer, {
			contentType: 'video/mp4',
			upsert: true,
		});

	if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

	// Get public URL
	const { data: urlData } = supabaseAdmin.storage
		.from('finished-videos')
		.getPublicUrl(storagePath);

	const publicUrl = urlData.publicUrl;

	// Compute duration from edit plan
	const clips = Array.isArray(editPlan.clips) ? editPlan.clips as Array<{ duration?: number }> : [];
	const durationSec = clips.reduce((sum, c) => sum + (c.duration || 0), 0);

	// Build tags from topic
	const tags = topic.split(/[\s,]+/).filter(t => t.length > 2).map(t => t.toLowerCase());

	// Insert into finished_videos table
	const { data: row, error: insertError } = await supabaseAdmin
		.from('finished_videos')
		.insert({
			title: `${topic} — ${platform} ${editMode}`,
			platform,
			edit_mode: editMode,
			storage_path: storagePath,
			public_url: publicUrl,
			duration_sec: durationSec,
			score: review.overallScore,
			review_notes: review.summary,
			revision_count: revisionCount,
			tags,
			source_video_ids: videoIds,
			render_id: renderId,
		})
		.select('id')
		.single();

	if (insertError) throw new Error(`DB insert failed: ${insertError.message}`);

	logger.info('[auto-pipeline] Saved to Supabase: id=%s, url=%s', row.id, publicUrl);

	return { supabaseId: row.id, publicUrl };
}

// --- Main Pipeline ---

export async function runAutoPipeline(
	config: PipelineConfig,
	logger: PipelineLogger,
): Promise<PipelineResult> {
	const {
		videoIds,
		platform,
		editMode,
		topic,
		purpose = 'social media',
		minScore = 8,
		maxAttempts = 3,
		appUrl,
	} = config;

	let currentPlan: Record<string, unknown> = {};
	let lastReview: VideoReview | undefined;
	let lastDownloadUrl: string | undefined;
	let lastRenderId = '';

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		logger.info('[auto-pipeline] === Attempt %d/%d ===', attempt, maxAttempts);

		try {
			// Step 1: Generate (or revise) edit plan
			if (attempt === 1) {
				currentPlan = await generateEditPlan(videoIds, platform, editMode, topic, purpose, logger);
			} else if (lastReview) {
				logger.info('[auto-pipeline] Generating revised edit plan (score was %d/%d)...', lastReview.overallScore, 10);
				const footageContext = buildFootageContext(currentPlan!);
				const revised = await generateRevisedEditPlan(lastReview, currentPlan!, footageContext, editMode, platform);
				if (!revised) {
					logger.warn('[auto-pipeline] Revision failed — using previous plan');
				} else {
					currentPlan = revised;
				}
			}

			logger.info('[auto-pipeline] Edit plan ready: %d clips',
				Array.isArray(currentPlan!.clips) ? (currentPlan!.clips as any[]).length : 0);

			// Step 2: Render
			const { renderId, downloadUrl } = await submitAndPollRender(currentPlan!, platform, editMode, appUrl, logger);
			lastRenderId = renderId;
			lastDownloadUrl = downloadUrl;

			// Step 3: Grade with gpt-5-mini vision
			logger.info('[auto-pipeline] Grading render with gpt-5-mini vision...');
			const review = await reviewRenderedVideo(downloadUrl, currentPlan!, editMode, platform);
			lastReview = review;

			logger.info('[auto-pipeline] Score: %d/10 (storytelling=%d, pacing=%d, platform=%d) — %d issues',
				review.overallScore, review.storytellingScore, review.pacingScore, review.platformFitScore, review.issues.length);

			// Step 4: Check if score meets threshold
			if (review.overallScore >= minScore) {
				logger.info('[auto-pipeline] Score %d >= %d — passing! Saving to Supabase...', review.overallScore, minScore);

				const { supabaseId, publicUrl } = await saveToSupabase(
					downloadUrl, currentPlan!, review, platform, editMode, topic, renderId, attempt - 1, videoIds, logger,
				);

				return {
					success: true,
					renderId,
					downloadUrl,
					score: review.overallScore,
					attempts: attempt,
					review,
					supabaseId,
					publicUrl,
				};
			}

			logger.info('[auto-pipeline] Score %d < %d — will revise...', review.overallScore, minScore);

		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error('[auto-pipeline] Attempt %d failed: %s', attempt, msg);

			if (attempt === maxAttempts) {
				return {
					success: false,
					renderId: lastRenderId,
					downloadUrl: lastDownloadUrl,
					score: lastReview?.overallScore,
					attempts: attempt,
					review: lastReview,
					error: msg,
				};
			}
		}
	}

	// Max attempts reached — save best effort to Supabase anyway
	logger.warn('[auto-pipeline] Max attempts reached. Saving best result (score=%d)...', lastReview?.overallScore);

	if (lastDownloadUrl && lastReview) {
		try {
			const { supabaseId, publicUrl } = await saveToSupabase(
				lastDownloadUrl, currentPlan!, lastReview, platform, editMode, topic, lastRenderId, maxAttempts - 1, videoIds, logger,
			);

			return {
				success: true,
				renderId: lastRenderId,
				downloadUrl: lastDownloadUrl,
				score: lastReview.overallScore,
				attempts: maxAttempts,
				review: lastReview,
				supabaseId,
				publicUrl,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error('[auto-pipeline] Failed to save best-effort result: %s', msg);
		}
	}

	return {
		success: false,
		renderId: lastRenderId,
		downloadUrl: lastDownloadUrl,
		score: lastReview?.overallScore,
		attempts: maxAttempts,
		review: lastReview,
		error: 'Max revision attempts reached without meeting quality threshold',
	};
}
