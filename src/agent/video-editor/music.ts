/**
 * Music Library for Video Editor
 *
 * Provides curated royalty-free music tracks organized by mood/mode,
 * with direct URLs that Shotstack can fetch during rendering.
 *
 * All tracks are CC0 / royalty-free / no-attribution-required.
 * Sources: Shotstack sample library, Unminus, public domain archives.
 *
 * NOTE: Pixabay has royalty-free music but NO public API for music search.
 * Their API only covers images and videos. Music must be manually curated.
 *
 * File: src/agent/video-editor/music.ts
 */

// --- Types ---

export interface MusicTrack {
	id: string;
	title: string;
	artist: string;
	url: string;             // Direct URL to MP3/audio file
	durationSeconds: number; // Approximate duration
	bpm?: number;
	mood: string[];          // e.g., ['upbeat', 'energetic']
	modes: string[];         // Which editing modes this fits: game_day, our_story, etc.
	source: string;          // Where it came from: 'shotstack', 'unminus', 'custom', etc.
}

export interface MusicSelection {
	track: MusicTrack;
	volume: number;          // 0.0 - 1.0
	effect: 'fadeIn' | 'fadeOut' | 'fadeInFadeOut';
}

// --- Curated Track Library ---
// These are hosted on reliable CDNs with direct download URLs.
// Shotstack can fetch these directly during render.

const MUSIC_LIBRARY: MusicTrack[] = [
	// === UPBEAT / ENERGETIC (Game Day, Quick Hit) ===
	{
		id: 'berlin',
		title: 'Berlin',
		artist: 'Unminus',
		url: 'https://shotstack-assets.s3-ap-southeast-2.amazonaws.com/music/unminus/berlin.mp3',
		durationSeconds: 120,
		bpm: 128,
		mood: ['upbeat', 'energetic', 'electronic'],
		modes: ['game_day', 'quick_hit'],
		source: 'shotstack-unminus',
	},
	{
		id: 'ambisax',
		title: 'Ambisax',
		artist: 'Unminus',
		url: 'https://shotstack-assets.s3.ap-southeast-2.amazonaws.com/music/unminus/ambisax.mp3',
		durationSeconds: 90,
		bpm: 110,
		mood: ['smooth', 'chill', 'saxophone'],
		modes: ['our_story', 'showcase'],
		source: 'shotstack-unminus',
	},

	// === Shotstack demo assets (known working URLs) ===
	{
		id: 'motions',
		title: 'Motions',
		artist: 'Shotstack',
		url: 'https://shotstack-assets.s3-ap-southeast-2.amazonaws.com/music/motions.mp3',
		durationSeconds: 150,
		bpm: 120,
		mood: ['upbeat', 'motivational', 'modern'],
		modes: ['game_day', 'quick_hit', 'showcase'],
		source: 'shotstack',
	},
	{
		id: 'dreams',
		title: 'Dreams',
		artist: 'Shotstack',
		url: 'https://shotstack-assets.s3-ap-southeast-2.amazonaws.com/music/dreams.mp3',
		durationSeconds: 180,
		bpm: 85,
		mood: ['warm', 'emotional', 'cinematic'],
		modes: ['our_story', 'showcase'],
		source: 'shotstack',
	},
];

// --- Mode-to-mood mapping ---
// Defines which moods work best for each editing mode

const MODE_MOOD_PREFERENCES: Record<string, string[]> = {
	game_day:  ['upbeat', 'energetic', 'motivational', 'modern'],
	our_story: ['warm', 'emotional', 'smooth', 'cinematic', 'acoustic'],
	quick_hit: ['upbeat', 'energetic', 'modern', 'electronic'],
	showcase:  ['cinematic', 'motivational', 'warm', 'emotional', 'smooth'],
};

// --- Mode-to-volume mapping ---
// How loud music should be relative to video audio per mode

const MODE_VOLUME: Record<string, number> = {
	game_day:  0.35,    // music supports but doesn't overpower
	our_story: 0.20,    // very subtle, voice is king
	quick_hit: 0.30,    // moderate, keeps energy
	showcase:  0.40,    // music drives the piece
};

