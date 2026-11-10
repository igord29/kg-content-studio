/**
 * The usage history must be global and survive a process restart — it used to
 * live in per-browser thread state, so the planner never saw past renders and
 * repeated the same cuts.
 *
 * Run: bun test-usage-store.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-store-'));
process.env.RAILWAY_VOLUME_MOUNT_PATH = dir;

const { appendUsageRecords, loadUsageRecords, loadUsageSummaries } = await import('./src/agent/video-editor/usage-store');
const { createClipUsageRecord } = await import('./src/agent/video-editor/usage-tracker');

let failures = 0;
const check = (label: string, ok: boolean): void => {
	console.log((ok ? '  PASS  ' : '  FAIL  ') + label);
	if (!ok) failures++;
};

check('empty history reads as no records', loadUsageRecords().length === 0);

const meta = { renderId: 'r1', editMode: 'game_day', platform: 'tiktok' };
appendUsageRecords([
	createClipUsageRecord({ fileId: 'a', trimStart: 10, duration: 4 }, meta),
	createClipUsageRecord({ fileId: 'b', trimStart: 0, duration: 3 }, meta),
]);
appendUsageRecords([createClipUsageRecord({ fileId: 'a', trimStart: 40, duration: 2 }, { ...meta, renderId: 'r2' })]);

check('records accumulate across writes', loadUsageRecords().length === 3);
check('history is on the persistent volume', fs.existsSync(path.join(dir, 'clip-usage.json')));

const a = loadUsageSummaries().find(s => s.fileId === 'a');
check('summary tracks both used regions of a source', a?.usedRegions.length === 2 && a.totalUses === 2);
check('a used source is less fresh than an unused one', (a?.freshnessScore ?? 1) < 1);

fs.writeFileSync(path.join(dir, 'clip-usage.json'), '{not json');
check('a corrupt file degrades to empty history instead of throwing', loadUsageRecords().length === 0);

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nUsage history is durable and global.' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
