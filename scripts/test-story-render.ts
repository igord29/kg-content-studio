/**
 * End-to-end check of the Story Studio renderer without any API keys:
 * a hand-built chess project (script lines, per-line voice cut from an
 * existing narration, synthetic footage index) → storyboard (greedy path) → render.
 *
 * usage: RAILWAY_VOLUME_MOUNT_PATH=<dir> STORY_LOCAL_SOURCES=<dir of clips> \
 *        STORY_TEST_VO=<narration.mp3> tsx scripts/test-story-render.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { ffmpeg } from '../src/agent/video-editor/story/media';
import { newProjectId, projectDir, saveProject } from '../src/agent/video-editor/story/store';
import { buildStoryboard, findRuns, planSlots } from '../src/agent/video-editor/story/storyboard';
import { renderStory } from '../src/agent/video-editor/story/build';
import { END_CARD } from '../src/agent/video-editor/story/voice';
import type { FootageMoment, StoryLine, StoryProject } from '../src/agent/video-editor/story/types';

const SEGS: Array<[number, number, string, number]> = [
	[0.00, 1.89, "It's Saturday, at the library.", 0.6],
	[2.36, 5.70, 'And for these kids, the real challenge is just getting started.', 0],
	[6.14, 7.22, 'Welcome to chess club.', 0.6],
	[7.77, 9.85, 'At first, the pieces are a mystery.', 0],
	[10.38, 11.55, 'Which way does the knight move?', 0],
	[13.96, 18.30, 'So they learn. One piece. One rule. One move at a time.', 0.4],
	[39.46, 42.97, 'These are skills that follow them back to the classroom, and into life.', 0.3],
	[49.41, 52.0, 'Follow us, to see where their next move takes them.', 0],
];
const EXTRA: Partial<StoryLine>[] = [
	{ emoji: '1f4da', emojiWord: 'library.', highlight: ['Saturday,', 'library.'], sfx: 'page-turn' },
	{ highlight: ['challenge'] },
	{ emoji: '265f-fe0f', emojiWord: 'chess', highlight: ['chess', 'club.'], title: 'CHESS CLUB', sfx: 'clack' },
	{ emoji: '1f9e9', emojiWord: 'mystery.', highlight: ['mystery.'] },
	{ emoji: '1f434', emojiWord: 'knight', highlight: ['knight'], sfx: 'clack' },
	{ highlight: ['piece.', 'rule.'], sfx: 'clack' },
	{ emoji: '1f3eb', emojiWord: 'classroom,', highlight: ['classroom,', 'life.'] },
	{ emoji: '1f440', emojiWord: 'Follow', highlight: ['Follow', 'next', 'move'] },
];

async function main() {
	const vo = process.env.STORY_TEST_VO!;
	const srcDir = process.env.STORY_LOCAL_SOURCES!;
	const now = new Date().toISOString();
	const p: StoryProject = {
		id: newProjectId(), createdAt: now, updatedAt: now, title: 'Chess Test', facts: 'test', audience: 'parents',
		callToAction: 'Follow us', targetSeconds: 40, videoIds: [], status: 'voiced',
		script: { openingTitle: 'SATURDAY @ THE LIBRARY', lines: SEGS.map(([, , text, pause], i) => ({ text, pauseAfter: pause, ...EXTRA[i] })) },
	};
	const vdir = path.join(projectDir(p.id), 'voice');
	fs.mkdirSync(vdir, { recursive: true });
	let cursor = 1.2;
	const segments = [];
	for (let i = 0; i < SEGS.length; i++) {
		const [a, b] = SEGS[i]!;
		const file = `line_${String(i).padStart(2, '0')}.wav`;
		await ffmpeg(['-i', vo, '-af', `atrim=${a}:${b + 0.15},asetpts=PTS-STARTPTS,aresample=48000`, '-ac', '1', path.join(vdir, file)]);
		segments.push({ line: i, start: +cursor.toFixed(3), end: +(cursor + b - a).toFixed(3), file });
		cursor += b - a + 0.3 + SEGS[i]![3];
	}
	p.voice = { provider: 'test', voiceId: 'test', segments, totalSeconds: +(segments.at(-1)!.end + 0.5 + END_CARD).toFixed(2) };

	// Synthetic index: every second of each local clip is "usable", subject placement varies.
	const moments: FootageMoment[] = [];
	const clips = fs.readdirSync(srcDir).filter(f => f.endsWith('.mp4')).slice(0, 8);
	p.sources = [];
	for (const f of clips) {
		const fileId = f.replace('.mp4', '') + 'TESTFILEID';
		p.videoIds.push(fileId);
		p.sources.push({ fileId, name: f, width: 0, height: 0, duration: 0 });
		for (let t = 2; t < 20; t++) moments.push({ fileId, t, people: 2 + (t % 2), quality: 2 + (t % 3 === 0 ? 1 : 0), action: t % 4 === 0 ? 'moving-piece' : 'thinking', x: 0.3 + (t % 5) / 10, desc: `${f} at ${t}s` });
	}
	console.log('runs', findRuns(moments).length, 'slots', planSlots(p).length);
	p.storyboard = await buildStoryboard(p, moments);
	p.storyboard[3]!.lift = true;
	p.storyboard[2]!.zoom = 1.15;
	console.log(p.storyboard.map(s => `${s.start.toFixed(2)} +${s.dur.toFixed(2)} L${s.line} ${s.fileId.slice(0, 6)}@${s.t} ${s.trans}`).join('\n'));
	saveProject(p);
	const t0 = Date.now();
	const out = await renderStory(p, m => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`));
	console.log(JSON.stringify(out), 'dir', path.join(projectDir(p.id), 'out'));
}
main().catch(e => { console.error(e); process.exit(1); });
