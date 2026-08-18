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
import { buildDeterministicPlan, buildAudiencePlan, type RigPlan } from './plan';
import { detectAudioSpikes } from './audio-events';
import { measureShake, isTooShaky } from './shake-meter';
import type { Audience } from './audience-profiles';
import { buildSmartCropFilter, buildAudioFilter } from '../../src/agent/video-editor/remotion/preprocessor-lambda';
import { gateRender, formatGateResult, PUBLISH_THRESHOLDS } from '../../src/agent/video-editor/render-gate';
import type { CatalogEntry } from '../../src/agent/video-editor/google-drive';

const REPO = path.resolve(__dirname, '../..');
const CACHE_DIR = path.join(REPO, '.temp-cataloger', 'rig-sources');
const OUT_DIR = path.join(REPO, '.temp-cataloger', 'rig-out');
const CATALOG_SNAPSHOT = process.env.RIG_CATALOG
	|| '/mnt/c/Users/igord/AppData/Local/Temp/claude/c--Development-Folder-kg-content-studio/f72ad922-9381-4b7e-a380-b5238a92fd64/scratchpad/catalog-tail2.json';
/** Original 5-clip chess pool — kept verbatim so baseline runs stay reproducible. */
const DEFAULT_POOL = [
	'1qeuWWIBC_2bDPRsI8cxfDJTw7t_IbGK8',
	'14KeHRp8r3IdIU7u14l-1HCtAGVW53YlT',
	'16LHPzOubmg_FTb-XHNQz-0MLXJ30X0vz',
	'1eIhkOG3LotguNPluZUUp7G8KASAqJTaG',
	'1cXV2gbBQ1zdcgKACdR01VnFQbmjv1Rpp',
];

/**
 * Audience-mode pool: tennis-forward program story (2026-08-18 S3×catalog
 * scout — all scored, all with raw S3 copies). Tennis action + coaching +
 * the hug close, with the strongest chess for the "learning" half.
 */
const STORY_POOL = [
	'1drwT9RDitILPYVujPiOzKtFcB1epc0Xe', // kid striking ball, US Open courts (hook material)
	'1uJrbdi2BcY8WU_27Xo8pU98cwxwzvbB7', // e7 kid enthusiastic w/ racket; girl pointing/coaching
	'1eIhkOG3LotguNPluZUUp7G8KASAqJTaG', // e7 child with racket mid-action (cached)
	'1WYmlWu7Xmzd2jzqeNEVKJzQWZbbbSARp', // coach instructing kids on court — THE teaching clip
	'1l96zDhR3k6AbWJ0inFHEi5vHVQElQeGb', // e7 adult hugging child — emotional close
	'15Vwnt5yFa9iuFRqywUJAQHth72-kasE9', // e7 kid looking upward with intent — determination
	'1aEJa_3f9Oa3HF2lyYao_upIQYSAhUoQS', // tennis AND chess in one gym — program bridge
	'1saznKyQotS-V9AZOfkd1FGjsyygncOi6', // tennis drills, kids interacting e6
	'1qeuWWIBC_2bDPRsI8cxfDJTw7t_IbGK8', // chess: child celebrating move e8
	'16LHPzOubmg_FTb-XHNQz-0MLXJ30X0vz', // chess: happy reaction e8 (measured calm)
	'13AFVyZyktzgMMbX7m4jOeosfuVvWT-uw', // chess: kids celebrating a move, 61s
];

