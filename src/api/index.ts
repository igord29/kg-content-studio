/**
 * API routes for agents
 */

import { createRouter, validator } from '@agentuity/runtime';
import { s } from '@agentuity/schema';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import translate, { AgentOutput, type HistoryEntry } from '../agent/translate';
import manager from '../agent/manager';
import contentCreator from '../agent/content-creator';
import videoEditor from '../agent/video-editor';
import grantWriter from '../agent/grant-writer';
import donorResearcher from '../agent/donor-researcher';
import venueProspector from '../agent/venue-prospector';
import { sendToMakeWebhook, getConfiguredWebhooks } from '../agent/content-creator/webhooks';
import { createDriveProxyToken, verifyDriveProxyToken } from '../agent/video-editor/drive-proxy';
import { uploadVideoFile } from '../agent/video-editor/google-drive';
import {
	type ClipUsageRecord,
	type VideoUsageSummary,
	createClipUsageRecord,
	buildUsageSummaryMap,
} from '../agent/video-editor/usage-tracker';

const api = createRouter();

// State subset for history endpoints (derived from AgentOutput)
export const StateSchema = AgentOutput.pick(['history', 'threadId', 'translationCount']);

// Translation agent
api.post('/translate', translate.validator(), async (c) => {
	const data = c.req.valid('json');
	return c.json(await translate.run(data));
});

// Retrieve translation history
api.get('/translate/history', validator({ output: StateSchema }), async (c) => {
	const history = (await c.var.thread.state.get<HistoryEntry[]>('history')) ?? [];
	return c.json({
		history,
		threadId: c.var.thread.id,
		translationCount: history.length,
	});
});

// Clear translation history
api.delete('/translate/history', validator({ output: StateSchema }), async (c) => {
	await c.var.thread.state.delete('history');
	return c.json({
		history: [],
		threadId: c.var.thread.id,
		translationCount: 0,
	});
});

// Refine question — generates one pointed follow-up question based on the brief
api.post('/refine-question', async (c) => {
	try {
		const { platform, briefData } = await c.req.json<{
			platform: string;
			briefData: Record<string, string>;
		}>();

		const briefSummary = Object.entries(briefData)
			.filter(([_, v]) => v?.trim())
			.map(([k, v]) => `${k}: ${v}`)
			.join('\n');

		const { text: question } = await generateText({
			model: openai('gpt-4o-mini'),
			prompt: `You are a creative director helping a nonprofit founder write a ${platform} post. She's given you this brief:

${briefSummary}

Your job: ask ONE pointed question that will surface a specific detail, real moment, or perspective that would make this content feel authentic and human — not generic.

Rules:
- Ask about something CONCRETE: a real moment she witnessed, a specific kid's reaction (no names), what the room looked like, what she was thinking at a particular point
- Don't ask "is there anything else?" — that's lazy
- Don't repeat what she already provided — push PAST it
- Keep it to 1-2 sentences
- Sound like a smart editor, not a chatbot
- If the brief is already rich with detail, ask about the emotional undercurrent or what she wants the reader to feel differently about after reading

Write ONLY the question. Nothing else.`,
		});

		return c.json({ question: question.trim() });
	} catch (err) {
		console.error('[refine-question] Error:', err instanceof Error ? err.message : err);
		return c.json({ question: null }, 500);
	}
});

// Manager agent
api.post('/manager', manager.validator(), async (c) => {
	const data = c.req.valid('json');
	return c.json(await manager.run(data));
});

// Content creator agent
api.post('/content-creator', contentCreator.validator(), async (c) => {
	const data = c.req.valid('json');
	return c.json(await contentCreator.run(data));
});

