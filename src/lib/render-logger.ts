/**
 * Render Logger
 *
 * Persists Remotion render pipeline events to Supabase (render_logs table).
 * Railway wipes runtime logs on container replacement, so this is our only
 * diagnostic trail for renders that happened >5 minutes ago.
 *
 * Design principles:
 *   - Fire-and-forget: every function swallows its own errors. Logging must
 *     NEVER crash the render pipeline. If Supabase is down, renders still work.
 *   - Idempotent where possible: updates use `.eq('render_id', id)` so retries
 *     are safe.
 *   - Minimal dependencies: only pulls in supabaseAdmin from lib/supabase.ts.
 *
 * Schema: see docs/render_logs_schema.sql
 *
 * File: src/lib/render-logger.ts
 */

import { supabaseAdmin } from './supabase';

// --- Types ---

export interface StageEvent {
	stage: string;                      // e.g. 's3_upload', 'lambda_submit'
	ts: string;                         // ISO timestamp
	ok: boolean;                        // success or failure
	durationMs?: number;                // how long the stage took
	error?: string;                     // error message if ok=false
	meta?: Record<string, unknown>;     // arbitrary extra data
}

export interface RenderLogInit {
	renderId: string;
	platform: string;
	mode: string;
	editPlan: unknown;                  // full edit plan (clips, overlays, music, etc.)
}

/** Input for buildClipDiagnostics — a clip from the edit plan. */
export interface ClipInput {
	fileId: string;
	filename?: string;
	trimStart?: number;
	duration?: number;
	purpose?: string;
	speed?: number;
}

/** Input for buildClipDiagnostics — result of the S3 upload step. */
export interface S3ClipInfo {
	fileId: string;
	s3Key: string;
	s3Url: string;
	sizeBytes: number;
}

// --- Helpers ---

/** True if Supabase is available and writes should proceed. */
function isEnabled(): boolean {
	return !!supabaseAdmin;
}

/** Swallow any error — logging must never break the pipeline. */
function safe(label: string, fn: () => Promise<void>): Promise<void> {
	return fn().catch((err) => {
		// eslint-disable-next-line no-console
		console.warn(`[render-logger] ${label} failed (non-fatal):`, err instanceof Error ? err.message : err);
	});
}

// --- Lifecycle Functions ---

/**
 * Insert the initial render_logs row.
 * Call this at the very start of the render pipeline, right after renderId
 * is generated.
 */
export async function logRenderStart(init: RenderLogInit): Promise<void> {
	if (!isEnabled()) return;
	await safe('logRenderStart', async () => {
		const { error } = await supabaseAdmin.from('render_logs').insert({
			render_id: init.renderId,
			platform: init.platform,
			mode: init.mode,
			edit_plan: init.editPlan,
			status: 'started',
			stages: [{ stage: 'started', ts: new Date().toISOString(), ok: true }],
		});
		if (error) throw new Error(error.message);
	});
}

/**
 * Append a stage event to the stages array.
 *
 * NOTE: This does a read-modify-write. It's safe for our pipeline because each
 * render has exactly one writer (the fire-and-forget async task in render.ts).
 * If we ever add concurrent writers, migrate this to a Postgres function that
 * appends atomically via jsonb || operator.
 */
export async function logStage(
	renderId: string,
	event: Omit<StageEvent, 'ts'>,
): Promise<void> {
	if (!isEnabled()) return;
	await safe('logStage', async () => {
		const stageEvent: StageEvent = { ...event, ts: new Date().toISOString() };

		const { data, error: readErr } = await supabaseAdmin
			.from('render_logs')
			.select('stages')
			.eq('render_id', renderId)
			.single();
		if (readErr) throw new Error(readErr.message);

		const stages = Array.isArray(data?.stages) ? [...(data.stages as StageEvent[])] : [];
		stages.push(stageEvent);

		const { error: updErr } = await supabaseAdmin
			.from('render_logs')
			.update({ stages })
			.eq('render_id', renderId);
		if (updErr) throw new Error(updErr.message);
	});
}

/**
 * Record per-clip diagnostics after the S3 upload stage.
 * This is the most important debug data for "same scene repeating" and
 * "clip missing from output" issues — you get to see exactly what got
 * uploaded, its S3 URL, and its size.
 */
export async function logClipDiagnostics(
	renderId: string,
	diagnostics: unknown,
): Promise<void> {
	if (!isEnabled()) return;
	await safe('logClipDiagnostics', async () => {
		const { error } = await supabaseAdmin
			.from('render_logs')
			.update({ clip_diagnostics: diagnostics, status: 'uploaded' })
			.eq('render_id', renderId);
		if (error) throw new Error(error.message);
	});
}

/**
 * Record Lambda submission — the Lambda render ID + the exact props we sent.
 * After this point, any failures are Lambda-side; the props row captures
 * precisely what we asked for so we can diff against what was actually rendered.
 */
export async function logRenderSubmitted(
	renderId: string,
	lambdaRenderId: string,
	remotionProps: unknown,
): Promise<void> {
	if (!isEnabled()) return;
	await safe('logRenderSubmitted', async () => {
		const { error } = await supabaseAdmin
			.from('render_logs')
			.update({
				lambda_render_id: lambdaRenderId,
				remotion_props: remotionProps,
				status: 'submitted',
			})
			.eq('render_id', renderId);
		if (error) throw new Error(error.message);
	});
}

/**
 * Terminal: render completed successfully.
 * Called from checkRemotionStatus() when Lambda reports 'done'.
 */
export async function logRenderDone(renderId: string, outputUrl: string): Promise<void> {
	if (!isEnabled()) return;
	await safe('logRenderDone', async () => {
		const { error } = await supabaseAdmin
			.from('render_logs')
			.update({
				status: 'done',
				output_url: outputUrl,
				completed_at: new Date().toISOString(),
			})
			.eq('render_id', renderId);
		if (error) throw new Error(error.message);
	});
}

/**
 * Terminal: render failed.
 * Called from failRender() and from checkRemotionStatus() on Lambda errors.
 */
export async function logRenderFailed(renderId: string, errorMsg: string): Promise<void> {
	if (!isEnabled()) return;
	await safe('logRenderFailed', async () => {
		const { error } = await supabaseAdmin
			.from('render_logs')
			.update({
				status: 'failed',
				error: errorMsg,
				completed_at: new Date().toISOString(),
			})
			.eq('render_id', renderId);
		if (error) throw new Error(error.message);
	});
}

// --- Per-Clip Diagnostics ---

/**
 * Build per-clip diagnostic data for the render_logs.clip_diagnostics column.
 *
 * This is the most important debug field for hunting down issues like
 * "same scene repeating" or "clip missing from output." It's called once
 * per render after the S3 upload step, and the result is persisted as
 * JSONB so you can query it later without re-running the render.
 *
 * The return value goes straight into Supabase — return an array of plain
 * objects (one per clip in the edit plan).
 *
 * TODO(IAN): Implement this function. See the prompt for guidance on which
 * fields matter most for your debugging workflow.
 *
 * @param clips - The clips from the edit plan (what Claude chose)
 * @param s3Clips - Map of fileId → S3 upload result (what got uploaded)
 * @returns JSON-serializable array of per-clip diagnostic objects
 */
export function buildClipDiagnostics(
	clips: ClipInput[],
	s3Clips: Map<string, S3ClipInfo>,
): unknown[] {
	// TODO: Return one object per clip. See the prompt for the decision points.
	return [];
}
