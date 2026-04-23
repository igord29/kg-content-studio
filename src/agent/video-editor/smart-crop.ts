/**
 * Smart Aspect Ratio Crop
 *
 * Given a source video's dimensions, a target aspect ratio, and where the
 * subject is in the source frame (from GPT-4o vision catalog), compute the
 * scale + crop filter needed to fill the target without losing the subject.
 *
 * Used by the FFmpeg preprocess pipeline (both local preprocess.ts and
 * remotion/preprocessor-lambda.ts) so Remotion Lambda receives clips that
 * are already correctly framed for each platform's aspect ratio.
 *
 * File: src/agent/video-editor/smart-crop.ts
 */

export type SubjectPosition =
	| 'center'
	| 'left'
	| 'right'
	| 'top-center'
	| 'bottom-center'
	| 'bottom-left'
	| 'bottom-right'
	| 'top-left'
	| 'top-right';

export type TargetAspect = '9:16' | '1:1' | '4:5' | '16:9';

export interface CropSpec {
	scaleW: number;     // intermediate scaled width
	scaleH: number;     // intermediate scaled height
	cropW: number;      // crop window width (= targetW)
	cropH: number;      // crop window height (= targetH)
	cropX: number;      // top-left x of crop window within scaled frame
	cropY: number;      // top-left y of crop window within scaled frame
	noCropNeeded: boolean; // true if source aspect already matches target
}

/**
 * Subject positions mapped to normalized coordinates (0-1) representing
 * where the subject's center sits in the source frame.
 *
 * These use rule-of-thirds offsets (0.33 / 0.67) rather than hugging edges
 * (0.0 / 1.0). Sports + documentary best practice: keep some breathing room
 * between the subject and the frame edge, so the crop feels intentional
 * rather than chopped.
 *
 * Specifically for CLC tennis content:
 *   - "bottom-center" = player at baseline on court (common for serves)
 *     → y=0.67 means player sits ~2/3 down, court stays visible above
 *   - "left"/"right" = player on one side of a doubles court or rally
 *     → x=0.33 or 0.67 keeps them composed, not flush against the edge
 *   - "center" = default / safest when vision isn't sure
 */
const POSITION_MAP: Record<SubjectPosition, { x: number; y: number }> = {
	'center':        { x: 0.50, y: 0.50 },
	'left':          { x: 0.33, y: 0.50 },
	'right':         { x: 0.67, y: 0.50 },
	'top-center':    { x: 0.50, y: 0.33 },
	'bottom-center': { x: 0.50, y: 0.67 },
	'top-left':      { x: 0.33, y: 0.33 },
	'top-right':     { x: 0.67, y: 0.33 },
	'bottom-left':   { x: 0.33, y: 0.67 },
	'bottom-right':  { x: 0.67, y: 0.67 },
};

const ASPECT_MAP: Record<TargetAspect, { w: number; h: number }> = {
	'9:16': { w: 1080, h: 1920 },
	'1:1':  { w: 1080, h: 1080 },
	'4:5':  { w: 1080, h: 1350 },
	'16:9': { w: 1920, h: 1080 },
};

/**
 * Normalize a subject position string (possibly with unexpected input) to
 * a safe SubjectPosition. Unknown values fall back to 'center'.
 */
function normalizeSubjectPosition(input: string | undefined | null): SubjectPosition {
	if (!input) return 'center';
	const cleaned = input.toLowerCase().trim() as SubjectPosition;
	return cleaned in POSITION_MAP ? cleaned : 'center';
}

/**
 * Round to even number (H.264 encoding requires even width/height).
 */
function roundEven(n: number): number {
	const r = Math.round(n);
	return r % 2 === 0 ? r : r + 1;
}

/**
 * Compute the scale + crop spec needed to convert source dimensions into
 * target dimensions while keeping the subject centered in the output frame.
 *
 * Strategy:
 *   1. Compute the scale factor K that satisfies three constraints:
 *        a. scaledW >= targetW (horizontal content fills the frame)
 *        b. scaledH >= targetH (vertical content fills the frame)
 *        c. There is enough room on BOTH axes to place the subject's
 *           normalized position at the center of the output window.
 *      Constraint (c) is the one the old implementation ignored — it only
 *      solved (a)+(b), which left subjects stranded wherever they happened
 *      to be in the source frame. For e.g. a 16:9 → 9:16 conversion with
 *      subject at y=0.67 (bottom of source), constraint (a)+(b) alone sets
 *      scaleH = targetH exactly, leaving zero vertical slack — so the crop
 *      window can't slide down and the subject ends up in the lower third
 *      of the output rather than dead-center. Solving (c) forces K high
 *      enough that the subject lands at output-center.
 *   2. Extra zoom (`extraZoom > 1.0`) multiplies on top of constraint (a)+(b)
 *      to pull the subject larger in the final frame — useful for content
 *      types like wide tennis court shots where a modest zoom keeps the
 *      player visible without too much empty court.
 *   3. Clamp cropX/cropY to scaled-frame bounds as a safety net — off-normal
 *      subjectPositions (extreme 0.0 / 1.0 values) would otherwise drive
 *      the crop origin out of bounds and produce black bars.
 */
