/**
 * Test script for the auto-cataloger (multi-frame extraction)
 * Downloads a video, extracts 4 frames via FFmpeg, sends to GPT-4o vision.
 *
 * Usage: bun run test-cataloger.ts
 */

import { testConnection, listVideoFiles, type VideoFile } from './src/agent/video-editor/google-drive';
import { catalogSingleVideo, getCatalogSummary } from './src/agent/video-editor/cataloger';
import { execSync } from 'child_process';

async function main() {
	console.log('[TEST] Auto-Cataloger Test (Multi-Frame Extraction)\n');

	// Step 0: Check FFmpeg
	console.log('[0] Checking FFmpeg installation...');
	try {
		const ffmpegVersion = execSync('ffmpeg -version', { encoding: 'utf-8', timeout: 5000 })
			.split('\n')[0];
		console.log(`   [PASS] ${ffmpegVersion}\n`);
	} catch {
		console.error('   [FAIL] FFmpeg not found. Install with: sudo apt update && sudo apt install ffmpeg -y');
		process.exit(1);
	}

	// Step 1: Test connection
	console.log('[1] Testing Google Drive connection...');
	const conn = await testConnection();
	console.log(`   Status: ${conn.success ? '[PASS]' : '[FAIL]'}`);
	console.log(`   Message: ${conn.message}\n`);

	if (!conn.success) {
		console.error('[FAIL] Connection failed. Check credentials.');
		process.exit(1);
	}

	// Step 2: List videos and pick a test subject
	console.log('[2] Listing videos to find a test subject...');
	const videos = await listVideoFiles();
	console.log(`   Found ${videos.length} videos`);

	if (videos.length === 0) {
		console.error('[FAIL] No videos found in folder.');
		process.exit(1);
	}

	// Pick first video
	const testVideo = videos[0]!;
	const sizeMB = (parseInt(testVideo.size) / (1024 * 1024)).toFixed(0);
	console.log(`   Test video: ${testVideo.name}`);
	console.log(`   Size: ${sizeMB} MB`);
	console.log(`   Has thumbnail: ${testVideo.thumbnailLink ? 'Yes' : 'No'}\n`);

	// Step 3: Analyze single video with multi-frame extraction
	console.log('[3] Running single video analysis with multi-frame extraction...');
	console.log('   (This downloads the video, extracts 4 frames, then sends to GPT-4o)');
	console.log('   (May take 15-45 seconds depending on file size)\n');

	try {
		const startTime = Date.now();
		const entry = await catalogSingleVideo(testVideo);
		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

		console.log('   [PASS] Analysis complete!');
		console.log(`   Time: ${elapsed}s`);
		console.log(`   Duration: ${entry.duration || 'N/A'}`);
		console.log(`   Location: ${entry.suspectedLocation} (${entry.locationConfidence} confidence)`);
		console.log(`   Location Clues: ${entry.locationClues}`);
		console.log(`   Content Type: ${entry.contentType}`);
		console.log(`   Activity: ${entry.activity}`);
		console.log(`   Quality: ${entry.quality}`);
		console.log(`   Indoor/Outdoor: ${entry.indoorOutdoor}`);
		console.log(`   People Count: ${entry.peopleCount || 'N/A'}`);
		console.log(`   Notable Moments: ${entry.notableMoments || 'N/A'}`);
		if (entry.readableText) {
			console.log(`   Readable Text: ${entry.readableText}`);
		}
		console.log(`   Suggested Modes: ${entry.suggestedModes?.join(', ') || 'None'}`);
		console.log(`   Needs Review: ${entry.needsManualReview}`);
		console.log(`   Review Notes: ${entry.reviewNotes}`);

		// Step 4: Test catalog summary with this single entry
		console.log('\n[4] Testing catalog summary...');
		const summary = getCatalogSummary([entry]);
		console.log(`   Total: ${summary.total}`);
		console.log(`   By Location:`, JSON.stringify(summary.byLocation));
		console.log(`   By Content Type:`, JSON.stringify(summary.byContentType));
		console.log(`   By Quality:`, JSON.stringify(summary.byQuality));
		console.log(`   Needs Review: ${summary.needsReview}`);
		console.log(`   With Readable Text: ${summary.withReadableText}`);
		console.log(`   Confidence Breakdown:`, JSON.stringify(summary.confidenceBreakdown));

		console.log('\n[PASS] All cataloger tests passed!');
		console.log('\nNext steps:');
		console.log('  - Run full catalog with: task=catalog, catalogAction=run-full');
		console.log('  - Check the frontend at the Video Editor page');
		console.log(`  - Estimated full catalog time: ${videos.length} videos * ~30s = ~${Math.round(videos.length * 30 / 60)} minutes`);

	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		console.error(`\n   [FAIL] Analysis failed: ${errorMsg}`);

		if (errorMsg.includes('401') || errorMsg.includes('403')) {
			console.error('\n   Download auth issue. The service account may not have access.');
			console.error('   Make sure the Google Drive folder is shared with the service account email.');
		}

		if (errorMsg.includes('rate') || errorMsg.includes('429')) {
			console.error('\n   Rate limit hit. Wait a minute and try again.');
		}

		if (errorMsg.includes('OPENAI_API_KEY')) {
			console.error('\n   OpenAI API key not set. Add OPENAI_API_KEY to your .env file.');
		}

		if (errorMsg.includes('ffmpeg') || errorMsg.includes('ENOENT')) {
			console.error('\n   FFmpeg not found. Install with: sudo apt update && sudo apt install ffmpeg -y');
		}

		if (errorMsg.includes('abort') || errorMsg.includes('timeout')) {
			console.error('\n   Download timeout. The video may be too large. Try a smaller file.');
		}

		process.exit(1);
	}
}

main().catch((err) => {
	console.error('[FAIL] Unexpected error:', err);
	process.exit(1);
});