// --- Public API ---

/**
 * Get all available music tracks
 */
export function getAllTracks(): MusicTrack[] {
	return [...MUSIC_LIBRARY];
}

/**
 * Get tracks suitable for a specific editing mode
 */
export function getTracksForMode(mode: string): MusicTrack[] {
	return MUSIC_LIBRARY.filter(t => t.modes.includes(mode));
}

/**
 * Select the best track for a given mode and optional mood hint.
 * Returns null if no tracks match (caller should skip music).
 */
export function selectTrack(
	mode: string,
	moodHint?: string,
): MusicSelection | null {
	const candidates = getTracksForMode(mode);
	if (candidates.length === 0) return null;

	// If mood hint provided, prefer tracks matching that mood
	if (moodHint) {
		const moodLower = moodHint.toLowerCase();
		const moodMatch = candidates.find(t =>
			t.mood.some(m => moodLower.includes(m))
		);
		if (moodMatch) {
			return {
				track: moodMatch,
				volume: MODE_VOLUME[mode] ?? 0.3,
				effect: 'fadeInFadeOut',
			};
		}
	}

	// Otherwise prefer tracks whose mood matches the mode's preferences
	const preferredMoods = MODE_MOOD_PREFERENCES[mode] || [];
	let bestTrack = candidates[0]!;
	let bestScore = 0;

	for (const track of candidates) {
		const score = track.mood.reduce((s, m) =>
			s + (preferredMoods.includes(m) ? 1 : 0), 0);
		if (score > bestScore) {
			bestScore = score;
			bestTrack = track;
		}
	}

	return {
		track: bestTrack,
		volume: MODE_VOLUME[mode] ?? 0.3,
		effect: 'fadeInFadeOut',
	};
}

/**
 * Create a MusicSelection from a custom URL provided by the user.
 * Used when users paste their own music URL in the UI.
 */
export function createCustomMusicSelection(
	url: string,
	mode: string,
	volume?: number,
): MusicSelection {
	return {
		track: {
			id: 'custom',
			title: 'Custom Track',
			artist: 'User Provided',
			url,
			durationSeconds: 0,
			mood: [],
			modes: [mode],
			source: 'custom',
		},
		volume: volume ?? MODE_VOLUME[mode] ?? 0.3,
		effect: 'fadeInFadeOut',
	};
}

/**
 * Add a custom track to the in-memory library (for the session).
 * Useful for uploading tracks to Google Drive and using their proxy URLs.
 */
export function addCustomTrack(track: MusicTrack): void {
	MUSIC_LIBRARY.push(track);
}

/**
 * Get the recommended volume for a mode
 */
export function getRecommendedVolume(mode: string): number {
	return MODE_VOLUME[mode] ?? 0.3;
}

/**
 * Determine if music should be added based on the platform and tier.
 * Tier 1 (TikTok/Reels) = NO music (team adds trending sound at upload)
 * Tier 2 (YouTube/Facebook/LinkedIn/IG Feed) = library music
 * Tier 3 (Showcase/Our Story hero) = AI-generated (Suno) — not yet implemented
 */
export function shouldAddMusic(platform: string, musicTier?: number): boolean {
	// Explicit tier override
	if (musicTier === 1) return false;
	if (musicTier === 2 || musicTier === 3) return true;

	// Platform-based default
	const tier1Platforms = ['tiktok', 'ig_reels', 'ig-reels'];
	const platformLower = platform.toLowerCase();
	return !tier1Platforms.includes(platformLower);
}

/**
 * Get the music tier for a platform (if not explicitly set)
 */
export function getDefaultMusicTier(platform: string, mode: string): number {
	const platformLower = platform.toLowerCase();
	const tier1Platforms = ['tiktok', 'ig_reels', 'ig-reels'];
	if (tier1Platforms.includes(platformLower)) return 1;

	// Showcase and Our Story hero pieces deserve Tier 3 (when available)
	if (mode === 'showcase') return 3;
	if (mode === 'our_story') return 2;

	return 2; // Default to Tier 2 for all other platforms
}
