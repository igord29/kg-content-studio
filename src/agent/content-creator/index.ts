import { createAgent } from '@agentuity/runtime';
import { s } from '@agentuity/schema';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import OpenAI from 'openai';
import { systemPrompt } from './kimberly-voice';
import { getAgentStyleRecommendations, getStyleById } from './style-library';

const openaiClient = new OpenAI();

// --- Platform-aware image size mappings (gpt-image-1.5 supported sizes) ---
const PLATFORM_IMAGE_SIZE: Record<string, '1024x1024' | '1536x1024' | '1024x1536'> = {
	Instagram: '1024x1024',     // Square posts
	TikTok: '1024x1536',       // Vertical 2:3 (closest to 9:16)
	YouTube: '1536x1024',      // Landscape 3:2
	Facebook: '1024x1024',     // Square for feed
	LinkedIn: '1536x1024',     // Landscape for professional posts
	Twitter: '1536x1024',      // Landscape for timeline
	Blog: '1536x1024',         // Landscape header images
	Newsletter: '1536x1024',   // Landscape email headers
};

// Quality settings per style type — photorealistic styles benefit from high quality
const STYLE_QUALITY: Record<string, 'low' | 'high'> = {
	photorealism: 'high',
	'surrealist-abstraction': 'high',
	'pop-surrealism': 'high',
	// All others default to 'low' for faster generation
};

const AgentInput = s.object({
	topic: s.string(),
	platform: s.string().optional(),
	includeImage: s.boolean().optional(),
	imageMode: s.string().optional(), // 'agent-pick' | 'user-pick'
	selectedStyles: s.array(s.string()).optional(), // style IDs for user-pick mode
	variationCount: s.number().optional(), // 1-3 for user-pick mode
});

const AgentOutput = s.object({
	content: s.string(),
	platform: s.string(),
	imageUrl: s.string().optional(),
	imagePrompt: s.string().optional(),
	images: s.array(s.object({
		styleId: s.string(),
		styleName: s.string(),
		imageUrl: s.string(),
		imagePrompt: s.string(),
		reason: s.string(),
	})).optional(),
	agentRecommendations: s.array(s.object({
		styleId: s.string(),
		styleName: s.string(),
		reason: s.string(),
	})).optional(),
});

// ---------------------------------------------------------------------------
// STRUCTURED PROMPT BUILDER
// ---------------------------------------------------------------------------
// Parses the structured topic string from the frontend (key: value pairs)
// and builds a rich, contextual generation prompt that gives the AI real
// material to work with — instead of a one-liner that produces generic output.
// ---------------------------------------------------------------------------

