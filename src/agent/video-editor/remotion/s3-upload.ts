/**
 * S3 Upload Utilities for Remotion Lambda
 *
 * Uploads video clips from Google Drive to the Remotion S3 bucket
 * so Lambda workers can fetch them at high speed (same-region S3).
 *
 * This eliminates the slow double-hop:
 *   Lambda → Agentuity server → Google Drive
 * and replaces it with:
 *   Agentuity server → Google Drive → S3 (once)
 *   Lambda → S3 (fast, same region)
 *
 * File: src/agent/video-editor/remotion/s3-upload.ts
 */

interface Logger {
	info: (...args: any[]) => void;
	error?: (...args: any[]) => void;
	warn?: (...args: any[]) => void;
}

export interface S3UploadedClip {
	fileId: string;
	s3Key: string;
	s3Url: string;
	sizeBytes: number;
}

/**
 * Download a single video from Google Drive to a temp directory.
 * Returns the local file path and size.
 */
async function downloadDriveFile(
	fileId: string,
	tempDir: string,
	logger?: Logger,
): Promise<{ fileId: string; localPath: string; sizeBytes: number }> {
	const { getAuth } = await import('../google-drive');
	const { drive_v3 } = await import('@googleapis/drive');
	const fs = await import('fs');
	const path = await import('path');

	const localPath = path.join(tempDir, `${fileId}.mp4`);

	logger?.info('[s3-upload] Downloading %s from Google Drive...', fileId);
	const start = Date.now();

	const authClient = getAuth();
	const drive = new drive_v3.Drive({ auth: authClient });
	const response = await drive.files.get(
		{ fileId, alt: 'media' },
		{ responseType: 'stream' },
	);

	await new Promise<void>((resolve, reject) => {
		const ws = fs.createWriteStream(localPath);
		(response.data as NodeJS.ReadableStream).pipe(ws);
		ws.on('finish', resolve);
		ws.on('error', reject);
		(response.data as NodeJS.ReadableStream).on('error', reject);
	});

	const sizeBytes = fs.statSync(localPath).size;
	const elapsed = ((Date.now() - start) / 1000).toFixed(1);
	logger?.info('[s3-upload] Downloaded %s: %dMB in %ss',
		fileId, (sizeBytes / (1024 * 1024)).toFixed(1), elapsed);

	return { fileId, localPath, sizeBytes };
}

/**
 * Check if s5cmd is available on the system.
 */
