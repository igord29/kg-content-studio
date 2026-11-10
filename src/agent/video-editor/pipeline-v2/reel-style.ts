/**
 * Recap-reel pacing — the style of the organisation's own published reels.
 *
 * The pipeline was built around a narrative edit: a 7-10s story hook and 4-5s
 * body shots. Seven of the organisation's published Instagram reels were
 * analysed shot by shot and none of them are cut that way. They are recap
 * montages:
 *   - 14-30 shots in 18-63s, each shot 1-2.5s (group moments up to ~3s)
 *   - hard cuts only, normal speed, cut to the beat of a music bed
 *   - the event title on screen inside the first 3 seconds
 *   - a simple chronological day: arrive -> play -> bond -> wrap up
 *   - wide/group shots alternating with close portraits and smiles
 *   - footage drawn from many different moments of the day
 * An edit of a dozen 4.5s shots from three source files reads as slow next to
 * that, which is the bar new edits are measured against.
 *
 * These blocks are appended to each step's prompt for recap modes and OVERRIDE
 * the narrative defaults in the system prompts; the clamps enforce the numbers
 * in code so pacing does not depend on the model complying.
 *
 * File: src/agent/video-editor/pipeline-v2/reel-style.ts
 */

/** Modes that are event recaps. Story-led modes keep the narrative pacing. */
export function isReelMode(mode: string | undefined): boolean {
	return mode === 'game_day' || mode === 'quick_hit';
}

export const REEL_HOOK_MIN_S = 2;
export const REEL_HOOK_MAX_S = 3;
export const REEL_SHOT_MIN_S = 1;
export const REEL_SHOT_MAX_S = 3;

export const REEL_HOOK_OVERRIDE = `
RECAP REEL OVERRIDE (this edit is an event recap — these rules REPLACE the
7-10 second story-hook rules above):
- The hook is the OPENING SHOT of a fast montage: ${REEL_HOOK_MIN_S}-${REEL_HOOK_MAX_S} seconds, no longer.
- Pick ONE instantly readable image: the group together facing the camera, or
  a kid mid-swing with the venue visible. The event title is laid over this
  shot, so it must read at a glance and establish where we are.
- trimStart = T - 0.5 (start just before the peak, not 3 seconds before it).
- Normal speed. No setup/turn/response arc — one shot, one image.`;

export function reelBodyOverride(sourceCount: number): string {
	const minSources = Math.min(5, sourceCount);
	return `
RECAP REEL OVERRIDE (this edit is an event recap — these rules REPLACE the
BODY STRUCTURE above and ignore the planned beat count):
- Compose 18-22 shots (a later check removes any shot where the camera had
  swung off the subject, so over-supply). Each shot ${REEL_SHOT_MIN_S}.2-2.5 seconds; a group moment or a full
  rally exchange may run up to ${REEL_SHOT_MAX_S} seconds. Nothing longer.
- ALL shots speed 1.0. No slow motion anywhere. Hard cuts only: OMIT
  transitionType on every clip. Keep effect null unless a shot is static.
- Use at least ${minSources} DIFFERENT source videos and no more than 3 shots from any
  one source. Variety across the day is the point of a recap.
- Tell the day in order: arriving / warming up -> drills and play -> rallies
  and points -> reactions, high-fives, kids together.
- Alternate shot sizes: never three wide shots in a row. Follow a wide or
  group shot with a close one (a face, a swing, hands on a racket).
- At least half the shots must be ACTIVE PLAY (tennis>=4). At least three must
  be faces or reactions (the highest emotion values available).
- Each shot still anchors within 2 seconds of a listed timestamp score, and
  each uses a DIFFERENT timestamp — never two shots of the same moment.
- purpose is one of: "establish", "showcase", "montage", "community".
- Keep each editNote to one short sentence.`;
}

export const REEL_CLOSE_OVERRIDE = `
RECAP REEL OVERRIDE (this edit is an event recap — these rules REPLACE the clip
lengths and the text overlay guidelines above):
- Community clip: 2-2.5 seconds. Close clip: 2.5-3 seconds, ending on the group
  together or a kid smiling at the camera. Normal speed, hard cuts, no
  transitionType.
- TEXT OVERLAYS — exactly these and no others:
  1. EVENT TITLE: position "top", animation "scaleUp", start 0.3, duration 3.
     The event and place in a few words, optionally a second short line for
     the season or year (e.g. "Red Ball Team Tennis\\nUS Open 2025").
     Plain and factual, like a caption on a photo.
  2. CLOSING CARD: position "center", animation "fade", over the final 2.5
     seconds: "Community Literacy Club" and nothing else.
- NO mid-video section titles, slogans, taglines or quotes. The footage and
  the music carry the middle of the reel.`;