function buildGenerationPrompt(topic: string, platform: string): string {
	// Parse key-value pairs from "topic: X. audience: Y. cta: Z." format
	const parsed: Record<string, string> = {};

	// Split on ". " followed by a key: pattern (but not periods inside values)
	const parts = topic.split(/\.\s*(?=[a-zA-Z_]+\s*:)/);
	for (const part of parts) {
		const match = part.match(/^([a-zA-Z_]+)\s*:\s*(.+)/s);
		if (match) {
			parsed[match[1]!.toLowerCase().trim()] = match[2]!.trim().replace(/\.$/, '');
		}
	}

	// If parsing failed (plain text topic), use the whole string
	const rawTopic = parsed['topic'] || topic;
	const audience = parsed['audience'] || '';
	const cta = parsed['cta'] || '';
	const details = parsed['details'] || '';
	const feeling = parsed['feeling'] || '';
	const moment = parsed['moment'] || '';
	const hook = parsed['hook'] || '';
	const style = parsed['style'] || '';
	const conversationNotes = parsed['conversation'] || '';

	// Build sections — only include what we have
	const sections: string[] = [];

	sections.push(`## WHAT THIS IS ABOUT\n${rawTopic}`);

	if (audience) {
		sections.push(`## WHO YOU'RE TALKING TO\n${audience}. Write directly to them — not about them. They're already in the circle.`);
	}

	if (moment) {
		sections.push(`## THE SPECIFIC MOMENT\nUse this real moment as the anchor:\n${moment}\nBuild the post around this — don't invent a different story.`);
	}

	if (hook) {
		sections.push(`## THE HOOK\nOpen with something close to: ${hook}\nMake it impossible to scroll past.`);
	}

	if (feeling) {
		sections.push(`## WHAT THE READER SHOULD FEEL\n${feeling}. But don't announce it — create it through specifics and rhythm.`);
	}

	if (details) {
		sections.push(`## DETAILS TO INCLUDE\n${details}\nWeave these in naturally — don't list them.`);
	}

	if (cta) {
		sections.push(`## WHAT THEY SHOULD DO\n${cta}. But the CTA should feel like an invitation, not a pitch.`);
	}

	if (style) {
		sections.push(`## VIDEO STYLE\n${style}`);
	}

	if (conversationNotes) {
		sections.push(`## ADDITIONAL CONTEXT FROM THE CONVERSATION\n${conversationNotes}`);
	}

	// ANTI-FABRICATION + OUTPUT FORMAT RULES — injected into every generation prompt
	sections.push(`## ABSOLUTE RULES
1. DO NOT invent any person, child, parent, coach, or specific individual. No "Jamal," no "Coach Keisha," no "Sarah's mom," no fake names. ZERO invented characters.
2. DO NOT create specific anecdotes that didn't happen. You can describe TYPES of moments ("the kid who finally holds the racket right") but never invent a plot with named characters.
3. If a real moment was provided above, use it. If not, write from program-level truth and Kimberly's lived perspective.
4. Start mid-thought. Drop the reader into something specific. No warm-up paragraphs.
5. Every sentence must earn its spot. If Kimberly would delete it, you delete it first.
6. Write this so an AI detector scores it as HUMAN. That means: irregular sentence lengths, conversational fragments, specific details over general claims, imperfect rhythm that sounds like someone actually talking.

## OUTPUT FORMAT — CRITICAL
Your response must be ONLY the final publishable content. Nothing else.
DO NOT include brainstorming, angle analysis, strategy notes, "Pick:" headers, numbered options, or any planning process.
DO NOT label your output with "Blog post:" or "Here's the post:" or any header.
DO NOT explain your approach or choices.
The FIRST word of your response must be the FIRST word of the actual post.`);

	return `You are writing a ${platform} post for Community Literacy Club.

${sections.join('\n\n')}

RESPOND WITH ONLY THE POST. No brainstorming. No angle analysis. No "here's the post" labels. The first word you write IS the first word of the published content.`;
}

// ---------------------------------------------------------------------------
// POST-PROCESSING: Strip brainstorming / planning from output
// ---------------------------------------------------------------------------
// Safety net: if the model dumps its chain-of-thought (angle brainstorming,
// "Pick:", numbered options, "Blog post:" labels), strip everything before
// the actual content begins.
// ---------------------------------------------------------------------------

