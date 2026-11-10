/**
 * Durable, GLOBAL clip-usage store.
 *
 * Usage history used to live in per-thread state: it belonged to one browser
 * session and vanished with it. A new tab, a redeploy, the async edit path or a
 * headless auto-process run all started from an empty history, so the planner
 * had no idea which moments had already been published and re-picked the same
 * cuts every time.
 *
 * This keeps one history for the whole app in a JSON file on the persistent
 * volume (see resolvePersistentDir), so every path reads and writes the same
 * record of what has been used.
 *
 * File: src/agent/video-editor/usage-store.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolvePersistentDir } from './google-drive';
import { buildUsageSummaryMap, type ClipUsageRecord, type VideoUsageSummary } from './usage-tracker';

const FILE_NAME = 'clip-usage.json';
/** Roughly 300+ renders of history; old records age out of freshness anyway. */
const MAX_RECORDS = 5000;

function storePath(): string {
	return path.join(resolvePersistentDir(), FILE_NAME);
}

export function loadUsageRecords(): ClipUsageRecord[] {
	try {
		const raw = fs.readFileSync(storePath(), 'utf-8');
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? (parsed as ClipUsageRecord[]) : [];
	} catch {
		return []; // missing or unreadable file = no history yet
	}
}

export function appendUsageRecords(records: ClipUsageRecord[]): number {
	if (records.length === 0) return 0;
	const all = loadUsageRecords().concat(records).slice(-MAX_RECORDS);
	const target = storePath();
	const tmp = target + '.tmp';
	// Write-then-rename so a crash mid-write cannot leave a truncated history.
	fs.writeFileSync(tmp, JSON.stringify(all));
	fs.renameSync(tmp, target);
	return records.length;
}

export function loadUsageSummaries(): VideoUsageSummary[] {
	return Array.from(buildUsageSummaryMap(loadUsageRecords()).values());
}
