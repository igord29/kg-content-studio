/**
 * Quick test script for Google Drive integration
 * Tests connection and lists available videos
 */

import { testConnection, getFolderSummary, listVideoFiles } from './src/agent/video-editor/google-drive';

async function main() {
  console.log('[TEST] Testing Google Drive Connection...\n');

  // Test connection
  console.log('[1] Testing connection...');
  const connectionResult = await testConnection();
  console.log(`   Status: ${connectionResult.success ? '[PASS]' : '[FAIL]'}`);
  console.log(`   Message: ${connectionResult.message}\n`);

  if (!connectionResult.success) {
    console.error('[FAIL] Connection failed. Please check your credentials and environment variables.');
    process.exit(1);
  }

  // Get folder summary
  console.log('[2] Getting folder summary...');
  try {
    const summary = await getFolderSummary();
    console.log(`   Total Videos: ${summary.totalFiles}`);
    console.log(`   Total Size: ${summary.totalSizeGB} GB`);
    console.log('   Video Formats:');
    Object.entries(summary.videoFormats).forEach(([format, count]) => {
      console.log(`      - ${format}: ${count} file(s)`);
    });
    console.log(`   Date Range: ${summary.dateRange.earliest} to ${summary.dateRange.latest}`);
  } catch (err) {
    console.error('[FAIL] Error getting folder summary:', err);
    process.exit(1);
  }

  // List first 5 video files
  console.log('\n[3] Listing first 5 video files...');
  try {
    const videos = await listVideoFiles();
    const sample = videos.slice(0, 5);
    sample.forEach((v, i) => {
      console.log(`   ${i + 1}. ${v.name} (${v.mimeType}, ${(parseInt(v.size) / (1024 * 1024)).toFixed(1)} MB)`);
    });
    if (videos.length > 5) {
      console.log(`   ... and ${videos.length - 5} more`);
    }
  } catch (err) {
    console.error('[FAIL] Error listing video files:', err);
    process.exit(1);
  }

  console.log('\n[PASS] Test completed successfully!');
}

// Run the test
main().catch((err) => {
  console.error('[FAIL] Unexpected error:', err);
  process.exit(1);
});