// Video editor agent
api.post('/video-editor', videoEditor.validator(), async (c) => {
	const data = c.req.valid('json');
	// Build the public-facing origin for Shotstack proxy URLs.
	// The internal c.req.url uses *.agentuity.run.internal which external services can't resolve.
	// Priority: x-forwarded-host header > Origin header > Referer header > fallback to req.url
	const fwdHost = c.req.header('x-forwarded-host');
	const fwdProto = c.req.header('x-forwarded-proto') || 'https';
	let origin: string;
	if (fwdHost) {
		origin = `${fwdProto}://${fwdHost}`;
	} else {
		const originHeader = c.req.header('origin');
		const referer = c.req.header('referer');
		if (originHeader) {
			origin = originHeader;
		} else if (referer) {
			origin = new URL(referer).origin;
		} else {
			origin = new URL(c.req.url).origin;
		}
	}
	// Load usage summary for freshness-aware edit plan generation
	let usageSummary: VideoUsageSummary[] = [];
	if (data.task === 'edit') {
		try {
			usageSummary = (await c.var.thread.state.get<VideoUsageSummary[]>('video-usage-summary')) ?? [];
		} catch { /* best-effort */ }
	}
	return c.json(await videoEditor.run({ ...data, appUrl: origin, usageSummary }));
});

// Remotion Lambda webhook — Remotion Lambda POSTs here on success/error/timeout.
// We correlate via customData.correlationId, verify HMAC sha512 signature, and
// write the result to the in-memory webhook store that the submit loop is polling.
// See: src/agent/video-editor/remotion/webhook-store.ts
api.post('/remotion-webhook', async (c) => {
	const rawBody = await c.req.text();

	// Verify HMAC signature if a secret is configured (matches Remotion's
	// invoke-webhook.js: `sha512=` + HMAC-SHA512(secret, body))
	const secret = process.env.REMOTION_WEBHOOK_SECRET;
	const receivedSig = c.req.header('x-remotion-signature') || '';
	if (secret && secret !== 'NO_SECRET_PROVIDED') {
		const crypto = await import('node:crypto');
		const expectedSig = 'sha512=' + crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
		try {
			const a = Buffer.from(expectedSig);
			const b = Buffer.from(receivedSig);
			if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
				return c.text('Invalid signature', 401);
			}
		} catch {
			return c.text('Invalid signature', 401);
		}
	}

	type WebhookPayload = {
		type: 'success' | 'error' | 'timeout';
		renderId: string;
		customData?: { correlationId?: string } | null;
		outputUrl?: string;
		timeToFinish?: number;
		errors?: Array<{ message: string; name: string; stack?: string }>;
	};
	let payload: WebhookPayload;
	try {
		payload = JSON.parse(rawBody) as WebhookPayload;
	} catch {
		return c.text('Invalid JSON', 400);
	}

	const correlationId = payload.customData?.correlationId;
	if (!correlationId) {
		return c.text('Missing customData.correlationId', 400);
	}

	const { setWebhookResult } = await import('../agent/video-editor/remotion/webhook-store');
	const receivedAt = Date.now();
	if (payload.type === 'success') {
		setWebhookResult(correlationId, {
			type: 'success',
			renderId: payload.renderId,
			outputUrl: payload.outputUrl || '',
			timeToFinish: payload.timeToFinish || 0,
			receivedAt,
		});
	} else if (payload.type === 'error') {
		setWebhookResult(correlationId, {
			type: 'error',
			renderId: payload.renderId,
			errors: payload.errors || [{ message: 'Unknown error', name: 'Unknown' }],
			receivedAt,
		});
	} else if (payload.type === 'timeout') {
		setWebhookResult(correlationId, {
			type: 'timeout',
			renderId: payload.renderId,
			receivedAt,
		});
	} else {
		return c.text('Unknown webhook type: ' + String((payload as { type: string }).type), 400);
	}

	return c.text('OK', 200);
});

// Debug endpoint: report what Remotion package versions are actually loaded
// at RUNTIME on Railway. Helps when version-pin-at-build-time passes but
// runtime still hits a version-mismatch error from Lambda.
api.get('/debug-remotion-version', async (c) => {
	const token = c.req.header('x-debug-token') || c.req.query('token');
	const expected = process.env.DEBUG_TOKEN;
	if (!expected || token !== expected) {
		return c.json({ error: 'Forbidden' }, 403);
	}
	const probes: Record<string, unknown> = {};
	for (const pkg of [
		'@remotion/lambda',
		'@remotion/lambda-client',
		'@remotion/serverless',
		'@remotion/serverless-client',
		'@remotion/streaming',
		'remotion',
	]) {
		try {
			const req = (await import('node:module')).createRequire(import.meta.url);
			const pkgJsonPath = req.resolve(`${pkg}/package.json`);
			const pkgJson = req(pkgJsonPath);
			probes[pkg] = { version: pkgJson.version, path: pkgJsonPath };
		} catch (err) {
			probes[pkg] = { error: err instanceof Error ? err.message : String(err) };
		}
	}
	return c.json({ probes, functionName: process.env.REMOTION_FUNCTION_NAME });
});

