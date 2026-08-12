#!/usr/bin/env bun
/**
 * Verify the Remotion composition bundle before deploying it.
 *
 *   bun scripts/verify-remotion-bundle.ts
 *
 * The composition bundle is deployed to S3 separately from the app (see
 * scripts/setup-remotion-lambda.ts). render.ts then reuses whatever is already
 * at REMOTION_SERVE_URL without rebuilding, so a bundle that fails to build --
 * or that quietly reintroduces a network dependency -- is not noticed until
 * renders come out wrong. This catches both without spending a Lambda render.
 *
 * Checks:
 *   1. The bundle builds at all.
 *   2. Font files are emitted INTO the bundle (self-hosted).
 *   3. Nothing fetches a font CDN at runtime. Lambda may have no outbound
 *      route, and @remotion/google-fonts throws rather than falling back, so a
 *      CDN reference is a latent hard failure.
 */

import { bundle } from '@remotion/bundler';
import * as path from 'path';
import * as fs from 'fs';

const ENTRY = path.resolve(__dirname, '..', 'src', 'agent', 'video-editor', 'remotion', 'entry.tsx');

// Hosts that would mean type is fetched at render time rather than bundled.
const FORBIDDEN_HOSTS = ['fonts.gstatic.com', 'fonts.googleapis.com'];

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else out.push(full);
	}
	return out;
}

async function main(): Promise<void> {
	console.log('[verify] Entry: ' + ENTRY);
	if (!fs.existsSync(ENTRY)) throw new Error('entry point not found: ' + ENTRY);

	let lastPct = -1;
	const serveUrl = await bundle({
		entryPoint: ENTRY,
		onProgress: (p: number) => {
			const step = Math.floor(p / 25) * 25;
			if (step !== lastPct) { lastPct = step; console.log('[verify] bundling ' + step + '%'); }
		},
	});
	console.log('[verify] Bundle built: ' + serveUrl);

	const files = walk(serveUrl);
	let failures = 0;

	const fontFiles = files.filter(f => /\.(woff2?|ttf|otf)$/i.test(f));
	console.log('[verify] Font files bundled: ' + fontFiles.length);
	if (fontFiles.length === 0) {
		console.error('[verify] FAIL: no font files in the bundle — text will render in a fallback face.');
		failures++;
	}

	const scripts = files.filter(f => /\.(js|css|html)$/i.test(f));
	const offenders: string[] = [];
	for (const file of scripts) {
		const contents = fs.readFileSync(file, 'utf-8');
		for (const host of FORBIDDEN_HOSTS) {
			if (contents.includes(host)) offenders.push(path.basename(file) + ' -> ' + host);
		}
	}
	if (offenders.length > 0) {
		console.error('[verify] FAIL: bundle fetches fonts at runtime:');
		for (const o of offenders) console.error('         ' + o);
		failures++;
	} else {
		console.log('[verify] No font-CDN references — type is fully self-hosted.');
	}

	if (failures > 0) {
		console.error('\n[verify] ' + failures + ' check(s) failed. Do NOT deploy this bundle.');
		process.exit(1);
	}
	console.log('\n[verify] Bundle looks good. Deploy it with:');
	console.log('         bun scripts/setup-remotion-lambda.ts');
}

main().catch((err: unknown) => {
	console.error('[verify] Bundle FAILED to build:', err);
	process.exit(1);
});
