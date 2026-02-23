#!/usr/bin/env bun
/**
 * Deploy FFmpeg Preprocessor Lambda
 *
 * Run this locally to deploy the preprocessor Lambda to AWS:
 *   bun scripts/deploy-preprocessor-lambda.ts
 *
 * This script:
 *   1. Downloads a static FFmpeg binary for Linux x86_64 (from John Van Sickle)
 *   2. Writes the self-contained Lambda handler (index.js)
 *   3. Creates a zip with both: index.js + bin/ffmpeg
 *   4. Creates or updates the Lambda function using the existing remotion-lambda-role
 *   5. Runs a smoke test invocation
 *   6. Prints env vars to set
 *
 * The FFmpeg binary is bundled INSIDE the deployment package (~30MB zipped).
 * No separate Lambda Layer required. The handler finds it at ./bin/ffmpeg.
 *
 * Prerequisites:
 *   - REMOTION_AWS_ACCESS_KEY_ID and REMOTION_AWS_SECRET_ACCESS_KEY in .env
 *   - remotion-lambda-role IAM role exists (created by setup-remotion-lambda.ts)
 *
 * Lambda specs:
 *   - Runtime: nodejs20.x
 *   - Memory: 2048 MB (FFmpeg deshake is CPU-intensive)
 *   - Timeout: 300s (5 min)
 *   - Ephemeral storage: 2048 MB (raw + processed clips on /tmp)
 *   - Architecture: x86_64
 */

import { config } from 'dotenv';
import { resolve, join } from 'path';
import {
	existsSync, mkdirSync, writeFileSync, readFileSync,
	unlinkSync, chmodSync, rmSync, statSync, copyFileSync,
} from 'fs';
import { execSync } from 'child_process';

// Load .env
config();

const region = process.env.REMOTION_AWS_REGION || 'us-east-1';
const FUNCTION_NAME = 'clc-video-preprocessor';
const ROLE_NAME = 'remotion-lambda-role';

// Static FFmpeg binary URL — John Van Sickle's builds for Linux amd64
// These are self-contained static binaries that work on Amazon Linux 2023 (Lambda runtime)
const FFMPEG_URL = 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz';
// Cache the downloaded archive locally so re-deploys don't re-download
const FFMPEG_CACHE_DIR = resolve(process.cwd(), '.ffmpeg-cache');

const BUILD_DIR = resolve(process.cwd(), '.temp-lambda-build');

console.log('=== FFmpeg Preprocessor Lambda Deployment ===');
console.log(`Region: ${region}`);
console.log(`Function: ${FUNCTION_NAME}`);
console.log('');

// ─── IAM Role ───────────────────────────────────────────────────────────

async function getRoleArn(): Promise<string> {
	const { IAMClient, GetRoleCommand } = await import('@aws-sdk/client-iam');

	const iam = new IAMClient({
		region,
		credentials: {
			accessKeyId: process.env.REMOTION_AWS_ACCESS_KEY_ID!,
			secretAccessKey: process.env.REMOTION_AWS_SECRET_ACCESS_KEY!,
		},
	});

	const result = await iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }));
	if (!result.Role?.Arn) {
		throw new Error(`Role "${ROLE_NAME}" not found. Run setup-remotion-lambda.ts first.`);
	}
	return result.Role.Arn;
}

// ─── FFmpeg Binary ──────────────────────────────────────────────────────

/**
 * Download and extract the static FFmpeg binary for Linux x86_64.
 * Caches the download in .ffmpeg-cache/ for faster re-deploys.
 * Returns the path to the extracted ffmpeg binary.
 */
