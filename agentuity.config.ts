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
	 *
	 * @remotion/lambda is externalized so its subpath import '@remotion/lambda/client'
	 * (used by render.ts for renderMediaOnLambda/getRenderProgress) is loaded from
	 * node_modules at runtime instead of being bundled. The /client subpath is lightweight
	 * and zero-dep. Heavy packages (@remotion/renderer, etc.) are only used locally.
	 */
	build: {
		external: [
			'@remotion/lambda',
			'@aws-sdk/client-s3',
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
