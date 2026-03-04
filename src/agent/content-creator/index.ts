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
	contentId: s.string().optional(),
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

	// ANTI-FABRICATION RULES — injected into every generation prompt
	sections.push(`## ABSOLUTE RULES
1. DO NOT invent any person, child, parent, coach, or specific individual. No "Jamal," no "Coach Keisha," no "Sarah's mom," no fake names. ZERO invented characters.
2. DO NOT create specific anecdotes that didn't happen. You can describe TYPES of moments ("the kid who finally holds the racket right") but never invent a plot with named characters.
3. If a real moment was provided above, use it. If not, write from program-level truth and Kimberly's lived perspective.
4. Start mid-thought. Drop the reader into something specific. No warm-up paragraphs.
5. Every sentence must earn its spot. If Kimberly would delete it, you delete it first.
6. Write this so an AI detector scores it as HUMAN. That means: irregular sentence lengths, conversational fragments, specific details over general claims, imperfect rhythm that sounds like someone actually talking.`);

	const isBlog = platform.toLowerCase() === 'blog';

	if (isBlog) {
		// BLOG: structured markdown with image placement markers
		// This REPLACES the generic output format — blog posts use markdown, not plain text
		sections.push(`## OUTPUT FORMAT — BLOG STRUCTURED MARKDOWN

YOUR OUTPUT MUST BE STRUCTURED MARKDOWN. This is the blog format — NOT plain text.

Your ENTIRE response must follow this EXACT template. Copy this structure literally, replacing the bracketed descriptions with real content:

# Your Compelling Title Here

[HEADER_IMAGE]

Your engaging 2-3 sentence intro paragraph here. Hook the reader into the story.

## Your First Section Title

Your substantive paragraph(s) here. No bullet lists.

## Your Second Section Title

Your substantive paragraph(s) here.

> Your pull quote here — one powerful sentence that captures a key insight.

## Your Third Section Title

[MID_IMAGE]

Your substantive paragraph(s) here.

[CLOSING_IMAGE]

## Your Final Section Title

Your closing paragraph with a natural CTA — an invitation, not a sales pitch.

MANDATORY REQUIREMENTS:
- Line 1 of your output MUST start with # followed by the title
- You MUST include 3-5 lines that start with ## (section headings)
- You MUST include exactly one line starting with > (pull quote)
- You MUST include these three markers, each alone on its own line: [HEADER_IMAGE] and [MID_IMAGE] and [CLOSING_IMAGE]
- Write substantive paragraphs between the headings — NO bullet lists, NO numbered lists
- Do NOT use bold (**), italic (*), or any formatting besides #, ##, >, and the three image markers
- Do NOT include any brainstorming, labels like "Blog post:", or meta-commentary`);
	} else {
		// NON-BLOG: plain text output
		sections.push(`## OUTPUT FORMAT — CRITICAL
Your response must be ONLY the final publishable content. Nothing else.
DO NOT include brainstorming, angle analysis, strategy notes, "Pick:" headers, numbered options, or any planning process.
DO NOT label your output with "Blog post:" or "Here's the post:" or any header.
DO NOT explain your approach or choices.
The FIRST word of your response must be the FIRST word of the actual post.`);
	}

	const closingInstruction = isBlog
		? 'RESPOND WITH ONLY THE STRUCTURED MARKDOWN BLOG. Line 1 must be # followed by the title. Include all three image markers [HEADER_IMAGE], [MID_IMAGE], [CLOSING_IMAGE].'
		: 'RESPOND WITH ONLY THE POST. No brainstorming. No angle analysis. No "here\'s the post" labels. The first word you write IS the first word of the published content.';

	return `You are writing a ${platform} post for Community Literacy Club.

${sections.join('\n\n')}

${closingInstruction}`;
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

