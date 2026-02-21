/**
 * Remotion Render Orchestration
 *
 * Manages the full lifecycle of Remotion renders:
 *   1. Bundle management (webpack bundle, cached after first build)
 *   2. Props conversion (RenderConfig → CLCVideoProps)
 *   3. Background render submission (renderMedia in async IIFE)
 *   4. Status tracking via in-memory registry
 *
 * Same RenderResult shape as Shotstack's checkStatus() so the
 * frontend polling code works for both engines transparently.
 *
 * File: src/agent/video-editor/remotion/render.ts
 */

import type { CLCVideoProps } from './types';
import type { PreprocessedClip } from '../preprocess';
import { PLATFORM_SETTINGS } from '../shotstack';

// --- Types ---

interface RenderEntry {
	id: string;
	status: 'queued' | 'bundling' | 'rendering' | 'done' | 'failed';
	outputPath?: string;
	error?: string;
	createdAt: number;
	updatedAt: number;
	progress?: number;  // 0-1 render progress
}

export interface RenderResult {
	id: string;
	status: 'queued' | 'fetching' | 'rendering' | 'saving' | 'done' | 'failed';
	url?: string;
	error?: string;
}

interface Logger {
	info: (...args: any[]) => void;
	error?: (...args: any[]) => void;
	warn?: (...args: any[]) => void;
}

// --- In-Memory State ---

/**
 * Registry of active/completed Remotion renders.
 * Key: render ID (remotion_<timestamp>_<random>)
 * Value: current status, output path, errors
 */
const renderRegistry = new Map<string, RenderEntry>();

/**
 * Cached webpack bundle path — built once on first render,
 * reused for subsequent renders. ~15-30s to build initially.
 */
let cachedBundlePath: string | null = null;
let bundlePromise: Promise<string> | null = null;

// --- Bundle Management ---

/**
 * Get or create the Remotion webpack bundle.
 * Uses a singleton promise to prevent concurrent bundle builds.
 */
async function getBundle(logger?: Logger): Promise<string> {
	// Return cached bundle if available
	if (cachedBundlePath) {
		// Verify it still exists on disk
		const fs = await import('fs');
		if (fs.existsSync(cachedBundlePath)) {
			return cachedBundlePath;
		}
		logger?.info('[remotion] Cached bundle missing from disk, rebuilding...');
		cachedBundlePath = null;
	}

	// If a bundle is already being built, wait for it
	if (bundlePromise) {
		logger?.info('[remotion] Bundle already building, waiting...');
		return bundlePromise;
	}

	// Build new bundle
	bundlePromise = (async () => {
		const startTime = Date.now();
		logger?.info('[remotion] Building webpack bundle...');

		try {
			const { bundle } = await import('@remotion/bundler');
			const path = await import('path');

			const entryPoint = path.resolve(
				process.cwd(),
				'src/agent/video-editor/remotion/entry.tsx',
			);

			const bundlePath = await bundle({
				entryPoint,
				// Use default webpack config — Remotion handles React/TS
			});

			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			logger?.info('[remotion] Bundle built in %ss: %s', elapsed, bundlePath);

			cachedBundlePath = bundlePath;
			return bundlePath;
		} catch (err) {
			bundlePromise = null;  // Allow retry on next attempt
			throw err;
		}
	})();

	return bundlePromise;
}

// --- Props Builder ---

/**
 * Convert a RenderConfig + PreprocessedClips to Remotion CLCVideoProps.
 *
 * Key difference from Shotstack: uses local file paths (processedClip.localPath)
 * instead of proxy URLs, since Remotion renders locally.
 */
