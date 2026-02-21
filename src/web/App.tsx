import { useAnalytics } from '@agentuity/react';
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from 'react';
import { StylePicker, type StylePickerResult } from './StylePicker';
import './App.css';

// Timeout constants
const TEXT_GENERATION_TIMEOUT = 90000; // 90 seconds for text (blog posts + cold starts need more time)
const IMAGE_GENERATION_TIMEOUT = 120000; // 120 seconds for images (they take longer)

interface Platform {
	id: string;
	label: string;
	icon: string;
	color: string;
	charLimit: number | null;
	desc: string;
	category: 'social' | 'video' | 'written';
}

const PLATFORMS: Platform[] = [
	{
		id: 'instagram',
		label: 'Instagram',
		icon: '📸',
		color: '#E1306C',
		charLimit: 2200,
		desc: 'Visual storytelling',
		category: 'social',
	},
	{
		id: 'facebook',
		label: 'Facebook',
		icon: '📘',
		color: '#1877F2',
		charLimit: 63206,
		desc: 'Community engagement',
		category: 'social',
	},
	{
		id: 'linkedin',
		label: 'LinkedIn',
		icon: '💼',
		color: '#0A66C2',
		charLimit: 3000,
		desc: 'Professional network',
		category: 'social',
	},
	{
		id: 'twitter',
		label: 'X / Twitter',
		icon: '𝕏',
		color: '#1d1d1d',
		charLimit: 280,
		desc: 'Quick impact',
		category: 'social',
	},
	{
		id: 'tiktok',
		label: 'TikTok',
		icon: '🎵',
		color: '#ff0050',
		charLimit: 4000,
		desc: 'Script + caption',
		category: 'video',
	},
	{
		id: 'youtube',
		label: 'YouTube',
		icon: '▶️',
		color: '#FF0000',
		charLimit: 5000,
		desc: 'Script + metadata',
		category: 'video',
	},
	{
		id: 'email',
		label: 'Newsletter',
		icon: '✉️',
		color: '#D44638',
		charLimit: null,
		desc: 'Direct connection',
		category: 'written',
	},
	{
		id: 'blog',
		label: 'Blog',
		icon: '✍️',
		color: '#2D6A4F',
		charLimit: null,
		desc: 'Deep storytelling',
		category: 'written',
	},
];

interface BriefField {
	id: string;
	label: string;
	placeholder: string;
	type: 'text' | 'textarea' | 'select';
	options?: string[];
}

const BRIEF_FIELDS: Record<string, BriefField[]> = {
	default: [
		{
			id: 'topic',
			label: "What's this about?",
			placeholder:
				'Spring chess tournament, summer camp registration, fundraiser recap...',
			type: 'textarea',
		},
		{
			id: 'audience',
			label: "Who's the audience?",
			placeholder: 'Parents, donors, community partners, volunteers...',
			type: 'select',
			options: [
				'Parents & Families',
				'Donors & Sponsors',
				'Community Partners',
				'Volunteers & Staff',
				'General Public',
				'Kids & Teens',
			],
		},
		{
			id: 'cta',
			label: 'What should they do?',
			placeholder: 'Register, donate, share, attend, volunteer...',
			type: 'text',
		},
		{
			id: 'details',
			label: 'Key details',
			placeholder: 'Dates, location, links, names, costs — anything specific',
			type: 'textarea',
		},
	],
	blog: [
		{
			id: 'topic',
			label: 'What story do you want to tell?',
			placeholder:
				"A moment from practice, a kid's breakthrough, why chess matters, a season reflection...",
			type: 'textarea',
		},
		{
			id: 'feeling',
			label: 'What should the reader feel?',
			placeholder: 'Inspired, connected, understood, motivated to act...',
			type: 'select',
			options: [
				'Inspired & Uplifted',
				'Connected to the mission',
				'Moved to take action',
				'Understanding our impact',
				'Part of the community',
				'Reflective & thoughtful',
			],
		},
		{
			id: 'moment',
			label: 'Is there a specific moment or person that captures this?',
			placeholder:
				"Last Tuesday a kid who hadn't spoken all semester checkmated his instructor...",
			type: 'textarea',
		},
		{
			id: 'details',
			label: 'Any details to include?',
			placeholder: 'Names (with permission), dates, program details, quotes...',
			type: 'textarea',
		},
	],
	tiktok: [
		{
			id: 'topic',
			label: "What's the video about?",
			placeholder:
				'A day at practice, a student spotlight, a quick chess tip, event hype...',
			type: 'textarea',
		},
		{
			id: 'hook',
			label: 'What grabs attention in the first 2 seconds?',
			placeholder:
				'A surprising fact, a bold statement, a question, a visual moment...',
			type: 'text',
		},
		{
			id: 'audience',
			label: "Who's this for?",
			placeholder: 'Parents, donors, community partners, volunteers...',
			type: 'select',
			options: [
				'Parents & Families',
				'Donors & Sponsors',
				'Community Partners',
				'General Public',
				'Kids & Teens',
				'Potential Volunteers',
			],
		},
		{
			id: 'details',
			label: 'Key details or talking points',
			placeholder:
				'What should be mentioned — dates, names, events, links in bio...',
			type: 'textarea',
		},
	],
	youtube: [
		{
			id: 'topic',
			label: "What's the video about?",
			placeholder:
				'Program overview, event recap, interview with a coach, student journey...',
			type: 'textarea',
		},
		{
			id: 'audience',
			label: "Who's watching this?",
			placeholder: 'Parents, donors, community partners, volunteers...',
			type: 'select',
			options: [
				'Parents & Families',
				'Donors & Sponsors',
				'Community Partners',
				'General Public',
				'Kids & Teens',
				'Potential Volunteers',
			],
		},
		{
			id: 'style',
			label: 'What kind of video?',
			placeholder: 'Choose the format...',
			type: 'select',
			options: [
				'Talking Head / Vlog',
				'Event Recap',
				'Tutorial / How-To',
				'Student Spotlight',
				'Program Overview',
				'Behind the Scenes',
			],
		},
		{
			id: 'details',
			label: 'Key points to cover',
			placeholder:
				'Main talking points, names, dates, anything specific to include...',
			type: 'textarea',
		},
	],
};

const PROMPT_TEMPLATES: Record<string, string> = {
	instagram: `Post announcing our spring chess tournament on March 15th at PS 234. Target audience is parents of kids ages 6-14. Include registration link. Tone: excited but informational.`,
	facebook: `Post recapping last weekend's tennis clinic. 40 kids attended, ages 8-16. Highlight the volunteer coaches. Ask parents to share photos. Warm and community-focused.`,
	linkedin: `Post about our impact this year — 200+ kids served, 3 new partnerships. Audience: potential donors and corporate sponsors. Professional but heartfelt.`,
	twitter: `Tweet announcing summer camp registration opens Monday. Ages 6-14. Link in bio. Make it punchy and shareable.`,
	tiktok: `30-second video script showing a typical Saturday at practice. Open with a kid making a great tennis shot, cut to chess boards, end with the group photo. Caption should be fun and inviting. Target: local parents scrolling.`,
	youtube: `5-minute video script: "What is Community Literacy Club?" Program overview for parents considering enrollment. Cover tennis, chess, mentorship, and what a typical day looks like. Friendly, authentic, not overly produced.`,
	email: `Monthly newsletter covering: spring tournament results, upcoming summer camp, volunteer spotlight on Coach Davis. Audience: our full mailing list of parents and supporters.`,
	blog: `Blog post about why we teach chess and tennis together — how strategic thinking on the board translates to the court. Describe the kinds of breakthroughs we see without inventing specific kids. Audience: parents considering enrollment and donors who want to understand our approach.`,
};

