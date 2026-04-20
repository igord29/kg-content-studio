/**
 * Remotion Lambda Render Orchestration
 *
 * Manages the full lifecycle of Remotion renders via AWS Lambda:
 *   1. Infrastructure config from env vars (set by scripts/setup-remotion-lambda.ts)
 *   2. Props conversion (RenderConfig → CLCVideoProps with S3 URLs)
 *   3. Render submission via renderMediaOnLambda()
 *   4. Status polling via getRenderProgress()
 *
 * Only imports from '@remotion/lambda/client' (lightweight).
 * Heavy deployment functions live in scripts/setup-remotion-lambda.ts (run locally).
 *
 * Same RenderResult shape as Shotstack's checkStatus() so the
 * frontend polling code works for both engines transparently.
 *
 * File: src/agent/video-editor/remotion/render.ts
 */

import type { CLCVideoProps } from './types';
import type { PreprocessedClip } from '../preprocess';
import { PLATFORM_SETTINGS } from '../shotstack';
import { buildProcessedFileProxyUrl } from '../drive-proxy';
import {
	logRenderStart,
	logClipDiagnostics,
	logRenderSubmitted,
	logRenderDone,
	logRenderFailed,
	buildClipDiagnostics,
} from '../../../lib/render-logger';

// --- Types ---

export interface RenderResult {
	id: string;
	status: 'queued' | 'fetching' | 'rendering' | 'saving' | 'done' | 'failed';
	url?: string;
	error?: string;
}

interface Logger {
	info: (...args: any[]) => void;
	error?: (...args: any[]) => void;
	warn?: (...args: any[]) => void;
}

interface LambdaInfrastructure {
	bucketName: string;
	functionName: string;
	serveUrl: string;
	region: string;
}

interface LambdaRenderEntry {
	localId: string;            // Our render ID: remotion_<ts>_<rand>
	lambdaRenderId: string;     // Lambda's internal render ID
	bucketName: string;
	functionName: string;
	region: string;
	status: 'queued' | 'rendering' | 'done' | 'failed';
	outputUrl?: string;         // S3 public URL
	error?: string;
	createdAt: number;
}

// --- In-Memory State ---

/**
 * Cached Lambda infrastructure — read from env vars on first use.
 * Set by running: bun scripts/setup-remotion-lambda.ts
 */
let cachedInfra: LambdaInfrastructure | null = null;

/**
 * Registry of active/completed Lambda renders.
 * Key: our render ID (remotion_<timestamp>_<random>)
 * Value: Lambda render ID mapping + status
 */
const renderRegistry = new Map<string, LambdaRenderEntry>();

/**
 * Pre-register a render ID in the registry so status polling works
 * before the Lambda submission completes (during preprocessing).
 * Status will show as 'queued' until Lambda submission updates it.
 */
export function preRegisterRender(renderId: string): void {
	renderRegistry.set(renderId, {
		localId: renderId,
		lambdaRenderId: '',  // Not yet known — set during Lambda submission
		bucketName: '',
		functionName: '',
		region: '',
		status: 'queued',
		createdAt: Date.now(),
	});
}

/**
 * Update a pre-registered render entry after Lambda submission.
 */
export function updateRenderEntry(renderId: string, update: Partial<LambdaRenderEntry>): void {
	const entry = renderRegistry.get(renderId);
	if (entry) {
		Object.assign(entry, update);
	}
}

/**
 * Mark a pre-registered render as failed.
 * Also persists the failure to render_logs (fire-and-forget).
 */
export function failRender(renderId: string, error: string): void {
	const entry = renderRegistry.get(renderId);
	if (entry) {
		entry.status = 'failed';
		entry.error = error;
	}
	// Persist to render_logs — fire and forget, already swallows its own errors.
	void logRenderFailed(renderId, error);
}

// --- Lambda Infrastructure ---

/**
 * Get the AWS region from env var or default.
 */
function getRegion(): string {
	return process.env.REMOTION_AWS_REGION || 'us-east-1';
}

/**
 * Get Lambda infrastructure config from environment variables.
 *
 * These env vars are set after running the one-time setup script:
 *   bun scripts/setup-remotion-lambda.ts
 *
 * If env vars aren't set, falls back to auto-discovery via
 * @remotion/lambda/client (getFunctions/getSites) — lightweight
 * API calls that only read existing AWS resources.
 */