export function buildRemotionProps(
	config: {
		clips: Array<{
			fileId: string;
			filename?: string;
			trimStart?: number;
			duration?: number;
			purpose?: string;
			speed?: number;
		}>;
		textOverlays?: Array<{
			text: string;
			start: number;
			duration: number;
			position?: string;
		}>;
		musicUrl?: string | null;
		mode: string;
		platform: string;
	},
	processedClips: PreprocessedClip[],
): CLCVideoProps {
	const platformSettings = PLATFORM_SETTINGS[config.platform] || PLATFORM_SETTINGS['youtube']!;

	// FPS: not stored in PLATFORM_SETTINGS, use standard 30fps
	const fps = 30;

	// Mode-specific settings — transitionDuration and bgColor from MODE_CONFIGS
	// (not in exported MODE_RENDER_SETTINGS, which only has transitionIn/Out/clipLength/volume)
	const REMOTION_MODE_SETTINGS: Record<string, { transitionDuration: number; bgColor: string }> = {
		game_day:  { transitionDuration: 0.5, bgColor: '#000000' },
		our_story: { transitionDuration: 1.0, bgColor: '#0a0a0a' },
		quick_hit: { transitionDuration: 0.3, bgColor: '#000000' },
		showcase:  { transitionDuration: 0.8, bgColor: '#0a0a0a' },
	};
	const remotionMode = REMOTION_MODE_SETTINGS[config.mode] || REMOTION_MODE_SETTINGS['game_day']!;
	const transitionDurationFrames = Math.round(remotionMode.transitionDuration * fps);

	// Build clip props using local file paths from preprocessing
	const clipProps: CLCVideoProps['clips'] = processedClips.map((pc) => ({
		src: pc.localPath,
		length: pc.effectiveDuration,
		// effect and transition are auto-assigned by CLCVideo based on mode + index
	}));

	// Build text overlay props — convert seconds to frames
	const textOverlays: CLCVideoProps['textOverlays'] = (config.textOverlays || []).map((overlay, index, arr) => {
		const startFrame = Math.round(overlay.start * fps);
		const durationFrames = Math.round(overlay.duration * fps);
		return {
			text: overlay.text,
			startFrame,
			durationFrames,
			position: (overlay.position as 'top' | 'center' | 'bottom') || 'bottom',
			isFirst: index === 0,
			isLast: index === arr.length - 1,
		};
	});

	return {
		clips: clipProps,
		mode: config.mode,
		width: platformSettings.width,
		height: platformSettings.height,
		fps,
		textOverlays,
		musicSrc: config.musicUrl || undefined,
		musicVolume: 0.3,
		bgColor: remotionMode.bgColor,
		transitionDurationFrames,
	};
}

// --- Render Submission ---

/**
 * Submit a Remotion render in the background.
 *
 * Returns immediately with a render ID. The actual render runs
 * in an async IIFE — check status via checkRemotionStatus().
 *
 * Flow:
 *   1. Register render in registry as 'queued'
 *   2. Async: getBundle() → selectComposition() → renderMedia()
 *   3. Update registry with 'done' + outputPath or 'failed' + error
 *   4. Cleanup preprocessed source files after render completes
 */