function isS5cmdAvailable(): boolean {
	try {
		const { execSync } = require('child_process');
		execSync('s5cmd version', { stdio: 'pipe', timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * Upload all files in a directory to S3 using s5cmd (parallel, 12x faster than aws-cli).
 * Falls back to AWS SDK if s5cmd is not installed (local dev).
 */
async function s5cmdUpload(
	tempDir: string,
	bucketName: string,
	s3Prefix: string,
	region: string,
	logger?: Logger,
): Promise<void> {
	const { execSync } = await import('child_process');

	const s3Dest = `s3://${bucketName}/${s3Prefix}/`;
	logger?.info('[s3-upload] s5cmd: uploading %s → %s', tempDir, s3Dest);
	const start = Date.now();

	execSync(
		`s5cmd --endpoint-url https://s3.${region}.amazonaws.com cp "${tempDir}/*.mp4" "${s3Dest}"`,
		{
			timeout: 300_000,
			stdio: 'pipe',
			env: {
				...process.env,
				AWS_ACCESS_KEY_ID: process.env.REMOTION_AWS_ACCESS_KEY_ID,
				AWS_SECRET_ACCESS_KEY: process.env.REMOTION_AWS_SECRET_ACCESS_KEY,
				AWS_REGION: region,
			},
		},
	);

	const elapsed = ((Date.now() - start) / 1000).toFixed(1);
	logger?.info('[s3-upload] s5cmd: upload complete in %ss', elapsed);
}

/**
 * Fallback: upload a single file using AWS SDK (for local dev without s5cmd).
 */
async function sdkUploadFile(
	localPath: string,
	bucketName: string,
	s3Key: string,
	region: string,
): Promise<void> {
	const fs = await import('fs');
	const { Upload } = await import('@aws-sdk/lib-storage');
	const { S3Client } = await import('@aws-sdk/client-s3');

	const s3 = new S3Client({
		region,
		credentials: {
			accessKeyId: process.env.REMOTION_AWS_ACCESS_KEY_ID!,
			secretAccessKey: process.env.REMOTION_AWS_SECRET_ACCESS_KEY!,
		},
	});

	const upload = new Upload({
		client: s3,
		params: {
			Bucket: bucketName,
			Key: s3Key,
			Body: fs.createReadStream(localPath),
			ContentType: 'video/mp4',
		},
		partSize: 10 * 1024 * 1024,
		queueSize: 1,
	});

	await upload.done();
}

/**
 * Upload multiple video files from Google Drive to S3.
 *
 * Two-phase approach:
 *   1. Download all clips from Drive → temp directory (sequential, streaming)
 *   2. Upload entire directory to S3 via s5cmd (parallel, 12x faster)
 *      Falls back to AWS SDK sequential upload if s5cmd isn't installed.
 *
 * Deduplicates by fileId (same clip used multiple times gets uploaded once).
 * Returns a map of fileId → S3 URL.
 */
export async function uploadClipsToS3(
	fileIds: string[],
	bucketName: string,
	region: string,
	logger?: Logger,
): Promise<Map<string, S3UploadedClip>> {
	const fs = await import('fs');
	const path = await import('path');
	const os = await import('os');

	const uniqueFileIds = [...new Set(fileIds)];
	const renderPrefix = `render_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
	const s3Prefix = `temp-clips/${renderPrefix}`;

	// Create temp directory for this render batch
	const tempDir = path.join(os.tmpdir(), `s3batch_${Date.now()}`);
	fs.mkdirSync(tempDir, { recursive: true });

	logger?.info('[s3-upload] Uploading %d unique clips to S3 (prefix: %s)...',
		uniqueFileIds.length, renderPrefix);
	const startTime = Date.now();

	// Phase 1: Download all clips from Drive to temp dir (sequential to avoid OOM)
	const downloaded: Array<{ fileId: string; localPath: string; sizeBytes: number }> = [];
	const errors: string[] = [];

	for (const fileId of uniqueFileIds) {
		try {
			const result = await downloadDriveFile(fileId, tempDir, logger);
			downloaded.push(result);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			errors.push(`${fileId}: ${msg}`);
			logger?.error?.('[s3-upload] Failed to download %s: %s', fileId, msg);
		}
	}

	if (errors.length > 0 && downloaded.length === 0) {
		// Clean up
		try { fs.rmSync(tempDir, { recursive: true }); } catch { /* ignore */ }
		throw new Error(`Failed to download all clips:\n${errors.join('\n')}`);
	}

	// Phase 2: Upload to S3
	const useS5cmd = isS5cmdAvailable();
	logger?.info('[s3-upload] Using %s for S3 upload (%d files)',
		useS5cmd ? 's5cmd (parallel)' : 'AWS SDK (sequential)', downloaded.length);

	if (useS5cmd) {
		await s5cmdUpload(tempDir, bucketName, s3Prefix, region, logger);
	} else {
		// Fallback: SDK sequential upload
		for (const file of downloaded) {
			const s3Key = `${s3Prefix}/${file.fileId}.mp4`;
			logger?.info('[s3-upload] SDK uploading %s...', file.fileId);
			await sdkUploadFile(file.localPath, bucketName, s3Key, region);
			logger?.info('[s3-upload] SDK uploaded %s', file.fileId);
		}
	}

	// Build results map
	const results = new Map<string, S3UploadedClip>();
	for (const file of downloaded) {
		const s3Key = `${s3Prefix}/${file.fileId}.mp4`;
		results.set(file.fileId, {
			fileId: file.fileId,
			s3Key,
			s3Url: `https://${bucketName}.s3.${region}.amazonaws.com/${s3Key}`,
			sizeBytes: file.sizeBytes,
		});
	}

	// Clean up temp directory
	try { fs.rmSync(tempDir, { recursive: true }); } catch { /* ignore */ }

	const totalSize = [...results.values()].reduce((s, r) => s + r.sizeBytes, 0);
	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
	logger?.info('[s3-upload] Upload complete: %d/%d clips, %dMB total, %ss',
		results.size, uniqueFileIds.length,
		(totalSize / (1024 * 1024)).toFixed(0), elapsed);

	if (errors.length > 0) {
		throw new Error(`Failed to upload ${errors.length} clips to S3:\n${errors.join('\n')}`);
	}

	return results;
}

/**
 * Upload preprocessed local video files to the Remotion S3 bucket.
 *
 * Unlike uploadClipsToS3() which downloads from Google Drive, this reads
 * already-preprocessed files from local disk (output of FFmpeg pipeline).
 * Each clip has a unique processedId since the same Drive file can produce
 * different processed clips (different trim/speed/stabilization).
 *
 * Returns a map of processedId → S3UploadedClip.
 */
export async function uploadPreprocessedClipsToS3(
	clips: Array<{ processedId: string; localPath: string }>,
	bucketName: string,
	region: string,
	logger?: Logger,
): Promise<Map<string, S3UploadedClip>> {
	const fs = await import('fs');
	const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');

	const renderPrefix = `render_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

	logger?.info('[s3-upload] Uploading %d preprocessed clips to S3 (prefix: %s)...',
		clips.length, renderPrefix);
	const startTime = Date.now();

	const s3 = new S3Client({
		region,
		credentials: {
			accessKeyId: process.env.REMOTION_AWS_ACCESS_KEY_ID!,
			secretAccessKey: process.env.REMOTION_AWS_SECRET_ACCESS_KEY!,
		},
	});

	const concurrency = 3;
	const results = new Map<string, S3UploadedClip>();
	const errors: string[] = [];

	for (let i = 0; i < clips.length; i += concurrency) {
		const batch = clips.slice(i, i + concurrency);
		const batchResults = await Promise.allSettled(
			batch.map(async (clip) => {
				const s3Key = `temp-clips/${renderPrefix}/${clip.processedId}.mp4`;

				// Read local preprocessed file
				logger?.info('[s3-upload] Reading local file %s (%s)...', clip.processedId, clip.localPath);
				const buffer = fs.readFileSync(clip.localPath);
				const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);

				// Upload to S3
				logger?.info('[s3-upload] Uploading %s to s3://%s/%s (%sMB)...',
					clip.processedId, bucketName, s3Key, sizeMB);
				const uploadStart = Date.now();

				await s3.send(new PutObjectCommand({
					Bucket: bucketName,
					Key: s3Key,
					Body: buffer,
					ContentType: 'video/mp4',
				}));

				const uploadTime = ((Date.now() - uploadStart) / 1000).toFixed(1);
				logger?.info('[s3-upload] Uploaded %s in %ss', clip.processedId, uploadTime);

				const s3Url = `https://${bucketName}.s3.${region}.amazonaws.com/${s3Key}`;

				return {
					fileId: clip.processedId, // Use processedId as the key identifier
					s3Key,
					s3Url,
					sizeBytes: buffer.length,
				} satisfies S3UploadedClip;
			}),
		);

		for (let j = 0; j < batchResults.length; j++) {
			const result = batchResults[j]!;
			const clip = batch[j]!;
			if (result.status === 'fulfilled') {
				results.set(clip.processedId, result.value);
			} else {
				const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
				errors.push(`${clip.processedId}: ${msg}`);
				logger?.error?.('[s3-upload] Failed to upload %s: %s', clip.processedId, msg);
			}
		}
	}

	const totalSize = [...results.values()].reduce((s, r) => s + r.sizeBytes, 0);
	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
	logger?.info('[s3-upload] Preprocessed upload complete: %d/%d clips, %dMB total, %ss',
		results.size, clips.length,
		(totalSize / (1024 * 1024)).toFixed(0), elapsed);

	if (errors.length > 0) {
		throw new Error(`Failed to upload ${errors.length} preprocessed clips to S3:\n${errors.join('\n')}`);
	}

	return results;
}

/**
 * Clean up temporary S3 clips after render completes.
 *
 * Deletes all files under the temp-clips/ prefix for this render.
 */
export async function cleanupS3Clips(
	clips: S3UploadedClip[],
	bucketName: string,
	region: string,
	logger?: Logger,
): Promise<void> {
	if (clips.length === 0) return;

	try {
		const { S3Client, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');

		const s3 = new S3Client({
			region,
			credentials: {
				accessKeyId: process.env.REMOTION_AWS_ACCESS_KEY_ID!,
				secretAccessKey: process.env.REMOTION_AWS_SECRET_ACCESS_KEY!,
			},
		});

		await s3.send(new DeleteObjectsCommand({
			Bucket: bucketName,
			Delete: {
				Objects: clips.map(c => ({ Key: c.s3Key })),
			},
		}));

		logger?.info('[s3-upload] Cleaned up %d temp clips from S3', clips.length);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger?.warn?.('[s3-upload] Cleanup warning: %s', msg);
	}
}
