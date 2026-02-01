import { useAnalytics } from '@agentuity/react';
import { type ChangeEvent, useCallback, useState } from 'react';
import './App.css';

const PLATFORMS = ['Instagram', 'Facebook', 'LinkedIn', 'Twitter'] as const;

type Platform = (typeof PLATFORMS)[number];

interface GenerationResult {
	intent: string;
	message: string;
	routed_to: string;
	result?: {
		content: string;
		platform: string;
	};
}

export function App() {
	const [topic, setTopic] = useState('');
	const [platform, setPlatform] = useState<Platform>('Instagram');
	const [isLoading, setIsLoading] = useState(false);
	const [result, setResult] = useState<GenerationResult | null>(null);
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const { track } = useAnalytics();

	const handleGenerate = useCallback(async () => {
		if (!topic.trim()) return;

		setIsLoading(true);
		setError(null);
		setResult(null);

		track('generate_content', { topic, platform });

		try {
			const response = await fetch('/api/manager', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					topic: `${topic} (Platform: ${platform}, Tone: Inspirational)`,
					description: '',
				}),
			});

			if (!response.ok) {
				throw new Error('Failed to generate content');
			}

			const data = await response.json();
			setResult(data);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Something went wrong');
		} finally {
			setIsLoading(false);
		}
	}, [platform, topic, track]);

	const handleCopy = useCallback(async () => {
		const content = result?.result?.content;
		if (!content) return;

		await navigator.clipboard.writeText(content);
		setCopied(true);
		track('copy_content');
		setTimeout(() => setCopied(false), 2000);
	}, [result, track]);

	const handleSendToMake = useCallback(() => {
		track('send_to_make');
		alert('Make.com integration coming soon');
	}, [track]);

	const generatedContent = result?.result?.content || '';
	const charCount = generatedContent.length;
	const platformLimits: Record<Platform, number> = {
		Twitter: 280,
		Instagram: 2200,
		Facebook: 63206,
		LinkedIn: 3000,
	};

	return (
		<div className="app-root min-h-screen text-slate-900">
			<div className="mx-auto w-full max-w-[720px] p-16">
				<header className="mb-16">
					<h1 className="gradient-text text-[36px] font-bold leading-[1.1] tracking-[-0.03em]">
						Content Studio
					</h1>
					<p className="mt-3 text-[16px] text-slate-500">
						AI-powered content in Kimberly&apos;s voice
					</p>
				</header>

				<div className="space-y-8">
					<div className="space-y-3">
						<label
							className="text-[13px] font-medium text-slate-600"
							htmlFor="topic-input"
						>
							Topic
						</label>
						<textarea
							id="topic-input"
							disabled={isLoading}
							onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
								setTopic(event.target.value)
							}
							placeholder="What do you want to write about?"
							value={topic}
							className={`app-textarea h-[180px] w-full resize-y px-5 py-4 text-[15px] leading-[1.6] text-slate-900 transition-all ${
								isLoading ? 'is-loading' : ''
							}`}
						/>
					</div>

					<div className="space-y-3">
						<label className="text-[13px] font-medium text-slate-600">Platform</label>
						<div className="platform-tabs inline-flex items-center gap-1">
							{PLATFORMS.map((item) => {
								const isActive = platform === item;
								return (
									<button
										key={item}
										type="button"
										onClick={() => setPlatform(item)}
										disabled={isLoading}
										data-active={isActive ? 'true' : 'false'}
										className={`platform-tab ${isActive ? 'is-active' : ''}`}
									>
										{item}
									</button>
								);
							})}
						</div>
					</div>

					{error && (
						<div className="rounded-[10px] border border-red-200 bg-red-50 px-5 py-4">
							<p className="text-[14px] text-red-700">{error}</p>
						</div>
					)}

					<button
						disabled={isLoading || !topic.trim()}
						onClick={handleGenerate}
						type="button"
						className={`generate-button ${isLoading ? 'is-pulsing' : ''}`}
					>
						{isLoading ? 'Generating...' : 'Generate Content'}
					</button>
				</div>

				{(generatedContent || isLoading) && (
					<section className="results-card mt-12">
						<div className="mb-6 flex items-center justify-between">
							<span className="text-[13px] font-medium text-slate-500">
								Generated Content
							</span>
							{generatedContent && (
								<span className="text-[13px] text-slate-400">
									{charCount.toLocaleString()} /{' '}
									{platformLimits[platform].toLocaleString()}
								</span>
							)}
						</div>

						{isLoading ? (
							<div className="space-y-3">
								<div className="skeleton-line h-4 w-11/12" />
								<div className="skeleton-line h-4 w-10/12" />
								<div className="skeleton-line h-4 w-9/12" />
								<div className="skeleton-line h-4 w-7/12" />
								<div className="skeleton-line h-4 w-8/12" />
								<div className="skeleton-line h-4 w-5/12" />
							</div>
						) : (
							<>
								<div className="mb-7 whitespace-pre-wrap text-[16px] leading-[1.7] text-slate-900">
									{generatedContent}
								</div>
								<div className="flex gap-3">
									<button
										onClick={handleCopy}
										type="button"
										className="secondary-button flex-1"
									>
										{copied ? 'Copied!' : 'Copy to Clipboard'}
									</button>
									<button
										onClick={handleSendToMake}
										type="button"
										className="secondary-button primary flex-1"
									>
										Send to Make.com
									</button>
								</div>
							</>
						)}
					</section>
				)}
			</div>

			<style>{`
				.app-root {
					font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
						"Helvetica Neue", Arial, sans-serif;
					background: radial-gradient(circle at center, #fafafa 0%, #f5f5f5 100%);
				}

				.gradient-text {
					background: linear-gradient(135deg, #1e40af 0%, #7c3aed 100%);
					-webkit-background-clip: text;
					background-clip: text;
					-webkit-text-fill-color: transparent;
				}

				.app-textarea {
					background: rgba(255, 255, 255, 0.8);
					border: 1px solid rgba(0, 0, 0, 0.06);
					border-radius: 12px;
					box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02),
						0 4px 8px rgba(0, 0, 0, 0.02),
						0 8px 16px rgba(0, 0, 0, 0.02);
					backdrop-filter: blur(20px);
					-webkit-backdrop-filter: blur(20px);
					transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
				}

				.app-textarea:focus {
					border-color: #3b82f6;
					box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.16),
						0 4px 12px rgba(0, 0, 0, 0.04),
						0 8px 20px rgba(0, 0, 0, 0.04);
					outline: none;
				}

				.app-textarea.is-loading {
					background-image: linear-gradient(
						90deg,
						rgba(255, 255, 255, 0.7) 0%,
						rgba(255, 255, 255, 0.95) 45%,
						rgba(255, 255, 255, 0.7) 100%
					);
					background-size: 200% 100%;
					animation: shimmer 1.4s ease-in-out infinite;
				}

				.platform-tabs {
					background: #f3f4f6;
					padding: 4px;
					border-radius: 10px;
				}

				.platform-tab {
					padding: 10px 20px;
					border-radius: 8px;
					font-size: 14px;
					font-weight: 500;
					color: #6b7280;
					background: transparent;
					transition: all 0.2s ease;
				}

				.platform-tab.is-active {
					background: #ffffff;
					color: #111827;
					box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
				}

				.platform-tab:hover:not(:disabled) {
					transform: scale(1.02);
				}

				.generate-button {
					height: 56px;
					border-radius: 12px;
					font-size: 16px;
					font-weight: 600;
					color: #ffffff;
					background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
					box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3),
						0 8px 24px rgba(139, 92, 246, 0.2);
					transition: all 0.3s ease;
					width: 100%;
				}

				.generate-button:hover:not(:disabled) {
					transform: translateY(-2px);
					box-shadow: 0 8px 18px rgba(59, 130, 246, 0.35),
						0 16px 32px rgba(139, 92, 246, 0.28);
				}

				.generate-button:active:not(:disabled) {
					transform: translateY(0);
				}

				.generate-button:disabled {
					opacity: 0.65;
					cursor: not-allowed;
				}

				.generate-button.is-pulsing {
					animation: pulse 1.6s ease-in-out infinite;
				}

				.results-card {
					background: #ffffff;
					border: 1px solid rgba(0, 0, 0, 0.06);
					border-radius: 16px;
					padding: 32px;
					box-shadow: 0 2px 4px rgba(0, 0, 0, 0.02),
						0 8px 16px rgba(0, 0, 0, 0.03),
						0 16px 32px rgba(0, 0, 0, 0.04);
					animation: card-in 0.45s ease forwards;
				}

				.secondary-button {
					height: 44px;
					border-radius: 10px;
					border: 1px solid rgba(15, 23, 42, 0.08);
					background: #ffffff;
					color: #374151;
					font-size: 14px;
					font-weight: 500;
					transition: all 0.2s ease;
				}

				.secondary-button:hover:not(:disabled) {
					background: #f8fafc;
					border-color: rgba(15, 23, 42, 0.16);
					transform: translateY(-1px);
				}

				.secondary-button.primary {
					background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
					color: #ffffff;
					border: none;
					box-shadow: 0 4px 12px rgba(59, 130, 246, 0.2);
				}

				.secondary-button.primary:hover:not(:disabled) {
					box-shadow: 0 8px 18px rgba(59, 130, 246, 0.28);
				}

				.skeleton-line {
					border-radius: 999px;
					background: linear-gradient(90deg, #f1f5f9 0%, #e2e8f0 50%, #f1f5f9 100%);
					background-size: 200% 100%;
					animation: shimmer 1.3s ease-in-out infinite;
				}

				@keyframes shimmer {
					0% {
						background-position: 0% 50%;
					}
					100% {
						background-position: 200% 50%;
					}
				}

				@keyframes pulse {
					0%,
					100% {
						transform: translateY(0);
					}
					50% {
						transform: translateY(-1px);
					}
				}

				@keyframes card-in {
					0% {
						opacity: 0;
						transform: translateY(12px);
					}
					100% {
						opacity: 1;
						transform: translateY(0);
					}
				}

				::placeholder {
					color: #9ca3af;
				}

				textarea:focus::placeholder {
					color: #d1d5db;
				}
			`}</style>
		</div>
	);
}