export function computeCrop(
	sourceW: number,
	sourceH: number,
	targetAspect: TargetAspect,
	subjectPosition: string | undefined | null,
	extraZoom: number = 1.0,
): CropSpec {
	const target = ASPECT_MAP[targetAspect];
	const targetW = target.w;
	const targetH = target.h;

	const sourceAR = sourceW / sourceH;
	const targetAR = targetW / targetH;

	// Already the correct aspect ratio — just scale, no crop.
	// Still honor extraZoom so aspect-matched sources can still zoom in.
	if (Math.abs(sourceAR - targetAR) < 0.01 && extraZoom <= 1.001) {
		return {
			scaleW: targetW,
			scaleH: targetH,
			cropW: targetW,
			cropH: targetH,
			cropX: 0,
			cropY: 0,
			noCropNeeded: true,
		};
	}

	const pos = POSITION_MAP[normalizeSubjectPosition(subjectPosition)];

	// --- Scale factor K resolves three constraints simultaneously ---
	// (a) Fill horizontally: K_fillX = targetW / sourceW
	// (b) Fill vertically:   K_fillY = targetH / sourceH
	// (c) Center subject on X: K_centerX = targetW / (2 * min(pos.x, 1-pos.x) * sourceW)
	//     Center subject on Y: K_centerY = targetH / (2 * min(pos.y, 1-pos.y) * sourceH)
	//
	// min(pos, 1-pos) floored at 0.1 avoids division explosion for extreme
	// subjectPositions like 'top-left' (pos.y=0.33 → min=0.33 fine, but a
	// hypothetical pos=0.95 would demand K=10× which is absurd).
	const kFillX = targetW / sourceW;
	const kFillY = targetH / sourceH;
	const marginX = Math.max(0.1, Math.min(pos.x, 1 - pos.x));
	const marginY = Math.max(0.1, Math.min(pos.y, 1 - pos.y));
	const kCenterX = targetW / (2 * marginX * sourceW);
	const kCenterY = targetH / (2 * marginY * sourceH);

	// Base minimum scale: max of fill constraints (this is what the old algo used).
	const kFill = Math.max(kFillX, kFillY);
	// Apply extraZoom to the fill baseline — this tightens the frame on the subject.
	const kZoomed = kFill * Math.max(1.0, extraZoom);
	// Final K must also satisfy the subject-centering constraints.
	const K = Math.max(kZoomed, kCenterX, kCenterY);

	const scaleW = roundEven(sourceW * K);
	const scaleH = roundEven(sourceH * K);

	// Position the crop window so the subject's point sits at the window's center.
	let cropX = roundEven(pos.x * scaleW - targetW / 2);
	let cropY = roundEven(pos.y * scaleH - targetH / 2);

	// Clamp to scaled frame bounds.
	cropX = Math.max(0, Math.min(cropX, scaleW - targetW));
	cropY = Math.max(0, Math.min(cropY, scaleH - targetH));

	return {
		scaleW,
		scaleH,
		cropW: targetW,
		cropH: targetH,
		cropX,
		cropY,
		noCropNeeded: false,
	};
}

/**
 * Build an FFmpeg filter chain that performs the smart crop.
 * Returns a comma-separated filter string ready to be combined with
 * other filters (deshake, unsharp, setpts).
 *
 * Example output for 16:9 source → 9:16 target, subject bottom-center, extraZoom=1.3:
 *   "scale=6720:3780,crop=1080:1920:2820:1260"
 *
 * @param extraZoom - Optional zoom multiplier applied on top of the minimum
 *   fill scale. >1.0 tightens the frame on the subject. Use ~1.25-1.4 for
 *   wide tennis action to make players more prominent; keep at 1.0 for
 *   interview / chess / establishing shots where context matters.
 */
export function buildCropFilter(
	sourceW: number,
	sourceH: number,
	targetAspect: TargetAspect,
	subjectPosition: string | undefined | null,
	extraZoom: number = 1.0,
): string {
	const spec = computeCrop(sourceW, sourceH, targetAspect, subjectPosition, extraZoom);

	if (spec.noCropNeeded) {
		return `scale=${spec.scaleW}:${spec.scaleH}`;
	}

	return `scale=${spec.scaleW}:${spec.scaleH},crop=${spec.cropW}:${spec.cropH}:${spec.cropX}:${spec.cropY}`;
}
