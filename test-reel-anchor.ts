/**
 * Recap-reel shots must sit on frames where people were confirmed in frame.
 * The first recap render showed sponsor boards and empty court for about half
 * its runtime because shots drifted off their scored moments.
 *
 * Run: bun test-reel-anchor.ts
 */
import { anchorReelClips, clampReelHook, clampReelShot, isReelMode } from './src/agent/video-editor/pipeline-v2/reel-style';

let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
	console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || !detail ? '' : ' — ' + detail));
	if (!ok) failures++;
};

const moments: Record<string, Array<{ timestamp: number; actionQuality: number; people: number }>> = {
	a: [
		{ timestamp: 10, actionQuality: 8, people: 4 },
		{ timestamp: 40, actionQuality: 9, people: 5 },
		{ timestamp: 70, actionQuality: 9, people: 1 }, // great action score, nobody in frame
	],
};
const logs: string[] = [];
const run = (clips: Array<{ fileId: string; trimStart: number; duration: number }>) =>
	anchorReelClips(clips, id => moments[id], m => logs.push(m));

const [early, last] = run([{ fileId: 'a', trimStart: 7, duration: 4.5 }, { fileId: 'a', trimStart: 38, duration: 4.5 }]);
check('a shot starting 3s early is pulled onto its moment', early?.trimStart === 9.5, String(early?.trimStart));
check('and is held short', (early?.duration ?? 9) <= 2.5);
check('the final shot may run to 3.5s so its action completes', last?.duration === 3.5, String(last?.duration));

const [empty] = run([{ fileId: 'a', trimStart: 69, duration: 2 }]);
check('a moment with nobody in frame is never used', empty?.trimStart === 39.5, String(empty?.trimStart));

const twice = run([{ fileId: 'a', trimStart: 9, duration: 2 }, { fileId: 'a', trimStart: 11, duration: 2 }]);
check('two shots never land on the same moment', twice[0]?.trimStart !== twice[1]?.trimStart);

const over = run([
	{ fileId: 'a', trimStart: 9, duration: 2 }, { fileId: 'a', trimStart: 39, duration: 2 }, { fileId: 'a', trimStart: 20, duration: 2 },
]);
check('a shot with no confirmed moment left is dropped', over.length === 2);

const [unscored] = run([{ fileId: 'zzz', trimStart: 5, duration: 2 }]);
check('an unscored source is left alone', unscored?.trimStart === 5);

check('recap modes are game_day and quick_hit', isReelMode('game_day') && isReelMode('quick_hit') && !isReelMode('our_story'));
check('hook is clamped to 2-3s', clampReelHook(9) === 3 && clampReelHook(0.5) === 2);
check('shots are clamped to 1-3s', clampReelShot(4.5) === 3 && clampReelShot(0.4) === 1);

console.log(failures === 0 ? '\nReel shots are anchored to confirmed moments.' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
