/**
 * Scene Analyzer
 * Uses FFmpeg to detect scene changes and key moments in videos.
 * Results are stored in the catalog to help the AI make better editing decisions.
 *
 * File: src/agent/video-editor/scene-analyzer.ts
 */

import { downloadVideo } from './google-drive';

export interface SceneChange {
	timestamp: number;       // seconds into the video
	score: number;           // 0-1, how dramatic the scene change is
}

export interface SceneDescription {
	timestamp: number;
	description: string;       // "Kid mid-serve, ball leaving racket"
	isAction: boolean;         // true = gameplay/action, false = walking/standing/talking
	actionType?: string;       // "serve" | "rally" | "forehand" | "backhand" | "celebration" | "instruction" | "walking" | "standing" | "talking" | "warmup" | "group_activity" | "chess_move" | "other"
	energyLevel: number;       // 1-5 scale
	visualQuality: number;     // 1-5 scale
	hookPotential: boolean;    // good for opening?
}

export interface SceneAnalysis {
	duration: number;
	sceneChanges: SceneChange[];
	highMotionMoments: number[];     // timestamps of peak action
	quietMoments: number[];          // timestamps of calm (interviews, establishing)
	recommendedHooks: number[];      // best timestamps for opening hooks
	sceneDescriptions?: SceneDescription[];  // GPT-4o vision descriptions at key timestamps
	namedSegments?: NamedSegment[];  // complete timeline coverage with editorial intelligence
}

export interface CutSafety {
	canCutAtStart: boolean;          // safe to enter this segment with a cut
	canCutAtEnd: boolean;            // safe to exit this segment with a cut
	bestEntryPoint: number;          // ideal trimStart within segment (seconds)
	bestExitPoint: number;           // ideal end point within segment (seconds)
	reason: string;                  // "action completes at 12.3s" or "speaker finishes sentence"
}

export interface NamedSegment {
	id: string;                      // "S1", "S2", etc.
	label: string;                   // "Coach instruction — two kids listening on court"
	startTime: number;               // seconds
	endTime: number;                 // seconds
	duration: number;                // endTime - startTime
	type: 'action' | 'dialogue' | 'transition' | 'establishing' | 'quiet';
	energy: number;                  // 1-5
	hookPotential: boolean;
	actionType?: string;             // from SceneDescription if available
	cutSafety: CutSafety;
}

/**
 * Analyze a video for scene changes using FFmpeg.
 */
