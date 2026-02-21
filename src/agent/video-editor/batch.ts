/**
 * Batch Processing for Video Editor
 * Handles processing multiple videos with the same settings
 */

import { generateScaleCommand, generateTextOverlayCommand, type TextOverlay, type VideoTemplate, getAspectRatioDimensions } from './video-skill';

export interface BatchJob {
	id: string;
	name: string;
	status: 'pending' | 'processing' | 'completed' | 'failed';
	inputFiles: string[];
	outputFiles: string[];
	template: VideoTemplate;
	customOverlays?: TextOverlay[];
	createdAt: string;
	completedAt?: string;
	error?: string;
}

export interface BatchConfig {
	template: VideoTemplate;
	overlays?: TextOverlay[];
	outputFormat: 'mp4' | 'webm' | 'mov';
	quality: 'draft' | 'standard' | 'high';
	outputDirectory: string;
	namingPattern: 'original' | 'sequential' | 'timestamped';
}

/**
 * Generate batch processing script for multiple files
 */
export function generateBatchScript(
	inputFiles: string[],
	config: BatchConfig,
): string {
	const lines: string[] = [];
	const { width, height } = getAspectRatioDimensions(config.template.aspectRatio);

	// Quality presets
	const qualitySettings: Record<string, string> = {
		draft: '-crf 28 -preset ultrafast',
		standard: '-crf 23 -preset medium',
		high: '-crf 18 -preset slow',
	};

	lines.push('#!/bin/bash');
	lines.push('# Batch Video Processing Script');
	lines.push(`# Template: ${config.template.name}`);
	lines.push(`# Files to process: ${inputFiles.length}`);
	lines.push(`# Output: ${config.outputDirectory}`);
	lines.push('');
	lines.push(`mkdir -p "${config.outputDirectory}"`);
	lines.push('');

	inputFiles.forEach((file, index) => {
		const baseName = file.split('/').pop()?.replace(/\.[^.]+$/, '') || `video_${index}`;
		let outputName: string;

		switch (config.namingPattern) {
			case 'sequential':
				outputName = `processed_${String(index + 1).padStart(3, '0')}`;
				break;
			case 'timestamped':
				outputName = `${baseName}_${Date.now()}`;
				break;
			default:
				outputName = `${baseName}_processed`;
		}

		const outputPath = `${config.outputDirectory}/${outputName}.${config.outputFormat}`;
		const tempPath = `${config.outputDirectory}/temp_${index}.mp4`;

		lines.push(`echo "Processing file ${index + 1}/${inputFiles.length}: ${file}"`);
		lines.push('');

		// Step 1: Scale to aspect ratio
		lines.push(`# Scale to ${config.template.aspectRatio}`);
		lines.push(`ffmpeg -i "${file}" -vf "scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2" ${qualitySettings[config.quality]} "${tempPath}"`);
		lines.push('');

		// Step 2: Apply overlays if any
		if (config.overlays && config.overlays.length > 0) {
			let currentInput = tempPath;
			config.overlays.forEach((overlay, overlayIndex) => {
				if (overlay.text) {
					const overlayOutput = overlayIndex === config.overlays!.length - 1
						? outputPath
						: `${config.outputDirectory}/overlay_${index}_${overlayIndex}.mp4`;

					lines.push(`# Apply text overlay ${overlayIndex + 1}`);
					const cmd = generateTextOverlayCommand(currentInput, overlayOutput, overlay);
					lines.push(cmd);
					lines.push('');

					// Clean up previous temp file
					if (overlayIndex > 0) {
						lines.push(`rm "${currentInput}"`);
					}
					currentInput = overlayOutput;
				}
			});
		} else {
			// No overlays, just rename temp to output
			lines.push(`mv "${tempPath}" "${outputPath}"`);
		}

		lines.push('');
		lines.push(`echo "Completed: ${outputPath}"`);
		lines.push('');
	});

	lines.push('echo "Batch processing complete!"');
	lines.push(`echo "Processed ${inputFiles.length} files to ${config.outputDirectory}"`);

	return lines.join('\n');
}

/**
 * Create a batch job record
 */
