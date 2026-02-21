/**
 * Shotstack Cloud Video Rendering Integration
 *
 * Handles: timeline building, render submission, status polling,
 * and Google Drive file access for Shotstack rendering.
 *
 * Shotstack API docs: https://shotstack.io/docs/api/
 *
 * File: src/agent/video-editor/shotstack.ts
 */

// --- Types ---

export interface ShotstackConfig {
	apiKey: string;
	environment: 'stage' | 'v1' | 'production';
}

export interface EditConfig {
	mode: 'game_day' | 'our_story' | 'quick_hit' | 'showcase';
	clips: Array<{
		sourceUrl: string;
		startTime: number;    // trim start in seconds
		duration: number;     // clip length in seconds
		label?: string;
	}>;
	music?: {
		tier: 2 | 3;
		sourceUrl?: string;
		volume?: number;
	};
	overlays?: Array<{
		text: string;
		position: 'top' | 'center' | 'bottom';
		startTime: number;
		duration: number;
		style?: 'title' | 'subtitle' | 'lower-third' | 'stat-card';
	}>;
	output: {
		format: 'mp4';
		resolution: 'sd' | 'hd' | '1080';
		aspectRatio: '16:9' | '9:16' | '1:1' | '4:5';
		fps: 25 | 30;
	};
	branding: {
		logoUrl?: string;
		primaryColor: string;   // #1B4D3E
		secondaryColor: string; // #C9A84C
	};
}

export interface RenderResult {
	id: string;
	status: 'queued' | 'fetching' | 'rendering' | 'saving' | 'done' | 'failed';
	url?: string;
	error?: string;
	created?: string;
	updated?: string;
}

interface ShotstackTimeline {
	timeline: {
		soundtrack?: {
			src: string;
			effect: string;
			volume: number;
		};
		tracks: Array<{
			clips: Array<{
				asset: Record<string, unknown>;
				start: number;
				length: number;
				transition?: Record<string, string>;
				fit?: string;
				position?: string;
				offset?: Record<string, number>;
			}>;
		}>;
	};
	output: {
		format: string;
		resolution: string;
		fps: number;
		aspectRatio?: string;
		size?: {
			width: number;
			height: number;
		};
	};
}

// --- Config ---

function getConfig(): ShotstackConfig {
	const apiKey = process.env.SHOTSTACK_API_KEY;
	if (!apiKey || apiKey === 'your_api_key_here') {
		throw new Error(
			'SHOTSTACK_API_KEY not configured. Set it in .env. ' +
			'Get your key at https://shotstack.io/dashboard/'
		);
	}
	const rawEnv = process.env.SHOTSTACK_ENV || 'stage';
	const environment = (rawEnv === 'production' ? 'v1' : rawEnv) as 'stage' | 'v1';
	return { apiKey, environment };
}

function getBaseUrl(): string {
	const config = getConfig();
	// Map 'production' to 'v1' since Shotstack's API endpoint uses 'v1' not 'production'
	const envPath = config.environment === 'v1' ? 'v1' : 'stage';
	return `https://api.shotstack.io/${envPath}`;
}

function getHeaders(): Record<string, string> {
	const config = getConfig();
	return {
		'Content-Type': 'application/json',
		'x-api-key': config.apiKey,
	};
}

// --- Resolution mappings ---

const ASPECT_RATIO_SIZES: Record<string, { width: number; height: number }> = {
	'16:9': { width: 1920, height: 1080 },
	'9:16': { width: 1080, height: 1920 },
	'1:1': { width: 1080, height: 1080 },
	'4:5': { width: 1080, height: 1350 },
};

// --- Platform-specific output settings ---

