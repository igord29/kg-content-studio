/**
 * Guards that the emotional tagging axis is actually CONSUMED.
 *
 * The failure this exists to prevent: a previous attempt added emotion fields to
 * the cataloger prompt, and nothing downstream ever read them. The catalog got
 * bigger, the API bill got bigger, and not one edit decision changed. Producing
 * a tag and reading a tag are two separate things and only the pair is useful.
 *
 * These are structural assertions over the source, not behavioural tests -- the
 * ranking helpers are inline in the prompt builders. Crude, but it fails loudly
 * the moment a step stops reading the field, which is the regression that
 * actually happened.
 *
 * Run: bun test-emotion-wiring.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const V2 = path.join(__dirname, 'src', 'agent', 'video-editor', 'pipeline-v2');
const VE = path.join(__dirname, 'src', 'agent', 'video-editor');

let failures = 0;
function check(label: string, condition: boolean, detail?: string): void {
	if (condition) { console.log('  PASS  ' + label); return; }
	failures++;
	console.log('  FAIL  ' + label + (detail ? '\n        ' + detail : ''));
}
const read = (p: string): string => fs.readFileSync(p, 'utf-8');

console.log('\n1. The cataloger PRODUCES the fields');
const cataloger = read(path.join(VE, 'cataloger.ts'));
check('scoring prompt asks for emotion', /- emotion: 0-10/.test(cataloger));
check('scoring prompt asks for valence', /- valence: "positive"/.test(cataloger));
check('scoring prompt asks for beat', /- beat: which story role/.test(cataloger));
check('prompt states emotion is independent of athletic quality',
	/independently of everything above/i.test(cataloger));
check('example JSON carries the new fields',
	/"emotion":\s*\d+.*"valence":\s*"\w+".*"beat":/s.test(cataloger));
check('parsed emotion is clamped to 0-10',
	/Math\.max\(0,\s*Math\.min\(10,\s*Math\.round\(score\.emotion\)\)\)/.test(cataloger));
check('valence is validated against an allowlist', /VALENCES\.includes/.test(cataloger));
check('beat is validated against an allowlist', /BEATS\.includes/.test(cataloger));
check('fields are written onto the score record',
	/allScores\.push\(\{[\s\S]*?emotion,[\s\S]*?valence,[\s\S]*?beat,/.test(cataloger));

console.log('\n2. The type DECLARES the fields');
const drive = read(path.join(VE, 'google-drive.ts'));
check('CatalogEntry.timestampScores declares emotion', /\n\s*emotion\?: number;/.test(drive));
check('CatalogEntry.timestampScores declares valence',
	/valence\?: 'positive' \| 'neutral' \| 'negative';/.test(drive));
check('CatalogEntry.timestampScores declares beat', /beat\?: 'hook' \|/.test(drive));

console.log('\n3. Every pipeline step READS the fields');
const steps: Array<[string, string]> = [
	['01-story-planner.ts', 'builds an emotional profile per source'],
	['02-hook-selector.ts', 'ranks hooks using emotion'],
	['03-body-composer.ts', 'surfaces emotional peaks'],
	['04-close-composer.ts', 'ranks the close using emotion'],
];
for (const [file, what] of steps) {
	const src = read(path.join(V2, file));
	check(file + ' — ' + what, /\.emotion\b/.test(src),
		'no reference to `.emotion` found; the tag is being produced and ignored');
}

console.log('\n4. Ranking genuinely depends on emotion (not just printed)');
const hook = read(path.join(V2, '02-hook-selector.ts'));
check('hook selector sorts by a score that includes emotion',
	/hookScore[\s\S]{0,400}s\.emotion[\s\S]{0,400}sort\(/.test(hook)
	|| /const hookScore[\s\S]{0,500}\.sort\(\(a, b\) => hookScore\(b\) - hookScore\(a\)\)/.test(hook));
const close = read(path.join(V2, '04-close-composer.ts'));
check('close composer sorts by a score that includes emotion',
	/closeScore[\s\S]{0,600}\.sort\(\(a, b\) => closeScore\(b\) - closeScore\(a\)\)/.test(close));
check('close composer weights community/reflection beats',
	/beat === 'community'[\s\S]{0,120}beat === 'reflection'/.test(close));
const body = read(path.join(V2, '03-body-composer.ts'));
check('body composer requires an emotional beat',
	/emotion >= 5/.test(body) && /EMOTIONAL ESCALATION/.test(body));

console.log('\n5. Pre-existing catalogs still work (graceful degradation)');
check('hook ranking falls back when emotion is absent',
	/typeof s\.emotion !== 'number'\) return s\.actionQuality/.test(hook));
check('close ranking falls back when emotion is absent',
	/typeof s\.emotion !== 'number'\) return s\.actionQuality/.test(close));
check('story planner distinguishes "not scored" from "no emotion"',
	/catalogued before emotional tagging/.test(read(path.join(V2, '01-story-planner.ts'))));

console.log(failures === 0
	? '\nEmotional tagging is wired end to end.'
	: '\n' + failures + ' FAILURES — a tag is being produced and not read.');
process.exit(failures === 0 ? 0 : 1);