async function getFFmpegBinary(): Promise<string> {
	if (!existsSync(FFMPEG_CACHE_DIR)) {
		mkdirSync(FFMPEG_CACHE_DIR, { recursive: true });
	}

	const cachedBinary = join(FFMPEG_CACHE_DIR, 'ffmpeg');

	// Check cache first
	if (existsSync(cachedBinary)) {
		const size = statSync(cachedBinary).size;
		if (size > 10_000_000) { // > 10MB = probably valid
			console.log('  Using cached FFmpeg binary (%d MB)', (size / (1024 * 1024)).toFixed(0));
			return cachedBinary;
		}
		// Corrupted cache — re-download
		unlinkSync(cachedBinary);
	}

	console.log('  Downloading static FFmpeg from johnvansickle.com...');
	console.log('  URL: %s', FFMPEG_URL);
	console.log('  (This is a ~30MB download, cached for future deploys)');

	const archivePath = join(FFMPEG_CACHE_DIR, 'ffmpeg-release-amd64-static.tar.xz');

	// Download using fetch (Bun has built-in fetch)
	const response = await fetch(FFMPEG_URL);
	if (!response.ok) {
		throw new Error(`Failed to download FFmpeg: ${response.status} ${response.statusText}`);
	}

	const arrayBuffer = await response.arrayBuffer();
	writeFileSync(archivePath, Buffer.from(arrayBuffer));
	const archiveSize = (statSync(archivePath).size / (1024 * 1024)).toFixed(1);
	console.log('  Downloaded: %s MB', archiveSize);

	// Extract just the ffmpeg binary from the tar.xz archive
	console.log('  Extracting ffmpeg binary...');

	// The archive is .tar.xz containing: ffmpeg-X.X-amd64-static/ffmpeg
	// On Windows, tar can't handle C: paths (interprets colon as remote host).
	// Strategy: try multiple approaches.
	const isWindows = process.platform === 'win32';
	let extracted = false;

	if (isWindows) {
		// Windows approach: use node-tar or a two-step 7z extraction, or bun shell
		// Step 1: Try using bun shell (bun has built-in tar.xz support via shell)
		try {
			// Use PowerShell + tar in WSL-style, or just use 7z if available
			// First, try 7z (often available on Windows dev machines)
			try {
				// 7z can handle .tar.xz in two steps: extract .xz → .tar → files
				const tarPath = join(FFMPEG_CACHE_DIR, 'ffmpeg-release-amd64-static.tar');

				// Step 1: Decompress .xz → .tar
				execSync(`7z x -y -o"${FFMPEG_CACHE_DIR}" "${archivePath}"`, { stdio: 'pipe', timeout: 120000 });
				console.log('  Decompressed .xz via 7z');

				// Step 2: Extract ffmpeg binary from .tar
				if (existsSync(tarPath)) {
					execSync(`7z e -y -o"${FFMPEG_CACHE_DIR}" "${tarPath}" "*/ffmpeg" -r`, { stdio: 'pipe', timeout: 120000 });
					try { unlinkSync(tarPath); } catch { /* ok */ }
				}

				if (existsSync(cachedBinary)) {
					extracted = true;
					console.log('  Extracted ffmpeg binary via 7z');
				}
			} catch {
				console.log('  7z not available, trying alternative...');
			}

			// If 7z didn't work, try using Node.js streams with lzma-native or xz decompress
			if (!extracted) {
				// Use tar with a relative path from the cache dir to avoid C: issue
				// Windows tar works fine if we cd into the directory first and use relative paths
				const archiveFilename = 'ffmpeg-release-amd64-static.tar.xz';
				try {
					execSync(
						`tar -xf "${archiveFilename}" --strip-components=1`,
						{ stdio: 'pipe', cwd: FFMPEG_CACHE_DIR, timeout: 120000 },
					);
					extracted = existsSync(cachedBinary);
					if (extracted) {
						console.log('  Extracted via tar with relative path');
					}
				} catch {
					console.log('  tar with relative path failed, trying with forward slashes...');
				}
			}

			// Try converting to forward-slash path for tar
			if (!extracted) {
				const archiveUnix = archivePath.replace(/\\/g, '/');
				const cacheUnix = FFMPEG_CACHE_DIR.replace(/\\/g, '/');
				try {
					execSync(
						`tar -xf "${archiveUnix}" --strip-components=1 -C "${cacheUnix}"`,
						{ stdio: 'pipe', timeout: 120000 },
					);
					extracted = existsSync(cachedBinary);
					if (extracted) {
						console.log('  Extracted via tar with Unix-style paths');
					}
				} catch {
					console.log('  tar with Unix paths failed');
				}
			}

			// Last resort on Windows: use Git Bash's tar (usually at C:\Program Files\Git\usr\bin\tar.exe)
			if (!extracted) {
				const gitBashTar = 'C:\\Program Files\\Git\\usr\\bin\\tar.exe';
				if (existsSync(gitBashTar)) {
					const archiveUnix = archivePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1');
					const cacheUnix = FFMPEG_CACHE_DIR.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1');
					try {
						execSync(
							`"${gitBashTar}" -xf "${archiveUnix}" --strip-components=1 -C "${cacheUnix}"`,
							{ stdio: 'pipe', timeout: 120000 },
						);
						extracted = existsSync(cachedBinary);
						if (extracted) {
							console.log('  Extracted via Git Bash tar');
						}
					} catch {
						console.log('  Git Bash tar failed');
					}
				}
			}
		} catch (err) {
			console.log('  Windows extraction failed: %s', err instanceof Error ? err.message : String(err));
		}
	} else {
		// Linux/Mac: standard tar works fine
		try {
			execSync(
				`tar -xf "${archivePath}" --wildcards "*/ffmpeg" --strip-components=1 -C "${FFMPEG_CACHE_DIR}"`,
				{ stdio: 'pipe', timeout: 120000 },
			);
			extracted = existsSync(cachedBinary);
		} catch {
			// Some tar versions don't support --wildcards
			try {
				execSync(
					`tar -xf "${archivePath}" -C "${FFMPEG_CACHE_DIR}" --strip-components=1`,
					{ stdio: 'pipe', timeout: 120000 },
				);
				extracted = existsSync(cachedBinary);
			} catch { /* fall through */ }
		}
	}

	// If extraction didn't place it at the expected location, search recursively
	if (!extracted) {
		// Scan cache directory for any file named 'ffmpeg'
		const { readdirSync } = require('fs');
		const walkSync = (dir: string): string | null => {
			try {
				const entries = readdirSync(dir, { withFileTypes: true });
				for (const e of entries) {
					const full = join(dir, e.name);
					if (e.isFile() && e.name === 'ffmpeg') return full;
					if (e.isDirectory()) {
						const found = walkSync(full);
						if (found) return found;
					}
				}
			} catch { /* permission error etc */ }
			return null;
		};

		const found = walkSync(FFMPEG_CACHE_DIR);
		if (found && found !== cachedBinary) {
			copyFileSync(found, cachedBinary);
			extracted = true;
			console.log('  Found ffmpeg at %s, copied to cache', found);
		}
	}

	if (!extracted || !existsSync(cachedBinary)) {
		throw new Error(
			'FFmpeg binary not found after extraction. Archive: ' + archivePath + '\n' +
			'On Windows, install 7-Zip (7z) or Git for Windows for tar.xz support.\n' +
			'Or manually extract the ffmpeg binary to: ' + cachedBinary
		);
	}

	// Clean up archive (keep just the binary)
	try { unlinkSync(archivePath); } catch { /* ok */ }
	// Clean up any subdirectories left from extraction
	try {
		const { readdirSync } = require('fs');
		for (const entry of readdirSync(FFMPEG_CACHE_DIR, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				rmSync(join(FFMPEG_CACHE_DIR, entry.name), { recursive: true, force: true });
			}
		}
	} catch { /* best effort */ }

	const binarySize = (statSync(cachedBinary).size / (1024 * 1024)).toFixed(1);
	console.log('  FFmpeg binary: %s MB', binarySize);

	return cachedBinary;
}

