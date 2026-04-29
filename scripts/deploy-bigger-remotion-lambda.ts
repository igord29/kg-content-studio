#!/usr/bin/env bun
/**
 * Deploy a higher-capacity Remotion Lambda for 4K rendering.
 *
 * The default function from setup-remotion-lambda.ts is mem2048MB / 240sec —
 * fine for 1080p but too small for 4K (4× pixels needs ~3-4× memory and time).
 *
 * This deploys a parallel function: mem3008MB / disk10240MB / 900sec.
 * Both functions coexist; we point REMOTION_FUNCTION_NAME at the new one.
 *
 * After running:
 *   railway variables -s kg-content-studio --set REMOTION_FUNCTION_NAME=<new-name>
 */
import { config } from 'dotenv';
config();

const region = (process.env.REMOTION_AWS_REGION || 'us-east-1') as string;

const { deployFunction } = await import('@remotion/lambda');

console.log('Deploying 4K-capable Lambda function...');
console.log(`  Region:   ${region}`);
console.log(`  Memory:   3008 MB`);
console.log(`  Disk:     10240 MB`);
console.log(`  Timeout:  900 sec`);

const result = await deployFunction({
	region: region as 'us-east-1',
	timeoutInSeconds: 900,
	memorySizeInMb: 3008,
	diskSizeInMb: 10240,
	createCloudWatchLogGroup: true,
});

console.log('');
console.log('=== Deployed ===');
console.log(`Function name: ${result.functionName}`);
console.log('');
console.log('Set on Railway:');
console.log(`  railway variables -s kg-content-studio --set REMOTION_FUNCTION_NAME=${result.functionName}`);
