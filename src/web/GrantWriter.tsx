import { useCallback, useState, type ChangeEvent } from 'react';

interface GrantResult {
	content: string;
	grantType: string;
	wordCount: number;
	estimatedReadTime: string;
	suggestions?: string[];
	missingInfo?: string[];
	sections?: { title: string; content: string }[];
}

const GRANT_TYPES = [
	{ id: 'loi', label: 'Letter of Intent', description: '1-2 page introduction to your proposal', icon: '✉️' },
	{ id: 'executive-summary', label: 'Executive Summary', description: 'Stand-alone 1-page overview', icon: '📄' },
	{ id: 'full-proposal', label: 'Full Proposal', description: 'Complete 5-10 page grant application', icon: '📋' },
	{ id: 'budget-narrative', label: 'Budget Narrative', description: 'Explanation of your budget', icon: '💰' },
	{ id: 'impact-report', label: 'Impact Report', description: 'Report on grant outcomes', icon: '📊' },
	{ id: 'thank-you-letter', label: 'Thank You Letter', description: 'Post-award gratitude letter', icon: '🙏' },
];

const FUNDER_FOCUSES = [
	'Youth Development',
	'Education',
	'Sports & Health',
	'Community Development',
	'Workforce Development',
	'Arts & Culture',
	'Racial Equity',
	'General Operating',
];

interface GrantWriterProps {
	onBack: () => void;
}

