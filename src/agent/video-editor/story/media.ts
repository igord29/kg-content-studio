/**
 * Footage access and ffmpeg helpers for Story Studio.
 *
 * Sources are read straight from Google Drive over HTTP range requests, so a
 * 500MB phone clip never has to be downloaded to the 5GB volume: ffmpeg seeks
 * to the few seconds it needs. For local testing, STORY_LOCAL_SOURCES can point
 * at a folder of <fileId>.mp4 files (a prefix of the id is enough).
 *
 * File: src/agent/video-editor/story/media.ts
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getAuth } from '../google-drive';

let cachedToken: { value: string; expires: number } | null = null;

export async function driveToken(): Promise<string> {
	if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
	const auth = getAuth();
	const res = await auth.authorize();
	const token = res.access_token;
	if (!token) throw new Error('Could not get a Google Drive access token');
	cachedToken = { value: token, expires: res.expiry_date ?? Date.now() + 50 * 60_000 };
	return token;
}

function localSource(fileId: string): string | null {
	const dir = process.env.STORY_LOCAL_SOURCES;
	if (!dir || !fs.existsSync(dir)) return null;
	const hit = fs.readdirSync(dir).find(f => f.endsWith('.mp4') && fileId.startsWith(f.replace(/\.mp4$/, '')));
	return hit ? path.join(dir, hit) : null;
}

/** ffmpeg/ffprobe input arguments for a Drive file (everything that goes before and including `-i`). */
export async function inputArgs(fileId: string, seek?: number): Promise<string[]> {
	const seekArgs = seek !== undefined ? ['-ss', seek.toFixed(3)] : [];
	const local = localSource(fileId);
	if (local) return [...seekArgs, '-i', local];
	const token = await driveToken();
	const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
	return ['-headers', `Authorization: Bearer ${token}\r\n`, '-reconnect', '1', '-reconnect_streamed', '1',
		'-reconnect_delay_max', '5', ...seekArgs, '-i', url];
}

export function run(bin: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '', stderr = '';
		p.stdout.on('data', d => { stdout += d; if (stdout.length > 8e6) stdout = stdout.slice(-4e6); });
		p.stderr.on('data', d => { stderr += d; if (stderr.length > 2e5) stderr = stderr.slice(-1e5); });
		const timer = opts.timeoutMs ? setTimeout(() => p.kill('SIGKILL'), opts.timeoutMs) : null;
		p.on('error', reject);
		p.on('close', code => {
			if (timer) clearTimeout(timer);
			if (code === 0) resolve({ stdout, stderr });
			else reject(new Error(`${bin} exited ${code}: ${stderr.slice(-1500)}`));
		});
	});
}

export const ffmpeg = (args: string[], timeoutMs = 20 * 60_000) =>
	run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args], { timeoutMs });

/** Display width/height (rotation applied) and duration of a source. */
export async function probe(fileId: string): Promise<{ width: number; height: number; duration: number }> {
	const args = (await inputArgs(fileId)).filter(a => a !== '-i');
	const input = args.pop()!;
	const { stdout } = await run('ffprobe', ['-v', 'error', ...args, '-select_streams', 'v:0', '-show_entries',
		'stream=width,height:stream_side_data=rotation:format=duration', '-of', 'json', input], { timeoutMs: 120_000 });
	const j = JSON.parse(stdout) as { streams: Array<{ width: number; height: number; side_data_list?: Array<{ rotation?: number }> }>; format: { duration: string } };
	const s = j.streams[0]!;
	const rot = Math.abs(Number(s.side_data_list?.find(d => d.rotation !== undefined)?.rotation ?? 0));
	const [w, h] = rot === 90 || rot === 270 ? [s.height, s.width] : [s.width, s.height];
	return { width: w, height: h, duration: parseFloat(j.format.duration) || 0 };
}

/** Durations of pause-free speech in an audio file, via silencedetect. */
export async function speechSpan(file: string): Promise<{ duration: number; firstSound: number; lastSound: number }> {
	const { stderr } = await run('ffmpeg', ['-nostdin', '-hide_banner', '-i', file, '-af', 'silencedetect=noise=-40dB:d=0.08', '-f', 'null', '-']);
	const dur = parseFloat(/Duration: (\d+):(\d+):([\d.]+)/.exec(stderr)?.slice(1).reduce((acc, v, i) => acc + parseFloat(v) * [3600, 60, 1][i]!, 0).toString() ?? '0');
	const starts = [...stderr.matchAll(/silence_start: ([\d.]+)/g)].map(m => parseFloat(m[1]!));
	const ends = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map(m => parseFloat(m[1]!));
	const firstSound = starts[0] === 0 || (starts[0] !== undefined && starts[0] < 0.02) ? (ends[0] ?? 0) : 0;
	const lastStart = starts.length > ends.length ? starts[starts.length - 1]! : dur;
	return { duration: dur, firstSound, lastSound: Math.min(dur, lastStart) };
}
