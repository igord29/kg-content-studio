/**
 * Story Studio renderer: storyboard + voice → finished 9:16 and 16:9 videos.
 *
 * This is the pipeline the hand-made CLC story videos were built with:
 *   1. every shot is cut from its source (streamed from Drive), locked to 30fps
 *      (phone footage is variable-frame-rate and smears under stabilisation
 *      otherwise), stabilised, framed on the subject, graded and sharpened;
 *      portrait sources in the 16:9 cut sit on a blurred copy of themselves;
 *   2. shots are joined with xfade transitions that start on the nominal cut
 *      and run into the next shot's tail, so cuts stay on the narration;
 *   3. the assembler adds karaoke captions (spoken word scaled up, key words
 *      yellow), title slams, emoji pops, a progress bar, watermark, the green
 *      logo end card, the per-line voice-over, sound effects and loudness
 *      normalisation to -14 LUFS;
 *   4. plus captions .srt, thumbnails and post copy.
 *
 * File: src/agent/video-editor/story/build.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { ffmpeg, inputArgs, run } from './media';
import { assetDir, projectDir } from './store';
import { footageEnd, LEAD_IN } from './voice';
import { writePostKit } from './script';
import type { Shot, StoryOutputs, StoryProject } from './types';

type Aspect = 'v' | 'w';
const SIZE: Record<Aspect, [number, number]> = { v: [1080, 1920], w: [1920, 1080] };
const GRADE = 'eq=brightness=0.04:contrast=1.08:saturation=1.15:gamma=1.08';
const LIFT = 'eq=gamma=1.35:brightness=0.06:contrast=1.05:saturation=1.1';
const TRANS_LEN = 0.35;
const FPS = 30;

const YELLOW = '&H0047D5F5&';
const GREEN_BGR = '&H003E4D1B';

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
		while (next < items.length) { const i = next++; await fn(items[i]!, i); }
	}));
}

async function probeLocal(file: string): Promise<{ w: number; h: number; dur: number; audio: boolean }> {
	const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:stream_side_data=rotation:format=duration', '-of', 'json', file]);
	const j = JSON.parse(stdout) as { streams: Array<{ codec_type: string; width?: number; height?: number; side_data_list?: Array<{ rotation?: number }> }>; format: { duration: string } };
	const v = j.streams.find(s => s.codec_type === 'video')!;
	const rot = Math.abs(Number(v.side_data_list?.find(d => d.rotation !== undefined)?.rotation ?? 0));
	const [w, h] = rot === 90 || rot === 270 ? [v.height!, v.width!] : [v.width!, v.height!];
	return { w, h, dur: parseFloat(j.format.duration) || 0, audio: j.streams.some(s => s.codec_type === 'audio') };
}

/** Shot timing made consistent: back-to-back from 0 and ending exactly where the end card starts. */
export function normaliseShots(p: StoryProject): Shot[] {
	const shots = (p.storyboard ?? []).map(s => ({ ...s }));
	if (shots.length === 0) throw new Error('Build the storyboard first');
	const end = footageEnd(p);
	let t = 0;
	for (const s of shots) { s.start = +t.toFixed(3); s.dur = Math.max(0.5, s.dur); t += s.dur; }
	const last = shots[shots.length - 1]!;
	last.dur = Math.max(0.5, +(end - last.start).toFixed(3));
	last.trans = 'cut';
	return shots;
}

const tailOf = (s: Shot) => (!s.trans || s.trans === 'cut' ? 1 / FPS : s.trans === 'fadewhite' ? 0.3 : TRANS_LEN);