async function getInfra(logger?: Logger): Promise<LambdaInfrastructure> {
	if (cachedInfra) return cachedInfra;

	const region = getRegion();

	// Check for explicit env var config (fastest path — no AWS API calls)
	const envFunction = process.env.REMOTION_FUNCTION_NAME;
	const envServeUrl = process.env.REMOTION_SERVE_URL;
	const envBucket = process.env.REMOTION_BUCKET_NAME;

	if (envFunction && envServeUrl && envBucket) {
		logger?.info('[remotion-lambda] Using env var config: function=%s, bucket=%s', envFunction, envBucket);
		cachedInfra = {
			bucketName: envBucket,
			functionName: envFunction,
			serveUrl: envServeUrl,
			region,
		};
		return cachedInfra;
	}

	// Fallback: auto-discover from AWS via lightweight /client APIs
	logger?.info('[remotion-lambda] No env var config — discovering infrastructure via AWS API...');
	const startTime = Date.now();

	try {
		const { getFunctions, getSites } = await import('@remotion/lambda/client');

		// Discover Lambda function
		const functions = await getFunctions({
			region: region as any,
			compatibleOnly: true,
		});
		if (functions.length === 0) {
			throw new Error(
				'No Remotion Lambda function found. Run: bun scripts/setup-remotion-lambda.ts'
			);
		}
		const functionName = functions[0]!.functionName;

		// Discover site (need bucket name first — extract from function's bucket or site listing)
		const sites = await getSites({ region: region as any });
		if (sites.sites.length === 0) {
			throw new Error(
				'No Remotion site found. Run: bun scripts/setup-remotion-lambda.ts'
			);
		}
		const site = sites.sites[0]!;
		const serveUrl = site.serveUrl;
		const bucketName = site.bucketName;

		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		logger?.info('[remotion-lambda] Discovered infra in %ss: function=%s, site=%s, bucket=%s',
			elapsed, functionName, serveUrl, bucketName);

		cachedInfra = { bucketName, functionName, serveUrl, region };
		return cachedInfra;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger?.error?.('[remotion-lambda] Infrastructure discovery failed: %s', msg);
		throw new Error(
			'Remotion Lambda infrastructure not found. Run: bun scripts/setup-remotion-lambda.ts\n' + msg
		);
	}
}

// --- Props Builder ---

/**
 * Convert a RenderConfig + PreprocessedClips to Remotion CLCVideoProps.
 *
 * Uses proxy URLs (not local file paths) so Lambda workers can fetch
 * the preprocessed clips over HTTP from our server.
 */
export function buildRemotionProps(
	config: {
		clips: Array<{
			fileId: string;
			filename?: string;
			trimStart?: number;
			duration?: number;
			purpose?: string;
			speed?: number;
		}>;
		textOverlays?: Array<{
			text: string;
			start: number;
			duration: number;
			position?: string;
		}>;
		musicUrl?: string | null;
		mode: string;
		platform: string;
	},
	processedClips: PreprocessedClip[],
	appUrl: string,
): CLCVideoProps {
	const platformSettings = PLATFORM_SETTINGS[config.platform] || PLATFORM_SETTINGS['youtube']!;

	// FPS: standard 30fps
	const fps = 30;

	// Mode-specific settings
	const REMOTION_MODE_SETTINGS: Record<string, { transitionDuration: number; bgColor: string }> = {
		game_day:  { transitionDuration: 0.5, bgColor: '#000000' },
		our_story: { transitionDuration: 1.0, bgColor: '#0a0a0a' },
		quick_hit: { transitionDuration: 0.3, bgColor: '#000000' },
		showcase:  { transitionDuration: 0.8, bgColor: '#0a0a0a' },
	};
	const remotionMode = REMOTION_MODE_SETTINGS[config.mode] || REMOTION_MODE_SETTINGS['game_day']!;
	const transitionDurationFrames = Math.round(remotionMode.transitionDuration * fps);

	// Build clip props using proxy URLs (Lambda fetches these over HTTP)
	const clipProps: CLCVideoProps['clips'] = processedClips.map((pc) => ({
		src: buildProcessedFileProxyUrl(appUrl, pc.processedId),
		length: pc.effectiveDuration,
	}));

	// Build text overlay props — convert seconds to frames
	const textOverlays: CLCVideoProps['textOverlays'] = (config.textOverlays || []).map((overlay, index, arr) => {
		const startFrame = Math.round(overlay.start * fps);
		const durationFrames = Math.round(overlay.duration * fps);
		return {
			text: overlay.text,
			startFrame,
			durationFrames,
			position: (overlay.position as 'top' | 'center' | 'bottom') || 'bottom',
			isFirst: index === 0,
			isLast: index === arr.length - 1,
		};
	});

	return {
		clips: clipProps,
		mode: config.mode,
		width: platformSettings.width,
		height: platformSettings.height,
		fps,
		textOverlays,
		musicSrc: config.musicUrl || undefined,
		musicVolume: 0.3,
		bgColor: remotionMode.bgColor,
		transitionDurationFrames,
	};
}

// --- Render Submission ---

/**
 * Submit a Remotion render to AWS Lambda.
 *
 * Flow:
 *   1. Ensure Lambda infrastructure is ready (bucket, function, site)
 *   2. Build props with proxy URLs for video clips
 *   3. Call renderMediaOnLambda() — kicks off distributed render on AWS
 *   4. Store mapping in registry for status polling
 *   5. Return our render ID immediately
 */
