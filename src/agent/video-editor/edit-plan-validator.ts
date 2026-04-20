/**
 * Edit Plan Validator
 *
 * Validates generated edit plans before rendering to catch errors
 * that would waste render credits or produce bad output. Inspired by
 * HyperFrames' pre-render linting pattern.
 *
 * Runs automatically after edit plan generation and auto-fixes
 * trivial issues (duration overflow, clamping) while flagging
 * unfixable issues as warnings.
 *
 * File: src/agent/video-editor/edit-plan-validator.ts
 */

import type { CatalogEntry } from './google-drive';

// --- Types ---

export interface ValidationIssue {
	severity: 'error' | 'warning';
	category: 'duration' | 'overlap' | 'cut-safety' | 'action-alignment' | 'file-id' | 'overlay' | 'gap';
	clipIndex?: number;
	message: string;
	autoFixed?: boolean;
	fixDescription?: string;
}

export interface ValidationResult {
	valid: boolean;               // no errors (warnings are OK)
	errors: ValidationIssue[];    // must fix before render
	warnings: ValidationIssue[];  // should review but won't block render
	autoFixCount: number;         // number of issues automatically corrected
}

interface EditPlanClip {
	fileId: string;
	filename?: string;
	trimStart: number;
	duration: number;
	purpose?: string;
	segment?: string;
	editNote?: string;
	speed?: number;
}

interface EditPlanOverlay {
	text: string;
	start: number;
	duration: number;
	position?: string;
}

interface EditPlanData {
	mode?: string;
	clips: EditPlanClip[];
	textOverlays?: EditPlanOverlay[];
	totalDuration?: number;
	transitions?: string;
	musicTier?: number;
	musicDirection?: string;
}

// --- Validation ---

/**
 * Validate an edit plan against catalog data and editorial rules.
 * Auto-fixes trivial issues and returns errors/warnings for the rest.
 */