// ─── Lambda Handler ─────────────────────────────────────────────────────

/**
 * Write the self-contained CJS Lambda handler to the build directory.
 * The handler uses ./bin/ffmpeg (bundled in the zip) or /opt/bin/ffmpeg (layer fallback).
 */
function writeHandler(): string {
	const indexPath = join(BUILD_DIR, 'index.js');

	const handler = `'use strict';

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { execSync } = require('child_process');
const { writeFileSync, readFileSync, unlinkSync, existsSync, statSync } = require('fs');
const path = require('path');

// --- FFmpeg binary discovery ---
// Priority: bundled in zip (./bin/ffmpeg) > Lambda layer (/opt/bin/ffmpeg) > system PATH
function getFFmpegPath() {
  // Bundled binary (same directory as this handler)
  const bundled = path.join(__dirname, 'bin', 'ffmpeg');
  if (existsSync(bundled)) {
    // Ensure it's executable (zip may strip permissions)
    try { require('fs').chmodSync(bundled, 0o755); } catch(e) {}
    return bundled;
  }
  // Lambda layer
  if (existsSync('/opt/bin/ffmpeg')) return '/opt/bin/ffmpeg';
  // System PATH fallback (for local testing)
  return 'ffmpeg';
}

// --- FFmpeg Filter Builders ---

function buildVideoFilter(config) {
  const filters = [];

  // Downscale to 1080p max — preserves aspect ratio, only scales if larger.
  // Applied FIRST so expensive filters operate on 1080p instead of 4K (~4x speedup).
  // -2 ensures height is divisible by 2 (required for H.264 encoding).
  filters.push('scale=min(iw\\\\,1080):-2');

  // Stabilization — FFmpeg deshake (single-pass, built-in)
  // Must come BEFORE sharpening so we sharpen the stabilized image
  // rx=32:ry=32 = 32px search radius (generous for phone sports footage)
  if (config.stabilize !== false) {
    filters.push('deshake=x=-1:y=-1:w=-1:h=-1:rx=32:ry=32');
  }

  // Sharpening — moderate settings for phone footage
  // 5x5 kernel, 0.8 luma strength, 0.4 chroma strength
  if (config.sharpen !== false) {
    filters.push('unsharp=5:5:0.8:5:5:0.4');
  }

  // Speed ramping — setpts changes presentation timestamps
  const speed = config.speed ?? 1.0;
  if (speed !== 1.0) {
    const ptsFactor = 1.0 / speed;
    filters.push('setpts=PTS*' + ptsFactor.toFixed(4));
  }

  return filters.join(',');
}

function buildAudioFilter(speed) {
  if (speed === 1.0) return '';
  const filters = [];
  let remaining = speed;
  // Chain atempo filters to stay within 0.5-2.0 range
  while (remaining > 2.0) { filters.push('atempo=2.0'); remaining /= 2.0; }
  while (remaining < 0.5) { filters.push('atempo=0.5'); remaining /= 0.5; }
  filters.push('atempo=' + remaining.toFixed(4));
  return filters.join(',');
}

// --- Lambda Handler ---

exports.handler = async function(event) {
  const startTime = Date.now();
  const ffmpegPath = getFFmpegPath();

  console.log('[preprocessor] FFmpeg path: ' + ffmpegPath);
  console.log('[preprocessor] Processing: input=%s, trim=%ds, dur=%ds, speed=%sx, stabilize=%s, sharpen=%s',
    event.inputS3Key, event.trimStart, event.duration,
    event.speed ?? 1.0, event.stabilize !== false ? 'yes' : 'no', event.sharpen !== false ? 'yes' : 'no');

  // Verify FFmpeg is available
  try {
    const version = execSync(ffmpegPath + ' -version', { stdio: 'pipe', timeout: 5000 }).toString().split('\\n')[0];
    console.log('[preprocessor] ' + version);
  } catch (err) {
    return {
      success: false,
      outputS3Key: event.outputS3Key || '',
      outputS3Url: '',
      outputSizeBytes: 0,
      effectiveDuration: 0,
      processingTimeMs: Date.now() - startTime,
      error: 'FFmpeg not found at ' + ffmpegPath + ': ' + (err.message || err),
    };
  }

  const inputPath = '/tmp/input.mp4';
  const outputPath = '/tmp/output.mp4';

  try {
    // Step 1: Download raw clip from S3
    console.log('[preprocessor] Downloading from s3://%s/%s...', event.bucketName, event.inputS3Key);
    const dlStart = Date.now();

    const s3 = new S3Client({ region: event.region });
    const getResult = await s3.send(new GetObjectCommand({
      Bucket: event.bucketName,
      Key: event.inputS3Key,
    }));

    const bodyBytes = await getResult.Body.transformToByteArray();
    writeFileSync(inputPath, Buffer.from(bodyBytes));

    const inputSize = statSync(inputPath).size;
    const dlTime = ((Date.now() - dlStart) / 1000).toFixed(1);
    console.log('[preprocessor] Downloaded: ' + (inputSize / (1024 * 1024)).toFixed(1) + 'MB in ' + dlTime + 's');

    // Step 2: Build FFmpeg command
    const speed = event.speed ?? 1.0;
    const videoFilter = buildVideoFilter({
      stabilize: event.stabilize,
      sharpen: event.sharpen,
      speed: speed,
    });
    const audioFilter = buildAudioFilter(speed);

    const ffmpegArgs = [
      ffmpegPath, '-y',
      '-ss', String(event.trimStart),
      '-t', String(event.duration),
      '-i', inputPath,
    ];

    if (videoFilter) { ffmpegArgs.push('-vf', "'" + videoFilter + "'"); }
    if (audioFilter) { ffmpegArgs.push('-af', "'" + audioFilter + "'"); }

    ffmpegArgs.push(
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '20',
      '-c:a', 'aac',
      '-b:a', '128k',
      outputPath,
    );

    const cmd = ffmpegArgs.join(' ');
    console.log('[preprocessor] FFmpeg command: ' + cmd);

    // Step 3: Run FFmpeg
    const ffStart = Date.now();
    try {
      execSync(cmd, { stdio: 'pipe', timeout: 240000, maxBuffer: 50 * 1024 * 1024 });
    } catch (ffErr) {
      // Capture stderr for better error messages
      const stderr = ffErr.stderr ? ffErr.stderr.toString().slice(-500) : '';
      throw new Error('FFmpeg failed: ' + (stderr || ffErr.message || ffErr));
    }

    const ffTime = ((Date.now() - ffStart) / 1000).toFixed(1);
    const outputSize = statSync(outputPath).size;
    console.log('[preprocessor] FFmpeg done: ' + (outputSize / (1024 * 1024)).toFixed(1) + 'MB output in ' + ffTime + 's');

    // Step 4: Upload processed clip to S3
    console.log('[preprocessor] Uploading to s3://%s/%s...', event.bucketName, event.outputS3Key);
    const upStart = Date.now();

    const outputBuffer = readFileSync(outputPath);
    await s3.send(new PutObjectCommand({
      Bucket: event.bucketName,
      Key: event.outputS3Key,
      Body: outputBuffer,
      ContentType: 'video/mp4',
    }));

    const upTime = ((Date.now() - upStart) / 1000).toFixed(1);
    console.log('[preprocessor] Uploaded in ' + upTime + 's');

    // Step 5: Clean up /tmp
    try { unlinkSync(inputPath); } catch(e) {}
    try { unlinkSync(outputPath); } catch(e) {}

    const effectiveDuration = event.duration / speed;
    const totalTime = Date.now() - startTime;
    const outputS3Url = 'https://' + event.bucketName + '.s3.' + event.region + '.amazonaws.com/' + event.outputS3Key;

    console.log('[preprocessor] Complete: ' +
      (inputSize / (1024 * 1024)).toFixed(1) + 'MB -> ' +
      (outputSize / (1024 * 1024)).toFixed(1) + 'MB, ' +
      'effectiveDur=' + effectiveDuration.toFixed(1) + 's, ' +
      'total=' + totalTime + 'ms');

    return {
      success: true,
      outputS3Key: event.outputS3Key,
      outputS3Url: outputS3Url,
      outputSizeBytes: outputSize,
      effectiveDuration: effectiveDuration,
      processingTimeMs: totalTime,
    };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[preprocessor] FAILED: ' + msg);

    try { if (existsSync(inputPath)) unlinkSync(inputPath); } catch(e) {}
    try { if (existsSync(outputPath)) unlinkSync(outputPath); } catch(e) {}

    return {
      success: false,
      outputS3Key: event.outputS3Key || '',
      outputS3Url: '',
      outputSizeBytes: 0,
      effectiveDuration: 0,
      processingTimeMs: Date.now() - startTime,
      error: msg,
    };
  }
};
`;

	writeFileSync(indexPath, handler, 'utf-8');
	return indexPath;
}

