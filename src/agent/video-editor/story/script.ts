/**
 * Narration script for a Story Studio video.
 *
 * Writes the voice-over as short spoken lines and, per line, the extras the
 * hand-made CLC videos used: an emoji pop, words to highlight, an optional
 * sound effect, an optional title slam and a note on what the footage should show.
 *
 * File: src/agent/video-editor/story/script.ts
 */

import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { availableEmoji } from './store';
import type { StoryLine, StoryProject } from './types';

/** Human names for the bundled emoji, so the model can pick by meaning. */
export const EMOJI_NAMES: Record<string, string> = {
	'1f514': 'bell', '265f-fe0f': 'chess pawn', '1f914': 'thinking face', '1f434': 'horse (chess knight)', '1f9e0': 'brain',
	'1f91d': 'handshake', '1f3c6': 'trophy', '1f4a1': 'light bulb', '1f4da': 'books', '1f525': 'fire', '1f440': 'eyes',
	'23f1-fe0f': 'stopwatch', '1f4aa': 'flexed bicep', '1f49a': 'green heart', '2728': 'sparkles', '1f3af': 'bullseye',
	'1f501': 'repeat', '1f392': 'backpack', '1f9e9': 'puzzle piece', '1f3eb': 'school', '1f3be': 'tennis', '1f3c5': 'medal',
	'1f389': 'party popper', '1f60a': 'smiling face', '1f604': 'grinning face', '1f64c': 'raised hands', '1f44f': 'clapping',
	'1f680': 'rocket', '2b50': 'star', '1f31f': 'glowing star', '1f4af': '100', '1f496': 'sparkling heart', '2764-fe0f': 'red heart',
	'1f3c3': 'runner', '1f3c0': 'basketball', '26bd': 'soccer ball', '1f4d6': 'open book', '270f-fe0f': 'pencil', '1f393': 'graduation cap',
	'1f468-200d-1f3eb': 'man teacher', '1f469-200d-1f3eb': 'woman teacher', '1f46a': 'family', '1f30d': 'globe', '1f3db-fe0f': 'library building',
	'1f3c1': 'finish flag', '1f947': 'gold medal', '1f64f': 'thank you hands', '1f91c': 'fist bump', '1f4f8': 'camera', '1f3ac': 'clapper board',
	'1f4e3': 'megaphone', '1f4c5': 'calendar', '1f306': 'city at dusk', '1f305': 'sunrise', '1f308': 'rainbow', '1f331': 'seedling (growth)',
	'1f4c8': 'chart going up', '1f50d': 'magnifying glass', '1f9e1': 'orange heart', '1f499': 'blue heart', '1f49b': 'yellow heart',
	'1f49c': 'purple heart', '1f917': 'hugging face', '1f60e': 'cool sunglasses face', '1f929': 'star-struck', '1f973': 'party face',
	'1f3a8': 'art palette', '1f3b5': 'music note', '1f52d': 'telescope', '1f9ea': 'test tube',
};

export const SFX_NAMES = ['clack', 'tick', 'ding', 'page-turn', 'whoosh', 'whip', 'school-bell', 'shutter-modern'] as const;

const SYSTEM = `You write voice-over scripts for Community Literacy Club (CLC), a New York youth nonprofit that uses tennis, chess and reading to build kids' confidence, focus and community. The audience is parents and donors.

Style — this is what has worked for CLC's videos:
- Short spoken lines, one idea each, 2 to 14 words. Rhythm matters: mix a few very short punchy lines ("One piece. One rule.") with longer ones.
- Concrete and specific to the facts given. Never invent names, numbers, places, dates, results or claims. If a fact is not given, do not state it.
- Warm, proud, not salesy. Kids are the heroes; CLC is "a club, and a family".
- Open with a hook that sets the scene in the first line. End with the call to action as the final line.
- Speak at ~2.6 words per second. Hit the requested length.

For every line also return:
- highlight: 1-3 words from the line (exact spelling, keep trailing punctuation) to show in yellow in the captions.
- emoji: one code from the EMOJI LIST that fits this line, or "" for none. Use emoji on roughly half the lines, never the same one twice in a row.
- emojiWord: the word the emoji should pop on (exact word from the line).
- sfx: "" or one of: clack (chess piece / ball contact), tick (clock), ding (a realisation), page-turn (books / library), school-bell (school's out). Use sparingly, 3-6 per video.
- title: "" or a 2-4 word ALL CAPS title slam for the opening line and the line that names the program. At most two titles.
- visual: what the footage should show under this line (e.g. "girl hitting a forehand", "kids shaking hands over the board", "coach in CLC hoodie with kids").
- pauseAfter: seconds of silence after the line, 0 to 0.8. Use ~0.6 after the opening and after the line naming the program, 0 elsewhere.

Return ONLY JSON: {"openingTitle": "...", "lines": [{"text":"","highlight":[],"emoji":"","emojiWord":"","sfx":"","title":"","visual":"","pauseAfter":0}]}`;

