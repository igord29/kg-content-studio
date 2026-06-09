/**
 * Prior-render usage context for the v2 pipeline steps.
 *
 * The usage tracker (usage-tracker.ts) records which time regions of each
 * source video appeared in past renders. The v1 monolith prompt consumed
 * that data; the v2 steps did not — so every v2 render of the same footage
 * anchored on the same "best" timestamps and produced identical cuts.
 *
 * These helpers give each step:
 *   - the previously-used time regions for a source (to avoid), and
 *   - a code-level "best unused peak" pick so variety doesn't depend on
 *     the model choosing to disobey a stale hint.
 *
 * File: src/agent/video-editor/pipeline-v2/usage-context.ts
 */

import type { PipelineInput } from './types';

/** Buffer (seconds) around a previously-used region that still counts as "the same cut". */
const REUSE_BUFFER = 3;

/** Get prior-render used regions for a source, as [start, end] pairs. */
export function priorUsedRegions(input: PipelineInput, fileId: string): Array<[number, number]> {
	const summary = input.usageSummaries?.find(s => s.fileId === fileId);
	if (!summary || summary.usedRegions.length === 0) return [];
	return summary.usedRegions.map(r => [r.trimStart, r.trimEnd]);
}

/** True if timestamp t falls inside (or within REUSE_BUFFER of) any used region. */
export function isTimestampUsed(regions: Array<[number, number]>, t: number): boolean {
	return regions.some(([a, b]) => t >= a - REUSE_BUFFER && t <= b + REUSE_BUFFER);
}

/**
 * Format used regions for a prompt, or '' when there's no history.
 * Example output:
 *   PREVIOUSLY USED IN PAST RENDERS (avoid re-cutting, keep ≥3s away): 12s-21s, 47s-52s
 */
export function formatPriorUsage(input: PipelineInput, fileId: string): string {
	const regions = priorUsedRegions(input, fileId);
	if (regions.length === 0) return '';
	const formatted = regions.map(([a, b]) => `${Math.round(a)}s-${Math.round(b)}s`).join(', ');
	return `\n  🔁 PREVIOUSLY USED IN PAST RENDERS (avoid re-cutting these — keep ≥${REUSE_BUFFER}s away unless no alternative exists): ${formatted}`;
}
