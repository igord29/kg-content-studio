import { useCallback, useState, type ChangeEvent } from 'react';

interface Prospect {
	name: string;
	type: string;
	description: string;
	givingAreas: string[];
	typicalGiftRange?: string;
	location?: string;
	website?: string;
	relevanceScore: number;
	relevanceReason: string;
	suggestedApproach: string;
	redFlags?: string[];
}

interface Profile {
	name: string;
	overview: string;
	givingHistory: string;
	priorities: string[];
	decisionMakers?: { name: string; role: string; notes?: string }[];
	applicationProcess?: string;
	deadlines?: string[];
	previousGrants?: { recipient: string; amount?: string; year?: string }[];
	alignmentAnalysis: string;
	suggestedAsk: string;
	cultivationStrategy: string;
}

interface ConnectionMap {
	target: string;
	pathways: { path: string[]; strength: string; notes: string }[];
	suggestedIntroductions: string[];
}

interface ResearchResult {
	prospects?: Prospect[];
	profile?: Profile;
	connectionMap?: ConnectionMap;
	searchType: string;
	resultsCount: number;
	searchCriteria: string;
}

const PROSPECT_TYPES = [
	{ id: 'foundation', label: 'Foundation', icon: '🏛️' },
	{ id: 'corporation', label: 'Corporation', icon: '🏢' },
	{ id: 'individual', label: 'Individual', icon: '👤' },
	{ id: 'government', label: 'Government', icon: '🏛️' },
	{ id: 'family-office', label: 'Family Office', icon: '👨‍👩‍👧' },
];

const GIVING_AREAS = [
	{ id: 'youth-development', label: 'Youth Development' },
	{ id: 'education', label: 'Education' },
	{ id: 'sports', label: 'Sports & Athletics' },
	{ id: 'community-development', label: 'Community Development' },
	{ id: 'workforce', label: 'Workforce Development' },
	{ id: 'racial-equity', label: 'Racial Equity' },
];

interface DonorResearcherProps {
	onBack: () => void;
}