export async function analyzeVideoScenes(fileId: string, filename: string): Promise<SceneAnalysis> {
	const fs = await import('fs');
	const path = await import('path');
	const { execSync } = await import('child_process');

	const tempDir = path.join(process.cwd(), '.temp-cataloger');
	if (!fs.existsSync(tempDir)) {
		fs.mkdirSync(tempDir, { recursive: true });
	}

	const localPath = path.join(tempDir, `analyze_${fileId}.mp4`);

	try {
		// Download video
		await downloadVideo(fileId, localPath);

		// Get video duration
		const durationOutput = execSync(
			`ffprobe -v error -show_entries format=duration -of csv=p=0 "${localPath}"`,
			{ stdio: 'pipe' }
		).toString().trim();
		const duration = parseFloat(durationOutput) || 0;

		// Detect scene changes (threshold 0.3 = moderate sensitivity)
		// Use metadata=print to capture actual scene scores instead of hardcoding
		let sceneOutput = '';
		try {
			sceneOutput = execSync(
				`ffmpeg -i "${localPath}" -vf "select='gt(scene,0.3)',metadata=print:key=lavfi.scene_score" -f null - 2>&1`,
				{ stdio: 'pipe', timeout: 120000 }
			).toString();
		} catch (err: any) {
			// FFmpeg outputs to stderr even on success, capture it
			sceneOutput = err.stderr?.toString() || err.stdout?.toString() || '';
		}

		const sceneChanges: SceneChange[] = [];
		// Parse timestamps and scores from FFmpeg output
		// pts_time lines are followed by lavfi.scene_score lines
		const ptsRegex = /pts_time:(\d+\.?\d*)/g;
		const scoreRegex = /lavfi\.scene_score=(\d+\.?\d*)/g;
		const timestamps: number[] = [];
		const scores: number[] = [];

		let match;
		while ((match = ptsRegex.exec(sceneOutput)) !== null) {
			const ts = parseFloat(match[1]!);
			if (!isNaN(ts)) timestamps.push(ts);
		}
		while ((match = scoreRegex.exec(sceneOutput)) !== null) {
			const sc = parseFloat(match[1]!);
			if (!isNaN(sc)) scores.push(sc);
		}

		for (let i = 0; i < timestamps.length; i++) {
			sceneChanges.push({
				timestamp: Math.round(timestamps[i]! * 10) / 10,
				score: Math.round((scores[i] ?? 0.5) * 1000) / 1000, // real score or fallback to 0.5
			});
		}

		// High motion moments: scene changes in the first 80% of the video
		// (action tends to happen mid-video, not at start/end)
		const highMotionMoments = sceneChanges
			.filter(sc => sc.timestamp > 2 && sc.timestamp < duration * 0.8)
			.map(sc => sc.timestamp);

		// Quiet moments: long gaps between scene changes (>5 seconds = likely static shot or interview)
		const quietMoments: number[] = [];
		const sortedScenes = [...sceneChanges].sort((a, b) => a.timestamp - b.timestamp);
		for (let i = 0; i < sortedScenes.length - 1; i++) {
			const gap = sortedScenes[i + 1]!.timestamp - sortedScenes[i]!.timestamp;
			if (gap > 5) {
				quietMoments.push(
					Math.round((sortedScenes[i]!.timestamp + gap / 2) * 10) / 10
				);
			}
		}

		// Also check gap from start to first scene change
		if (sortedScenes.length > 0 && sortedScenes[0]!.timestamp > 5) {
			quietMoments.unshift(Math.round((sortedScenes[0]!.timestamp / 2) * 10) / 10);
		}

		// Recommended hooks: scene changes in the first 30% of the video
		const recommendedHooks = sceneChanges
			.filter(sc => sc.timestamp > 0.5 && sc.timestamp < duration * 0.3)
			.slice(0, 5)
			.map(sc => sc.timestamp);

		// If no hooks found from scene changes, suggest evenly spaced timestamps in first 30%
		if (recommendedHooks.length === 0 && duration > 3) {
			const hookWindow = duration * 0.3;
			recommendedHooks.push(
				Math.round(hookWindow * 0.2 * 10) / 10,
				Math.round(hookWindow * 0.5 * 10) / 10,
				Math.round(hookWindow * 0.8 * 10) / 10,
			);
		}

		return {
			duration,
			sceneChanges,
			highMotionMoments,
			quietMoments,
			recommendedHooks,
		};
	} finally {
		// Clean up
		try {
			if (fs.existsSync(localPath)) {
				fs.unlinkSync(localPath);
			}
		} catch { /* best effort */ }
	}
}

// --- Scene Description Prompt ---

const SCENE_DESCRIPTION_PROMPT = `You are analyzing frames extracted from youth tennis/chess nonprofit video footage at specific timestamps. For each frame, determine:

1. What is happening at this exact moment? Be specific about the action visible.
2. Is this an ACTION moment (gameplay, serve, rally, volley, celebration, coaching demonstration, chess move) or a NON-ACTION moment (walking, standing, talking, milling around, setting up, waiting)?
3. Rate the energy level (1-5): 1=static/boring, 2=minimal activity, 3=moderate activity, 4=high energy, 5=peak action/excitement
4. Rate visual quality (1-5): 1=blurry/dark/poorly framed, 2=below average, 3=acceptable, 4=well-composed, 5=sharp/great lighting/compelling composition
5. Would this frame make a good opening hook for a social media video?

Return JSON array with one object per frame, in the same order as the frames provided:
[
  {
    "timestamp": 8.7,
    "description": "Kid mid-serve on hard court, ball just leaving racket, good form visible",
    "isAction": true,
    "actionType": "serve",
    "energyLevel": 5,
    "visualQuality": 4,
    "hookPotential": true
  },
  {
    "timestamp": 15.1,
    "description": "Players walking to baseline between points, coach standing to the side",
    "isAction": false,
    "actionType": "walking",
    "energyLevel": 1,
    "visualQuality": 3,
    "hookPotential": false
  }
]

Valid actionType values: "serve", "rally", "forehand", "backhand", "volley", "celebration", "instruction", "chess_move", "walking", "standing", "talking", "warmup", "group_activity", "other"

Be honest and precise. If someone is just walking or standing, say so — don't inflate it to sound like action. The whole point is to help an AI editor avoid picking boring timestamps.

Return ONLY valid JSON. No markdown fences, no explanation.`;