export async function submitRemotionRender(
	config: {
		clips: Array<{
			fileId: string;
			filename?: string;
			trimStart?: number;
			duration?: number;
			purpose?: string;
			speed?: number;
		}>;
		textOverlays?: Array<{
			text: string;
			start: number;
			duration: number;
			position?: string;
		}>;
		musicUrl?: string | null;
		mode: string;
		platform: string;
	},
	processedClips: PreprocessedClip[],
	appUrl: string,
	logger?: Logger,
): Promise<string> {
	const renderId = `remotion_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

	logger?.info('[remotion-lambda] Render %s: getting infrastructure config...', renderId);

	// Step 1: Get Lambda infrastructure config
	const infra = await getInfra(logger);

	// Step 2: Build props with proxy URLs
	const props = buildRemotionProps(config, processedClips, appUrl);

	logger?.info('[remotion-lambda] Submitting render: %d clips, %dx%d, mode=%s, platform=%s',
		props.clips.length, props.width, props.height, config.mode, config.platform);

	// Step 3: Submit to Lambda
	const { renderMediaOnLambda } = await import('@remotion/lambda/client');

	// Limit concurrent Lambda invocations for low-concurrency AWS accounts.
	// Default limit is 10 for new accounts. Target max 4 renderers + 1 orchestrator = 5.
	const totalDuration = props.clips.reduce((sum, c) => sum + c.length, 0);
	const totalFrames = Math.ceil(totalDuration * props.fps);
	const maxRendererLambdas = 4;
	const framesPerLambda = Math.max(200, Math.ceil(totalFrames / maxRendererLambdas));

	const result = await renderMediaOnLambda({
		region: infra.region as any,
		functionName: infra.functionName,
		serveUrl: infra.serveUrl,
		composition: 'CLCVideo',
		codec: 'h264',
		inputProps: props as unknown as Record<string, unknown>,
		privacy: 'public',
		framesPerLambda,
		// Generous timeout: Lambda workers must download full videos from Drive via our proxy
		// before extracting frames. Default 30s is too short for large clips.
		timeoutInMilliseconds: 240_000,
	});

	// Step 4: Store mapping in registry
	renderRegistry.set(renderId, {
		localId: renderId,
		lambdaRenderId: result.renderId,
		bucketName: result.bucketName,
		functionName: infra.functionName,
		region: infra.region,
		status: 'queued',
		createdAt: Date.now(),
	});

	logger?.info('[remotion-lambda] Submitted. Lambda renderId: %s → our renderId: %s',
		result.renderId, renderId);

	return renderId;
}

// --- Direct Render (S3 upload → Lambda) ---

/**
 * Submit a Remotion render to AWS Lambda.
 *
 * Pipeline:
 *   1. Upload raw clips from Google Drive → Remotion S3 bucket (same AWS region)
 *   2. Build Remotion props with S3 URLs (Lambda → S3 is ~1GB/s)
 *   3. Submit renderMediaOnLambda() with S3-backed clip URLs
 *   4. Schedule S3 cleanup after render completes
 *
 * This avoids the slow double-hop (Lambda → Agentuity → Drive) that caused
 * OffthreadVideo timeouts. The upload happens once on our server, then all
 * Lambda workers fetch from fast same-region S3.
 */
export async function submitRemotionRenderDirect(
	config: {
		clips: Array<{
			fileId: string;
			filename?: string;
			trimStart?: number;
			duration?: number;
			purpose?: string;
			speed?: number;
		}>;
		textOverlays?: Array<{
			text: string;
			start: number;
			duration: number;
			position?: string;
		}>;
		musicUrl?: string | null;
		mode: string;
		platform: string;
	},
	appUrl: string,
	logger?: Logger,
	preRegisteredRenderId?: string,
): Promise<string> {
	const renderId = preRegisteredRenderId || `remotion_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

	logger?.info('[remotion-lambda] Render %s: getting infrastructure config...', renderId);

	// Persist render start to Supabase (fire-and-forget). Captures the full
	// edit plan so we can diagnose failures even after the Railway container
	// has been replaced and runtime logs are gone.
	void logRenderStart({
		renderId,
		platform: config.platform,
		mode: config.mode,
		editPlan: {
			clips: config.clips,
			textOverlays: config.textOverlays || [],
			musicUrl: config.musicUrl ?? null,
			mode: config.mode,
			platform: config.platform,
		},
	});

	// Step 1: Get Lambda infrastructure config
	const infra = await getInfra(logger);

	// Step 2: Upload clips from Google Drive to S3
	// This is the key optimization: Lambda workers fetch from same-region S3 (~1GB/s)
	// instead of the slow double-hop through our server to Google Drive.
	const { uploadClipsToS3, cleanupS3Clips } = await import('./s3-upload');

	const fileIds = config.clips.map(c => c.fileId);
	logger?.info('[remotion-lambda] Uploading %d clips from Drive to S3 bucket %s...',
		fileIds.length, infra.bucketName);

	const s3Clips = await uploadClipsToS3(
		fileIds,
		infra.bucketName,
		infra.region,
		logger,
	);

	// Persist per-clip upload results — this is the key diagnostic data for
	// issues like "same scene repeating" or "clip missing from output."
	void logClipDiagnostics(renderId, buildClipDiagnostics(config.clips, s3Clips));

	// Step 3: Build props with S3 URLs
	const platformSettings = PLATFORM_SETTINGS[config.platform] || PLATFORM_SETTINGS['youtube']!;
	const fps = 30;

	const REMOTION_MODE_SETTINGS: Record<string, { transitionDuration: number; bgColor: string }> = {
		game_day:  { transitionDuration: 0.5, bgColor: '#000000' },
		our_story: { transitionDuration: 1.0, bgColor: '#0a0a0a' },
		quick_hit: { transitionDuration: 0.3, bgColor: '#000000' },
		showcase:  { transitionDuration: 0.8, bgColor: '#0a0a0a' },
	};
	const remotionMode = REMOTION_MODE_SETTINGS[config.mode] || REMOTION_MODE_SETTINGS['game_day']!;
	const transitionDurationFrames = Math.round(remotionMode.transitionDuration * fps);

	// Build clip props using S3 URLs (fast same-region access for Lambda)
	// Smart zoom/crop defaults based on content type from catalog
	// Framing defaults by content type. objectFit:'cover' already crops
	// horizontal (16:9) source to fill vertical (9:16) frame — so zoom=1.0
	// means the natural cover-crop. Zoom > 1.0 adds ADDITIONAL crop on top.
	// Previous zoom=2.0 for tennis was too aggressive — players invisible.
	const CONTENT_TYPE_FRAMING: Record<string, { zoom: number; cropY: number; cropX: number }> = {
		tennis_action: { zoom: 1.0, cropY: 60, cropX: 50 },   // Cover-crop only, focus slightly below center (court level)
		event:         { zoom: 1.0, cropY: 55, cropX: 50 },   // Cover-crop, slightly below center
		interview:     { zoom: 1.0, cropY: 50, cropX: 50 },   // Center on face
		chess:         { zoom: 1.0, cropY: 50, cropX: 50 },   // Centered
		establishing:  { zoom: 1.0, cropY: 50, cropX: 50 },   // Full frame, show the venue
		mixed:         { zoom: 1.0, cropY: 55, cropX: 50 },   // Slightly below center
		unknown:       { zoom: 1.0, cropY: 50, cropX: 50 },   // Safe default
	};

	const clipProps: CLCVideoProps['clips'] = config.clips.map((clip) => {
		const s3Info = s3Clips.get(clip.fileId);
		if (!s3Info) {
			throw new Error(`S3 upload missing for clip ${clip.fileId}`);
		}
		// Look up content type framing from the clip's purpose or default
		const contentType = (clip as any).contentType || 'unknown';
		const framing = CONTENT_TYPE_FRAMING[contentType] || CONTENT_TYPE_FRAMING['unknown']!;
		return {
			src: s3Info.s3Url,
			length: clip.duration || 5,
			trimStart: clip.trimStart || 0,
			zoom: (clip as any).zoom || framing.zoom,
			cropX: (clip as any).cropX || framing.cropX,
			cropY: (clip as any).cropY || framing.cropY,
		};
	});

	// Build text overlay props
	const textOverlays: CLCVideoProps['textOverlays'] = (config.textOverlays || []).map((overlay, index, arr) => {
		const startFrame = Math.round(overlay.start * fps);
		const durationFrames = Math.round(overlay.duration * fps);
		return {
			text: overlay.text,
			startFrame,
			durationFrames,
			position: (overlay.position as 'top' | 'center' | 'bottom') || 'bottom',
			isFirst: index === 0,
			isLast: index === arr.length - 1,
		};
	});

	const props: CLCVideoProps = {
		clips: clipProps,
		mode: config.mode,
		width: platformSettings.width,
		height: platformSettings.height,
		fps,
		textOverlays,
		musicSrc: config.musicUrl || undefined,
		musicVolume: 0.3,
		bgColor: remotionMode.bgColor,
		transitionDurationFrames,
	};

	logger?.info('[remotion-lambda] Submitting render (S3-backed): %d clips, %dx%d, mode=%s, platform=%s',
		props.clips.length, props.width, props.height, config.mode, config.platform);

	// Step 4: Submit to Lambda
	const { renderMediaOnLambda } = await import('@remotion/lambda/client');

	// Calculate total frames to set framesPerLambda appropriately.
	// AWS account has a low concurrency limit (default 10 for new accounts).
	// Remotion spawns (totalFrames / framesPerLambda) renderer Lambdas + 1 orchestrator.
	// We target max ~4 renderer Lambdas (+ 1 orchestrator = 5 total) to stay well within limit.
	const totalDuration = clipProps.reduce((sum, c) => sum + c.length, 0);
	const totalFrames = Math.ceil(totalDuration * fps);
	const maxRendererLambdas = 4;
	const framesPerLambda = Math.max(200, Math.ceil(totalFrames / maxRendererLambdas));

	logger?.info('[remotion-lambda] totalFrames=%d, framesPerLambda=%d (max %d renderer Lambdas)',
		totalFrames, framesPerLambda, maxRendererLambdas);

	const result = await renderMediaOnLambda({
		region: infra.region as any,
		functionName: infra.functionName,
		serveUrl: infra.serveUrl,
		composition: 'CLCVideo',
		codec: 'h264',
		inputProps: props as unknown as Record<string, unknown>,
		privacy: 'public',
		framesPerLambda,
		// Generous timeout: still needed for OffthreadVideo to process large clips
		timeoutInMilliseconds: 240_000,
	});

	// Step 5: Store mapping in registry (update if pre-registered, otherwise create)
	if (preRegisteredRenderId && renderRegistry.has(renderId)) {
		updateRenderEntry(renderId, {
			lambdaRenderId: result.renderId,
			bucketName: result.bucketName,
			functionName: infra.functionName,
			region: infra.region,
			status: 'queued',
		});
	} else {
		const entry: LambdaRenderEntry = {
			localId: renderId,
			lambdaRenderId: result.renderId,
			bucketName: result.bucketName,
			functionName: infra.functionName,
			region: infra.region,
			status: 'queued',
			createdAt: Date.now(),
		};
		renderRegistry.set(renderId, entry);
	}

	// Persist the exact props we handed Lambda + its render ID. This is the
	// last checkpoint under our control — anything after this is Lambda-side.
	void logRenderSubmitted(renderId, result.renderId, props);

	// Schedule S3 cleanup after 30 minutes (generous: renders take 2-5 min)
	const s3ClipsList = [...s3Clips.values()];
	setTimeout(async () => {
		logger?.info('[remotion-lambda] Cleaning up %d temp S3 clips for render %s...',
			s3ClipsList.length, renderId);
		await cleanupS3Clips(s3ClipsList, infra.bucketName, infra.region, logger);
	}, 30 * 60 * 1000);

	logger?.info('[remotion-lambda] Submitted (S3-backed). Lambda renderId: %s → our renderId: %s',
		result.renderId, renderId);

	return renderId;
}