interface Message {
	isAgent: boolean;
	text?: string;
	isTyping?: boolean;
}

interface GeneratedImage {
	styleId: string;
	styleName: string;
	imageUrl: string;
	imagePrompt: string;
	reason: string;
}

interface GenerationResult {
	intent: string;
	message: string;
	routed_to: string;
	result?: {
		content: string;
		platform: string;
		imageUrl?: string;
		imagePrompt?: string;
		images?: GeneratedImage[];
		agentRecommendations?: { styleId: string; styleName: string; reason: string }[];
	};
}

interface ChatBubbleProps {
	message?: string;
	isAgent: boolean;
	isTyping?: boolean;
}

const ChatBubble = ({ message, isAgent, isTyping }: ChatBubbleProps) => (
	<div
		style={{
			display: 'flex',
			justifyContent: isAgent ? 'flex-start' : 'flex-end',
			marginBottom: 12,
			animation: 'fadeSlideUp 0.3s ease-out',
		}}
	>
		<div
			className="clc-chat-bubble"
			style={{
				maxWidth: '80%',
				padding: '14px 18px',
				borderRadius: isAgent ? '4px 18px 18px 18px' : '18px 4px 18px 18px',
				background: isAgent ? '#1a1f2e' : '#2D6A4F',
				color: isAgent ? '#c8d0e0' : '#ffffff',
				fontSize: 14,
				lineHeight: 1.65,
				fontFamily: "'Source Serif 4', Georgia, serif",
				border: isAgent ? '1px solid #262d40' : 'none',
				whiteSpace: 'pre-wrap',
			}}
		>
			{isTyping ? (
				<span style={{ display: 'flex', gap: 4, padding: '4px 0' }}>
					<span
						style={{
							width: 6,
							height: 6,
							borderRadius: '50%',
							background: '#4a5578',
							animation: 'pulse 1s infinite',
						}}
					/>
					<span
						style={{
							width: 6,
							height: 6,
							borderRadius: '50%',
							background: '#4a5578',
							animation: 'pulse 1s infinite 0.15s',
						}}
					/>
					<span
						style={{
							width: 6,
							height: 6,
							borderRadius: '50%',
							background: '#4a5578',
							animation: 'pulse 1s infinite 0.3s',
						}}
					/>
				</span>
			) : (
				message || ''
			)}
		</div>
	</div>
);

interface OutputCardProps {
	content: string;
	platform: string;
	images?: GeneratedImage[];
	onCopy: () => void;
	onSendToMake: () => void;
	onEdit?: (newContent: string) => void;
	copied: boolean;
}

const OutputCard = ({
	content,
	platform,
	images,
	onCopy,
	onSendToMake,
	onEdit,
	copied,
}: OutputCardProps) => {
	const p = PLATFORMS.find((pl) => pl.id === platform);
	const isVideo = p?.category === 'video';
	const [expandedPrompt, setExpandedPrompt] = useState<string | null>(null);
	const [isEditing, setIsEditing] = useState(false);
	const [editedContent, setEditedContent] = useState(content);

	return (
		<div
			className="clc-output-card"
			style={{
				background: '#111520',
				border: '1px solid #1e2538',
				borderRadius: 12,
				padding: 24,
				animation: 'fadeSlideUp 0.4s ease-out',
			}}
		>
			<div
				style={{
					display: 'flex',
					justifyContent: 'space-between',
					alignItems: 'center',
					marginBottom: 16,
				}}
			>
				<div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
					<span style={{ fontSize: 20 }}>{p?.icon}</span>
					<span
						style={{
							fontFamily: "'Space Mono', monospace",
							fontSize: 11,
							textTransform: 'uppercase',
							letterSpacing: 2,
						}}
					>
						<span style={{ color: p?.color }}>{p?.label}</span>
						<span style={{ color: '#4a5578' }}>
							{' '}
							— {isVideo ? 'Script + Caption Ready' : 'Ready to Publish'}
						</span>
					</span>
				</div>
				{p?.charLimit && (
					<span
						style={{
							fontSize: 11,
							color: content.length > p.charLimit ? '#ef4444' : '#4a5578',
							fontFamily: "'Space Mono', monospace",
						}}
					>
						{content.length} / {p.charLimit.toLocaleString()}
					</span>
				)}
			</div>
			{isEditing ? (
				<div style={{ padding: '16px 0', borderTop: '1px solid #1e2538', borderBottom: '1px solid #1e2538', marginBottom: 16 }}>
					<textarea
						value={editedContent}
						onChange={(e) => setEditedContent(e.target.value)}
						style={{
							width: '100%',
							minHeight: 150,
							padding: '12px',
							borderRadius: 6,
							border: '1px solid #2D6A4F',
							background: '#0a0d14',
							color: '#e2e8f0',
							fontSize: 15,
							lineHeight: 1.75,
							fontFamily: "'Source Serif 4', Georgia, serif",
							resize: 'vertical',
							outline: 'none',
						}}
					/>
					<div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
						<button
							onClick={() => {
								onEdit?.(editedContent);
								setIsEditing(false);
							}}
							style={{
								padding: '8px 16px',
								borderRadius: 6,
								border: 'none',
								background: '#2D6A4F',
								color: '#ffffff',
								cursor: 'pointer',
								fontFamily: "'Space Mono', monospace",
								fontSize: 11,
								letterSpacing: 0.5,
							}}
							type="button"
						>
							Save Changes
						</button>
						<button
							onClick={() => {
								setEditedContent(content);
								setIsEditing(false);
							}}
							style={{
								padding: '8px 16px',
								borderRadius: 6,
								border: '1px solid #1e2538',
								background: 'transparent',
								color: '#8892b0',
								cursor: 'pointer',
								fontFamily: "'Space Mono', monospace",
								fontSize: 11,
								letterSpacing: 0.5,
							}}
							type="button"
						>
							Cancel
						</button>
					</div>
				</div>
			) : (
				<div
					style={{
						color: '#e2e8f0',
						fontSize: 15,
						lineHeight: 1.75,
						fontFamily: "'Source Serif 4', Georgia, serif",
						whiteSpace: 'pre-wrap',
						padding: '16px 0',
						borderTop: '1px solid #1e2538',
						borderBottom: '1px solid #1e2538',
						marginBottom: 16,
					}}
				>
					{content}
				</div>
			)}

			{/* Generated Images */}
			{images && images.length > 0 && (
				<div style={{ marginBottom: 16 }}>
					<div style={{
						fontFamily: "'Space Mono', monospace",
						fontSize: 10,
						letterSpacing: 2,
						textTransform: 'uppercase' as const,
						color: '#4a5578',
						marginBottom: 12,
					}}>
						GENERATED IMAGES
					</div>
					<div className="clc-image-grid" style={{
						display: 'grid',
						gridTemplateColumns: images.length === 1 ? '1fr' : 'repeat(2, 1fr)',
						gap: 12,
					}}>
						{images.map((img) => (
							<div key={img.styleId} style={{
								borderRadius: 8,
								overflow: 'hidden',
								border: '1px solid #1e2538',
								background: '#0a0d14',
							}}>
								<img
									src={img.imageUrl}
									alt={`${img.styleName} style`}
									style={{
										width: '100%',
										height: 'auto',
										display: 'block',
									}}
								/>
								<div style={{ padding: '10px 12px' }}>
									<div style={{
										display: 'flex',
										justifyContent: 'space-between',
										alignItems: 'center',
										marginBottom: 6,
									}}>
										<span style={{
											fontFamily: "'Space Mono', monospace",
											fontSize: 10,
											fontWeight: 700,
											color: '#2D6A4F',
											letterSpacing: 1,
											textTransform: 'uppercase' as const,
										}}>
											{img.styleName}
										</span>
										<button
											onClick={() => {
												// Create a proper download link for base64 images
												const link = document.createElement('a');
												link.href = img.imageUrl;
												link.download = `clc-${img.styleName.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}.png`;
												document.body.appendChild(link);
												link.click();
												document.body.removeChild(link);
											}}
											style={{
												fontFamily: "'Space Mono', monospace",
												fontSize: 10,
												color: '#4a5578',
												letterSpacing: 0.5,
												background: 'none',
												border: 'none',
												cursor: 'pointer',
												padding: 0,
												textDecoration: 'none',
											}}
											type="button"
										>
											Download
										</button>
									</div>
									<button
										onClick={() => setExpandedPrompt(
											expandedPrompt === img.styleId ? null : img.styleId
										)}
										style={{
											background: 'none',
											border: 'none',
											color: '#4a5578',
											cursor: 'pointer',
											fontFamily: "'Space Mono', monospace",
											fontSize: 9,
											padding: 0,
											letterSpacing: 0.3,
										}}
										type="button"
									>
										{expandedPrompt === img.styleId ? '▾ Hide prompt' : '▸ Show prompt'}
									</button>
									{expandedPrompt === img.styleId && (
										<div style={{
											marginTop: 6,
											fontSize: 11,
											color: '#4a5578',
											lineHeight: 1.5,
											fontFamily: "'Source Serif 4', Georgia, serif",
										}}>
											{img.imagePrompt}
										</div>
									)}
								</div>
							</div>
						))}
					</div>
				</div>
			)}

			<div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
				<button
					onClick={onCopy}
					style={{
						padding: '10px 20px',
						borderRadius: 8,
						border: '1px solid #2D6A4F',
						background: 'transparent',
						color: '#2D6A4F',
						cursor: 'pointer',
						fontFamily: "'Space Mono', monospace",
						fontSize: 12,
						letterSpacing: 1,
						transition: 'all 0.2s',
					}}
					type="button"
				>
					{copied ? '✓ Copied' : 'Copy to Clipboard'}
				</button>
				{onEdit && !isEditing && (
					<button
						onClick={() => setIsEditing(true)}
						style={{
							padding: '10px 20px',
							borderRadius: 8,
							border: '1px solid #1e2538',
							background: 'transparent',
							color: '#8892b0',
							cursor: 'pointer',
							fontFamily: "'Space Mono', monospace",
							fontSize: 12,
							letterSpacing: 1,
							transition: 'all 0.2s',
						}}
						type="button"
					>
						Edit
					</button>
				)}
				<button
					onClick={onSendToMake}
					style={{
						padding: '10px 20px',
						borderRadius: 8,
						border: 'none',
						background: '#2D6A4F',
						color: '#ffffff',
						cursor: 'pointer',
						fontFamily: "'Space Mono', monospace",
						fontSize: 12,
						letterSpacing: 1,
						opacity: 0.5,
					}}
					type="button"
				>
					Send to Make.com →
				</button>
			</div>
		</div>
	);
};

