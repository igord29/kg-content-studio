import { createAgent } from '@agentuity/runtime';
import { s } from '@agentuity/schema';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { systemPrompt } from './kimberly-voice';

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
		
		const { text } = await generateText({
			model: openai('gpt-4o-mini'),
			system: systemPrompt,
			prompt: `Write a ${platform} post about: ${topic}`,
		});
		
		return {
			content: text,
			platform,
		};
	}
});

export default agent;
