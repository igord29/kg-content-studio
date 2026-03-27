/**
 * Shared types for Remotion compositions
 *
 * These bridge the gap between the existing RenderConfig (Shotstack-oriented, seconds-based)
 * and Remotion's frame-based rendering system.
 */

/** Color grading profiles — CSS filter presets keyed by name */
export type ColorGrade = 'boost' | 'cinematic' | 'warm' | 'dramatic' | 'documentary' | 'vintage' | 'cool';

/** Speed keyframe — defines a speed change at a specific point within a clip */
export interface SpeedKeyframe {
	/** Progress through the clip (0.0 = start, 1.0 = end) */
	at: number;
	/** Playback speed multiplier (0.3 = slow-mo, 1.0 = normal, 2.0 = fast) */
	speed: number;
}

/** Text animation style */
export type TextAnimation = 'fade' | 'slideUp' | 'slideDown' | 'scaleUp' | 'bounce' | 'typewriter';

export interface CLCVideoProps {
	clips: Array<{
		src: string;             // proxy URL (Drive or preprocessed file)
		length: number;          // effective duration in seconds
		trimStart?: number;      // start offset in seconds (for raw clips, skip this many seconds)
		effect?: string;         // 'zoomIn' | 'zoomOut' | 'slideRight' | 'slideLeft'
		filter?: string;         // color grade: 'boost' | 'cinematic' | 'warm' | 'dramatic' | 'documentary' | 'vintage' | 'cool'
		transitionType?: string; // mapped from Shotstack: 'fade' | 'slide' | 'wipe' | 'clockWipe'
		transitionDirection?: string; // 'from-left' | 'from-right' | 'from-top' | 'from-bottom'
		speedKeyframes?: SpeedKeyframe[]; // optional in-clip speed ramps
	}>;
	mode: string;              // 'game_day' | 'our_story' | 'quick_hit' | 'showcase'
	width: number;
	height: number;
	fps: number;
	textOverlays: Array<{
		text: string;
		startFrame: number;
		durationFrames: number;
		position: 'top' | 'center' | 'bottom';
		isFirst: boolean;
		isLast: boolean;
		animation?: TextAnimation; // entry/exit animation style
	}>;
	musicSrc?: string | null;
	musicVolume?: number;
	bgColor: string;
	transitionDurationFrames: number;
}
