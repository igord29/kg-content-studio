/**
 * Test script to verify the resume logic in cataloger
 * Creates a fake catalog-results.json with a few entries,
 * then checks that runFullCatalog correctly identifies them as already processed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { listVideoFiles } from './src/agent/video-editor/google-drive';
import type { CatalogEntry } from './src/agent/video-editor/google-drive';

async function testResumeLogic() {
	console.log('[TEST] Testing resume logic...\n');

	const catalogPath = path.join(process.cwd(), 'catalog-results.json');

	// Get first 3 videos from Drive
	const videos = await listVideoFiles();
	console.log(`[TEST] Found ${videos.length} total videos in Drive`);

	if (videos.length < 3) {
		console.log('[TEST] Need at least 3 videos to test properly');
		return;
	}

	// Create fake catalog entries for first 3 videos
	const fakeEntries: CatalogEntry[] = videos.slice(0, 3).map(video => ({
		fileId: video.id,
		filename: video.name,
		suspectedLocation: 'Hempstead',
		locationConfidence: 'high' as const,
		locationClues: 'Test entry',
		contentType: 'tennis_action' as const,
		activity: 'Test',
		quality: 'good' as const,
		indoorOutdoor: 'indoor' as const,
		suggestedModes: ['game_day' as const],
		thumbnailLink: video.thumbnailLink,
		needsManualReview: false,
	}));

	// Save fake catalog
	fs.writeFileSync(catalogPath, JSON.stringify(fakeEntries, null, 2), 'utf-8');
	console.log(`[TEST] Created fake catalog with ${fakeEntries.length} entries:`);
	fakeEntries.forEach(entry => console.log(`  - ${entry.filename}`));

	console.log('\n[TEST] Now if you run: npm run catalog:full or tsx run-full-catalog.ts');
	console.log('[TEST] It should skip these 3 videos and only process the rest.');
	console.log(`[TEST] Expected to skip: ${fakeEntries.length}`);
	console.log(`[TEST] Expected to process: ${videos.length - fakeEntries.length}`);
	console.log('\n[TEST] To reset and start fresh, delete: catalog-results.json');
}

testResumeLogic().catch(e => {
	console.error('[TEST] Failed:', e.message);
	process.exit(1);
});
