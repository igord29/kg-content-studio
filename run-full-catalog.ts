import * as fs from 'fs';
import * as path from 'path';
import { runFullCatalog, getCatalogSummary } from './src/agent/video-editor/cataloger';

async function main() {
  console.log('[CATALOG] Starting full catalog of all videos...');
  console.log('[CATALOG] This will take approximately 1.5-3 hours.');
  console.log('[CATALOG] Progress saves every 5 videos. Safe to interrupt.\n');

  const result = await runFullCatalog({}, (progress) => {
    console.log(`[${progress.completed}/${progress.total}] ${progress.currentFile || '?'} - ${progress.failed} failed`);
  });

  console.log('\n--- CATALOG COMPLETE ---');
  console.log(`Processed: ${result.completed}`);
  console.log(`Failed: ${result.failed}`);

  if (result.errors.length > 0) {
    console.log(`\nErrors (${result.errors.length}):`);
    result.errors.forEach(e => console.log(`  ${e.filename}: ${e.error}`));
  }

  // Save local copy of full results
  const localPath = path.join(process.cwd(), 'catalog-results.json');
  try {
    fs.writeFileSync(localPath, JSON.stringify(result.catalog, null, 2), 'utf-8');
    console.log(`\n[CATALOG] Results saved to: ${localPath}`);
  } catch (err) {
    console.error('[CATALOG] Failed to save local results:', err);
  }

  const summary = getCatalogSummary(result.catalog);
  console.log('\n--- SUMMARY ---');
  console.log('By Location:', JSON.stringify(summary.byLocation, null, 2));
  console.log('By Content Type:', JSON.stringify(summary.byContentType, null, 2));
  console.log('By Quality:', JSON.stringify(summary.byQuality, null, 2));
  console.log('Needs Review:', summary.needsReview);
  console.log('Confidence:', JSON.stringify(summary.confidenceBreakdown, null, 2));
  console.log('With Readable Text:', summary.withReadableText);
}

main().catch(e => { console.log('[FAIL]', e.message); process.exit(1); });