export const PLATFORM_SETTINGS: Record<string, { width: number; height: number; maxDuration: number; aspectRatio: string }> = {
	tiktok:    { width: 1080, height: 1920, maxDuration: 60, aspectRatio: '9:16' },
	ig_reels:  { width: 1080, height: 1920, maxDuration: 90, aspectRatio: '9:16' },
	'ig-reels': { width: 1080, height: 1920, maxDuration: 90, aspectRatio: '9:16' },
	ig_feed:   { width: 1080, height: 1080, maxDuration: 60, aspectRatio: '1:1' },
	'ig-feed': { width: 1080, height: 1080, maxDuration: 60, aspectRatio: '1:1' },
	youtube:   { width: 1920, height: 1080, maxDuration: 600, aspectRatio: '16:9' },
	facebook:  { width: 1920, height: 1080, maxDuration: 240, aspectRatio: '16:9' },
	linkedin:  { width: 1920, height: 1080, maxDuration: 120, aspectRatio: '16:9' },
};

// --- Mode-specific render pacing ---

export const MODE_RENDER_SETTINGS: Record<string, { transitionIn: string; transitionOut: string; defaultClipLength: number; volume: number }> = {
	game_day:  { transitionIn: 'carouselRight', transitionOut: 'carouselLeft', defaultClipLength: 4, volume: 0.8 },
	our_story: { transitionIn: 'fade', transitionOut: 'fade', defaultClipLength: 8, volume: 0.5 },
	quick_hit: { transitionIn: 'slideRight', transitionOut: 'slideLeft', defaultClipLength: 4, volume: 0.7 },
	showcase:  { transitionIn: 'fadeSlow', transitionOut: 'fadeSlow', defaultClipLength: 6, volume: 0.4 },
};

// --- Mode-specific transition and pacing configs ---

interface ModeConfig {
	transitionIn: string;
	transitionOut: string;
	transitionDuration: number;
	titleStyle: string;
	titleSize: string;
	filter?: string;        // Shotstack filter applied to video clips
	effect?: string;        // Shotstack effect (motion) for clips: zoomIn, zoomOut, slideRight, etc.
	bgColor: string;        // Timeline background color (prevents black flashes)
}

const MODE_CONFIGS: Record<string, ModeConfig> = {
	game_day: {
		transitionIn: 'carouselRight',
		transitionOut: 'carouselLeft',
		transitionDuration: 0.5,  // fast but visible — keeps the energy up
		titleStyle: 'blockbuster',
		titleSize: 'large',
		filter: 'boost',      // +saturation/contrast for vibrancy
		bgColor: '#000000',
	},
	our_story: {
		transitionIn: 'fade',
		transitionOut: 'fade',
		transitionDuration: 1.0,  // slow, emotional — breathing room between story beats
		titleStyle: 'minimal',
		titleSize: 'medium',
		effect: 'zoomIn',    // gentle Ken Burns drift
		bgColor: '#0a0a0a',
	},
	quick_hit: {
		transitionIn: 'slideRight',
		transitionOut: 'slideLeft',
		transitionDuration: 0.3,  // snappy — platform-native feel
		titleStyle: 'minimal',
		titleSize: 'small',
		bgColor: '#000000',
	},
	showcase: {
		transitionIn: 'fadeSlow',
		transitionOut: 'fadeSlow',
		transitionDuration: 1.2,  // cinematic, smooth — measured and confident
		titleStyle: 'minimal',
		titleSize: 'large',
		effect: 'zoomIn',    // slow push-in for cinematic feel
		bgColor: '#000000',
	},
};

// --- Mode-specific clip effect pools (Ken Burns-style motion) ---
// Cycling through these prevents every clip from having the same motion
const CLIP_EFFECT_POOLS: Record<string, string[]> = {
	game_day:  ['zoomIn', 'slideRight', 'slideLeft', 'zoomOut'],
	our_story: ['zoomIn', 'zoomOut'],        // gentle, intentional
	quick_hit: ['slideRight', 'slideLeft'],   // fast, platform-native
	showcase:  ['zoomIn', 'zoomOut', 'slideRight'], // cinematic variety
};

// --- Core Functions ---

/**
 * Build a Shotstack timeline JSON from our edit config
 */
