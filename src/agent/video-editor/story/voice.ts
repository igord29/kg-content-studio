/**
 * Voice-over for Story Studio.
 *
 * Every script line is voiced separately, trimmed to its speech and placed on
 * the timeline with a natural gap plus the line's own pause. Per-line audio
 * means the editor always knows exactly when each line starts, so shots,
 * captions, emoji and sound effects can land on it — and editing one line
 * only re-voices that line.
 *
 * Providers:
 *   - ElevenLabs (ELEVENLABS_API_KEY): default voice "Brian", the narrator used
 *     on the hand-made CLC videos.
 *   - OpenAI (OPENAI_API_KEY): fallback, voice "onyx".
 *
 * File: src/agent/video-editor/story/voice.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { ffmpeg, speechSpan } from './media';
import { projectDir } from './store';
import type { StoryProject, VoiceSegment } from './types';

export const LEAD_IN = 1.2;     // seconds of picture before the first word
export const LINE_GAP = 0.3;    // breath between lines
export const END_CARD = 4.0;    // logo card after the last line

export const ELEVEN_VOICES: Record<string, string> = {
	Brian: 'nPczCjzI2devNBz1zQrb', Bill: 'pqHfZKP75CvOlQylNhV4', Chris: 'iP95p4xoKVk53GoZ742B', Eric: 'cjVigY5qzO86Huf0OWal',
	Will: 'bIHbv24MWmeRgasZH58o', Roger: 'CwhRBWXzGAHq8TQ4Fs17', Sarah: 'EXAVITQu4vr4xnSDxMaL', Jessica: 'cgSgspJ2msm6clMCkdW9',
	Matilda: 'XrExE9yKIg1WjnnlVkGX', Laura: 'FGY2WhTYpPnrIDTdsKH5',
};
export const OPENAI_VOICES = ['onyx', 'ash', 'ballad', 'echo', 'sage', 'verse', 'alloy', 'coral', 'nova', 'shimmer'];

export function voiceOptions(): { provider: string; voices: string[]; default: string }[] {
	const out: { provider: string; voices: string[]; default: string }[] = [];
	if (process.env.ELEVENLABS_API_KEY) out.push({ provider: 'elevenlabs', voices: Object.keys(ELEVEN_VOICES), default: 'Brian' });
	if (process.env.OPENAI_API_KEY) out.push({ provider: 'openai', voices: OPENAI_VOICES, default: 'onyx' });
	return out;
}

async function speakEleven(text: string, voice: string, prev: string, next: string): Promise<Buffer> {
	const id = ELEVEN_VOICES[voice] ?? voice;
	const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(id)}?output_format=mp3_44100_128`, {
		method: 'POST',
		headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY!, 'content-type': 'application/json' },
		body: JSON.stringify({
			text, model_id: 'eleven_multilingual_v2', previous_text: prev || undefined, next_text: next || undefined,
			voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
		}),
		signal: AbortSignal.timeout(90_000),
	});
	if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
	return Buffer.from(await res.arrayBuffer());
}

async function speakOpenAI(text: string, voice: string): Promise<Buffer> {
	const res = await fetch('https://api.openai.com/v1/audio/speech', {
		method: 'POST',
		headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
		body: JSON.stringify({
			model: 'gpt-4o-mini-tts', voice, input: text, response_format: 'mp3',
			instructions: 'Warm, proud, documentary narrator for a youth nonprofit video. Natural pace, clear, confident, not salesy.',
		}),
		signal: AbortSignal.timeout(90_000),
	});
	if (!res.ok) throw new Error(`OpenAI TTS ${res.status}: ${(await res.text()).slice(0, 300)}`);
	return Buffer.from(await res.arrayBuffer());
}

/** Voice every line and lay the narration out on the timeline. */
export async function voiceScript(p: StoryProject, provider: string, voice: string, log: (m: string) => void):
	Promise<{ segments: VoiceSegment[]; totalSeconds: number }> {
	const lines = p.script?.lines ?? [];
	if (lines.length === 0) throw new Error('Write the script first');
	const dir = path.join(projectDir(p.id), 'voice');
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });

	const segments: VoiceSegment[] = [];
	let cursor = LEAD_IN;
	for (let i = 0; i < lines.length; i++) {
		log(`Voicing line ${i + 1} of ${lines.length}`);
		const text = lines[i]!.text;
		const raw = provider === 'elevenlabs'
			? await speakEleven(text, voice, lines[i - 1]?.text ?? '', lines[i + 1]?.text ?? '')
			: await speakOpenAI(text, voice);
		const rawFile = path.join(dir, `raw_${i}.mp3`);
		fs.writeFileSync(rawFile, raw);
		const span = await speechSpan(rawFile);
		const a = Math.max(0, span.firstSound - 0.03), b = Math.min(span.duration, span.lastSound + 0.08);
		const file = `line_${String(i).padStart(2, '0')}.wav`;
		await ffmpeg(['-i', rawFile, '-af', `atrim=${a.toFixed(3)}:${b.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000`, '-ac', '1', path.join(dir, file)]);
		fs.rmSync(rawFile);
		const len = b - a;
		segments.push({ line: i, start: +cursor.toFixed(3), end: +(cursor + len).toFixed(3), file });
		cursor += len + LINE_GAP + (lines[i]!.pauseAfter ?? 0);
	}
	const lastEnd = segments[segments.length - 1]!.end;
	return { segments, totalSeconds: +(lastEnd + 0.5 + END_CARD).toFixed(2) };
}

/** Where the footage stops and the logo card starts. */
export function footageEnd(p: StoryProject): number {
	return +((p.voice?.totalSeconds ?? 0) - END_CARD).toFixed(2);
}
