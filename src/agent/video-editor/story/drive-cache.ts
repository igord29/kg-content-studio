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
	const base = process.env.RAILWAY_VOLUME_MOUNT_PATH || (fs.existsSync('/data') ? '/data' : process.cwd());
	const d = path.join(base, 'story', 'drive-cache');
	fs.mkdirSync(d, { recursive: true });
	return d;
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
	if (fs.existsSync(f)) { const n = Number(fs.readFileSync(f, 'utf8')); sizes.set(fileId, n); return n; }
	const res = await driveFetch(fileId, 0, 1);
	await res.arrayBuffer();
	const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') || '')?.[1]);
	if (!total) throw new Error(`Drive gave no size for ${fileId}`);
	fs.mkdirSync(path.dirname(f), { recursive: true });
	fs.writeFileSync(f, String(total));
	sizes.set(fileId, total);
	return total;
}

function trim(): void {
	const root = cacheDir();
	const files: Array<{ p: string; size: number; t: number }> = [];
	for (const id of fs.readdirSync(root)) {
		const d = path.join(root, id);
		if (!fs.statSync(d).isDirectory()) continue;
		for (const f of fs.readdirSync(d)) {
			if (!f.endsWith('.bin')) continue;
			const st = fs.statSync(path.join(d, f));
			files.push({ p: path.join(d, f), size: st.size, t: st.atimeMs });
		}
	}
	let total = files.reduce((s, f) => s + f.size, 0);
	files.sort((a, b) => a.t - b.t);
	for (const f of files) {
		if (total <= LIMIT) break;
		try { fs.unlinkSync(f.p); total -= f.size; } catch { /* already gone */ }
	}
}

async function chunk(fileId: string, idx: number, total: number): Promise<Buffer> {
	const f = path.join(cacheDir(), fileId, `${idx}.bin`);
	if (fs.existsSync(f)) {
		const now = new Date();
		try { fs.utimesSync(f, now, now); } catch { /* best effort */ }
		return fs.readFileSync(f);
	}
	const key = `${fileId}:${idx}`;
	const running = inflight.get(key);
	if (running) return running;
	const p = (async () => {
		const a = idx * CHUNK, b = Math.min(total, a + CHUNK) - 1;
		let buf: Buffer | null = null;
		for (let attempt = 1; !buf; attempt++) {
			try {
				// One signal covers headers and body, so a stalled body read is aborted too.
				const res = await driveFetch(fileId, a, b, AbortSignal.timeout(FETCH_TIMEOUT_MS));
				buf = Buffer.from(await res.arrayBuffer());
			} catch (e) {
				if (attempt >= 3) throw e;
				console.error('[drive-cache] retry', attempt, fileId, idx, (e as Error).message.slice(0, 120));
				await new Promise(ok => setTimeout(ok, 2000 * attempt));
			}
		}
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f + '.part', buf);
		fs.renameSync(f + '.part', f);
		if (Math.random() < 0.05) trim();
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
			if (!res.write(buf.subarray(a, b))) await new Promise<void>(ok => res.once('drain', () => ok()));
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