/** Clamp a hook to the recap-reel opening-shot length. */
export function clampReelHook(duration: number): number {
	return Math.min(REEL_HOOK_MAX_S, Math.max(REEL_HOOK_MIN_S, duration));
}

/** Clamp a body/close shot to recap-reel length. */
export function clampReelShot(duration: number): number {
	return Math.min(REEL_SHOT_MAX_S, Math.max(REEL_SHOT_MIN_S, duration));
}

// ── Anchoring ────────────────────────────────────────────────────────────

interface ScoredMoment { timestamp: number; actionQuality: number; people: number }
interface AnchorableClip { fileId: string; trimStart: number; duration: number }

/** Minimum `people` score (1-5) for a moment to count as "someone is in frame". */
const MIN_PEOPLE = 3;
/** How far a clip may be from a confirmed moment before it is re-pointed. */
const SNAP_WINDOW_S = 4;
/** Lead-in before the confirmed frame. */
const LEAD_IN_S = 0.5;

/**
 * Pin every shot of a recap reel onto a frame the cataloguer actually saw.
 *
 * Much of the library is body-worn camera footage: the frame swings off the
 * kids and onto a wall or the court surface within a second or two. A score at
 * T says "people were in frame at T" and nothing about T+3. The first recap
 * render started shots seconds before their scored moment and let dedup
 * shifting move others onto unscored timestamps; roughly half its shots showed
 * sponsor boards and empty court.
 *
 * So: each shot is re-pointed to start LEAD_IN_S before the nearest confirmed
 * moment with people in frame, and held short. Each moment is used once. A shot
 * with no confirmed moment left on its source is dropped — a shorter reel beats
 * one with a wall in it.
 */
export function anchorReelClips<T extends AnchorableClip>(
	clips: T[],
	momentsFor: (fileId: string) => ScoredMoment[] | undefined,
	log: (msg: string) => void,
): T[] {
	const taken = new Map<string, number[]>();
	const isFree = (fileId: string, t: number): boolean =>
		!(taken.get(fileId) ?? []).some(u => Math.abs(u - t) < 2.5);

	const out: T[] = [];
	clips.forEach((clip, i) => {
		const all = momentsFor(clip.fileId);
		if (!all || all.length === 0) { out.push(clip); return; } // unscored source: nothing to anchor to

		const usable = all.filter(m => m.people >= MIN_PEOPLE && isFree(clip.fileId, m.timestamp));
		const aim = clip.trimStart + LEAD_IN_S;
		const nearest = (pool: ScoredMoment[]): ScoredMoment | undefined => pool
			.filter(m => Math.abs(m.timestamp - aim) <= SNAP_WINDOW_S)
			.sort((a, b) => Math.abs(a.timestamp - aim) - Math.abs(b.timestamp - aim))[0];
		// Prefer a moment where people clearly fill the frame (people >= 4) over
		// one where they are merely present, even if it is a little further away.
		const pick = nearest(usable.filter(m => m.people >= MIN_PEOPLE + 1))
			?? nearest(usable)
			?? [...usable].sort((a, b) => (b.people - a.people) || (b.actionQuality - a.actionQuality))[0];

		if (!pick) {
			log(`shot ${i} (${clip.fileId.slice(0, 8)} @ ${clip.trimStart}s) dropped: no unused moment with people in frame on that source`);
			return;
		}
		const trimStart = Math.max(0, pick.timestamp - LEAD_IN_S);
		if (Math.abs(trimStart - clip.trimStart) > 0.75) {
			log(`shot ${i} (${clip.fileId.slice(0, 8)}) re-pointed ${clip.trimStart}s -> ${trimStart}s (confirmed moment at ${pick.timestamp}s)`);
		}
		taken.set(clip.fileId, [...(taken.get(clip.fileId) ?? []), pick.timestamp]);
		out.push({ ...clip, trimStart, duration: Math.min(clip.duration, 2.5) });
	});
	return out;
}
