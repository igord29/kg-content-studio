/**
 * Video Reviewer
 * Downloads a rendered video, extracts frames, and sends them to GPT-4o vision
 * for a professional editorial review. Evaluates storytelling, pacing, and
 * platform fit, then returns actionable feedback.
 *
 * File: src/agent/video-editor/video-reviewer.ts
 */

import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { videoDirectorPrompt } from './video-director-prompt';

// --- Types ---

export interface ReviewIssue {
	severity: 'critical' | 'warning' | 'suggestion';
	timestamp: string;
	category: 'pacing' | 'storytelling' | 'platform' | 'visual' | 'text';
	description: string;
	fix: string;
}

export interface VideoReview {
	overallScore: number;
	storytellingScore: number;
	pacingScore: number;
	platformFitScore: number;

	storyArc: 'clear' | 'weak' | 'missing';
	hookEffectiveness: string;
	endingQuality: string;

	issues: ReviewIssue[];
	strengths: string[];

	summary: string;
}

// --- Review Prompt ---

function buildReviewPrompt(mode: string, platform: string): string {
	const modeStructures: Record<string, string> = {
		game_day: `GAME DAY structure:
[0-2s] HOOK — strongest visual moment, immediate motion
[2-8s] BUILD — escalating action clips, increasing pace
[8-12s] PEAK — the moment (winning point, celebration, reaction)
[12-15s] RESOLVE — group shot or emotional beat + CLC branding
Pacing: Fast cuts 1-3s per clip. Energy builds continuously. Beat-synced when music present.`,

		our_story: `OUR STORY structure:
[0-5s] COLD OPEN — most compelling quote or visual teaser
[5-15s] ESTABLISH — B-roll of the program, location, atmosphere
[15-60s] THE STORY — interview with B-roll intercuts
[60-80s] THE TURN — emotional peak or key insight
[80-100s] RESOLUTION — hope, growth, what's next
Pacing: Slower, intentional cuts 3-6s each. Let people finish sentences. Breathing room between sections.`,

		quick_hit: `QUICK HIT structure:
[0-1s] HOOK TEXT — question or statement that stops the scroll
[1-10s] THE MOMENT — the thing worth watching
[10-15s] REACTION/PAYOFF — response, result, or punchline
[15s] CTA — "Follow for more" or "Link in bio"
Pacing: Native platform feel. Jump cuts are fine. 1-3s per clip. Text-heavy for sound-off viewing.`,

		showcase: `SHOWCASE structure:
[0-5s] COLD OPEN — arresting visual or quote
[5-20s] THE PROBLEM — why this matters
[20-50s] THE SOLUTION — what CLC does, shown not told
[50-90s] THE PROOF — kids thriving, stats, testimonials woven together
[90-120s] THE VISION — where CLC is going
Pacing: Measured, confident 3-5s per clip. Every shot intentional. Smooth transitions. Premium feel.`,
	};

	const platformRules: Record<string, string> = {
		tiktok: `TikTok rules:
- Aspect ratio: 9:16 vertical
- Duration: 15-60s (sweet spot 30-45s)
- Hook: Must grab attention in first 1-2 seconds — this is scroll-or-stop
- Music: NO embedded music (team adds trending sounds at upload)
- Captions: Burned in, readable at mobile size
- Feel: Should look native, not over-produced
- CTA: "Follow for more" at end`,

		ig_reels: `Instagram Reels rules:
- Aspect ratio: 9:16 vertical
- Duration: 15-60s (sweet spot 30-45s)
- Hook: Immediate — Reels autoplay, viewer decides in 1-2 seconds
- Music: NO embedded music (team adds trending sounds)
- Captions: Burned in, readable
- Feel: Polished but authentic
- CTA: "Follow @handle"`,

		ig_feed: `Instagram Feed rules:
- Aspect ratio: 1:1 or 4:5
- Duration: 15-60s (sweet spot 30-45s)
- Hook: Strong but can be slightly more considered than Reels
- Music: Tier 2 (Pixabay) baked in
- Captions: Burned in
- Feel: Curated, gallery-worthy
- CTA: "Link in bio"`,

		youtube: `YouTube rules:
- Aspect ratio: 16:9 landscape
- Duration: 60-180s (can breathe, build narrative)
- Hook: First 5 seconds matter, but viewers are more patient here
- Music: Tier 2 (Pixabay) or Tier 3 (Suno) baked in
- Captions: Separate SRT file
- Feel: Polished, cinematic, longer holds are welcome
- Intro: Brief branded intro (2-3s), full outro with subscribe CTA`,

		facebook: `Facebook rules:
- Aspect ratio: 16:9 or 1:1
- Duration: 30-90s (sweet spot 45-60s)
- Hook: Autoplay without sound — need strong visual hook + captions
- Music: Tier 2 (Pixabay) baked in
- Captions: Burned in (most viewers watch without sound)
- Feel: Community-oriented, warm, accessible
- CTA: "Learn more at website"`,

		linkedin: `LinkedIn rules:
- Aspect ratio: 16:9
- Duration: 30-90s (sweet spot 30-60s)
- Hook: Professional but compelling — this audience respects substance
- Music: Tier 2 (Pixabay) baked in, subtle
- Captions: Burned in
- Feel: Professional, impact-focused, results-oriented
- No emoji in overlays. Professional tone throughout.
- CTA: "Visit website / Partner with us"`,
	};

	const modeInfo = modeStructures[mode] || modeStructures['game_day']!;
	const platformInfo = platformRules[platform] || platformRules['tiktok']!;

	return `You are a professional video editor and social media strategist reviewing a rendered video for Community Literacy Club (CLC), a youth tennis and chess nonprofit.

You are reviewing the RENDERED OUTPUT — the final video that will be published. You are looking at frames extracted from the actual render, not the source footage.

EDITING MODE USED: ${mode.toUpperCase()}
${modeInfo}

TARGET PLATFORM: ${platform.toUpperCase()}
${platformInfo}

REVIEW CRITERIA — evaluate each area and score 1-10:

STORYTELLING (1-10):
- Does the video have a clear narrative arc? (beginning → middle → end)
- Is there an emotional center — a moment the whole edit builds toward?
- Do clips connect logically, or is it random montage ("clip soup")?
- Does the ending feel intentional (resolution) or abrupt (ran out of footage)?
- Would a first-time viewer understand what's happening and why they should care?
- Are quiet/breathing moments used effectively, or is everything the same energy level?

PACING (1-10, based on the ${mode} mode rules above):
- Do clip durations match the mode's pacing rules?
- Are any clips too short to process visually (under 2 seconds)?
- Are any clips held so long they become boring?
- Does the rhythm vary, or is every cut the same length?
- Does the energy build appropriately for this mode?
- Is there contrast between high-energy and calm moments?

PLATFORM FIT (1-10, based on the ${platform} platform rules above):
- Does the overall duration feel right for this platform?
- Does the hook work for this platform's viewing behavior?
- Would text overlays be readable at typical viewing size for this platform?
- Does the production quality match platform expectations?
- Would this content perform well on ${platform} specifically?
- Does it follow platform-specific rules (music, captions, CTA)?

VISUAL QUALITY:
- Are transitions clean or jarring?
- Are there any black frames, blank spaces, or visual glitches?
- Do text overlays appear and disappear smoothly?
- Are the clips from consistent locations, or are there jarring location jumps?
- Is the color grading consistent across clips?

Return ONLY valid JSON in this exact format:
{
  "overallScore": 7,
  "storytellingScore": 6,
  "pacingScore": 7,
  "platformFitScore": 8,
  "storyArc": "clear",
  "hookEffectiveness": "Strong opening with kid mid-serve — immediately draws attention",
  "endingQuality": "Abrupt — cuts to branding card without emotional resolution",
  "issues": [
    {
      "severity": "critical",
      "timestamp": "0-3s",
      "category": "pacing",
      "description": "Opening three clips are each under 2 seconds — viewer can't process what they're seeing",
      "fix": "Combine into one 4-5 second establishing shot, or hold the strongest frame longer"
    },
    {
      "severity": "warning",
      "timestamp": "12-15s",
      "category": "storytelling",
      "description": "Jump from tennis action to chess with no transition — feels disconnected",
      "fix": "Add a 1-second breathing moment between the two activities, or use a text overlay to bridge"
    }
  ],
  "strengths": [
    "Strong visual hook — the opening frame immediately captures attention",
    "Good use of location variety showing CLC's reach"
  ],
  "summary": "The edit has strong raw material but rushes through clips too quickly for the viewer to connect emotionally. The opening hook works well but the middle section feels like a montage rather than a story. Needs longer clip holds and a more intentional ending."
}

Be specific and actionable. Reference exact timestamps. Every issue must include a concrete fix suggestion. Be honest — a score of 5 means average, not bad. Only give 8+ if the edit genuinely excels in that area.`;
}