export function validateEditPlan(
	editPlan: EditPlanData,
	catalogMap: Map<string, CatalogEntry>,
): ValidationResult {
	const errors: ValidationIssue[] = [];
	const warnings: ValidationIssue[] = [];
	let autoFixCount = 0;

	if (!editPlan.clips || editPlan.clips.length === 0) {
		errors.push({
			severity: 'error',
			category: 'duration',
			message: 'Edit plan has no clips',
		});
		return { valid: false, errors, warnings, autoFixCount };
	}

	// --- Rule 1: File ID validation ---
	for (let i = 0; i < editPlan.clips.length; i++) {
		const clip = editPlan.clips[i]!;
		if (!catalogMap.has(clip.fileId)) {
			// Try to match by filename
			let matched = false;
			if (clip.filename) {
				for (const [fid, entry] of catalogMap) {
					if (entry.filename === clip.filename) {
						warnings.push({
							severity: 'warning',
							category: 'file-id',
							clipIndex: i,
							message: `Clip ${i + 1}: fileId "${clip.fileId.slice(0, 12)}..." not in catalog, auto-corrected via filename match "${clip.filename}"`,
							autoFixed: true,
							fixDescription: `Changed fileId to ${fid}`,
						});
						clip.fileId = fid;
						matched = true;
						autoFixCount++;
						break;
					}
				}
			}
			if (!matched) {
				errors.push({
					severity: 'error',
					category: 'file-id',
					clipIndex: i,
					message: `Clip ${i + 1}: fileId "${clip.fileId.slice(0, 12)}..." not found in catalog${clip.filename ? ` (filename: ${clip.filename})` : ''}`,
				});
			}
		}
	}

	// --- Rule 2: Duration bounds ---
	for (let i = 0; i < editPlan.clips.length; i++) {
		const clip = editPlan.clips[i]!;
		const entry = catalogMap.get(clip.fileId);
		if (!entry?.duration) continue;

		const sourceDuration = parseFloat(entry.duration.replace(/s$/, '')) || 0;
		if (sourceDuration <= 0) continue;

		if (clip.trimStart < 0) {
			clip.trimStart = 0;
			warnings.push({
				severity: 'warning',
				category: 'duration',
				clipIndex: i,
				message: `Clip ${i + 1}: negative trimStart auto-corrected to 0`,
				autoFixed: true,
				fixDescription: 'Set trimStart to 0',
			});
			autoFixCount++;
		}

		// Check trimStart beyond source BEFORE attempting duration clamp
		if (clip.trimStart >= sourceDuration) {
			errors.push({
				severity: 'error',
				category: 'duration',
				clipIndex: i,
				message: `Clip ${i + 1}: trimStart(${clip.trimStart}s) is beyond source video duration (${sourceDuration}s)`,
			});
			continue; // skip duration clamp — trimStart itself is invalid
		}

		// Auto-fix: clamp duration to fit within source (only if trimStart is valid)
		const clipEnd = clip.trimStart + clip.duration;
		if (clipEnd > sourceDuration) {
			const oldDuration = clip.duration;
			clip.duration = Math.max(1, sourceDuration - clip.trimStart);
			warnings.push({
				severity: 'warning',
				category: 'duration',
				clipIndex: i,
				message: `Clip ${i + 1}: trimStart(${clip.trimStart}) + duration(${oldDuration}) = ${clipEnd}s exceeds source duration ${sourceDuration}s`,
				autoFixed: true,
				fixDescription: `Clamped duration to ${clip.duration}s`,
			});
			autoFixCount++;
		}
	}

	// --- Rule 3: Minimum gap between same-source clips ---
	const clipsByFileId = new Map<string, Array<{ index: number; trimStart: number; duration: number }>>();
	for (let i = 0; i < editPlan.clips.length; i++) {
		const clip = editPlan.clips[i]!;
		const existing = clipsByFileId.get(clip.fileId) || [];
		existing.push({ index: i, trimStart: clip.trimStart, duration: clip.duration });
		clipsByFileId.set(clip.fileId, existing);
	}

	for (const [fileId, clips] of clipsByFileId) {
		if (clips.length <= 1) continue;
		const sorted = [...clips].sort((a, b) => a.trimStart - b.trimStart);
		for (let j = 0; j < sorted.length - 1; j++) {
			const current = sorted[j]!;
			const next = sorted[j + 1]!;
			const gap = next.trimStart - (current.trimStart + current.duration);
			if (gap < 3) {
				// Under 3 seconds overlap/gap is a real problem
				const entry = catalogMap.get(fileId);
				const fname = entry?.filename || fileId.slice(0, 12);
				if (gap < 0) {
					errors.push({
						severity: 'error',
						category: 'overlap',
						clipIndex: next.index,
						message: `Clips ${current.index + 1} & ${next.index + 1} from "${fname}" overlap by ${Math.abs(gap).toFixed(1)}s (trimStart ${current.trimStart}+${current.duration} vs ${next.trimStart})`,
					});
				} else {
					warnings.push({
						severity: 'warning',
						category: 'gap',
						clipIndex: next.index,
						message: `Clips ${current.index + 1} & ${next.index + 1} from "${fname}" are only ${gap.toFixed(1)}s apart — may show same scene. Recommend 15s+ gap.`,
					});
				}
			}
		}
	}

	// --- Rule 4: Action alignment (when visual timeline exists) ---
	for (let i = 0; i < editPlan.clips.length; i++) {
		const clip = editPlan.clips[i]!;
		const entry = catalogMap.get(clip.fileId);
		if (!entry?.visualTimeline || entry.visualTimeline.actionWindows.length === 0) continue;

		const purpose = (clip.purpose || '').toLowerCase();
		const isActionClip = purpose.includes('hook') || purpose.includes('peak') || purpose.includes('build') || purpose.includes('action');

		if (isActionClip) {
			// Check if trimStart falls within any action window
			const inActionWindow = entry.visualTimeline.actionWindows.some(
				w => clip.trimStart >= w.start - 1 && clip.trimStart <= w.end + 1,
			);
			if (!inActionWindow) {
				// Find nearest action window
				const nearest = entry.visualTimeline.actionWindows
					.map(w => ({
						window: w,
						distance: Math.min(Math.abs(clip.trimStart - w.start), Math.abs(clip.trimStart - w.end)),
					}))
					.sort((a, b) => a.distance - b.distance)[0];

				if (nearest) {
					warnings.push({
						severity: 'warning',
						category: 'action-alignment',
						clipIndex: i,
						message: `Clip ${i + 1} (${purpose.slice(0, 40)}): trimStart ${clip.trimStart}s is outside all action windows. Nearest action: ${nearest.window.start}-${nearest.window.end}s (${nearest.window.type}). Consider using trimStart=${nearest.window.start}s instead.`,
					});
				}
			}
		}
	}

	// --- Rule 5: Cut safety (when named segments exist) ---
	for (let i = 0; i < editPlan.clips.length; i++) {
		const clip = editPlan.clips[i]!;
		if (!clip.segment) continue;

		const entry = catalogMap.get(clip.fileId);
		const segments = entry?.sceneAnalysis?.namedSegments;
		if (!segments) continue;

		const segment = segments.find(s => s.id === clip.segment);
		if (!segment) {
			warnings.push({
				severity: 'warning',
				category: 'cut-safety',
				clipIndex: i,
				message: `Clip ${i + 1}: references segment "${clip.segment}" which doesn't exist in scene analysis`,
			});
			continue;
		}

		// Check entry point
		if (clip.trimStart < segment.cutSafety.bestEntryPoint - 0.5) {
			warnings.push({
				severity: 'warning',
				category: 'cut-safety',
				clipIndex: i,
				message: `Clip ${i + 1}: trimStart ${clip.trimStart}s is before segment ${clip.segment}'s safe entry point (${segment.cutSafety.bestEntryPoint}s). ${segment.cutSafety.reason}`,
			});
		}

		// Check exit point
		const clipEnd = clip.trimStart + clip.duration;
		if (clipEnd > segment.cutSafety.bestExitPoint + 0.5) {
			warnings.push({
				severity: 'warning',
				category: 'cut-safety',
				clipIndex: i,
				message: `Clip ${i + 1}: end ${clipEnd}s extends past segment ${clip.segment}'s safe exit point (${segment.cutSafety.bestExitPoint}s). ${segment.cutSafety.reason}`,
			});
		}
	}

	// --- Rule 6: Text overlay bounds ---
	if (editPlan.textOverlays && editPlan.totalDuration) {
		for (let i = 0; i < editPlan.textOverlays.length; i++) {
			const overlay = editPlan.textOverlays[i]!;
			const overlayEnd = overlay.start + overlay.duration;
			if (overlayEnd > editPlan.totalDuration + 1) {
				const oldDuration = overlay.duration;
				overlay.duration = Math.max(0.5, editPlan.totalDuration - overlay.start);
				warnings.push({
					severity: 'warning',
					category: 'overlay',
					message: `Text overlay ${i + 1} ("${overlay.text.slice(0, 30)}..."): extends to ${overlayEnd}s past total duration ${editPlan.totalDuration}s`,
					autoFixed: true,
					fixDescription: `Clamped duration from ${oldDuration}s to ${overlay.duration}s`,
				});
				autoFixCount++;
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
		autoFixCount,
	};
}

/**
 * Format validation results for logging or display.
 */
export function formatValidationResult(result: ValidationResult): string {
	const lines: string[] = [];

	if (result.valid) {
		lines.push(`Edit plan validation: PASSED (${result.warnings.length} warnings, ${result.autoFixCount} auto-fixed)`);
	} else {
		lines.push(`Edit plan validation: FAILED (${result.errors.length} errors, ${result.warnings.length} warnings)`);
	}

	for (const err of result.errors) {
		lines.push(`  ERROR [${err.category}]: ${err.message}`);
	}
	for (const warn of result.warnings) {
		const fixNote = warn.autoFixed ? ` (auto-fixed: ${warn.fixDescription})` : '';
		lines.push(`  WARN [${warn.category}]: ${warn.message}${fixNote}`);
	}

	return lines.join('\n');
}
