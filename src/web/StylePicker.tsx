import { useCallback, useEffect, useState } from 'react';

export type ImageModeChoice = 'agent-pick' | 'user-pick' | 'skip';

export interface StylePickerResult {
	mode: ImageModeChoice;
	selectedStyles: string[];
	variationCount: number;
}

interface StyleDef {
	id: string;
	name: string;
	description: string;
	gradient: string;
	/** CSS pattern/background that visually represents the art style */
	visualPreview: string;
	/** Extra CSS for overlay effects */
	overlayCSS?: React.CSSProperties;
}

// Each style gets a CSS-based visual treatment that evokes its actual aesthetic
const STYLES: StyleDef[] = [
	{
		id: 'photorealism',
		name: 'Photorealism',
		description: 'Cinematic documentary photography',
		gradient: 'linear-gradient(135deg, #2c1810 0%, #8B6914 30%, #C4933A 60%, #6B4F10 100%)',
		visualPreview: `
			radial-gradient(ellipse at 35% 60%, rgba(255,220,150,0.4) 0%, transparent 50%),
			radial-gradient(circle at 70% 40%, rgba(255,255,255,0.15) 0%, transparent 30%),
			linear-gradient(135deg, #1a1008 0%, #3d2b14 25%, #6b4f2a 50%, #c4933a 80%, #8b6914 100%)
		`,
		overlayCSS: {
			boxShadow: 'inset 0 0 20px rgba(0,0,0,0.5), inset 0 -10px 20px rgba(196,147,58,0.2)',
		},
	},
	{
		id: 'corporate-memphis',
		name: 'Corporate Memphis',
		description: 'Flat vector Alegria-style',
		gradient: 'linear-gradient(135deg, #9B59B6, #E91E8C, #F1C40F)',
		visualPreview: `
			radial-gradient(circle at 25% 30%, #FF6B6B 15px, transparent 16px),
			radial-gradient(circle at 70% 55%, #4ECDC4 20px, transparent 21px),
			radial-gradient(circle at 50% 80%, #FFE66D 12px, transparent 13px),
			radial-gradient(ellipse at 45% 40%, #A06CD5 25px, transparent 26px),
			linear-gradient(135deg, #FFE66D 0%, #FF6B6B 33%, #4ECDC4 66%, #A06CD5 100%)
		`,
	},
	{
		id: 'retro-futurism',
		name: 'Retro Futurism',
		description: '1960s Space Age optimism',
		gradient: 'linear-gradient(135deg, #E67E22, #F1C40F, #1ABC9C)',
		visualPreview: `
			radial-gradient(circle at 50% 50%, #F1C40F 8px, transparent 9px),
			radial-gradient(circle at 50% 50%, transparent 14px, #E67E22 15px, transparent 16px),
			radial-gradient(circle at 50% 50%, transparent 22px, #1ABC9C 23px, transparent 24px),
			conic-gradient(from 0deg at 50% 50%, #E67E22 0deg, #F1C40F 60deg, #1ABC9C 120deg, #E67E22 180deg, #F1C40F 240deg, #1ABC9C 300deg, #E67E22 360deg),
			linear-gradient(135deg, #2c1a00 0%, #1a3a35 100%)
		`,
	},
	{
		id: 'surrealist-abstraction',
		name: 'Surrealist Abstraction',
		description: 'Dreamlike Dali compositions',
		gradient: 'linear-gradient(135deg, #1B2631, #7D3C98, #E67E22)',
		visualPreview: `
			radial-gradient(ellipse at 30% 70%, rgba(125,60,152,0.8) 0%, transparent 40%),
			radial-gradient(ellipse at 70% 30%, rgba(230,126,34,0.6) 0%, transparent 35%),
			radial-gradient(ellipse at 50% 50%, rgba(30,60,100,0.9) 0%, transparent 50%),
			linear-gradient(180deg, #0a0e18 0%, #1B2631 40%, #2c1040 70%, #E67E22 100%)
		`,
		overlayCSS: {
			boxShadow: 'inset 0 0 30px rgba(125,60,152,0.4)',
		},
	},
	{
		id: 'caricature',
		name: 'Caricature',
		description: 'Exaggerated expressive characters',
		gradient: 'linear-gradient(135deg, #FAE5D3, #F0B27A, #E67E22)',
		visualPreview: `
			radial-gradient(ellipse at 40% 35%, #F0B27A 18px, transparent 19px),
			radial-gradient(circle at 35% 30%, #2c1a00 3px, transparent 4px),
			radial-gradient(circle at 45% 30%, #2c1a00 3px, transparent 4px),
			radial-gradient(ellipse at 40% 38%, #E67E22 6px, transparent 7px),
			linear-gradient(135deg, #FAE5D3 0%, #F5D5B0 50%, #E8C49A 100%)
		`,
	},
	{
		id: 'digital-illustration',
		name: 'Digital Illustration',
		description: 'Polished modern concept art',
		gradient: 'linear-gradient(135deg, #2980B9, #8E44AD, #D2B4DE)',
		visualPreview: `
			linear-gradient(160deg, transparent 30%, rgba(41,128,185,0.3) 31%, rgba(41,128,185,0.3) 32%, transparent 33%),
			linear-gradient(160deg, transparent 50%, rgba(142,68,173,0.3) 51%, rgba(142,68,173,0.3) 52%, transparent 53%),
			radial-gradient(circle at 60% 40%, rgba(210,180,222,0.5) 0%, transparent 40%),
			linear-gradient(135deg, #1a3550 0%, #2980B9 30%, #8E44AD 65%, #D2B4DE 100%)
		`,
		overlayCSS: {
			boxShadow: 'inset 0 0 15px rgba(41,128,185,0.3)',
		},
	},
	{
		id: 'comic-book',
		name: 'Comic Book',
		description: 'Bold lines, halftone action',
		gradient: 'linear-gradient(135deg, #E74C3C, #F1C40F, #2980B9)',
		visualPreview: `
			radial-gradient(circle, #000 1px, transparent 1px),
			linear-gradient(135deg, #E74C3C 0%, #F1C40F 45%, #2980B9 100%)
		`,
		overlayCSS: {
			backgroundSize: '6px 6px, 100% 100%',
			border: '3px solid #000',
			boxShadow: 'inset 3px -3px 0 rgba(0,0,0,0.2)',
		},
	},
	{
		id: 'cartoon',
		name: 'Cartoon',
		description: 'Friendly rounded approachable',
		gradient: 'linear-gradient(135deg, #27AE60, #1ABC9C, #2980B9)',
		visualPreview: `
			radial-gradient(circle at 40% 40%, #FDFEFE 15px, transparent 16px),
			radial-gradient(circle at 35% 37%, #2c3e50 4px, transparent 5px),
			radial-gradient(circle at 45% 37%, #2c3e50 4px, transparent 5px),
			radial-gradient(ellipse at 40% 48%, #E74C3C 5px, transparent 6px),
			linear-gradient(135deg, #85E89A 0%, #7DD6C8 50%, #74BFDE 100%)
		`,
	},
	{
		id: 'playful-art',
		name: 'Playful Art',
		description: 'Cut-paper collage handmade',
		gradient: 'linear-gradient(135deg, #F0B27A, #FAE5D3, #27AE60)',
		visualPreview: `
			linear-gradient(45deg, #E74C3C 0%, #E74C3C 25%, transparent 25%),
			linear-gradient(-45deg, #27AE60 0%, #27AE60 20%, transparent 20%),
			linear-gradient(90deg, transparent 40%, #F1C40F 40%, #F1C40F 60%, transparent 60%),
			linear-gradient(135deg, #F5DEB3 0%, #E8D5B5 30%, #DBC8A0 60%, #C4B590 100%)
		`,
		overlayCSS: {
			backgroundSize: '40px 40px, 35px 35px, 100% 100%, 100% 100%',
		},
	},
	{
		id: 'pop-surrealism',
		name: 'Pop Surrealism',
		description: 'Hyper-detailed lowbrow art',
		gradient: 'linear-gradient(135deg, #E91E8C, #9B59B6, #1ABC9C)',
		visualPreview: `
			radial-gradient(circle at 50% 40%, rgba(233,30,140,0.4) 0%, transparent 30%),
			radial-gradient(circle at 45% 38%, #1ABC9C 8px, transparent 9px),
			radial-gradient(circle at 55% 38%, #1ABC9C 8px, transparent 9px),
			radial-gradient(circle at 45% 38%, #0a0a0a 4px, transparent 5px),
			radial-gradient(circle at 55% 38%, #0a0a0a 4px, transparent 5px),
			radial-gradient(ellipse at 50% 35%, #FAE5D3 18px, transparent 19px),
			linear-gradient(135deg, #1a0520 0%, #0d1a2e 50%, #0a2a25 100%)
		`,
		overlayCSS: {
			boxShadow: 'inset 0 0 20px rgba(155,89,182,0.4), inset 0 0 40px rgba(233,30,140,0.2)',
		},
	},
	{
		id: 'playful-3d',
		name: 'Playful 3D',
		description: 'Pixar-inspired soft renders',
		gradient: 'linear-gradient(135deg, #E91E8C, #D2B4DE, #27AE60)',
		visualPreview: `
			radial-gradient(circle at 40% 50%, #FFB3D9 20px, transparent 21px),
			radial-gradient(circle at 60% 45%, #B8E6C8 16px, transparent 17px),
			radial-gradient(circle at 50% 65%, #D4B8E8 14px, transparent 15px),
			radial-gradient(circle at 40% 50%, rgba(255,255,255,0.4) 8px, transparent 15px),
			linear-gradient(135deg, #FFF0F5 0%, #F0E6FF 50%, #E6FFF0 100%)
		`,
		overlayCSS: {
			boxShadow: 'inset 0 -5px 15px rgba(0,0,0,0.08), inset 0 5px 15px rgba(255,255,255,0.3)',
		},
	},
	{
		id: 'algerian',
		name: 'Algerian',
		description: 'North African geometric jewel tones',
		gradient: 'linear-gradient(135deg, #1B2631, #C0392B, #D4AC0D)',
		visualPreview: `
			conic-gradient(from 0deg at 50% 50%, #C0392B 0deg, #D4AC0D 45deg, #1B6B50 90deg, #C0392B 135deg, #D4AC0D 180deg, #1B6B50 225deg, #C0392B 270deg, #D4AC0D 315deg, #C0392B 360deg),
			repeating-conic-gradient(from 0deg at 50% 50%, transparent 0deg, transparent 40deg, rgba(212,172,13,0.3) 45deg),
			linear-gradient(135deg, #0a0e18 0%, #1B2631 50%, #0a0e18 100%)
		`,
		overlayCSS: {
			boxShadow: 'inset 0 0 10px rgba(212,172,13,0.4), inset 0 0 2px rgba(192,57,43,0.6)',
		},
	},
];

