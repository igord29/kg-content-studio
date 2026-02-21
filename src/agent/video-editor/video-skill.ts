/**
 * Video Skill - FFmpeg command generation and video editing utilities
 * These commands are generated but executed client-side or via Make.com
 */

export interface VideoClip {
	path: string;
	startTime?: number; // seconds
	endTime?: number; // seconds
	label?: string;
}

export interface TextOverlay {
	text: string;
	startTime: number; // seconds
	duration: number; // seconds
	position: 'top' | 'center' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
	fontSize?: number;
	fontColor?: string;
	bgColor?: string;
	animation?: 'fade' | 'slide-up' | 'slide-down' | 'none';
}

export interface AudioTrack {
	path: string;
	volume?: number; // 0-1
	fadeIn?: number; // seconds
	fadeOut?: number; // seconds
}

export interface VideoTemplate {
	id: string;
	name: string;
	description: string;
	aspectRatio: '16:9' | '9:16' | '1:1' | '4:5';
	duration: number; // target duration in seconds
	style: 'dynamic' | 'calm' | 'energetic' | 'storytelling';
	overlays: TextOverlay[];
	transitions: ('fade' | 'cut' | 'dissolve' | 'wipe')[];
}

// Pre-built templates for common nonprofit video types
export const VIDEO_TEMPLATES: VideoTemplate[] = [
	{
		id: 'tiktok-highlight',
		name: 'TikTok Highlight',
		description: 'Quick 15-30 second highlight reel for TikTok/Reels',
		aspectRatio: '9:16',
		duration: 20,
		style: 'dynamic',
		overlays: [
			{ text: '', startTime: 0, duration: 3, position: 'center', fontSize: 48, animation: 'fade' },
		],
		transitions: ['cut', 'cut', 'fade'],
	},
	{
		id: 'youtube-intro',
		name: 'YouTube Intro',
		description: '5-10 second branded intro for YouTube videos',
		aspectRatio: '16:9',
		duration: 7,
		style: 'energetic',
		overlays: [
			{ text: 'Community Literacy Club', startTime: 1, duration: 4, position: 'center', fontSize: 64, animation: 'fade' },
			{ text: 'Tennis | Chess | Mentorship', startTime: 3, duration: 3, position: 'bottom', fontSize: 24, animation: 'slide-up' },
		],
		transitions: ['fade', 'fade'],
	},
	{
		id: 'instagram-story',
		name: 'Instagram Story',
		description: '15 second story with text overlays',
		aspectRatio: '9:16',
		duration: 15,
		style: 'calm',
		overlays: [
			{ text: '', startTime: 0, duration: 3, position: 'top', fontSize: 32, animation: 'slide-down' },
			{ text: '', startTime: 10, duration: 5, position: 'bottom', fontSize: 24, animation: 'fade' },
		],
		transitions: ['dissolve', 'fade'],
	},
	{
		id: 'event-recap',
		name: 'Event Recap',
		description: '60-90 second event highlight video',
		aspectRatio: '16:9',
		duration: 75,
		style: 'storytelling',
		overlays: [
			{ text: '', startTime: 0, duration: 4, position: 'center', fontSize: 56, animation: 'fade' },
			{ text: '', startTime: 70, duration: 5, position: 'center', fontSize: 32, animation: 'fade' },
		],
		transitions: ['dissolve', 'cut', 'cut', 'dissolve', 'fade'],
	},
	{
		id: 'testimonial',
		name: 'Testimonial Clip',
		description: '30-60 second testimonial with name lower-third',
		aspectRatio: '16:9',
		duration: 45,
		style: 'calm',
		overlays: [
			{ text: '', startTime: 2, duration: 5, position: 'bottom-left', fontSize: 24, bgColor: '#2D6A4F', animation: 'slide-up' },
		],
		transitions: ['fade', 'fade'],
	},
	{
		id: 'square-promo',
		name: 'Square Promo',
		description: '30 second promotional video for feed posts',
		aspectRatio: '1:1',
		duration: 30,
		style: 'energetic',
		overlays: [
			{ text: '', startTime: 0, duration: 3, position: 'center', fontSize: 48, animation: 'fade' },
			{ text: '', startTime: 25, duration: 5, position: 'bottom', fontSize: 28, animation: 'slide-up' },
		],
		transitions: ['cut', 'dissolve', 'fade'],
	},
];

/**
 * Get aspect ratio dimensions
 */
