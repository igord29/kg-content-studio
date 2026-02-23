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
		let sceneOutput = '';
		try {
			sceneOutput = execSync(
				`ffmpeg -i "${localPath}" -vf "select='gt(scene,0.3)',showinfo" -f null - 2>&1`,
				{ stdio: 'pipe', timeout: 120000 }
			).toString();
		} catch (err: any) {
			// FFmpeg outputs to stderr even on success, capture it
			sceneOutput = err.stderr?.toString() || err.stdout?.toString() || '';
		}

		const sceneChanges: SceneChange[] = [];
		const sceneRegex = /pts_time:(\d+\.?\d*)/g;
		let match;
		while ((match = sceneRegex.exec(sceneOutput)) !== null) {
			const ts = parseFloat(match[1]!);
			if (!isNaN(ts)) {
				sceneChanges.push({
					timestamp: Math.round(ts * 10) / 10,
					score: 0.5,
				});
			}
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

	// Send to GPT-4o vision
	const result = await generateText({
		model: openai('gpt-4o'),
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