// ─── Zip Package ────────────────────────────────────────────────────────

/**
 * Create the Lambda deployment zip containing:
 *   - index.js (handler)
 *   - bin/ffmpeg (static binary, ~70MB uncompressed → ~30MB zipped)
 */
async function createZipPackage(ffmpegBinaryPath: string): Promise<Buffer> {
	// Prepare build directory structure
	const binDir = join(BUILD_DIR, 'bin');
	if (!existsSync(binDir)) {
		mkdirSync(binDir, { recursive: true });
	}

	// Copy FFmpeg binary into build/bin/
	const targetBinary = join(binDir, 'ffmpeg');
	copyFileSync(ffmpegBinaryPath, targetBinary);

	// Ensure it's executable (important when deploying from Windows)
	try { chmodSync(targetBinary, 0o755); } catch { /* Windows */ }

	const binarySize = (statSync(targetBinary).size / (1024 * 1024)).toFixed(1);
	console.log('  FFmpeg binary in package: %s MB', binarySize);

	// Write handler
	const indexPath = writeHandler();
	console.log('  Handler written: %s', indexPath);

	// Create zip
	const zipPath = join(BUILD_DIR, 'preprocessor.zip');
	if (existsSync(zipPath)) unlinkSync(zipPath);

	// Create zip — try different approaches for cross-platform compatibility
	let zipped = false;

	// Approach 1: PowerShell (Windows)
	if (!zipped) {
		try {
			execSync(
				`powershell -Command "Compress-Archive -Path '${join(BUILD_DIR, 'index.js')}', '${binDir}' -DestinationPath '${zipPath}' -Force"`,
				{ stdio: 'pipe', timeout: 60000 },
			);
			zipped = true;
			console.log('  Created zip via PowerShell');
		} catch { /* try next */ }
	}

	// Approach 2: zip command (Linux/Mac)
	if (!zipped) {
		try {
			execSync(
				`cd "${BUILD_DIR}" && zip -r "${zipPath}" index.js bin/ffmpeg`,
				{ stdio: 'pipe', timeout: 60000 },
			);
			zipped = true;
			console.log('  Created zip via zip command');
		} catch { /* try next */ }
	}

	// Approach 3: 7z (Windows with 7-Zip)
	if (!zipped) {
		try {
			execSync(
				`cd "${BUILD_DIR}" && 7z a -tzip "${zipPath}" index.js bin\\ffmpeg`,
				{ stdio: 'pipe', timeout: 60000 },
			);
			zipped = true;
			console.log('  Created zip via 7z');
		} catch { /* try next */ }
	}

	if (!zipped) {
		throw new Error(
			'Could not create zip file. Install one of: PowerShell, zip (Linux), or 7z (Windows).'
		);
	}

	const zipBuffer = readFileSync(zipPath);
	const zipSize = (zipBuffer.length / (1024 * 1024)).toFixed(1);
	console.log('  Deployment package: %s MB', zipSize);

	// Lambda has a 50MB direct upload limit; for larger packages we must use S3
	if (zipBuffer.length > 50 * 1024 * 1024) {
		console.log('  Package > 50MB — will upload to S3 first (Lambda direct upload limit)');
	}

	return zipBuffer;
}