// ---------------------------------------------------------------------------
// SUPABASE IMAGE UPLOAD
// ---------------------------------------------------------------------------
// Uploads base64 PNG images to the 'generated-images' Supabase Storage bucket
// and returns a persistent public URL. Falls back gracefully — if upload fails,
// the caller keeps the base64 data URL.
// ---------------------------------------------------------------------------

async function uploadImageToSupabase(
	base64Data: string,
	styleId: string,
	logger: { info: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void },
): Promise<string | null> {
	try {
		const { supabaseAdmin } = await import('../../lib/supabase');

		const raw = base64Data.replace(/^data:image\/\w+;base64,/, '');
		const buffer = Buffer.from(raw, 'base64');

		const now = new Date();
		const storagePath = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${Date.now()}_${styleId}.png`;

		const { error: uploadError } = await supabaseAdmin.storage
			.from('generated-images')
			.upload(storagePath, buffer, {
				contentType: 'image/png',
				upsert: false,
			});

		if (uploadError) {
			logger.error('Supabase image upload failed: %s', uploadError.message);
			return null;
		}

		const { data: urlData } = supabaseAdmin.storage
			.from('generated-images')
			.getPublicUrl(storagePath);

		logger.info('Image uploaded to Supabase: %s', urlData.publicUrl);
		return urlData.publicUrl;
	} catch (err) {
		logger.error('Image upload error: %s', err);
		return null;
	}
}

// ---------------------------------------------------------------------------
// FEEDBACK CONTEXT LOADER
// ---------------------------------------------------------------------------
// Queries Supabase for recent editorial feedback (likes/dislikes with notes)
// and formats them as a prompt section to append to the system prompt.
// This is the "training" mechanism — Kim's past feedback becomes direct
// editorial instruction for the LLM.
// ---------------------------------------------------------------------------

async function loadFeedbackContext(
	logger?: { info: (msg: string, ...args: unknown[]) => void },
): Promise<string> {
	try {
		const { supabaseAdmin } = await import('../../lib/supabase');

		const { data } = await supabaseAdmin
			.from('content_feedback')
			.select('rating, notes, platform, content_type, content_snippet')
			.not('notes', 'is', null)
			.order('created_at', { ascending: false })
			.limit(20);

		if (!data || data.length === 0) return '';

		const liked = data
			.filter((f: any) => f.rating === 'positive' && f.notes)
			.map((f: any) => `- "${f.notes}"${f.content_snippet ? ` (re: "${f.content_snippet.slice(0, 80)}...")` : ''}`)
			.slice(0, 8);

		const disliked = data
			.filter((f: any) => f.rating === 'negative' && f.notes)
			.map((f: any) => `- "${f.notes}"${f.content_snippet ? ` (re: "${f.content_snippet.slice(0, 80)}...")` : ''}`)
			.slice(0, 8);

		if (liked.length === 0 && disliked.length === 0) return '';

		const sections: string[] = ['\n\n---\n\nFEEDBACK FROM KIMBERLY (use this to calibrate your writing):'];

		if (disliked.length > 0) {
			sections.push(`\nShe did NOT like these things in previous content — AVOID repeating these patterns:\n${disliked.join('\n')}`);
		}
		if (liked.length > 0) {
			sections.push(`\nShe DID like these things — lean into these patterns:\n${liked.join('\n')}`);
		}

		sections.push('\nTreat this feedback as direct editorial instruction. It overrides general guidelines when they conflict.\n---');

		const result = sections.join('\n');
		logger?.info('Loaded feedback context: %d chars (%d liked, %d disliked)', result.length, liked.length, disliked.length);
		return result;
	} catch {
		return '';
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

		// Step 0: Load editorial feedback from Supabase to inject into system prompt
		const feedbackContext = await loadFeedbackContext(ctx.logger);

		// Step 1: Build a structured, context-rich prompt from the brief data
		const generationPrompt = buildGenerationPrompt(topic, platform);
		ctx.logger.info('Generation prompt length: %d, feedback context: %d chars', generationPrompt.length, feedbackContext.length);

		// Step 2: Generate the text content with the structured prompt + feedback
		const { text: rawContent } = await generateText({
			model: openai('gpt-5-mini'),
			system: systemPrompt + feedbackContext,
			prompt: generationPrompt,
		});

		// Step 2b: Strip any brainstorming/planning that leaked into the output.
		// The model sometimes dumps its chain-of-thought before the actual post.
		// For blog posts, skip stripping to preserve markdown structure (# headers, > quotes, [MARKERS])
		const isBlogPost = platform.toLowerCase() === 'blog';
		let content = isBlogPost ? rawContent.trim() : stripBrainstorming(rawContent);
		ctx.logger.info('Content generated, length: %d (raw: %d)', content.length, rawContent.length);

		// Step 2c: Blog format validation — if the LLM didn't produce structured markdown,
		// make a second call to reformat the plain text into the required blog structure.
		if (isBlogPost) {
			const hasH1 = /^#\s+.+/m.test(content);
			const hasH2 = /^##\s+.+/m.test(content);
			const hasMarkers = content.includes('[HEADER_IMAGE]') && content.includes('[MID_IMAGE]') && content.includes('[CLOSING_IMAGE]');

			ctx.logger.info('Blog format check — H1: %s, H2: %s, markers: %s', hasH1, hasH2, hasMarkers);

			if (!hasH1 || !hasH2 || !hasMarkers) {
				ctx.logger.info('Blog format missing — reformatting with second LLM call...');
				const { text: reformatted } = await generateText({
					model: openai('gpt-5-mini'),
					prompt: `You are a formatting assistant. Take this blog post and reformat it into structured markdown.

ORIGINAL BLOG POST:
${content}

REFORMAT it into this EXACT structure. Keep ALL the original writing — just add the formatting:

# [Extract or write a compelling title from the content]

[HEADER_IMAGE]

[First 2-3 sentences as intro paragraph]

## [Section heading for the first major topic]

[Paragraphs from the original covering this topic]

## [Section heading for the second major topic]

[Paragraphs from the original]

> [Pick the single most powerful sentence from the original as a pull quote]

## [Section heading for the next topic]

[MID_IMAGE]

[Paragraphs from the original]

[CLOSING_IMAGE]

## [Final section heading]

[Final paragraphs from the original]

RULES:
- KEEP the original text — do not rewrite it, just organize it
- Line 1 MUST start with # (the title)
- Include 3-5 ## section headings
- Include exactly one > blockquote (pull quote)
- Include exactly these three markers on their own lines: [HEADER_IMAGE], [MID_IMAGE], [CLOSING_IMAGE]
- No bullet lists, no bold/italic, no extra formatting
- Output ONLY the reformatted markdown, nothing else`,
				});
				content = reformatted.trim();
				ctx.logger.info('Blog reformatted, length: %d', content.length);
			}
		}

		let imageUrl: string | undefined;
		let imagePrompt: string | undefined;
		let images: { styleId: string; styleName: string; imageUrl: string; imagePrompt: string; reason: string }[] | undefined;
		let agentRecommendations: { styleId: string; styleName: string; reason: string }[] | undefined;

		// Step 3: Generate images if requested
		if (includeImage) {
			const isBlog = platform.toLowerCase() === 'blog';

			if (isBlog) {
				// ---------------------------------------------------------------
				// BLOG: Generate 3 position-specific images (header, mid, closing)
				// ---------------------------------------------------------------
				ctx.logger.info('Blog detected — generating 3 position-specific image prompts...');

				// Strip image markers from content before passing to image prompt generator
				const cleanContent = content
					.replace(/\[HEADER_IMAGE\]/g, '')
					.replace(/\[MID_IMAGE\]/g, '')
					.replace(/\[CLOSING_IMAGE\]/g, '')
					.trim();

				const { text: blogImagePrompts } = await generateText({
					model: openai('gpt-5-mini'),
					prompt: `You are writing THREE image generation prompts for gpt-image-1.5, based on a blog post for Community Literacy Club (a youth tennis, chess, and mentorship nonprofit serving predominantly Black and brown communities in Hempstead, Long Beach, Brooklyn, Westchester, Newark NJ, and Connecticut).

Blog post:
${cleanContent}

Author context: This content is written from the perspective of Kimberly Gordon, a Black woman who is the founder and executive director of Community Literacy Club and UnitedSets Tennis & Learning. When the post is written in first person or describes leadership, program direction, coaching, or organizational vision, the scene should reflect her identity — a Black woman leading, teaching, coaching, or connecting with her community. Do NOT default to male figures in leadership positions.

Write THREE separate scene descriptions, one for each position in the blog post. Each scene should be DIFFERENT and reflect the content near its placement:

HEADER:
Scene: [Sets the overall tone — captures the topic/theme of the blog, wide establishing shot]
Subject: [Main subject that draws the reader in]
Key details: [Textures, colors, atmosphere]
Composition: [Wide or medium shot, inviting the reader in]

MID:
Scene: [Illustrates the core insight or turning point in the narrative]
Subject: [A specific action or interaction that embodies the middle section's content]
Key details: [Close-up details that feel intimate and real]
Composition: [Tighter framing, eye-level, documentary feel]

CLOSING:
Scene: [Forward-looking, resolution, or the feeling the reader should leave with]
Subject: [A moment that captures hope, determination, or community]
Key details: [Warm lighting, sense of continuation]
Composition: [Medium-wide, golden hour or warm interior lighting]

RULES:
- REPRESENT THE COMMUNITY: Show Black and brown children, teens, young adults, and families. This is who CLC serves.
- Be SPECIFIC — worn tennis ball fuzz, chalk dust on fingers, cracked gym floor, folding chairs, portable net
- Use photography/cinematography language (35mm lens, shallow depth of field, golden hour)
- Do NOT include any art style directions — just describe the scene and moment
- Do NOT include text overlays, watermarks, or brand references
- Capture real, unposed moments — not stock photo setups
- Settings should feel like community centers, school gyms, public parks — NOT country clubs
- Each scene description should be 4-6 lines
- The three scenes must be VISUALLY DISTINCT from each other

Write the three scene descriptions using the exact labels HEADER:, MID:, CLOSING: — nothing else:`,
				});

				// Parse out the three prompts
				const promptText = blogImagePrompts.trim();
				const headerMatch = promptText.match(/HEADER:\s*([\s\S]*?)(?=MID:|$)/i);
				const midMatch = promptText.match(/MID:\s*([\s\S]*?)(?=CLOSING:|$)/i);
				const closingMatch = promptText.match(/CLOSING:\s*([\s\S]*?)$/i);

				const blogPositionPrompts = [
					{ position: 'Header image', prompt: headerMatch?.[1]?.trim() || promptText },
					{ position: 'Mid-post image', prompt: midMatch?.[1]?.trim() || promptText },
					{ position: 'Closing image', prompt: closingMatch?.[1]?.trim() || promptText },
				];

				imagePrompt = blogPositionPrompts[0]!.prompt; // primary prompt for metadata

				// Use top recommended style for visual consistency across all 3 blog images
				const recommendations = getAgentStyleRecommendations(topic, platform);
				agentRecommendations = recommendations;
				const primaryStyle = getStyleById(recommendations[0]?.styleId || 'photorealism');

				if (primaryStyle) {
					ctx.logger.info('Blog images: using style "%s" for all 3 positions', primaryStyle.name);

					const imagePromises = blogPositionPrompts.map((bp) =>
						generateStyledImage(bp.prompt, primaryStyle, bp.position, platform, ctx.logger),
					);

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
				}

				ctx.logger.info('Blog image generation complete: %d of 3 succeeded', images?.length ?? 0);
			} else {
				// ---------------------------------------------------------------
				// NON-BLOG: Standard image generation (existing flow)
				// ---------------------------------------------------------------
				ctx.logger.info('Generating structured image prompt for gpt-image-1.5...');

				const { text: generatedImagePrompt } = await generateText({
					model: openai('gpt-5-mini'),
					prompt: `You are writing an image generation prompt for gpt-image-1.5, based on a social media post for Community Literacy Club (a youth tennis, chess, and mentorship nonprofit serving predominantly Black and brown communities in Hempstead, Long Beach, Brooklyn, Westchester, Newark NJ, and Connecticut).

Post: ${content}

Platform: ${platform}

Author context: This content is written from the perspective of Kimberly Gordon, a Black woman who is the founder and executive director of Community Literacy Club and UnitedSets Tennis & Learning. When the post is written in first person or describes leadership, program direction, coaching, or organizational vision, the scene should reflect her identity — a Black woman leading, teaching, coaching, or connecting with her community. Do NOT default to male figures in leadership positions.

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
			} // end non-blog else

			// Upload generated images to Supabase Storage for persistence
			// Replace base64 data URLs with public Supabase URLs
			if (images && images.length > 0) {
				ctx.logger.info('Uploading %d images to Supabase Storage...', images.length);
				for (const img of images) {
					if (img.imageUrl.startsWith('data:')) {
						const publicUrl = await uploadImageToSupabase(img.imageUrl, img.styleId, ctx.logger);
						if (publicUrl) {
							img.imageUrl = publicUrl;
						}
					}
				}
				// Update the primary imageUrl too
				const firstImage = images[0];
				if (firstImage) {
					imageUrl = firstImage.imageUrl;
				}
			}
		}

		// Save to Supabase for persistent storage
		let contentId: string | undefined;
		try {
			const { supabaseAdmin } = await import('../../lib/supabase');

			const imageUrls = (images || []).map(img => img.imageUrl);
			const imagePrompts = (images || []).map(img => img.imagePrompt);
			const imageStyles = (images || []).map(img => img.styleName);

			const contentType = platform.toLowerCase() === 'blog' ? 'blog'
				: ['tiktok', 'youtube'].includes(platform.toLowerCase()) ? 'script'
				: platform.toLowerCase() === 'newsletter' ? 'newsletter'
				: 'post';

			const { data: row, error: dbError } = await supabaseAdmin
				.from('generated_content')
				.insert({
					platform,
					content,
					topic: topic.slice(0, 500),
					image_urls: imageUrls,
					image_prompts: imagePrompts,
					image_styles: imageStyles,
					content_type: contentType,
					word_count: content.split(/\s+/).length,
				})
				.select('id')
				.single();

			if (dbError) {
				ctx.logger.error('Supabase content save failed: %s', dbError.message);
			} else {
				contentId = row.id;
				ctx.logger.info('Content saved to Supabase: %s', row.id);
			}
		} catch (err) {
			ctx.logger.warn('Failed to save to Supabase: %s',
				err instanceof Error ? err.message : String(err));
		}

		// Also save to thread state as fallback (existing pattern)
		try {
			const thumbnails = (images || []).map((img) => ({
				styleId: img.styleId,
				styleName: img.styleName,
				thumbnail: img.imageUrl,
				imagePrompt: img.imagePrompt,
			}));

			const libraryEntry = {
				id: contentId || `cl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
				createdAt: new Date().toISOString(),
				platform,
				content,
				topic: topic.slice(0, 300),
				images: thumbnails.length > 0 ? thumbnails : undefined,
			};

			await ctx.thread.state.push('content-library', libraryEntry, 100);
		} catch (libErr) {
			ctx.logger.warn('Thread state save failed: %s',
				libErr instanceof Error ? libErr.message : String(libErr));
		}

		return {
			content,
			platform,
			contentId,
			imageUrl,
			imagePrompt,
			images,
			agentRecommendations,
		};
	}
});

export default agent;
