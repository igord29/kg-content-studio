import { createAgent } from '@agentuity/runtime';
import { s } from '@agentuity/schema';
import contentCreator from '../content-creator';

const AgentInput = s.object({
	topic: s.string(),
	description: s.string().optional(),
});

const AgentOutput = s.object({
	intent: s.string(),
	message: s.string(),
	routed_to: s.string(),
	result: s.any().optional(),
});

const agent = createAgent('manager', {
	description: 'Routes content marketing requests to appropriate agents',
	schema: {
		input: AgentInput,
		output: AgentOutput,
	},
	handler: async (ctx, { topic, description }) => {
		ctx.logger.info('Manager analyzing: %s', topic);
		
		const text = `${topic} ${description || ''}`.toLowerCase();
		
		let intent = 'unknown';
		let routed_to = 'none';
		let result = null;
		
		if (text.includes('grant') || text.includes('funding')) {
			intent = 'grant';
			routed_to = 'grant-writer';
		} else if (text.includes('donor') || text.includes('sponsor')) {
			intent = 'donor';
			routed_to = 'donor-researcher';
		} else if (text.includes('venue') || text.includes('court')) {
			intent = 'venue';
			routed_to = 'venue-prospector';
	} else if (text.includes('social') || text.includes('post') || text.includes('content') || 
	           text.includes('tennis') || text.includes('chess') || text.includes('program') ||
	           text.includes('student') || text.includes('kid') || text.includes('mentor') ||
	           text.includes('story') || text.includes('share') || text.includes('success')) {
		intent = 'content';
		routed_to = 'content-creator';
		
		// Actually CALL the content creator!
		ctx.logger.info('Routing to content-creator...');
		result = await contentCreator.run({ topic, platform: 'Instagram' });
	}
		
		return {
			intent,
			message: `Detected: ${intent}. Routed to: ${routed_to}`,
			routed_to,
			result,
		};
	}
});

export default agent;