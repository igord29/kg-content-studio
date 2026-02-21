/**
 * Agentuity Configuration
 *
 */

import type { AgentuityConfig } from '@agentuity/cli';
import tailwindcss from '@tailwindcss/vite';

export default {
	/**
	 * Workbench (development only)
	 *
	 * Visual UI for testing agents during development. Not included in production builds.
	 * Omit this section to disable. Access at http://localhost:3500/workbench
	 */
	workbench: {
		route: '/workbench',
		headers: {},
	},

	/**
	 * Build Configuration
	 *
	 * external: packages excluded from the server bundle, loaded from node_modules at runtime.
	 * Remotion packages include browser-only deps (@remotion/studio → @remotion/web-renderer)
	 * that can't be bundled. They're dynamically imported at runtime only when needed.
	 */
	build: {
		external: [
			'remotion',
			'@remotion/renderer',
			'@remotion/bundler',
			'@remotion/transitions',
			'@remotion/media-utils',
			'@remotion/studio',
			'@remotion/web-renderer',
		],
	},

	/**
	 * Vite Plugins
	 *
	 * Custom Vite plugins for the client build (src/web/).
	 * Added after built-in plugins: React, browserEnvPlugin, patchPlugin
	 *
	 * Example (Tailwind CSS):
	 *   bun add -d tailwindcss @tailwindcss/vite
	 *   import tailwindcss from '@tailwindcss/vite';
	 *   plugins: [tailwindcss()]
	 *
	 * @see https://vitejs.dev/plugins/
	 */
	plugins: tailwindcss(),
} as AgentuityConfig;