/** Cut, stabilise, frame and grade one shot, for both aspects. */
async function buildShot(s: Shot, i: number, work: string): Promise<void> {
	const len = s.dur + tailOf(s);
	const pad = 0.5; // stabiliser warm-up so the first frames are steady too
	const ss = Math.max(0, s.t - pad);
	const lead = s.t - ss;
	const raw = path.join(work, `raw_${i}.mp4`);
	await ffmpeg([...(await inputArgs(s.fileId, ss)), '-t', (len + lead + 0.2).toFixed(3), '-map', '0:v:0', '-map', '0:a:0?',
		'-vf', `fps=${FPS}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-c:a', 'aac', '-ar', '48000', '-ac', '2', raw], 10 * 60_000);
	const info = await probeLocal(raw);
	const trf = path.join(work, `shot_${i}.trf`);
	await ffmpeg(['-i', raw, '-vf', `vidstabdetect=shakiness=8:accuracy=15:result=${trf}`, '-f', 'null', '-']);

	for (const a of ['v', 'w'] as Aspect[]) {
		const [OW, OH] = SIZE[a];
		const srcAspect = info.w / info.h;
		const pillar = a === 'w' && srcAspect < 1.2;
		const target = pillar ? srcAspect : OW / OH;
		let cw = srcAspect < target ? info.w : info.h * target;
		let ch = srcAspect < target ? info.w / target : info.h;
		// Body cameras tilt up: vertical cuts of landscape footage get an extra push-in so the
		// crop can drop below the ceiling (1440p sources still upscale less than 1.7x).
		const zoom = Math.max(1, s.zoom || 1) * (a === 'v' && srcAspect > 1.2 ? 1.12 : 1);
		cw = Math.floor(cw / zoom / 2) * 2; ch = Math.floor(ch / zoom / 2) * 2;
		const x = Math.round(Math.max(0, Math.min(info.w - cw, (s.x ?? 0.5) * info.w - cw / 2)));
		const y = Math.round(Math.max(0, Math.min(info.h - ch, (s.y ?? 0.6) * info.h - ch / 2)));
		const look = `${GRADE},${s.lift ? LIFT : 'null'},unsharp=5:5:0.6:5:5:0.3`;
		const head = `[0:v]vidstabtransform=input=${trf}:zoom=3:smoothing=12:interpol=bicubic,crop=${cw}:${ch}:${x}:${y}`;
		const tailF = `trim=start=${lead.toFixed(3)}:duration=${len.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p[vo]`;
		const vf = pillar
			? `${head},${look},split[a][b];[a]scale=${OW}:${OH}:force_original_aspect_ratio=increase,crop=${OW}:${OH},gblur=sigma=40,eq=brightness=-0.12:saturation=0.8[bg];` +
			  `[b]scale=-2:${OH}:flags=lanczos[fg];[bg][fg]overlay=(W-w)/2:0,${tailF}`
			: `${head},scale=${OW}:${OH}:flags=lanczos,${look},${tailF}`;
		const audio = info.audio
			? `[0:a]atrim=start=${lead.toFixed(3)}:duration=${len.toFixed(3)},asetpts=PTS-STARTPTS[ao]`
			: `anullsrc=r=48000:cl=stereo,atrim=duration=${len.toFixed(3)}[ao]`;
		await ffmpeg(['-i', raw, '-filter_complex', `${vf};${audio}`, '-map', '[vo]', '-map', '[ao]',
			'-c:v', 'libx264', '-preset', 'fast', '-crf', '17', '-c:a', 'aac', '-b:a', '192k', '-t', len.toFixed(3),
			path.join(work, `${a}_${String(i).padStart(2, '0')}.mp4`)]);
	}
	fs.rmSync(raw, { force: true });
	fs.rmSync(trf, { force: true });
}

/** Join shots, each transition starting on its nominal cut and running into the shot's tail. */
async function chain(shots: Shot[], work: string, a: Aspect, out: string): Promise<void> {
	const n = shots.length;
	const inputs: string[] = [];
	const fc: string[] = [];
	for (let i = 0; i < n; i++) {
		inputs.push('-i', path.join(work, `${a}_${String(i).padStart(2, '0')}.mp4`));
		// Frame rounding can leave a shot one frame short, and a short shot stops xfade dead.
		fc.push(`[${i}:v]settb=1/${FPS},setpts=PTS-STARTPTS,fps=${FPS},format=yuv420p,tpad=stop_mode=clone:stop_duration=0.15[v${i}]`);
	}
	let cur = 'v0', cum = 0;
	for (let k = 0; k < n - 1; k++) {
		cum += shots[k]!.dur;
		let tp: string = shots[k]!.trans ?? 'cut';
		let du = tailOf(shots[k]!);
		if (tp === 'cut') { tp = 'fade'; du = 1 / FPS; }
		fc.push(`[${cur}][v${k + 1}]xfade=transition=${tp}:duration=${du.toFixed(4)}:offset=${cum.toFixed(4)}[x${k}]`);
		cur = `x${k}`;
	}
	const total = cum + shots[n - 1]!.dur;
	fc.push(`[${cur}]trim=duration=${total.toFixed(4)}[vout]`);
	for (let i = 0; i < n; i++) fc.push(`[${i}:a]atrim=duration=${shots[i]!.dur.toFixed(4)},asetpts=PTS-STARTPTS[a${i}]`);
	fc.push(Array.from({ length: n }, (_, i) => `[a${i}]`).join('') + `concat=n=${n}:v=0:a=1[aout]`);
	await ffmpeg([...inputs, '-filter_complex', fc.join(';'), '-map', '[vout]', '-map', '[aout]',
		'-c:v', 'libx264', '-preset', 'fast', '-crf', '17', '-r', String(FPS), '-c:a', 'aac', '-b:a', '192k', out], 30 * 60_000);
}

// --- captions, titles, emoji, sound ------------------------------------------------

const ts = (t: number) => {
	t = Math.max(0, t);
	const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
	return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};
const bare = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, '');
const assText = (s: string) => s.replace(/[{}\\]/g, '');

interface Word { a: number; b: number; w: string }

/** Word timings within each voiced line, spread by character count. */
export function wordTimes(p: StoryProject): Word[][] {
	const lines = p.script?.lines ?? [];
	return (p.voice?.segments ?? []).map(seg => {
		const words = (lines[seg.line]?.text ?? '').split(/\s+/).filter(Boolean);
		const total = words.reduce((n, w) => n + w.length + 1, 0) || 1;
		let t = seg.start;
		return words.map(w => { const dt = (seg.end - seg.start) * (w.length + 1) / total; const r = { a: t, b: t + dt, w }; t += dt; return r; });
	});
}

function twoRows(text: string): string {
	const w = text.trim().split(/\s+/);
	if (w.length < 3) return w.join(' ');
	const k = Math.ceil(w.length / 2);
	return w.slice(0, k).join(' ') + '\\N' + w.slice(k).join(' ');
}

interface Overlay { t: number; dur: number; code: string }
interface Sfx { t: number; name: string; vol: number }

function plan(p: StoryProject, shots: Shot[], W: number, H: number) {
	const V = H > W;
	const BASE = footageEnd(p);
	const TOTAL = p.voice!.totalSeconds;
	const lines = p.script?.lines ?? [];
	const segs = p.voice?.segments ?? [];
	const words = wordTimes(p);
	const CAP_SIZE = V ? 92 : 76;
	const CAP_Y = Math.round(H * (V ? 0.70 : 0.84));
	const SLAM = V ? 150 : 130;
	const events: string[] = [];

	// karaoke captions: 2-4 word chunks, the spoken word scaled up, key words yellow
	segs.forEach((seg, si) => {
		const line = lines[seg.line];
		const hl = new Set((line?.highlight ?? []).flatMap(h => h.split(/\s+/)).map(bare));
		const ws = words[si]!;
		const chunks: Word[][] = [];
		let cur: Word[] = [];
		for (const w of ws) {
			cur.push(w);
			if (cur.length >= (V ? 3 : 4) || /[,.?!;:]$/.test(w.w)) { chunks.push(cur); cur = []; }
		}
		if (cur.length) chunks.push(cur);
		for (const ch of chunks) {
			ch.forEach((w, j) => {
				const parts = ch.map((o, jj) => {
					const txt = assText(o.w.toUpperCase());
					if (jj === j) return `{\\c${hl.has(bare(o.w)) ? YELLOW : '&H00FFFFFF&'}\\fscx112\\fscy112}${txt}{\\c&HFFFFFF&\\fscx100\\fscy100}`;
					return `{\\c${hl.has(bare(o.w)) ? YELLOW : '&H00FFFFFF&'}\\alpha&H30&}${txt}{\\alpha&H00&\\c&HFFFFFF&}`;
				});
				const end = j < ch.length - 1 ? w.b : Math.max(w.b, ch[ch.length - 1]!.b + 0.25);
				const pop = j === 0 ? '\\fscx70\\fscy70\\t(0,90,\\fscx100\\fscy100)' : '';
				events.push(`Dialogue: 0,${ts(w.a)},${ts(Math.min(end, BASE))},Cap,,0,0,0,,{${pop}}${parts.join(' ')}`);
			});
		}
	});
	// never two caption events on screen at once
	const sec = (x: string) => { const [h, m, s] = x.split(':'); return +h! * 3600 + +m! * 60 + parseFloat(s!); };
	events.sort((a, b) => sec(a.split(',')[1]!) - sec(b.split(',')[1]!));
	for (let i = 0; i < events.length - 1; i++) {
		const parts = events[i]!.split(',');
		const nxt = sec(events[i + 1]!.split(',')[1]!);
		if (sec(parts[2]!) > nxt) { parts[2] = ts(nxt); events[i] = parts.join(','); }
	}

	// title slams
	const slam = (t0: number, t1: number, text: string) => {
		const ms = Math.round((t1 - t0) * 1000);
		events.push(`Dialogue: 2,${ts(t0)},${ts(t1)},Slam,,0,0,0,,{\\an5\\pos(${W / 2},${Math.round(H * 0.36)})\\fscx260\\fscy260\\alpha&HFF&` +
			`\\t(0,140,\\fscx100\\fscy100\\alpha&H00&)\\t(${ms - 180},${ms},\\alpha&HFF&)}${twoRows(assText(text.toUpperCase()))}`);
	};
	const opening = p.script?.openingTitle?.trim();
	if (opening && !lines[0]?.title && segs[0]) slam(0.15, Math.min(segs[0].start + 2.2, segs[1]?.start ?? BASE), opening);
	segs.forEach((seg, si) => {
		const t = lines[seg.line]?.title;
		if (t) slam(Math.max(0.1, seg.start - 0.1), Math.min(seg.start + 2.1, segs[si + 1]?.start ?? BASE, BASE), t);
	});

	// end card text + watermark
	const LOGO = Math.round(Math.min(W, H) * (V ? 0.42 : 0.36));
	const LOGO_Y = Math.round(H / 2 - LOGO * 0.62 - 40);
	const TY = LOGO_Y + LOGO + (V ? 90 : 70);
	const cardText = assText((p.cardText || 'Follow the journey').toUpperCase());
	events.push(`Dialogue: 3,${ts(BASE + 0.35)},${ts(TOTAL)},CardBig,,0,0,0,,{\\fad(250,0)\\pos(${W / 2},${TY})}${cardText}`);
	events.push(`Dialogue: 3,${ts(BASE + 0.6)},${ts(TOTAL)},CardSmall,,0,0,0,,{\\fad(250,0)\\pos(${W / 2},${TY + 115})}@CommunityLiteracyClub\\NCommunityLiteracyClub.org`);
	events.push(`Dialogue: 3,${ts(0)},${ts(BASE)},Mark,,0,0,0,,COMMUNITYLITERACYCLUB.ORG`);

	const font = 'Montserrat ExtraBold';
	const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${font},${CAP_SIZE},&H00FFFFFF,&H00FFFFFF,&H00000000,&H90000000,0,0,0,0,100,100,1,0,1,9,5,2,60,60,${H - CAP_Y},1
Style: Slam,${font},${SLAM},&H00FFFFFF,&H00FFFFFF,&H00000000,&HA0000000,0,0,0,0,100,100,2,0,1,12,8,5,40,40,0,1
Style: CardBig,${font},${V ? 120 : 96},&H00FFFFFF,&H00FFFFFF,${GREEN_BGR},&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,60,60,0,1
Style: CardSmall,Montserrat,${V ? 54 : 46},&H00FFFFFF,&H00FFFFFF,${GREEN_BGR},&H00000000,1,0,0,0,100,100,1,0,1,0,0,5,60,60,0,1
Style: Mark,${font},${V ? 34 : 28},&H00FFFFFF,&H00FFFFFF,${GREEN_BGR},${GREEN_BGR},0,0,0,0,100,100,1,0,3,10,0,2,60,60,${V ? Math.round(H * 0.12) : 30},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`;

	// emoji pops and per-line sound effects land on their word
	const wordAt = (si: number, word?: string): number => {
		const ws = words[si] ?? [];
		const hit = word ? ws.find(w => bare(w.w) === bare(word)) : undefined;
		return hit ? hit.a : segs[si]!.start;
	};
	const emoji: Overlay[] = [];
	const sfx: Sfx[] = [{ t: 0.05, name: 'whoosh', vol: 0.5 }];
	segs.forEach((seg, si) => {
		const line = lines[seg.line];
		if (!line) return;
		const t = wordAt(si, line.emojiWord || line.highlight?.[0]);
		if (line.emoji) {
			const until = segs[si + 1]?.start ?? BASE;
			emoji.push({ t, dur: Math.max(0.8, Math.min(1.6, until - t + 0.2)), code: line.emoji });
		}
		if (line.sfx) sfx.push({ t: Math.max(0, t - 0.02), name: line.sfx, vol: line.sfx === 'ding' ? 0.35 : line.sfx === 'school-bell' ? 0.5 : 0.85 });
	});
	let c = 0;
	for (const s of shots.slice(0, -1)) {
		c += s.dur;
		if (s.trans === 'zoomin' || s.trans === 'smoothleft') sfx.push({ t: c - 0.05, name: 'whoosh', vol: 0.9 });
		else if (s.trans === 'slideleft' || s.trans === 'slideup' || s.trans === 'wipeleft') sfx.push({ t: c - 0.05, name: 'whip', vol: 0.9 });
		else if (s.trans === 'fadewhite') sfx.push({ t: c - 0.02, name: 'shutter-modern', vol: 0.45 });
	}
	sfx.push({ t: BASE + 0.1, name: 'ding', vol: 0.35 });

	const ESZ = V ? 170 : 130;
	const EY = CAP_Y - CAP_SIZE - ESZ - (V ? 30 : 10);
	return { ass, emoji, sfx, BASE, TOTAL, V, LOGO, LOGO_Y, ESZ, EY };
}

async function assemble(p: StoryProject, shots: Shot[], base: string, out: string, work: string, a: Aspect): Promise<void> {
	const [W, H] = SIZE[a];
	const assets = assetDir();
	const pl = plan(p, shots, W, H);
	const { BASE, TOTAL, V } = pl;
	const CARD = TOTAL - BASE;
	const assFile = path.join(work, `${a}.ass`);
	fs.writeFileSync(assFile, pl.ass);

	const inputs = ['-i', base, '-i', path.join(assets, 'logo.png')];
	const fc: string[] = [
		// xfade into the card shortens the picture by 0.3s, so the card is 0.3s longer
		`color=c=0x1B4D3E:s=${W}x${H}:r=${FPS}:d=${(CARD + 0.3).toFixed(3)},format=yuv420p,settb=1/${FPS}[card]`,
		`[0:v]settb=1/${FPS},fps=${FPS},format=yuv420p[b0];[b0][card]xfade=transition=fade:duration=0.3:offset=${(BASE - 0.3).toFixed(3)}[vc]`,
		`[vc]subtitles=${assFile}:fontsdir=${path.join(assets, 'fonts')}[v1]`,
		`color=c=0xF5D547:s=${W}x${V ? 10 : 8}:r=${FPS}:d=${TOTAL}[bar]`,
		`[v1][bar]overlay=x='-w+w*t/${TOTAL}':y=0:eval=frame[v2]`,
	];
	let cur = 'v2', idx = 2;
	pl.emoji.forEach((e, k) => {
		inputs.push('-loop', '1', '-t', TOTAL.toFixed(2), '-i', path.join(assets, 'emoji', `${e.code}.png`));
		fc.push(`[${idx}:v]scale=${pl.ESZ}:${pl.ESZ}:flags=lanczos,format=rgba[e${k}]`);
		const y = `${pl.EY}+80*max(0\\,1-(t-${e.t.toFixed(3)})/0.18)`;
		fc.push(`[${cur}][e${k}]overlay=x=(W-w)/2:y='${y}':eval=frame:enable='between(t,${e.t.toFixed(3)},${(e.t + e.dur).toFixed(3)})'[ve${k}]`);
		cur = `ve${k}`; idx++;
	});
	fc.push(`[1:v]loop=-1:size=1,trim=duration=${TOTAL},scale=${pl.LOGO}:${pl.LOGO},format=rgba,fade=t=in:st=${BASE + 0.1}:d=0.4:alpha=1[lg]`);
	fc.push(`[${cur}][lg]overlay=(W-w)/2:${pl.LOGO_Y}:enable='gte(t,${BASE + 0.1})',format=yuv420p[v]`);

	// voice: each line placed at its start
	const vdir = path.join(projectDir(p.id), 'voice');
	const mix: string[] = [];
	for (const seg of p.voice!.segments) {
		inputs.push('-i', path.join(vdir, seg.file));
		fc.push(`[${idx}:a]aresample=48000,adelay=${Math.round(seg.start * 1000)}:all=1[s${mix.length}]`);
		mix.push(`[s${mix.length}]`); idx++;
	}
	fc.push(`${mix.join('')}amix=inputs=${mix.length}:normalize=0,volume=1.5,apad=whole_dur=${TOTAL}[vo]`);
	fc.push(`[0:a]volume=0.25,apad=whole_dur=${TOTAL}[nat]`);
	const fx: string[] = [];
	for (const s of pl.sfx) {
		const f = path.join(assets, 'sfx', `${s.name}.wav`);
		if (!fs.existsSync(f)) continue;
		inputs.push('-i', f);
		fc.push(`[${idx}:a]aresample=48000,volume=${s.vol},adelay=${Math.max(0, Math.round(s.t * 1000))}:all=1[x${fx.length}]`);
		fx.push(`[x${fx.length}]`); idx++;
	}
	fc.push(`${fx.join('')}amix=inputs=${fx.length}:normalize=0,apad=whole_dur=${TOTAL}[fx]`);
	fc.push(`[vo][nat][fx]amix=inputs=3:normalize=0,atrim=0:${TOTAL},loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]`);
	await ffmpeg([...inputs, '-filter_complex', fc.join(';'), '-map', '[v]', '-map', '[a]',
		'-c:v', 'libx264', '-crf', '19', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
		'-movflags', '+faststart', '-t', TOTAL.toFixed(3), out], 40 * 60_000);
}

export function buildSrt(p: StoryProject): string {
	const lines = p.script?.lines ?? [];
	const srtTime = (t: number) => {
		const ms = Math.round(t * 1000);
		const h = Math.floor(ms / 3_600_000), m = Math.floor(ms / 60_000) % 60, s = Math.floor(ms / 1000) % 60;
		return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
	};
	return (p.voice?.segments ?? []).map((seg, i) => {
		let text = lines[seg.line]?.text ?? '';
		if (text.length > 42) { const w = text.split(' '); const k = Math.ceil(w.length / 2); text = w.slice(0, k).join(' ') + '\n' + w.slice(k).join(' '); }
		return `${i + 1}\n${srtTime(seg.start)} --> ${srtTime(seg.end + 0.2)}\n${text}\n`;
	}).join('\n');
}

/** Render everything. Files land in /data/story/projects/<id>/out. */
export async function renderStory(p: StoryProject, log: (m: string) => void): Promise<StoryOutputs> {
	if (!p.voice?.segments.length) throw new Error('Record the voice-over first');
	const shots = normaliseShots(p);
	const dir = projectDir(p.id);
	const work = path.join(dir, 'work');
	const out = path.join(dir, 'out');
	fs.rmSync(work, { recursive: true, force: true });
	fs.mkdirSync(work, { recursive: true });
	fs.mkdirSync(out, { recursive: true });
	const slug = (p.title || 'story').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'story';
	try {
		let done = 0;
		await pool(shots, 3, async (s, i) => {
			await buildShot(s, i, work);
			log(`Cutting and stabilising shots: ${++done} / ${shots.length}`);
		});
		const outputs: StoryOutputs = {};
		for (const a of ['v', 'w'] as Aspect[]) {
			const label = a === 'v' ? '9:16' : '16:9';
			log(`Joining shots with transitions (${label})`);
			const base = path.join(work, `base_${a}.mp4`);
			await chain(shots, work, a, base);
			log(`Adding captions, emoji, sound and end card (${label})`);
			const file = `${slug}-${a === 'v' ? '9x16' : '16x9'}.mp4`;
			await assemble(p, shots, base, path.join(out, file), work, a);
			if (a === 'v') outputs.vertical = file; else outputs.wide = file;
		}
		fs.writeFileSync(path.join(out, `${slug}-captions.srt`), buildSrt(p));
		outputs.srt = `${slug}-captions.srt`;
		// thumbnails: the hook frame, title slam showing
		const tThumb = Math.min(LEAD_IN + 0.6, footageEnd(p) - 0.5).toFixed(2);
		await ffmpeg(['-ss', tThumb, '-i', path.join(out, outputs.vertical!), '-frames:v', '1', '-q:v', '2', path.join(out, `${slug}-thumbnail-9x16.jpg`)]);
		await ffmpeg(['-ss', tThumb, '-i', path.join(out, outputs.wide!), '-frames:v', '1', '-q:v', '2', path.join(out, `${slug}-thumbnail-16x9.jpg`)]);
		outputs.thumbnail = `${slug}-thumbnail-9x16.jpg`;
		outputs.thumbnailWide = `${slug}-thumbnail-16x9.jpg`;
		log('Writing post copy');
		try {
			fs.writeFileSync(path.join(out, `${slug}-post-kit.md`), await writePostKit(p));
			outputs.postKit = `${slug}-post-kit.md`;
		} catch (e) {
			log(`Post copy failed (${(e as Error).message}); the videos are ready`);
		}
		return outputs;
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}
