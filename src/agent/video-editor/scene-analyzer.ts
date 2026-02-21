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

export interface SceneAnalysis {
	duration: number;
	sceneChanges: SceneChange[];
	highMotionMoments: number[];     // timestamps of peak action
	quietMoments: number[];          // timestamps of calm (interviews, establishing)
	recommendedHooks: number[];      // best timestamps for opening hooks
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

/**
 * Format scene analysis for inclusion in AI edit plan prompts.
 */
export function formatSceneAnalysisForPrompt(analysis: SceneAnalysis): string {
	const scenes = analysis.sceneChanges.map(sc => `${sc.timestamp}s`).join(', ');
	const hooks = analysis.recommendedHooks.map(t => `${t}s`).join(', ');
	const quiet = analysis.quietMoments.map(t => `${t}s`).join(', ');
	const action = analysis.highMotionMoments.slice(0, 8).map(t => `${t}s`).join(', ');

	return `  - Video Duration: ${analysis.duration.toFixed(1)}s
  - Scene Changes (${analysis.sceneChanges.length} detected): [${scenes}]
  - High-Action Moments: [${action || 'none detected'}]
  - Quiet/Static Moments: [${quiet || 'none detected'}]
  - Recommended Hook Timestamps: [${hooks}]`;
}
