/**
 * Remotion Lambda Render Orchestration
 *
 * Manages the full lifecycle of Remotion renders via AWS Lambda:
 *   1. Infrastructure config from env vars (set by scripts/setup-remotion-lambda.ts)
 *   2. Props conversion (RenderConfig → CLCVideoProps with proxy URLs)
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

	const result = await renderMediaOnLambda({
		region: infra.region as any,
		functionName: infra.functionName,
		serveUrl: infra.serveUrl,
		composition: 'CLCVideo',
		codec: 'h264',
		inputProps: props as unknown as Record<string, unknown>,
		privacy: 'public',
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
			return { id: renderId, status: 'failed', error: errorMsg };
		}

		if (progress.done && progress.outputFile) {
			// With privacy: 'public', outputFile is a directly accessible S3 URL
			entry.status = 'done';
			entry.outputUrl = progress.outputFile;
			logger?.info('[remotion-lambda] Render %s complete: %s', renderId, progress.outputFile);
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