/**
 * Describe what happens at specific scene timestamps using GPT-4o vision.
 * Takes the timestamps identified by FFmpeg scene analysis and extracts a frame
 * at each one, then sends them to GPT-4o to get semantic descriptions.
 * This bridges the gap between motion detection ("something moved") and
 * content understanding ("a kid is hitting a serve").
 */
export async function describeSceneTimestamps(
	videoPath: string,
	sceneAnalysis: SceneAnalysis,
	maxFrames: number = 6,
): Promise<SceneDescription[]> {
	const fs = await import('fs');
	const path = await import('path');
	const { execSync } = await import('child_process');
	const { generateText } = await import('ai');
	const { openai } = await import('@ai-sdk/openai');

	// Select the most interesting timestamps to analyze:
	// Priority: recommendedHooks first, then highMotionMoments, then top sceneChanges by score
	const candidateTimestamps = new Set<number>();

	for (const t of sceneAnalysis.recommendedHooks) {
		candidateTimestamps.add(t);
	}
	for (const t of sceneAnalysis.highMotionMoments) {
		candidateTimestamps.add(t);
	}
	// Add scene changes sorted by score descending
	const sortedChanges = [...sceneAnalysis.sceneChanges].sort((a, b) => b.score - a.score);
	for (const sc of sortedChanges) {
		candidateTimestamps.add(sc.timestamp);
	}

	// Take up to maxFrames, ensuring timestamps are >2s apart
	const selectedTimestamps: number[] = [];
	const sortedCandidates = [...candidateTimestamps].sort((a, b) => a - b);
	for (const ts of sortedCandidates) {
		if (selectedTimestamps.length >= maxFrames) break;
		const tooClose = selectedTimestamps.some(existing => Math.abs(existing - ts) < 2);
		if (!tooClose) {
			selectedTimestamps.push(ts);
		}
	}

	if (selectedTimestamps.length === 0) {
		return [];
	}

	// Extract a frame at each selected timestamp
	const tempDir = path.join(process.cwd(), '.temp-cataloger');
	if (!fs.existsSync(tempDir)) {
		fs.mkdirSync(tempDir, { recursive: true });
	}

	const contentParts: Array<{ type: 'image'; image: Uint8Array } | { type: 'text'; text: string }> = [];
	const validTimestamps: number[] = [];

	for (let i = 0; i < selectedTimestamps.length; i++) {
		const ts = selectedTimestamps[i]!;
		const framePath = path.join(tempDir, `scene_desc_${Date.now()}_${i}.jpg`);

		try {
			execSync(
				`ffmpeg -y -ss ${ts.toFixed(2)} -i "${videoPath}" -frames:v 1 -q:v 2 "${framePath}"`,
				{ timeout: 30000, stdio: 'pipe' },
			);

			if (fs.existsSync(framePath)) {
				const imageBuffer = fs.readFileSync(framePath);
				contentParts.push({
					type: 'image',
					image: new Uint8Array(imageBuffer),
				});
				validTimestamps.push(ts);
				// Clean up frame immediately
				try { fs.unlinkSync(framePath); } catch { /* best effort */ }
			}
		} catch {
			// Skip failed extractions
			try { if (fs.existsSync(framePath)) fs.unlinkSync(framePath); } catch { /* best effort */ }
		}
	}

	if (validTimestamps.length === 0) {
		return [];
	}

	// Build frame labels
	const frameLabels = validTimestamps.map((ts, i) =>
		`Frame ${i + 1}: timestamp ${ts.toFixed(1)}s`
	).join('\n');

	contentParts.push({
		type: 'text',
		text: `These ${validTimestamps.length} frames are from specific timestamps in a single video of youth tennis/chess activities:\n${frameLabels}\n\nAnalyze each frame individually. Each corresponds to a detected scene change or high-motion moment. Tell me what is ACTUALLY happening in each frame.`,
	});

	// Use gpt-4o-mini for scene descriptions — much cheaper, adequate for this task
	const result = await generateText({
		model: openai('gpt-4o-mini'),
		system: SCENE_DESCRIPTION_PROMPT,
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
		const descriptions = JSON.parse(jsonStr) as SceneDescription[];
		// Ensure timestamps match what we sent (GPT might round differently)
		return descriptions.map((desc, i) => ({
			...desc,
			timestamp: validTimestamps[i] ?? desc.timestamp,
		}));
	} catch {
		return [];
	}
}

/**
 * Format scene analysis for inclusion in AI edit plan prompts.
 */
export function formatSceneAnalysisForPrompt(analysis: SceneAnalysis): string {
	const scenes = analysis.sceneChanges.map(sc => `${sc.timestamp}s`).join(', ');
	const hooks = analysis.recommendedHooks.map(t => `${t}s`).join(', ');
	const quiet = analysis.quietMoments.map(t => `${t}s`).join(', ');
	const action = analysis.highMotionMoments.slice(0, 8).map(t => `${t}s`).join(', ');

	let base = `  - Video Duration: ${analysis.duration.toFixed(1)}s
  - Scene Changes (${analysis.sceneChanges.length} detected): [${scenes}]
  - High-Action Moments: [${action || 'none detected'}]
  - Quiet/Static Moments: [${quiet || 'none detected'}]
  - Recommended Hook Timestamps: [${hooks}]`;

	// Add semantic descriptions when available
	if (analysis.sceneDescriptions && analysis.sceneDescriptions.length > 0) {
		const descLines = analysis.sceneDescriptions.map(d => {
			const actionTag = d.isAction ? 'ACTION' : 'NON-ACTION';
			const hookTag = d.hookPotential ? ', GOOD HOOK' : '';
			return `    * ${d.timestamp.toFixed(1)}s: [${actionTag}${hookTag}] ${d.description} (energy: ${d.energyLevel}/5, quality: ${d.visualQuality}/5, type: ${d.actionType || 'unknown'})`;
		}).join('\n');

		base += `\n  - SCENE CONTENT DESCRIPTIONS (GPT-4o confirmed what happens at each timestamp):\n${descLines}`;

		// Highlight best action timestamps
		const bestAction = analysis.sceneDescriptions
			.filter(d => d.isAction && d.energyLevel >= 4)
			.map(d => `${d.timestamp.toFixed(1)}s`)
			.join(', ');
		if (bestAction) {
			base += `\n  - ⭐ BEST ACTION TIMESTAMPS (energy 4-5, confirmed gameplay): [${bestAction}]`;
		}

		// Highlight confirmed hooks
		const bestHooks = analysis.sceneDescriptions
			.filter(d => d.hookPotential)
			.map(d => `${d.timestamp.toFixed(1)}s`)
			.join(', ');
		if (bestHooks) {
			base += `\n  - 🎯 VISUALLY CONFIRMED HOOKS: [${bestHooks}]`;
		}

		// Warn about non-action timestamps
		const avoidTimestamps = analysis.sceneDescriptions
			.filter(d => !d.isAction && d.energyLevel <= 2)
			.map(d => `${d.timestamp.toFixed(1)}s (${d.actionType || 'non-action'})`)
			.join(', ');
		if (avoidTimestamps) {
			base += `\n  - ⚠️ AVOID THESE (confirmed non-action, low energy): [${avoidTimestamps}]`;
		}
	}

	return base;
}

// --- Named Scene Segments ---

/**
 * Map a SceneDescription actionType to a segment type.
 */
function actionTypeToSegmentType(actionType?: string, isAction?: boolean): NamedSegment['type'] {
	if (!actionType) return isAction ? 'action' : 'quiet';
	switch (actionType) {
		case 'serve':
		case 'rally':
		case 'forehand':
		case 'backhand':
		case 'volley':
		case 'celebration':
		case 'chess_move':
			return 'action';
		case 'instruction':
		case 'talking':
			return 'dialogue';
		case 'walking':
		case 'standing':
			return 'transition';
		case 'warmup':
		case 'group_activity':
			return isAction ? 'action' : 'quiet';
		default:
			return isAction ? 'action' : 'quiet';
	}
}

/**
 * Generate cut safety metadata for a segment based on its type.
 * This encodes professional editorial grammar — when it's safe to cut in/out.
 */
function generateCutSafety(
	type: NamedSegment['type'],
	startTime: number,
	endTime: number,
	segDuration: number,
): CutSafety {
	switch (type) {
		case 'action':
			return {
				canCutAtStart: true,
				canCutAtEnd: false,
				bestEntryPoint: Math.round(startTime * 10) / 10,
				bestExitPoint: Math.round(Math.max(startTime + 0.5, endTime - 0.3) * 10) / 10,
				reason: 'Action segment — let the action complete before cutting. Exit after the peak, not during.',
			};
		case 'dialogue':
			return {
				canCutAtStart: false,
				canCutAtEnd: false,
				bestEntryPoint: Math.round(Math.min(startTime + 0.5, endTime - 0.5) * 10) / 10,
				bestExitPoint: Math.round(Math.max(startTime + 0.5, endTime - 0.5) * 10) / 10,
				reason: 'Dialogue segment — let the speaker finish. Do not cut mid-sentence.',
			};
		case 'transition':
			return {
				canCutAtStart: true,
				canCutAtEnd: true,
				bestEntryPoint: Math.round(startTime * 10) / 10,
				bestExitPoint: Math.round(endTime * 10) / 10,
				reason: 'Transition segment — safe to cut freely (walking, panning, setup).',
			};
		case 'establishing':
			return {
				canCutAtStart: true,
				canCutAtEnd: true,
				bestEntryPoint: Math.round(startTime * 10) / 10,
				bestExitPoint: Math.round(Math.min(startTime + Math.max(segDuration, 2.5), endTime) * 10) / 10,
				reason: 'Establishing segment — hold for at least 2-3 seconds to orient the viewer.',
			};
		case 'quiet':
		default:
			return {
				canCutAtStart: true,
				canCutAtEnd: true,
				bestEntryPoint: Math.round(Math.min(startTime + 0.5, endTime) * 10) / 10,
				bestExitPoint: Math.round(Math.max(startTime, endTime - 0.5) * 10) / 10,
				reason: 'Quiet segment — safe to cut after natural pauses.',
			};
	}
}

/**
 * Infer segment type from catalog-level metadata when no scene description is available.
 */
function inferSegmentType(
	index: number,
	totalSegments: number,
	relativePosition: number, // 0-1 position in video
	catalogContentType: string,
): NamedSegment['type'] {
	// First segment is usually establishing
	if (index === 0) return 'establishing';
	// Last segment is usually quiet (wrap-up)
	if (index === totalSegments - 1 && totalSegments > 2) return 'quiet';
	// Infer from catalog content type for middle segments
	switch (catalogContentType) {
		case 'interview':
			return 'dialogue';
		case 'tennis_action':
		case 'chess':
			return relativePosition < 0.2 || relativePosition > 0.85 ? 'transition' : 'action';
		case 'event':
		case 'establishing':
			return relativePosition < 0.3 ? 'establishing' : 'transition';
		default:
			return 'quiet';
	}
}

/**
 * Infer energy level from segment type when no scene description is available.
 */
function inferEnergy(type: NamedSegment['type']): number {
	switch (type) {
		case 'action': return 4;
		case 'dialogue': return 2;
		case 'transition': return 2;
		case 'establishing': return 2;
		case 'quiet': return 1;
		default: return 2;
	}
}

/**
 * Generate a positional label when no GPT-4o scene description is available.
 */
function generatePositionalLabel(
	relativePosition: number,
	catalogActivity: string,
	segType: NamedSegment['type'],
): string {
	const positionName = relativePosition < 0.2
		? 'Early'
		: relativePosition < 0.4
			? 'Early-mid'
			: relativePosition < 0.6
				? 'Mid-video'
				: relativePosition < 0.8
					? 'Late-mid'
					: 'Late';

	// Shorten catalog activity to ~50 chars
	const shortActivity = catalogActivity.length > 50
		? catalogActivity.substring(0, 47) + '...'
		: catalogActivity;

	return `${positionName} — ${shortActivity} (${segType}, estimated)`;
}

/**
 * Generate named segments from scene analysis data.
 * Converts sparse scene change timestamps into a complete timeline
 * where every second of the video is covered by a labeled segment
 * with editorial cut safety metadata.
 *
 * This is a pure function — no API calls, no file I/O.
 * Runs on existing scene analysis data from the catalog.
 */
export function generateNamedSegments(
	sceneAnalysis: SceneAnalysis,
	catalogActivity: string,
	catalogContentType: string,
): NamedSegment[] {
	const { duration, sceneChanges, sceneDescriptions } = sceneAnalysis;

	if (duration <= 0) return [];

	// 1. Build boundaries: [0, ...sorted scene change timestamps, duration]
	const sortedTimestamps = [...new Set(
		sceneChanges.map(sc => sc.timestamp)
	)].sort((a, b) => a - b);

	const boundaries = [0, ...sortedTimestamps, duration];
	// Remove duplicates and ensure sorted
	const uniqueBoundaries = [...new Set(boundaries)].sort((a, b) => a - b);

	// 2. Create segments from consecutive boundary pairs
	const rawSegments: NamedSegment[] = [];
	for (let i = 0; i < uniqueBoundaries.length - 1; i++) {
		const startTime = uniqueBoundaries[i]!;
		const endTime = uniqueBoundaries[i + 1]!;
		const segDuration = endTime - startTime;

		// Skip tiny segments (< 0.5s) — merge with previous
		if (segDuration < 0.5 && rawSegments.length > 0) {
			const prev = rawSegments[rawSegments.length - 1]!;
			prev.endTime = endTime;
			prev.duration = prev.endTime - prev.startTime;
			// Recalculate cut safety with new bounds
			prev.cutSafety = generateCutSafety(prev.type, prev.startTime, prev.endTime, prev.duration);
			continue;
		}
		if (segDuration < 0.5 && rawSegments.length === 0) {
			// First segment is too tiny, extend to next boundary
			continue;
		}

		const segIndex = rawSegments.length;
		const relativePosition = startTime / duration;

		// 3. Find matching scene description (any description whose timestamp falls in this segment)
		const matchingDesc = sceneDescriptions?.find(
			d => d.timestamp >= startTime && d.timestamp < endTime
		);

		// 4. Assign segment properties
		let type: NamedSegment['type'];
		let label: string;
		let energy: number;
		let hookPotential: boolean;
		let actionType: string | undefined;

		if (matchingDesc) {
			// We have a GPT-4o confirmed description for this segment
			type = actionTypeToSegmentType(matchingDesc.actionType, matchingDesc.isAction);
			label = matchingDesc.description;
			energy = matchingDesc.energyLevel;
			hookPotential = matchingDesc.hookPotential;
			actionType = matchingDesc.actionType;
		} else {
			// No description — infer from position + catalog metadata
			type = inferSegmentType(segIndex, uniqueBoundaries.length - 1, relativePosition, catalogContentType);
			label = generatePositionalLabel(relativePosition, catalogActivity, type);
			energy = inferEnergy(type);
			hookPotential = type === 'action' && energy >= 4 && relativePosition < 0.3;
			actionType = undefined;
		}

		const cutSafety = generateCutSafety(type, startTime, endTime, segDuration);

		rawSegments.push({
			id: `S${segIndex + 1}`,
			label,
			startTime: Math.round(startTime * 10) / 10,
			endTime: Math.round(endTime * 10) / 10,
			duration: Math.round(segDuration * 10) / 10,
			type,
			energy,
			hookPotential,
			actionType,
			cutSafety,
		});
	}

	// 5. Merge if too many segments (keep prompt manageable)
	let segments = rawSegments;
	if (segments.length > 25) {
		segments = mergeAdjacentSegments(segments, 25);
	}

	// 6. Re-number segment IDs after merge
	segments.forEach((seg, i) => {
		seg.id = `S${i + 1}`;
	});

	return segments;
}

/**
 * Merge adjacent segments of the same type until segment count <= maxSegments.
 */
function mergeAdjacentSegments(segments: NamedSegment[], maxSegments: number): NamedSegment[] {
	const result = [...segments];

	while (result.length > maxSegments) {
		// Find the best pair to merge: adjacent segments with same type, smallest combined duration
		let bestIdx = -1;
		let bestScore = Infinity;

		for (let i = 0; i < result.length - 1; i++) {
			const a = result[i]!;
			const b = result[i + 1]!;
			if (a.type === b.type) {
				const combined = a.duration + b.duration;
				if (combined < bestScore) {
					bestScore = combined;
					bestIdx = i;
				}
			}
		}

		if (bestIdx === -1) {
			// No same-type adjacent pairs — merge smallest adjacent pair regardless of type
			for (let i = 0; i < result.length - 1; i++) {
				const combined = result[i]!.duration + result[i + 1]!.duration;
				if (combined < bestScore) {
					bestScore = combined;
					bestIdx = i;
				}
			}
		}

		if (bestIdx === -1) break; // shouldn't happen

		const a = result[bestIdx]!;
		const b = result[bestIdx + 1]!;

		// Merge b into a
		a.endTime = b.endTime;
		a.duration = Math.round((a.endTime - a.startTime) * 10) / 10;
		a.label = a.label.includes('(estimated)')
			? a.label  // keep first label if both are estimated
			: `${a.label} / ${b.label}`;
		a.energy = Math.round((a.energy + b.energy) / 2);
		a.hookPotential = a.hookPotential || b.hookPotential;
		a.cutSafety = generateCutSafety(a.type, a.startTime, a.endTime, a.duration);

		// Remove b
		result.splice(bestIdx + 1, 1);
	}

	return result;
}

/**
 * Format named segments as a timeline for AI edit plan prompts.
 * Falls back to the original sparse format if no segments are available.
 */
export function formatSegmentTimelineForPrompt(analysis: SceneAnalysis): string {
	if (!analysis.namedSegments || analysis.namedSegments.length === 0) {
		return formatSceneAnalysisForPrompt(analysis);
	}

	const lines = analysis.namedSegments.map(seg => {
		const typeLabel = seg.type.toUpperCase();
		const hookStar = seg.hookPotential ? ', HOOK ⭐' : '';
		const entryStr = `Safe entry: ${seg.cutSafety.bestEntryPoint.toFixed(1)}s`;
		const exitStr = `Safe exit: ${seg.cutSafety.bestExitPoint.toFixed(1)}s`;

		let warning: string;
		if (!seg.cutSafety.canCutAtEnd && !seg.cutSafety.canCutAtStart) {
			warning = `⚠️ ${seg.cutSafety.reason}`;
		} else if (!seg.cutSafety.canCutAtEnd) {
			warning = `⚠️ ${seg.cutSafety.reason}`;
		} else {
			warning = 'Can cut freely';
		}

		return `  ${seg.id} [${seg.startTime.toFixed(1)}-${seg.endTime.toFixed(1)}s] ${typeLabel} — ${seg.label} (energy ${seg.energy}/5${hookStar})
     → ${entryStr} | ${exitStr} | ${warning}`;
	}).join('\n');

	let result = `  - Video Duration: ${analysis.duration.toFixed(1)}s
  SCENE TIMELINE (${analysis.namedSegments.length} segments — reference by ID in your edit plan):
${lines}`;

	// Highlight best action segments
	const bestAction = analysis.namedSegments
		.filter(s => s.type === 'action' && s.energy >= 4)
		.map(s => s.id);
	if (bestAction.length > 0) {
		result += `\n  ⭐ BEST ACTION SEGMENTS: [${bestAction.join(', ')}]`;
	}

	// Highlight recommended hooks
	const hooks = analysis.namedSegments
		.filter(s => s.hookPotential)
		.map(s => s.id);
	if (hooks.length > 0) {
		result += `\n  🎯 RECOMMENDED HOOK SEGMENTS: [${hooks.join(', ')}]`;
	}

	// Warn about low-energy segments to avoid for hooks/peaks
	const avoid = analysis.namedSegments
		.filter(s => (s.type === 'transition' || s.type === 'quiet') && s.energy <= 1)
		.map(s => s.id);
	if (avoid.length > 0) {
		result += `\n  ⚠️ AVOID FOR HOOKS/PEAKS (low energy): [${avoid.join(', ')}]`;
	}

	return result;
}