// --- Preprocessed Render (FFmpeg → S3 → Lambda) ---

/**
 * Submit a Remotion render using preprocessed local clips.
 *
 * Pipeline:
 *   1. FFmpeg preprocess: Drive → download → deshake + sharpen + trim + speed → local .mp4
 *   2. Upload preprocessed .mp4 files to Remotion S3 bucket
 *   3. Build Remotion props with S3 URLs (trimStart=0, already trimmed)
 *   4. Submit renderMediaOnLambda()
 *   5. Schedule S3 cleanup
 *
 * This gives Lambda workers stabilized, sharpened, pre-trimmed clips
 * instead of raw shaky footage.
 */
export async function submitRemotionRenderPreprocessed(
	config: {
		clips: Array<{
			fileId: string;
			filename?: string;
			trimStart?: number;
			duration?: number;
			purpose?: string;
			speed?: number;
		}>;
		textOverlays?: Array<{
			text: string;
			start: number;
			duration: number;
			position?: string;
		}>;
		musicUrl?: string | null;
		mode: string;
		platform: string;
	},
	processedClips: PreprocessedClip[],
	logger?: Logger,
	existingRenderId?: string,
): Promise<string> {
	const renderId = existingRenderId || `remotion_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

	logger?.info('[remotion-lambda] Render %s: getting infrastructure config...', renderId);

	// Step 1: Get Lambda infrastructure config
	const infra = await getInfra(logger);

	// Step 2: Upload preprocessed local files to S3
	const { uploadPreprocessedClipsToS3, cleanupS3Clips } = await import('./s3-upload');

	const clipsForUpload = processedClips.map(pc => ({
		processedId: pc.processedId,
		localPath: pc.localPath,
	}));

	logger?.info('[remotion-lambda] Uploading %d preprocessed clips to S3 bucket %s...',
		clipsForUpload.length, infra.bucketName);

	const s3Clips = await uploadPreprocessedClipsToS3(
		clipsForUpload,
		infra.bucketName,
		infra.region,
		logger,
	);

	// Step 3: Build props with S3 URLs (clips are already trimmed/processed)
	const platformSettings = PLATFORM_SETTINGS[config.platform] || PLATFORM_SETTINGS['youtube']!;
	const fps = 30;

	const REMOTION_MODE_SETTINGS: Record<string, { transitionDuration: number; bgColor: string }> = {
		game_day:  { transitionDuration: 0.5, bgColor: '#000000' },
		our_story: { transitionDuration: 1.0, bgColor: '#0a0a0a' },
		quick_hit: { transitionDuration: 0.3, bgColor: '#000000' },
		showcase:  { transitionDuration: 0.8, bgColor: '#0a0a0a' },
	};
	const remotionMode = REMOTION_MODE_SETTINGS[config.mode] || REMOTION_MODE_SETTINGS['game_day']!;
	const transitionDurationFrames = Math.round(remotionMode.transitionDuration * fps);

	// Build clip props using S3 URLs for preprocessed files
	// trimStart=0 because FFmpeg already trimmed during preprocessing
	const clipProps: CLCVideoProps['clips'] = processedClips.map((pc) => {
		const s3Info = s3Clips.get(pc.processedId);
		if (!s3Info) {
			throw new Error(`S3 upload missing for preprocessed clip ${pc.processedId}`);
		}
		return {
			src: s3Info.s3Url,
			length: pc.effectiveDuration,
			trimStart: 0, // Already trimmed by FFmpeg
		};
	});

	// Build text overlay props
	const textOverlays: CLCVideoProps['textOverlays'] = (config.textOverlays || []).map((overlay, index, arr) => {
		const startFrame = Math.round(overlay.start * fps);
		const durationFrames = Math.round(overlay.duration * fps);
		return {
			text: overlay.text,
			startFrame,
			durationFrames,
			position: (overlay.position as 'top' | 'center' | 'bottom') || 'bottom',
			isFirst: index === 0,
			isLast: index === arr.length - 1,
		};
	});

	const props: CLCVideoProps = {
		clips: clipProps,
		mode: config.mode,
		width: platformSettings.width,
		height: platformSettings.height,
		fps,
		textOverlays,
		musicSrc: config.musicUrl || undefined,
		musicVolume: 0.3,
		bgColor: remotionMode.bgColor,
		transitionDurationFrames,
	};

	logger?.info('[remotion-lambda] Submitting render (preprocessed): %d clips, %dx%d, mode=%s, platform=%s',
		props.clips.length, props.width, props.height, config.mode, config.platform);

	// Step 4: Submit to Lambda
	const { renderMediaOnLambda } = await import('@remotion/lambda/client');

	const totalDuration = clipProps.reduce((sum, c) => sum + c.length, 0);
	const totalFrames = Math.ceil(totalDuration * fps);
	const maxRendererLambdas = 4;
	const framesPerLambda = Math.max(200, Math.ceil(totalFrames / maxRendererLambdas));

	logger?.info('[remotion-lambda] totalFrames=%d, framesPerLambda=%d (max %d renderer Lambdas)',
		totalFrames, framesPerLambda, maxRendererLambdas);

	const result = await renderMediaOnLambda({
		region: infra.region as any,
		functionName: infra.functionName,
		serveUrl: infra.serveUrl,
		composition: 'CLCVideo',
		codec: 'h264',
		inputProps: props as unknown as Record<string, unknown>,
		privacy: 'public',
		framesPerLambda,
		timeoutInMilliseconds: 240_000,
	});

	// Step 5: Store mapping in registry
	const entry: LambdaRenderEntry = {
		localId: renderId,
		lambdaRenderId: result.renderId,
		bucketName: result.bucketName,
		functionName: infra.functionName,
		region: infra.region,
		status: 'queued',
		createdAt: Date.now(),
	};
	renderRegistry.set(renderId, entry);

	// Schedule S3 cleanup after 30 minutes
	const s3ClipsList = [...s3Clips.values()];
	setTimeout(async () => {
		logger?.info('[remotion-lambda] Cleaning up %d temp S3 clips for render %s...',
			s3ClipsList.length, renderId);
		await cleanupS3Clips(s3ClipsList, infra.bucketName, infra.region, logger);
	}, 30 * 60 * 1000);

	logger?.info('[remotion-lambda] Submitted (preprocessed). Lambda renderId: %s → our renderId: %s',
		result.renderId, renderId);

	return renderId;
}

// --- Preprocessor Lambda Render (Drive → S3 → FFmpeg Lambda → S3 → Remotion Lambda) ---

/**
 * Submit a Remotion render with FFmpeg preprocessing via a dedicated Lambda.
 *
 * Full pipeline:
 *   1. Upload raw clips from Google Drive → S3 (existing uploadClipsToS3)
 *   2. Invoke preprocessor Lambda for each clip (deshake + sharpen + trim + speed)
 *   3. Build Remotion props with processed S3 URLs (trimStart=0, already trimmed)
 *   4. Submit renderMediaOnLambda() with processed clips
 *   5. Schedule cleanup of all S3 clips (raw + processed)
 *
 * This is designed to run in a fire-and-forget async block:
 *   - Render ID is pre-registered before calling this function
 *   - On success: render registry is updated with Lambda render ID
 *   - On failure: render registry is updated with error
 *
 * The caller should NOT await this if running under Agentuity's 60s timeout.
 * Instead: pre-register, fire async, return render ID immediately.
 */
export async function submitRemotionRenderWithPreprocessing(
	config: {
		clips: Array<{
			fileId: string;
			filename?: string;
			trimStart?: number;
			duration?: number;
			purpose?: string;
			speed?: number;
		}>;
		textOverlays?: Array<{
			text: string;
			start: number;
			duration: number;
			position?: string;
		}>;
		musicUrl?: string | null;
		mode: string;
		platform: string;
	},
	renderId: string,
	logger?: Logger,
): Promise<void> {
	try {
		const memLog = () => {
			const m = process.memoryUsage();
			return `rss=${(m.rss / 1024 / 1024).toFixed(0)}MB heap=${(m.heapUsed / 1024 / 1024).toFixed(0)}/${(m.heapTotal / 1024 / 1024).toFixed(0)}MB`;
		};

		logger?.info('[remotion-lambda] Render %s: starting preprocessed pipeline... [mem: %s]', renderId, memLog());

		// Step 1: Get Lambda infrastructure config
		const infra = await getInfra(logger);

		// Step 2: Upload raw clips from Google Drive to S3
		const { uploadClipsToS3, cleanupS3Clips } = await import('./s3-upload');
		const {
			invokePreprocessorForClips,
			buildPreprocessorConfigs,
		} = await import('./preprocessor-invoke');

		logger?.info('[remotion-lambda] After imports [mem: %s]', memLog());

		const fileIds = config.clips.map(c => c.fileId);
		logger?.info('[remotion-lambda] Uploading %d raw clips from Drive to S3 bucket %s...',
			fileIds.length, infra.bucketName);

		const s3Clips = await uploadClipsToS3(
			fileIds,
			infra.bucketName,
			infra.region,
			logger,
		);

		logger?.info('[remotion-lambda] S3 upload complete [mem: %s]', memLog());

		// Update status: raw upload complete, starting preprocessing
		updateRenderEntry(renderId, { status: 'rendering' });

		// Step 3: Try preprocessing, fall back to raw clips if it fails.
		// Preprocessing adds deshake + sharpen via Lambda, but "socket hang up"
		// errors on Bun/Railway have made it unreliable. Raw clips still render
		// fine — just without stabilization/sharpening.
		let useProcessedClips = false;
		let processedClipResults: Awaited<ReturnType<typeof invokePreprocessorForClips>> | null = null;

		try {
			const preprocessorConfigs = buildPreprocessorConfigs(config.clips, s3Clips);
			logger?.info('[remotion-lambda] Attempting preprocessor Lambda for %d clips... [mem: %s]', preprocessorConfigs.length, memLog());

			processedClipResults = await invokePreprocessorForClips(
				preprocessorConfigs,
				infra.bucketName,
				infra.region,
				logger,
			);
			useProcessedClips = true;
			logger?.info('[remotion-lambda] Preprocessing succeeded for all %d clips', processedClipResults.length);
		} catch (preprocessErr) {
			const msg = preprocessErr instanceof Error ? preprocessErr.message : String(preprocessErr);
			logger?.warn?.('[remotion-lambda] Preprocessing failed, falling back to raw clips: %s', msg);
			// Continue with raw S3 clips — video will render without deshake/sharpen
		}

		// Step 4: Build Remotion props
		const platformSettings = PLATFORM_SETTINGS[config.platform] || PLATFORM_SETTINGS['youtube']!;
		const fps = 30;

		const REMOTION_MODE_SETTINGS: Record<string, { transitionDuration: number; bgColor: string }> = {
			game_day:  { transitionDuration: 0.5, bgColor: '#000000' },
			our_story: { transitionDuration: 1.0, bgColor: '#0a0a0a' },
			quick_hit: { transitionDuration: 0.3, bgColor: '#000000' },
			showcase:  { transitionDuration: 0.8, bgColor: '#0a0a0a' },
		};
		const remotionMode = REMOTION_MODE_SETTINGS[config.mode] || REMOTION_MODE_SETTINGS['game_day']!;
		const transitionDurationFrames = Math.round(remotionMode.transitionDuration * fps);

		// Build clip props — use processed S3 URLs if preprocessing succeeded,
		// otherwise fall back to raw S3 URLs with original trim points
		let clipProps: CLCVideoProps['clips'];

		if (useProcessedClips && processedClipResults) {
			// Preprocessed: trimStart=0 because FFmpeg already trimmed
			clipProps = processedClipResults.map((pc) => ({
				src: pc.outputS3Url,
				length: pc.effectiveDuration,
				trimStart: 0,
			}));
			logger?.info('[remotion-lambda] Using %d preprocessed clips (stabilized + sharpened)', clipProps.length);
		} else {
			// Fallback: use raw S3 clips with original trim/duration from edit plan
			clipProps = config.clips.map((clip) => {
				const s3Info = s3Clips.get(clip.fileId);
				if (!s3Info) throw new Error(`S3 upload missing for clip ${clip.fileId}`);
				return {
					src: s3Info.s3Url,
					length: clip.duration || 5,
					trimStart: clip.trimStart || 0,
				};
			});
			logger?.info('[remotion-lambda] Using %d raw clips (no preprocessing — fallback mode)', clipProps.length);
		}

		// Build text overlay props
		const textOverlays: CLCVideoProps['textOverlays'] = (config.textOverlays || []).map((overlay, index, arr) => {
			const startFrame = Math.round(overlay.start * fps);
			const durationFrames = Math.round(overlay.duration * fps);
			return {
				text: overlay.text,
				startFrame,
				durationFrames,
				position: (overlay.position as 'top' | 'center' | 'bottom') || 'bottom',
				isFirst: index === 0,
				isLast: index === arr.length - 1,
			};
		});

		const props: CLCVideoProps = {
			clips: clipProps,
			mode: config.mode,
			width: platformSettings.width,
			height: platformSettings.height,
			fps,
			textOverlays,
			musicSrc: config.musicUrl || undefined,
			musicVolume: 0.3,
			bgColor: remotionMode.bgColor,
			transitionDurationFrames,
		};

		logger?.info('[remotion-lambda] Submitting render (preprocessed via Lambda): %d clips, %dx%d, mode=%s',
			props.clips.length, props.width, props.height, config.mode);

		// Step 5: Submit to Remotion Lambda
		const { renderMediaOnLambda } = await import('@remotion/lambda/client');

		const totalDuration = clipProps.reduce((sum, c) => sum + c.length, 0);
		const totalFrames = Math.ceil(totalDuration * fps);
		const maxRendererLambdas = 4;
		const framesPerLambda = Math.max(200, Math.ceil(totalFrames / maxRendererLambdas));

		logger?.info('[remotion-lambda] totalFrames=%d, framesPerLambda=%d',
			totalFrames, framesPerLambda);

		const result = await renderMediaOnLambda({
			region: infra.region as any,
			functionName: infra.functionName,
			serveUrl: infra.serveUrl,
			composition: 'CLCVideo',
			codec: 'h264',
			inputProps: props as unknown as Record<string, unknown>,
			privacy: 'public',
			framesPerLambda,
			timeoutInMilliseconds: 240_000,
		});

		// Step 6: Update render registry with Lambda render ID
		updateRenderEntry(renderId, {
			lambdaRenderId: result.renderId,
			bucketName: result.bucketName,
			functionName: infra.functionName,
			region: infra.region,
			status: 'rendering',
		});

		// Schedule cleanup of S3 clips after 30 minutes
		const rawClipsList = [...s3Clips.values()];
		const processedS3Keys = (useProcessedClips && processedClipResults)
			? processedClipResults.map(pc => ({
				fileId: pc.fileId,
				s3Key: pc.outputS3Key,
				s3Url: pc.outputS3Url,
				sizeBytes: pc.outputSizeBytes,
			}))
			: [];
		const allClips = [...rawClipsList, ...processedS3Keys];

		setTimeout(async () => {
			logger?.info('[remotion-lambda] Cleaning up %d S3 clips (raw + processed) for render %s...',
				allClips.length, renderId);
			await cleanupS3Clips(allClips, infra.bucketName, infra.region, logger);
		}, 30 * 60 * 1000);

		logger?.info('[remotion-lambda] Submitted (preprocessed via Lambda). Lambda renderId: %s → our renderId: %s',
			result.renderId, renderId);

	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger?.error?.('[remotion-lambda] Preprocessed render pipeline failed for %s: %s', renderId, msg);
		failRender(renderId, msg);
	}
}

// --- Status Check ---

/**
 * Check the status of a Remotion Lambda render.
 *
 * Polls AWS Lambda for progress, caches done/failed results.
 * Returns the same RenderResult shape as Shotstack's checkStatus()
 * so the frontend polling code works transparently.
 */
export async function checkRemotionStatus(renderId: string, logger?: Logger): Promise<RenderResult> {
	const entry = renderRegistry.get(renderId);

	if (!entry) {
		return {
			id: renderId,
			status: 'failed',
			error: 'Render not found — it may have expired from memory',
		};
	}

	// Return cached terminal states
	if (entry.status === 'done') {
		return { id: renderId, status: 'done', url: entry.outputUrl };
	}
	if (entry.status === 'failed') {
		return { id: renderId, status: 'failed', error: entry.error };
	}

	// If Lambda hasn't been submitted yet (still preprocessing), return queued status
	if (!entry.lambdaRenderId || !entry.bucketName || !entry.region) {
		logger?.info('[remotion-lambda] Render %s still preprocessing (awaiting Lambda submission)', renderId);
		return { id: renderId, status: 'rendering' };
	}

	// Poll Lambda for progress
	try {
		const { getRenderProgress } = await import('@remotion/lambda/client');

		const progress = await getRenderProgress({
			renderId: entry.lambdaRenderId,
			bucketName: entry.bucketName,
			functionName: entry.functionName,
			region: entry.region as any,
		});

		if (progress.fatalErrorEncountered) {
			const errorMsg = progress.errors?.[0]?.message || 'Lambda render failed';
			entry.status = 'failed';
			entry.error = errorMsg;
			logger?.error?.('[remotion-lambda] Render %s failed: %s', renderId, errorMsg);
			// Persist terminal failure (fire-and-forget).
			void logRenderFailed(renderId, errorMsg);
			return { id: renderId, status: 'failed', error: errorMsg };
		}

		if (progress.done && progress.outputFile) {
			// With privacy: 'public', outputFile is a directly accessible S3 URL
			entry.status = 'done';
			entry.outputUrl = progress.outputFile;
			logger?.info('[remotion-lambda] Render %s complete: %s', renderId, progress.outputFile);
			// Persist terminal success (fire-and-forget).
			void logRenderDone(renderId, progress.outputFile);
			return { id: renderId, status: 'done', url: progress.outputFile };
		}

		// Still in progress
		const pct = (progress.overallProgress * 100).toFixed(0);
		logger?.info('[remotion-lambda] Render %s progress: %s%%', renderId, pct);

		entry.status = 'rendering';
		const mappedStatus: RenderResult['status'] = progress.overallProgress > 0 ? 'rendering' : 'fetching';
		return { id: renderId, status: mappedStatus };

	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger?.error?.('[remotion-lambda] Progress check failed for %s: %s', renderId, msg);
		// Don't mark as failed on transient errors — let polling retry
		return { id: renderId, status: 'rendering' };
	}
}

// --- Availability Check ---

/**
 * Test if Remotion Lambda rendering is available.
 *
 * Checks for:
 *   1. AWS credentials (REMOTION_AWS_ACCESS_KEY_ID + SECRET)
 *   2. Infrastructure config (env vars or auto-discovery)
 *
 * If env vars are set (REMOTION_FUNCTION_NAME, etc.), returns immediately.
 * Otherwise falls back to auto-discovery via lightweight AWS API calls.
 */
export async function testRemotionAvailability(logger?: Logger): Promise<{
	available: boolean;
	message: string;
}> {
	const hasAwsCreds = !!(
		process.env.REMOTION_AWS_ACCESS_KEY_ID &&
		process.env.REMOTION_AWS_SECRET_ACCESS_KEY
	);

	if (!hasAwsCreds) {
		logger?.info('[remotion-lambda] No AWS credentials found');
		return {
			available: false,
			message: 'Remotion Lambda requires REMOTION_AWS_ACCESS_KEY_ID and REMOTION_AWS_SECRET_ACCESS_KEY',
		};
	}

	// AWS creds found — try to resolve infrastructure config
	try {
		const infra = await getInfra(logger);
		return {
			available: true,
			message: `Remotion Lambda ready (${infra.region}, function: ${infra.functionName})`,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger?.error?.('[remotion-lambda] Infrastructure check failed: %s', msg);
		return {
			available: false,
			message: 'Remotion Lambda not configured: ' + msg,
		};
	}
}

// --- Explicit Setup ---

/**
 * Re-discover Lambda infrastructure from AWS.
 * Forces cache refresh. Useful for debugging.
 */
export async function setupLambdaInfra(logger?: Logger): Promise<{
	success: boolean;
	message: string;
	infrastructure?: LambdaInfrastructure;
}> {
	// Force re-discovery
	cachedInfra = null;

	try {
		const infra = await getInfra(logger);
		return {
			success: true,
			message: `Lambda ready: function=${infra.functionName}, site=${infra.serveUrl}, bucket=${infra.bucketName}, region=${infra.region}`,
			infrastructure: infra,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { success: false, message: 'Lambda setup failed: ' + msg };
	}
}
