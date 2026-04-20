/**
 * Visual Timeline Analyzer
 *
 * Sends contact sheet images to GPT-4o-mini and gets per-timestamp
 * descriptions back. The result is a dense visual timeline that tells
 * the AI exactly what happens at each point in the video.
 *
 * This replaces the more expensive individual-frame scoring approach
 * (scoreVideoTimestamps) with a single-image analysis that provides
 * denser coverage at ~10x lower cost.
 *
 * File: src/agent/video-editor/visual-timeline.ts
 */

import * as fs from 'fs';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import type { ContactSheet } from './contact-sheet';

// --- Types ---

export interface TimelineFrame {
	timestamp: number;
	description: string;       // "Two kids rallying on hard court, ball mid-flight"
	isAction: boolean;
	actionType: string;        // "rally" | "serve" | "forehand" | "walking" | etc.
	energy: number;            // 1-5
	hookPotential: boolean;
}

export interface ActionWindow {
	start: number;             // seconds
	end: number;               // seconds
	type: string;              // "rally" | "drill" | "instruction" | etc.
	peakEnergy: number;        // highest energy in this window
}

export interface VisualTimeline {
	frames: TimelineFrame[];
	summary: string;           // "60s of tennis clinic: warm-up (0-15s), drills (15-40s)..."
	bestMoments: number[];     // top 5 timestamps by action quality
	actionWindows: ActionWindow[];
}

// --- Prompt ---

const CONTACT_SHEET_ANALYSIS_PROMPT = `You are analyzing a contact sheet of thumbnails from a youth tennis/chess nonprofit video. The thumbnails are arranged in a grid, left-to-right then top-to-bottom, each with its timestamp burned into the bottom-left corner.

Your job: describe what's happening at each timestamp so an AI video editor can make smart clip selections for social media content.

For EACH thumbnail in order, determine:
1. What is happening? Be specific about the action visible.
2. Is this ACTION (gameplay, serve, rally, celebration, coaching demo) or NON-ACTION (walking, standing, talking, waiting)?
3. Energy level (1-5): 1=static, 2=minimal, 3=moderate, 4=high energy, 5=peak action
4. Would this frame make a good opening hook for a social media video?
5. Action type: "serve" | "rally" | "forehand" | "backhand" | "volley" | "celebration" | "instruction" | "drill" | "chess_move" | "walking" | "standing" | "talking" | "warmup" | "group_activity" | "establishing" | "other"

ALSO identify:
- ACTION WINDOWS: Continuous time ranges where gameplay/action is sustained. Group consecutive action frames into windows.
- BEST MOMENTS: The top 5 timestamps with highest action quality (for hooks and peaks).
- SUMMARY: A one-sentence description of the video's overall arc (e.g., "60s of tennis clinic: warm-up (0-15s), drills (15-40s), rallies (40-55s), cool-down (55-60s)")

Return JSON in this exact format:
{
  "frames": [
    {"timestamp": 2.0, "description": "Coach gathering kids on blue hard court", "isAction": false, "actionType": "instruction", "energy": 2, "hookPotential": false},
    {"timestamp": 4.0, "description": "Kid mid-serve, ball toss visible", "isAction": true, "actionType": "serve", "energy": 5, "hookPotential": true}
  ],
  "actionWindows": [
    {"start": 10.0, "end": 22.0, "type": "rally", "peakEnergy": 5},
    {"start": 30.0, "end": 45.0, "type": "drill", "peakEnergy": 4}
  ],
  "bestMoments": [12.0, 18.0, 34.0, 40.0, 50.0],
  "summary": "60s of tennis clinic: coach instruction (0-10s), rally drills (10-22s), rest (22-30s), forehand drills (30-45s), cool-down (45-60s)"
}

IMPORTANT RULES:
- Match timestamps to what's burned into each thumbnail. Read the timestamp labels carefully.
- Be HONEST. If kids are just standing around, say so. Don't inflate energy.
- ACTION means actual gameplay, movement, sports activity. Walking between points is NOT action.
- The video editor needs to know WHERE to cut, so precision matters more than optimism.
- If you can't read a timestamp label clearly, estimate based on position in the grid.

Return ONLY valid JSON. No markdown fences, no explanation.`;

