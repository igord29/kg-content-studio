#!/usr/bin/env bun
/**
 * Add Lambda Preprocessor Permissions
 *
 * Run this with AWS admin/root credentials to grant remotion-user
 * the necessary Lambda permissions for the preprocessor function.
 *
 * Usage:
 *   AWS_ACCESS_KEY_ID=<admin-key> AWS_SECRET_ACCESS_KEY=<admin-secret> bun scripts/add-preprocessor-permissions.ts
 *
 * Or: log into AWS Console → IAM → Users → remotion-user → Add Inline Policy
 * with the JSON policy printed at the bottom of this script.
 */

import { config } from 'dotenv';

config();

const USER_NAME = 'remotion-user';
const POLICY_NAME = 'lambda-preprocessor-management';
const FUNCTION_NAME = 'clc-video-preprocessor';
const ACCOUNT_ID = '894261761826';

// The policy we need to attach
const policyDocument = {
	Version: '2012-10-17',
	Statement: [
		{
			Sid: 'ManagePreprocessorLambda',
			Effect: 'Allow',
			Action: [
				'lambda:GetFunction',
				'lambda:CreateFunction',
				'lambda:UpdateFunctionCode',
				'lambda:UpdateFunctionConfiguration',
				'lambda:InvokeFunction',
				'lambda:GetFunctionConfiguration',
			],
			Resource: [
				`arn:aws:lambda:*:${ACCOUNT_ID}:function:${FUNCTION_NAME}`,
			],
		},
		{
			Sid: 'PassRoleForLambda',
			Effect: 'Allow',
			Action: ['iam:PassRole'],
			Resource: [`arn:aws:iam::${ACCOUNT_ID}:role/remotion-lambda-role`],
			Condition: {
				StringEquals: {
					'iam:PassedToService': 'lambda.amazonaws.com',
				},
			},
		},
	],
};

async function main() {
	// Try using explicit admin credentials from env, or fall back to .env credentials
	const accessKeyId = process.env.AWS_ACCESS_KEY_ID || process.env.REMOTION_AWS_ACCESS_KEY_ID;
	const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.REMOTION_AWS_SECRET_ACCESS_KEY;

	if (!accessKeyId || !secretAccessKey) {
		console.error('ERROR: AWS credentials required.');
		console.error('Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for an admin user.');
		process.exit(1);
	}

	const { IAMClient, PutUserPolicyCommand } = await import('@aws-sdk/client-iam');

	const iam = new IAMClient({
		region: 'us-east-1',
		credentials: { accessKeyId, secretAccessKey },
	});

	try {
		// Step 1: Add user policy for managing the preprocessor Lambda
		await iam.send(new PutUserPolicyCommand({
			UserName: USER_NAME,
			PolicyName: POLICY_NAME,
			PolicyDocument: JSON.stringify(policyDocument),
		}));

		console.log('✓ Added inline policy "%s" to user "%s"', POLICY_NAME, USER_NAME);

		// Step 2: Update the Lambda execution role policy to include preprocessor logs
		const { PutRolePolicyCommand, GetRolePolicyCommand } = await import('@aws-sdk/client-iam');

		// Get existing execution policy
		let existingPolicy: any;
		try {
			const existing = await iam.send(new GetRolePolicyCommand({
				RoleName: 'remotion-lambda-role',
				PolicyName: 'remotion-lambda-execution',
			}));
			existingPolicy = JSON.parse(decodeURIComponent(existing.PolicyDocument!));
		} catch {
			existingPolicy = null;
		}

		if (existingPolicy) {
			// Add CloudWatch Logs permissions for the preprocessor function
			const logsStatement = existingPolicy.Statement?.find(
				(s: any) => s.Sid === '4' && s.Action?.includes('logs:CreateLogStream'),
			);
			if (logsStatement) {
				const preprocessorLogGroup = `arn:aws:logs:*:${ACCOUNT_ID}:log-group:/aws/lambda/${FUNCTION_NAME}:*`;
				if (!logsStatement.Resource.includes(preprocessorLogGroup)) {
					logsStatement.Resource.push(preprocessorLogGroup);
				}
			}

			// Also ensure lambda:InvokeFunction covers the preprocessor (for Remotion Lambda to invoke it if needed)
			const invokeStatement = existingPolicy.Statement?.find(
				(s: any) => s.Sid === '2' && s.Action?.includes('lambda:InvokeFunction'),
			);
			if (invokeStatement) {
				const preprocessorArn = `arn:aws:lambda:*:${ACCOUNT_ID}:function:${FUNCTION_NAME}`;
				if (!invokeStatement.Resource.includes(preprocessorArn)) {
					invokeStatement.Resource.push(preprocessorArn);
				}
			}

			await iam.send(new PutRolePolicyCommand({
				RoleName: 'remotion-lambda-role',
				PolicyName: 'remotion-lambda-execution',
				PolicyDocument: JSON.stringify(existingPolicy),
			}));

			console.log('✓ Updated remotion-lambda-role execution policy (added preprocessor logs + invoke)');
		}

		console.log('');
		console.log('Now run: bun scripts/deploy-preprocessor-lambda.ts');
	} catch (err: any) {
		if (err.message?.includes('not authorized')) {
			console.error('');
			console.error('ERROR: The provided credentials cannot modify IAM policies.');
			console.error('You need admin credentials. Options:');
			console.error('');
			console.error('Option 1: Run this script with admin credentials:');
			console.error('  AWS_ACCESS_KEY_ID=<admin> AWS_SECRET_ACCESS_KEY=<admin-secret> bun scripts/add-preprocessor-permissions.ts');
			console.error('');
			console.error('Option 2: Add the policies manually in AWS Console:');
			console.error('');
			console.error('  STEP A: Add user policy for Lambda management');
			console.error('  1. Go to AWS Console → IAM → Users → remotion-user');
			console.error('  2. Click "Add permissions" → "Create inline policy"');
			console.error('  3. Switch to JSON tab and paste:');
			console.error('');
			console.error(JSON.stringify(policyDocument, null, 2));
			console.error('');
			console.error('  4. Name the policy: %s', POLICY_NAME);
			console.error('  5. Click "Create policy"');
			console.error('');
			console.error('  STEP B: Update Lambda execution role (for CloudWatch logs)');
			console.error('  1. Go to AWS Console → IAM → Roles → remotion-lambda-role');
			console.error('  2. Click on "remotion-lambda-execution" policy → Edit');
			console.error('  3. In the logs:CreateLogStream statement (Sid "4"), add these Resources:');
			console.error(`     - arn:aws:logs:*:${ACCOUNT_ID}:log-group:/aws/lambda/${FUNCTION_NAME}:*`);
			console.error('');
			console.error('Then run: bun scripts/deploy-preprocessor-lambda.ts');
		} else {
			throw err;
		}
	}
}

main().catch((err) => {
	console.error('Failed:', err.message || err);
	process.exit(1);
});