type Step = 'platform' | 'brief' | 'conversation';

interface AppProps {
	onBack?: () => void;
}

export function App({ onBack }: AppProps) {
	const [step, setStep] = useState<Step>('platform');
	const [selectedPlatform, setSelectedPlatform] = useState<string | null>(null);
	const [briefData, setBriefData] = useState<Record<string, string>>({});
	const [messages, setMessages] = useState<Message[]>([]);
	const [userInput, setUserInput] = useState('');
	const [isGenerating, setIsGenerating] = useState(false);
	const [generatedContent, setGeneratedContent] = useState<string | null>(null);
	const [showTemplates, setShowTemplates] = useState(false);
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const chatEndRef = useRef<HTMLDivElement>(null);
	const stylePickerRef = useRef<HTMLDivElement>(null);

	// Image generation state
	const [showStylePicker, setShowStylePicker] = useState(false);
	const [isGeneratingImages, setIsGeneratingImages] = useState(false);
	const [generatedImages, setGeneratedImages] = useState<GeneratedImage[]>([]);
	const [generatingStatus, setGeneratingStatus] = useState('');
	const [savedFullTopic, setSavedFullTopic] = useState('');

	// Timeout and elapsed time state
	const [elapsedTime, setElapsedTime] = useState(0);
	const abortControllerRef = useRef<AbortController | null>(null);
	const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

	// Publish modal state
	const [showPublishModal, setShowPublishModal] = useState(false);
	const [publishStatus, setPublishStatus] = useState<'idle' | 'publishing' | 'success' | 'error'>('idle');
	const [publishMessage, setPublishMessage] = useState('');
	const [scheduledTime, setScheduledTime] = useState<string>('');

	const { track } = useAnalytics();

	// Elapsed time counter
	useEffect(() => {
		if (isGenerating || isGeneratingImages) {
			setElapsedTime(0);
			timerRef.current = setInterval(() => {
				setElapsedTime((prev) => prev + 1);
			}, 1000);
		} else {
			if (timerRef.current) {
				clearInterval(timerRef.current);
				timerRef.current = null;
			}
			setElapsedTime(0);
		}
		return () => {
			if (timerRef.current) {
				clearInterval(timerRef.current);
			}
		};
	}, [isGenerating, isGeneratingImages]);

	const handleCancel = useCallback(() => {
		if (abortControllerRef.current) {
			abortControllerRef.current.abort();
			abortControllerRef.current = null;
		}
		setIsGenerating(false);
		setIsGeneratingImages(false);
		setGeneratingStatus('');
		setError(null);
		setMessages((prev) => [
			...prev,
			{
				isAgent: true,
				text: 'Generation cancelled. Want to try again with the same brief?',
			},
		]);
	}, []);

	useEffect(() => {
		chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [messages]);

	// Auto-scroll to StylePicker when it becomes visible after text generation
	useEffect(() => {
		if (showStylePicker && generatedContent) {
			// Small delay to let the DOM render the StylePicker
			const timer = setTimeout(() => {
				stylePickerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
			}, 150);
			return () => clearTimeout(timer);
		}
	}, [showStylePicker, generatedContent]);

	const handlePlatformSelect = useCallback((platform: string) => {
		setSelectedPlatform(platform);
		setStep('brief');
	}, []);

	const getFieldsForPlatform = useCallback((platformId: string): BriefField[] => {
		return (BRIEF_FIELDS[platformId] || BRIEF_FIELDS.default)!;
	}, []);

	const handleBriefSubmit = useCallback(() => {
		if (!selectedPlatform) return;

		const p = PLATFORMS.find((pl) => pl.id === selectedPlatform);
		const isVideo = p?.category === 'video';
		setStep('conversation');

		const briefSummary = Object.entries(briefData)
			.filter(([_, v]) => v)
			.map(([k, v]) => `${k}: ${v}`)
			.join('\n');

		const contentType =
			selectedPlatform === 'blog'
				? 'a blog post'
				: isVideo
					? `a ${p?.label} script and caption`
					: `a ${p?.label} post`;

		setMessages([
			{
				isAgent: true,
				text: `Got it — working on ${contentType}. Here's what I have so far:\n\n${briefSummary}\n\nLet me ask a couple things to make this stronger...`,
			},
		]);

		setTimeout(() => {
			// Dynamic follow-up questions based on what's MISSING from the brief
			const hasMoment = !!briefData.moment?.trim();
			const hasDetails = !!briefData.details?.trim();
			const hasCta = !!briefData.cta?.trim();
			const hasAudience = !!briefData.audience?.trim();
			const hasHook = !!briefData.hook?.trim();
			const hasTopic = !!briefData.topic?.trim();

			let followUps: string;

			if (selectedPlatform === 'blog' && !hasMoment) {
				followUps =
					"Is there a specific moment — a Tuesday at the gym, a kid's first serve, something you saw that stuck with you? That's what makes this piece real instead of generic.";
			} else if (selectedPlatform === 'tiktok' && !hasHook) {
				followUps =
					"What's the first thing someone sees when they stop scrolling? A kid mid-swing? A chessboard close-up? Give me the opening shot.";
			} else if (selectedPlatform === 'youtube') {
				followUps =
					"Should this feel like someone talking to the camera, or more of a produced piece with B-roll? And what's the one thing a viewer should walk away knowing?";
			} else if (!hasDetails && !hasMoment) {
				followUps =
					"Give me something specific — a date, a gym name, what the weather was like, how many kids showed up. Details are what make this sound like Kimberly, not a template.";
			} else if (!hasCta) {
				followUps =
					"What do you want people to do after reading this? Sign up, share it, show up somewhere? Or is this just about making them feel something?";
			} else {
				followUps =
					"Anything else I should know? A link to include, a name to mention, or something you definitely don't want in this post?";
			}

			setMessages((prev) => [...prev, { isAgent: true, text: followUps }]);
		}, 1500);
	}, [selectedPlatform, briefData]);

	const handleSendMessage = useCallback(async () => {
		if (!userInput.trim() || !selectedPlatform) return;

		const currentInput = userInput.trim();
		setMessages((prev) => [...prev, { isAgent: false, text: currentInput }]);
		setUserInput('');

		setTimeout(() => {
			setMessages((prev) => [...prev, { isAgent: true, isTyping: true }]);
		}, 400);

		setTimeout(() => {
			setMessages((prev) => {
				const filtered = prev.filter((m) => !m.isTyping);
				return [
					...filtered,
					{
						isAgent: true,
						text: 'Perfect — I have everything I need. Writing your post now...',
					},
				];
			});

			setIsGenerating(true);
			setGeneratingStatus('WRITING YOUR POST...');
			setError(null);

			// Build a structured topic string — each field is a labeled section
			// so the backend prompt builder can parse and use them properly.
			const p = PLATFORMS.find((pl) => pl.id === selectedPlatform);

			// Collect conversation answers as additional context.
			// NOTE: `messages` state doesn't yet include the current userInput
			// (setMessages is async), so we append it manually to avoid losing
			// the user's most recent answer.
			const previousAnswers = messages
				.filter((m) => !m.isAgent && !m.isTyping)
				.map((m) => m.text)
				.filter(Boolean);
			// userInput was captured before we cleared it above
			const conversationContext = [...previousAnswers, currentInput]
				.filter(Boolean)
				.join('. ');

			// Build structured key:value pairs — the backend parses these
			const topicParts: string[] = [];
			for (const [key, value] of Object.entries(briefData)) {
				if (value?.trim()) {
					topicParts.push(`${key}: ${value.trim()}`);
				}
			}
			if (conversationContext) {
				topicParts.push(`conversation: ${conversationContext}`);
			}
			const fullTopic = topicParts.join('. ');
			setSavedFullTopic(fullTopic);

			track('generate_content', { platform: selectedPlatform, briefData });

			// Set up abort controller for timeout/cancellation
			abortControllerRef.current = new AbortController();
			const timeoutId = setTimeout(() => {
				if (abortControllerRef.current) {
					abortControllerRef.current.abort();
				}
			}, TEXT_GENERATION_TIMEOUT);

			// Call the API — text only first (includeImage: false)
			fetch('/api/content-creator', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					topic: fullTopic,
					platform: p?.label || 'Instagram',
					includeImage: false,
				}),
				signal: abortControllerRef.current.signal,
			})
				.then((response) => {
					clearTimeout(timeoutId);
					if (!response.ok) {
						throw new Error('Failed to generate content');
					}
					return response.json();
				})
				.then((data: { content: string; platform: string }) => {
					const content = data.content || '';
					setGeneratedContent(content);
					setIsGenerating(false);
					setGeneratingStatus('');
					// Show style picker after text is ready
					setShowStylePicker(true);
				})
				.catch((err) => {
					clearTimeout(timeoutId);
					if (err.name === 'AbortError') {
						setError('Request timed out or was cancelled. Please try again.');
					} else {
						setError(err instanceof Error ? err.message : 'Something went wrong');
					}
					setIsGenerating(false);
					setGeneratingStatus('');
					setMessages((prev) => [
						...prev,
						{
							isAgent: true,
							text: 'Sorry, there was an error generating your content. Please try again.',
						},
					]);
				});
		}, 2000);
	}, [userInput, selectedPlatform, briefData, messages, track]);

	const handleStylePickerSubmit = useCallback((result: StylePickerResult) => {
		if (!selectedPlatform || !generatedContent) return;

		setShowStylePicker(false);

		if (result.mode === 'skip') {
			// No images — done
			return;
		}

		// Start image generation
		setIsGeneratingImages(true);
		setGeneratingStatus(
			result.mode === 'agent-pick'
				? 'CHOOSING ART STYLES...'
				: 'PAINTING YOUR IMAGES...'
		);

		const p = PLATFORMS.find((pl) => pl.id === selectedPlatform);

		track('generate_images', {
			platform: selectedPlatform,
			mode: result.mode,
			styles: result.selectedStyles,
			variationCount: result.variationCount,
		});

		// Set up abort controller for timeout/cancellation
		abortControllerRef.current = new AbortController();
		const timeoutId = setTimeout(() => {
			if (abortControllerRef.current) {
				abortControllerRef.current.abort();
			}
		}, IMAGE_GENERATION_TIMEOUT);

		fetch('/api/content-creator', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				topic: savedFullTopic,
				platform: p?.label || 'Instagram',
				includeImage: true,
				imageMode: result.mode,
				selectedStyles: result.selectedStyles,
				variationCount: result.variationCount,
			}),
			signal: abortControllerRef.current.signal,
		})
			.then((response) => {
				clearTimeout(timeoutId);
				if (!response.ok) {
					throw new Error('Failed to generate images');
				}
				return response.json();
			})
			.then((data: { images?: GeneratedImage[] }) => {
				if (data.images && data.images.length > 0) {
					setGeneratedImages(data.images);
				}
				setIsGeneratingImages(false);
				setGeneratingStatus('');
			})
			.catch((err) => {
				clearTimeout(timeoutId);
				console.error('Image generation error:', err);
				setIsGeneratingImages(false);
				setGeneratingStatus('');
				// Don't block the flow — text is already shown
				const errorMessage = err.name === 'AbortError'
					? "Image generation timed out. You can still use the text content, or try again."
					: "Images couldn't be generated. You can still use the text content.";
				setMessages((prev) => [
					...prev,
					{
						isAgent: true,
						text: errorMessage,
					},
				]);
			});
	}, [selectedPlatform, generatedContent, savedFullTopic, track]);

	const handleCopy = useCallback(() => {
		if (!generatedContent) return;

		navigator.clipboard?.writeText(generatedContent);
		setCopied(true);
		track('copy_content');
		setTimeout(() => setCopied(false), 2000);
	}, [generatedContent, track]);

	const handleSendToMake = useCallback(() => {
		setShowPublishModal(true);
		setPublishStatus('idle');
		setPublishMessage('');
		setScheduledTime('');
	}, []);

	const handlePublishConfirm = useCallback(async () => {
		if (!generatedContent || !selectedPlatform) return;

		setPublishStatus('publishing');
		track('send_to_make', { platform: selectedPlatform, scheduled: !!scheduledTime });

		const p = PLATFORMS.find((pl) => pl.id === selectedPlatform);
		const firstImage = generatedImages[0];

		try {
			const response = await fetch('/api/webhook/publish', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					platform: p?.label || selectedPlatform,
					content: generatedContent,
					imageUrl: firstImage?.imageUrl,
					imageStyle: firstImage?.styleName,
					scheduledTime: scheduledTime || undefined,
				}),
			});

			const result = await response.json();

			if (result.success) {
				setPublishStatus('success');
				setPublishMessage(result.message);
			} else {
				setPublishStatus('error');
				setPublishMessage(result.message);
			}
		} catch (err) {
			setPublishStatus('error');
			setPublishMessage(err instanceof Error ? err.message : 'Failed to publish');
		}
	}, [generatedContent, selectedPlatform, generatedImages, scheduledTime, track]);

	const handleReset = useCallback(() => {
		setStep('platform');
		setSelectedPlatform(null);
		setBriefData({});
		setMessages([]);
		setGeneratedContent(null);
		setShowStylePicker(false);
		setIsGeneratingImages(false);
		setGeneratedImages([]);
		setGeneratingStatus('');
		setSavedFullTopic('');
		setError(null);
	}, []);

	const handleEditContent = useCallback((newContent: string) => {
		setGeneratedContent(newContent);
	}, []);

	const categories = [
		{ id: 'social', label: 'Social Media' },
		{ id: 'video', label: 'Video' },
		{ id: 'written', label: 'Long-Form' },
	];

	return (
		<>
			<style>{`
        @import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,300;8..60,400;8..60,600;8..60,700&family=Space+Mono:wght@400;700&display=swap');

        @keyframes fadeSlideUp {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }

        @keyframes pulse {
          0%, 100% { opacity: 0.3; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.2); }
        }

        @keyframes shimmer {
          0% { background-position: -200% center; }
          100% { background-position: 200% center; }
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #2a3148; border-radius: 4px; }

        textarea:focus, input:focus, select:focus {
          border-color: #2D6A4F55 !important;
          outline: none;
        }

        /* Mobile Responsive */
        @media (max-width: 768px) {
          .clc-header { padding: 16px 16px !important; }
          .clc-main { padding: 20px 16px !important; max-width: 100% !important; }
          .clc-footer { padding: 12px 16px !important; }
          .clc-sidebar { display: none !important; }
          .clc-platform-grid-social { grid-template-columns: repeat(2, 1fr) !important; }
          .clc-platform-grid-other { grid-template-columns: 1fr !important; }
          .clc-output-card { padding: 16px !important; }
          .clc-image-grid { grid-template-columns: 1fr !important; }
          .clc-style-grid { grid-template-columns: repeat(2, 1fr) !important; }
          .clc-publish-modal { width: 95% !important; padding: 20px !important; }
          .clc-chat-bubble { max-width: 90% !important; }
        }

        @media (max-width: 480px) {
          .clc-platform-grid-social { grid-template-columns: 1fr !important; }
          .clc-style-grid { grid-template-columns: repeat(2, 1fr) !important; }
        }
      `}</style>

			<div
				style={{
					minHeight: '100vh',
					background: '#0a0d14',
					color: '#e2e8f0',
					fontFamily: "'Source Serif 4', Georgia, serif",
				}}
			>
				{/* Header */}
				<header
					className="clc-header"
					style={{
						padding: '24px 40px',
						borderBottom: '1px solid #141824',
						display: 'flex',
						justifyContent: 'space-between',
						alignItems: 'center',
					}}
				>
					<div>
						{onBack && (
							<button
								onClick={onBack}
								style={{
									background: 'none',
									border: 'none',
									color: '#4a5578',
									cursor: 'pointer',
									fontFamily: "'Space Mono', monospace",
									fontSize: 11,
									marginBottom: 8,
									letterSpacing: 0.5,
									padding: 0,
								}}
								type="button"
							>
								← Back to Content Studio
							</button>
						)}
						<h1
							style={{
								fontSize: 22,
								fontWeight: 700,
								letterSpacing: '-0.02em',
								color: '#ffffff',
							}}
						>
							Content Creator
						</h1>
						<p
							style={{
								fontFamily: "'Space Mono', monospace",
								fontSize: 11,
								color: '#4a5578',
								marginTop: 4,
								letterSpacing: 0.5,
							}}
						>
							Social media posts with AI images
						</p>
					</div>

					<button
						onClick={() => setShowTemplates(!showTemplates)}
						style={{
							padding: '8px 16px',
							borderRadius: 6,
							border: '1px solid #1e2538',
							background: showTemplates ? '#1e2538' : 'transparent',
							color: '#8892b0',
							cursor: 'pointer',
							fontFamily: "'Space Mono', monospace",
							fontSize: 11,
							letterSpacing: 0.5,
							transition: 'all 0.2s',
						}}
						type="button"
					>
						{showTemplates ? '✕ Close' : '💡 Prompt Tips'}
					</button>
				</header>

				<div style={{ display: 'flex', minHeight: 'calc(100vh - 81px)' }}>
					{/* Main Content */}
					<main
						className="clc-main"
						style={{ flex: 1, padding: '32px 40px', maxWidth: 800, margin: '0 auto' }}
					>
						{/* Step 1: Platform Selection */}
						{step === 'platform' && (
							<div style={{ animation: 'fadeSlideUp 0.4s ease-out' }}>
								<div style={{ marginBottom: 36 }}>
									<h2
										style={{
											fontSize: 28,
											fontWeight: 300,
											marginBottom: 8,
											letterSpacing: '-0.01em',
										}}
									>
										What are we creating?
									</h2>
									<p style={{ color: '#4a5578', fontSize: 15 }}>
										Choose the platform — it shapes how the content is written.
									</p>
								</div>

								{categories.map((cat) => (
									<div key={cat.id} style={{ marginBottom: 24 }}>
										<div
											style={{
												fontFamily: "'Space Mono', monospace",
												fontSize: 10,
												color: '#4a5578',
												letterSpacing: 2,
												textTransform: 'uppercase',
												marginBottom: 10,
											}}
										>
											{cat.label}
										</div>
										<div
											className={cat.id === 'social' ? 'clc-platform-grid-social' : 'clc-platform-grid-other'}
											style={{
												display: 'grid',
												gridTemplateColumns:
													cat.id === 'social' ? 'repeat(4, 1fr)' : 'repeat(2, 1fr)',
												gap: 10,
											}}
										>
											{PLATFORMS.filter((p) => p.category === cat.id).map((p) => (
												<button
													key={p.id}
													onClick={() => handlePlatformSelect(p.id)}
													style={{
														padding: '20px 16px',
														borderRadius: 10,
														border: '1px solid #1e2538',
														background: '#111520',
														cursor: 'pointer',
														textAlign: 'left',
														transition: 'all 0.25s',
														position: 'relative',
														overflow: 'hidden',
													}}
													onMouseEnter={(e) => {
														e.currentTarget.style.borderColor = p.color + '66';
														e.currentTarget.style.background = '#141824';
													}}
													onMouseLeave={(e) => {
														e.currentTarget.style.borderColor = '#1e2538';
														e.currentTarget.style.background = '#111520';
													}}
													type="button"
												>
													<div style={{ fontSize: 24, marginBottom: 10 }}>{p.icon}</div>
													<div
														style={{
															fontFamily: "'Space Mono', monospace",
															fontSize: 12,
															fontWeight: 700,
															color: '#ffffff',
															marginBottom: 3,
															letterSpacing: 0.5,
														}}
													>
														{p.label}
													</div>
													<div
														style={{
															fontFamily: "'Space Mono', monospace",
															fontSize: 10,
															color: '#4a5578',
															letterSpacing: 0.3,
														}}
													>
														{p.desc}
													</div>
													<div
														style={{
															position: 'absolute',
															top: 0,
															right: 0,
															width: 3,
															height: '100%',
															background: p.color,
															opacity: 0.35,
															borderRadius: '0 10px 10px 0',
														}}
													/>
												</button>
											))}
										</div>
									</div>
								))}
							</div>
						)}

						{/* Step 2: Brief */}
						{step === 'brief' && selectedPlatform && (
							<div style={{ animation: 'fadeSlideUp 0.4s ease-out' }}>
								<div style={{ marginBottom: 32 }}>
									<button
										onClick={() => {
											setStep('platform');
											setSelectedPlatform(null);
											setBriefData({});
										}}
										style={{
											background: 'none',
											border: 'none',
											color: '#4a5578',
											cursor: 'pointer',
											fontFamily: "'Space Mono', monospace",
											fontSize: 11,
											marginBottom: 16,
											letterSpacing: 0.5,
										}}
										type="button"
									>
										← Back to platforms
									</button>
									<div
										style={{
											display: 'flex',
											alignItems: 'center',
											gap: 12,
											marginBottom: 8,
										}}
									>
										<span style={{ fontSize: 24 }}>
											{PLATFORMS.find((p) => p.id === selectedPlatform)?.icon}
										</span>
										<h2 style={{ fontSize: 24, fontWeight: 300 }}>
											{selectedPlatform === 'blog'
												? 'Tell us the story'
												: selectedPlatform === 'tiktok'
													? 'Plan the video'
													: selectedPlatform === 'youtube'
														? 'Outline the video'
														: 'Fill in the brief'}
										</h2>
									</div>
									<p style={{ color: '#4a5578', fontSize: 14 }}>
										{selectedPlatform === 'blog'
											? 'Blog posts need depth. The more you share, the more authentic the piece.'
											: selectedPlatform === 'tiktok'
												? "We'll write the script, caption, and hashtags. You bring the camera."
												: selectedPlatform === 'youtube'
													? "We'll write the full script, title, description, and tags."
													: 'Give enough context to work with — follow-up questions come next.'}
									</p>
								</div>

								{getFieldsForPlatform(selectedPlatform).map((field) => (
									<div key={field.id} style={{ marginBottom: 20 }}>
										<label
											style={{
												display: 'block',
												fontFamily: "'Space Mono', monospace",
												fontSize: 11,
												color: '#8892b0',
												marginBottom: 8,
												letterSpacing: 1,
												textTransform: 'uppercase',
											}}
										>
											{field.label}
										</label>
										{field.type === 'textarea' ? (
											<textarea
												value={briefData[field.id] || ''}
												onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
													setBriefData((prev) => ({
														...prev,
														[field.id]: e.target.value,
													}))
												}
												placeholder={field.placeholder}
												rows={3}
												style={{
													width: '100%',
													padding: '14px 16px',
													borderRadius: 8,
													border: '1px solid #1e2538',
													background: '#111520',
													color: '#e2e8f0',
													fontSize: 14,
													fontFamily: "'Source Serif 4', Georgia, serif",
													lineHeight: 1.6,
													resize: 'vertical',
													outline: 'none',
												}}
											/>
										) : field.type === 'select' ? (
											<select
												value={briefData[field.id] || ''}
												onChange={(e: ChangeEvent<HTMLSelectElement>) =>
													setBriefData((prev) => ({
														...prev,
														[field.id]: e.target.value,
													}))
												}
												aria-label={field.label}
												style={{
													width: '100%',
													padding: '14px 16px',
													borderRadius: 8,
													border: '1px solid #1e2538',
													background: '#111520',
													color: briefData[field.id] ? '#e2e8f0' : '#4a5578',
													fontSize: 14,
													fontFamily: "'Source Serif 4', Georgia, serif",
													outline: 'none',
													cursor: 'pointer',
												}}
											>
												<option value="">{field.placeholder}</option>
												{field.options?.map((opt) => (
													<option key={opt} value={opt}>
														{opt}
													</option>
												))}
											</select>
										) : (
											<input
												type="text"
												value={briefData[field.id] || ''}
												onChange={(e: ChangeEvent<HTMLInputElement>) =>
													setBriefData((prev) => ({
														...prev,
														[field.id]: e.target.value,
													}))
												}
												placeholder={field.placeholder}
												style={{
													width: '100%',
													padding: '14px 16px',
													borderRadius: 8,
													border: '1px solid #1e2538',
													background: '#111520',
													color: '#e2e8f0',
													fontSize: 14,
													fontFamily: "'Source Serif 4', Georgia, serif",
													outline: 'none',
												}}
											/>
										)}
									</div>
								))}

								<button
									onClick={handleBriefSubmit}
									disabled={!briefData.topic && !briefData.hook}
									style={{
										width: '100%',
										padding: '16px',
										borderRadius: 8,
										border: 'none',
										background:
											briefData.topic || briefData.hook ? '#2D6A4F' : '#1e2538',
										color: briefData.topic || briefData.hook ? '#ffffff' : '#4a5578',
										fontSize: 14,
										fontFamily: "'Space Mono', monospace",
										fontWeight: 700,
										letterSpacing: 1,
										cursor:
											briefData.topic || briefData.hook ? 'pointer' : 'not-allowed',
										transition: 'all 0.25s',
										marginTop: 8,
									}}
									type="button"
								>
									Continue →
								</button>
							</div>
						)}

						{/* Step 3: Conversation */}
						{step === 'conversation' && (
							<div style={{ animation: 'fadeSlideUp 0.4s ease-out' }}>
								<div style={{ marginBottom: 24 }}>
									<button
										onClick={() => {
											setStep('brief');
											setMessages([]);
											setGeneratedContent(null);
											setShowStylePicker(false);
											setGeneratedImages([]);
										}}
										style={{
											background: 'none',
											border: 'none',
											color: '#4a5578',
											cursor: 'pointer',
											fontFamily: "'Space Mono', monospace",
											fontSize: 11,
											marginBottom: 16,
											letterSpacing: 0.5,
										}}
										type="button"
									>
										← Back to brief
									</button>
									<div
										style={{
											display: 'flex',
											alignItems: 'center',
											gap: 8,
											fontFamily: "'Space Mono', monospace",
											fontSize: 11,
											color: '#4a5578',
											letterSpacing: 1,
										}}
									>
										<span
											style={{
												width: 8,
												height: 8,
												borderRadius: '50%',
												background: '#2D6A4F',
												display: 'inline-block',
											}}
										/>
										REFINING YOUR CONTENT
									</div>
								</div>

								<div
									style={{
										minHeight: 200,
										maxHeight: 400,
										overflowY: 'auto',
										marginBottom: 20,
										paddingRight: 8,
									}}
								>
									{messages.map((msg, i) => (
										<ChatBubble
											key={i}
											message={msg.text}
											isAgent={msg.isAgent}
											isTyping={msg.isTyping}
										/>
									))}
									<div ref={chatEndRef} />
								</div>

								{error && (
									<div
										style={{
											marginBottom: 16,
											padding: '12px 16px',
											borderRadius: 8,
											background: '#2d1a1a',
											border: '1px solid #5c2626',
											color: '#f87171',
											fontSize: 13,
										}}
									>
										<div style={{ marginBottom: 8 }}>{error}</div>
										<button
											onClick={() => {
												setError(null);
												// Re-enable input so user can try again
											}}
											style={{
												padding: '6px 12px',
												borderRadius: 4,
												border: '1px solid #5c2626',
												background: 'transparent',
												color: '#f87171',
												cursor: 'pointer',
												fontFamily: "'Space Mono', monospace",
												fontSize: 11,
												letterSpacing: 0.5,
											}}
											type="button"
										>
											Try Again
										</button>
									</div>
								)}

								{!generatedContent && !isGenerating && (
									<div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
										<textarea
											value={userInput}
											onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
												setUserInput(e.target.value)
											}
											onKeyDown={(e) => {
												if (e.key === 'Enter' && !e.shiftKey) {
													e.preventDefault();
													handleSendMessage();
												}
											}}
											placeholder="Answer the questions or add more context..."
											rows={2}
											style={{
												flex: 1,
												padding: '14px 16px',
												borderRadius: 8,
												border: '1px solid #1e2538',
												background: '#111520',
												color: '#e2e8f0',
												fontSize: 14,
												fontFamily: "'Source Serif 4', Georgia, serif",
												lineHeight: 1.5,
												resize: 'none',
												outline: 'none',
											}}
										/>
										<button
											onClick={handleSendMessage}
											style={{
												padding: '14px 20px',
												borderRadius: 8,
												border: 'none',
												background: '#2D6A4F',
												color: '#ffffff',
												cursor: 'pointer',
												fontFamily: "'Space Mono', monospace",
												fontSize: 12,
												fontWeight: 700,
												whiteSpace: 'nowrap',
											}}
											type="button"
										>
											Send
										</button>
									</div>
								)}

								{/* Loading indicator for text or images */}
								{(isGenerating || isGeneratingImages) && (
									<div
										style={{
											textAlign: 'center',
											padding: '32px 0',
											animation: 'fadeSlideUp 0.3s ease-out',
										}}
									>
										<div
											style={{
												fontFamily: "'Space Mono', monospace",
												fontSize: 12,
												color: '#2D6A4F',
												letterSpacing: 2,
												background: 'linear-gradient(90deg, #2D6A4F, #4a9e7a, #2D6A4F)',
												backgroundSize: '200% auto',
												WebkitBackgroundClip: 'text',
												WebkitTextFillColor: 'transparent',
												animation: 'shimmer 2s linear infinite',
												marginBottom: 8,
											}}
										>
											{generatingStatus || 'GENERATING CONTENT...'}
										</div>
										<div
											style={{
												fontFamily: "'Space Mono', monospace",
												fontSize: 10,
												color: '#4a5578',
												letterSpacing: 1,
												marginBottom: 12,
											}}
										>
											{elapsedTime}s elapsed
										</div>
										<button
											onClick={handleCancel}
											style={{
												padding: '8px 16px',
												borderRadius: 6,
												border: '1px solid #5c2626',
												background: 'transparent',
												color: '#f87171',
												cursor: 'pointer',
												fontFamily: "'Space Mono', monospace",
												fontSize: 10,
												letterSpacing: 0.5,
												transition: 'all 0.2s',
											}}
											type="button"
										>
											Cancel
										</button>
									</div>
								)}

								{/* Style Picker — shown after text is generated */}
								{showStylePicker && generatedContent && !isGeneratingImages && (
									<div ref={stylePickerRef} style={{ marginTop: 24 }}>
										<OutputCard
											content={generatedContent}
											platform={selectedPlatform!}
											onCopy={handleCopy}
											onSendToMake={handleSendToMake}
											onEdit={handleEditContent}
											copied={copied}
										/>
										<div style={{ marginTop: 16 }}>
											<StylePicker onSubmit={handleStylePickerSubmit} />
										</div>
									</div>
								)}

								{/* Final output — text + images */}
								{generatedContent && !isGenerating && !showStylePicker && !isGeneratingImages && selectedPlatform && (
									<div style={{ marginTop: 24 }}>
										<OutputCard
											content={generatedContent}
											platform={selectedPlatform}
											images={generatedImages.length > 0 ? generatedImages : undefined}
											onCopy={handleCopy}
											onSendToMake={handleSendToMake}
											onEdit={handleEditContent}
											copied={copied}
										/>
										<div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
											<button
												onClick={() => {
													setGeneratedContent(null);
													setShowStylePicker(false);
													setGeneratedImages([]);
													setMessages((prev) => [
														...prev,
														{
															isAgent: true,
															text: 'Want me to adjust anything? Different angle, shorter, more personal — just say the word.',
														},
													]);
												}}
												style={{
													flex: 1,
													padding: '12px',
													borderRadius: 8,
													border: '1px solid #1e2538',
													background: 'transparent',
													color: '#8892b0',
													cursor: 'pointer',
													fontFamily: "'Space Mono', monospace",
													fontSize: 12,
													letterSpacing: 0.5,
												}}
												type="button"
											>
												✏️ Refine this
											</button>
											<button
												onClick={handleReset}
												style={{
													flex: 1,
													padding: '12px',
													borderRadius: 8,
													border: '1px solid #1e2538',
													background: 'transparent',
													color: '#8892b0',
													cursor: 'pointer',
													fontFamily: "'Space Mono', monospace",
													fontSize: 12,
													letterSpacing: 0.5,
												}}
												type="button"
											>
												🆕 New content
											</button>
										</div>
									</div>
								)}
							</div>
						)}
					</main>

					{/* Sidebar: Prompt Templates */}
					{showTemplates && (
						<aside
							className="clc-sidebar"
							style={{
								width: 340,
								borderLeft: '1px solid #141824',
								padding: '32px 24px',
								overflowY: 'auto',
								animation: 'fadeSlideUp 0.3s ease-out',
								background: '#0d1018',
							}}
						>
							<h3
								style={{
									fontFamily: "'Space Mono', monospace",
									fontSize: 11,
									letterSpacing: 2,
									textTransform: 'uppercase',
									color: '#4a5578',
									marginBottom: 20,
								}}
							>
								💡 Example Prompts
							</h3>
							<p
								style={{
									fontSize: 13,
									color: '#4a5578',
									marginBottom: 24,
									lineHeight: 1.6,
								}}
							>
								The more specific you are, the better the output. Use these as a starting
								point.
							</p>

							{PLATFORMS.map((p) => (
								<div
									key={p.id}
									style={{
										marginBottom: 14,
										padding: '14px',
										borderRadius: 8,
										border: '1px solid #1e2538',
										background: '#111520',
									}}
								>
									<div
										style={{
											display: 'flex',
											alignItems: 'center',
											gap: 8,
											marginBottom: 10,
										}}
									>
										<span style={{ fontSize: 14 }}>{p.icon}</span>
										<span
											style={{
												fontFamily: "'Space Mono', monospace",
												fontSize: 11,
												color: p.color,
												fontWeight: 700,
												letterSpacing: 0.5,
											}}
										>
											{p.label}
										</span>
									</div>
									<p
										style={{
											fontSize: 12,
											color: '#8892b0',
											lineHeight: 1.65,
											fontStyle: 'italic',
										}}
									>
										&quot;{PROMPT_TEMPLATES[p.id]}&quot;
									</p>
								</div>
							))}
						</aside>
					)}
				</div>

				{/* Footer */}
				<footer
					className="clc-footer"
					style={{
						padding: '14px 40px',
						borderTop: '1px solid #141824',
						textAlign: 'center',
					}}
				>
					<span
						style={{
							fontFamily: "'Space Mono', monospace",
							fontSize: 10,
							color: '#2a3148',
							letterSpacing: 1,
						}}
					>
						Community Literacy Club
					</span>
				</footer>

				{/* Publish Modal */}
				{showPublishModal && (
					<div
						style={{
							position: 'fixed',
							top: 0,
							left: 0,
							right: 0,
							bottom: 0,
							background: 'rgba(0, 0, 0, 0.8)',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							zIndex: 1000,
							animation: 'fadeSlideUp 0.2s ease-out',
						}}
						onClick={() => publishStatus !== 'publishing' && setShowPublishModal(false)}
					>
						<div
							className="clc-publish-modal"
							style={{
								background: '#111520',
								border: '1px solid #1e2538',
								borderRadius: 12,
								padding: 24,
								maxWidth: 480,
								width: '90%',
								maxHeight: '80vh',
								overflow: 'auto',
							}}
							onClick={(e) => e.stopPropagation()}
						>
							{publishStatus === 'idle' && (
								<>
									<div style={{
										fontFamily: "'Space Mono', monospace",
										fontSize: 10,
										letterSpacing: 2,
										textTransform: 'uppercase' as const,
										color: '#4a5578',
										marginBottom: 16,
									}}>
										PUBLISH TO MAKE.COM
									</div>
									<p style={{
										fontSize: 14,
										color: '#c8d0e0',
										marginBottom: 20,
										lineHeight: 1.6,
									}}>
										Send this content to Make.com for automated publishing to{' '}
										<strong style={{ color: '#2D6A4F' }}>
											{PLATFORMS.find(p => p.id === selectedPlatform)?.label}
										</strong>
									</p>

									{/* Content preview */}
									<div style={{
										background: '#0a0d14',
										borderRadius: 8,
										padding: 12,
										marginBottom: 16,
										maxHeight: 120,
										overflow: 'auto',
									}}>
										<div style={{
											fontSize: 12,
											color: '#8892b0',
											lineHeight: 1.5,
											whiteSpace: 'pre-wrap',
										}}>
											{generatedContent?.slice(0, 200)}
											{(generatedContent?.length ?? 0) > 200 && '...'}
										</div>
									</div>

									{/* Schedule option */}
									<div style={{ marginBottom: 20 }}>
										<label style={{
											display: 'block',
											fontFamily: "'Space Mono', monospace",
											fontSize: 10,
											color: '#4a5578',
											marginBottom: 8,
											letterSpacing: 1,
										}}>
											SCHEDULE (OPTIONAL)
										</label>
										<input
											type="datetime-local"
											value={scheduledTime}
											onChange={(e) => setScheduledTime(e.target.value)}
											style={{
												width: '100%',
												padding: '10px 12px',
												borderRadius: 6,
												border: '1px solid #1e2538',
												background: '#0a0d14',
												color: '#e2e8f0',
												fontSize: 13,
												fontFamily: "'Space Mono', monospace",
												outline: 'none',
											}}
										/>
										<p style={{
											fontSize: 11,
											color: '#4a5578',
											marginTop: 6,
										}}>
											Leave empty to publish immediately
										</p>
									</div>

									{/* Action buttons */}
									<div style={{ display: 'flex', gap: 10 }}>
										<button
											onClick={() => setShowPublishModal(false)}
											style={{
												flex: 1,
												padding: '12px',
												borderRadius: 8,
												border: '1px solid #1e2538',
												background: 'transparent',
												color: '#8892b0',
												cursor: 'pointer',
												fontFamily: "'Space Mono', monospace",
												fontSize: 12,
												letterSpacing: 0.5,
											}}
											type="button"
										>
											Cancel
										</button>
										<button
											onClick={handlePublishConfirm}
											style={{
												flex: 1,
												padding: '12px',
												borderRadius: 8,
												border: 'none',
												background: '#2D6A4F',
												color: '#ffffff',
												cursor: 'pointer',
												fontFamily: "'Space Mono', monospace",
												fontSize: 12,
												fontWeight: 700,
												letterSpacing: 0.5,
											}}
											type="button"
										>
											{scheduledTime ? 'Schedule' : 'Publish Now'}
										</button>
									</div>
								</>
							)}

							{publishStatus === 'publishing' && (
								<div style={{ textAlign: 'center', padding: '20px 0' }}>
									<div style={{
										fontFamily: "'Space Mono', monospace",
										fontSize: 12,
										color: '#2D6A4F',
										letterSpacing: 2,
										background: 'linear-gradient(90deg, #2D6A4F, #4a9e7a, #2D6A4F)',
										backgroundSize: '200% auto',
										WebkitBackgroundClip: 'text',
										WebkitTextFillColor: 'transparent',
										animation: 'shimmer 2s linear infinite',
									}}>
										SENDING TO MAKE.COM...
									</div>
								</div>
							)}

							{publishStatus === 'success' && (
								<div style={{ textAlign: 'center', padding: '20px 0' }}>
									<div style={{ fontSize: 48, marginBottom: 16 }}>✓</div>
									<div style={{
										fontFamily: "'Space Mono', monospace",
										fontSize: 12,
										color: '#2D6A4F',
										letterSpacing: 1,
										marginBottom: 12,
									}}>
										SUCCESS
									</div>
									<p style={{ fontSize: 14, color: '#8892b0', marginBottom: 20 }}>
										{publishMessage}
									</p>
									<button
										onClick={() => setShowPublishModal(false)}
										style={{
											padding: '12px 24px',
											borderRadius: 8,
											border: 'none',
											background: '#2D6A4F',
											color: '#ffffff',
											cursor: 'pointer',
											fontFamily: "'Space Mono', monospace",
											fontSize: 12,
											letterSpacing: 0.5,
										}}
										type="button"
									>
										Done
									</button>
								</div>
							)}

							{publishStatus === 'error' && (
								<div style={{ textAlign: 'center', padding: '20px 0' }}>
									<div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
									<div style={{
										fontFamily: "'Space Mono', monospace",
										fontSize: 12,
										color: '#f87171',
										letterSpacing: 1,
										marginBottom: 12,
									}}>
										PUBLISHING FAILED
									</div>
									<p style={{ fontSize: 14, color: '#8892b0', marginBottom: 20 }}>
										{publishMessage}
									</p>
									<div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
										<button
											onClick={() => setShowPublishModal(false)}
											style={{
												padding: '12px 24px',
												borderRadius: 8,
												border: '1px solid #1e2538',
												background: 'transparent',
												color: '#8892b0',
												cursor: 'pointer',
												fontFamily: "'Space Mono', monospace",
												fontSize: 12,
												letterSpacing: 0.5,
											}}
											type="button"
										>
											Close
										</button>
										<button
											onClick={() => setPublishStatus('idle')}
											style={{
												padding: '12px 24px',
												borderRadius: 8,
												border: 'none',
												background: '#2D6A4F',
												color: '#ffffff',
												cursor: 'pointer',
												fontFamily: "'Space Mono', monospace",
												fontSize: 12,
												letterSpacing: 0.5,
											}}
											type="button"
										>
											Try Again
										</button>
									</div>
								</div>
							)}
						</div>
					</div>
				)}
			</div>
		</>
	);
}
