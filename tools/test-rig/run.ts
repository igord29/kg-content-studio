/**
 * Local test rig — the zero-API-cost iterate-and-measure loop.
 *
 *   bun tools/test-rig/run.ts [runName]
 *
 * plan (deterministic, from paid-for shot lists) → preprocess (the SAME
 * FFmpeg crop/audio filters the Lambda runs) → local Remotion render (the
 * SAME composition the cloud renders) → measured gate (the SAME thresholds
 * production uses). No OpenAI, no Lambda, no Anthropic — iterate for free,
 * spend only when a configuration wins here.
 *
 * Sources come from the S3 temp-clips left by past cloud renders (paid for
 * once, cached locally forever under .temp-cataloger/rig-sources/).
 *
 * File: tools/test-rig/run.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { buildDeterministicPlan, type RigPlan } from './plan';
import { buildSmartCropFilter, buildAudioFilter } from '../../src/agent/video-editor/remotion/preprocessor-lambda';
import { gateRender, formatGateResult, PUBLISH_THRESHOLDS } from '../../src/agent/video-editor/render-gate';
import type { CatalogEntry } from '../../src/agent/video-editor/google-drive';

const REPO = path.resolve(__dirname, '../..');
const CACHE_DIR = path.join(REPO, '.temp-cataloger', 'rig-sources');
const OUT_DIR = path.join(REPO, '.temp-cataloger', 'rig-out');
const CATALOG_SNAPSHOT = process.env.RIG_CATALOG
	|| '/mnt/c/Users/igord/AppData/Local/Temp/claude/c--Development-Folder-kg-content-studio/f72ad922-9381-4b7e-a380-b5238a92fd64/scratchpad/catalog-tail2.json';
const DEFAULT_POOL = [
	'1qeuWWIBC_2bDPRsI8cxfDJTw7t_IbGK8',
	'14KeHRp8r3IdIU7u14l-1HCtAGVW53YlT',
	'16LHPzOubmg_FTb-XHNQz-0MLXJ30X0vz',
	'1eIhkOG3LotguNPluZUUp7G8KASAqJTaG',
	'1cXV2gbBQ1zdcgKACdR01VnFQbmjv1Rpp',
];

const s3 = new S3Client({
	region: process.env.REMOTION_AWS_REGION || 'us-east-1',
	credentials: {
		accessKeyId: process.env.REMOTION_AWS_ACCESS_KEY_ID!,
		secretAccessKey: process.env.REMOTION_AWS_SECRET_ACCESS_KEY!,
	},
});
const BUCKET = process.env.REMOTION_BUCKET_NAME!;

async function ensureSource(fileId: string): Promise<string> {
	fs.mkdirSync(CACHE_DIR, { recursive: true });
	const local = path.join(CACHE_DIR, `${fileId}.mp4`);
	if (fs.existsSync(local) && fs.statSync(local).size > 1e6) return local;

	// Find a raw copy in any past render's temp-clips upload.
	console.log(`[rig] searching S3 for source ${fileId}...`);
	let token: string | undefined;
	let key: string | undefined;
	do {
		const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'temp-clips/', ContinuationToken: token }));
		key = (page.Contents ?? []).find(o => o.Key?.endsWith(`/${fileId}.mp4`) && (o.Size ?? 0) > 50e6)?.Key ?? undefined;
		token = page.NextContinuationToken;
	} while (!key && token);
	if (!key) throw new Error(`No raw S3 copy of ${fileId} — run a cloud render with it once, or add a Drive download path`);

	console.log(`[rig] downloading s3://${BUCKET}/${key} ...`);
	const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
	const bytes = await obj.Body!.transformToByteArray();
	fs.writeFileSync(local, Buffer.from(bytes));
	console.log(`[rig] cached ${(bytes.length / 1e6).toFixed(0)}MB -> ${local}`);
	return local;
}

function probeDims(file: string): { w: number; h: number } {
	const out = execSync(
		`ffprobe -v error -select_streams v:0 -show_entries stream=width,height:stream_side_data=rotation -of default=noprint_wrappers=1 "${file}"`,
		{ encoding: 'utf8' },
	);
	let w = parseInt(out.match(/^width=(\d+)/m)?.[1] ?? '1920', 10);
	let h = parseInt(out.match(/^height=(\d+)/m)?.[1] ?? '1080', 10);
	const rot = Math.abs(parseInt(out.match(/rotation=(-?\d+)/)?.[1] ?? '0', 10)) % 180;
	if (rot === 90) [w, h] = [h, w];
	return { w, h };
}

async function main() {
	const runName = process.argv[2] || `rig_${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '')}`;
	const runDir = path.join(OUT_DIR, runName);
	fs.mkdirSync(runDir, { recursive: true });

	// 1. Catalog + pool
	const snapshot = JSON.parse(fs.readFileSync(CATALOG_SNAPSHOT, 'utf8'));
	const catalog: CatalogEntry[] = snapshot.catalog ?? snapshot;
	const pool = DEFAULT_POOL.map(id => {
		const entry = catalog.find(e => e.fileId === id);
		if (!entry) throw new Error(`pool video ${id} missing from catalog snapshot`);
		return { entry, durationSec: parseInt(entry.duration ?? '0') || 0 };
	});

	// 2. Deterministic plan
	const plan: RigPlan = buildDeterministicPlan(pool);
	fs.writeFileSync(path.join(runDir, 'plan.json'), JSON.stringify(plan, null, 2));
	console.log(`[rig] plan: ${plan.clips.length} clips, ${plan.clips.reduce((s, c) => s + c.duration, 0).toFixed(1)}s total`);
	for (const c of plan.clips) {
		console.log(`  ${c.purpose.padEnd(9)} ${c.fileId.slice(0, 8)} ${c.trimStart}s+${c.duration}s zoom=${c.extraZoom} "${c.why}"`);
	}

	// 3. Preprocess each clip locally with the Lambda's own filters
	const processed: Array<{ src: string; length: number }> = [];
	for (let i = 0; i < plan.clips.length; i++) {
		const clip = plan.clips[i]!;
		const src = await ensureSource(clip.fileId);
		const { w, h } = probeDims(src);
		const vf = buildSmartCropFilter(w, h, '9:16', clip.subjectPosition, clip.extraZoom);
		const af = buildAudioFilter(clip.speed, clip.duration);
		const outFile = path.join(runDir, `clip_${i}_${clip.purpose}.mp4`);
		const vfArg = vf ? `-vf "${vf}"` : '';
		const afArg = af ? `-af "${af}"` : '';
		console.log(`[rig] preprocess clip ${i + 1}/${plan.clips.length} (${clip.purpose})...`);
		execSync(
			`ffmpeg -y -loglevel error -ss ${clip.trimStart} -t ${clip.duration} -i "${src}" ${vfArg} ${afArg} -r 30 -c:v libx264 -preset fast -crf 18 -c:a aac "${outFile}"`,
			{ stdio: 'pipe', timeout: 300_000 },
		);
		processed.push({ src: outFile, length: clip.duration });
	}

	// 4. Local Remotion render — same composition as the cloud
	const props = {
		clips: processed.map(p => ({ src: p.src, length: p.length, trimStart: 0 })),
		mode: plan.mode,
		width: 1080,
		height: 1920,
		fps: 30,
		textOverlays: plan.textOverlays.map((o, idx, arr) => ({
			text: o.text,
			startFrame: Math.round(o.start * 30),
			durationFrames: Math.round(o.duration * 30),
			position: o.position,
			isFirst: idx === 0,
			isLast: idx === arr.length - 1,
			animation: o.animation,
		})),
		musicSrc: undefined,
		musicVolume: 0,
		bgColor: '#0a0a0a',
		transitionDurationFrames: 30,
	};
	const propsFile = path.join(runDir, 'props.json');
	fs.writeFileSync(propsFile, JSON.stringify(props));

	const outVideo = path.join(runDir, `${runName}.mp4`);
	console.log('[rig] rendering locally (bundle + render)...');
	execSync(
		`bunx remotion render "${path.join(REPO, 'src/agent/video-editor/remotion/entry.tsx')}" CLCVideo "${outVideo}" --props="${propsFile}" --codec=h264 --concurrency=4 --log=error`,
		{ stdio: 'inherit', cwd: REPO, timeout: 1_800_000 },
	);

	// 5. Measure with the production gate
	console.log('[rig] measuring...');
	const gate = await gateRender(outVideo, PUBLISH_THRESHOLDS, plan.clips.map(c => c.duration / c.speed));
	console.log(formatGateResult(gate));
	fs.writeFileSync(path.join(runDir, 'gate.json'), JSON.stringify(gate, null, 2));

	console.log(`\n[rig] DONE -> ${outVideo}`);
	console.log(`[rig] artifacts in ${runDir} (plan.json, gate.json, per-clip files)`);
	console.log('[rig] optional framing metrics: python3 tools/quality-gate.py ' + outVideo);
}

main().catch(err => {
	console.error('[rig] FAILED:', err?.message || err);
	process.exit(1);
});
