/**
 * Local read-through cache for Drive video files.
 *
 * ffmpeg opens a Drive file with "Range: bytes=0-" and seeks around in it. Drive
 * counts open-ended reads like that toward the file's download quota, so a few
 * hundred frame grabs or clip cuts made Drive answer "The download quota for this
 * file has been exceeded" (403) for every file for about a day.
 *
 * Instead, ffmpeg reads from this loopback proxy. The proxy serves any byte
 * range by assembling fixed 8 MB chunks; each chunk is fetched from Drive once
 * with a bounded range and kept on the volume, so seeking, re-reading the moov
 * atom, frame grabs and re-renders cost nothing after the first read. The cache
 * is trimmed (oldest first) to STORY_CACHE_GB, default 3.
 *
 * File: src/agent/video-editor/story/drive-cache.ts
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as http from 'http';
import * as path from 'path';
import type { AddressInfo } from 'net';

const CHUNK = 8 * 1024 * 1024;
const LIMIT = Number(process.env.STORY_CACHE_GB || 3) * 1024 ** 3;

let tokenFn: (() => Promise<string>) | null = null;
let server: http.Server | null = null;
let port = 0;
const sizes = new Map<string, number>();
const inflight = new Map<string, Promise<Buffer>>();

function cacheDir(): string {
	if (process.env.STORY_CACHE_DIR) return process.env.STORY_CACHE_DIR;
	const base = process.env.RAILWAY_VOLUME_MOUNT_PATH || (fs.existsSync('/data') ? '/data' : process.cwd());
	return path.join(base, 'story', 'drive-cache');
}

/** Every cache read and write is async and has a deadline. With synchronous fs calls a stuck volume froze the
 * whole server (even /options stopped answering, at 0% CPU) until it was restarted. If the volume does not
 * answer in time, the cache is switched off for a while and chunks are served straight from Drive. */
const IO_TIMEOUT_MS = Number(process.env.STORY_CACHE_IO_TIMEOUT_MS || 15_000);
const CACHE_OFF_MS = 10 * 60_000;
let cacheOffUntil = 0;
const cacheOn = () => Date.now() >= cacheOffUntil;