export function GrantWriter({ onBack }: GrantWriterProps) {
	const [step, setStep] = useState<'type' | 'details' | 'generating' | 'result'>('type');

	// Grant type
	const [grantType, setGrantType] = useState<string>('');

	// Funder info
	const [funderName, setFunderName] = useState('');
	const [funderFocus, setFunderFocus] = useState('');
	const [askAmount, setAskAmount] = useState<string>('');

	// Project info
	const [projectName, setProjectName] = useState('');
	const [projectDescription, setProjectDescription] = useState('');
	const [targetPopulation, setTargetPopulation] = useState('');
	const [timeline, setTimeline] = useState('');

	// Requirements
	const [wordLimit, setWordLimit] = useState<string>('');
	const [specificQuestions, setSpecificQuestions] = useState('');

	// Result
	const [result, setResult] = useState<GrantResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	const handleGenerate = useCallback(async () => {
		setStep('generating');
		setError(null);

		try {
			const response = await fetch('/api/grant-writer', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					grantType,
					funderName: funderName || undefined,
					funderFocus: funderFocus || undefined,
					askAmount: askAmount ? Number(askAmount) : undefined,
					projectName: projectName || undefined,
					projectDescription,
					targetPopulation: targetPopulation || undefined,
					timeline: timeline || undefined,
					wordLimit: wordLimit ? Number(wordLimit) : undefined,
					specificQuestions: specificQuestions
						? specificQuestions.split('\n').filter((q) => q.trim())
						: undefined,
				}),
			});

			if (!response.ok) {
				throw new Error('Failed to generate grant content');
			}

			const data = await response.json();
			setResult(data);
			setStep('result');
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Something went wrong');
			setStep('details');
		}
	}, [grantType, funderName, funderFocus, askAmount, projectName, projectDescription, targetPopulation, timeline, wordLimit, specificQuestions]);

	const handleCopy = useCallback(() => {
		if (!result) return;
		navigator.clipboard?.writeText(result.content);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	}, [result]);

	const handleReset = useCallback(() => {
		setStep('type');
		setGrantType('');
		setFunderName('');
		setFunderFocus('');
		setAskAmount('');
		setProjectName('');
		setProjectDescription('');
		setTargetPopulation('');
		setTimeline('');
		setWordLimit('');
		setSpecificQuestions('');
		setResult(null);
	}, []);

	return (
		<div style={{
			minHeight: '100vh',
			background: '#0a0d14',
			color: '#e2e8f0',
			fontFamily: "'Source Serif 4', Georgia, serif",
		}}>
			{/* Header */}
			<header style={{
				padding: '24px 40px',
				borderBottom: '1px solid #141824',
			}}>
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
				<h1 style={{
					fontSize: 22,
					fontWeight: 700,
					letterSpacing: '-0.02em',
					color: '#ffffff',
				}}>
					Grant Writer
				</h1>
				<p style={{
					fontFamily: "'Space Mono', monospace",
					fontSize: 11,
					color: '#4a5578',
					marginTop: 4,
					letterSpacing: 0.5,
				}}>
					Generate proposals, LOIs, and funding narratives
				</p>
			</header>

			<main style={{ padding: '32px 40px', maxWidth: 800, margin: '0 auto' }}>
				{/* Step: Type Selection */}
				{step === 'type' && (
					<div style={{ animation: 'fadeSlideUp 0.4s ease-out' }}>
						<h2 style={{ fontSize: 24, fontWeight: 300, marginBottom: 8 }}>
							What do you need?
						</h2>
						<p style={{ color: '#4a5578', fontSize: 14, marginBottom: 24 }}>
							Select the type of grant document to generate.
						</p>

						<div style={{
							display: 'grid',
							gridTemplateColumns: 'repeat(2, 1fr)',
							gap: 12,
						}}>
							{GRANT_TYPES.map((type) => (
								<button
									key={type.id}
									onClick={() => {
										setGrantType(type.id);
										setStep('details');
									}}
									style={{
										padding: '20px 16px',
										borderRadius: 10,
										border: '1px solid #1e2538',
										background: '#111520',
										cursor: 'pointer',
										textAlign: 'left' as const,
										transition: 'all 0.2s',
									}}
									onMouseEnter={(e) => {
										e.currentTarget.style.borderColor = '#2D6A4F';
										e.currentTarget.style.background = '#141824';
									}}
									onMouseLeave={(e) => {
										e.currentTarget.style.borderColor = '#1e2538';
										e.currentTarget.style.background = '#111520';
									}}
									type="button"
								>
									<div style={{ fontSize: 24, marginBottom: 8 }}>{type.icon}</div>
									<div style={{
										fontFamily: "'Space Mono', monospace",
										fontSize: 12,
										fontWeight: 700,
										color: '#e2e8f0',
										marginBottom: 4,
									}}>
										{type.label}
									</div>
									<div style={{
										fontFamily: "'Space Mono', monospace",
										fontSize: 10,
										color: '#4a5578',
									}}>
										{type.description}
									</div>
								</button>
							))}
						</div>
					</div>
				)}

				{/* Step: Details */}
				{step === 'details' && (
					<div style={{ animation: 'fadeSlideUp 0.4s ease-out' }}>
						<button
							onClick={() => setStep('type')}
							style={{
								background: 'none',
								border: 'none',
								color: '#4a5578',
								cursor: 'pointer',
								fontFamily: "'Space Mono', monospace",
								fontSize: 11,
								marginBottom: 16,
								letterSpacing: 0.5,
								padding: 0,
							}}
							type="button"
						>
							← Back
						</button>

						<h2 style={{ fontSize: 24, fontWeight: 300, marginBottom: 24 }}>
							{GRANT_TYPES.find((t) => t.id === grantType)?.icon}{' '}
							{GRANT_TYPES.find((t) => t.id === grantType)?.label}
						</h2>

						{error && (
							<div style={{
								marginBottom: 20,
								padding: '12px 16px',
								borderRadius: 8,
								background: '#2d1a1a',
								border: '1px solid #5c2626',
								color: '#f87171',
								fontSize: 13,
							}}>
								{error}
							</div>
						)}

						{/* Funder Info Section */}
						<div style={{
							background: '#111520',
							border: '1px solid #1e2538',
							borderRadius: 10,
							padding: 20,
							marginBottom: 16,
						}}>
							<div style={{
								fontFamily: "'Space Mono', monospace",
								fontSize: 10,
								letterSpacing: 2,
								textTransform: 'uppercase' as const,
								color: '#2D6A4F',
								marginBottom: 16,
							}}>
								FUNDER INFORMATION
							</div>

							<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
								<div>
									<label style={{
										display: 'block',
										fontFamily: "'Space Mono', monospace",
										fontSize: 10,
										color: '#4a5578',
										marginBottom: 6,
									}}>
										Funder Name
									</label>
									<input
										type="text"
										value={funderName}
										onChange={(e) => setFunderName(e.target.value)}
										placeholder="e.g., Ford Foundation"
										style={{
											width: '100%',
											padding: '10px 12px',
											borderRadius: 6,
											border: '1px solid #1e2538',
											background: '#0a0d14',
											color: '#e2e8f0',
											fontSize: 13,
											outline: 'none',
										}}
									/>
								</div>
								<div>
									<label style={{
										display: 'block',
										fontFamily: "'Space Mono', monospace",
										fontSize: 10,
										color: '#4a5578',
										marginBottom: 6,
									}}>
										Ask Amount
									</label>
									<input
										type="number"
										value={askAmount}
										onChange={(e) => setAskAmount(e.target.value)}
										placeholder="e.g., 50000"
										style={{
											width: '100%',
											padding: '10px 12px',
											borderRadius: 6,
											border: '1px solid #1e2538',
											background: '#0a0d14',
											color: '#e2e8f0',
											fontSize: 13,
											outline: 'none',
										}}
									/>
								</div>
							</div>

							<div>
								<label style={{
									display: 'block',
									fontFamily: "'Space Mono', monospace",
									fontSize: 10,
									color: '#4a5578',
									marginBottom: 6,
								}}>
									Funder Focus Area
								</label>
								<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
									{FUNDER_FOCUSES.map((focus) => (
										<button
											key={focus}
											onClick={() => setFunderFocus(focus)}
											style={{
												padding: '6px 12px',
												borderRadius: 6,
												border: funderFocus === focus ? '1px solid #2D6A4F' : '1px solid #1e2538',
												background: funderFocus === focus ? '#2D6A4F20' : 'transparent',
												color: funderFocus === focus ? '#4a9e7a' : '#8892b0',
												cursor: 'pointer',
												fontFamily: "'Space Mono', monospace",
												fontSize: 10,
											}}
											type="button"
										>
											{focus}
										</button>
									))}
								</div>
							</div>
						</div>

						{/* Project Info Section */}
						<div style={{
							background: '#111520',
							border: '1px solid #1e2538',
							borderRadius: 10,
							padding: 20,
							marginBottom: 16,
						}}>
							<div style={{
								fontFamily: "'Space Mono', monospace",
								fontSize: 10,
								letterSpacing: 2,
								textTransform: 'uppercase' as const,
								color: '#E67E22',
								marginBottom: 16,
							}}>
								PROJECT DETAILS
							</div>

							<div style={{ marginBottom: 12 }}>
								<label style={{
									display: 'block',
									fontFamily: "'Space Mono', monospace",
									fontSize: 10,
									color: '#4a5578',
									marginBottom: 6,
								}}>
									Project Name (Optional)
								</label>
								<input
									type="text"
									value={projectName}
									onChange={(e) => setProjectName(e.target.value)}
									placeholder="e.g., Summer Tennis & Chess Academy 2024"
									style={{
										width: '100%',
										padding: '10px 12px',
										borderRadius: 6,
										border: '1px solid #1e2538',
										background: '#0a0d14',
										color: '#e2e8f0',
										fontSize: 13,
										outline: 'none',
									}}
								/>
							</div>

							<div style={{ marginBottom: 12 }}>
								<label style={{
									display: 'block',
									fontFamily: "'Space Mono', monospace",
									fontSize: 10,
									color: '#4a5578',
									marginBottom: 6,
								}}>
									Project Description *
								</label>
								<textarea
									value={projectDescription}
									onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setProjectDescription(e.target.value)}
									placeholder="Describe what you're seeking funding for..."
									rows={4}
									style={{
										width: '100%',
										padding: '10px 12px',
										borderRadius: 6,
										border: '1px solid #1e2538',
										background: '#0a0d14',
										color: '#e2e8f0',
										fontSize: 13,
										outline: 'none',
										resize: 'vertical',
									}}
								/>
							</div>

							<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
								<div>
									<label style={{
										display: 'block',
										fontFamily: "'Space Mono', monospace",
										fontSize: 10,
										color: '#4a5578',
										marginBottom: 6,
									}}>
										Target Population
									</label>
									<input
										type="text"
										value={targetPopulation}
										onChange={(e) => setTargetPopulation(e.target.value)}
										placeholder="e.g., Youth ages 8-14 in Hempstead"
										style={{
											width: '100%',
											padding: '10px 12px',
											borderRadius: 6,
											border: '1px solid #1e2538',
											background: '#0a0d14',
											color: '#e2e8f0',
											fontSize: 13,
											outline: 'none',
										}}
									/>
								</div>
								<div>
									<label style={{
										display: 'block',
										fontFamily: "'Space Mono', monospace",
										fontSize: 10,
										color: '#4a5578',
										marginBottom: 6,
									}}>
										Timeline
									</label>
									<input
										type="text"
										value={timeline}
										onChange={(e) => setTimeline(e.target.value)}
										placeholder="e.g., 12 months, June 2024 - May 2025"
										style={{
											width: '100%',
											padding: '10px 12px',
											borderRadius: 6,
											border: '1px solid #1e2538',
											background: '#0a0d14',
											color: '#e2e8f0',
											fontSize: 13,
											outline: 'none',
										}}
									/>
								</div>
							</div>
						</div>

						{/* Requirements Section */}
						<div style={{
							background: '#111520',
							border: '1px solid #1e2538',
							borderRadius: 10,
							padding: 20,
							marginBottom: 20,
						}}>
							<div style={{
								fontFamily: "'Space Mono', monospace",
								fontSize: 10,
								letterSpacing: 2,
								textTransform: 'uppercase' as const,
								color: '#9B59B6',
								marginBottom: 16,
							}}>
								REQUIREMENTS (OPTIONAL)
							</div>

							<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
								<div>
									<label style={{
										display: 'block',
										fontFamily: "'Space Mono', monospace",
										fontSize: 10,
										color: '#4a5578',
										marginBottom: 6,
									}}>
										Word Limit
									</label>
									<input
										type="number"
										value={wordLimit}
										onChange={(e) => setWordLimit(e.target.value)}
										placeholder="e.g., 500"
										style={{
											width: '100%',
											padding: '10px 12px',
											borderRadius: 6,
											border: '1px solid #1e2538',
											background: '#0a0d14',
											color: '#e2e8f0',
											fontSize: 13,
											outline: 'none',
										}}
									/>
								</div>
							</div>

							<div>
								<label style={{
									display: 'block',
									fontFamily: "'Space Mono', monospace",
									fontSize: 10,
									color: '#4a5578',
									marginBottom: 6,
								}}>
									Specific Questions to Answer (one per line)
								</label>
								<textarea
									value={specificQuestions}
									onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setSpecificQuestions(e.target.value)}
									placeholder="Enter any specific questions the funder asks..."
									rows={3}
									style={{
										width: '100%',
										padding: '10px 12px',
										borderRadius: 6,
										border: '1px solid #1e2538',
										background: '#0a0d14',
										color: '#e2e8f0',
										fontSize: 13,
										outline: 'none',
										resize: 'vertical',
									}}
								/>
							</div>
						</div>

						<button
							onClick={handleGenerate}
							disabled={!projectDescription}
							style={{
								width: '100%',
								padding: '14px',
								borderRadius: 8,
								border: 'none',
								background: projectDescription ? '#2D6A4F' : '#1e2538',
								color: projectDescription ? '#ffffff' : '#4a5578',
								cursor: projectDescription ? 'pointer' : 'not-allowed',
								fontFamily: "'Space Mono', monospace",
								fontSize: 12,
								fontWeight: 700,
								letterSpacing: 0.5,
							}}
							type="button"
						>
							Generate {GRANT_TYPES.find((t) => t.id === grantType)?.label} →
						</button>
					</div>
				)}

				{/* Step: Generating */}
				{step === 'generating' && (
					<div style={{
						textAlign: 'center',
						padding: '60px 0',
						animation: 'fadeSlideUp 0.4s ease-out',
					}}>
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
							WRITING YOUR {GRANT_TYPES.find((t) => t.id === grantType)?.label.toUpperCase()}...
						</div>
						<p style={{ color: '#4a5578', fontSize: 14, marginTop: 12 }}>
							Crafting compelling language in Kimberly's voice
						</p>
					</div>
				)}

				{/* Step: Result */}
				{step === 'result' && result && (
					<div style={{ animation: 'fadeSlideUp 0.4s ease-out' }}>
						<div style={{ marginBottom: 24 }}>
							<h2 style={{ fontSize: 24, fontWeight: 300, marginBottom: 8 }}>
								Your {GRANT_TYPES.find((t) => t.id === grantType)?.label}
							</h2>
							<p style={{
								fontFamily: "'Space Mono', monospace",
								fontSize: 11,
								color: '#4a5578',
							}}>
								{result.wordCount} words • {result.estimatedReadTime}
							</p>
						</div>

						{/* Suggestions */}
						{result.suggestions && result.suggestions.length > 0 && (
							<div style={{
								background: '#1a2a1a',
								border: '1px solid #2D6A4F40',
								borderRadius: 10,
								padding: 16,
								marginBottom: 16,
							}}>
								<div style={{
									fontFamily: "'Space Mono', monospace",
									fontSize: 10,
									letterSpacing: 1,
									color: '#4a9e7a',
									marginBottom: 10,
								}}>
									💡 SUGGESTIONS TO STRENGTHEN
								</div>
								<ul style={{ margin: 0, paddingLeft: 20, color: '#8892b0', fontSize: 13, lineHeight: 1.6 }}>
									{result.suggestions.map((s, i) => (
										<li key={i}>{s}</li>
									))}
								</ul>
							</div>
						)}

						{/* Missing Info */}
						{result.missingInfo && result.missingInfo.length > 0 && (
							<div style={{
								background: '#2a2a1a',
								border: '1px solid #E67E2240',
								borderRadius: 10,
								padding: 16,
								marginBottom: 16,
							}}>
								<div style={{
									fontFamily: "'Space Mono', monospace",
									fontSize: 10,
									letterSpacing: 1,
									color: '#E67E22',
									marginBottom: 10,
								}}>
									📝 CONSIDER ADDING
								</div>
								<ul style={{ margin: 0, paddingLeft: 20, color: '#8892b0', fontSize: 13, lineHeight: 1.6 }}>
									{result.missingInfo.map((info, i) => (
										<li key={i}>{info}</li>
									))}
								</ul>
							</div>
						)}

						{/* Content */}
						<div style={{
							background: '#111520',
							border: '1px solid #1e2538',
							borderRadius: 12,
							padding: 24,
							marginBottom: 16,
						}}>
							<div style={{
								display: 'flex',
								justifyContent: 'space-between',
								alignItems: 'center',
								marginBottom: 16,
							}}>
								<span style={{
									fontFamily: "'Space Mono', monospace",
									fontSize: 10,
									letterSpacing: 2,
									textTransform: 'uppercase' as const,
									color: '#4a5578',
								}}>
									{grantType.toUpperCase().replace('-', ' ')}
								</span>
								<button
									onClick={handleCopy}
									style={{
										padding: '8px 16px',
										borderRadius: 6,
										border: '1px solid #2D6A4F',
										background: 'transparent',
										color: '#2D6A4F',
										cursor: 'pointer',
										fontFamily: "'Space Mono', monospace",
										fontSize: 11,
									}}
									type="button"
								>
									{copied ? '✓ Copied' : 'Copy to Clipboard'}
								</button>
							</div>
							<div style={{
								color: '#e2e8f0',
								fontSize: 14,
								lineHeight: 1.8,
								whiteSpace: 'pre-wrap',
								fontFamily: "'Source Serif 4', Georgia, serif",
							}}>
								{result.content}
							</div>
						</div>

						<div style={{ display: 'flex', gap: 10 }}>
							<button
								onClick={() => setStep('details')}
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
								}}
								type="button"
							>
								← Edit & Regenerate
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
								}}
								type="button"
							>
								🆕 New Document
							</button>
						</div>
					</div>
				)}
			</main>

			<style>{`
				@keyframes fadeSlideUp {
					from { opacity: 0; transform: translateY(12px); }
					to { opacity: 1; transform: translateY(0); }
				}
				@keyframes shimmer {
					0% { background-position: -200% center; }
					100% { background-position: 200% center; }
				}
			`}</style>
		</div>
	);
}
