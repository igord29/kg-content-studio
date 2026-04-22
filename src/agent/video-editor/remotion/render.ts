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
	lambdaRenderId: string;     // Remotion's server-generated render ID (known only after webhook fires)
	correlationId?: string;     // Our ID for webhook-store lookup (set at submit time)
	outputS3Key?: string;       // Known output path (set at submit time via outName)
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
 * Wrap a promise in a timeout that rejects if not settled within ms.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(
			() => reject(new Error(`${label} timed out after ${ms}ms`)),
			ms,
		);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

/**
 * Submit a render to Remotion Lambda via InvokeWithResponseStream — read ONLY
 * the first stream message (which contains the server-generated renderId and
 * confirms Lambda started), then break out of the stream iterator. Lambda
 * keeps rendering in the background; we track completion via webhook + S3 poll.
 *
 * Why this exists (evolution):
 *   1. `renderMediaOnLambda()` hung on Railway Bun — it reads the entire
 *      streaming response including render progress, which Bun's HTTP path
 *      can't keep alive for the full render duration.
 *   2. NodeHttpHandler caused "socket hang up" on Bun (per team note at
 *      preprocessor-invoke.ts:86).
 *   3. RequestResponse + AbortSignal aborted at 45s on Railway — same stream
 *      read-to-completion issue, just with a timeout.
 *   4. Direct Event invocation was silently dropped by AWS for the render
 *      Lambda: verified by inspecting S3 renders/ folder after Railway's
 *      Event invoke — NO progress.json was written for that invocation time,
 *      meaning Lambda never executed. This is because the render Lambda uses
 *      `awslambda.streamifyResponse`, which is designed for
 *      InvokeWithResponseStream and has undefined Event behavior.
 *   5. InvokeWithResponseStream + early-close proven to work locally: Lambda
 *      writes renderId to stream within ~300ms, we read it, close the stream,
 *      and the Lambda continues rendering in the background (verified via
 *      progress.json updates and final S3 output).
 *
 * Completion detection: we still return correlationId + outputS3Key so the
 * checkRemotionStatus() poll loop can race webhook store vs S3 HeadObject.
 */
