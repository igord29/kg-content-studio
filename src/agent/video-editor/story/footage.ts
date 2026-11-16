/**
 * Footage index for Story Studio: what is on screen, second by second.
 *
 * Each source is sampled at one frame per second, the frames are tiled into
 * labelled contact sheets, and a vision model tags every frame: how clearly a
 * person is in shot, what they are doing, whether the frame is usable (body-worn
 * cameras spend a lot of time on floors, walls and sleeves), and where the
 * subject sits horizontally — which is what lets the vertical crop follow the
 * kid instead of the empty middle of the frame.
 *
 * The index is cached per Drive file and shared across projects.
 *
 * File: src/agent/video-editor/story/footage.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { ffmpeg, inputArgs, probe } from './media';
import { assetDir, loadIndex, saveIndex } from './store';
import type { FootageMoment, SourceInfo } from './types';

const COLS = 6, ROWS = 4, PER_SHEET = COLS * ROWS;

export const ACTIONS = ['hitting', 'swinging', 'rally', 'serving', 'running', 'ready-stance', 'coach-teaching', 'coach-feeding',
	'playing-chess', 'moving-piece', 'thinking', 'smiling', 'celebrating', 'handshake', 'group', 'posing', 'talking',
	'reading', 'setup', 'walking', 'none'] as const;

const PROMPT = `These are frames from a youth program video (tennis, chess or reading), ${PER_SHEET} per sheet, left-to-right then top-to-bottom. Each frame is labelled with its time in seconds (yellow number, top-left).

For EVERY frame return one object:
- t: the yellow label
- people: 0 nobody visible, 1 people only far/small, 2 a person clearly visible at medium size, 3 close: a face or the action fills a good part of the frame
- quality: 0 unusable (lens blocked by a hand/sleeve/racket, mostly floor/ceiling/wall, motion blur), 1 weak, 2 fine, 3 great shot
- action: one of ${ACTIONS.join(', ')}
- x: horizontal position of the main subject from 0 (left edge) to 1 (right edge); 0.5 if centred or nobody
- y: vertical position of the subject's face or the action (hands, board, ball) from 0 (top) to 1 (bottom); 0.6 if nobody
- desc: at most 8 words, concrete (e.g. "girl swings forehand at coach's toss")

Return ONLY a JSON array.`;

async function tagSheet(img: Buffer, labels: number[]): Promise<FootageMoment[]> {
	const res = await generateText({
		model: anthropic('claude-sonnet-4-6'),
		messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image', image: img }] }],
		maxOutputTokens: 4000,
		abortSignal: AbortSignal.timeout(120_000),
	});
	const raw = res.text.trim();
	const arr = JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1)) as Array<Partial<FootageMoment>>;
	const byT = new Map(arr.map(m => [Math.round(Number(m.t)), m]));
	// Trust our own labels, not the model's: a frame it skipped is recorded as unusable.
	return labels.map(t => {
		const m = byT.get(t) ?? {};
		return {
			fileId: '', t,
			people: Math.max(0, Math.min(3, Math.round(Number(m.people) || 0))),
			quality: Math.max(0, Math.min(3, Math.round(Number(m.quality) || 0))),
			action: (ACTIONS as readonly string[]).includes(String(m.action)) ? String(m.action) : 'none',
			x: Math.max(0, Math.min(1, Number(m.x ?? 0.5) || 0.5)),
			y: Math.max(0, Math.min(1, Number(m.y ?? 0.6) || 0.6)),
			desc: String(m.desc ?? '').slice(0, 80),
		};
	});
}

/** Index one source (cached). */
export async function indexSource(fileId: string, name: string, log: (m: string) => void): Promise<{ source: SourceInfo; moments: FootageMoment[] }> {
	const cached = loadIndex(fileId);
	if (cached && cached.moments.length > 0) return cached;

	const info = await probe(fileId);
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'story-idx-'));
	try {
		const cellW = info.width >= info.height ? 320 : 240;
		const font = path.join(assetDir(), 'fonts', 'Montserrat-800.ttf');
		log(`Sampling ${name} (${Math.round(info.duration)}s)`);
		await ffmpeg([...(await inputArgs(fileId)), '-an',
			'-vf', `fps=1,scale=${cellW}:-2,drawtext=fontfile=${font}:text='%{eif\\:t\\:d}':fontcolor=yellow:fontsize=${Math.round(cellW / 9)}:x=4:y=4:borderw=3,tile=${COLS}x${ROWS}`,
			'-q:v', '4', path.join(work, 'sheet_%03d.jpg')], 30 * 60_000);
		const sheets = fs.readdirSync(work).filter(f => f.startsWith('sheet_')).sort();
		const total = Math.floor(info.duration);
		const moments: FootageMoment[] = [];
		// Tag sheets three at a time.
		for (let i = 0; i < sheets.length; i += 3) {
			const batch = sheets.slice(i, i + 3);
			log(`Watching ${name}: ${Math.min(i + 3, sheets.length)} / ${sheets.length} sheets`);
			const tagged = await Promise.all(batch.map((s, k) => {
				const first = (i + k) * PER_SHEET;
				const labels = Array.from({ length: PER_SHEET }, (_, j) => first + j).filter(t => t <= total);
				return tagSheet(fs.readFileSync(path.join(work, s)), labels).catch(() => labels.map(t => ({
					fileId, t, people: 0, quality: 0, action: 'none', x: 0.5, desc: 'not analysed',
				} as FootageMoment)));
			}));
			for (const ms of tagged) for (const m of ms) moments.push({ ...m, fileId });
		}
		const idx = { source: { fileId, name, ...info, indexedAt: new Date().toISOString() }, moments };
		saveIndex(idx);
		return idx;
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

/** A single frame as JPEG, for the storyboard UI. */
export async function frameJpeg(fileId: string, t: number, width = 360): Promise<Buffer> {
	const out = path.join(os.tmpdir(), `frame-${fileId.slice(0, 10)}-${Math.round(t * 10)}-${width}.jpg`);
	if (!fs.existsSync(out)) {
		await ffmpeg([...(await inputArgs(fileId, Math.max(0, t))), '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', out], 120_000);
	}
	return fs.readFileSync(out);
}
