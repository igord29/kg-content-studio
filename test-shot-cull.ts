/**
 * Culling a plan from shot-check verdicts.
 * Run: bun test-shot-cull.ts
 */
import { cullPlan, shotStarts } from './src/agent/video-editor/shot-check';

let failures = 0;
const check = (label: string, ok: boolean): void => { console.log((ok ? '  PASS  ' : '  FAIL  ') + label); if (!ok) failures++; };

const clips = Array.from({ length: 8 }, (_, i) => ({ fileId: 'f' + i, trimStart: i * 10, duration: 2 }));
const plan = {
	clips, totalDuration: 16,
	textOverlays: [
		{ text: 'Title', start: 0.3, duration: 3, position: 'top' },
		{ text: 'Community Literacy Club', start: 13.5, duration: 2.5, position: 'center' },
		{ text: 'CommunityLiteracyClub.org', start: 0, duration: 16, position: 'bottom' },
	],
};
const v = (keep: boolean, opener = 2) => ({ keep, opener, reason: '' });
const verdicts = [v(false, 1), v(true, 2), v(true, 5), v(true, 2), v(false), v(true, 3), v(true, 2), v(true, 2)].map((x, shot) => ({ ...x, shot }));

check('shot start times accumulate', JSON.stringify(shotStarts(clips.slice(0, 3))) === '[0,2,4]');

const out = cullPlan(plan, verdicts)!;
check('rejected shots are removed', out.clips.length === 6 && !out.clips.some(c => c.fileId === 'f0' || c.fileId === 'f4'));
check('the strongest opener leads', out.clips[0]!.fileId === 'f2');
check('the rest keep their order', out.clips.slice(1).map(c => c.fileId).join() === 'f1,f3,f5,f6,f7');
check('watermark covers the new length', out.textOverlays!.find(o => o.position === 'bottom')!.duration === 12);
check('closing card sits on the final shots', out.textOverlays!.find(o => o.position === 'center')!.start === 10.5);
check('opening title is untouched', out.textOverlays!.find(o => o.position === 'top')!.start === 0.3);
check('too few survivors returns null', cullPlan(plan, verdicts.map((x, i) => ({ ...x, keep: i < 3 }))) === null);

console.log(failures === 0 ? '\nShot culling works.' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