/**
 * Analyze a contact sheet image using GPT-4o-mini vision.
 *
 * Sends the single contact sheet image and gets back per-timestamp
 * descriptions, action windows, and best moments.
 */
export async function analyzeContactSheet(
	contactSheet: ContactSheet,
	catalogDescription?: string,
): Promise<VisualTimeline> {
	const imageBuffer = fs.readFileSync(contactSheet.imagePath);

	const contentParts: Array<{ type: 'image'; image: Uint8Array } | { type: 'text'; text: string }> = [];

	contentParts.push({
		type: 'image',
		image: new Uint8Array(imageBuffer),
	});

	// Build context text with timestamp info
	let contextText = `This contact sheet has ${contactSheet.totalFrames} thumbnails arranged in a ${contactSheet.gridCols}x${contactSheet.gridRows} grid.`;
	contextText += ` Frames are sampled every ${contactSheet.frameInterval}s.`;
	contextText += ` Timestamps (in order, left-to-right, top-to-bottom): ${contactSheet.timestamps.map(t => `${t.toFixed(1)}s`).join(', ')}.`;

	if (catalogDescription) {
		contextText += `\n\nContext from catalog: "${catalogDescription}" — use this for general context but describe each frame based on what you actually see.`;
	}

	contentParts.push({ type: 'text', text: contextText });

	const result = await generateText({
		model: openai('gpt-4o-mini'),
		system: CONTACT_SHEET_ANALYSIS_PROMPT,
		messages: [{
			role: 'user',
			content: contentParts,
		}],
	});

	// Parse response
	let jsonStr = result.text.trim();
	if (jsonStr.startsWith('```')) {
		jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
	}

	try {
		const parsed = JSON.parse(jsonStr) as VisualTimeline;

		// Ensure timestamps match what we sent (model might round differently)
		if (parsed.frames && Array.isArray(parsed.frames)) {
			for (let i = 0; i < parsed.frames.length && i < contactSheet.timestamps.length; i++) {
				parsed.frames[i]!.timestamp = contactSheet.timestamps[i]!;
			}
		}

		// Always rebuild action windows from frame data — the model often
		// underreports windows (e.g., returns 2 when there are 5+ action sequences).
		// The frame descriptions are reliable; the window grouping is not.
		if (parsed.frames && parsed.frames.length > 0) {
			parsed.actionWindows = inferActionWindows(parsed.frames, contactSheet.frameInterval);
		} else if (parsed.actionWindows && Array.isArray(parsed.actionWindows)) {
			parsed.actionWindows = parsed.actionWindows.filter(
				w => typeof w.start === 'number' && typeof w.end === 'number' && w.end > w.start,
			);
		} else {
			parsed.actionWindows = [];
		}

		// Validate bestMoments
		if (!parsed.bestMoments || !Array.isArray(parsed.bestMoments)) {
			parsed.bestMoments = inferBestMoments(parsed.frames || []);
		}

		// Validate summary
		if (!parsed.summary || typeof parsed.summary !== 'string') {
			parsed.summary = generateSummary(parsed.frames || [], parsed.actionWindows);
		}

		return parsed;
	} catch {
		// If JSON parsing fails, return a minimal timeline from timestamps
		return {
			frames: contactSheet.timestamps.map(ts => ({
				timestamp: ts,
				description: 'Analysis unavailable',
				isAction: false,
				actionType: 'other',
				energy: 2,
				hookPotential: false,
			})),
			summary: 'Contact sheet analysis failed — timestamps available but no descriptions',
			bestMoments: [],
			actionWindows: [],
		};
	}
}

/**
 * Infer action windows from frame descriptions when the model doesn't provide them.
 * Groups consecutive action frames (with gaps up to 1 interval) into windows.
 */
