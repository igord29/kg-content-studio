/**
 * remapSpeed — variable playback speed within a single clip.
 * Adapted from remotion-dev/timing-functions.
 *
 * Given a frame number and a speed function, returns the remapped frame
 * position. This enables slow-motion on high-scored moments and speed-up
 * on filler within the same clip.
 *
 * Usage:
 *   const remappedFrame = remapSpeed(frame, (f) => {
 *     // Slow-mo between frames 30-60, normal speed elsewhere
 *     if (f >= 30 && f <= 60) return 0.5;
 *     return 1;
 *   });
 */
export const remapSpeed = (frame: number, speed: (fr: number) => number): number => {
	let framesPassed = 0;
	for (let i = 0; i <= frame; i++) {
		framesPassed += speed(i);
	}
	return framesPassed;
};
