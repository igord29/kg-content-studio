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
- Compose 14-18 shots. Each shot ${REEL_SHOT_MIN_S}.2-2.5 seconds; a group moment or a full
  rally exchange may run up to ${REEL_SHOT_MAX_S} seconds. Nothing longer.
- ALL shots speed 1.0. No slow motion anywhere. Hard cuts only: OMIT
  transitionType on every clip. Keep effect null unless a shot is static.
- Use at least ${minSources} DIFFERENT source videos and no more than 4 shots from any
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