export function buildShotstackTimeline(config: EditConfig): ShotstackTimeline {
	const modeConfig: ModeConfig = MODE_CONFIGS[config.mode] ?? MODE_CONFIGS['our_story']!;
	const size = ASPECT_RATIO_SIZES[config.output.aspectRatio] || ASPECT_RATIO_SIZES['16:9'];
	const effectPool = CLIP_EFFECT_POOLS[config.mode] || CLIP_EFFECT_POOLS['game_day']!;

	// Track 1: Video clips with effects, filters, and proper volume
	let currentTime = 0;
	const videoClips = config.clips.map((clip, index) => {
		const clipEffect = effectPool[index % effectPool.length];
		let clipVolume = 0.5;
		if (config.music?.sourceUrl) {
			clipVolume = 0.25; // lower when music is playing
		}

		const entry: Record<string, unknown> = {
			asset: {
				type: 'video',
				src: clip.sourceUrl,
				trim: clip.startTime,
				volume: clipVolume,
			},
			start: currentTime,
			length: clip.duration,
			transition: {
				in: modeConfig.transitionIn,
				out: modeConfig.transitionOut,
			},
			fit: 'cover' as string,
			effect: clipEffect,
		};

		if (modeConfig.filter) {
			entry.filter = modeConfig.filter;
		}

		currentTime += clip.duration - modeConfig.transitionDuration;
		return entry;
	});

	// Track 2: Text overlays — use HTML asset for professional styling
	const textClips = (config.overlays || []).map((overlay, idx) => {
		const position = overlay.position === 'bottom' ? 'bottom'
			: overlay.position === 'top' ? 'top'
			: 'center';
		const isFirst = idx === 0;
		const isLast = idx === (config.overlays?.length || 0) - 1;
		const textStyle = getTextStyle(config.mode, position, isFirst, isLast);

		return {
			asset: {
				type: 'html',
				html: textStyle.html(overlay.text),
				css: textStyle.css,
				width: textStyle.width,
				height: textStyle.height,
			},
			start: overlay.startTime,
			length: overlay.duration,
			transition: {
				in: 'fade',
				out: 'fadeFast',
			},
			position: position,
			offset: position === 'bottom' ? { y: -0.08 } : undefined,
		};
	});

	// Calculate video duration for background track
	const lastVideoClip = videoClips[videoClips.length - 1] as { start: number; length: number } | undefined;
	const legacyVideoDuration = lastVideoClip ? lastVideoClip.start + lastVideoClip.length : 0;

	// Build tracks (text on top, video middle, background color bottom)
	const tracks: ShotstackTimeline['timeline']['tracks'] = [];

	if (textClips.length > 0) {
		tracks.push({ clips: textClips as any });
	}
	tracks.push({ clips: videoClips as any });

	// Add background color track to prevent black frames during transitions
	if (legacyVideoDuration > 0 && size) {
		tracks.push({
			clips: [{
				asset: {
					type: 'html',
					html: `<div style="width:100%;height:100%;background-color:${modeConfig.bgColor};"></div>`,
					css: '',
					width: size.width,
					height: size.height,
				},
				start: 0,
				length: legacyVideoDuration + 1,
			}] as any,
		});
	}

	// Soundtrack
	const soundtrack = config.music?.sourceUrl
		? {
			src: config.music.sourceUrl,
			effect: 'fadeInFadeOut' as string,
			volume: config.music.volume ?? 0.3,
		}
		: undefined;

	return {
		timeline: {
			soundtrack,
			tracks,
			background: modeConfig.bgColor,
			fonts: [
				{ src: 'https://fonts.gstatic.com/s/montserrat/v26/JTUHjIg1_i6t8kCHKm4532VJOt5-QNFgpCuM70w-Y3tcoqK5.ttf' },
				{ src: 'https://fonts.gstatic.com/s/montserrat/v26/JTUHjIg1_i6t8kCHKm4532VJOt5-QNFgpCu173w-Y3tcoqK5.ttf' },
			],
		} as any,
		output: {
			format: config.output.format,
			resolution: config.output.resolution === '1080' ? 'hd' : config.output.resolution,
			fps: config.output.fps,
			size,
			quality: 'high',
		} as any,
	};
}

/**
 * Submit a render job to Shotstack
 * Returns the render ID for status polling
 */
