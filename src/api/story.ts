/**
 * Story Studio API: narrated social videos, step by step.
 *
 *   GET    /story/footage[?folder=<Drive folder id or link>]  footage to pick from
 *   GET    /story/probe?fileId=                               size and length of a source
 *   GET    /story/clip?fileId=&t=&d=                          up to 20s of a source, original quality
 *   GET    /story/options                                      voices, emoji, sound effects, transitions
 *   GET    /story/projects                                     list
 *   POST   /story/projects                                     create
 *   GET    /story/projects/:id                                 read (job progress lives here)
 *   PUT    /story/projects/:id                                 edit fields / script / storyboard
 *   DELETE /story/projects/:id
 *   POST   /story/projects/:id/script                          write the script (sync)
 *   POST   /story/projects/:id/voice      {provider, voice}    job: voice every line
 *   POST   /story/projects/:id/storyboard                      job: watch footage + pick shots
 *   POST   /story/projects/:id/render                          job: render everything
 *   GET    /story/projects/:id/files/:name                     finished files (range requests)
 *   GET    /story/projects/:id/voice/:name                     voiced lines
 *   GET    /story/frame?fileId=&t=&w=                          a frame, for the storyboard
 *
 * File: src/api/story.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Context } from 'hono';
import { loadExistingCatalog } from '../agent/video-editor/cataloger';
import { getVideoMetadata, listAllVideoFilesRecursive } from '../agent/video-editor/google-drive';
import { availableEmoji, deleteProject, listProjects, loadIndex, loadProject, newProjectId, projectDir, saveProject, updateProject } from '../agent/video-editor/story/store';
import { EMOJI_NAMES, SFX_NAMES, writeScript } from '../agent/video-editor/story/script';
import { voiceOptions, voiceScript } from '../agent/video-editor/story/voice';
import { frameJpeg, indexSource } from '../agent/video-editor/story/footage';
import { driveToken, ffmpeg, inputArgs, probe } from '../agent/video-editor/story/media';
import * as os from 'os';
import { buildStoryboard } from '../agent/video-editor/story/storyboard';
import { renderStory } from '../agent/video-editor/story/build';
import type { FootageMoment, SourceInfo, StoryLine, StoryProject } from '../agent/video-editor/story/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Router = { get: (...a: any[]) => any; post: (...a: any[]) => any; put: (...a: any[]) => any; delete: (...a: any[]) => any };

/** Jobs running in this process. A project that says "running" but isn't here was cut off by a restart. */
const running = new Set<string>();

function fresh(id: string): StoryProject | null {
	const p = loadProject(id);
	if (p?.job?.state === 'running' && !running.has(id)) {
		return updateProject(id, q => { q.job = { ...q.job!, state: 'failed', error: 'The server restarted during this step. Run it again.' }; });
	}
	return p;
}

function startJob(id: string, step: string, work: (log: (m: string) => void) => Promise<(p: StoryProject) => void>): boolean {
	if (running.has(id)) return false;
	running.add(id);
	updateProject(id, p => { p.job = { step, state: 'running', progress: 'Starting', startedAt: new Date().toISOString() }; });
	const log = (m: string) => {
		try { updateProject(id, p => { if (p.job) p.job.progress = m; }); } catch { /* project deleted */ }
		console.log(`[story ${id}] ${step}: ${m}`);
	};
	void (async () => {
		try {
			const apply = await work(log);
			updateProject(id, p => { apply(p); p.job = { ...p.job!, state: 'done', progress: 'Done' }; });
		} catch (e) {
			const msg = (e as Error).message || String(e);
			console.error(`[story ${id}] ${step} failed:`, msg);
			try { updateProject(id, p => { p.job = { ...p.job!, state: 'failed', error: msg.slice(0, 1500) }; }); } catch { /* deleted */ }
		} finally {
			running.delete(id);
		}
	})();
	return true;
}

const folderIdFrom = (s: string) => /folders\/([A-Za-z0-9_-]+)/.exec(s)?.[1] ?? /[?&]id=([A-Za-z0-9_-]+)/.exec(s)?.[1] ?? s.trim();