export function getAspectRatioDimensions(ratio: string): { width: number; height: number } {
	const dimensions: Record<string, { width: number; height: number }> = {
		'16:9': { width: 1920, height: 1080 },
		'9:16': { width: 1080, height: 1920 },
		'1:1': { width: 1080, height: 1080 },
		'4:5': { width: 1080, height: 1350 },
	};
	return dimensions[ratio] ?? { width: 1920, height: 1080 };
}

/**
 * Generate FFmpeg command for trimming a clip
 */
export function generateTrimCommand(
	inputPath: string,
	outputPath: string,
	startTime: number,
	endTime: number,
): string {
	const duration = endTime - startTime;
	return `ffmpeg -i "${inputPath}" -ss ${startTime} -t ${duration} -c copy "${outputPath}"`;
}

/**
 * Generate FFmpeg command for scaling to aspect ratio
 */
export function generateScaleCommand(
	inputPath: string,
	outputPath: string,
	aspectRatio: string,
): string {
	const { width, height } = getAspectRatioDimensions(aspectRatio);
	return `ffmpeg -i "${inputPath}" -vf "scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2" -c:a copy "${outputPath}"`;
}

/**
 * Generate FFmpeg command for text overlay
 */
export function generateTextOverlayCommand(
	inputPath: string,
	outputPath: string,
	overlay: TextOverlay,
): string {
	const { text, startTime, duration, position, fontSize = 32, fontColor = 'white' } = overlay;

	// Calculate position coordinates
	let x = '(w-text_w)/2';
	let y = '(h-text_h)/2';

	switch (position) {
		case 'top':
			y = '50';
			break;
		case 'bottom':
			y = 'h-text_h-50';
			break;
		case 'top-left':
			x = '50';
			y = '50';
			break;
		case 'top-right':
			x = 'w-text_w-50';
			y = '50';
			break;
		case 'bottom-left':
			x = '50';
			y = 'h-text_h-50';
			break;
		case 'bottom-right':
			x = 'w-text_w-50';
			y = 'h-text_h-50';
			break;
	}

	const endTime = startTime + duration;
	const escapedText = text.replace(/'/g, "'\\''").replace(/:/g, '\\:');

	return `ffmpeg -i "${inputPath}" -vf "drawtext=text='${escapedText}':fontsize=${fontSize}:fontcolor=${fontColor}:x=${x}:y=${y}:enable='between(t,${startTime},${endTime})'" -c:a copy "${outputPath}"`;
}

/**
 * Generate FFmpeg command for concatenating clips
 */
export function generateConcatCommand(
	inputPaths: string[],
	outputPath: string,
	transition: 'cut' | 'fade' | 'dissolve' = 'cut',
): string {
	if (transition === 'cut') {
		// Simple concatenation
		const listContent = inputPaths.map((p) => `file '${p}'`).join('\n');
		return `# First create a file list:\necho "${listContent}" > filelist.txt\n\n# Then run:\nffmpeg -f concat -safe 0 -i filelist.txt -c copy "${outputPath}"`;
	}

	// For fade/dissolve, use xfade filter (simplified for 2 clips)
	if (inputPaths.length === 2) {
		const filterType = transition === 'fade' ? 'fade' : 'dissolve';
		return `ffmpeg -i "${inputPaths[0]}" -i "${inputPaths[1]}" -filter_complex "xfade=transition=${filterType}:duration=0.5:offset=5" -c:a copy "${outputPath}"`;
	}

	return generateConcatCommand(inputPaths, outputPath, 'cut');
}

/**
 * Generate FFmpeg command for adding background music
 */
export function generateAddMusicCommand(
	videoPath: string,
	audioPath: string,
	outputPath: string,
	volume: number = 0.3,
	fadeOut: number = 2,
): string {
	return `ffmpeg -i "${videoPath}" -i "${audioPath}" -filter_complex "[1:a]volume=${volume},afade=t=out:st=58:d=${fadeOut}[bg];[0:a][bg]amix=inputs=2:duration=first" -c:v copy "${outputPath}"`;
}

/**
 * Generate a complete video editing script based on template
 */
export function generateVideoScript(
	template: VideoTemplate,
	clips: VideoClip[],
	customOverlays?: TextOverlay[],
	bgMusic?: AudioTrack,
): string {
	const steps: string[] = [];
	const { width, height } = getAspectRatioDimensions(template.aspectRatio);

	steps.push(`# Video Editing Script: ${template.name}`);
	steps.push(`# Target: ${template.aspectRatio} @ ${width}x${height}`);
	steps.push(`# Duration: ~${template.duration}s`);
	steps.push('');
	steps.push('# Step 1: Prepare clips');

	clips.forEach((clip, i) => {
		const outputFile = `clip_${i}_prepared.mp4`;

		// Trim if needed
		if (clip.startTime !== undefined && clip.endTime !== undefined) {
			steps.push(`# Trim clip ${i + 1}`);
			steps.push(generateTrimCommand(clip.path, `clip_${i}_trimmed.mp4`, clip.startTime, clip.endTime));
			steps.push(`# Scale clip ${i + 1}`);
			steps.push(generateScaleCommand(`clip_${i}_trimmed.mp4`, outputFile, template.aspectRatio));
		} else {
			steps.push(`# Scale clip ${i + 1}`);
			steps.push(generateScaleCommand(clip.path, outputFile, template.aspectRatio));
		}
		steps.push('');
	});

	steps.push('# Step 2: Concatenate clips');
	const clipOutputs = clips.map((_, i) => `clip_${i}_prepared.mp4`);
	// Map 'wipe' to 'dissolve' since generateConcatCommand doesn't support 'wipe'
	const transition = template.transitions[0];
	const concatTransition: 'cut' | 'fade' | 'dissolve' = transition === 'wipe' ? 'dissolve' : (transition || 'cut');
	steps.push(generateConcatCommand(clipOutputs, 'merged.mp4', concatTransition));
	steps.push('');

	// Apply overlays
	const overlaysToApply = customOverlays || template.overlays;
	if (overlaysToApply.length > 0) {
		steps.push('# Step 3: Add text overlays');
		let currentInput = 'merged.mp4';
		overlaysToApply.forEach((overlay, i) => {
			if (overlay.text) {
				const outputFile = i === overlaysToApply.length - 1 ? 'with_overlays.mp4' : `overlay_${i}.mp4`;
				steps.push(generateTextOverlayCommand(currentInput, outputFile, overlay));
				currentInput = outputFile;
			}
		});
		steps.push('');
	}

	// Add background music
	if (bgMusic) {
		steps.push('# Step 4: Add background music');
		const inputFile = overlaysToApply.length > 0 ? 'with_overlays.mp4' : 'merged.mp4';
		steps.push(generateAddMusicCommand(inputFile, bgMusic.path, 'final_output.mp4', bgMusic.volume, bgMusic.fadeOut));
	}

	steps.push('');
	steps.push('# Final output: final_output.mp4');

	return steps.join('\n');
}

/**
 * Get template by ID
 */
export function getTemplateById(id: string): VideoTemplate | undefined {
	return VIDEO_TEMPLATES.find((t) => t.id === id);
}

/**
 * Get template recommendations based on platform and content type
 */
export function getTemplateRecommendations(
	platform: string,
	contentType?: string,
): { templateId: string; templateName: string; reason: string }[] {
	const plat = platform.toLowerCase();
	const content = (contentType || '').toLowerCase();

	if (plat === 'tiktok' || plat === 'reels' || plat === 'instagram reels') {
		return [
			{ templateId: 'tiktok-highlight', templateName: 'TikTok Highlight', reason: 'Optimized for vertical short-form content' },
			{ templateId: 'instagram-story', templateName: 'Instagram Story', reason: 'Great for quick updates and behind-the-scenes' },
		];
	}

	if (plat === 'youtube') {
		if (content.includes('intro')) {
			return [
				{ templateId: 'youtube-intro', templateName: 'YouTube Intro', reason: 'Professional branded intro' },
			];
		}
		return [
			{ templateId: 'event-recap', templateName: 'Event Recap', reason: 'Perfect for longer YouTube content' },
			{ templateId: 'testimonial', templateName: 'Testimonial Clip', reason: 'Great for interview-style content' },
		];
	}

	if (plat === 'instagram' && !content.includes('reel')) {
		return [
			{ templateId: 'square-promo', templateName: 'Square Promo', reason: 'Optimized for Instagram feed' },
			{ templateId: 'instagram-story', templateName: 'Instagram Story', reason: 'Perfect for Stories format' },
		];
	}

	if (content.includes('event') || content.includes('recap')) {
		return [
			{ templateId: 'event-recap', templateName: 'Event Recap', reason: 'Designed for event highlight videos' },
		];
	}

	if (content.includes('testimonial') || content.includes('interview')) {
		return [
			{ templateId: 'testimonial', templateName: 'Testimonial Clip', reason: 'Professional lower-third styling' },
		];
	}

	// Default recommendations
	return [
		{ templateId: 'square-promo', templateName: 'Square Promo', reason: 'Versatile format for most platforms' },
		{ templateId: 'event-recap', templateName: 'Event Recap', reason: 'Great for storytelling content' },
	];
}
