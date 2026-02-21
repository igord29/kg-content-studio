/**
 * Scene Analyzer
 * Uses FFmpeg to detect scene changes, motion peaks, and key moments in videos.
 * Results are stored in the catalog to help the AI make better editing decisions.
 *
 * File: src/agent/video-editor/scene-analyzer.ts
 */

import { downloadVideo } from './google-drive';

export interface SceneChange {
	timestamp: number;       // seconds into the video
	score: number;           // 0-1, how dramatic the scene change is
}

export interface MotionPeak {
	timestamp: number;
	intensity: number;       // relative motion intensity
}

export interface SceneAnalysis {
	duration: number;               // total video duration in seconds
	sceneChanges: SceneChange[];    // detected scene boundaries
	motionPeaks: MotionPeak[];      // high-motion moments (action, celebration)
	quietMoments: number[];         // timestamps of low-motion (good for interviews, establishing shots)
	recommendedHooks: number[];     // best timestamps for opening hooks (high motion + scene change)
	recommendedCloseups: number[];  // timestamps likely showing faces/close interaction
}

/**
 * Analyze a video for scene changes and motion using FFmpeg.
 * Downloads the video temporarily, runs analysis, cleans up.
 */
export async function analyzeVideoScenes(fileId: string, _filename: string): Promise<SceneAnalysis> {
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
			`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${localPath}"`,
			{ encoding: 'utf-8', timeout: 30000 },
		).trim();
		const duration = parseFloat(durationOutput) || 0;

		if (duration <= 0) {
			return {
				duration: 0,
				sceneChanges: [],
				motionPeaks: [],
				quietMoments: [],
				recommendedHooks: [],
				recommendedCloseups: [],
			};
		}

		// Detect scene changes using ffmpeg's scene detection filter.
		// This outputs timestamps where the visual content changes significantly.
		// We use showinfo to get pts_time for each detected scene change.
		let sceneOutput = '';
		try {
			sceneOutput = execSync(
				`ffmpeg -i "${localPath}" -vf "select='gt(scene,0.3)',showinfo" -f null - 2>&1`,
				{ encoding: 'utf-8', timeout: 120000 },
			);
		} catch (err: any) {
			// ffmpeg writes to stderr, which execSync treats as an error with stdio: 'pipe'
			// but with default stdio the output comes through — use the error output if available
			if (err.stderr) {
				sceneOutput = err.stderr.toString();
			} else if (err.stdout) {
				sceneOutput = err.stdout.toString();
			}
		}

		const sceneChanges: SceneChange[] = [];
		const sceneRegex = /pts_time:\s*(\d+\.?\d*)/g;
		let match;
		while ((match = sceneRegex.exec(sceneOutput)) !== null) {
			const ts = parseFloat(match[1]!);
			if (!isNaN(ts)) {
				sceneChanges.push({
					timestamp: ts,
					score: 0.5, // default score
				});
			}
		}

		// Use scene changes as proxy for motion peaks — scene changes in the middle
		// of the video tend to correlate with action moments
		const motionPeaks: MotionPeak[] = sceneChanges
			.filter(sc => sc.timestamp > 1 && sc.timestamp < duration - 1)
			.map(sc => ({ timestamp: sc.timestamp, intensity: sc.score }));

		// Quiet moments: gaps between scene changes longer than 5 seconds
		// (good for interviews, establishing shots, slow moments)
		const quietMoments: number[] = [];
		const sortedChanges = [...sceneChanges].sort((a, b) => a.timestamp - b.timestamp);

		// Check gap from start to first scene change
		if (sortedChanges.length > 0 && sortedChanges[0]!.timestamp > 5) {
			quietMoments.push(sortedChanges[0]!.timestamp / 2);
		}

		for (let i = 0; i < sortedChanges.length - 1; i++) {
			const gap = sortedChanges[i + 1]!.timestamp - sortedChanges[i]!.timestamp;
			if (gap > 5) {
				quietMoments.push(sortedChanges[i]!.timestamp + gap / 2);
			}
		}

		// Check gap from last scene change to end
		if (sortedChanges.length > 0) {
			const lastChange = sortedChanges[sortedChanges.length - 1]!;
			if (duration - lastChange.timestamp > 5) {
				quietMoments.push(lastChange.timestamp + (duration - lastChange.timestamp) / 2);
			}
		}

		// Recommended hooks: first 3 scene changes in the first 30% of video
		// (high motion + scene change = visually interesting opening)
		const earlyScenes = sceneChanges.filter(sc => sc.timestamp < duration * 0.3);
		const recommendedHooks = earlyScenes.slice(0, 3).map(sc => sc.timestamp);

		// Recommended closeups: quiet moments in first half
		// (likely face-to-face interactions, interviews, establishing shots)
		const recommendedCloseups = quietMoments.filter(t => t < duration * 0.5).slice(0, 3);

		return {
			duration,
			sceneChanges,
			motionPeaks,
			quietMoments,
			recommendedHooks,
			recommendedCloseups,
		};
	} finally {
		// Clean up downloaded file
		try {
			if (fs.existsSync(localPath)) {
				fs.unlinkSync(localPath);
			}
		} catch { /* best effort cleanup */ }
	}
}

/**
 * Format scene analysis for inclusion in AI edit plan prompts.
 * Makes the data human-readable so GPT-4o can use it for intelligent clip selection.
 */
export function formatSceneAnalysisForPrompt(analysis: SceneAnalysis): string {
	const sceneTimestamps = analysis.sceneChanges.map(sc =>
		`${sc.timestamp.toFixed(1)}s`,
	).join(', ');

	const hookTimestamps = analysis.recommendedHooks.map(t =>
		`${t.toFixed(1)}s`,
	).join(', ');

	const quietTimestamps = analysis.quietMoments.map(t =>
		`${t.toFixed(1)}s`,
	).join(', ');

	return `  - Total Duration: ${analysis.duration.toFixed(1)}s
  - Scene Changes At: [${sceneTimestamps || 'none detected'}]
  - Best Hook Moments: [${hookTimestamps || 'none detected'}]
  - Quiet/Interview Moments: [${quietTimestamps || 'none detected'}]
  - Total Scene Changes: ${analysis.sceneChanges.length}`;
}