// Cache for generated preview images
const PREVIEW_CACHE_KEY = 'clc-style-previews-v2';

/**
 * Downscale a base64 image to a small JPEG thumbnail for localStorage caching.
 * Full-size PNGs for 12 styles would exceed the ~5MB localStorage limit.
 * Returns a compressed data URL (~20-40KB each vs ~200-400KB for originals).
 */
function compressThumbnail(dataUrl: string, maxWidth = 160): Promise<string> {
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () => {
			const scale = maxWidth / img.width;
			const canvas = document.createElement('canvas');
			canvas.width = maxWidth;
			canvas.height = Math.round(img.height * scale);
			const ctx = canvas.getContext('2d');
			if (ctx) {
				ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
				resolve(canvas.toDataURL('image/jpeg', 0.6));
			} else {
				resolve(dataUrl); // fallback: store original
			}
		};
		img.onerror = () => resolve(dataUrl);
		img.src = dataUrl;
	});
}

interface StylePickerProps {
	onSubmit: (result: StylePickerResult) => void;
}

export function StylePicker({ onSubmit }: StylePickerProps) {
	const [phase, setPhase] = useState<'choose-mode' | 'pick-styles'>('choose-mode');
	const [selected, setSelected] = useState<string[]>([]);
	const [variationCount, setVariationCount] = useState(2);
	const [previewImages, setPreviewImages] = useState<Record<string, string>>({});
	const [generatingPreviews, setGeneratingPreviews] = useState(false);
	const [previewProgress, setPreviewProgress] = useState(0);

	// Load cached preview images on mount
	useEffect(() => {
		try {
			// Clean up old cache key
			localStorage.removeItem('clc-style-previews-v1');
		} catch { /* ignore */ }
		try {
			const cached = localStorage.getItem(PREVIEW_CACHE_KEY);
			if (cached) {
				const parsed = JSON.parse(cached);
				if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
					setPreviewImages(parsed);
				}
			}
		} catch { /* ignore parse errors */ }
	}, []);

	// Generate real preview images for all styles
	const handleGeneratePreviews = useCallback(async () => {
		setGeneratingPreviews(true);
		setPreviewProgress(0);

		const results: Record<string, string> = {};
		let completed = 0;

		// Generate previews sequentially to avoid rate limits
		for (const style of STYLES) {
			try {
				const response = await fetch('/api/content-creator', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						topic: 'Kids playing tennis and chess at a community center in Hempstead NY. Black and brown children, portable nets, folding tables, real community moment.',
						platform: 'Instagram',
						includeImage: true,
						imageMode: 'user-pick',
						selectedStyles: [style.id],
						variationCount: 1,
					}),
				});

				if (response.ok) {
					const data = await response.json();
					const img = data.images?.[0];
					if (img?.imageUrl) {
						results[style.id] = img.imageUrl;
					}
				}
			} catch (err) {
				console.error(`Preview generation failed for ${style.id}:`, err);
			}

			completed++;
			setPreviewProgress(Math.round((completed / STYLES.length) * 100));
		}

		// Store full-size in state for display
		setPreviewImages(results);

		// Cache compressed thumbnails to localStorage to stay under ~5MB limit
		if (Object.keys(results).length > 0) {
			try {
				const compressed: Record<string, string> = {};
				for (const [id, url] of Object.entries(results)) {
					compressed[id] = await compressThumbnail(url);
				}
				localStorage.setItem(PREVIEW_CACHE_KEY, JSON.stringify(compressed));
			} catch {
				// localStorage full — remove stale key and continue without cache
				try { localStorage.removeItem(PREVIEW_CACHE_KEY); } catch { /* ignore */ }
			}
		}

		setGeneratingPreviews(false);
	}, []);

	const handleStyleToggle = useCallback((styleId: string) => {
		setSelected((prev) => {
			if (prev.includes(styleId)) {
				return prev.filter((id) => id !== styleId);
			}
			if (prev.length >= variationCount) {
				return [...prev.slice(1), styleId];
			}
			return [...prev, styleId];
		});
	}, [variationCount]);

	const handleVariationChange = useCallback((count: number) => {
		setVariationCount(count);
		setSelected((prev) => prev.slice(0, count));
	}, []);

	if (phase === 'choose-mode') {
		return (
			<div style={{
				background: '#111520',
				border: '1px solid #1e2538',
				borderRadius: 12,
				padding: 24,
				animation: 'fadeSlideUp 0.4s ease-out',
			}}>
				<div style={{
					fontFamily: "'Space Mono', monospace",
					fontSize: 10,
					letterSpacing: 2,
					textTransform: 'uppercase' as const,
					color: '#4a5578',
					marginBottom: 16,
				}}>
					IMAGE OPTIONS
				</div>
				<p style={{
					fontSize: 15,
					color: '#c8d0e0',
					marginBottom: 20,
					lineHeight: 1.6,
					fontFamily: "'Source Serif 4', Georgia, serif",
				}}>
					Add an image to this post?
				</p>

				<div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10 }}>
					<button
						onClick={() => onSubmit({ mode: 'agent-pick', selectedStyles: [], variationCount: 2 })}
						style={{
							padding: '14px 20px',
							borderRadius: 8,
							border: '1px solid #2D6A4F',
							background: '#2D6A4F15',
							color: '#4a9e7a',
							cursor: 'pointer',
							fontFamily: "'Space Mono', monospace",
							fontSize: 12,
							letterSpacing: 0.5,
							textAlign: 'left' as const,
							transition: 'all 0.2s',
						}}
						onMouseEnter={(e) => { e.currentTarget.style.background = '#2D6A4F25'; }}
						onMouseLeave={(e) => { e.currentTarget.style.background = '#2D6A4F15'; }}
						type="button"
					>
						<span style={{ fontWeight: 700 }}>Let AI choose</span>
						<span style={{ color: '#4a5578', marginLeft: 8 }}>— picks 2 best-fit styles automatically</span>
					</button>

					<button
						onClick={() => setPhase('pick-styles')}
						style={{
							padding: '14px 20px',
							borderRadius: 8,
							border: '1px solid #1e2538',
							background: 'transparent',
							color: '#8892b0',
							cursor: 'pointer',
							fontFamily: "'Space Mono', monospace",
							fontSize: 12,
							letterSpacing: 0.5,
							textAlign: 'left' as const,
							transition: 'all 0.2s',
						}}
						onMouseEnter={(e) => { e.currentTarget.style.background = '#141824'; }}
						onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
						type="button"
					>
						<span style={{ fontWeight: 700 }}>I'll choose</span>
						<span style={{ color: '#4a5578', marginLeft: 8 }}>— browse 12 art styles</span>
					</button>

					<button
						onClick={() => onSubmit({ mode: 'skip', selectedStyles: [], variationCount: 0 })}
						style={{
							padding: '14px 20px',
							borderRadius: 8,
							border: '1px solid #1e2538',
							background: 'transparent',
							color: '#4a5578',
							cursor: 'pointer',
							fontFamily: "'Space Mono', monospace",
							fontSize: 12,
							letterSpacing: 0.5,
							textAlign: 'left' as const,
							transition: 'all 0.2s',
						}}
						onMouseEnter={(e) => { e.currentTarget.style.background = '#141824'; }}
						onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
						type="button"
					>
						Skip — text only
					</button>
				</div>
			</div>
		);
	}

	// Phase: pick-styles
	const hasRealPreviews = Object.keys(previewImages).length > 0;

	return (
		<div style={{
			background: '#111520',
			border: '1px solid #1e2538',
			borderRadius: 12,
			padding: 24,
			animation: 'fadeSlideUp 0.4s ease-out',
		}}>
			<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
				<div>
					<div style={{
						fontFamily: "'Space Mono', monospace",
						fontSize: 10,
						letterSpacing: 2,
						textTransform: 'uppercase' as const,
						color: '#4a5578',
						marginBottom: 6,
					}}>
						CHOOSE YOUR STYLES
					</div>
					<p style={{
						fontSize: 13,
						color: '#8892b0',
						fontFamily: "'Source Serif 4', Georgia, serif",
					}}>
						Select up to {variationCount} style{variationCount > 1 ? 's' : ''} for your image
					</p>
				</div>
				<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
					{!hasRealPreviews && !generatingPreviews && (
						<button
							onClick={handleGeneratePreviews}
							style={{
								padding: '6px 12px',
								borderRadius: 6,
								border: '1px solid #2D6A4F',
								background: '#2D6A4F15',
								color: '#4a9e7a',
								cursor: 'pointer',
								fontFamily: "'Space Mono', monospace",
								fontSize: 9,
								letterSpacing: 0.5,
								whiteSpace: 'nowrap' as const,
							}}
							title="Generate real preview images for each style (takes a few minutes)"
							type="button"
						>
							Generate Real Previews
						</button>
					)}
					{generatingPreviews && (
						<span style={{
							fontFamily: "'Space Mono', monospace",
							fontSize: 9,
							color: '#4a9e7a',
							letterSpacing: 0.5,
						}}>
							Generating... {previewProgress}%
						</span>
					)}
					<button
						onClick={() => { setPhase('choose-mode'); setSelected([]); }}
						style={{
							background: 'none',
							border: 'none',
							color: '#4a5578',
							cursor: 'pointer',
							fontFamily: "'Space Mono', monospace",
							fontSize: 11,
							letterSpacing: 0.5,
						}}
						type="button"
					>
						← Back
					</button>
				</div>
			</div>

			{/* Variation count selector */}
			<div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
				<span style={{
					fontFamily: "'Space Mono', monospace",
					fontSize: 11,
					color: '#4a5578',
					letterSpacing: 0.5,
				}}>
					How many images?
				</span>
				{[1, 2, 3].map((n) => (
					<button
						key={n}
						onClick={() => handleVariationChange(n)}
						style={{
							width: 32,
							height: 32,
							borderRadius: 6,
							border: variationCount === n ? '1px solid #2D6A4F' : '1px solid #1e2538',
							background: variationCount === n ? '#2D6A4F20' : 'transparent',
							color: variationCount === n ? '#4a9e7a' : '#4a5578',
							cursor: 'pointer',
							fontFamily: "'Space Mono', monospace",
							fontSize: 13,
							fontWeight: 700,
							transition: 'all 0.2s',
						}}
						type="button"
					>
						{n}
					</button>
				))}
			</div>

			{/* Style grid */}
			<div className="clc-style-grid" style={{
				display: 'grid',
				gridTemplateColumns: 'repeat(3, 1fr)',
				gap: 10,
				marginBottom: 20,
			}}>
				{STYLES.map((style) => {
					const selIndex = selected.indexOf(style.id);
					const isSelected = selIndex !== -1;
					const hasRealPreview = !!previewImages[style.id];

					return (
						<button
							key={style.id}
							onClick={() => handleStyleToggle(style.id)}
							style={{
								padding: 0,
								borderRadius: 10,
								border: isSelected ? '2px solid #2D6A4F' : '1px solid #1e2538',
								background: '#0a0d14',
								cursor: 'pointer',
								textAlign: 'left' as const,
								transition: 'all 0.2s',
								overflow: 'hidden',
								position: 'relative' as const,
							}}
							type="button"
						>
							{/* Visual preview thumbnail */}
							<div style={{
								height: 80,
								position: 'relative' as const,
								overflow: 'hidden',
							}}>
								{hasRealPreview ? (
									/* Real generated preview image */
									<img
										src={previewImages[style.id]}
										alt={`${style.name} preview`}
										style={{
											width: '100%',
											height: '100%',
											objectFit: 'cover',
											display: 'block',
										}}
									/>
								) : (
									/* CSS-based visual representation */
									<div style={{
										width: '100%',
										height: '100%',
										background: style.visualPreview,
										...(style.overlayCSS || {}),
									}} />
								)}
								{isSelected && (
									<div style={{
										position: 'absolute' as const,
										top: 6,
										right: 6,
										width: 22,
										height: 22,
										borderRadius: '50%',
										background: '#2D6A4F',
										color: '#ffffff',
										display: 'flex',
										alignItems: 'center',
										justifyContent: 'center',
										fontSize: 11,
										fontFamily: "'Space Mono', monospace",
										fontWeight: 700,
										boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
									}}>
										{selIndex + 1}
									</div>
								)}
							</div>
							{/* Info */}
							<div style={{ padding: '10px 10px 12px' }}>
								<div style={{
									fontFamily: "'Space Mono', monospace",
									fontSize: 10,
									fontWeight: 700,
									color: '#e2e8f0',
									marginBottom: 3,
									letterSpacing: 0.3,
								}}>
									{style.name}
								</div>
								<div style={{
									fontFamily: "'Space Mono', monospace",
									fontSize: 9,
									color: '#4a5578',
									lineHeight: 1.4,
									letterSpacing: 0.2,
								}}>
									{style.description}
								</div>
							</div>
						</button>
					);
				})}
			</div>

			{/* Submit */}
			<button
				onClick={() => onSubmit({
					mode: 'user-pick',
					selectedStyles: selected,
					variationCount,
				})}
				disabled={selected.length === 0}
				style={{
					width: '100%',
					padding: '14px',
					borderRadius: 8,
					border: 'none',
					background: selected.length > 0 ? '#2D6A4F' : '#1e2538',
					color: selected.length > 0 ? '#ffffff' : '#4a5578',
					cursor: selected.length > 0 ? 'pointer' : 'not-allowed',
					fontFamily: "'Space Mono', monospace",
					fontSize: 12,
					fontWeight: 700,
					letterSpacing: 1,
					transition: 'all 0.25s',
				}}
				type="button"
			>
				{selected.length > 0
					? `Generate ${selected.length} image${selected.length > 1 ? 's' : ''}`
					: 'Select at least one style'}
			</button>
		</div>
	);
}
