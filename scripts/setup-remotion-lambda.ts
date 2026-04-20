#!/usr/bin/env bun
/**
 * One-time Remotion Lambda Setup Script
 *
 * Run this locally to deploy Lambda infrastructure to AWS:
 *   bun scripts/setup-remotion-lambda.ts
 *
 * This script:
 *   0. Creates the IAM execution role (remotion-lambda-role) if missing
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

/**
 * Create the remotion-lambda-role IAM role if it doesn't already exist.
 * This is the execution role that the Lambda function itself assumes.
 */
async function ensureLambdaRole() {
	const { IAMClient, GetRoleCommand, CreateRoleCommand, PutRolePolicyCommand } =
		await import('@aws-sdk/client-iam');

	const iam = new IAMClient({
		region,
		credentials: {
			accessKeyId: process.env.REMOTION_AWS_ACCESS_KEY_ID!,
			secretAccessKey: process.env.REMOTION_AWS_SECRET_ACCESS_KEY!,
		},
	});

	const roleName = 'remotion-lambda-role';

	// Check if role already exists
	try {
		await iam.send(new GetRoleCommand({ RoleName: roleName }));
		console.log(`  Role "${roleName}" already exists.`);
		return;
	} catch (err: any) {
		if (err.name !== 'NoSuchEntityException') {
			throw err;
		}
		// Role doesn't exist — create it
	}

	console.log(`  Creating role "${roleName}"...`);

	// Trust policy: allow Lambda service to assume this role
	const trustPolicy = JSON.stringify({
		Version: '2012-10-17',
		Statement: [
			{
				Effect: 'Allow',
				Principal: { Service: 'lambda.amazonaws.com' },
				Action: 'sts:AssumeRole',
			},
		],
	});

	await iam.send(
		new CreateRoleCommand({
			RoleName: roleName,
			AssumeRolePolicyDocument: trustPolicy,
			Description: 'Execution role for Remotion Lambda render functions',
		}),
	);

	// Attach the inline execution policy (what the Lambda function can do at runtime)
	const executionPolicy = JSON.stringify({
		Version: '2012-10-17',
		Statement: [
			{
				Sid: '0',
				Effect: 'Allow',
				Action: ['s3:ListAllMyBuckets'],
				Resource: ['*'],
			},
			{
				Sid: '1',
				Effect: 'Allow',
				Action: [
					's3:CreateBucket',
					's3:ListBucket',
					's3:PutBucketAcl',
					's3:GetObject',
					's3:DeleteObject',
					's3:PutObjectAcl',
					's3:PutObject',
					's3:GetBucketLocation',
				],
				Resource: ['arn:aws:s3:::remotionlambda-*'],
			},
			{
				Sid: '2',
				Effect: 'Allow',
				Action: ['lambda:InvokeFunction'],
				Resource: ['arn:aws:lambda:*:*:function:remotion-render-*'],
			},
			{
				Sid: '3',
				Effect: 'Allow',
				Action: ['logs:CreateLogGroup'],
				Resource: ['arn:aws:logs:*:*:log-group:/aws/lambda-insights'],
			},
			{
				Sid: '4',
				Effect: 'Allow',
				Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
				Resource: [
					'arn:aws:logs:*:*:log-group:/aws/lambda/remotion-render-*',
					'arn:aws:logs:*:*:log-group:/aws/lambda-insights:*',
				],
			},
		],
	});

	await iam.send(
		new PutRolePolicyCommand({
			RoleName: roleName,
			PolicyName: 'remotion-lambda-execution',
			PolicyDocument: executionPolicy,
		}),
	);

	console.log(`  Role "${roleName}" created with execution policy.`);

	// Wait for IAM propagation (roles can take a few seconds to become usable)
	console.log('  Waiting 10s for IAM role propagation...');
	await new Promise((resolve) => setTimeout(resolve, 10_000));
}

async function main() {
	// Dynamically import @remotion/lambda (heavy — only used in this script)
	const {
		getOrCreateBucket,
		getFunctions,
		deployFunction,
		getSites,
		deploySite,
	} = await import('@remotion/lambda');

	// Step 0: Ensure the Lambda execution role exists
	console.log('[0/4] Ensuring IAM execution role...');
	await ensureLambdaRole();

	// Step 1: S3 Bucket
	console.log('[1/4] Getting or creating S3 bucket...');
	const { bucketName } = await getOrCreateBucket({ region });
	console.log(`  Bucket: ${bucketName}`);

	// Step 2: Lambda Function
	console.log('[2/4] Checking for existing Lambda function...');
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
			timeoutInSeconds: 900,
			memorySizeInMb: 3008,
			diskSizeInMb: 10240,
			createCloudWatchLogGroup: true,
		});
		functionName = deployed.functionName;
		console.log(`  Deployed new function: ${functionName}`);
	}

	// Step 3: Site (composition bundle)
	// Always redeploy to ensure the site matches the current Remotion version
	console.log('[3/4] Deploying composition bundle (always redeploy for version consistency)...');
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
	const serveUrl = site.serveUrl;
	console.log(`  Deployed site: ${serveUrl}`);

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
