/**
 * API routes for agents
 */

import { createRouter, validator } from '@agentuity/runtime';
import translate, { AgentOutput, type HistoryEntry } from '../agent/translate';
import manager from '../agent/manager';
import contentCreator from '../agent/content-creator';

const api = createRouter();

// State subset for history endpoints (derived from AgentOutput)
export const StateSchema = AgentOutput.pick(['history', 'threadId', 'translationCount']);

// Translation agent
api.post('/translate', translate.validator(), async (c) => {
	const data = c.req.valid('json');
	return c.json(await translate.run(data));
});

// Retrieve translation history
api.get('/translate/history', validator({ output: StateSchema }), async (c) => {
	const history = (await c.var.thread.state.get<HistoryEntry[]>('history')) ?? [];
	return c.json({
		history,
		threadId: c.var.thread.id,
		translationCount: history.length,
	});
});

// Clear translation history
api.delete('/translate/history', validator({ output: StateSchema }), async (c) => {
	await c.var.thread.state.delete('history');
	return c.json({
		history: [],
		threadId: c.var.thread.id,
		translationCount: 0,
	});
});

// Manager agent
api.post('/manager', manager.validator(), async (c) => {
	const data = c.req.valid('json');
	return c.json(await manager.run(data));
});

// Content creator agent
api.post('/content-creator', contentCreator.validator(), async (c) => {
	const data = c.req.valid('json');
	return c.json(await contentCreator.run(data));
});

export default api;