// ─── Deploy Lambda ──────────────────────────────────────────────────────

async function deployLambda(zipBuffer: Buffer, roleArn: string): Promise<string> {
	const {
		LambdaClient,
		CreateFunctionCommand,
		UpdateFunctionCodeCommand,
		UpdateFunctionConfigurationCommand,
		GetFunctionCommand,
		waitUntilFunctionUpdatedV2,
	} = await import('@aws-sdk/client-lambda');

	const lambda = new LambdaClient({
		region,
		credentials: {
			accessKeyId: process.env.REMOTION_AWS_ACCESS_KEY_ID!,
			secretAccessKey: process.env.REMOTION_AWS_SECRET_ACCESS_KEY!,
		},
	});

	// Check if function already exists
	let functionExists = false;
	try {
		await lambda.send(new GetFunctionCommand({ FunctionName: FUNCTION_NAME }));
		functionExists = true;
	} catch (err: any) {
		if (err.name !== 'ResourceNotFoundException') throw err;
	}

	// If zip is > 50MB, upload to S3 first
	const useS3Upload = zipBuffer.length > 50 * 1024 * 1024;
	let s3Key: string | undefined;
	let s3Bucket: string | undefined;

	if (useS3Upload) {
		const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
		s3Bucket = process.env.REMOTION_BUCKET_NAME;
		if (!s3Bucket) {
			throw new Error('REMOTION_BUCKET_NAME required for packages > 50MB. Set it in .env.');
		}
		s3Key = `lambda-deploy/${FUNCTION_NAME}-${Date.now()}.zip`;

		console.log('  Uploading package to S3: s3://%s/%s...', s3Bucket, s3Key);
		const s3 = new S3Client({
			region,
			credentials: {
				accessKeyId: process.env.REMOTION_AWS_ACCESS_KEY_ID!,
				secretAccessKey: process.env.REMOTION_AWS_SECRET_ACCESS_KEY!,
			},
		});
		await s3.send(new PutObjectCommand({
			Bucket: s3Bucket,
			Key: s3Key,
			Body: zipBuffer,
		}));
		console.log('  Uploaded to S3.');
	}

	if (functionExists) {
		console.log('  Updating existing Lambda function...');

		// Update code
		if (useS3Upload) {
			await lambda.send(new UpdateFunctionCodeCommand({
				FunctionName: FUNCTION_NAME,
				S3Bucket: s3Bucket,
				S3Key: s3Key,
			}));
		} else {
			await lambda.send(new UpdateFunctionCodeCommand({
				FunctionName: FUNCTION_NAME,
				ZipFile: zipBuffer,
			}));
		}

		// Wait for code update
		console.log('  Waiting for code update to propagate...');
		await waitUntilFunctionUpdatedV2(
			{ client: lambda, maxWaitTime: 120 },
			{ FunctionName: FUNCTION_NAME },
		);

		// Update configuration
		await lambda.send(new UpdateFunctionConfigurationCommand({
			FunctionName: FUNCTION_NAME,
			Runtime: 'nodejs20.x',
			Handler: 'index.handler',
			MemorySize: 2048,
			Timeout: 300,
			EphemeralStorage: { Size: 2048 },
			Role: roleArn,
			Description: 'FFmpeg preprocessor for CLC video: deshake + sharpen + trim + speed',
		}));

		console.log('  Function updated.');
	} else {
		console.log('  Creating new Lambda function...');

		const createParams: any = {
			FunctionName: FUNCTION_NAME,
			Runtime: 'nodejs20.x',
			Handler: 'index.handler',
			Role: roleArn,
			MemorySize: 2048,
			Timeout: 300,
			EphemeralStorage: { Size: 2048 },
			Architectures: ['x86_64'],
			Description: 'FFmpeg preprocessor for CLC video: deshake + sharpen + trim + speed',
		};

		if (useS3Upload) {
			createParams.Code = { S3Bucket: s3Bucket, S3Key: s3Key };
		} else {
			createParams.Code = { ZipFile: zipBuffer };
		}

		await lambda.send(new CreateFunctionCommand(createParams));
		console.log('  Function created. Waiting for activation...');

		// Wait for function to become active
		await waitUntilFunctionUpdatedV2(
			{ client: lambda, maxWaitTime: 120 },
			{ FunctionName: FUNCTION_NAME },
		);
	}

	// Get the function ARN
	const fnInfo = await lambda.send(new GetFunctionCommand({ FunctionName: FUNCTION_NAME }));
	return fnInfo.Configuration?.FunctionArn || FUNCTION_NAME;
}

