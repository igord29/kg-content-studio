/**
 * Shared types for Remotion compositions
 *
 * These bridge the gap between the existing RenderConfig (Shotstack-oriented, seconds-based)
 * and Remotion's frame-based rendering system.
 */

export interface CLCVideoProps {
	clips: Array<{
		src: string;             // local file path (from preprocessing)
		length: number;          // effective duration in seconds
		effect?: string;         // 'zoomIn' | 'zoomOut' | 'slideRight' | 'slideLeft'
		filter?: string;         // 'boost' | undefined
		transitionType?: string; // mapped from Shotstack: 'fade' | 'slide' | 'wipe' | 'clockWipe'
		transitionDirection?: string; // 'from-left' | 'from-right' | 'from-top' | 'from-bottom'
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
	}>;
	musicSrc?: string | null;
	musicVolume?: number;
	bgColor: string;
	transitionDurationFrames: number;
}