function serveFile(c: Context, file: string, type: string): Response {
	if (!fs.existsSync(file)) return c.text('Not found', 404);
	const size = fs.statSync(file).size;
	const range = c.req.header('range');
	const headers: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
	if (c.req.query('download')) headers['Content-Disposition'] = `attachment; filename="${path.basename(file)}"`;
	const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
	if (m) {
		const start = m[1] ? parseInt(m[1]) : Math.max(0, size - parseInt(m[2] || '0'));
		const end = m[1] && m[2] ? Math.min(size - 1, parseInt(m[2])) : size - 1;
		if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
		const buf = Buffer.alloc(end - start + 1);
		const fd = fs.openSync(file, 'r');
		try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
		return new Response(new Uint8Array(buf), { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(buf.length) } });
	}
	return new Response(new Uint8Array(fs.readFileSync(file)), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
}

const TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.srt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.wav': 'audio/wav' };
const safeName = (n: string) => /^[A-Za-z0-9._-]+$/.test(n) && !n.startsWith('.');

export function registerStoryRoutes(api: Router): void {
	api.get('/story/footage', async (c: Context) => {
		const folder = c.req.query('folder');
		try {
			if (folder) {
				const files = await listAllVideoFilesRecursive(folderIdFrom(folder));
				return c.json({ videos: files.map(f => ({ fileId: f.id, name: f.name, thumbnail: f.thumbnailLink, created: f.createdTime, indexed: !!loadIndex(f.id) })) });
			}
			const catalog = loadExistingCatalog();
			return c.json({
				videos: catalog.map(e => ({
					fileId: e.fileId, name: e.filename, thumbnail: e.thumbnailLink, duration: e.duration,
					activity: e.activity, location: e.suspectedLocation, contentType: e.contentType, quality: e.quality,
					indexed: !!loadIndex(e.fileId),
				})),
			});
		} catch (e) {
			return c.json({ videos: [], error: (e as Error).message }, 500);
		}
	});

	api.get('/story/options', (c: Context) => c.json({
		voices: voiceOptions(),
		emoji: availableEmoji().map(code => ({ code, name: EMOJI_NAMES[code] ?? code })),
		sfx: SFX_NAMES,
		transitions: ['cut', 'zoomin', 'fadewhite', 'slideleft', 'slideup', 'smoothleft', 'wipeleft'],
	}));

	api.get('/story/projects', (c: Context) => c.json({
		projects: listProjects().map(p => ({ id: p.id, title: p.title, status: p.status, updatedAt: p.updatedAt, job: p.job, outputs: p.outputs })),
	}));

	api.post('/story/projects', async (c: Context) => {
		const b = await c.req.json().catch(() => ({})) as Partial<StoryProject>;
		const now = new Date().toISOString();
		const p: StoryProject = {
			id: newProjectId(), createdAt: now, updatedAt: now,
			title: String(b.title || 'Untitled story').slice(0, 120),
			facts: String(b.facts || ''),
			audience: String(b.audience || 'Parents and donors'),
			callToAction: String(b.callToAction || 'Follow us to see more of the journey.'),
			targetSeconds: Math.max(15, Math.min(120, Number(b.targetSeconds) || 60)),
			cardText: b.cardText ? String(b.cardText).slice(0, 40) : undefined,
			videoIds: Array.isArray(b.videoIds) ? b.videoIds.map(String).slice(0, 12) : [],
			status: 'draft',
		};
		return c.json(saveProject(p));
	});

	api.get('/story/projects/:id', (c: Context) => {
		const p = fresh(c.req.param('id')!);
		return p ? c.json(p) : c.text('Not found', 404);
	});

	api.put('/story/projects/:id', async (c: Context) => {
		const id = c.req.param('id')!;
		if (running.has(id)) return c.json({ error: 'A step is still running' }, 409);
		const b = await c.req.json().catch(() => ({})) as Partial<StoryProject>;
		try {
			const p = updateProject(id, q => {
				for (const k of ['title', 'facts', 'audience', 'callToAction', 'cardText'] as const) if (typeof b[k] === 'string') q[k] = b[k] as string;
				if (b.targetSeconds) q.targetSeconds = Math.max(15, Math.min(120, Number(b.targetSeconds)));
				if (Array.isArray(b.videoIds)) {
					const changed = b.videoIds.join() !== q.videoIds.join();
					q.videoIds = b.videoIds.map(String).slice(0, 12);
					if (changed && q.storyboard) { q.storyboard = undefined; if (q.status !== 'draft' && q.status !== 'scripted') q.status = 'voiced'; }
				}
				if (b.script?.lines) {
					const lines = b.script.lines.filter((l: StoryLine) => l.text?.trim());
					const wordsChanged = lines.map((l: StoryLine) => l.text.trim()).join('\n') !== (q.script?.lines ?? []).map(l => l.text).join('\n')
						|| lines.map((l: StoryLine) => l.pauseAfter ?? 0).join() !== (q.script?.lines ?? []).map(l => l.pauseAfter ?? 0).join();
					q.script = { lines, openingTitle: b.script.openingTitle ?? q.script?.openingTitle };
					// New words need a new voice-over, and the shots follow the voice.
					if (wordsChanged) { q.voice = undefined; q.storyboard = undefined; q.status = 'scripted'; }
				}
				if (Array.isArray(b.storyboard) && q.storyboard) {
					if (JSON.stringify(b.storyboard) !== JSON.stringify(q.storyboard) && q.status === 'rendered') q.status = 'storyboarded';
					q.storyboard = b.storyboard;
				}
			});
			return c.json(p);
		} catch (e) {
			return c.json({ error: (e as Error).message }, 404);
		}
	});

	api.delete('/story/projects/:id', (c: Context) => {
		const id = c.req.param('id')!;
		if (running.has(id)) return c.json({ error: 'A step is still running' }, 409);
		deleteProject(id);
		return c.json({ ok: true });
	});

	api.post('/story/projects/:id/script', async (c: Context) => {
		const id = c.req.param('id')!;
		const p = fresh(id);
		if (!p) return c.text('Not found', 404);
		if (!p.facts.trim()) return c.json({ error: 'Add what happened first' }, 400);
		try {
			const script = await writeScript(p);
			return c.json(updateProject(id, q => { q.script = script; q.voice = undefined; q.storyboard = undefined; q.status = 'scripted'; }));
		} catch (e) {
			return c.json({ error: 'Script failed: ' + (e as Error).message }, 500);
		}
	});

	api.post('/story/projects/:id/voice', async (c: Context) => {
		const id = c.req.param('id')!;
		const p = fresh(id);
		if (!p) return c.text('Not found', 404);
		if (!p.script?.lines.length) return c.json({ error: 'Write the script first' }, 400);
		const b = await c.req.json().catch(() => ({})) as { provider?: string; voice?: string };
		const opts = voiceOptions();
		const provider = opts.find(o => o.provider === b.provider) ?? opts[0];
		if (!provider) return c.json({ error: 'No voice provider configured (add ELEVENLABS_API_KEY or OPENAI_API_KEY)' }, 400);
		const voice = b.voice && provider.voices.includes(b.voice) ? b.voice : provider.default;
		const ok = startJob(id, 'voice', async log => {
			const v = await voiceScript(p, provider.provider, voice, log);
			return q => { q.voice = { provider: provider.provider, voiceId: voice, ...v }; q.storyboard = undefined; q.status = 'voiced'; };
		});
		return ok ? c.json(fresh(id)) : c.json({ error: 'A step is already running' }, 409);
	});

	api.post('/story/projects/:id/storyboard', (c: Context) => {
		const id = c.req.param('id')!;
		const p = fresh(id);
		if (!p) return c.text('Not found', 404);
		if (!p.voice) return c.json({ error: 'Record the voice-over first' }, 400);
		if (!p.videoIds.length) return c.json({ error: 'Pick some footage first' }, 400);
		const ok = startJob(id, 'storyboard', async log => {
			const sources: SourceInfo[] = [];
			const moments: FootageMoment[] = [];
			let k = 0;
			for (const fileId of p.videoIds) {
				k++;
				let name = fileId;
				try { name = (await getVideoMetadata(fileId)).name || fileId; } catch { /* keep the id */ }
				log(`Watching footage ${k} of ${p.videoIds.length}: ${name}`);
				try {
					const idx = await indexSource(fileId, name, m => log(`(${k}/${p.videoIds.length}) ${m}`));
					sources.push(idx.source);
					moments.push(...idx.moments);
				} catch (e) {
					log(`Skipped ${name}: ${(e as Error).message.slice(0, 200)}`);
				}
			}
			if (!sources.length) throw new Error('None of the selected videos could be read from Drive');
			log('Picking a shot for every line');
			const storyboard = await buildStoryboard({ ...p, sources }, moments);
			return q => { q.sources = sources; q.storyboard = storyboard; q.status = 'storyboarded'; };
		});
		return ok ? c.json(fresh(id)) : c.json({ error: 'A step is already running' }, 409);
	});

	api.post('/story/projects/:id/render', (c: Context) => {
		const id = c.req.param('id')!;
		const p = fresh(id);
		if (!p) return c.text('Not found', 404);
		if (!p.storyboard?.length) return c.json({ error: 'Build the storyboard first' }, 400);
		const ok = startJob(id, 'render', async log => {
			const outputs = await renderStory(p, log);
			return q => { q.outputs = outputs; q.status = 'rendered'; };
		});
		return ok ? c.json(fresh(id)) : c.json({ error: 'A step is already running' }, 409);
	});

	api.get('/story/projects/:id/files/:name', (c: Context) => {
		const name = c.req.param('name')!;
		if (!safeName(name)) return c.text('Bad name', 400);
		const file = path.join(projectDir(c.req.param('id')!), 'out', name);
		return serveFile(c, file, TYPES[path.extname(name)] ?? 'application/octet-stream');
	});

	api.get('/story/projects/:id/voice/:name', (c: Context) => {
		const name = c.req.param('name')!;
		if (!safeName(name)) return c.text('Bad name', 400);
		return serveFile(c, path.join(projectDir(c.req.param('id')!), 'voice', name), 'audio/wav');
	});

	/** Can the service account download this file right now? Returns Drive's own status and error reason. */
	api.get('/story/drive-check', async (c: Context) => {
		const fileId = c.req.query('fileId') || '';
		if (!/^[A-Za-z0-9_-]{10,}$/.test(fileId)) return c.text('Bad file id', 400);
		const token = await driveToken();
		const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
			{ headers: { Authorization: `Bearer ${token}`, Range: c.req.query('range') || 'bytes=0-15', ...(c.req.query('ua') ? { 'User-Agent': c.req.query('ua')! } : {}) } });
		if (r.ok && r.body) await r.body.cancel();
		const body = r.ok ? '' : (await r.text()).slice(0, 600);
		return c.json({ status: r.status, ok: r.ok, body });
	});

	/** Size and length of a Drive video, so an editor can plan crops before cutting. */
	api.get('/story/probe', async (c: Context) => {
		const fileId = c.req.query('fileId') || '';
		if (!/^[A-Za-z0-9_-]{10,}$/.test(fileId)) return c.text('Bad file id', 400);
		try { return c.json(await probe(fileId)); } catch (e) { return c.text('Probe failed: ' + (e as Error).message.slice(0, 200), 500); }
	});

	/** A few seconds of a Drive video at full resolution (original stream, no re-encode) for hand editing. */
	api.get('/story/clip', async (c: Context) => {
		const fileId = c.req.query('fileId') || '';
		if (!/^[A-Za-z0-9_-]{10,}$/.test(fileId)) return c.text('Bad file id', 400);
		const t = Math.max(0, Number(c.req.query('t')) || 0);
		const d = Math.max(0.5, Math.min(20, Number(c.req.query('d')) || 5));
		const out = path.join(os.tmpdir(), `clip-${fileId.slice(0, 12)}-${Math.round(t * 100)}-${Math.round(d * 100)}${c.req.query('audio') === '1' ? '-a' : ''}.mp4`);
		try {
			if (!fs.existsSync(out)) {
				const tmp = out + '.part.mp4';
				// Stream copy: no re-encode (4K HEVC encodes are too slow and memory-hungry for a request).
				// The cut snaps back to the keyframe before t, so callers should ask for a second of lead.
				// Video only unless ?audio=1: interleaved audio makes ffmpeg hop around the remote file and crawl.
				await ffmpeg([...(await inputArgs(fileId, t)), '-t', d.toFixed(3), '-map', '0:v:0', ...(c.req.query('audio') === '1' ? ['-map', '0:a:0?'] : ['-an']),
					'-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', tmp], 240_000);
				fs.renameSync(tmp, out);
			}
			// Not kept: a 20 s 4K cut is ~150 MB and the container's temp space counts against its memory,
			// so cached cuts pile up until the service stalls.
			const body = fs.readFileSync(out);
			fs.rmSync(out, { force: true });
			return new Response(new Uint8Array(body), { headers: { 'Content-Type': 'video/mp4' } });
		} catch (e) {
			return c.text('Clip failed: ' + (e as Error).message.slice(0, 300), 500);
		}
	});

	api.get('/story/frame', async (c: Context) => {
		const fileId = c.req.query('fileId') || '';
		if (!/^[A-Za-z0-9_-]{10,}$/.test(fileId)) return c.text('Bad file id', 400);
		const t = Math.max(0, Number(c.req.query('t')) || 0);
		const w = Math.max(120, Math.min(2400, Number(c.req.query('w')) || 320));
		try {
			const jpg = await frameJpeg(fileId, t, w);
			return new Response(new Uint8Array(jpg), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } });
		} catch (e) {
			return c.text('Frame failed: ' + (e as Error).message.slice(0, 200), 500);
		}
	});
}