function inferActionWindows(frames: TimelineFrame[], frameInterval: number): ActionWindow[] {
	const windows: ActionWindow[] = [];
	let currentWindow: ActionWindow | null = null;
	const maxGap = frameInterval * 1.5; // allow up to 1.5 intervals gap

	for (const frame of frames) {
		if (frame.isAction && frame.energy >= 3) {
			if (currentWindow && (frame.timestamp - currentWindow.end) <= maxGap) {
				// Extend current window
				currentWindow.end = frame.timestamp;
				// Update type to match the highest-energy frame in the window
				if (frame.energy > currentWindow.peakEnergy) {
					currentWindow.type = frame.actionType;
				}
				currentWindow.peakEnergy = Math.max(currentWindow.peakEnergy, frame.energy);
			} else {
				// Start new window
				if (currentWindow) windows.push(currentWindow);
				currentWindow = {
					start: frame.timestamp,
					end: frame.timestamp,
					type: frame.actionType,
					peakEnergy: frame.energy,
				};
			}
		}
	}

	if (currentWindow) windows.push(currentWindow);
	return windows;
}

/**
 * Infer best moments from frame descriptions when the model doesn't provide them.
 */
function inferBestMoments(frames: TimelineFrame[]): number[] {
	return frames
		.filter(f => f.isAction)
		.sort((a, b) => b.energy - a.energy)
		.slice(0, 5)
		.map(f => f.timestamp);
}

/**
 * Generate a summary string from frames and action windows.
 */
function generateSummary(frames: TimelineFrame[], windows: ActionWindow[]): string {
	if (frames.length === 0) return 'No frames analyzed';

	const totalDuration = frames[frames.length - 1]!.timestamp;
	const actionCount = frames.filter(f => f.isAction).length;
	const actionPct = Math.round((actionCount / frames.length) * 100);

	const windowDescs = windows.map(w =>
		`${w.type} (${w.start.toFixed(0)}-${w.end.toFixed(0)}s)`,
	).join(', ');

	return `${totalDuration.toFixed(0)}s video, ${actionPct}% action${windowDescs ? `. Action windows: ${windowDescs}` : ''}`;
}

/**
 * Format a visual timeline for inclusion in AI edit plan prompts.
 * Produces a compact text representation that fits efficiently in context.
 */
export function formatVisualTimelineForPrompt(timeline: VisualTimeline): string {
	const lines: string[] = [];

	// Summary line
	lines.push(`  Summary: ${timeline.summary}`);

	// Action windows (critical for clip selection)
	if (timeline.actionWindows.length > 0) {
		const windowsStr = timeline.actionWindows
			.map(w => `${w.start.toFixed(1)}-${w.end.toFixed(1)}s: ${w.type} (peak energy ${w.peakEnergy}/5)`)
			.join(', ');
		lines.push(`  Action Windows: [${windowsStr}]`);
	}

	// Best moments (for hooks and peaks)
	if (timeline.bestMoments.length > 0) {
		lines.push(`  Best Moments: [${timeline.bestMoments.map(t => `${t.toFixed(1)}s`).join(', ')}]`);
	}

	// Per-frame details — only show action/high-energy frames to save context
	const actionFrames = timeline.frames.filter(f => f.isAction || f.energy >= 3);
	if (actionFrames.length > 0) {
		const frameLines = actionFrames
			.map(f => `    ${f.timestamp.toFixed(1)}s: ${f.description} (energy ${f.energy}/5, ${f.actionType}${f.hookPotential ? ', HOOK' : ''})`)
			.join('\n');
		lines.push(`  Action Frame Details:\n${frameLines}`);
	}

	// Non-action frames summary (so the AI knows what to avoid)
	const nonActionFrames = timeline.frames.filter(f => !f.isAction && f.energy <= 2);
	if (nonActionFrames.length > 0) {
		const avoidStr = nonActionFrames
			.map(f => `${f.timestamp.toFixed(1)}s (${f.actionType})`)
			.join(', ');
		lines.push(`  Avoid (non-action, low energy): [${avoidStr}]`);
	}

	return lines.join('\n');
}
