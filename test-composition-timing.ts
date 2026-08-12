/**
 * Quantifies the truncation bug: what the composition claimed vs what
 * CLCVideo actually laid out, before and after the shared-timing fix.
 */
import {
	computeCompositionFrames,
	clipFramesFor,
} from './src/agent/video-editor/remotion/composition-timing';

type C = { src: string; length: number; transitionType?: string };

const MODES: Record<string, number> = {
	game_day: 0.5,
	our_story: 1.0,
	quick_hit: 0.3,
	showcase: 0.8,
};

const FPS = 30;
const LENGTHS = [3, 4, 3.5, 5, 4, 3, 4.5, 4]; // 8-clip edit, 31.0s planned

/** The OLD entry.tsx calculateMetadata. */
function oldCompositionFrames(clips: C[], fps: number, tdf: number): number {
	const totalSeconds = clips.reduce((s, c) => s + c.length, 0);
	const overlap = Math.max(0, clips.length - 1) * (tdf / fps);
	return Math.max(30, Math.ceil((totalSeconds - overlap) * fps));
}

/** The OLD CLCVideo per-clip length: clamp every clip to 2 transitions + 1s. */
function oldRenderedFrames(clips: C[], fps: number, tdf: number): number {
	let total = 0;
	for (const c of clips) total += Math.max(Math.ceil(c.length * fps), tdf * 2 + fps);
	let transitions = 0;
	clips.forEach((c, i) => { if (i > 0 && tdf > 0 && c.transitionType) transitions++; });
	return total - transitions * tdf;
}

/** The NEW CLCVideo per-clip length, summed the same way the renderer lays it out. */
function newRenderedFrames(clips: C[], fps: number, tdf: number): number {
	let total = 0;
	for (let i = 0; i < clips.length; i++) total += clipFramesFor(clips, i, fps, tdf);
	let transitions = 0;
	clips.forEach((c, i) => { if (i > 0 && tdf > 0 && c.transitionType) transitions++; });
	return total - transitions * tdf;
}

function build(nTransitions: number): C[] {
	return LENGTHS.map((length, i) => ({
		src: `clip${i}.mp4`,
		length,
		// Put transitions on the earliest boundaries (index > 0).
		...(i > 0 && i <= nTransitions ? { transitionType: 'fade' } : {}),
	}));
}

console.log('Truncation per render — 8 clips, 31.0s of planned footage, ' + FPS + 'fps\n');
console.log('mode        transitions   OLD lost      NEW lost   short-cut stretch (old)');
console.log('-------------------------------------------------------------------------');

for (const [mode, td] of Object.entries(MODES)) {
	const tdf = Math.round(td * FPS);
	for (const nT of [2, 0]) {
		const clips = build(nT);

		const oldComp = oldCompositionFrames(clips, FPS, tdf);
		const oldReal = oldRenderedFrames(clips, FPS, tdf);
		const oldLost = (oldReal - oldComp) / FPS;

		const newComp = computeCompositionFrames(clips, FPS, tdf);
		const newReal = newRenderedFrames(clips, FPS, tdf);
		const newLost = (newReal - newComp) / FPS;

		// How much the old min-clip clamp inflated clips that no transition touched.
		let stretch = 0;
		clips.forEach(c => {
			const planned = Math.ceil(c.length * FPS);
			const clamped = Math.max(planned, tdf * 2 + FPS);
			stretch += (clamped - planned) / FPS;
		});

		console.log(
			`${mode.padEnd(11)} ${String(nT === 0 ? 'all hard' : nT).padEnd(13)} ` +
			`${(oldLost.toFixed(1) + 's').padEnd(13)} ${(newLost.toFixed(1) + 's').padEnd(10)} ` +
			`${stretch.toFixed(1)}s`,
		);
	}
}

// Hard assertions: the new math must never disagree with the renderer.
let failures = 0;
for (const [mode, td] of Object.entries(MODES)) {
	const tdf = Math.round(td * FPS);
	for (let nT = 0; nT <= 7; nT++) {
		const clips = build(nT);
		const comp = computeCompositionFrames(clips, FPS, tdf);
		const real = newRenderedFrames(clips, FPS, tdf);
		if (comp !== real) {
			console.error(`MISMATCH ${mode} nT=${nT}: composition=${comp} rendered=${real}`);
			failures++;
		}
	}
}

// A deliberately short cut on a hard boundary must survive at its planned length.
const punchy: C[] = [
	{ src: 'a.mp4', length: 3 },
	{ src: 'b.mp4', length: 1.5 },
	{ src: 'c.mp4', length: 3 },
];
const tdfStory = Math.round(MODES.our_story! * FPS);
const shortFrames = clipFramesFor(punchy, 1, FPS, tdfStory);
console.log(`\n1.5s hard-cut clip in our_story -> ${shortFrames} frames (${(shortFrames / FPS).toFixed(1)}s); old clamp forced ${tdfStory * 2 + FPS} frames (3.0s)`);
if (shortFrames !== 45) { console.error('FAIL: short hard-cut clip was not preserved'); failures++; }

// A clip between two transitions must still be protected.
const wrapped: C[] = [
	{ src: 'a.mp4', length: 3 },
	{ src: 'b.mp4', length: 0.5, transitionType: 'fade' },
	{ src: 'c.mp4', length: 3, transitionType: 'fade' },
];
const protectedFrames = clipFramesFor(wrapped, 1, FPS, tdfStory);
console.log(`0.5s clip between two 1.0s transitions -> ${protectedFrames} frames (${(protectedFrames / FPS).toFixed(1)}s), floor respected`);
if (protectedFrames !== tdfStory * 2 + FPS) { console.error('FAIL: transition floor not applied'); failures++; }

console.log(failures === 0 ? '\nAll timing assertions passed.' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
