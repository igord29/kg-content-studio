import { createAgent } from '@agentuity/runtime';
import { s } from '@agentuity/schema';
import OpenAI from 'openai';
import { systemPrompt } from './kimberly-voice';

const client = new OpenAI();

const AgentInput = s.object({
	topic: s.string(),
	platform: s.string().optional(),
});

const AgentOutput = s.object({
	content: s.string(),
	platform: s.string(),
});

const agent = createAgent('content-creator', {
	description: 'Creates social media content',
	schema: {
		input: AgentInput,
		output: AgentOutput,
	},
	handler: async (ctx, { topic, platform = 'Instagram' }) => {
		ctx.logger.info('Creating content for: %s on %s', topic, platform);
		
		const completion = await client.chat.completions.create({
			model: 'gpt-4o-mini',
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: `Write a ${platform} post about: ${topic}` },
			],
		});
		
		const content = completion.choices[0]?.message?.content || '';
		
		return {
			content,
			platform,
		};
	}
});

export default agent;