const MUSIC_FILE = path.join(REPO, '.temp-cataloger', 'rig-music-dreams.mp3'); // production's our_story track
const MUSIC_VOLUME = 0.28;   // render.ts fallback — what production actually ships
const CLIP_AUDIO_DUCK = 0.35; // raw gym ambience under the music bed (production leaves it at 1.0 — known flaw)

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
	// Older ffprobe builds (WSL) reject the stream_side_data section — fall
	// back to plain width/height + the legacy rotate tag.
	let out = '';
	try {
		out = execSync(
			`ffprobe -v error -select_streams v:0 -show_entries stream=width,height:stream_side_data=rotation -of default=noprint_wrappers=1 "${file}"`,
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
		);
	} catch {
		out = execSync(
			`ffprobe -v error -select_streams v:0 -show_entries stream=width,height:stream_tags=rotate -of default=noprint_wrappers=1 "${file}"`,
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
		);
	}
	let w = parseInt(out.match(/^width=(\d+)/m)?.[1] ?? '1920', 10);
	let h = parseInt(out.match(/^height=(\d+)/m)?.[1] ?? '1080', 10);
	const rot = Math.abs(parseInt(out.match(/rotation=(-?\d+)|rotate=(-?\d+)/)?.slice(1).find(Boolean) ?? '0', 10)) % 180;
	if (rot === 90) [w, h] = [h, w];
	return { w, h };
}