class IoTimeout extends Error {}
function io<T>(p: Promise<T>, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const deadline = new Promise<never>((_, no) => {
		timer = setTimeout(() => {
			cacheOffUntil = Date.now() + CACHE_OFF_MS;
			console.error(`[drive-cache] ${what} took over ${IO_TIMEOUT_MS} ms; serving from Drive without the cache for ${CACHE_OFF_MS / 60_000} min`);
			no(new IoTimeout(what));
		}, IO_TIMEOUT_MS);
	});
	return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/** Drive sometimes sends headers and then stalls the body indefinitely. Without a deadline that read never
 * settles, and because concurrent readers share the in-flight promise, every later request touching the same
 * chunk (often the moov atom) hangs until the process restarts. Each fetch therefore carries a deadline. */
const FETCH_TIMEOUT_MS = Number(process.env.STORY_DRIVE_TIMEOUT_MS || 60_000);

async function driveFetch(fileId: string, a: number, b: number, signal?: AbortSignal): Promise<Response> {
	const token = await tokenFn!();
	const res = await fetch(`${process.env.STORY_DRIVE_BASE || 'https://www.googleapis.com/drive/v3/files'}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
		{ headers: { Authorization: `Bearer ${token}`, Range: `bytes=${a}-${b}` }, signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!res.ok) {
		const body = (await res.text()).slice(0, 300);
		throw new Error(`Drive ${res.status} for ${fileId} bytes ${a}-${b}: ${body.replace(/\s+/g, ' ')}`);
	}
	return res;
}

async function sizeOf(fileId: string): Promise<number> {
	const known = sizes.get(fileId);
	if (known) return known;
	const f = path.join(cacheDir(), fileId, 'size');
	if (cacheOn()) {
		try {
			const n = Number(await io(fsp.readFile(f, 'utf8'), 'reading a cached size'));
			if (n > 0) { sizes.set(fileId, n); return n; }
		} catch { /* not cached, or the volume is slow: ask Drive */ }
	}
	const res = await driveFetch(fileId, 0, 1);
	await res.arrayBuffer();
	const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') || '')?.[1]);
	if (!total) throw new Error(`Drive gave no size for ${fileId}`);
	sizes.set(fileId, total);
	if (cacheOn()) {
		void io(fsp.mkdir(path.dirname(f), { recursive: true }).then(() => fsp.writeFile(f, String(total))), 'caching a size')
			.catch(() => { /* best effort */ });
	}
	return total;
}

let trimming: Promise<void> | null = null;

/** Delete the least recently used chunks until the cache is under `limit`. One trim runs at a time. */
function trim(limit = LIMIT): Promise<void> {
	if (trimming) return trimming;
	trimming = io((async () => {
		const root = cacheDir();
		const files: Array<{ p: string; size: number; t: number }> = [];
		for (const id of await fsp.readdir(root).catch(() => [] as string[])) {
			const d = path.join(root, id);
			const names = await fsp.readdir(d).catch(() => null);   // null: not a directory (or gone)
			if (!names) continue;
			for (const f of names) {
				// Half-written chunks from a failed write are never read again.
				if (f.endsWith('.part')) { await fsp.unlink(path.join(d, f)).catch(() => {}); continue; }
				if (!f.endsWith('.bin')) continue;
				const st = await fsp.stat(path.join(d, f)).catch(() => null);
				if (st) files.push({ p: path.join(d, f), size: st.size, t: st.atimeMs });
			}
		}
		let total = files.reduce((s, f) => s + f.size, 0);
		files.sort((x, y) => x.t - y.t);
		for (const f of files) {
			if (total <= limit) break;
			await fsp.unlink(f.p).then(() => { total -= f.size; }, () => {});
		}
	})(), 'trimming the cache')
		.catch(e => console.error('[drive-cache] trim failed:', (e as Error).message.slice(0, 120)))
		.finally(() => { trimming = null; });
	return trimming;
}

/** A chunk from the volume, or null if it is not there, is short, or the volume is not answering. */
async function cachedChunk(f: string, want: number, fileId: string, idx: number): Promise<Buffer | null> {
	if (!cacheOn()) return null;
	let cached: Buffer;
	try { cached = await io(fsp.readFile(f), 'reading a cached chunk'); }
	catch { return null; }   // missing (ENOENT) or the volume timed out
	// A short chunk shifts every byte after it, so ffmpeg sees broken NAL units at that spot on every
	// read until the chunk ages out. Drop it and fetch it again.
	if (cached.length !== want) {
		console.error('[drive-cache] dropping short cached chunk', fileId, idx, cached.length, 'of', want);
		void fsp.unlink(f).catch(() => {});
		return null;
	}
	const now = new Date();
	void fsp.utimes(f, now, now).catch(() => { /* best effort: keeps it from being trimmed first */ });
	return cached;
}

/** Caching is an optimisation and never delays a response: written in the background, and if the volume is
 * full it trims to half and tries once more. (Trimming only after successful writes meant a full volume was
 * never trimmed, and every request touching an uncached chunk failed with ENOSPC.) */
function saveChunk(f: string, buf: Buffer): void {
	if (!cacheOn()) return;
	const save = async () => {
		await fsp.mkdir(path.dirname(f), { recursive: true });
		await fsp.writeFile(f + '.part', buf);
		await fsp.rename(f + '.part', f);
	};
	void io(save(), 'writing a chunk')
		.catch(async e => {
			await fsp.unlink(f + '.part').catch(() => {});
			if (e instanceof IoTimeout || !cacheOn()) return;
			console.error('[drive-cache] cache write failed, trimming:', (e as Error).message.slice(0, 120));
			await trim(LIMIT / 2);
			await io(save(), 'writing a chunk').catch(() => fsp.unlink(f + '.part').catch(() => {}));
		})
		.then(() => { if (Math.random() < 0.05) void trim(); });
}

async function chunk(fileId: string, idx: number, total: number): Promise<Buffer> {
	const f = path.join(cacheDir(), fileId, `${idx}.bin`);
	const want = Math.min(total, (idx + 1) * CHUNK) - idx * CHUNK;
	const key = `${fileId}:${idx}`;
	const running = inflight.get(key);
	if (running) return running;
	const p = (async () => {
		const hit = await cachedChunk(f, want, fileId, idx);
		if (hit) return hit;
		const a = idx * CHUNK, b = Math.min(total, a + CHUNK) - 1;
		let buf: Buffer | null = null;
		for (let attempt = 1; !buf; attempt++) {
			try {
				// One signal covers headers and body, so a stalled body read is aborted too.
				const res = await driveFetch(fileId, a, b, AbortSignal.timeout(FETCH_TIMEOUT_MS));
				const got = Buffer.from(await res.arrayBuffer());
				// Drive can end a ranged body early without an error; never serve or cache a short chunk.
				if (got.length !== want) throw new Error(`short body ${got.length} of ${want}`);
				buf = got;
			} catch (e) {
				if (attempt >= 3) throw e;
				console.error('[drive-cache] retry', attempt, fileId, idx, (e as Error).message.slice(0, 120));
				await new Promise(ok => setTimeout(ok, 2000 * attempt));
			}
		}
		saveChunk(f, buf);
		return buf;
	})();
	inflight.set(key, p);
	try { return await p; } finally { inflight.delete(key); }
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	const m = /^\/drive\/([A-Za-z0-9_-]{10,})/.exec(req.url || '');
	if (!m) { res.writeHead(404).end(); return; }
	const fileId = m[1]!;
	let total: number;
	try { total = await sizeOf(fileId); } catch (e) { res.writeHead(502).end(String((e as Error).message)); return; }
	const r = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
	const start = r && r[1] ? Number(r[1]) : 0;
	const end = r && r[2] ? Math.min(total - 1, Number(r[2])) : total - 1;
	if (start >= total) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end(); return; }
	res.writeHead(r ? 206 : 200, {
		'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1),
		...(r ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
	});
	if (req.method === 'HEAD') { res.end(); return; }
	let closed = false;
	res.on('close', () => { closed = true; });
	try {
		for (let idx = Math.floor(start / CHUNK); idx <= Math.floor(end / CHUNK) && !closed; idx++) {
			const buf = await chunk(fileId, idx, total);
			const a = Math.max(start - idx * CHUNK, 0), b = Math.min(end - idx * CHUNK + 1, buf.length);
			// Wait for drain, or for the socket to close: ffmpeg killed by its timeout never drains,
			// and waiting on drain alone would hold this handler and its chunk buffers forever.
			if (!res.write(buf.subarray(a, b))) await new Promise<void>(ok => {
				const done = () => { res.off('drain', done); res.off('close', done); ok(); };
				res.on('drain', done); res.on('close', done);
			});
		}
		res.end();
	} catch (e) {
		console.error('[drive-cache]', (e as Error).message);
		res.destroy();
	}
}

/** URL ffmpeg should read instead of Drive. Starts the loopback proxy on first use. */
export async function cachedDriveUrl(fileId: string, getToken: () => Promise<string>): Promise<string> {
	tokenFn = getToken;
	if (!server) {
		server = http.createServer((req, res) => { void handle(req, res); });
		await new Promise<void>(ok => server!.listen(0, '127.0.0.1', () => ok()));
		port = (server.address() as AddressInfo).port;
	}
	return `http://127.0.0.1:${port}/drive/${fileId}`;
}