export function createBatchJob(
	name: string,
	inputFiles: string[],
	template: VideoTemplate,
	customOverlays?: TextOverlay[],
): BatchJob {
	return {
		id: `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
		name,
		status: 'pending',
		inputFiles,
		outputFiles: [],
		template,
		customOverlays,
		createdAt: new Date().toISOString(),
	};
}

/**
 * Estimate processing time for a batch job
 */
export function estimateBatchTime(
	inputFiles: string[],
	quality: 'draft' | 'standard' | 'high',
): { minutes: number; description: string } {
	// Rough estimates based on typical video lengths and processing speeds
	const baseTimePerFile: Record<string, number> = {
		draft: 0.5, // 30 seconds per file
		standard: 2, // 2 minutes per file
		high: 5, // 5 minutes per file
	};

	const totalMinutes = inputFiles.length * (baseTimePerFile[quality] ?? 2);

	let description: string;
	if (totalMinutes < 1) {
		description = 'Less than a minute';
	} else if (totalMinutes < 5) {
		description = 'A few minutes';
	} else if (totalMinutes < 30) {
		description = `About ${Math.round(totalMinutes)} minutes`;
	} else if (totalMinutes < 60) {
		description = `About ${Math.round(totalMinutes / 5) * 5} minutes`;
	} else {
		const hours = Math.round(totalMinutes / 60 * 10) / 10;
		description = `About ${hours} hour${hours > 1 ? 's' : ''}`;
	}

	return { minutes: totalMinutes, description };
}

/**
 * Generate thumbnail extraction commands for batch
 */
export function generateThumbnailBatch(
	inputFiles: string[],
	outputDirectory: string,
	timeOffset: number = 1, // seconds into video
): string {
	const lines: string[] = [];

	lines.push('#!/bin/bash');
	lines.push('# Thumbnail Extraction Script');
	lines.push(`# Extracting thumbnails from ${inputFiles.length} videos`);
	lines.push('');
	lines.push(`mkdir -p "${outputDirectory}"`);
	lines.push('');

	inputFiles.forEach((file, index) => {
		const baseName = file.split('/').pop()?.replace(/\.[^.]+$/, '') || `video_${index}`;
		const outputPath = `${outputDirectory}/${baseName}_thumb.jpg`;

		lines.push(`ffmpeg -i "${file}" -ss ${timeOffset} -vframes 1 -q:v 2 "${outputPath}"`);
	});

	lines.push('');
	lines.push('echo "Thumbnail extraction complete!"');

	return lines.join('\n');
}

/**
 * Generate GIF creation batch script
 */
export function generateGifBatch(
	inputFiles: string[],
	outputDirectory: string,
	options: {
		startTime?: number;
		duration?: number;
		width?: number;
		fps?: number;
	} = {},
): string {
	const {
		startTime = 0,
		duration = 5,
		width = 480,
		fps = 10,
	} = options;

	const lines: string[] = [];

	lines.push('#!/bin/bash');
	lines.push('# GIF Creation Script');
	lines.push(`# Creating GIFs from ${inputFiles.length} videos`);
	lines.push('');
	lines.push(`mkdir -p "${outputDirectory}"`);
	lines.push('');

	inputFiles.forEach((file, index) => {
		const baseName = file.split('/').pop()?.replace(/\.[^.]+$/, '') || `video_${index}`;
		const outputPath = `${outputDirectory}/${baseName}.gif`;
		const palettePath = `${outputDirectory}/${baseName}_palette.png`;

		// Two-pass GIF creation for better quality
		lines.push(`echo "Creating GIF ${index + 1}/${inputFiles.length}"`);
		lines.push(`ffmpeg -ss ${startTime} -t ${duration} -i "${file}" -vf "fps=${fps},scale=${width}:-1:flags=lanczos,palettegen" -y "${palettePath}"`);
		lines.push(`ffmpeg -ss ${startTime} -t ${duration} -i "${file}" -i "${palettePath}" -filter_complex "[0:v]fps=${fps},scale=${width}:-1:flags=lanczos[v];[v][1:v]paletteuse" -y "${outputPath}"`);
		lines.push(`rm "${palettePath}"`);
		lines.push('');
	});

	lines.push('echo "GIF creation complete!"');

	return lines.join('\n');
}