async function main() {
	const runName = process.argv[2] || `rig_${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '')}`;
	const audienceArg = (process.argv[3] || process.env.RIG_AUDIENCE || '').toLowerCase();
	const audience: Audience | null =
		audienceArg === 'parents' || audienceArg === 'donors' ? audienceArg : null;
	const runDir = path.join(OUT_DIR, runName);
	fs.mkdirSync(runDir, { recursive: true });

	// 1. Catalog + pool
	const snapshot = JSON.parse(fs.readFileSync(CATALOG_SNAPSHOT, 'utf8'));
	const catalog: CatalogEntry[] = snapshot.catalog ?? snapshot;
	const poolIds = audience ? STORY_POOL : DEFAULT_POOL;
	const pool = poolIds.map(id => {
		const entry = catalog.find(e => e.fileId === id);
		if (!entry) throw new Error(`pool video ${id} missing from catalog snapshot`);
		return { entry, durationSec: parseInt(entry.duration ?? '0') || 0 };
	});

	// 2. Plan — audience mode scores each edit role (hook/body/cta) for who is
	// watching and mines audio cheer spikes; bare mode keeps the old baseline.
	let plan: RigPlan;
	if (audience) {
		// Audience mode needs every source locally (audio spike pass). A source
		// with no S3 raw copy is dropped from the pool, not fatal.
		const available: typeof pool = [];
		const spikes: Record<string, number[]> = {};
		for (const p of pool) {
			try {
				const src = await ensureSource(p.entry.fileId!);
				spikes[p.entry.fileId!] = detectAudioSpikes(src);
				available.push(p);
			} catch (err) {
				console.warn(`[rig] dropping ${p.entry.fileId} from pool: ${(err as Error).message}`);
			}
		}
		console.log(`[rig] audio cheer spikes: ${available.map(p => `${p.entry.fileId!.slice(0, 6)}=${spikes[p.entry.fileId!]!.length}`).join(' ')}`);
		// Shake meter: measured lazily per candidate span at pick time, cached.
		const shakeCache = new Map<string, ReturnType<typeof measureShake>>();
		const shakeFn = (fileId: string, start: number, dur: number) => {
			const key = `${fileId}:${Math.round(start)}:${Math.round(dur)}`;
			if (!shakeCache.has(key)) {
				shakeCache.set(key, measureShake(path.join(CACHE_DIR, `${fileId}.mp4`), start, dur));
			}
			const r = shakeCache.get(key);
			return r ? { metric: r.metric, jitter: r.jitter, tooShaky: isTooShaky(r) } : null;
		};
		plan = buildAudiencePlan(available, audience, spikes, shakeFn);
		console.log(`[rig] audience: ${audience} (${shakeCache.size} shake measurements)`);
	} else {
		plan = buildDeterministicPlan(pool);
	}
	fs.writeFileSync(path.join(runDir, 'plan.json'), JSON.stringify(plan, null, 2));
	console.log(`[rig] plan: ${plan.clips.length} clips, ${plan.clips.reduce((s, c) => s + c.duration, 0).toFixed(1)}s total`);
	for (const c of plan.clips) {
		console.log(`  ${c.purpose.padEnd(10)} ${c.fileId.slice(0, 8)} ${c.trimStart}s+${c.duration}s zoom=${c.extraZoom} "${c.why}"`);
	}
	if (process.env.RIG_PLAN_ONLY) {
		console.log('[rig] RIG_PLAN_ONLY set — stopping after plan.');
		return;
	}

	// 3. Preprocess each clip locally with the Lambda's own filters.
	// Audience mode adds: (a) two-pass vidstab stabilization ahead of the smart
	// crop — handheld shake was the operator's top complaint, and the stills-
	// scored catalog can't see it; (b) raw gym ambience ducked under the music
	// bed (production plays it at 1.0 — a known flaw to port back).
	const processed: Array<{ src: string; length: number }> = [];
	for (let i = 0; i < plan.clips.length; i++) {
		const clip = plan.clips[i]!;
		const src = await ensureSource(clip.fileId);
		const { w, h } = probeDims(src);
		const crop = buildSmartCropFilter(w, h, '9:16', clip.subjectPosition, clip.extraZoom);
		let vf = crop;
		if (audience) {
			const trf = path.join(runDir, `clip_${i}.trf`);
			console.log(`[rig] stabilize pass (detect) clip ${i + 1}/${plan.clips.length}...`);
			execSync(
				`ffmpeg -nostdin -y -loglevel error -ss ${clip.trimStart} -t ${clip.duration} -i "${src}" -vf "vidstabdetect=shakiness=8:accuracy=15:result=${trf}" -an -f null -`,
				{ stdio: 'pipe', timeout: 300_000 },
			);
			const stab = `vidstabtransform=input=${trf}:smoothing=30:optzoom=1:interpol=bicubic:crop=black,unsharp=5:5:0.8:3:3:0.4`;
			vf = crop ? `${stab},${crop}` : stab;
		}
		// Older local ffmpeg can't negotiate channel layout between aresample and
		// afade — pin stereo up front. (Lambda's newer build needs no pin.)
		const afBase = buildAudioFilter(clip.speed, clip.duration);
		const duck = audience ? `volume=${CLIP_AUDIO_DUCK},` : '';
		// Some sources also need the stereo pin re-asserted AFTER aresample or
		// the aresample->afade link fails to negotiate a layout (WSL ffmpeg 4.4).
		const afPinned = afBase?.replace('aresample=48000', 'aresample=48000,aformat=channel_layouts=stereo');
		const af = afPinned ? `aformat=channel_layouts=stereo,${duck}${afPinned}` : afPinned;
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

	// 4. Local Remotion render — same composition as the cloud.
	// The composition consumes URL sources (the cloud hands it S3 URLs), so
	// serve the preprocessed clips over localhost for the render's duration.
	const PORT = 8899;
	const { spawn } = await import('node:child_process');
	const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', runDir], {
		stdio: 'ignore',
		detached: false,
	});
	await new Promise(r => setTimeout(r, 1500));

	const props = {
		clips: processed.map(p => ({ src: `http://localhost:${PORT}/${path.basename(p.src)}`, length: p.length, trimStart: 0 })),
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
		musicSrc: (() => {
			// Audience mode renders with the same track production would pick for
			// our_story, served over localhost like the clips.
			if (!audience || !fs.existsSync(MUSIC_FILE)) return undefined;
			fs.copyFileSync(MUSIC_FILE, path.join(runDir, 'rig-music.mp3'));
			return `http://localhost:${PORT}/rig-music.mp3`;
		})(),
		musicVolume: audience ? MUSIC_VOLUME : 0,
		bgColor: '#0a0a0a',
		transitionDurationFrames: 30,
	};
	const propsFile = path.join(runDir, 'props.json');
	fs.writeFileSync(propsFile, JSON.stringify(props));

	const outVideo = path.join(runDir, `${runName}.mp4`);
	console.log('[rig] rendering locally (bundle + render)...');
	try {
		execSync(
			`bunx remotion render "${path.join(REPO, 'src/agent/video-editor/remotion/entry.tsx')}" CLCVideo "${outVideo}" --props="${propsFile}" --codec=h264 --concurrency=4 --log=error`,
			{ stdio: 'inherit', cwd: REPO, timeout: 1_800_000 },
		);
	} finally {
		server.kill();
	}

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