export async function writeScript(p: StoryProject): Promise<{ lines: StoryLine[]; openingTitle?: string }> {
	const emoji = availableEmoji().map(c => `${c} = ${EMOJI_NAMES[c] ?? c}`).join('\n');
	const words = Math.round((p.targetSeconds - 6) * 2.6);
	const prompt = `Title / topic: ${p.title}
What happened (facts — use only these): ${p.facts}
Audience: ${p.audience}
Call to action (final line): ${p.callToAction}
Target length: ${p.targetSeconds} seconds of video, so about ${words} spoken words.

EMOJI LIST:
${emoji}`;
	const res = await generateText({
		model: anthropic('claude-sonnet-4-6'),
		system: SYSTEM,
		prompt,
		maxOutputTokens: 4000,
		abortSignal: AbortSignal.timeout(120_000),
	});
	return parseScript(res.text);
}

export function parseScript(raw: string): { lines: StoryLine[]; openingTitle?: string } {
	const text = raw.trim().replace(/^```(?:json)?\s*/, '').replace(/```$/, '');
	const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { openingTitle?: string; lines: StoryLine[] };
	const emoji = new Set(availableEmoji());
	const lines = (j.lines || []).filter(l => l && typeof l.text === 'string' && l.text.trim()).map(l => ({
		text: l.text.trim(),
		highlight: Array.isArray(l.highlight) ? l.highlight.filter(w => typeof w === 'string' && l.text.includes(w.replace(/[.,!?]$/, ''))) : [],
		emoji: l.emoji && emoji.has(l.emoji) ? l.emoji : undefined,
		emojiWord: l.emojiWord || undefined,
		sfx: l.sfx && (SFX_NAMES as readonly string[]).includes(l.sfx) ? l.sfx : undefined,
		title: l.title?.trim() || undefined,
		visual: l.visual?.trim() || undefined,
		pauseAfter: Math.max(0, Math.min(1.2, Number(l.pauseAfter) || 0)),
	}));
	if (lines.length === 0) throw new Error('Script came back empty');
	return { lines, openingTitle: j.openingTitle };
}

/** Post copy for every platform, written from the final script. */
export async function writePostKit(p: StoryProject): Promise<string> {
	const script = (p.script?.lines ?? []).map(l => l.text).join(' ');
	const res = await generateText({
		model: anthropic('claude-sonnet-4-6'),
		system: `You write social post copy for Community Literacy Club (CLC), a New York youth nonprofit (est. 2020) using tennis, chess and reading. Audience: parents and donors. Never invent facts beyond those given. Output plain Markdown with these sections exactly:
## YOUTUBE (16:9)
TITLE / DESCRIPTION (with https://CommunityLiteracyClub.org and 3 hashtags) / TAGS (comma separated) / SETTINGS (thumbnail, captions .srt, category, audience "not made for kids", end screen)
## YOUTUBE SHORTS
TITLE (#shorts) / DESCRIPTION
## INSTAGRAM REEL
CAPTION (with emoji, 5 hashtags) / SETTINGS (cover, alt text, add a trending sound at 10-20% under the voice-over, bio link)
## TIKTOK
CAPTION (with hashtags) / SETTINGS (cover text, auto-captions OFF because captions are burned in)
## BEFORE POSTING
- Don't name or tag any child; confirm photo/video releases for every child on screen.`,
		prompt: `Video title: ${p.title}\nFacts: ${p.facts}\nAudience: ${p.audience}\nCall to action: ${p.callToAction}\nNarration: ${script}`,
		maxOutputTokens: 2500,
		abortSignal: AbortSignal.timeout(120_000),
	});
	return res.text.trim();
}
