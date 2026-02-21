/**
 * Image Style Library for Content Creator
 * 12 art styles with structured prompt suffixes for gpt-image-1.5
 * Follows the gpt-image-1.5 prompting guide:
 *   - Photography/cinematography language for photorealistic styles
 *   - Explicit rendering techniques and material references for illustrated styles
 *   - Specific color palettes, textures, and composition guidance
 * + recommendation engine mapping content topics/platforms to best-fit styles
 */

export interface ImageStyle {
	id: string;
	name: string;
	description: string;
	promptSuffix: string;
	bestFor: string[];
}

export const IMAGE_STYLES: ImageStyle[] = [
	{
		id: 'photorealism',
		name: 'Photorealism',
		description: 'Cinematic documentary photography with natural lighting',
		promptSuffix:
			'Style: Cinematic photorealism.\nCamera: Shot on 35mm Kodak Portra 400 film, 50mm prime lens at f/1.8, shallow depth of field.\nLighting: Natural available light, golden hour warmth, soft directional key light from camera-left.\nTexture: Visible film grain, subtle lens flare, true-to-life skin tones and fabric textures.\nMood: Candid documentary moment — unposed, emotionally authentic, decisive-moment feel.',
		bestFor: ['instagram', 'linkedin', 'facebook', 'community', 'impact', 'tournament'],
	},
	{
		id: 'corporate-memphis',
		name: 'Corporate Memphis',
		description: 'Flat 2D vector illustrations with bold colors',
		promptSuffix:
			'Style: Corporate Memphis flat 2D vector illustration.\nRendering: Clean vector shapes, zero outlines, no gradients — flat solid fills only.\nFigures: Simplified human forms with elongated limbs, small heads, large hands, Alegria-style proportions.\nPalette: Bold saturated primaries — coral #FF6B6B, electric blue #4ECDC4, warm yellow #FFE66D, soft purple #A06CD5.\nComposition: Asymmetric balance, figures interacting with oversized abstract shapes, generous white space.',
		bestFor: ['linkedin', 'newsletter', 'email', 'facebook'],
	},
	{
		id: 'retro-futurism',
		name: 'Retro Futurism',
		description: '1960s Space Age aesthetic with atomic-age optimism',
		promptSuffix:
			'Style: Retro futurism, 1960s Space Age poster art.\nRendering: Screen-printed texture with visible halftone registration, limited color separations (4-5 spot colors).\nPalette: Mid-century modern — burnt orange, teal, mustard gold, cream white, charcoal black.\nElements: Atomic starbursts, swooping rocket trails, ray-gun gothic architecture, Googie-style curves.\nComposition: Strong diagonal energy, bold negative space for text placement, vintage travel poster layout.',
		bestFor: ['twitter', 'tiktok', 'instagram'],
	},
	{
		id: 'surrealist-abstraction',
		name: 'Surrealist Abstraction',
		description: 'Dreamlike compositions inspired by Dali and Magritte',
		promptSuffix:
			'Style: Surrealist abstraction, painterly fine art.\nRendering: Oil paint texture with visible brushstrokes, glazed layers, chiaroscuro lighting with dramatic cast shadows.\nElements: Impossible geometry, floating objects defying gravity, melting forms, trompe-l\'oeil depth illusions.\nPalette: Deep rich saturated tones — ultramarine blue, cadmium red, gold ochre — against moody atmospheric backgrounds.\nMood: Dreamlike and contemplative, Magritte-meets-Dali conceptual surrealism, mysterious and thought-provoking.',
		bestFor: ['blog', 'instagram', 'youtube'],
	},
	{
		id: 'caricature',
		name: 'Caricature',
		description: 'Exaggerated expressive character art with personality',
		promptSuffix:
			'Style: Expressive caricature illustration, editorial cartoon art.\nRendering: Fluid ink linework with varying stroke weight, watercolor wash fills, visible paper texture beneath.\nFigures: Exaggerated key features (large heads, expressive hands), dynamic S-curve poses, squash-and-stretch energy.\nPalette: Warm and inviting — amber, terracotta, sage green, with pops of bright accent color for focal points.\nExpression: Maximum personality — every face tells a story, every gesture is amplified.',
		bestFor: ['twitter', 'tiktok', 'facebook'],
	},
	{
		id: 'digital-illustration',
		name: 'Digital Illustration',
		description: 'Polished modern concept art with clean rendering',
		promptSuffix:
			'Style: Polished digital illustration, modern concept art.\nRendering: Clean cel-shaded base with soft airbrush gradients, ambient occlusion shadows, subtle rim lighting on edges.\nDetail: Stylized but precise — simplified forms with one level of fine detail (stitching on fabric, texture on surfaces).\nPalette: Vibrant and professional — teal, warm coral, deep navy, cream highlights, cohesive and brand-friendly.\nComposition: Strong silhouette readability, clear hierarchy of visual elements, professional editorial quality.',
		bestFor: ['linkedin', 'instagram', 'blog', 'newsletter', 'fundraiser'],
	},
	{
		id: 'comic-book',
		name: 'Comic Book',
		description: 'Bold lines, halftone dots, and dynamic action',
		promptSuffix:
			'Style: Classic comic book art, Silver Age superhero aesthetic.\nRendering: Bold black india-ink outlines with varying weight, Ben-Day dot halftone shading, CMYK color separation look.\nAction: Dynamic foreshortened poses, speed lines radiating from focal point, dramatic low-angle perspective.\nPalette: Vivid primaries — pure red, blue, yellow — with flat color fills and minimal gradients.\nComposition: High-contrast panels, strong diagonal motion lines, impact-frame energy.',
		bestFor: ['twitter', 'tiktok', 'instagram', 'tournament', 'competition'],
	},
	{
		id: 'cartoon',
		name: 'Cartoon',
		description: 'Friendly rounded shapes with approachable feel',
		promptSuffix:
			'Style: Friendly cartoon illustration, children\'s book quality.\nRendering: Clean vector-style outlines with consistent 3px stroke weight, flat color fills with one shadow tone per shape.\nFigures: Rounded pill-shaped bodies, oversized heads (1:3 ratio to body), huge expressive eyes, button noses, simple mitten hands.\nPalette: Warm and inviting — sunshine yellow, sky blue, grass green, soft pink, with cream-white backgrounds.\nMood: Joyful, safe, and welcoming — every character looks like they are having the best day ever.',
		bestFor: ['facebook', 'instagram', 'tiktok', 'youth', 'kids'],
	},
	{
		id: 'playful-art',
		name: 'Playful Art',
		description: 'Cut-paper collage with handmade tactile feel',
		promptSuffix:
			'Style: Cut-paper collage art, handcrafted mixed-media.\nRendering: Torn construction-paper edges with visible fiber texture, layered depth with drop shadows between paper layers, rubber cement stain marks.\nMaterials: Kraft paper, tissue paper, magazine clippings, washi tape strips, stamped ink marks, crayon scribbles.\nPalette: Earthy craft tones — kraft brown, sage green, dusty rose — with pops of bright red and turquoise as accents.\nTexture: Every surface has tactile quality — you can feel the paper grain, the glue ridges, the scissor-cut edges.',
		bestFor: ['instagram', 'facebook', 'newsletter', 'community', 'youth'],
	},
	{
		id: 'pop-surrealism',
		name: 'Pop Surrealism',
		description: 'Lowbrow art with hyper-detailed rendering',
		promptSuffix:
			'Style: Pop surrealism, lowbrow fine art.\nRendering: Hyper-detailed oil painting technique with porcelain-smooth skin, meticulous fabric folds, micro-detailed background patterns.\nFigures: Oversized luminous eyes (anime-meets-Bouguereau), doll-like proportions, serene but enigmatic expressions.\nPalette: Rich jewel tones — deep emerald, ruby, sapphire, antique gold — with pearlescent highlights and dark vignette edges.\nMood: Whimsical yet slightly uncanny, beautiful but dreamlike, every square inch filled with obsessive hidden detail.',
		bestFor: ['instagram', 'blog', 'youtube'],
	},
	{
		id: 'playful-3d',
		name: 'Playful 3D',
		description: 'Pixar-inspired soft renders with toy-like charm',
		promptSuffix:
			'Style: Playful 3D render, Pixar-quality character art.\nRendering: Soft subsurface scattering on skin, ambient occlusion in crevices, three-point studio lighting with warm key and cool fill.\nForms: Rounded pill shapes, inflated balloon proportions, no sharp edges — everything looks squeezable and toy-like.\nMaterials: Matte plastic, soft felt, smooth rubber — tactile surfaces that catch light beautifully.\nPalette: Cheerful pastels with saturated accents — mint, peach, lavender, with pops of cherry red and sunshine yellow.\nMood: Claymation-meets-vinyl-toy charm, miniature tilt-shift world feel.',
		bestFor: ['instagram', 'tiktok', 'facebook', 'youth', 'kids'],
	},
	{
		id: 'algerian',
		name: 'Algerian',
		description: 'North African geometric patterns with jewel tones',
		promptSuffix:
			'Style: North African Algerian decorative art, Islamic geometric tradition.\nRendering: Mathematically precise geometric tessellations, hand-painted ceramic texture, gold leaf gilding with subtle patina.\nPatterns: Interlocking star-and-cross zellige tile motifs, arabesque vine scrollwork, muqarnas honeycomb depth illusions.\nPalette: Jewel tones — deep crimson, royal cobalt blue, emerald green, burnished gold — on cream or midnight backgrounds.\nComposition: Ornate border frames with central medallion focus, sacred geometry proportions, luxurious and celebratory.',
		bestFor: ['instagram', 'linkedin', 'fundraiser', 'gala', 'event'],
	},
];