export async function submitRender(config: EditConfig): Promise<string> {
	const timeline = buildShotstackTimeline(config);
	const baseUrl = getBaseUrl();
	const headers = getHeaders();

	const response = await fetch(`${baseUrl}/render`, {
		method: 'POST',
		headers,
		body: JSON.stringify(timeline),
	});

	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Shotstack render submission failed (${response.status}): ${errorBody}`);
	}

	const data = await response.json() as { response: { id: string; message: string } };
	return data.response.id;
}

/**
 * Check the status of a render job
 */
export async function checkStatus(renderId: string): Promise<RenderResult> {
	const baseUrl = getBaseUrl();
	const headers = getHeaders();

	const response = await fetch(`${baseUrl}/render/${renderId}`, {
		method: 'GET',
		headers,
	});

	if (!response.ok) {
		throw new Error(`Shotstack status check failed (${response.status})`);
	}

	const data = await response.json() as {
		response: {
			id: string;
			status: string;
			url?: string;
			error?: string;
			created?: string;
			updated?: string;
		};
	};

	return {
		id: data.response.id,
		status: data.response.status as RenderResult['status'],
		url: data.response.url,
		error: data.response.error,
		created: data.response.created,
		updated: data.response.updated,
	};
}

/**
 * Poll for render completion
 * Returns the final result with download URL when done
 */
export async function waitForRender(
	renderId: string,
	timeoutMs: number = 300000, // 5 minute default
	pollIntervalMs: number = 5000, // 5 second poll interval
): Promise<RenderResult> {
	const startTime = Date.now();

	while (Date.now() - startTime < timeoutMs) {
		const result = await checkStatus(renderId);

		if (result.status === 'done') {
			return result;
		}

		if (result.status === 'failed') {
			throw new Error(`Render failed: ${result.error || 'Unknown error'}`);
		}

		// Still in progress (queued, fetching, rendering, saving)
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}

	throw new Error(`Render timed out after ${timeoutMs / 1000}s. Render ID: ${renderId}`);
}

/**
 * Generate a temporary publicly-accessible URL for a Google Drive file.
 * Creates a public reader permission, returns the direct download link.
 *
 * IMPORTANT: Call revokePublicUrl() after the render completes to remove public access.
 */
export async function getTemporaryPublicUrl(fileId: string): Promise<string> {
	// Use shared auth/drive from google-drive module
	const { getAuth } = await import('./google-drive');
	const { drive_v3 } = await import('@googleapis/drive');

	const authClient = getAuth();
	const drive = new drive_v3.Drive({ auth: authClient });

	// Create a public "reader" permission
	await drive.permissions.create({
		fileId,
		requestBody: {
			role: 'reader',
			type: 'anyone',
		},
	});

	// Get the webContentLink which handles large files without the virus-scan confirmation page.
	// Falls back to uc?export=download for files that don't have webContentLink.
	try {
		const file = await drive.files.get({
			fileId,
			fields: 'webContentLink',
		});
		if (file.data.webContentLink) {
			return file.data.webContentLink;
		}
	} catch {
		// Fall through to default URL
	}

	return `https://drive.google.com/uc?export=download&confirm=t&id=${fileId}`;
}

/**
 * Revoke public access from a Google Drive file after rendering
 */
export async function revokePublicUrl(fileId: string): Promise<void> {
	// Use shared auth/drive from google-drive module
	const { getAuth } = await import('./google-drive');
	const { drive_v3 } = await import('@googleapis/drive');

	const authClient = getAuth();
	const drive = new drive_v3.Drive({ auth: authClient });

	// List permissions to find the "anyone" permission
	const perms = await drive.permissions.list({ fileId });
	const anyonePerm = (perms.data.permissions || []).find(
		(p) => p.type === 'anyone',
	);

	if (anyonePerm?.id) {
		await drive.permissions.delete({
			fileId,
			permissionId: anyonePerm.id,
		});
	}
}

/**
 * Convenience: render a video and wait for completion
 */
export async function renderAndWait(config: EditConfig): Promise<RenderResult> {
	const renderId = await submitRender(config);
	return waitForRender(renderId);
}

/**
 * Test connectivity to the Shotstack API
 */
