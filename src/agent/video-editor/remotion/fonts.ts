/**
 * Font loading for the CLC compositions.
 *
 * TextOverlay.tsx asks for `'Montserrat', sans-serif` at weights 400, 500, 600,
 * 800 and 900, and CLCVideo/TikTokCaptions/TransitionShowcase ask for it too --
 * but nothing ever loaded the family. Lambda's headless Chromium has no
 * Montserrat installed, so every render silently substituted the default
 * sans-serif. The weight and letter-spacing work in TextOverlay was being
 * thrown away, and 800/900 came out as faux-bold or plain.
 *
 * Self-hosted via @fontsource rather than @remotion/google-fonts on purpose:
 * fontsource ships the .woff2 files inside node_modules, so the bundler inlines
 * them and the render makes ZERO network requests for type. A renderer that
 * fetches fonts.gstatic.com per render is both slow and a hard failure when the
 * Lambda has no outbound route -- it throws rather than falling back.
 *
 * Declaring the @font-face is not enough on its own. Remotion captures frames as
 * fast as it can, so without delayRender the first frames render in the fallback
 * face and the video visibly changes typeface partway through. document.fonts
 * .load() forces the actual download, and only then do we release the render.
 *
 * File: src/agent/video-editor/remotion/fonts.ts
 */

import { continueRender, delayRender } from 'remotion';

import '@fontsource/montserrat/400.css';
import '@fontsource/montserrat/500.css';
import '@fontsource/montserrat/600.css';
import '@fontsource/montserrat/800.css';
import '@fontsource/montserrat/900.css';

/** Every weight referenced by the compositions. Keep in sync with TextOverlay. */
export const MONTSERRAT_WEIGHTS = [400, 500, 600, 800, 900] as const;

export const FONT_FAMILY = "'Montserrat', sans-serif";

let started = false;

/**
 * Block the render until Montserrat is actually usable.
 *
 * Idempotent, and safe to call from module scope. Failures continue the render
 * rather than hanging it -- a video in the fallback face beats no video, and the
 * warning says which happened.
 */
export function ensureFontsLoaded(): void {
	if (started) return;
	started = true;

	// Guard for any non-browser context the bundle might be evaluated in.
	if (typeof document === 'undefined' || !('fonts' in document)) return;

	const handle = delayRender('Loading Montserrat');

	Promise.all(
		MONTSERRAT_WEIGHTS.map(weight => document.fonts.load(`${weight} 1em Montserrat`)),
	)
		.then(() => {
			continueRender(handle);
		})
		.catch((err: unknown) => {
			// Don't strand the render on a font problem.
			// eslint-disable-next-line no-console
			console.warn('[fonts] Montserrat failed to load, falling back to sans-serif:', err);
			continueRender(handle);
		});
}
