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
import { loadExistingCatalog, hydrateCatalogFromDrive } from './cataloger';
import { formatSegmentTimelineForPrompt } from './scene-analyzer';
import { reviewRenderedVideo, generateRevisedEditPlan, type VideoReview } from './video-reviewer';
import { validateEditPlanDedup, type VideoUsageSummary } from './usage-tracker';
import { buildShotList, isInsideVettedSpan, snapIntoVettedSpan } from './pipeline-v2/shot-list';
import { validateEditPlan, formatValidationResult } from './edit-plan-validator';
import { selectTrack, shouldAddMusic } from './music';
import { gateRender, formatGateResult, PUBLISH_THRESHOLDS, type GateResult } from './render-gate';
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
	/** Prior-render clip usage — lets the planner avoid repeating the same cuts */
	usageSummary?: VideoUsageSummary[];
	/**
	 * Stage heartbeat. The pipeline runs detached (the gateway kills held HTTP
	 * streams) and cloud runtime logs are unreachable, so this is the only way
	 * to see WHERE a run died: the caller persists each stage to KV.
	 */
	onStage?: (stage: string) => void;
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
	/** Clips of the plan that actually rendered — lets the API layer record
	 *  usage so future renders avoid re-cutting the same regions. */
	editPlanClips?: Array<{ fileId: string; filename?: string; trimStart?: number; duration?: number; purpose?: string }>;
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
	usageSummary?: VideoUsageSummary[],
): Promise<Record<string, unknown>> {
	// Cover the path where auto-process is invoked outside the agent handler.
	// Idempotent — a no-op if the handler already hydrated this process.
	try { await hydrateCatalogFromDrive(); } catch { /* fall back to whatever is local */ }
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

	// V2 PIPELINE FEATURE FLAG — DEFAULT ON.
	// The multi-step pipeline (focused Claude calls instead of one 14K-token
	// monolith) is the default. Set VIDEO_EDITOR_USE_V2_PIPELINE=false to
	// force the v1 monolith. Any v2 failure still falls through to v1 below.
	// (Was opt-in until 2026-06: every deploy without the env var silently
	// ran v1, so months of v2 quality work never reached production renders.)
	if (process.env.VIDEO_EDITOR_USE_V2_PIPELINE !== 'false') {
		try {
			const { generateEditPlanV2 } = await import('./pipeline-v2');
			logger.info('[auto-pipeline] Using v2 multi-step pipeline (default; set VIDEO_EDITOR_USE_V2_PIPELINE=false to opt out)');
			const plan = await generateEditPlanV2(
				{
					videoIds,
					catalog: catalogMap,
					videoMetadata: videoDetails.filter((v): v is typeof v & { id: string; name: string } => !('error' in v)),
					topic,
					purpose,
					platform,
					editMode: editMode as 'auto' | 'game_day' | 'our_story' | 'quick_hit' | 'showcase',
					usageSummaries: usageSummary,
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

// --- Pre-render Validation ---

/**
 * Run the same two validators the `task: 'edit'` handler runs before it hands a
 * plan to the render engine: scene dedup + comprehensive bounds/alignment checks.
 *
 * This pipeline previously imported neither, so an out-of-bounds trim (trimStart
 * past the end of the source, duration overflowing it, overlays past the end of
 * the timeline) went straight to Lambda and burned a render. `validateEditPlan`
 * mutates the plan in place to auto-fix the trivial cases; errors it can't fix
 * are logged loudly but do NOT abort — a partially-valid render still gives the
 * reviewer something to grade, which is how the quality loop recovers.
 */
function validatePlanBeforeRender(
	plan: Record<string, unknown>,
	logger: PipelineLogger,
): void {
	if (!Array.isArray(plan.clips) || plan.clips.length === 0) return;

	const dedupResult = validateEditPlanDedup(plan.clips as any);
	if (!dedupResult.valid) {
		logger.warn(
			'[auto-pipeline] Edit plan has %d duplicate scene(s): %s',
			dedupResult.duplicates.length,
			dedupResult.duplicates.map(d =>
				`Clip ${d.clipA + 1} & ${d.clipB + 1} overlap by ${d.overlapSeconds}s`
			).join(', '),
		);
	}

	const catalogMap = new Map(loadExistingCatalog().map(entry => [entry.fileId, entry]));
	const result = validateEditPlan(plan as any, catalogMap);
	if (result.autoFixCount > 0) {
		logger.info('[auto-pipeline] Edit plan validation: auto-fixed %d issues', result.autoFixCount);
	}
	if (!result.valid) {
		logger.warn('[auto-pipeline] Edit plan validation FAILED:\n%s', formatValidationResult(result));
	} else if (result.warnings.length > 0) {
		logger.info('[auto-pipeline] Edit plan validation passed with %d warnings', result.warnings.length);
	}

	// Vetted-span enforcement: the composers' prompts promise that out-of-span
	// clips "are snapped back in code" — this is that code. Only applies to
	// sources with timestamp scores; unscored sources keep their estimated
	// path. A clip outside every vetted run is snapped into the nearest run
	// that fits (shrinking to the run when needed), loudly.
	const shotListCache = new Map<string, ReturnType<typeof buildShotList>>();
	for (const clip of plan.clips as Array<{ fileId?: string; trimStart?: number; duration?: number; purpose?: string }>) {
		if (!clip.fileId || typeof clip.trimStart !== 'number' || typeof clip.duration !== 'number') continue;
		const entry = catalogMap.get(clip.fileId);
		if (!entry?.timestampScores?.length) continue;
		let list = shotListCache.get(clip.fileId);
		if (!list) {
			const durSec = entry.duration ? parseInt(entry.duration) || 0 : 0;
			list = buildShotList(entry, durSec);
			shotListCache.set(clip.fileId, list);
		}
		if (list.segments.length === 0) continue; // nothing to snap into — bounds checks above still apply
		if (isInsideVettedSpan(list, clip.trimStart, clip.trimStart + clip.duration)) continue;
		const snapped = snapIntoVettedSpan(list, clip.trimStart, clip.duration);
		if (snapped) {
			logger.warn(
				'[auto-pipeline] Clip (%s "%s") %ds+%ds is OUTSIDE every vetted span — snapped to %ds+%ds',
				clip.fileId.slice(0, 8), clip.purpose ?? '?', clip.trimStart, clip.duration, snapped.trimStart, snapped.duration,
			);
			clip.trimStart = snapped.trimStart;
			clip.duration = snapped.duration;
		}
	}
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
	// `editMode` may be the literal 'auto'; getTracksForMode('auto') returns []
	// so selectTrack would return null and music would be silently skipped.
	// The plan always resolves a concrete mode — prefer it.
	const planMode = editPlan.mode;
	const musicMode = typeof planMode === 'string' && planMode ? planMode : editMode;
	let musicUrl: string | null = (editPlan.musicUrl as string) || null;
	let musicVolume: number | undefined;
	if (!musicUrl && shouldAddMusic(platform, musicTier)) {
		const selection = selectTrack(musicMode, musicDirection);
		if (selection) {
			musicUrl = selection.track.url;
			musicVolume = selection.volume;
			logger.info('[auto-pipeline] Auto-selected music: "%s" (mode=%s, volume=%s)',
				selection.track.title, musicMode, selection.volume);
		} else {
			logger.info('[auto-pipeline] No music track found for mode=%s, skipping', musicMode);
		}
	}
	// TODO: `submitRemotionRenderWithPreprocessing` in
	// src/agent/video-editor/remotion/render.ts has no `musicVolume` field — it
	// derives the volume from `musicVolumeFor(config.mode)`. Add
	// `musicVolume?: number` to that config type and prefer it over
	// musicVolumeFor() so the library's per-mode volume is what renders.
	void musicVolume;

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

	// Poll until done or failed (max ~20 minutes — covers the local-relay
	// submit path, which adds pickup latency before the Lambda even starts)
	const maxPolls = 120;
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
		usageSummary,
	} = config;

	let currentPlan: Record<string, unknown> = {};
	let lastReview: VideoReview | undefined;
	let lastGate: GateResult | null = null;
	let lastDownloadUrl: string | undefined;
	let lastRenderId = '';

	const stage = (s: string) => { try { config.onStage?.(s); } catch { /* heartbeat must never break the pipeline */ } };

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		logger.info('[auto-pipeline] === Attempt %d/%d ===', attempt, maxAttempts);
		stage(`attempt ${attempt}/${maxAttempts}: generating edit plan`);

		try {
			// Step 1: Generate (or revise) edit plan
			if (attempt === 1) {
				currentPlan = await generateEditPlan(videoIds, platform, editMode, topic, purpose, logger, usageSummary);
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

			// Validate (and auto-fix) before the plan reaches the render engine.
			// Covers both the freshly-generated plan and revised plans.
			validatePlanBeforeRender(currentPlan!, logger);

			logger.info('[auto-pipeline] Edit plan ready: %d clips',
				Array.isArray(currentPlan!.clips) ? (currentPlan!.clips as any[]).length : 0);

			// Step 2: Render
			stage(`attempt ${attempt}: submitting render (preprocess + Lambda)`);
			const { renderId, downloadUrl } = await submitAndPollRender(currentPlan!, platform, editMode, appUrl, logger);
			lastRenderId = renderId;
			lastDownloadUrl = downloadUrl;
			stage(`attempt ${attempt}: render complete (${renderId}) — measuring`);

			// Step 3a: Measure the render. This runs FIRST and is not negotiable —
			// the AI reviewer below judges from 8 stills and no audio, so it cannot
			// hear clipping, cannot see a 1s clip, and cannot catch a frozen frame.
			// Everything here is measured with FFmpeg and cannot be talked out of.
			let gate: GateResult | null = null;
			try {
				const plannedLengths = Array.isArray(currentPlan?.clips)
					? (currentPlan!.clips as Array<{ duration?: number; speed?: number }>)
						.map((c) => (typeof c.duration === 'number' ? c.duration / (c.speed || 1) : NaN))
						.filter((n) => Number.isFinite(n) && n > 0)
					: [];
				gate = await gateRender(downloadUrl, PUBLISH_THRESHOLDS, plannedLengths.length >= 2 ? plannedLengths : undefined);
				logger.info('[auto-pipeline] %s', gate.summary);
				if (!gate.pass) logger.warn('\n%s', formatGateResult(gate));
			} catch (gateErr) {
				// A measurement failure must not silently become a pass.
				const msg = gateErr instanceof Error ? gateErr.message : String(gateErr);
				logger.error('[auto-pipeline] Render gate could not measure the output: %s', msg);
				gate = null;
			}
			lastGate = gate;

			// Step 3b: Grade with vision (taste, not correctness)
			logger.info('[auto-pipeline] Grading render with vision model...');
			stage(`attempt ${attempt}: gate ${gate ? (gate.pass ? 'PASS' : 'FAIL') : 'unmeasured'} — reviewing`);
			const review = await reviewRenderedVideo(downloadUrl, currentPlan!, editMode, platform, gate?.metrics ?? null);
			lastReview = review;

			logger.info('[auto-pipeline] Score: %d/10 (storytelling=%d, pacing=%d, platform=%d) — %d issues',
				review.overallScore, review.storytellingScore, review.pacingScore, review.platformFitScore, review.issues.length);

			// Step 4: Publish only if BOTH the measured gate and the taste score pass.
			if (gate && !gate.pass) {
				logger.info('[auto-pipeline] Measured gate failed (%s) — will revise regardless of the %d/10 taste score.',
					gate.failures.join(', '), review.overallScore);
			} else if (!gate) {
				logger.info('[auto-pipeline] Gate unmeasurable — treating as a fail and revising.');
			} else if (review.overallScore >= minScore) {
				logger.info('[auto-pipeline] Score %d >= %d — passing! Saving to Supabase...', review.overallScore, minScore);
				stage(`attempt ${attempt}: PASSED (score ${review.overallScore}) — saving to library`);

				// Library save must not sink a successful render: the cloud env has
				// no Supabase credentials right now, so this write fails — but the
				// render itself is real and downloadable. Log, and return success.
				let supabaseId: string | undefined;
				let publicUrl: string | undefined;
				try {
					const saved = await saveToSupabase(
						downloadUrl, currentPlan!, review, platform, editMode, topic, renderId, attempt - 1, videoIds, logger,
					);
					supabaseId = saved.supabaseId;
					publicUrl = saved.publicUrl;
				} catch (saveErr) {
					const msg = saveErr instanceof Error ? saveErr.message : String(saveErr);
					logger.warn('[auto-pipeline] Library save failed (render still available at downloadUrl): %s', msg);
				}

				return {
					success: true,
					renderId,
					downloadUrl,
					score: review.overallScore,
					attempts: attempt,
					review,
					supabaseId,
					publicUrl,
					editPlanClips: Array.isArray(currentPlan.clips) ? currentPlan.clips as PipelineResult['editPlanClips'] : undefined,
				};
			}

			logger.info('[auto-pipeline] Score %d < %d — will revise...', review.overallScore, minScore);

		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error('[auto-pipeline] Attempt %d failed: %s', attempt, msg);
			stage(`attempt ${attempt} FAILED: ${msg.slice(0, 250)}`);

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

	// Max attempts reached. Previously this published unconditionally — a
	// sub-threshold render went straight to finished_videos with success:true.
	// A measured failure (clipping audio, frozen frames, black tail) is an
	// objective defect, so it now blocks publication and routes to review
	// instead. A merely-low taste score still publishes as before.
	if (lastGate && !lastGate.pass) {
		logger.warn('[auto-pipeline] Max attempts reached AND the measured gate still fails (%s). Holding for review — not publishing.',
			lastGate.failures.join(', '));
		return {
			success: false,
			renderId: lastRenderId,
			downloadUrl: lastDownloadUrl,
			score: lastReview?.overallScore,
			attempts: maxAttempts,
			review: lastReview,
			error: `Render gate failed after ${maxAttempts} attempts: ${lastGate.failures.join(', ')}. Output is at the download URL for manual review.`,
		};
	}

	logger.warn('[auto-pipeline] Max attempts reached. Saving best result (score=%d, gate=%s)...',
		lastReview?.overallScore, lastGate ? 'pass' : 'unmeasured');

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
				editPlanClips: Array.isArray(currentPlan!.clips) ? currentPlan!.clips as PipelineResult['editPlanClips'] : undefined,
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
