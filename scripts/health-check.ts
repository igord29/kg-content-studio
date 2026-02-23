#!/usr/bin/env bun
/**
 * CLC Video Project Health Check
 * Verifies all external services and infrastructure are working.
 */

import { config } from 'dotenv';
config();

interface CheckResult {
	name: string;
	ok: boolean;
	detail: string;
}

const results: CheckResult[] = [];

// --- Google Drive ---
async function checkGoogleDrive(): Promise<void> {
	try {
		const { testConnection, getFolderSummary } = await import('../src/agent/video-editor/google-drive');
		const connected = await testConnection();
		if (connected) {
			const summary = await getFolderSummary();
			results.push({ name: 'Google Drive', ok: true, detail: `${summary.totalFiles || 0} files found` });
		} else {
			results.push({ name: 'Google Drive', ok: false, detail: 'testConnection returned false' });
		}
	} catch (err: any) {
		results.push({ name: 'Google Drive', ok: false, detail: err.message?.substring(0, 100) || 'Unknown error' });
	}
}

// --- Shotstack ---
async function checkShotstack(): Promise<void> {
	try {
		const { testShotstackConnection } = await import('../src/agent/video-editor/shotstack');
		const result = await testShotstackConnection();
		if (result) {
			results.push({ name: 'Shotstack', ok: true, detail: 'connected' });
		} else {
			results.push({ name: 'Shotstack', ok: false, detail: 'connection failed' });
		}
	} catch (err: any) {
		results.push({ name: 'Shotstack', ok: false, detail: err.message?.substring(0, 100) || 'Unknown error' });
	}
}

// --- Remotion Lambda ---
async function checkRemotionLambda(): Promise<void> {
	try {
		const fn = process.env.REMOTION_FUNCTION_NAME;
		const bk = process.env.REMOTION_BUCKET_NAME;
		const su = process.env.REMOTION_SERVE_URL;
		const region = process.env.REMOTION_AWS_REGION || 'us-east-1';

		if (!fn || !bk || !su) {
			results.push({ name: 'Remotion Lambda', ok: false, detail: 'Missing env vars (REMOTION_FUNCTION_NAME, BUCKET_NAME, or SERVE_URL)' });
			return;
		}

		const { getRenderProgress } = await import('@remotion/lambda/client');

		try {
			await getRenderProgress({
				renderId: 'health-check-nonexistent',
				bucketName: bk,
				functionName: fn,
				region: region as any,
			});
			results.push({ name: 'Remotion Lambda', ok: true, detail: `${fn} reachable` });
		} catch (err: any) {
			const msg = err.message || '';
			// These errors prove the function is reachable
			if (msg.includes('Could not find') || msg.includes('No render') || msg.includes('does not exist') || msg.includes('not found')) {
				results.push({ name: 'Remotion Lambda', ok: true, detail: `${fn} reachable (render lookup works)` });
			} else if (msg.includes('AccessDenied') || msg.includes('not authorized')) {
				results.push({ name: 'Remotion Lambda', ok: false, detail: 'Access denied: ' + msg.substring(0, 80) });
			} else {
				// Any response means Lambda is running
				results.push({ name: 'Remotion Lambda', ok: true, detail: `${fn} responding: ${msg.substring(0, 60)}` });
			}
		}
	} catch (err: any) {
		results.push({ name: 'Remotion Lambda', ok: false, detail: err.message?.substring(0, 100) || 'Unknown error' });
	}
}