// Debug endpoint: invoke the render Lambda with a tiny dummy payload and
// return the exact sequence of stream events observed, so we can diagnose
// why submit appears to succeed but Lambda never actually runs on Railway.
//
// Gated by DEBUG_TOKEN env var so random traffic can't trigger a Lambda.
// Usage:  curl -X POST https://<app>/api/debug-lambda-submit -H "x-debug-token: <token>"
api.post('/debug-lambda-submit', async (c) => {
	const token = c.req.header('x-debug-token') || c.req.query('token');
	const expected = process.env.DEBUG_TOKEN;
	if (!expected || token !== expected) {
		return c.json({ error: 'Forbidden' }, 403);
	}

	const events: Array<Record<string, unknown>> = [];
	const log = (msg: string, extra?: Record<string, unknown>) => {
		events.push({ t: Date.now(), msg, ...(extra || {}) });
		console.log('[debug-lambda-submit]', msg, extra || '');
	};

	try {
		const { LambdaClient, InvokeWithResponseStreamCommand } = await import('@aws-sdk/client-lambda');
		const region = process.env.REMOTION_AWS_REGION || 'us-east-1';
		const functionName = process.env.REMOTION_FUNCTION_NAME;
		const bucketName = process.env.REMOTION_BUCKET_NAME;
		const serveUrl = process.env.REMOTION_SERVE_URL;

		if (!functionName || !bucketName || !serveUrl) {
			return c.json({ error: 'Missing REMOTION_* env vars' }, 500);
		}

		const lambdaClientMod: any = await import('@remotion/lambda-client');
		const { makeLambdaRenderMediaPayload, renderMediaOnLambdaOptionalToRequired } =
			lambdaClientMod.LambdaClientInternals;

		// Tiny 2-clip dummy payload pointing at an already-preprocessed mp4 in S3
		// (from previous test renders — these files still exist).
		const realVideoUrl = `https://${bucketName}.s3.${region}.amazonaws.com/temp-clips/render_1776757038634_24wl/1795MeSx_DsodS2TfH8X-HsQTGrhklLR5.mp4`;
		const correlationId = `debug-${Date.now()}`;
		const outputS3Key = `custom-renders/${correlationId}/out.mp4`;
		const inputProps = {
			clips: [
				{ src: realVideoUrl, length: 3 },
				{ src: realVideoUrl, length: 3 },
			],
			mode: 'game_day',
			width: 1080,
			height: 1920,
			fps: 30,
			transitionDurationFrames: 15,
			bgColor: '#000000',
			textOverlays: [],
			musicUrl: null,
		};

		const fullInput = renderMediaOnLambdaOptionalToRequired({
			region,
			functionName,
			serveUrl,
			composition: 'CLCVideo',
			codec: 'h264',
			inputProps,
			privacy: 'public',
			framesPerLambda: 180,
			timeoutInMilliseconds: 240_000,
			forceBucketName: bucketName,
			outName: { key: outputS3Key, bucketName },
			webhook: null,
		});

		log('built fullInput');
		const renderPayload = await makeLambdaRenderMediaPayload(fullInput);
		const payloadBytes = Buffer.from(JSON.stringify(renderPayload));
		log('built renderPayload', { payloadSize: payloadBytes.length });

		const lambda = new LambdaClient({
			region,
			credentials: {
				accessKeyId: process.env.REMOTION_AWS_ACCESS_KEY_ID!,
				secretAccessKey: process.env.REMOTION_AWS_SECRET_ACCESS_KEY!,
			},
		});

		log('calling InvokeWithResponseStream', { functionName, region });
		const t0 = Date.now();
		const streamResult = await lambda.send(
			new InvokeWithResponseStreamCommand({
				FunctionName: functionName,
				Payload: payloadBytes,
				InvocationType: 'RequestResponse',
			}),
		);

		log('lambda.send resolved', {
			ms: Date.now() - t0,
			StatusCode: streamResult.StatusCode,
			ResponseStreamContentType: streamResult.ResponseStreamContentType || null,
			hasEventStream: Boolean(streamResult.EventStream),
		});

		if (!streamResult.EventStream) {
			return c.json({ ok: false, reason: 'no-event-stream', events, correlationId, outputS3Key });
		}

		let eventIdx = 0;
		const eventDetails: Array<Record<string, unknown>> = [];
		const iterStart = Date.now();
		try {
			await (async () => {
				const timeout = new Promise<never>((_, reject) => {
					setTimeout(() => reject(new Error('iteration timeout 30s')), 30_000);
				});
				const iterate = (async () => {
					for await (const event of streamResult.EventStream!) {
						eventIdx++;
						const entry: Record<string, unknown> = {
							idx: eventIdx,
							ms: Date.now() - iterStart,
							keys: Object.keys(event || {}),
						};
						if (event.PayloadChunk?.Payload) {
							const text = new TextDecoder().decode(event.PayloadChunk.Payload);
							entry.payloadBytes = event.PayloadChunk.Payload.length;
							entry.payloadText = text.slice(0, 500);
						}
						if (event.InvokeComplete) {
							const ic: any = event.InvokeComplete;
							entry.invokeComplete = {
								ErrorCode: ic?.ErrorCode || null,
								ErrorDetails: (ic?.ErrorDetails || '').slice(0, 2000),
								LogResult: (ic?.LogResult || '').slice(0, 2000),
							};
						}
						eventDetails.push(entry);
						log(`event #${eventIdx}`, entry);
						if (eventIdx >= 5) break;  // enough diagnostics
					}
				})();
				await Promise.race([iterate, timeout]);
			})();
		} catch (iterErr) {
			const msg = iterErr instanceof Error ? iterErr.message : String(iterErr);
			log('iteration error', { err: msg });
		}

		return c.json({
			ok: true,
			correlationId,
			outputS3Key,
			lambdaResponse: {
				StatusCode: streamResult.StatusCode,
				ResponseStreamContentType: streamResult.ResponseStreamContentType || null,
				hasEventStream: Boolean(streamResult.EventStream),
			},
			eventCount: eventIdx,
			eventDetails,
			events,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const name = err instanceof Error ? err.name : 'Unknown';
		const stack = err instanceof Error ? err.stack : undefined;
		log('top-level error', { name, msg, stack: stack?.slice(0, 500) });
		return c.json({ ok: false, error: msg, name, events }, 500);
	}
});

// CORS headers for Drive proxy — required for Remotion Lambda (Chrome at localhost:3000)
const DRIVE_PROXY_CORS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
	'Access-Control-Allow-Headers': 'Range, Content-Type',
	'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
	'Access-Control-Max-Age': '86400',
};

// Google Drive file proxy — streams files for Shotstack & Remotion Lambda to consume
// Secured with HMAC token so only URLs generated by the render task work
api.get('/drive-file/:fileId', async (c) => {
	const fileId = c.req.param('fileId');
	const token = c.req.query('token');

	if (!fileId || !token) {
		return c.text('Missing file ID or token', 400);
	}

	if (!verifyDriveProxyToken(fileId, token)) {
		return c.text('Invalid token', 403);
	}

	try {
		const { getAuth } = await import('../agent/video-editor/google-drive');
		const { drive_v3 } = await import('@googleapis/drive');

		const authClient = getAuth();
		const drive = new drive_v3.Drive({ auth: authClient });

		// Get file metadata for Content-Type and size
		const meta = await drive.files.get({
			fileId,
			fields: 'mimeType,size,name',
		});

		const fileSize = meta.data.size ? parseInt(meta.data.size, 10) : 0;

		// Common headers for all responses (CORS + cache)
		const baseHeaders: Record<string, string> = {
			...DRIVE_PROXY_CORS,
			'Content-Type': meta.data.mimeType || 'video/mp4',
			'Cache-Control': 'public, max-age=3600',
			'Accept-Ranges': 'bytes',
		};
		if (meta.data.name) {
			baseHeaders['Content-Disposition'] = `inline; filename="${meta.data.name}"`;
		}

		// HEAD request — return metadata only (Remotion probes this)
		if (c.req.method === 'HEAD') {
			if (fileSize) baseHeaders['Content-Length'] = String(fileSize);
			return new Response(null, { status: 200, headers: baseHeaders });
		}

		// Stream the full file content from Google Drive
		const response = await drive.files.get(
			{ fileId, alt: 'media' },
			{ responseType: 'stream' },
		);

		if (fileSize) {
			baseHeaders['Content-Length'] = String(fileSize);
		}

		// Convert Node.js readable stream to Web ReadableStream for Response
		const nodeStream = response.data as NodeJS.ReadableStream;
		const { Readable } = await import('stream');
		const webStream = Readable.toWeb(Readable.from(nodeStream));

		return new Response(webStream as unknown as ReadableStream, {
			status: 200,
			headers: baseHeaders,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[drive-file proxy] Error streaming file %s: %s', fileId, msg);
		return c.text('Failed to stream file: ' + msg, 500);
	}
});

// Pre-processed file proxy — serves FFmpeg-enhanced clips from .temp-cataloger/
// Same HMAC token approach as drive-file, but for locally pre-processed files
api.get('/processed-file/:processedId', async (c) => {
	const processedId = c.req.param('processedId');
	const token = c.req.query('token');

	if (!processedId || !token) {
		return c.text('Missing processed ID or token', 400);
	}

	if (!verifyDriveProxyToken(processedId, token)) {
		return c.text('Invalid token', 403);
	}

	try {
		const fs = await import('fs');
		const path = await import('path');

		// Security: only serve from the .temp-cataloger/ directory
		const tempDir = path.resolve(process.cwd(), '.temp-cataloger');
		const filePath = path.join(tempDir, `processed_${processedId}.mp4`);
		const resolvedPath = path.resolve(filePath);

		if (!resolvedPath.toLowerCase().startsWith(tempDir.toLowerCase())) {
			return c.text('Access denied', 403);
		}

		if (!fs.existsSync(resolvedPath)) {
			return c.text('Processed file not found', 404);
		}

		const stat = fs.statSync(resolvedPath);
		const stream = fs.createReadStream(resolvedPath);
		const { Readable } = await import('stream');
		const webStream = Readable.toWeb(stream as any);

		return new Response(webStream as unknown as ReadableStream, {
			status: 200,
			headers: {
				...DRIVE_PROXY_CORS,
				'Content-Type': 'video/mp4',
				'Content-Length': String(stat.size),
				'Accept-Ranges': 'bytes',
				'Cache-Control': 'public, max-age=3600',
				'Content-Disposition': `inline; filename="processed_${processedId}.mp4"`,
			},
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[processed-file proxy] Error streaming file %s: %s', processedId, msg);
		return c.text('Failed to stream processed file: ' + msg, 500);
	}
});

// Remotion render download — redirects to S3 URL for Lambda-rendered videos
// Keyed by render ID (format: remotion_<timestamp>_<random>)
api.get('/remotion-render/:renderId', async (c) => {
	const renderId = c.req.param('renderId');

	if (!renderId || !renderId.startsWith('remotion_')) {
		return c.text('Invalid render ID', 400);
	}

	try {
		const { checkRemotionStatus } = await import('../agent/video-editor/remotion/render');
		const status = await checkRemotionStatus(renderId);

		if (status.status === 'done' && status.url) {
			// Redirect to S3 public URL — browser follows redirect and downloads
			return c.redirect(status.url, 302);
		}

		if (status.status === 'failed') {
			return c.text('Render failed: ' + (status.error || 'Unknown error'), 500);
		}

		return c.text('Render not yet complete (status: ' + status.status + ')', 202);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[remotion-render] Error checking render %s: %s', renderId, msg);
		return c.text('Failed: ' + msg, 500);
	}
});

// Grant writer agent
api.post('/grant-writer', grantWriter.validator(), async (c) => {
	const data = c.req.valid('json');
	return c.json(await grantWriter.run(data));
});

// Donor researcher agent
api.post('/donor-researcher', donorResearcher.validator(), async (c) => {
	const data = c.req.valid('json');
	return c.json(await donorResearcher.run(data));
});

// Venue prospector agent
api.post('/venue-prospector', venueProspector.validator(), async (c) => {
	const data = c.req.valid('json');
	return c.json(await venueProspector.run(data));
});

// Webhook: Send content to Make.com
export const WebhookInput = s.object({
	platform: s.string(),
	content: s.string(),
	imageUrl: s.string().optional(),
	imageStyle: s.string().optional(),
	scheduledTime: s.string().optional(),
});

api.post('/webhook/publish', validator({ input: WebhookInput }), async (c) => {
	const { platform, content, imageUrl, imageStyle, scheduledTime } = c.req.valid('json');
	const result = await sendToMakeWebhook(platform, content, imageUrl, imageStyle, scheduledTime);
	return c.json(result);
});

// Get configured webhooks
api.get('/webhook/config', async (c) => {
	const configured = getConfiguredWebhooks();
	return c.json({ configuredPlatforms: configured });
});

// --- Content Library (Supabase-backed) ---

// Get all saved text content
api.get('/content-library', async (c) => {
	const { supabaseAdmin } = await import('../lib/supabase');
	const platform = c.req.query('platform');
	const limit = parseInt(c.req.query('limit') || '100');

	let query = supabaseAdmin
		.from('generated_content')
		.select('*')
		.order('created_at', { ascending: false })
		.limit(limit);

	if (platform) query = query.eq('platform', platform);

	const { data, error } = await query;
	if (error) return c.json({ entries: [], count: 0, error: error.message }, 500);

	// Map to the shape ContentLibrary.tsx expects
	const entries = (data || []).map((row: any) => ({
		id: row.id,
		createdAt: row.created_at,
		platform: row.platform,
		content: row.content,
		topic: row.topic || '',
		contentType: row.content_type,
		wordCount: row.word_count,
		images: row.image_urls?.length > 0
			? row.image_urls.map((url: string, i: number) => ({
				styleId: row.image_styles?.[i] || `style-${i}`,
				styleName: row.image_styles?.[i] || 'Unknown',
				thumbnail: url,
				imagePrompt: row.image_prompts?.[i] || '',
			}))
			: undefined,
	}));

	return c.json({ entries, count: entries.length });
});

// Delete a content entry + clean up storage images
api.delete('/content-library/:id', async (c) => {
	const { supabaseAdmin } = await import('../lib/supabase');
	const id = c.req.param('id');

	// Get image URLs to clean up storage
	const { data: entry } = await supabaseAdmin
		.from('generated_content')
		.select('image_urls')
		.eq('id', id)
		.single();

	if (entry?.image_urls?.length) {
		for (const url of entry.image_urls) {
			const pathMatch = url.split('/generated-images/')[1];
			if (pathMatch) {
				await supabaseAdmin.storage.from('generated-images').remove([pathMatch]);
			}
		}
	}

	const { error } = await supabaseAdmin
		.from('generated_content')
		.delete()
		.eq('id', id);

	if (error) return c.json({ success: false, error: error.message }, 500);
	return c.json({ success: true });
});

// --- Content Feedback ---

// Submit feedback (like/dislike + optional notes)
api.post('/content-feedback', async (c) => {
	const { supabaseAdmin } = await import('../lib/supabase');
	const body = await c.req.json();

	if (!body || !body.rating || !['positive', 'negative'].includes(body.rating)) {
		return c.json({ success: false, error: 'rating must be "positive" or "negative"' }, 400);
	}

	const { data, error } = await supabaseAdmin
		.from('content_feedback')
		.insert({
			content_id: body.contentId || null,
			rating: body.rating,
			notes: body.notes || null,
			platform: body.platform || null,
			content_type: body.contentType || null,
			content_snippet: body.contentSnippet || null,
		})
		.select('id')
		.single();

	if (error) return c.json({ success: false, error: error.message }, 500);
	return c.json({ success: true, id: data.id });
});

// Get all feedback entries
api.get('/content-feedback', async (c) => {
	const { supabaseAdmin } = await import('../lib/supabase');
	const limit = parseInt(c.req.query('limit') || '50');

	const { data, error } = await supabaseAdmin
		.from('content_feedback')
		.select('*')
		.order('created_at', { ascending: false })
		.limit(limit);

	if (error) return c.json({ entries: [], count: 0, error: error.message }, 500);
	return c.json({ entries: data || [], count: data?.length || 0 });
});

// --- Video Library (Supabase-backed) ---

// Get all saved video renders
api.get('/video-library', async (c) => {
	const { supabaseAdmin } = await import('../lib/supabase');
	const platform = c.req.query('platform');
	const minScore = c.req.query('minScore');
	const limit = parseInt(c.req.query('limit') || '100');

	let query = supabaseAdmin
		.from('finished_videos')
		.select('*')
		.order('created_at', { ascending: false })
		.limit(limit);

	if (platform) query = query.eq('platform', platform);
	if (minScore) query = query.gte('score', parseInt(minScore));

	const { data, error } = await query;
	if (error) return c.json({ entries: [], count: 0, error: error.message }, 500);

	return c.json({ entries: data || [], count: data?.length || 0 });
});

// Search video library (full-text search on title + tags)
api.get('/video-library/search', async (c) => {
	const { supabaseAdmin } = await import('../lib/supabase');
	const q = c.req.query('q') || '';
	if (!q.trim()) {
		return c.json({ entries: [], count: 0 });
	}

	// Sanitize query to prevent PostgREST filter injection
	const safeQ = q.replace(/[{},\\]/g, '');
	const { data, error } = await supabaseAdmin
		.from('finished_videos')
		.select('*')
		.or(`title.ilike.%${safeQ}%,tags.cs.{${safeQ.toLowerCase()}}`)
		.order('created_at', { ascending: false })
		.limit(50);

	if (error) return c.json({ entries: [], count: 0, error: error.message }, 500);
	return c.json({ entries: data || [], count: data?.length || 0 });
});

// Save a new video render entry
api.post('/video-library', async (c) => {
	const { supabaseAdmin } = await import('../lib/supabase');
	const entry = await c.req.json();

	if (!entry || !entry.title) {
		return c.json({ success: false, error: 'title is required' }, 400);
	}

	const { data, error } = await supabaseAdmin
		.from('finished_videos')
		.insert({
			title: entry.title,
			platform: entry.platform || 'tiktok',
			edit_mode: entry.edit_mode || entry.renderMode || 'game_day',
			storage_path: entry.storage_path || '',
			public_url: entry.public_url || entry.downloadUrl || '',
			duration_sec: entry.duration_sec,
			score: entry.score,
			review_notes: entry.review_notes,
			tags: entry.tags || [],
			source_video_ids: entry.source_video_ids || [],
			render_id: entry.render_id || entry.renderId,
		})
		.select('id')
		.single();

	if (error) return c.json({ success: false, error: error.message }, 500);
	return c.json({ success: true, id: data.id });
});

// Delete a specific video library entry
api.delete('/video-library/:id', async (c) => {
	const { supabaseAdmin } = await import('../lib/supabase');
	const id = c.req.param('id');

	// First get the storage path to clean up the file
	const { data: entry } = await supabaseAdmin
		.from('finished_videos')
		.select('storage_path')
		.eq('id', id)
		.single();

	// Delete from storage if path exists
	if (entry?.storage_path) {
		await supabaseAdmin.storage.from('finished-videos').remove([entry.storage_path]);
	}

	const { error } = await supabaseAdmin
		.from('finished_videos')
		.delete()
		.eq('id', id);

	if (error) return c.json({ success: false, error: error.message }, 500);
	return c.json({ success: true });
});

// --- Upload Video (Quick Edit) ---

// Upload a video file directly to Google Drive for instant editing
api.post('/upload-video', async (c) => {
	try {
		const formData = await c.req.formData();
		const file = formData.get('video');

		if (!file || !(file instanceof File)) {
			return c.json({ success: false, error: 'No video file provided' }, 400);
		}

		const buffer = Buffer.from(await file.arrayBuffer());
		const filename = file.name || `upload_${Date.now()}.mp4`;

		const result = await uploadVideoFile(buffer, filename);

		return c.json({
			success: true,
			fileId: result.fileId,
			filename: result.filename,
			webViewLink: result.webViewLink,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[upload-video] Error: %s', msg);
		return c.json({ success: false, error: 'Upload failed: ' + msg }, 500);
	}
});

// --- Upload Video to Supabase Storage (for auto-pipeline) ---

api.post('/upload-video-supabase', async (c) => {
	try {
		const formData = await c.req.formData();
		const file = formData.get('video');
		const platform = (formData.get('platform') as string) || 'tiktok';
		const editMode = (formData.get('editMode') as string) || 'game_day';
		const topic = (formData.get('topic') as string) || '';

		if (!file || !(file instanceof File)) {
			return c.json({ success: false, error: 'No video file provided' }, 400);
		}

		const buffer = Buffer.from(await file.arrayBuffer());
		const filename = file.name || `upload_${Date.now()}.mp4`;

		// Upload to Supabase Storage (raw-videos bucket)
		const { supabaseAdmin } = await import('../lib/supabase');
		const now = new Date();
		const storagePath = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${Date.now()}_${filename}`;

		const { error: uploadError } = await supabaseAdmin.storage
			.from('raw-videos')
			.upload(storagePath, buffer, {
				contentType: file.type || 'video/mp4',
				upsert: true,
			});

		if (uploadError) {
			return c.json({ success: false, error: `Storage upload failed: ${uploadError.message}` }, 500);
		}

		const { data: urlData } = supabaseAdmin.storage
			.from('raw-videos')
			.getPublicUrl(storagePath);

		// Also save to raw_uploads table
		const { data: row, error: dbError } = await supabaseAdmin
			.from('raw_uploads')
			.insert({
				original_filename: filename,
				storage_path: storagePath,
				public_url: urlData.publicUrl,
				status: 'uploaded',
			})
			.select('id')
			.single();

		if (dbError) {
			console.error('[upload-video-supabase] DB insert error: %s', dbError.message);
		}

		// Also upload to Google Drive so the auto-pipeline can use it with the existing catalog system
		let driveFileId: string | undefined;
		try {
			const driveResult = await uploadVideoFile(buffer, filename);
			driveFileId = driveResult.fileId;
		} catch (err) {
			console.error('[upload-video-supabase] Drive upload failed (non-fatal): %s', err instanceof Error ? err.message : err);
		}

		return c.json({
			success: true,
			supabaseId: row?.id,
			storagePath,
			publicUrl: urlData.publicUrl,
			driveFileId,
			filename,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[upload-video-supabase] Error: %s', msg);
		return c.json({ success: false, error: 'Upload failed: ' + msg }, 500);
	}
});

// --- Clip Usage Tracking ---

// Get all video usage summaries (for frontend freshness display)
api.get('/clip-usage', async (c) => {
	const summary = (await c.var.thread.state.get<VideoUsageSummary[]>('video-usage-summary')) ?? [];
	return c.json({ entries: summary, count: summary.length });
});

// Get detailed usage for a specific video
api.get('/clip-usage/:fileId', async (c) => {
	const fileId = c.req.param('fileId');
	const allUsage = (await c.var.thread.state.get<ClipUsageRecord[]>('clip-usage')) ?? [];
	const videoUsage = allUsage.filter((r) => r.fileId === fileId);
	const summary = (await c.var.thread.state.get<VideoUsageSummary[]>('video-usage-summary')) ?? [];
	const videoSummary = summary.find((s) => s.fileId === fileId);
	return c.json({ fileId, records: videoUsage, summary: videoSummary || null });
});

// Record clip usage after a render completes
api.post('/clip-usage', async (c) => {
	const body = await c.req.json();

	if (!body || !body.clips || !Array.isArray(body.clips) || body.clips.length === 0) {
		return c.json({ success: false, error: 'Missing or empty clips array' }, 400);
	}

	// Create usage records for each clip
	const records: ClipUsageRecord[] = body.clips.map((clip: any) =>
		createClipUsageRecord(clip, {
			renderId: body.renderId || `render_${Date.now()}`,
			renderDate: body.renderDate,
			editMode: body.editMode,
			platform: body.platform,
		}),
	);

	// Push each record to clip-usage (capped at 500)
	for (const record of records) {
		await c.var.thread.state.push('clip-usage', record, 500);
	}

	// Rebuild video-usage-summary from all records
	const allUsage = (await c.var.thread.state.get<ClipUsageRecord[]>('clip-usage')) ?? [];
	const summaryMap = buildUsageSummaryMap(allUsage);
	await c.var.thread.state.set('video-usage-summary', Array.from(summaryMap.values()));

	return c.json({ success: true, recorded: records.length });
});

export default api;