// ─── Test ───────────────────────────────────────────────────────────────

async function testFunction(): Promise<boolean> {
	console.log('  Running smoke test...');

	const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');

	const lambda = new LambdaClient({
		region,
		credentials: {
			accessKeyId: process.env.REMOTION_AWS_ACCESS_KEY_ID!,
			secretAccessKey: process.env.REMOTION_AWS_SECRET_ACCESS_KEY!,
		},
	});

	try {
		// Invoke with a payload that will fail (no such S3 file) but proves:
		// 1. Lambda loads successfully
		// 2. Handler executes
		// 3. FFmpeg binary is found
		const result = await lambda.send(new InvokeCommand({
			FunctionName: FUNCTION_NAME,
			InvocationType: 'RequestResponse',
			Payload: Buffer.from(JSON.stringify({
				bucketName: 'nonexistent-test-bucket',
				region: region,
				inputS3Key: 'test/nonexistent.mp4',
				outputS3Key: 'test/output.mp4',
				trimStart: 0,
				duration: 1,
				stabilize: true,
				sharpen: true,
			})),
		}));

		const payload = result.Payload
			? JSON.parse(Buffer.from(result.Payload).toString())
			: null;

		if (result.FunctionError) {
			// Unhandled error in Lambda runtime
			console.error('  Smoke test: Lambda runtime error');
			console.error('  %s', JSON.stringify(payload, null, 2).substring(0, 500));
			return false;
		}

		if (payload && payload.success === false) {
			const err = payload.error || '';
			if (err.includes('FFmpeg not found')) {
				console.error('  FAIL: FFmpeg binary not found! Error: %s', err);
				return false;
			}
			// Expected: S3 NoSuchBucket/NoSuchKey error = function loaded fine, FFmpeg was found
			console.log('  OK: Function loaded, FFmpeg found. Expected S3 error: %s',
				err.substring(0, 100));
			return true;
		}

		console.log('  Unexpected result: %s', JSON.stringify(payload).substring(0, 200));
		return true;

	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('  Smoke test invocation failed: %s', msg);
		return false;
	}
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
	// Validate env vars
	if (!process.env.REMOTION_AWS_ACCESS_KEY_ID || !process.env.REMOTION_AWS_SECRET_ACCESS_KEY) {
		console.error('ERROR: REMOTION_AWS_ACCESS_KEY_ID and REMOTION_AWS_SECRET_ACCESS_KEY must be set in .env');
		process.exit(1);
	}

	// Clean build dir
	if (existsSync(BUILD_DIR)) {
		rmSync(BUILD_DIR, { recursive: true, force: true });
	}
	mkdirSync(BUILD_DIR, { recursive: true });

	// Step 1: Get FFmpeg binary
	console.log('[1/5] Getting FFmpeg binary...');
	const ffmpegBinary = await getFFmpegBinary();

	// Step 2: Create deployment package
	console.log('[2/5] Creating deployment package (handler + FFmpeg binary)...');
	const zipBuffer = await createZipPackage(ffmpegBinary);

	// Step 3: Get IAM role
	console.log('[3/5] Getting IAM role ARN...');
	const roleArn = await getRoleArn();
	console.log('  Role: %s', roleArn);

	// Step 4: Deploy
	console.log('[4/5] Deploying Lambda function...');
	const functionArn = await deployLambda(zipBuffer, roleArn);

	// Step 5: Test
	console.log('[5/5] Testing...');
	const testOk = await testFunction();

	// Clean up build artifacts
	try {
		rmSync(BUILD_DIR, { recursive: true, force: true });
	} catch { /* best effort */ }

	// Results
	console.log('');
	console.log('══════════════════════════════════════════════');
	console.log('  Deployment %s', testOk ? 'COMPLETE' : 'COMPLETE (test failed — check FFmpeg binary)');
	console.log('══════════════════════════════════════════════');
	console.log('');
	console.log('  Function:  %s', FUNCTION_NAME);
	console.log('  ARN:       %s', functionArn);
	console.log('  Memory:    2048 MB');
	console.log('  Timeout:   300s');
	console.log('  Disk:      2048 MB');
	console.log('  Runtime:   nodejs20.x (x86_64)');
	console.log('  FFmpeg:    bundled in package');
	console.log('');
	console.log('  Add to .env:');
	console.log(`    PREPROCESSOR_FUNCTION_NAME=${FUNCTION_NAME}`);
	console.log('');
	console.log('  Set in Agentuity cloud:');
	console.log(`    bunx @agentuity/cli cloud env set PREPROCESSOR_FUNCTION_NAME "${FUNCTION_NAME}"`);
	console.log('');
}

main().catch((err) => {
	console.error('Deployment failed:', err.message || err);
	process.exit(1);
});