/**
 * Given content context, returns 2 recommended styles with reasons
 */
export function getAgentStyleRecommendations(
	topic: string,
	platform: string,
): { styleId: string; styleName: string; reason: string }[] {
	const text = topic.toLowerCase();
	const plat = platform.toLowerCase();

	// Topic-based matching (highest priority)
	if (text.includes('youth') || text.includes('kid') || text.includes('children') || text.includes('ages')) {
		return pickStyles(['cartoon', 'playful-3d'], 'Great for youth-focused content — friendly and approachable');
	}

	if (text.includes('tournament') || text.includes('competition') || text.includes('match') || text.includes('championship')) {
		return pickStyles(['comic-book', 'photorealism'], 'High-energy styles that capture competitive spirit');
	}

	if (text.includes('fundrais') || text.includes('gala') || text.includes('donor') || text.includes('sponsor')) {
		return pickStyles(['algerian', 'digital-illustration'], 'Elegant and polished — perfect for fundraising');
	}

	if (text.includes('community') || text.includes('impact') || text.includes('story') || text.includes('mentor')) {
		return pickStyles(['photorealism', 'playful-art'], 'Authentic feel that captures real community moments');
	}

	// Platform-based fallback
	if (plat === 'linkedin') {
		return pickStyles(['digital-illustration', 'photorealism'], 'Professional and polished for LinkedIn');
	}
	if (plat === 'instagram') {
		return pickStyles(['photorealism', 'playful-3d'], 'Eye-catching styles that perform well on Instagram');
	}
	if (plat === 'twitter' || plat === 'x') {
		return pickStyles(['comic-book', 'retro-futurism'], 'Bold and shareable — stands out in the feed');
	}
	if (plat === 'tiktok') {
		return pickStyles(['cartoon', 'playful-3d'], 'Fun and vibrant for the TikTok audience');
	}
	if (plat === 'facebook') {
		return pickStyles(['photorealism', 'cartoon'], 'Warm and community-friendly for Facebook');
	}

	// Default fallback
	return pickStyles(['photorealism', 'digital-illustration'], 'Versatile styles that work across platforms');
}

function pickStyles(
	ids: string[],
	reason: string,
): { styleId: string; styleName: string; reason: string }[] {
	return ids.map((id) => {
		const style = IMAGE_STYLES.find((s) => s.id === id);
		return {
			styleId: id,
			styleName: style?.name ?? id,
			reason,
		};
	});
}

export function getStyleById(id: string): ImageStyle | undefined {
	return IMAGE_STYLES.find((s) => s.id === id);
}