function stripBrainstorming(raw: string): string {
	let text = raw.trim();

	// Pattern 1: "Blog post:" or "Post:" or "Here's the post:" label followed by content
	const postLabelMatch = text.match(/(?:^|\n)\s*(?:blog\s*post|post|here'?s?\s*the\s*post|final\s*(?:post|version)|caption|script)\s*:\s*\n/i);
	if (postLabelMatch && postLabelMatch.index !== undefined) {
		const afterLabel = text.slice(postLabelMatch.index + postLabelMatch[0].length).trim();
		if (afterLabel.length > 100) {
			text = afterLabel;
		}
	}

	// Pattern 2: Numbered angle analysis ("1)", "2)", "3)" followed by "Pick:")
	const pickMatch = text.match(/(?:^|\n)\s*Pick\s*:/i);
	if (pickMatch && pickMatch.index !== undefined) {
		// Find the actual content after the "Pick:" line
		const afterPick = text.slice(pickMatch.index);
		const contentStart = afterPick.match(/\n\n(.+)/s);
		if (contentStart && contentStart[1] && contentStart[1].trim().length > 100) {
			text = contentStart[1].trim();
			// Strip any remaining "Blog post:" header
			text = text.replace(/^(?:blog\s*post|post|caption|script)\s*:\s*\n+/i, '').trim();
		}
	}

	// Pattern 3: "Angle brainstorming" type headers at the start
	// Only match multi-word planning phrases to avoid stripping posts that
	// legitimately start with common words like "Strategy" or "Options"
	if (/^(?:angle\s*brainstorm|brainstorming|approach\s*options?|strategy\s*(?:notes?|options?))/i.test(text)) {
		// Find the first double-line-break after the planning section
		const doubleBreak = text.indexOf('\n\n');
		if (doubleBreak > 0) {
			const rest = text.slice(doubleBreak + 2).trim();
			if (rest.length > 200) {
				text = rest;
			}
		}
	}

	// Pattern 4: "---" separator between planning and content
	const separatorMatch = text.match(/\n---+\n/);
	if (separatorMatch && separatorMatch.index !== undefined) {
		const afterSep = text.slice(separatorMatch.index + separatorMatch[0].length).trim();
		if (afterSep.length > 100) {
			text = afterSep;
		}
	}

	return text.trim();
}

/**
 * Generate a styled image using gpt-image-1.5 with best-practice structured prompting.
 */
async function generateStyledImage(
	imagePrompt: string,
	style: { id: string; name: string; promptSuffix: string },
	reason: string,
	platform: string,
	logger: { info: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void },
): Promise<{ styleId: string; styleName: string; imageUrl: string; imagePrompt: string; reason: string } | null> {
	const fullPrompt = [
		imagePrompt,
		'',
		style.promptSuffix,
		'',
		'Constraints:',
		'- Original artwork only, no copyrighted characters or trademarks',
		'- No watermarks, no logos, no extra text unless specified',
		'- No stock photo aesthetics — capture an authentic, specific moment',
		'- Composition should have clear focal point with balanced negative space',
		'- Represent Black and brown children, teens, and community members authentically',
		'- Show real settings: community center gyms, portable nets, folding tables with chess boards, parks',
	].join('\n');

	const quality = STYLE_QUALITY[style.id] || 'low';
	const size = PLATFORM_IMAGE_SIZE[platform] || '1024x1024';

	logger.info('Generating image with gpt-image-1.5 — style: "%s", quality: %s, size: %s',
		style.name, quality, size);

	try {
		const imageResponse = await openaiClient.images.generate({
			model: 'gpt-image-1.5',
			prompt: fullPrompt,
			n: 1,
			size,
			quality,
		});

		const imageData = imageResponse.data?.[0];
		const b64 = imageData?.b64_json;

		if (!b64) {
			logger.error('No image data returned for style "%s"', style.name);
			return null;
		}

		const dataUrl = `data:image/png;base64,${b64}`;
		logger.info('Image generated for style "%s": success (%d KB)', style.name, Math.round(b64.length / 1024));

		return {
			styleId: style.id,
			styleName: style.name,
			imageUrl: dataUrl,
			imagePrompt: fullPrompt,
			reason,
		};
	} catch (error) {
		logger.error('Image generation failed for style "%s": %s', style.name, error);
		return null;
	}
}

const agent = createAgent('content-creator', {
	description: 'Creates social media content with optional AI-generated images',
	schema: {
		input: AgentInput,
		output: AgentOutput,
	},
	handler: async (ctx, {
		topic,
		platform = 'Instagram',
		includeImage = true,
		imageMode = 'agent-pick',
		selectedStyles = [],
		variationCount = 2,
	}) => {
		ctx.logger.info('Creating content for: %s on %s', topic, platform);

		// Step 1: Build a structured, context-rich prompt from the brief data
		const generationPrompt = buildGenerationPrompt(topic, platform);
		ctx.logger.info('Generation prompt length: %d', generationPrompt.length);

		// Step 2: Generate the text content with the structured prompt
		const { text: rawContent } = await generateText({
			model: openai('gpt-5-mini'),
			system: systemPrompt,
			prompt: generationPrompt,
		});

		// Step 2b: Strip any brainstorming/planning that leaked into the output.
		// The model sometimes dumps its chain-of-thought before the actual post.
		const content = stripBrainstorming(rawContent);
		ctx.logger.info('Content generated, length: %d (raw: %d)', content.length, rawContent.length);

		let imageUrl: string | undefined;
		let imagePrompt: string | undefined;
		let images: { styleId: string; styleName: string; imageUrl: string; imagePrompt: string; reason: string }[] | undefined;
		let agentRecommendations: { styleId: string; styleName: string; reason: string }[] | undefined;

		// Step 3: Generate images if requested
		if (includeImage) {
			ctx.logger.info('Generating structured image prompt for gpt-image-1.5...');

			const { text: generatedImagePrompt } = await generateText({
				model: openai('gpt-5-mini'),
				prompt: `You are writing an image generation prompt for gpt-image-1.5, based on a social media post for Community Literacy Club (a youth tennis, chess, and mentorship nonprofit serving predominantly Black and brown communities in Hempstead, Long Beach, Brooklyn, Westchester, Newark NJ, and Connecticut).

Post: ${content}

Platform: ${platform}

Write a structured scene description following this exact format:

Scene: [Describe the background environment — location, time of day, lighting conditions, atmosphere]
Subject: [Describe the main subject(s) — who/what is in the scene, their pose, expression, action]
Key details: [Specific textures, materials, colors, objects that make the scene feel authentic and real]
Composition: [Framing, camera angle, depth of field — use photography language like lens focal length, eye-level/low-angle, etc.]

RULES:
- REPRESENT THE COMMUNITY: Show Black and brown children, teens, young adults, and families. This is who CLC serves.
- Be SPECIFIC — worn tennis ball fuzz, chalk dust on fingers, cracked gym floor, folding chairs, portable net
- Use photography/cinematography language (35mm lens, shallow depth of field, golden hour)
- Do NOT include any art style directions — just describe the scene and moment
- Do NOT include text overlays, watermarks, or brand references
- Capture a real, unposed moment — not a stock photo setup
- Settings should feel like community centers, school gyms, public parks — NOT country clubs or expensive facilities
- Keep it to 4-6 lines total

Write only the structured scene description, nothing else:`,
			});

			imagePrompt = generatedImagePrompt.trim();
			ctx.logger.info('Image prompt: %s', imagePrompt.slice(0, 200));

			if (imageMode === 'agent-pick') {
				const recommendations = getAgentStyleRecommendations(topic, platform);
				agentRecommendations = recommendations;
				ctx.logger.info('Agent recommended styles: %s', recommendations.map(r => r.styleName).join(', '));

				const imagePromises = recommendations.map((rec) => {
					const style = getStyleById(rec.styleId);
					if (!style) return Promise.resolve(null);
					return generateStyledImage(imagePrompt!, style, rec.reason, platform, ctx.logger);
				});

				const results = await Promise.allSettled(imagePromises);
				const successfulImages: { styleId: string; styleName: string; imageUrl: string; imagePrompt: string; reason: string }[] = [];
				for (const result of results) {
					if (result.status === 'fulfilled' && result.value !== null) {
						successfulImages.push(result.value);
					}
				}
				images = successfulImages;

				const firstImage = successfulImages[0];
				if (firstImage) {
					imageUrl = firstImage.imageUrl;
				}
			} else {
				const stylesToUse = selectedStyles.slice(0, variationCount);
				ctx.logger.info('User selected styles: %s', stylesToUse.join(', '));

				const imagePromises = stylesToUse.map((styleId) => {
					const style = getStyleById(styleId);
					if (!style) return Promise.resolve(null);
					return generateStyledImage(imagePrompt!, style, 'Selected by user', platform, ctx.logger);
				});

				const results = await Promise.allSettled(imagePromises);
				const successfulImages: { styleId: string; styleName: string; imageUrl: string; imagePrompt: string; reason: string }[] = [];
				for (const result of results) {
					if (result.status === 'fulfilled' && result.value !== null) {
						successfulImages.push(result.value);
					}
				}
				images = successfulImages;

				const firstImg = successfulImages[0];
				if (firstImg) {
					imageUrl = firstImg.imageUrl;
				}
			}

			ctx.logger.info('Image generation complete: %d of %d succeeded',
				images?.length ?? 0,
				imageMode === 'agent-pick' ? 2 : selectedStyles.length,
			);
		}

		const result = {
			content,
			platform,
			imageUrl,
			imagePrompt,
			images,
			agentRecommendations,
		};

		// Auto-save to content library for future reference
		try {
			const thumbnails = (images || []).map((img) => ({
				styleId: img.styleId,
				styleName: img.styleName,
				thumbnail: img.imageUrl,
				imagePrompt: img.imagePrompt,
			}));

			const libraryEntry = {
				id: `cl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
				createdAt: new Date().toISOString(),
				platform,
				content,
				topic: topic.slice(0, 300),
				images: thumbnails.length > 0 ? thumbnails : undefined,
			};

			await ctx.thread.state.push('content-library', libraryEntry, 100);
			ctx.logger.info('Content saved to library: %s (%s, %d images)',
				libraryEntry.id, platform, thumbnails.length);
		} catch (libErr) {
			ctx.logger.warn('Failed to save to content library: %s',
				libErr instanceof Error ? libErr.message : String(libErr));
		}

		return result;
	}
});

export default agent;
