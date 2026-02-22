#!/usr/bin/env bun
/**
 * One-time Remotion Lambda Setup Script
 *
 * Run this locally to deploy Lambda infrastructure to AWS:
 *   bun scripts/setup-remotion-lambda.ts
 *
 * This script:
 *   1. Creates/finds an S3 bucket for Remotion
 *   2. Deploys (or reuses) a Lambda function
 *   3. Deploys (or reuses) the composition site bundle to S3
 *   4. Prints env vars to add to .env and Agentuity cloud config
 *
 * The cloud app only needs the lightweight '@remotion/lambda/client' —
 * this script handles all the heavy deployment work locally.
 *
 * Required env vars (must be in .env):
 *   REMOTION_AWS_ACCESS_KEY_ID
 *   REMOTION_AWS_SECRET_ACCESS_KEY
 *   REMOTION_AWS_REGION (optional, defaults to us-east-1)
 */

import { config } from 'dotenv';
import { resolve } from 'path';

// Load .env
config();

const region = (process.env.REMOTION_AWS_REGION || 'us-east-1') as any;

console.log('=== Remotion Lambda Setup ===');
console.log(`Region: ${region}`);
console.log('');

async function main() {
	// Dynamically import @remotion/lambda (heavy — only used in this script)
	const {
		getOrCreateBucket,
		getFunctions,
		deployFunction,
		getSites,
		deploySite,
	} = await import('@remotion/lambda');

	// Step 1: S3 Bucket
	console.log('[1/3] Getting or creating S3 bucket...');
	const { bucketName } = await getOrCreateBucket({ region });
	console.log(`  Bucket: ${bucketName}`);

	// Step 2: Lambda Function
	console.log('[2/3] Checking for existing Lambda function...');
	const existingFunctions = await getFunctions({
		region,
		compatibleOnly: true,
	});

	let functionName: string;
	if (existingFunctions.length > 0) {
		functionName = existingFunctions[0]!.functionName;
		console.log(`  Reusing existing function: ${functionName}`);
	} else {
		console.log('  No compatible function found. Deploying new function...');
		const deployed = await deployFunction({
			region,
			timeoutInSeconds: 240,
			memorySizeInMb: 2048,
			diskSizeInMb: 2048,
			createCloudWatchLogGroup: true,
		});
		functionName = deployed.functionName;
		console.log(`  Deployed new function: ${functionName}`);
	}

	// Step 3: Site (composition bundle)
	console.log('[3/3] Checking for existing site...');
	const existingSites = await getSites({ region, bucketName });

	let serveUrl: string;
	if (existingSites.sites.length > 0) {
		serveUrl = existingSites.sites[0]!.serveUrl;
		console.log(`  Reusing existing site: ${serveUrl}`);
	} else {
		console.log('  No site found. Deploying composition bundle...');
		const entryPoint = resolve(
			process.cwd(),
			'src/agent/video-editor/remotion/entry.tsx',
		);
		console.log(`  Entry point: ${entryPoint}`);
		const site = await deploySite({
			entryPoint,
			bucketName,
			region,
			siteName: 'clc-video',
		});
		serveUrl = site.serveUrl;
		console.log(`  Deployed site: ${serveUrl}`);
	}

	// Print results
	console.log('');
	console.log('=== Setup Complete ===');
	console.log('');
	console.log('Add these to your .env file:');
	console.log('');
	console.log(`REMOTION_FUNCTION_NAME=${functionName}`);
	console.log(`REMOTION_SERVE_URL=${serveUrl}`);
	console.log(`REMOTION_BUCKET_NAME=${bucketName}`);
	console.log('');
	console.log('And set them in Agentuity cloud:');
	console.log('');
	console.log(`  bunx @agentuity/cli cloud env set REMOTION_FUNCTION_NAME "${functionName}"`);
	console.log(`  bunx @agentuity/cli cloud env set REMOTION_SERVE_URL "${serveUrl}"`);
	console.log(`  bunx @agentuity/cli cloud env set REMOTION_BUCKET_NAME "${bucketName}"`);
	console.log('');
}

main().catch((err) => {
	console.error('Setup failed:', err.message || err);
	process.exit(1);
});