export async function testShotstackConnection(): Promise<{ success: boolean; message: string }> {
	const apiKey = process.env.SHOTSTACK_API_KEY || '';
	const env = process.env.SHOTSTACK_ENV || 'stage';

	if (!apiKey || apiKey === 'your_api_key_here') {
		return { success: false, message: 'SHOTSTACK_API_KEY not set' };
	}

	const baseUrl = env === 'production' || env === 'v1'
		? 'https://api.shotstack.io/v1'
		: 'https://api.shotstack.io/stage';

	try {
		// POST /render with empty body: 400 = auth valid but bad request (expected),
		// 200 = unlikely but valid, 401/403 = bad API key
		const response = await fetch(`${baseUrl}/render`, {
			method: 'POST',
			headers: {
				'x-api-key': apiKey,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({}),
		});

		if (response.status === 400 || response.ok) {
			return { success: true, message: 'Cloud render connected (' + env + ' environment)' };
		}

		if (response.status === 401 || response.status === 403) {
			return { success: false, message: 'Invalid API key (status ' + response.status + ')' };
		}

		const text = await response.text();
		return { success: false, message: 'Cloud render returned status ' + response.status + ': ' + text.substring(0, 200) };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { success: false, message: 'Cloud render connection failed: ' + msg };
	}
}

/**
 * Submit a pre-built timeline object to Shotstack for rendering.
 * Unlike submitRender (which takes an EditConfig), this takes a raw timeline object.
 */
export async function submitRenderTimeline(timeline: object): Promise<string> {
	const baseUrl = getBaseUrl();
	const headers = getHeaders();

	const response = await fetch(`${baseUrl}/render`, {
		method: 'POST',
		headers,
		body: JSON.stringify(timeline),
	});

	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Shotstack render submission failed (${response.status}): ${errorBody}`);
	}

	const data = await response.json() as { response: { id: string; message: string } };
	return data.response.id;
}

/**
 * Build a Shotstack timeline from a simplified render config.
 * Used by the render task to convert edit plans into Shotstack JSON.
 */
export interface RenderConfig {
	clips: Array<{ src: string; trim?: number; length?: number }>;
	mode: string;
	platform: string;
	textOverlays?: Array<{ text: string; start: number; duration: number; position?: string }>;
	musicUrl?: string | null;
}

export function buildRenderTimeline(config: RenderConfig): object {
	const platformSettings = PLATFORM_SETTINGS[config.platform] || PLATFORM_SETTINGS['youtube']!;
	const modeSettings = MODE_RENDER_SETTINGS[config.mode] || MODE_RENDER_SETTINGS['game_day']!;
	const modeConfig = MODE_CONFIGS[config.mode] || MODE_CONFIGS['game_day']!;

	// --- Brand constants ---
	const BRAND_GREEN = '#1B4D3E';
	const BRAND_GOLD = '#C9A84C';
	const BRAND_WHITE = '#FFFFFF';

	// Transition variety per mode — keeps edits from feeling repetitive
	const TRANSITION_POOLS: Record<string, Array<{ in: string; out: string }>> = {
		game_day: [
			{ in: 'carouselRight', out: 'carouselLeft' },
			{ in: 'slideRight', out: 'slideLeft' },
			{ in: 'wipeRight', out: 'wipeLeft' },
			{ in: 'fade', out: 'fade' },
			{ in: 'zoom', out: 'fade' },
		],
		our_story: [
			{ in: 'fade', out: 'fade' },
			{ in: 'fadeSlow', out: 'fadeSlow' },
			{ in: 'reveal', out: 'fade' },
			{ in: 'fade', out: 'fadeSlow' },
		],
		quick_hit: [
			{ in: 'slideRight', out: 'slideLeft' },
			{ in: 'fade', out: 'fade' },
			{ in: 'wipeRight', out: 'wipeLeft' },
			{ in: 'zoom', out: 'fade' },
		],
		showcase: [
			{ in: 'fadeSlow', out: 'fadeSlow' },
			{ in: 'fade', out: 'fade' },
			{ in: 'reveal', out: 'fadeSlow' },
			{ in: 'slideRight', out: 'slideLeft' },
			{ in: 'zoom', out: 'fadeSlow' },
		],
	};
	const transitionPool = TRANSITION_POOLS[config.mode] || TRANSITION_POOLS['game_day']!;

	// Clip effect pool for Ken Burns-style motion
	const effectPool = CLIP_EFFECT_POOLS[config.mode] || CLIP_EFFECT_POOLS['game_day']!;

	// Build video clips track
	let currentStart = 0;
	const totalClips = config.clips.length;
	const transitionDuration = modeConfig.transitionDuration;
	const videoClips = config.clips.map((clip, index) => {
		const rawLength = clip.length || modeSettings.defaultClipLength;
		// Enforce minimum: must be at least 2x transition duration + 1s of visible content
		const minLength = (transitionDuration * 2) + 1;
		const clipLength = Math.max(rawLength, minLength);
		// Cycle through transition pool for variety — first clip always uses mode default
		const transition = index === 0
			? { in: modeSettings.transitionIn, out: modeSettings.transitionOut }
			: transitionPool[index % transitionPool.length]!;

		// Cycle through effects for dynamic motion (every clip should move)
		const clipEffect = effectPool[index % effectPool.length];

		// Audio: lower volume on clips so music can breathe (if music present)
		// First and last clips get a slight volume dip for clean in/out
		let clipVolume = modeSettings.volume;
		if (config.musicUrl) {
			clipVolume = Math.max(0.15, clipVolume - 0.2); // reduce when music plays
		}

		const clipObj: Record<string, unknown> = {
			asset: {
				type: 'video' as const,
				src: clip.src,
				trim: clip.trim || 0,
				volume: clipVolume,
			},
			start: currentStart,
			length: clipLength,
			transition,
			fit: 'cover' as const,
			effect: clipEffect,     // Ken Burns motion on every clip
		};

		// Apply mode-specific color filter (boost for game_day energy, etc.)
		if (modeConfig.filter) {
			clipObj.filter = modeConfig.filter;
		}

		// Subtract transition duration so clips overlap during transitions (no black frames)
		currentStart += clipLength - modeConfig.transitionDuration;
		return clipObj;
	});

	// --- Calculate actual video track duration ---
	// This prevents text overlays from extending past video content (which causes black frames)
	const lastClip = videoClips[videoClips.length - 1] as { start: number; length: number } | undefined;
	const videoDuration = lastClip ? lastClip.start + lastClip.length : 0;

	console.log(`[shotstack] Timeline: ${totalClips} clips, videoDuration=${videoDuration.toFixed(2)}s, transitionDuration=${transitionDuration}s, mode=${config.mode}, platform=${config.platform}`);

	// --- Build professional text overlays using HTML asset ---
	// HTML assets give us full control over fonts, colors, backgrounds, and layout
	// compared to the basic "title" asset which looks generic
	// CLAMP: all overlays must fit within the video duration to prevent black screen at end
	const textClips = (config.textOverlays || []).map((overlay, idx) => {
		const position = overlay.position || 'bottom';
		const isFirst = idx === 0;    // hook text gets special treatment
		const isLast = idx === (config.textOverlays?.length || 0) - 1;

		// Clamp overlay timing to video duration
		let start = overlay.start;
		let duration = overlay.duration;

		if (videoDuration > 0) {
			// Overlay must not start after video ends
			if (start >= videoDuration) {
				start = videoDuration - duration - 0.5;
			}
			// Overlay must not extend past video content
			if (start + duration > videoDuration) {
				duration = videoDuration - start;
			}
			// Safety bounds
			if (start < 0) start = 0;
			if (duration < 0.5) duration = 0.5;
		}

		// Mode-specific text styling
		const textStyle = getTextStyle(config.mode, position, isFirst, isLast);

		return {
			asset: {
				type: 'html' as const,
				html: textStyle.html(overlay.text),
				css: textStyle.css,
				width: textStyle.width,
				height: textStyle.height,
			},
			start,
			length: duration,
			transition: {
				in: isFirst ? 'fade' : 'fadeFast',
				out: 'fadeFast',
			},
			position,
			offset: position === 'bottom' ? { y: -0.08 }
				: position === 'top' ? { y: 0.08 }
				: undefined,
		};
	});

	// Build timeline — text track FIRST (index 0 = foreground in Shotstack), video SECOND, background color LAST
	// The background color track is the KEY fix for black frames: when the last clip's
	// transition-out fades, it reveals this solid color instead of empty timeline (black).
	const tracks: Array<{ clips: any[] }> = [];
	if (textClips.length > 0) {
		tracks.push({ clips: textClips });
	}
	tracks.push({ clips: videoClips });

	// Add a solid background color track as the bottommost layer
	// This ensures ALL transitions (including the last clip's out-transition)
	// fade into the mode's background color, not black empty timeline
	if (videoDuration > 0) {
		const bgTrack = {
			clips: [{
				asset: {
					type: 'html' as const,
					html: `<div style="width:100%;height:100%;background-color:${modeConfig.bgColor};"></div>`,
					css: '',
					width: platformSettings.width,
					height: platformSettings.height,
				},
				start: 0,
				length: videoDuration + 1, // +1s buffer beyond video end
				fit: 'none' as const,
			}],
		};
		tracks.push(bgTrack);
		console.log(`[shotstack] Added background color track: ${modeConfig.bgColor}, length=${(videoDuration + 1).toFixed(2)}s`);
	}

	const timeline: Record<string, unknown> = {
		tracks,
		background: modeConfig.bgColor, // prevents black flashes between clips
		fonts: [
			// Montserrat — brand headline font from Google Fonts
			{
				src: 'https://fonts.gstatic.com/s/montserrat/v26/JTUHjIg1_i6t8kCHKm4532VJOt5-QNFgpCuM70w-Y3tcoqK5.ttf',
			},
			// Montserrat Bold
			{
				src: 'https://fonts.gstatic.com/s/montserrat/v26/JTUHjIg1_i6t8kCHKm4532VJOt5-QNFgpCu173w-Y3tcoqK5.ttf',
			},
		],
	};

	// Add soundtrack if provided
	if (config.musicUrl) {
		timeline.soundtrack = {
			src: config.musicUrl,
			effect: 'fadeInFadeOut',
			volume: config.mode === 'showcase' ? 0.4 : config.mode === 'our_story' ? 0.2 : 0.35,
		};
	}

	// Build output settings — high quality for social media posting
	const output: Record<string, unknown> = {
		format: 'mp4',
		resolution: 'hd',
		fps: 30,
		quality: 'high',    // Shotstack quality setting (low/medium/high)
		size: {
			width: platformSettings.width,
			height: platformSettings.height,
		},
	};

	return { timeline, output };
}

// --- Professional text overlay styling per mode ---

interface TextStyleConfig {
	html: (text: string) => string;
	css: string;
	width: number;
	height: number;
}

function getTextStyle(
	mode: string,
	position: string,
	isFirst: boolean,
	isLast: boolean,
): TextStyleConfig {
	// Escape HTML entities
	const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

	if (mode === 'game_day') {
		// Bold, high-energy — uppercase, strong background, gold accent
		return {
			html: (text) => `<p class="gd">${esc(text).toUpperCase()}</p>`,
			css: `
				p.gd {
					font-family: 'Montserrat', sans-serif;
					font-size: 38px;
					font-weight: 800;
					color: #FFFFFF;
					text-align: center;
					letter-spacing: 2px;
					text-transform: uppercase;
					background-color: rgba(27, 77, 62, 0.85);
					padding: 12px 28px;
					border-left: 5px solid #C9A84C;
					margin: 0;
				}
			`,
			width: 800,
			height: 120,
		};
	}

	if (mode === 'our_story') {
		// Warm, intimate — elegant serif feel, subtle background
		return {
			html: (text) => `<p class="os">${esc(text)}</p>`,
			css: `
				p.os {
					font-family: 'Montserrat', sans-serif;
					font-size: 30px;
					font-weight: 400;
					color: #FFFFFF;
					text-align: center;
					background-color: rgba(0, 0, 0, 0.55);
					padding: 14px 32px;
					border-bottom: 3px solid #C9A84C;
					margin: 0;
					line-height: 1.4;
				}
			`,
			width: 780,
			height: 140,
		};
	}

	if (mode === 'quick_hit') {
		// Bold, centered, TikTok/Reels native — big text, high contrast
		return {
			html: (text) => `<p class="qh">${esc(text).toUpperCase()}</p>`,
			css: `
				p.qh {
					font-family: 'Montserrat', sans-serif;
					font-size: 44px;
					font-weight: 900;
					color: #FFFFFF;
					text-align: center;
					text-transform: uppercase;
					letter-spacing: 1px;
					-webkit-text-stroke: 2px rgba(0, 0, 0, 0.6);
					text-shadow: 3px 3px 6px rgba(0, 0, 0, 0.8);
					margin: 0;
					padding: 8px 20px;
				}
			`,
			width: 900,
			height: 120,
		};
	}

	if (mode === 'showcase') {
		// Premium, cinematic — clean, understated, professional
		if (isLast) {
			// Final card: CTA style with brand background
			return {
				html: (text) => `<p class="sc-cta">${esc(text)}</p>`,
				css: `
					p.sc-cta {
						font-family: 'Montserrat', sans-serif;
						font-size: 32px;
						font-weight: 600;
						color: #C9A84C;
						text-align: center;
						background-color: rgba(27, 77, 62, 0.9);
						padding: 16px 40px;
						margin: 0;
						letter-spacing: 1px;
					}
				`,
				width: 800,
				height: 120,
			};
		}
		return {
			html: (text) => `<p class="sc">${esc(text)}</p>`,
			css: `
				p.sc {
					font-family: 'Montserrat', sans-serif;
					font-size: 34px;
					font-weight: 500;
					color: #FFFFFF;
					text-align: center;
					background-color: rgba(0, 0, 0, 0.45);
					padding: 14px 36px;
					border-bottom: 2px solid #C9A84C;
					margin: 0;
					letter-spacing: 0.5px;
				}
			`,
			width: 800,
			height: 120,
		};
	}

	// Fallback — clean default
	return {
		html: (text) => `<p class="def">${esc(text)}</p>`,
		css: `
			p.def {
				font-family: 'Montserrat', sans-serif;
				font-size: 32px;
				font-weight: 600;
				color: #FFFFFF;
				text-align: center;
				background-color: rgba(0, 0, 0, 0.6);
				padding: 12px 28px;
				margin: 0;
			}
		`,
		width: 800,
		height: 120,
	};
}

/**
 * Create a simple highlight reel from a list of Google Drive file IDs
 * Handles public URL creation, rendering, and cleanup
 */
export async function renderHighlightFromDrive(
	fileIds: string[],
	options: {
		mode?: EditConfig['mode'];
		clipDuration?: number;
		title?: string;
		aspectRatio?: EditConfig['output']['aspectRatio'];
	} = {},
): Promise<RenderResult> {
	const {
		mode = 'game_day',
		clipDuration = 5,
		title,
		aspectRatio = '9:16',
	} = options;

	// Generate temporary public URLs for all files
	const publicUrls: Array<{ fileId: string; url: string }> = [];

	try {
		for (const fileId of fileIds) {
			const url = await getTemporaryPublicUrl(fileId);
			publicUrls.push({ fileId, url });
		}

		// Build the edit config
		const config: EditConfig = {
			mode,
			clips: publicUrls.map((pu, i) => ({
				sourceUrl: pu.url,
				startTime: 0,
				duration: clipDuration,
				label: `Clip ${i + 1}`,
			})),
			overlays: title ? [{
				text: title,
				position: 'bottom' as const,
				startTime: 0,
				duration: 4,
				style: 'title' as const,
			}] : [],
			output: {
				format: 'mp4',
				resolution: '1080',
				aspectRatio,
				fps: 30,
			},
			branding: {
				primaryColor: '#1B4D3E',
				secondaryColor: '#C9A84C',
			},
		};

		// Submit and wait for render
		const result = await renderAndWait(config);
		return result;
	} finally {
		// Always clean up public access
		for (const pu of publicUrls) {
			try {
				await revokePublicUrl(pu.fileId);
			} catch {
				// Best-effort cleanup - log but don't fail
			}
		}
	}
}
