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
 * Upload a single video file from Google Drive to the Remotion S3 bucket.
 *
 * Downloads from Drive API → buffers in memory → uploads to S3.
 * Returns the public S3 URL that Lambda workers can fetch.
 */
async function uploadDriveFileToS3(
	fileId: string,
	bucketName: string,
	region: string,
	renderPrefix: string,
	logger?: Logger,
): Promise<S3UploadedClip> {
	// Dynamic imports to keep the module lightweight
	const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
	const { getAuth } = await import('../google-drive');
	const { drive_v3 } = await import('@googleapis/drive');

	const s3Key = `temp-clips/${renderPrefix}/${fileId}.mp4`;

	// Step 1: Download from Google Drive to a temp file (stream, not buffer)
	logger?.info('[s3-upload] Downloading %s from Google Drive...', fileId);
	const startDl = Date.now();

	const authClient = getAuth();
	const drive = new drive_v3.Drive({ auth: authClient });

	const fs = await import('fs');
	const path = await import('path');
	const os = await import('os');
	const tempPath = path.join(os.tmpdir(), `s3upload_${fileId}_${Date.now()}.mp4`);

	const response = await drive.files.get(
		{ fileId, alt: 'media' },
		{ responseType: 'stream' },
	);

	// Stream to disk to avoid buffering 300MB+ in memory
	await new Promise<void>((resolve, reject) => {
		const ws = fs.createWriteStream(tempPath);
		(response.data as NodeJS.ReadableStream).pipe(ws);
		ws.on('finish', resolve);
		ws.on('error', reject);
		(response.data as NodeJS.ReadableStream).on('error', reject);
	});

	const fileSize = fs.statSync(tempPath).size;
	const dlTime = ((Date.now() - startDl) / 1000).toFixed(1);
	logger?.info('[s3-upload] Downloaded %s: %dMB in %ss',
		fileId, (fileSize / (1024 * 1024)).toFixed(1), dlTime);

	// Step 2: Stream upload to S3 from temp file
	logger?.info('[s3-upload] Uploading %s to s3://%s/%s...', fileId, bucketName, s3Key);
	const startUp = Date.now();

	const { Upload } = await import('@aws-sdk/lib-storage');

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
			Body: fs.createReadStream(tempPath),
			ContentType: 'video/mp4',
		},
		// 10MB parts, process one part at a time to keep memory low
		partSize: 10 * 1024 * 1024,
		queueSize: 1,
	});

	await upload.done();

	const upTime = ((Date.now() - startUp) / 1000).toFixed(1);
	logger?.info('[s3-upload] Uploaded %s to S3 in %ss', fileId, upTime);

	// Clean up temp file
	try { fs.unlinkSync(tempPath); } catch { /* best-effort */ }

	// Build the public S3 URL
	const s3Url = `https://${bucketName}.s3.${region}.amazonaws.com/${s3Key}`;

	return {
		fileId,
		s3Key,
		s3Url,
		sizeBytes: fileSize,
	};
}

/**
 * Upload multiple video files from Google Drive to S3 in parallel.
 *
 * Deduplicates by fileId (same file used multiple times gets uploaded once).
 * Returns a map of fileId → S3 URL.
 */
export async function uploadClipsToS3(
	fileIds: string[],
	bucketName: string,
	region: string,
	logger?: Logger,
): Promise<Map<string, S3UploadedClip>> {
	// Deduplicate fileIds (same clip may be used multiple times with different trimStart)
	const uniqueFileIds = [...new Set(fileIds)];

	const renderPrefix = `render_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

	logger?.info('[s3-upload] Uploading %d unique clips to S3 (prefix: %s)...',
		uniqueFileIds.length, renderPrefix);
	const startTime = Date.now();

	// Upload sequentially to keep memory low — each clip streams through disk, not RAM
	const concurrency = 1;
	const results = new Map<string, S3UploadedClip>();
	const errors: string[] = [];

	for (let i = 0; i < uniqueFileIds.length; i += concurrency) {
		const batch = uniqueFileIds.slice(i, i + concurrency);
		const batchResults = await Promise.allSettled(
			batch.map(fileId =>
				uploadDriveFileToS3(fileId, bucketName, region, renderPrefix, logger)
			),
		);

		for (let j = 0; j < batchResults.length; j++) {
			const result = batchResults[j]!;
			const fileId = batch[j]!;
			if (result.status === 'fulfilled') {
				results.set(fileId, result.value);
			} else {
				const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
				errors.push(`${fileId}: ${msg}`);
				logger?.error?.('[s3-upload] Failed to upload %s: %s', fileId, msg);
			}
		}
	}

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