// --- Frame Extraction ---

/**
 * Download a video from a URL and extract frames for review.
 * Returns paths to extracted JPEG frames.
 */
async function downloadAndExtractFrames(
	downloadUrl: string,
	frameCount: number = 8,
): Promise<{ videoPath: string; framePaths: string[]; duration: number }> {
	const fs = await import('fs');
	const path = await import('path');
	const { execSync } = await import('child_process');

	const tempDir = path.join(process.cwd(), '.temp-cataloger');
	if (!fs.existsSync(tempDir)) {
		fs.mkdirSync(tempDir, { recursive: true });
	}

	const videoId = `review_${Date.now()}`;
	const videoPath = path.join(tempDir, `${videoId}.mp4`);

	// Download the rendered video
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 120000);

	try {
		const response = await fetch(downloadUrl, {
			signal: controller.signal,
		});
		clearTimeout(timeoutId);

		if (!response.ok) {
			throw new Error(`Download failed: ${response.status} ${response.statusText}`);
		}

		const fileStream = fs.createWriteStream(videoPath);
		const reader = (response.body as ReadableStream<Uint8Array>).getReader();

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				fileStream.write(Buffer.from(value));
			}
		} finally {
			fileStream.end();
		}

		await new Promise<void>((resolve, reject) => {
			fileStream.on('finish', resolve);
			fileStream.on('error', reject);
		});
	} catch (err) {
		clearTimeout(timeoutId);
		if (fs.existsSync(videoPath)) {
			try { fs.unlinkSync(videoPath); } catch { /* ignore */ }
		}
		throw err;
	}

	// Get duration
	let duration = 0;
	try {
		const durationOutput = execSync(
			`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
			{ encoding: 'utf-8', timeout: 30000 },
		).trim();
		duration = parseFloat(durationOutput) || 0;
	} catch {
		duration = 0;
	}

	if (duration <= 0) {
		return { videoPath, framePaths: [], duration: 0 };
	}

	// Extract frames evenly spaced across the video
	// Use more frames than cataloging (8-10) for finer pacing analysis
	const framePaths: string[] = [];
	for (let i = 0; i < frameCount; i++) {
		// Space frames from 5% to 95% of the video
		const pct = 0.05 + (0.90 * i) / (frameCount - 1);
		const timestamp = duration * pct;
		const framePath = path.join(tempDir, `${videoId}_review_${i}.jpg`);

		try {
			execSync(
				`ffmpeg -y -ss ${timestamp.toFixed(2)} -i "${videoPath}" -frames:v 1 -q:v 2 "${framePath}"`,
				{ timeout: 30000, stdio: 'pipe' },
			);
			if (fs.existsSync(framePath)) {
				framePaths.push(framePath);
			}
		} catch {
			// Skip failed frames
		}
	}

	return { videoPath, framePaths, duration };
}

/**
 * Clean up review temp files.
 */
async function cleanupReviewFiles(videoPath: string, framePaths: string[]): Promise<void> {
	const fs = await import('fs');
	try {
		if (fs.existsSync(videoPath)) {
			fs.unlinkSync(videoPath);
		}
	} catch { /* best effort */ }

	for (const fp of framePaths) {
		try {
			if (fs.existsSync(fp)) {
				fs.unlinkSync(fp);
			}
		} catch { /* best effort */ }
	}
}

// --- Main Review Function ---

/**
 * Review a rendered video by extracting frames and sending to GPT-4o vision.
 */
export async function reviewRenderedVideo(
	downloadUrl: string,
	editPlan: Record<string, unknown> | null,
	mode: string,
	platform: string,
): Promise<VideoReview> {
	const fs = await import('fs');

	// Download and extract frames
	const { videoPath, framePaths, duration } = await downloadAndExtractFrames(downloadUrl, 8);

	if (framePaths.length === 0) {
		await cleanupReviewFiles(videoPath, framePaths);
		throw new Error('Could not extract any frames from the rendered video');
	}

	try {
		// Build multi-image content for GPT-4o vision
		const contentParts: Array<{ type: 'image'; image: Uint8Array } | { type: 'text'; text: string }> = [];

		for (let i = 0; i < framePaths.length; i++) {
			const framePath = framePaths[i]!;
			const imageBuffer = fs.readFileSync(framePath);
			contentParts.push({
				type: 'image',
				image: new Uint8Array(imageBuffer),
			});
		}

		// Build frame labels with approximate timestamps
		const frameLabels = framePaths.map((_, i) => {
			const pct = 0.05 + (0.90 * i) / (framePaths.length - 1);
			const ts = (duration * pct).toFixed(1);
			return `Frame ${i + 1}: ~${ts}s into the video`;
		}).join('\n');

		// Build the text part with context
		let editPlanContext = '';
		if (editPlan) {
			const clipCount = Array.isArray(editPlan.clips) ? editPlan.clips.length : 0;
			const overlayCount = Array.isArray(editPlan.textOverlays) ? editPlan.textOverlays.length : 0;
			const totalDur = editPlan.totalDuration || 'unknown';
			const musicDir = editPlan.musicDirection || 'none specified';

			editPlanContext = `
ORIGINAL EDIT PLAN CONTEXT:
- Mode: ${editPlan.mode || mode}
- Total clips used: ${clipCount}
- Text overlays: ${overlayCount}
- Planned duration: ${totalDur}s
- Music direction: ${musicDir}
- Transitions: ${editPlan.transitions || 'default'}

Compare the rendered result against this intent. Did the edit plan's vision come through in the final render?`;
		}

		contentParts.push({
			type: 'text',
			text: `These ${framePaths.length} frames are extracted from a rendered video (${duration.toFixed(1)}s long) for the ${platform.toUpperCase()} platform using ${mode.toUpperCase()} editing mode.

${frameLabels}

Review these frames as the final rendered output that will be published. Evaluate the storytelling, pacing, and platform fit.
${editPlanContext}

Return your review as JSON following the format specified in your instructions.`,
		});

		// Send to GPT-4o
		const result = await generateText({
			model: openai('gpt-4o'),
			system: buildReviewPrompt(mode, platform),
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

		const review = JSON.parse(jsonStr) as VideoReview;
		return review;

	} finally {
		await cleanupReviewFiles(videoPath, framePaths);
	}
}

// --- Revised Edit Plan Generator ---

/**
 * Generate a revised edit plan based on review feedback.
 * Takes the review issues, original edit plan, and footage context,
 * then asks GPT-4o to produce a corrected edit plan.
 */
export async function generateRevisedEditPlan(
	review: VideoReview,
	originalEditPlan: Record<string, unknown>,
	footageContext: string,
	mode: string,
	platform: string,
): Promise<Record<string, unknown> | null> {
	// Map each issue to the clip index it most likely affects (by timestamp)
	const originalClips = Array.isArray(originalEditPlan.clips) ? originalEditPlan.clips as Array<{ trimStart?: number; duration?: number; fileId?: string; filename?: string; purpose?: string }> : [];

	const issuesList = review.issues.map((issue, i) => {
		// Try to match issue timestamp to a clip index
		let clipHint = '';
		if (issue.timestamp) {
			const tsMatch = issue.timestamp.match(/(\d+)/);
			if (tsMatch) {
				const issueTime = parseInt(tsMatch[1]!);
				let accumulatedTime = 0;
				for (let ci = 0; ci < originalClips.length; ci++) {
					const clipDur = originalClips[ci]?.duration || 4;
					if (issueTime >= accumulatedTime && issueTime < accumulatedTime + clipDur) {
						clipHint = ` → Affects Clip ${ci + 1} (${originalClips[ci]?.filename || originalClips[ci]?.fileId || 'unknown'})`;
						break;
					}
					accumulatedTime += clipDur;
				}
			}
		}
		return `${i + 1}. [${issue.severity.toUpperCase()}] ${issue.category} at ${issue.timestamp}: ${issue.description}${clipHint}\n   Fix: ${issue.fix}`;
	}).join('\n');

	const strengthsList = review.strengths.map((s, i) => `${i + 1}. ${s}`).join('\n');

	const prompt = `You are REVISING an edit plan that was already rendered and reviewed. The rendered video scored poorly. Your job is to fix it.

SCORES:
- Overall: ${review.overallScore}/10
- Storytelling: ${review.storytellingScore}/10
- Pacing: ${review.pacingScore}/10
- Platform Fit: ${review.platformFitScore}/10

STORY ARC: ${review.storyArc}
HOOK: ${review.hookEffectiveness}
ENDING: ${review.endingQuality}

ISSUES TO FIX (with affected clips):
${issuesList}

STRENGTHS TO KEEP:
${strengthsList}

REVIEWER SUMMARY: ${review.summary}

ORIGINAL EDIT PLAN:
${JSON.stringify(originalEditPlan, null, 2)}

AVAILABLE FOOTAGE (with scene analysis timestamps):
${footageContext}

---

YOUR PRIMARY REVISION TOOL IS \`trimStart\`.

The original edit plan picked specific moments from the source videos. Many of those moments may be boring, poorly framed, or wrong for the story. Each source video has multiple interesting moments at different timestamps. Your job is to pick BETTER moments by changing trimStart values.

REVISION STRATEGY:
1. For each issue flagged by the reviewer, identify which clip(s) it affects
2. Look at the SCENE ANALYSIS data for that clip's source video — find alternative trim points:
   - Scene Changes: good for establishing shots and transitions
   - High-Motion Moments: good for energy and action
   - Recommended Hooks: good for opening clips and attention-grabbers
3. Change the trimStart to a DIFFERENT timestamp from the scene analysis
4. Adjust duration to hold the new moment long enough to land (usually 3-6s)

GOOD REVISION EXAMPLE:
  Issue: "Clip 3 at 8-12s is boring — shows empty court"
  Original: trimStart=2, duration=4
  Source video has highMotionMoments at [8.7, 22.1] and sceneChanges at [1.5, 12.0, 28.3]
  → Revised: trimStart=8.7, duration=4 (picks a high-action moment instead)

BAD REVISION (what NOT to do):
  Issue: "Clip 3 at 8-12s is boring — shows empty court"
  Original: trimStart=2, duration=4
  → Revised: trimStart=2, duration=6 (WRONG — same boring footage, just longer!)

ADDITIONAL RULES:
- Do NOT just stretch or shrink clip durations — that keeps the same boring footage
- DO pick different trimStart values from the scene analysis timestamps
- KEEP clips that the reviewer praised — don't change what works
- KEEP the same fileId references — you can only change WHEN you cut into each video, not WHICH videos to use
- You CAN reorder clips for better story flow
- You CAN add the same fileId twice with different trimStart to show different moments
- Target total duration for ${platform}: match platform guidelines
- Follow ${mode} mode structure for pacing and energy

Return ONLY the revised JSON edit plan (same format as the original) wrapped in \`\`\`json fences. Include a "revisionNotes" field explaining what you changed and why for each clip.`;

	const result = await generateText({
		model: openai('gpt-4o'),
		system: videoDirectorPrompt,
		prompt,
	});

	const jsonMatch = result.text.match(/```json\s*([\s\S]*?)```/);
	if (jsonMatch?.[1]) {
		try {
			return JSON.parse(jsonMatch[1].trim());
		} catch {
			return null;
		}
	}

	return null;
}