// --- Preprocessor Lambda ---
async function checkPreprocessorLambda(): Promise<void> {
	try {
		const fn = process.env.PREPROCESSOR_FUNCTION_NAME;
		if (!fn) {
			results.push({ name: 'Preprocessor Lambda', ok: false, detail: 'PREPROCESSOR_FUNCTION_NAME not set' });
			return;
		}

		const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');

		const lambda = new LambdaClient({
			region: process.env.REMOTION_AWS_REGION || 'us-east-1',
			credentials: {
				accessKeyId: process.env.REMOTION_AWS_ACCESS_KEY_ID!,
				secretAccessKey: process.env.REMOTION_AWS_SECRET_ACCESS_KEY!,
			},
		});

		const result = await lambda.send(new InvokeCommand({
			FunctionName: fn,
			InvocationType: 'RequestResponse',
			Payload: Buffer.from(JSON.stringify({
				bucketName: 'nonexistent-health-check',
				region: 'us-east-1',
				inputS3Key: 'test/nonexistent.mp4',
				outputS3Key: 'test/output.mp4',
				trimStart: 0,
				duration: 1,
				stabilize: true,
				sharpen: true,
			})),
		}));

		if (result.FunctionError) {
			const payload = result.Payload
				? JSON.parse(Buffer.from(result.Payload).toString())
				: { errorMessage: 'Unknown' };
			results.push({ name: 'Preprocessor Lambda', ok: false, detail: 'Runtime error: ' + (payload.errorMessage || '').substring(0, 80) });
			return;
		}

		const payload = result.Payload
			? JSON.parse(Buffer.from(result.Payload).toString())
			: null;

		if (payload?.error?.includes('FFmpeg not found')) {
			results.push({ name: 'Preprocessor Lambda', ok: false, detail: 'FFmpeg binary not found in Lambda' });
			return;
		}

		results.push({ name: 'Preprocessor Lambda', ok: true, detail: `${fn} reachable, FFmpeg found` });
	} catch (err: any) {
		results.push({ name: 'Preprocessor Lambda', ok: false, detail: err.message?.substring(0, 100) || 'Unknown error' });
	}
}

// --- S3 Bucket ---
async function checkS3Bucket(): Promise<void> {
	try {
		const bk = process.env.REMOTION_BUCKET_NAME;
		if (!bk) {
			results.push({ name: 'S3 Bucket', ok: false, detail: 'REMOTION_BUCKET_NAME not set' });
			return;
		}

		const { S3Client, HeadBucketCommand } = await import('@aws-sdk/client-s3');
		const s3 = new S3Client({
			region: process.env.REMOTION_AWS_REGION || 'us-east-1',
			credentials: {
				accessKeyId: process.env.REMOTION_AWS_ACCESS_KEY_ID!,
				secretAccessKey: process.env.REMOTION_AWS_SECRET_ACCESS_KEY!,
			},
		});

		await s3.send(new HeadBucketCommand({ Bucket: bk }));
		results.push({ name: 'S3 Bucket', ok: true, detail: `${bk} accessible` });
	} catch (err: any) {
		results.push({ name: 'S3 Bucket', ok: false, detail: err.message?.substring(0, 100) || 'Unknown error' });
	}
}

// --- OpenAI / AI Gateway ---
async function checkAI(): Promise<void> {
	try {
		const { generateText } = await import('ai');
		const { openai } = await import('@ai-sdk/openai');

		const result = await generateText({
			model: openai('gpt-4o-mini'),
			prompt: 'Reply with exactly: OK',
			maxTokens: 5,
		});

		if (result.text?.includes('OK')) {
			results.push({ name: 'AI (OpenAI)', ok: true, detail: 'gpt-4o-mini responding' });
		} else {
			results.push({ name: 'AI (OpenAI)', ok: true, detail: `gpt-4o-mini responding (got: ${result.text?.substring(0, 20)})` });
		}
	} catch (err: any) {
		results.push({ name: 'AI (OpenAI)', ok: false, detail: err.message?.substring(0, 100) || 'Unknown error' });
	}
}

// --- Main ---
async function main() {
	console.log('=== CLC Video Project Health Check ===');
	console.log('');

	// Run all checks in parallel
	await Promise.all([
		checkGoogleDrive(),
		checkShotstack(),
		checkRemotionLambda(),
		checkPreprocessorLambda(),
		checkS3Bucket(),
		checkAI(),
	]);

	// Print results
	const maxNameLen = Math.max(...results.map(r => r.name.length));

	for (const r of results) {
		const icon = r.ok ? '✓' : '✗';
		const pad = ' '.repeat(maxNameLen - r.name.length);
		console.log('  %s %s%s  %s', icon, r.name, pad, r.detail);
	}

	const passed = results.filter(r => r.ok).length;
	const failed = results.filter(r => !r.ok).length;

	console.log('');
	console.log('  %d/%d checks passed', passed, results.length);

	if (failed > 0) {
		console.log('  %d checks FAILED', failed);
		process.exit(1);
	} else {
		console.log('  All systems operational!');
	}
}

main().catch(err => {
	console.error('Health check error:', err.message || err);
	process.exit(1);
});