export function DonorResearcher({ onBack }: DonorResearcherProps) {
	const [step, setStep] = useState<'mode' | 'search' | 'deep-dive' | 'connections' | 'generating' | 'result'>('mode');
	const [searchType, setSearchType] = useState<'prospect-search' | 'deep-dive' | 'connection-map'>('prospect-search');

	// Prospect search state
	const [prospectType, setProspectType] = useState('');
	const [givingArea, setGivingArea] = useState('');
	const [location, setLocation] = useState('New York, Connecticut, New Jersey');
	const [minGiftSize, setMinGiftSize] = useState('');
	const [maxGiftSize, setMaxGiftSize] = useState('');
	const [keywords, setKeywords] = useState('');

	// Deep dive state
	const [prospectName, setProspectName] = useState('');
	const [prospectWebsite, setProspectWebsite] = useState('');

	// Connection map state
	const [targetProspect, setTargetProspect] = useState('');
	const [knownConnections, setKnownConnections] = useState('');

	// Result state
	const [result, setResult] = useState<ResearchResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [expandedProspect, setExpandedProspect] = useState<string | null>(null);

	const handleSearch = useCallback(async () => {
		setStep('generating');
		setError(null);

		try {
			const body: Record<string, unknown> = { searchType };

			if (searchType === 'prospect-search') {
				body.prospectType = prospectType || undefined;
				body.givingArea = givingArea || undefined;
				body.location = location || undefined;
				body.minGiftSize = minGiftSize ? Number(minGiftSize) : undefined;
				body.maxGiftSize = maxGiftSize ? Number(maxGiftSize) : undefined;
				body.keywords = keywords ? keywords.split(',').map((k) => k.trim()) : undefined;
			} else if (searchType === 'deep-dive') {
				body.prospectName = prospectName;
				body.prospectWebsite = prospectWebsite || undefined;
			} else if (searchType === 'connection-map') {
				body.targetProspect = targetProspect;
				body.knownConnections = knownConnections ? knownConnections.split(',').map((c) => c.trim()) : undefined;
			}

			const response = await fetch('/api/donor-researcher', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});

			if (!response.ok) {
				throw new Error('Research failed');
			}

			const data = await response.json();
			setResult(data);
			setStep('result');
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Something went wrong');
			setStep(searchType === 'deep-dive' ? 'deep-dive' : searchType === 'connection-map' ? 'connections' : 'search');
		}
	}, [searchType, prospectType, givingArea, location, minGiftSize, maxGiftSize, keywords, prospectName, prospectWebsite, targetProspect, knownConnections]);

	const handleReset = useCallback(() => {
		setStep('mode');
		setResult(null);
		setProspectType('');
		setGivingArea('');
		setProspectName('');
		setProspectWebsite('');
		setTargetProspect('');
		setKnownConnections('');
	}, []);

	const renderScoreBadge = (score: number) => {
		const color = score >= 8 ? '#2D6A4F' : score >= 5 ? '#E67E22' : '#c0392b';
		return (
			<span style={{
				display: 'inline-flex',
				alignItems: 'center',
				justifyContent: 'center',
				width: 28,
				height: 28,
				borderRadius: '50%',
				background: `${color}30`,
				color,
				fontFamily: "'Space Mono', monospace",
				fontSize: 11,
				fontWeight: 700,
			}}>
				{score}
			</span>
		);
	};

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
					Donor Researcher
				</h1>
				<p style={{
					fontFamily: "'Space Mono', monospace",
					fontSize: 11,
					color: '#4a5578',
					marginTop: 4,
					letterSpacing: 0.5,
				}}>
					Find and research potential funders
				</p>
			</header>

			<main style={{ padding: '32px 40px', maxWidth: 900, margin: '0 auto' }}>
				{/* Step: Mode Selection */}
				{step === 'mode' && (
					<div style={{ animation: 'fadeSlideUp 0.4s ease-out' }}>
						<h2 style={{ fontSize: 24, fontWeight: 300, marginBottom: 24 }}>
							What do you need?
						</h2>

						<div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
							<button
								onClick={() => { setSearchType('prospect-search'); setStep('search'); }}
								style={{
									padding: '20px 24px',
									borderRadius: 10,
									border: '1px solid #1e2538',
									background: '#111520',
									cursor: 'pointer',
									textAlign: 'left' as const,
									transition: 'all 0.2s',
								}}
								onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#2D6A4F'; }}
								onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#1e2538'; }}
								type="button"
							>
								<div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
									<span style={{ fontSize: 24 }}>🔍</span>
									<div>
										<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 12, fontWeight: 700, color: '#e2e8f0', marginBottom: 4 }}>
											Find New Prospects
										</div>
										<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, color: '#4a5578' }}>
											Search for foundations, corporations, and individuals by criteria
										</div>
									</div>
								</div>
							</button>

							<button
								onClick={() => { setSearchType('deep-dive'); setStep('deep-dive'); }}
								style={{
									padding: '20px 24px',
									borderRadius: 10,
									border: '1px solid #1e2538',
									background: '#111520',
									cursor: 'pointer',
									textAlign: 'left' as const,
									transition: 'all 0.2s',
								}}
								onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#2D6A4F'; }}
								onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#1e2538'; }}
								type="button"
							>
								<div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
									<span style={{ fontSize: 24 }}>🔬</span>
									<div>
										<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 12, fontWeight: 700, color: '#e2e8f0', marginBottom: 4 }}>
											Deep Dive on a Prospect
										</div>
										<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, color: '#4a5578' }}>
											Get detailed research on a specific foundation or donor
										</div>
									</div>
								</div>
							</button>

							<button
								onClick={() => { setSearchType('connection-map'); setStep('connections'); }}
								style={{
									padding: '20px 24px',
									borderRadius: 10,
									border: '1px solid #1e2538',
									background: '#111520',
									cursor: 'pointer',
									textAlign: 'left' as const,
									transition: 'all 0.2s',
								}}
								onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#2D6A4F'; }}
								onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#1e2538'; }}
								type="button"
							>
								<div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
									<span style={{ fontSize: 24 }}>🕸️</span>
									<div>
										<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 12, fontWeight: 700, color: '#e2e8f0', marginBottom: 4 }}>
											Map Connections
										</div>
										<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, color: '#4a5578' }}>
											Find pathways to reach a target donor
										</div>
									</div>
								</div>
							</button>
						</div>
					</div>
				)}

				{/* Step: Prospect Search */}
				{step === 'search' && (
					<div style={{ animation: 'fadeSlideUp 0.4s ease-out' }}>
						<button onClick={() => setStep('mode')} style={{ background: 'none', border: 'none', color: '#4a5578', cursor: 'pointer', fontFamily: "'Space Mono', monospace", fontSize: 11, marginBottom: 16, padding: 0 }} type="button">← Back</button>

						<h2 style={{ fontSize: 24, fontWeight: 300, marginBottom: 24 }}>🔍 Find Prospects</h2>

						{error && (
							<div style={{ marginBottom: 20, padding: '12px 16px', borderRadius: 8, background: '#2d1a1a', border: '1px solid #5c2626', color: '#f87171', fontSize: 13 }}>
								{error}
							</div>
						)}

						{/* Prospect Type */}
						<div style={{ marginBottom: 20 }}>
							<label style={{ display: 'block', fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 8, letterSpacing: 1, textTransform: 'uppercase' as const }}>
								Prospect Type
							</label>
							<div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
								{PROSPECT_TYPES.map((type) => (
									<button
										key={type.id}
										onClick={() => setProspectType(prospectType === type.id ? '' : type.id)}
										style={{
											padding: '8px 14px',
											borderRadius: 6,
											border: prospectType === type.id ? '1px solid #2D6A4F' : '1px solid #1e2538',
											background: prospectType === type.id ? '#2D6A4F20' : 'transparent',
											color: prospectType === type.id ? '#4a9e7a' : '#8892b0',
											cursor: 'pointer',
											fontFamily: "'Space Mono', monospace",
											fontSize: 11,
										}}
										type="button"
									>
										{type.icon} {type.label}
									</button>
								))}
							</div>
						</div>

						{/* Giving Area */}
						<div style={{ marginBottom: 20 }}>
							<label style={{ display: 'block', fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 8, letterSpacing: 1, textTransform: 'uppercase' as const }}>
								Giving Area Focus
							</label>
							<div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
								{GIVING_AREAS.map((area) => (
									<button
										key={area.id}
										onClick={() => setGivingArea(givingArea === area.id ? '' : area.id)}
										style={{
											padding: '8px 14px',
											borderRadius: 6,
											border: givingArea === area.id ? '1px solid #2D6A4F' : '1px solid #1e2538',
											background: givingArea === area.id ? '#2D6A4F20' : 'transparent',
											color: givingArea === area.id ? '#4a9e7a' : '#8892b0',
											cursor: 'pointer',
											fontFamily: "'Space Mono', monospace",
											fontSize: 11,
										}}
										type="button"
									>
										{area.label}
									</button>
								))}
							</div>
						</div>

						{/* Location & Gift Size */}
						<div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12, marginBottom: 20 }}>
							<div>
								<label style={{ display: 'block', fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 6 }}>Location</label>
								<input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="New York, Connecticut" style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #1e2538', background: '#111520', color: '#e2e8f0', fontSize: 13, outline: 'none' }} />
							</div>
							<div>
								<label style={{ display: 'block', fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 6 }}>Min Gift ($)</label>
								<input type="number" value={minGiftSize} onChange={(e) => setMinGiftSize(e.target.value)} placeholder="5000" style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #1e2538', background: '#111520', color: '#e2e8f0', fontSize: 13, outline: 'none' }} />
							</div>
							<div>
								<label style={{ display: 'block', fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 6 }}>Max Gift ($)</label>
								<input type="number" value={maxGiftSize} onChange={(e) => setMaxGiftSize(e.target.value)} placeholder="100000" style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #1e2538', background: '#111520', color: '#e2e8f0', fontSize: 13, outline: 'none' }} />
							</div>
						</div>

						{/* Keywords */}
						<div style={{ marginBottom: 24 }}>
							<label style={{ display: 'block', fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 6 }}>Keywords (comma-separated)</label>
							<input type="text" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="tennis, chess, mentorship, STEM" style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #1e2538', background: '#111520', color: '#e2e8f0', fontSize: 13, outline: 'none' }} />
						</div>

						<button onClick={handleSearch} style={{ width: '100%', padding: '14px', borderRadius: 8, border: 'none', background: '#2D6A4F', color: '#ffffff', cursor: 'pointer', fontFamily: "'Space Mono', monospace", fontSize: 12, fontWeight: 700 }} type="button">
							Search Prospects →
						</button>
					</div>
				)}

				{/* Step: Deep Dive */}
				{step === 'deep-dive' && (
					<div style={{ animation: 'fadeSlideUp 0.4s ease-out' }}>
						<button onClick={() => setStep('mode')} style={{ background: 'none', border: 'none', color: '#4a5578', cursor: 'pointer', fontFamily: "'Space Mono', monospace", fontSize: 11, marginBottom: 16, padding: 0 }} type="button">← Back</button>

						<h2 style={{ fontSize: 24, fontWeight: 300, marginBottom: 24 }}>🔬 Deep Dive Research</h2>

						{error && (
							<div style={{ marginBottom: 20, padding: '12px 16px', borderRadius: 8, background: '#2d1a1a', border: '1px solid #5c2626', color: '#f87171', fontSize: 13 }}>
								{error}
							</div>
						)}

						<div style={{ marginBottom: 16 }}>
							<label style={{ display: 'block', fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 6 }}>Prospect Name *</label>
							<input type="text" value={prospectName} onChange={(e) => setProspectName(e.target.value)} placeholder="e.g., Robin Hood Foundation" style={{ width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid #1e2538', background: '#111520', color: '#e2e8f0', fontSize: 14, outline: 'none' }} />
						</div>

						<div style={{ marginBottom: 24 }}>
							<label style={{ display: 'block', fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 6 }}>Website (Optional)</label>
							<input type="text" value={prospectWebsite} onChange={(e: ChangeEvent<HTMLInputElement>) => setProspectWebsite(e.target.value)} placeholder="https://..." style={{ width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid #1e2538', background: '#111520', color: '#e2e8f0', fontSize: 14, outline: 'none' }} />
						</div>

						<button onClick={handleSearch} disabled={!prospectName} style={{ width: '100%', padding: '14px', borderRadius: 8, border: 'none', background: prospectName ? '#2D6A4F' : '#1e2538', color: prospectName ? '#ffffff' : '#4a5578', cursor: prospectName ? 'pointer' : 'not-allowed', fontFamily: "'Space Mono', monospace", fontSize: 12, fontWeight: 700 }} type="button">
							Research This Prospect →
						</button>
					</div>
				)}

				{/* Step: Connection Map */}
				{step === 'connections' && (
					<div style={{ animation: 'fadeSlideUp 0.4s ease-out' }}>
						<button onClick={() => setStep('mode')} style={{ background: 'none', border: 'none', color: '#4a5578', cursor: 'pointer', fontFamily: "'Space Mono', monospace", fontSize: 11, marginBottom: 16, padding: 0 }} type="button">← Back</button>

						<h2 style={{ fontSize: 24, fontWeight: 300, marginBottom: 24 }}>🕸️ Map Connections</h2>

						{error && (
							<div style={{ marginBottom: 20, padding: '12px 16px', borderRadius: 8, background: '#2d1a1a', border: '1px solid #5c2626', color: '#f87171', fontSize: 13 }}>
								{error}
							</div>
						)}

						<div style={{ marginBottom: 16 }}>
							<label style={{ display: 'block', fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 6 }}>Who do you want to reach? *</label>
							<input type="text" value={targetProspect} onChange={(e) => setTargetProspect(e.target.value)} placeholder="e.g., John Smith, CEO of XYZ Foundation" style={{ width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid #1e2538', background: '#111520', color: '#e2e8f0', fontSize: 14, outline: 'none' }} />
						</div>

						<div style={{ marginBottom: 24 }}>
							<label style={{ display: 'block', fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 6 }}>People you already know (comma-separated)</label>
							<textarea value={knownConnections} onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setKnownConnections(e.target.value)} placeholder="Board members, current donors, community leaders..." rows={3} style={{ width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid #1e2538', background: '#111520', color: '#e2e8f0', fontSize: 14, outline: 'none', resize: 'vertical' }} />
						</div>

						<button onClick={handleSearch} disabled={!targetProspect} style={{ width: '100%', padding: '14px', borderRadius: 8, border: 'none', background: targetProspect ? '#2D6A4F' : '#1e2538', color: targetProspect ? '#ffffff' : '#4a5578', cursor: targetProspect ? 'pointer' : 'not-allowed', fontFamily: "'Space Mono', monospace", fontSize: 12, fontWeight: 700 }} type="button">
							Find Connections →
						</button>
					</div>
				)}

				{/* Step: Generating */}
				{step === 'generating' && (
					<div style={{ textAlign: 'center', padding: '60px 0', animation: 'fadeSlideUp 0.4s ease-out' }}>
						<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 12, color: '#2D6A4F', letterSpacing: 2, background: 'linear-gradient(90deg, #2D6A4F, #4a9e7a, #2D6A4F)', backgroundSize: '200% auto', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', animation: 'shimmer 2s linear infinite' }}>
							RESEARCHING...
						</div>
						<p style={{ color: '#4a5578', fontSize: 14, marginTop: 12 }}>
							{searchType === 'prospect-search' && 'Searching for matching prospects'}
							{searchType === 'deep-dive' && 'Building detailed profile'}
							{searchType === 'connection-map' && 'Mapping connection pathways'}
						</p>
					</div>
				)}

				{/* Step: Results */}
				{step === 'result' && result && (
					<div style={{ animation: 'fadeSlideUp 0.4s ease-out' }}>
						<div style={{ marginBottom: 24 }}>
							<h2 style={{ fontSize: 24, fontWeight: 300, marginBottom: 8 }}>
								{result.searchType === 'prospect-search' && '🔍 Prospect Results'}
								{result.searchType === 'deep-dive' && '🔬 Prospect Profile'}
								{result.searchType === 'connection-map' && '🕸️ Connection Map'}
							</h2>
							<p style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, color: '#4a5578' }}>
								{result.resultsCount} result{result.resultsCount !== 1 ? 's' : ''} • {result.searchCriteria}
							</p>
						</div>

						{/* Prospect List */}
						{result.prospects && (
							<div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
								{result.prospects.map((prospect, i) => (
									<div key={i} style={{ background: '#111520', border: '1px solid #1e2538', borderRadius: 10, padding: 20 }}>
										<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
											<div>
												<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 14, fontWeight: 700, color: '#e2e8f0', marginBottom: 4 }}>
													{prospect.name}
												</div>
												<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578' }}>
													{prospect.type} {prospect.location && `• ${prospect.location}`} {prospect.typicalGiftRange && `• ${prospect.typicalGiftRange}`}
												</div>
											</div>
											{renderScoreBadge(prospect.relevanceScore)}
										</div>

										<p style={{ fontSize: 13, color: '#8892b0', lineHeight: 1.6, marginBottom: 12 }}>
											{prospect.description}
										</p>

										<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
											{prospect.givingAreas.map((area) => (
												<span key={area} style={{ padding: '4px 10px', borderRadius: 4, background: '#1e2538', color: '#4a5578', fontFamily: "'Space Mono', monospace", fontSize: 10 }}>
													{area}
												</span>
											))}
										</div>

										<button
											onClick={() => setExpandedProspect(expandedProspect === prospect.name ? null : prospect.name)}
											style={{ background: 'none', border: 'none', color: '#2D6A4F', cursor: 'pointer', fontFamily: "'Space Mono', monospace", fontSize: 11, padding: 0 }}
											type="button"
										>
											{expandedProspect === prospect.name ? '▾ Hide details' : '▸ Show approach & notes'}
										</button>

										{expandedProspect === prospect.name && (
											<div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #1e2538' }}>
												<div style={{ marginBottom: 10 }}>
													<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#2D6A4F', marginBottom: 4 }}>WHY RELEVANT</div>
													<p style={{ fontSize: 12, color: '#c8d0e0', lineHeight: 1.5 }}>{prospect.relevanceReason}</p>
												</div>
												<div style={{ marginBottom: 10 }}>
													<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#E67E22', marginBottom: 4 }}>SUGGESTED APPROACH</div>
													<p style={{ fontSize: 12, color: '#c8d0e0', lineHeight: 1.5 }}>{prospect.suggestedApproach}</p>
												</div>
												{prospect.redFlags && prospect.redFlags.length > 0 && (
													<div>
														<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#c0392b', marginBottom: 4 }}>CONSIDERATIONS</div>
														<ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: '#8892b0' }}>
															{prospect.redFlags.map((flag, j) => (
																<li key={j}>{flag}</li>
															))}
														</ul>
													</div>
												)}
												{prospect.website && (
													<a href={prospect.website} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-block', marginTop: 10, fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578' }}>
														🔗 {prospect.website}
													</a>
												)}
											</div>
										)}
									</div>
								))}
							</div>
						)}

						{/* Profile (Deep Dive) */}
						{result.profile && (
							<div style={{ background: '#111520', border: '1px solid #1e2538', borderRadius: 12, padding: 24 }}>
								<h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16, color: '#e2e8f0' }}>{result.profile.name}</h3>

								<div style={{ marginBottom: 20 }}>
									<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#2D6A4F', marginBottom: 6, letterSpacing: 1 }}>OVERVIEW</div>
									<p style={{ fontSize: 14, color: '#c8d0e0', lineHeight: 1.7 }}>{result.profile.overview}</p>
								</div>

								<div style={{ marginBottom: 20 }}>
									<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#E67E22', marginBottom: 6, letterSpacing: 1 }}>GIVING HISTORY</div>
									<p style={{ fontSize: 14, color: '#c8d0e0', lineHeight: 1.7 }}>{result.profile.givingHistory}</p>
								</div>

								<div style={{ marginBottom: 20 }}>
									<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#9B59B6', marginBottom: 6, letterSpacing: 1 }}>PRIORITIES</div>
									<ul style={{ margin: 0, paddingLeft: 20, fontSize: 14, color: '#c8d0e0', lineHeight: 1.7 }}>
										{result.profile.priorities.map((p, i) => <li key={i}>{p}</li>)}
									</ul>
								</div>

								<div style={{ marginBottom: 20 }}>
									<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#2D6A4F', marginBottom: 6, letterSpacing: 1 }}>ALIGNMENT WITH CLC</div>
									<p style={{ fontSize: 14, color: '#c8d0e0', lineHeight: 1.7 }}>{result.profile.alignmentAnalysis}</p>
								</div>

								<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
									<div style={{ background: '#0a0d14', padding: 16, borderRadius: 8 }}>
										<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 6 }}>SUGGESTED ASK</div>
										<p style={{ fontSize: 13, color: '#e2e8f0', lineHeight: 1.6 }}>{result.profile.suggestedAsk}</p>
									</div>
									<div style={{ background: '#0a0d14', padding: 16, borderRadius: 8 }}>
										<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 6 }}>CULTIVATION STRATEGY</div>
										<p style={{ fontSize: 13, color: '#e2e8f0', lineHeight: 1.6 }}>{result.profile.cultivationStrategy}</p>
									</div>
								</div>
							</div>
						)}

						{/* Connection Map */}
						{result.connectionMap && (
							<div style={{ background: '#111520', border: '1px solid #1e2538', borderRadius: 12, padding: 24 }}>
								<h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16, color: '#e2e8f0' }}>
									Pathways to {result.connectionMap.target}
								</h3>

								{result.connectionMap.pathways.map((pathway, i) => (
									<div key={i} style={{ marginBottom: 16, padding: 16, background: '#0a0d14', borderRadius: 8 }}>
										<div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
											<span style={{
												padding: '4px 8px',
												borderRadius: 4,
												background: pathway.strength === 'strong' ? '#2D6A4F30' : pathway.strength === 'moderate' ? '#E67E2230' : '#1e2538',
												color: pathway.strength === 'strong' ? '#4a9e7a' : pathway.strength === 'moderate' ? '#E67E22' : '#4a5578',
												fontFamily: "'Space Mono', monospace",
												fontSize: 10,
											}}>
												{pathway.strength.toUpperCase()}
											</span>
										</div>
										<div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
											{pathway.path.map((person, j) => (
												<span key={j} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
													<span style={{ padding: '6px 12px', borderRadius: 6, background: '#1e2538', color: '#e2e8f0', fontFamily: "'Space Mono', monospace", fontSize: 11 }}>
														{person}
													</span>
													{j < pathway.path.length - 1 && <span style={{ color: '#4a5578' }}>→</span>}
												</span>
											))}
										</div>
										<p style={{ fontSize: 12, color: '#8892b0', lineHeight: 1.5 }}>{pathway.notes}</p>
									</div>
								))}

								{result.connectionMap.suggestedIntroductions.length > 0 && (
									<div style={{ marginTop: 16 }}>
										<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 8, letterSpacing: 1 }}>SUGGESTED INTRODUCTION ASKS</div>
										<div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
											{result.connectionMap.suggestedIntroductions.map((person, i) => (
												<span key={i} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #2D6A4F', color: '#4a9e7a', fontFamily: "'Space Mono', monospace", fontSize: 11 }}>
													{person}
												</span>
											))}
										</div>
									</div>
								)}
							</div>
						)}

						<div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
							<button onClick={() => setStep('mode')} style={{ flex: 1, padding: '12px', borderRadius: 8, border: '1px solid #1e2538', background: 'transparent', color: '#8892b0', cursor: 'pointer', fontFamily: "'Space Mono', monospace", fontSize: 12 }} type="button">
								← New Search
							</button>
							<button onClick={handleReset} style={{ flex: 1, padding: '12px', borderRadius: 8, border: '1px solid #1e2538', background: 'transparent', color: '#8892b0', cursor: 'pointer', fontFamily: "'Space Mono', monospace", fontSize: 12 }} type="button">
								🆕 Start Over
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