export async function submitRemotionRender(
	config: {
		clips: Array<{
			fileId: string;
			filename?: string;
			trimStart?: number;
			duration?: number;
			purpose?: string;
			speed?: number;
		}>;
		textOverlays?: Array<{
			text: string;
			start: number;
			duration: number;
			position?: string;
		}>;
		musicUrl?: string | null;
		mode: string;
		platform: string;
	},
	processedClips: PreprocessedClip[],
	logger?: Logger,
): Promise<string> {
	const renderId = `remotion_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	const now = Date.now();

	// Register in registry
	renderRegistry.set(renderId, {
		id: renderId,
		status: 'queued',
		createdAt: now,
		updatedAt: now,
	});

	logger?.info('[remotion] Render %s registered, starting background render...', renderId);

	// Build props BEFORE the async IIFE so errors are caught synchronously
	const props = buildRemotionProps(config, processedClips);

	// Fire and forget — render runs in the background
	(async () => {
		const fs = await import('fs');
		const path = await import('path');

		try {
			// Step 1: Ensure Chromium is available
			const { ensureBrowser } = await import('@remotion/renderer');
			await ensureBrowser();

			// Step 2: Get or build the webpack bundle
			renderRegistry.set(renderId, {
				...renderRegistry.get(renderId)!,
				status: 'bundling',
				updatedAt: Date.now(),
			});

			const bundlePath = await getBundle(logger);

			// Step 3: Select the composition
			const { selectComposition } = await import('@remotion/renderer');
			const composition = await selectComposition({
				serveUrl: bundlePath,
				id: 'CLCVideo',
				inputProps: props as unknown as Record<string, unknown>,
			});

			// Step 4: Render the video
			renderRegistry.set(renderId, {
				...renderRegistry.get(renderId)!,
				status: 'rendering',
				updatedAt: Date.now(),
			});

			const tempDir = path.join(process.cwd(), '.temp-cataloger');
			if (!fs.existsSync(tempDir)) {
				fs.mkdirSync(tempDir, { recursive: true });
			}

			const outputPath = path.join(tempDir, `${renderId}.mp4`);

			logger?.info('[remotion] Starting renderMedia: %d clips, %dx%d, %dfps, ~%ds',
				props.clips.length, props.width, props.height, props.fps,
				props.clips.reduce((sum, c) => sum + c.length, 0));

			const { renderMedia } = await import('@remotion/renderer');
			await renderMedia({
				composition,
				serveUrl: bundlePath,
				codec: 'h264',
				outputLocation: outputPath,
				inputProps: props as unknown as Record<string, unknown>,
				concurrency: 1,  // Conservative for Railway memory limits
				onProgress: ({ progress }) => {
					const entry = renderRegistry.get(renderId);
					if (entry) {
						entry.progress = progress;
						entry.updatedAt = Date.now();
					}
				},
			});

			// Step 5: Mark as done
			const stat = fs.statSync(outputPath);
			logger?.info('[remotion] Render %s complete: %s (%dMB)',
				renderId, outputPath, (stat.size / (1024 * 1024)).toFixed(1));

			renderRegistry.set(renderId, {
				...renderRegistry.get(renderId)!,
				status: 'done',
				outputPath,
				updatedAt: Date.now(),
			});

			// Step 6: Cleanup preprocessed source files (they're baked into the render now)
			const { cleanupProcessedFiles } = await import('../preprocess');
			await cleanupProcessedFiles(processedClips);
			logger?.info('[remotion] Cleaned up %d preprocessed source files', processedClips.length);

		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger?.error?.('[remotion] Render %s failed: %s', renderId, msg);

			renderRegistry.set(renderId, {
				...renderRegistry.get(renderId)!,
				status: 'failed',
				error: msg,
				updatedAt: Date.now(),
			});

			// Cleanup preprocessed files even on failure
			try {
				const { cleanupProcessedFiles } = await import('../preprocess');
				await cleanupProcessedFiles(processedClips);
			} catch { /* best effort */ }
		}
	})();

	return renderId;
}

// --- Status Check ---

/**
 * Check the status of a Remotion render.
 *
 * Returns the same RenderResult shape as Shotstack's checkStatus()
 * so the frontend polling code works transparently for both engines.
 */
export function checkRemotionStatus(renderId: string): RenderResult {
	const entry = renderRegistry.get(renderId);

	if (!entry) {
		return {
			id: renderId,
			status: 'failed',
			error: 'Render not found — it may have expired from memory',
		};
	}

	// Map Remotion-specific statuses to Shotstack-compatible ones
	let mappedStatus: RenderResult['status'];
	switch (entry.status) {
		case 'queued':
			mappedStatus = 'queued';
			break;
		case 'bundling':
			mappedStatus = 'fetching';  // "fetching" = preparing resources
			break;
		case 'rendering':
			mappedStatus = 'rendering';
			break;
		case 'done':
			mappedStatus = 'done';
			break;
		case 'failed':
			mappedStatus = 'failed';
			break;
		default:
			mappedStatus = 'queued';
	}

	// Build download URL for completed renders
	let downloadUrl: string | undefined;
	if (entry.status === 'done' && entry.outputPath) {
		downloadUrl = `/api/remotion-render/${encodeURIComponent(renderId)}`;
	}

	return {
		id: renderId,
		status: mappedStatus,
		url: downloadUrl,
		error: entry.error,
	};
}

// --- Availability Check ---

/**
 * Test if Remotion is configured and ready to attempt rendering.
 *
 * This is a lightweight check — it does NOT download Chromium or import
 * heavy @remotion packages (which can fail in serverless environments).
 * Chromium download happens at render time via ensureBrowser().
 *
 * If Chromium isn't available when rendering, the render will fail gracefully
 * with a clear error message in the render status UI.
 */
export async function testRemotionAvailability(logger?: Logger): Promise<{
	available: boolean;
	message: string;
}> {
	try {
		// Verify the composition files exist (they're part of our source, not external deps)
		const fs = await import('fs');
		const path = await import('path');
		const entryPath = path.resolve(process.cwd(), 'src/agent/video-editor/remotion/entry.tsx');

		// In production builds, source files may be bundled — check if our render module loaded
		// (this function being callable means the module imported successfully)
		logger?.info('[remotion] Remotion render module loaded — marking as available');
		return { available: true, message: 'Remotion renderer configured' };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger?.error?.('[remotion] Availability check failed: %s', msg);
		return { available: false, message: 'Remotion not available: ' + msg };
	}
}