async function submitRenderWithRetry(
	opts: Parameters<typeof import('@remotion/lambda/client').renderMediaOnLambda>[0],
	appUrl: string,
	logger?: Logger,
	maxAttempts = 3,
): Promise<{
	correlationId: string;
	outputS3Key: string;
	bucketName: string;
	lambdaRenderId?: string;
}> {
	const [lambdaClientMod, { LambdaClient, InvokeWithResponseStreamCommand }] = await Promise.all([
		import('@remotion/lambda-client'),
		import('@aws-sdk/client-lambda'),
	]);
	const { makeLambdaRenderMediaPayload, renderMediaOnLambdaOptionalToRequired } =
		(lambdaClientMod as any).LambdaClientInternals;

	const credentials = {
		accessKeyId: process.env.REMOTION_AWS_ACCESS_KEY_ID!,
		secretAccessKey: process.env.REMOTION_AWS_SECRET_ACCESS_KEY!,
	};

	const bucketName = opts.forceBucketName || process.env.REMOTION_BUCKET_NAME;
	if (!bucketName) {
		throw new Error('Render requires a bucket name (opts.forceBucketName or REMOTION_BUCKET_NAME env)');
	}

	// Generate correlation ID + deterministic output path
	const correlationId = `clc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	const outputS3Key = `custom-renders/${correlationId}/out.mp4`;

	// Defense-in-depth: this guard catches any caller that slipped past the outer
	// validation. The precise previous failure mode was `Y.replace is not a function`
	// from `appUrl.replace(/\/$/, '')` when appUrl was null/undefined/non-string.
	if (typeof appUrl !== 'string' || appUrl.length === 0) {
		throw new Error(
			`submitRenderWithRetry: appUrl must be a non-empty string (got ${typeof appUrl} ${JSON.stringify(appUrl)})`,
		);
	}
	const webhookUrl = `${appUrl.replace(/\/$/, '')}/api/remotion-webhook`;
	const webhookSecret = process.env.REMOTION_WEBHOOK_SECRET || null;

	let lastErr: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const start = Date.now();
		try {
			const fullInput = renderMediaOnLambdaOptionalToRequired({
				...opts,
				outName: { key: outputS3Key, bucketName },
				webhook: {
					url: webhookUrl,
					secret: webhookSecret,
					customData: { correlationId },
				},
				forceBucketName: bucketName,
			});

			const renderPayload = await withTimeout(
				makeLambdaRenderMediaPayload(fullInput),
				20_000,
				`makeLambdaRenderMediaPayload attempt ${attempt}/${maxAttempts}`,
			);

			// Use Bun's default fetch-based handler. NodeHttp2Handler was tried
			// but Bun's node:http2 implementation raises ERR_STREAM_PREMATURE_CLOSE
			// when the AWS SDK tries to stream, so we can't use it on Bun. The
			// default handler worked locally (produced 170MB output) but failed
			// on Railway — difference is Linux/Alpine + Railway networking.
			const lambda = new LambdaClient({ region: opts.region as string, credentials });

			const invokeStart = Date.now();
			const payloadBytes = Buffer.from(JSON.stringify(renderPayload));
			logger?.info('[remotion-lambda] Streaming invoke: correlationId=%s, payload=%d bytes, function=%s, region=%s',
				correlationId, payloadBytes.length, opts.functionName, opts.region);

			// InvokeWithResponseStream — NATIVE invocation pattern for Remotion's
			// streamified Lambda handler. We only need the first message (which the
			// START handler writes after calling callFunctionAsync for LAUNCH — so
			// by the time we read it, LAUNCH has already been kicked off). We then
			// break; Lambda continues async.
			//
			// Wrap in a 60s timeout: if lambda.send() hangs on Railway's Bun
			// without yielding ANY response, fall through to retry rather than
			// silently succeed with nothing.
			const streamResult = await withTimeout(
				lambda.send(
					new InvokeWithResponseStreamCommand({
						FunctionName: opts.functionName,
						Payload: payloadBytes,
						InvocationType: 'RequestResponse',
					}),
				),
				60_000,
				`InvokeWithResponseStream attempt ${attempt}/${maxAttempts}`,
			);

			logger?.info('[remotion-lambda] Stream opened in %dms: StatusCode=%s, hasEventStream=%s, responseStreamContentType=%s',
				Date.now() - invokeStart,
				streamResult.StatusCode,
				Boolean(streamResult.EventStream),
				streamResult.ResponseStreamContentType || 'unknown');

			if (streamResult.StatusCode !== 200) {
				throw new Error(`Streaming invoke returned unexpected status ${streamResult.StatusCode}`);
			}
			if (!streamResult.EventStream) {
				throw new Error('Streaming invoke returned no EventStream');
			}

			// Read just the first PayloadChunk then break. Abort reading the rest
			// of the stream — Lambda will continue running regardless.
			let firstMessage: string | null = null;
			let lambdaRenderId: string | undefined;
			let startError: { message: string; fatal: boolean } | null = null;
			let eventCount = 0;
			let sawPayloadChunk = false;
			let sawInvokeComplete = false;
			const iterStart = Date.now();
			try {
				// Timeout the iterator itself — on Railway's Bun, if the stream
				// is broken (HTTP/1.1 fallback, empty stream, etc.), the for-await
				// might hang forever. 30s is generous for the first chunk (~300ms
				// typical, Lambda cold-start may add seconds).
				await withTimeout(
					(async () => {
						for await (const event of streamResult.EventStream!) {
							eventCount++;
							const keys = Object.keys(event || {});
							logger?.info('[remotion-lambda]   event #%d (%dms): keys=%s',
								eventCount, Date.now() - iterStart, keys.join(','));
							if (event.PayloadChunk?.Payload) {
								sawPayloadChunk = true;
								firstMessage = new TextDecoder().decode(event.PayloadChunk.Payload);
								logger?.info('[remotion-lambda]   PayloadChunk (%d bytes): %s',
									event.PayloadChunk.Payload.length,
									firstMessage.slice(0, 300));
								// Parse the payload OUTSIDE the error-detection logic — a
								// JSON.parse failure is recoverable, but a {type:"error"}
								// payload is NOT and must propagate. The old code had the
								// throw inside the try/catch, so error payloads got
								// silently swallowed and the render would hang for 900s.
								let parsed: any = null;
								try {
									parsed = JSON.parse(firstMessage);
								} catch {
									logger?.warn?.('[remotion-lambda] First stream message not JSON: %s',
										firstMessage.slice(0, 200));
								}
								if (parsed?.type === 'error') {
									// Version-mismatch & similar fatal errors — no point
									// retrying; the Lambda will reject every time.
									const msg = parsed.message || firstMessage;
									const isVersionMismatch = typeof msg === 'string' &&
										msg.includes('Version mismatch');
									startError = {
										message: `Render Lambda start error: ${msg}`,
										fatal: isVersionMismatch,
									};
								} else if (parsed?.renderId) {
									lambdaRenderId = parsed.renderId;
								}
								break;
							}
							if (event.InvokeComplete) {
								sawInvokeComplete = true;
								const ic: any = event.InvokeComplete;
								logger?.warn?.('[remotion-lambda] InvokeComplete WITHOUT PayloadChunk: errorCode=%s errorDetails=%s logResult=%s',
									ic?.ErrorCode || 'none',
									(ic?.ErrorDetails || '').slice(0, 500),
									(ic?.LogResult || '').slice(0, 500));
								break;
							}
						}
					})(),
					30_000,
					`Stream iteration attempt ${attempt}/${maxAttempts}`,
				);
			} catch (streamErr) {
				const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
				logger?.warn?.('[remotion-lambda] Stream iterator ended: eventCount=%d, sawPayloadChunk=%s, sawInvokeComplete=%s, err=%s',
					eventCount, sawPayloadChunk, sawInvokeComplete, msg);
				// If we got a PayloadChunk before the error, Lambda is running — continue.
				// If not, treat as a submit failure and retry.
				if (!sawPayloadChunk) {
					throw new Error(`Stream yielded no PayloadChunk (events=${eventCount}, invokeComplete=${sawInvokeComplete}): ${msg}`);
				}
			}

			// Lambda responded with a {type:"error"} payload — e.g. version mismatch.
			// This is NOT recoverable by retry; surface it so the caller fails fast
			// instead of waiting for the 900s safety-net.
			if (startError) {
				const err = new Error(startError.message);
				if (startError.fatal) {
					// Tag as fatal so the outer retry loop doesn't waste attempts.
					(err as Error & { fatal?: boolean }).fatal = true;
				}
				throw err;
			}

			// If the stream ended cleanly but yielded no PayloadChunk, Lambda
			// probably didn't actually execute — fail the attempt so we retry.
			if (!sawPayloadChunk) {
				throw new Error(`Stream yielded no PayloadChunk (events=${eventCount}, invokeComplete=${sawInvokeComplete})`);
			}

			logger?.info('[remotion-lambda] Render submitted in %dms (lambdaRenderId=%s, events=%d)%s',
				Date.now() - invokeStart, lambdaRenderId || 'unknown', eventCount,
				attempt > 1 ? ` [attempt ${attempt}]` : '');

			return { correlationId, outputS3Key, bucketName, lambdaRenderId };
		} catch (err) {
			lastErr = err;
			const msg = err instanceof Error ? err.message : String(err);
			const isFatal = err instanceof Error &&
				(err as Error & { fatal?: boolean }).fatal === true;
			logger?.warn?.('[remotion-lambda] Submit attempt %d/%d failed after %dms: %s%s',
				attempt, maxAttempts, Date.now() - start, msg,
				isFatal ? ' (fatal — skipping retries)' : '');
			if (isFatal) {
				// e.g. version mismatch — no point retrying, the Lambda will reject every time.
				break;
			}
			if (attempt < maxAttempts) {
				await new Promise(r => setTimeout(r, 1000 * attempt));
			}
		}
	}
	throw lastErr instanceof Error
		? lastErr
		: new Error('Lambda streaming invoke failed after retries');
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
			animation?: string;  // 'fade' | 'slideUp' | 'slideDown' | 'scaleUp' | 'bounce' | 'typewriter'
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
			animation: (overlay as { animation?: string }).animation as CLCVideoProps['textOverlays'][number]['animation'],
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
			animation?: string;  // 'fade' | 'slideUp' | 'slideDown' | 'scaleUp' | 'bounce' | 'typewriter'
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

	// Step 3: Submit to Lambda (via wrapper that handles hung calls on Railway).

	// Limit concurrent Lambda invocations for low-concurrency AWS accounts.
	// Default limit is 10 for new accounts. Target max 4 renderers + 1 orchestrator = 5.
	const totalDuration = props.clips.reduce((sum, c) => sum + c.length, 0);
	const totalFrames = Math.ceil(totalDuration * props.fps);
	const maxRendererLambdas = 4;
	const framesPerLambda = Math.max(200, Math.ceil(totalFrames / maxRendererLambdas));

	const result = await submitRenderWithRetry({
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
		forceBucketName: infra.bucketName,
	}, appUrl, logger);

	// Step 4: Store mapping in registry
	renderRegistry.set(renderId, {
		localId: renderId,
		lambdaRenderId: result.lambdaRenderId || '',
		correlationId: result.correlationId,
		outputS3Key: result.outputS3Key,
		bucketName: result.bucketName,
		functionName: infra.functionName,
		region: infra.region,
		status: 'rendering',
		createdAt: Date.now(),
	});

	logger?.info('[remotion-lambda] Submitted. correlationId=%s → our renderId=%s',
		result.correlationId, renderId);

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
			animation?: string;  // 'fade' | 'slideUp' | 'slideDown' | 'scaleUp' | 'bounce' | 'typewriter'
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
			animation: (overlay as { animation?: string }).animation as CLCVideoProps['textOverlays'][number]['animation'],
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

	// Step 4: Submit to Lambda (via wrapper that handles hung calls on Railway).

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

	const result = await submitRenderWithRetry({
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
		forceBucketName: infra.bucketName,
	}, appUrl, logger);

	// Step 5: Store mapping in registry (update if pre-registered, otherwise create)
	if (preRegisteredRenderId && renderRegistry.has(renderId)) {
		updateRenderEntry(renderId, {
			correlationId: result.correlationId,
			outputS3Key: result.outputS3Key,
			bucketName: result.bucketName,
			lambdaRenderId: result.lambdaRenderId || '',
			functionName: infra.functionName,
			region: infra.region,
			status: 'rendering',
		});
	} else {
		const entry: LambdaRenderEntry = {
			localId: renderId,
			lambdaRenderId: result.lambdaRenderId || '',
			correlationId: result.correlationId,
			outputS3Key: result.outputS3Key,
			bucketName: result.bucketName,
			functionName: infra.functionName,
			region: infra.region,
			status: 'rendering',
			createdAt: Date.now(),
		};
		renderRegistry.set(renderId, entry);
	}

	// Persist the exact props we handed Lambda + our correlation ID. This is the
	// last checkpoint under our control — anything after this is Lambda-side.
	void logRenderSubmitted(renderId, result.correlationId, props);

	// Schedule S3 cleanup after 30 minutes (generous: renders take 2-5 min)
	const s3ClipsList = [...s3Clips.values()];
	setTimeout(async () => {
		logger?.info('[remotion-lambda] Cleaning up %d temp S3 clips for render %s...',
			s3ClipsList.length, renderId);
		await cleanupS3Clips(s3ClipsList, infra.bucketName, infra.region, logger);
	}, 30 * 60 * 1000);

	logger?.info('[remotion-lambda] Submitted (S3-backed). correlationId=%s → our renderId=%s',
		result.correlationId, renderId);

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
			animation?: string;  // 'fade' | 'slideUp' | 'slideDown' | 'scaleUp' | 'bounce' | 'typewriter'
		}>;
		musicUrl?: string | null;
		mode: string;
		platform: string;
	},
	processedClips: PreprocessedClip[],
	appUrl: string,
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
			animation: (overlay as { animation?: string }).animation as CLCVideoProps['textOverlays'][number]['animation'],
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

	// Step 4: Submit to Lambda (via wrapper that handles hung calls on Railway).

	const totalDuration = clipProps.reduce((sum, c) => sum + c.length, 0);
	const totalFrames = Math.ceil(totalDuration * fps);
	const maxRendererLambdas = 4;
	const framesPerLambda = Math.max(200, Math.ceil(totalFrames / maxRendererLambdas));

	logger?.info('[remotion-lambda] totalFrames=%d, framesPerLambda=%d (max %d renderer Lambdas)',
		totalFrames, framesPerLambda, maxRendererLambdas);

	const result = await submitRenderWithRetry({
		region: infra.region as any,
		functionName: infra.functionName,
		serveUrl: infra.serveUrl,
		composition: 'CLCVideo',
		codec: 'h264',
		inputProps: props as unknown as Record<string, unknown>,
		privacy: 'public',
		framesPerLambda,
		timeoutInMilliseconds: 240_000,
		forceBucketName: infra.bucketName,
	}, appUrl, logger);

	// Step 5: Store mapping in registry
	const entry: LambdaRenderEntry = {
		localId: renderId,
		lambdaRenderId: result.lambdaRenderId || '',
		correlationId: result.correlationId,
		outputS3Key: result.outputS3Key,
		bucketName: result.bucketName,
		functionName: infra.functionName,
		region: infra.region,
		status: 'rendering',
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

	logger?.info('[remotion-lambda] Submitted (preprocessed). correlationId=%s → our renderId=%s',
		result.correlationId, renderId);

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
			subjectPosition?: string;  // From catalog — drives Lambda smart crop
		}>;
		textOverlays?: Array<{
			text: string;
			start: number;
			duration: number;
			position?: string;
			animation?: string;  // 'fade' | 'slideUp' | 'slideDown' | 'scaleUp' | 'bounce' | 'typewriter'
		}>;
		musicUrl?: string | null;
		mode: string;
		platform: string;
	},
	renderId: string,
	appUrl: string,
	logger?: Logger,
): Promise<void> {
	try {
		// DEFENSIVE: appUrl MUST be a non-empty string. If the caller sent anything else
		// (null, undefined, an object, a number), fail fast with a clear error showing the
		// actual received value — not a cryptic `Y.replace is not a function` from deep inside.
		if (typeof appUrl !== 'string' || appUrl.length === 0) {
			throw new Error(
				`submitRemotionRenderWithPreprocessing: appUrl must be a non-empty string (got ${typeof appUrl} ${JSON.stringify(appUrl)}). ` +
				`This URL is the public-facing origin used for the Remotion webhook callback; it's normally injected by src/api/index.ts from x-forwarded-host.`,
			);
		}

		const memLog = () => {
			const m = process.memoryUsage();
			return `rss=${(m.rss / 1024 / 1024).toFixed(0)}MB heap=${(m.heapUsed / 1024 / 1024).toFixed(0)}/${(m.heapTotal / 1024 / 1024).toFixed(0)}MB`;
		};

		logger?.info('[remotion-lambda] Render %s: starting preprocessed pipeline (appUrl=%s)... [mem: %s]', renderId, appUrl, memLog());

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
			const platformSettingsForAspect = PLATFORM_SETTINGS[config.platform] || PLATFORM_SETTINGS['youtube']!;
			const targetAspect = platformSettingsForAspect.aspectRatio as '9:16' | '1:1' | '4:5' | '16:9';
			const preprocessorConfigs = buildPreprocessorConfigs(config.clips, s3Clips, 5, targetAspect);
			logger?.info('[remotion-lambda] Attempting preprocessor Lambda for %d clips (aspect=%s)... [mem: %s]',
				preprocessorConfigs.length, targetAspect, memLog());

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
			// Preprocessed: trimStart=0 because FFmpeg already trimmed.
			// Per-clip Remotion metadata (effect/filter/transitions) flows through
			// the preprocessor result as passthrough fields — no re-correlation needed.
			clipProps = processedClipResults.map((pc) => ({
				src: pc.outputS3Url,
				length: pc.effectiveDuration,
				trimStart: 0,
				effect: pc.effect,
				filter: pc.filter,
				transitionType: pc.transitionType,
				transitionDirection: pc.transitionDirection,
				speedKeyframes: pc.speedKeyframes,
			}));
			logger?.info('[remotion-lambda] Using %d preprocessed clips (stabilized + sharpened)', clipProps.length);
		} else {
			// Fallback: use raw S3 clips with original trim/duration from edit plan.
			clipProps = config.clips.map((clip: any) => {
				const s3Info = s3Clips.get(clip.fileId);
				if (!s3Info) throw new Error(`S3 upload missing for clip ${clip.fileId}`);
				return {
					src: s3Info.s3Url,
					length: clip.duration || 5,
					trimStart: clip.trimStart || 0,
					effect: clip.effect,
					filter: clip.filter,
					transitionType: clip.transitionType,
					transitionDirection: clip.transitionDirection,
					speedKeyframes: clip.speedKeyframes,
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

		// Step 5: Submit to Remotion Lambda (via wrapper that handles hung calls on Railway).

		const totalDuration = clipProps.reduce((sum, c) => sum + c.length, 0);
		const totalFrames = Math.ceil(totalDuration * fps);
		const maxRendererLambdas = 4;
		const framesPerLambda = Math.max(200, Math.ceil(totalFrames / maxRendererLambdas));

		logger?.info('[remotion-lambda] totalFrames=%d, framesPerLambda=%d',
			totalFrames, framesPerLambda);

		const result = await submitRenderWithRetry({
			region: infra.region as any,
			functionName: infra.functionName,
			serveUrl: infra.serveUrl,
			composition: 'CLCVideo',
			codec: 'h264',
			inputProps: props as unknown as Record<string, unknown>,
			privacy: 'public',
			framesPerLambda,
			timeoutInMilliseconds: 240_000,
			forceBucketName: infra.bucketName,
		}, appUrl, logger);

		// Step 6: Update render registry with correlation ID + output location.
		// lambdaRenderId may come from the streaming-invoke's first message; if
		// not present, webhook will fill it in when it fires.
		updateRenderEntry(renderId, {
			correlationId: result.correlationId,
			outputS3Key: result.outputS3Key,
			bucketName: result.bucketName,
			lambdaRenderId: result.lambdaRenderId || '',
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

		logger?.info('[remotion-lambda] Submitted (preprocessed via Lambda). correlationId=%s → our renderId=%s',
			result.correlationId, renderId);

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
 * Event+webhook architecture: Lambda was fire-and-forget invoked, so we can't
 * call getRenderProgress (we don't have Remotion's server-generated renderId).
 * Instead we check two completion signals in this order:
 *
 *   1. Webhook store lookup by correlationId — fast path, fires within seconds
 *      of success or error. Delivers outputUrl (success) or errors[] (failure).
 *   2. S3 HeadObject on our known outputS3Key — fallback in case webhook fails
 *      (network drop, Railway restart losing in-memory map, etc.). Object
 *      existence = success.
 *
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

	// If Lambda hasn't been submitted yet (still preprocessing), return queued.
	// Submit sets correlationId + outputS3Key, so their absence means we're pre-submit.
	if (!entry.correlationId || !entry.outputS3Key || !entry.bucketName || !entry.region) {
		logger?.info('[remotion-lambda] Render %s still preprocessing (awaiting Lambda submission)', renderId);
		return { id: renderId, status: 'rendering' };
	}

	// Step 1: Check webhook store first — this is the fast-and-rich path that
	// gives us error details immediately if the render fails.
	try {
		const { getWebhookResult } = await import('./webhook-store');
		const webhookResult = getWebhookResult(entry.correlationId);
		if (webhookResult) {
			if (webhookResult.type === 'success') {
				entry.status = 'done';
				entry.outputUrl = webhookResult.outputUrl;
				entry.lambdaRenderId = webhookResult.renderId;
				logger?.info('[remotion-lambda] Render %s complete via webhook: %s', renderId, webhookResult.outputUrl);
				void logRenderDone(renderId, webhookResult.outputUrl);
				return { id: renderId, status: 'done', url: webhookResult.outputUrl };
			}
			if (webhookResult.type === 'error') {
				const errorMsg = webhookResult.errors?.[0]?.message || 'Lambda render failed';
				entry.status = 'failed';
				entry.error = errorMsg;
				entry.lambdaRenderId = webhookResult.renderId;
				logger?.error?.('[remotion-lambda] Render %s failed via webhook: %s', renderId, errorMsg);
				void logRenderFailed(renderId, errorMsg);
				return { id: renderId, status: 'failed', error: errorMsg };
			}
			if (webhookResult.type === 'timeout') {
				const errorMsg = 'Lambda render timed out';
				entry.status = 'failed';
				entry.error = errorMsg;
				entry.lambdaRenderId = webhookResult.renderId;
				void logRenderFailed(renderId, errorMsg);
				return { id: renderId, status: 'failed', error: errorMsg };
			}
		}
	} catch (err) {
		logger?.warn?.('[remotion-lambda] Webhook store check failed: %s',
			err instanceof Error ? err.message : String(err));
	}

	// Step 2: S3 HeadObject fallback — for the case where the webhook never
	// reached us (Railway restart, network issue, etc.). Existence of the object
	// at our known outName path means the render succeeded.
	try {
		const { S3Client, HeadObjectCommand } = await import('@aws-sdk/client-s3');
		const s3 = new S3Client({
			region: entry.region,
			credentials: {
				accessKeyId: process.env.REMOTION_AWS_ACCESS_KEY_ID!,
				secretAccessKey: process.env.REMOTION_AWS_SECRET_ACCESS_KEY!,
			},
		});
		try {
			const head = await s3.send(new HeadObjectCommand({
				Bucket: entry.bucketName,
				Key: entry.outputS3Key,
			}));
			// Reject 0-byte or tiny files — Lambda occasionally creates the key
			// before writing bytes, and a 0-byte "mp4" would break the frontend
			// player. Real renders are >100KB even for short clips.
			const sizeBytes = head.ContentLength || 0;
			if (sizeBytes < 1024) {
				logger?.warn?.('[remotion-lambda] S3 object exists but too small (%d bytes), treating as in-progress', sizeBytes);
			} else {
				const outputUrl = `https://${entry.bucketName}.s3.${entry.region}.amazonaws.com/${entry.outputS3Key}`;
				entry.status = 'done';
				entry.outputUrl = outputUrl;
				logger?.info('[remotion-lambda] Render %s complete via S3 fallback: %s (%d bytes)', renderId, outputUrl, sizeBytes);
				void logRenderDone(renderId, outputUrl);
				return { id: renderId, status: 'done', url: outputUrl };
			}
		} catch (err: any) {
			if (err.name !== 'NotFound' && err.$metadata?.httpStatusCode !== 404) {
				logger?.warn?.('[remotion-lambda] S3 HeadObject failed: %s', err.message);
			}
			// 404 = still rendering
		}
	} catch (err) {
		logger?.warn?.('[remotion-lambda] S3 fallback check failed: %s',
			err instanceof Error ? err.message : String(err));
	}

	// Neither signal has fired yet — still rendering.
	// Safety net: if we've been waiting > 15 min, declare timeout. Local tests
	// show 12-clip renders take ~5-8 min (preprocessing + 4 chunks + stitching),
	// so 15 min gives 2x headroom for network/cold-start variance.
	const ageMs = Date.now() - entry.createdAt;
	if (ageMs > 15 * 60 * 1000) {
		const errorMsg = `Lambda render timed out after ${Math.round(ageMs / 1000)}s with no webhook or output file`;
		entry.status = 'failed';
		entry.error = errorMsg;
		logger?.error?.('[remotion-lambda] Render %s safety-net timeout: %s', renderId, errorMsg);
		void logRenderFailed(renderId, errorMsg);
		return { id: renderId, status: 'failed', error: errorMsg };
	}

	return { id: renderId, status: 'rendering' };
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
