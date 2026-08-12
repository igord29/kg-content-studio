/**
 * Tests the crop/audio builders inside the GENERATED Lambda handler.
 *
 * This matters because scripts/deploy-preprocessor-lambda.ts embeds its own
 * copies of these functions in a template literal, and THAT is the code which
 * actually runs in AWS. The versions under
 * src/agent/video-editor/remotion/preprocessor-lambda.ts are reference mirrors
 * that are never deployed, so testing those proves nothing about production.
 *
 * Run: bun test-preprocessor-crop.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const BACKTICK = String.fromCharCode(96);
const DEPLOY_SCRIPT = path.join(__dirname, 'scripts', 'deploy-preprocessor-lambda.ts');

function extractHandlerSource(): string {
	const src = fs.readFileSync(DEPLOY_SCRIPT, 'utf-8');
	const declIdx = src.indexOf('const handler = ' + BACKTICK);
	if (declIdx < 0) throw new Error('could not find the handler template literal');
	const start = declIdx + ('const handler = ' + BACKTICK).length;
	const end = src.indexOf('\n' + BACKTICK + ';', start);
	if (end < 0) throw new Error('could not find the end of the handler template literal');
	const raw = src.slice(start, end);
	if (raw.includes('${')) throw new Error('handler literal now interpolates; update this test');
	// Resolve the template literal exactly as the deploy script would, so the
	// escaping (e.g. the \\, inside scale=min(iw\,1080)) matches what ships.
	return new Function('return ' + BACKTICK + raw + BACKTICK)() as string;
}

type CropFn = (w: number, h: number, aspect: string, pos: string | undefined, zoom?: number) => string;
type AudioFn = (speed: number, duration: number) => string;
type VideoFn = (config: Record<string, unknown>) => string;

const handlerSource = extractHandlerSource();

const from = handlerSource.indexOf('// --- Smart Crop Helpers ---');
const to = handlerSource.indexOf('// --- Lambda Handler ---');
if (from < 0 || to < 0) throw new Error('could not locate the builder section');

const sandbox: Record<string, unknown> = {};
new Function(
	'exports',
	handlerSource.slice(from, to) +
		'\nexports.buildSmartCropFilter = buildSmartCropFilter;' +
		'\nexports.buildVideoFilter = buildVideoFilter;' +
		'\nexports.buildAudioFilter = buildAudioFilter;',
)(sandbox);

const buildSmartCropFilter = sandbox.buildSmartCropFilter as CropFn;
const buildVideoFilter = sandbox.buildVideoFilter as VideoFn;
const buildAudioFilter = sandbox.buildAudioFilter as AudioFn;

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown): void {
	if (actual === expected) {
		console.log('  PASS  ' + label);
		return;
	}
	failures++;
	console.log('  FAIL  ' + label);
	console.log('        expected: ' + String(expected));
	console.log('        actual:   ' + String(actual));
}
function assert(label: string, cond: boolean): void {
	if (cond) console.log('  PASS  ' + label);
	else { failures++; console.log('  FAIL  ' + label); }
}

// --- 1. Backward compatibility -------------------------------------------
// extraZoom was previously accepted by the invoker and dropped on the floor.
// Adding it must not disturb clips that never asked for a punch-in.
console.log('\n1. Backward compatibility (zoom 1.0, centred, 1920x1080 -> 9:16)');
const BASELINE = 'scale=3414:1920,crop=1080:1920:1168:0';
expect('reproduces the pre-fix filter byte-for-byte',
	buildSmartCropFilter(1920, 1080, '9:16', 'center', 1.0), BASELINE);
expect('undefined extraZoom behaves as 1.0',
	buildSmartCropFilter(1920, 1080, '9:16', 'center', undefined), BASELINE);
expect('matching aspect with no zoom is a plain scale',
	buildSmartCropFilter(1080, 1920, '9:16', 'center', 1.0), 'scale=1080:1920');

// --- 2. extraZoom reaches FFmpeg -----------------------------------------
console.log('\n2. extraZoom tightens framing (the 1%-subject fix)');
let prevCropShare = Infinity;
for (const zoom of [1.0, 1.15, 1.3, 1.5]) {
	const filter = buildSmartCropFilter(1920, 1080, '9:16', 'center', zoom);
	const scaled = /scale=(\d+):(\d+)/.exec(filter);
	if (!scaled) { failures++; console.log('  FAIL  unparseable filter at zoom ' + zoom); continue; }
	const share = 1080 / parseInt(scaled[1]!, 10);
	console.log('        zoom ' + zoom.toFixed(2) + ' -> ' + filter);
	if (zoom > 1.0 && share >= prevCropShare) {
		failures++;
		console.log('  FAIL  zoom ' + zoom + ' did not tighten the crop window');
	}
	prevCropShare = share;
}
assert('framing tightens monotonically with extraZoom', prevCropShare < 1080 / 3414);

// --- 3. Vertical framing --------------------------------------------------
// For 16:9 -> 9:16 the old code pinned scaleH to targetH, leaving zero vertical
// slack, so cropY always clamped to 0 and subjectPosition's Y was inert.
console.log('\n3. subjectPosition Y affects framing');
const cropYFor = (pos: string): number => {
	const m = /crop=\d+:\d+:(\d+):(\d+)/.exec(buildSmartCropFilter(1920, 1080, '9:16', pos, 1.0));
	if (!m) throw new Error('unparseable crop for ' + pos);
	return parseInt(m[2]!, 10);
};
const top = cropYFor('top-center');
const mid = cropYFor('center');
const bottom = cropYFor('bottom-center');
console.log('        top-center cropY=' + top + ', center=' + mid + ', bottom-center=' + bottom);
assert('top and bottom framing differ', top !== bottom);
assert('a lower subject crops further down', bottom > top);

// --- 4. Centring upscale is bounded by available detail -------------------
// Full centring on 1080p samples only 401px of source width and upscales it to
// 1080 — visibly soft. On 4K the same constraint samples 802px and is free.
console.log('\n4. Centring upscale is bounded on low-res sources');
const sampledWidth = (w: number, h: number, pos: string): number => {
	const m = /scale=(\d+):/.exec(buildSmartCropFilter(w, h, '9:16', pos, 1.0));
	return 1080 / (parseInt(m![1]!, 10) / w);
};
const hd = sampledWidth(1920, 1080, 'top-center');
const uhd = sampledWidth(3840, 2160, 'top-center');
console.log('        1080p samples ' + hd.toFixed(0) + 'px, 4K samples ' + uhd.toFixed(0) + 'px of source width');
assert('1080p centring is capped above the uncapped 401px', hd > 430);
assert('4K centring is not capped', uhd > 780);

// --- 5. Audio chain -------------------------------------------------------
// Finished renders measured -11.9..-15.3 LUFS with true peaks above 0 dBFS.
console.log('\n5. Audio chain');
expect('normalises at speed 1.0 (previously emitted nothing at all)',
	buildAudioFilter(1.0, 4.0),
	'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,afade=t=in:st=0:d=0.015,afade=t=out:st=3.985:d=0.015');
const slow = buildAudioFilter(0.5, 4.0);
assert('slow-mo retimes with atempo', slow.includes('atempo=0.5000'));
assert('fade-out is placed on the OUTPUT timeline (8.0s, not 4.0s)', slow.includes('st=7.985'));
assert('unknown duration skips fades rather than emitting a bad st=',
	!buildAudioFilter(1.0, 0).includes('afade'));

// --- 6. Full filter build -------------------------------------------------
console.log('\n6. buildVideoFilter passes extraZoom through');
const vf = buildVideoFilter({
	targetAspect: '9:16', sourceWidth: 1920, sourceHeight: 1080,
	subjectPosition: 'center', extraZoom: 1.3, sharpen: true,
});
console.log('        ' + vf);
assert('extraZoom survives the full chain', vf.startsWith('scale=4438:2496'));

console.log(failures === 0 ? '\nAll preprocessor assertions passed.' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
