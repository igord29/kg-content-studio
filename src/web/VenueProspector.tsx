import { useCallback, useState, type ChangeEvent } from 'react';

interface Venue {
	name: string;
	type: string;
	address: string;
	description: string;
	capacity?: string;
	amenities: string[];
	contactInfo?: string;
	website?: string;
	fitScore: number;
	fitReason: string;
	considerations?: string[];
	suggestedApproach: string;
}

interface VenueProfile {
	name: string;
	type: string;
	address: string;
	overview: string;
	facilities: string;
	currentPrograms?: string[];
	decisionMakers?: { name: string; role: string; contact?: string }[];
	availability?: string;
	costs?: string;
	partnershipOpportunities: string[];
	clcFit: string;
	recommendedPrograms: string[];
}

interface OutreachPlan {
	summary: string;
	venues: {
		name: string;
		priority: string;
		approach: string;
		talkingPoints: string[];
		proposedPartnership: string;
		timeline: string;
	}[];
	emailTemplate: string;
	followUpSchedule: { timing: string; action: string }[];
}

interface VenueResult {
	venues?: Venue[];
	profile?: VenueProfile;
	outreachPlan?: OutreachPlan;
	searchType: string;
	resultsCount: number;
	searchCriteria: string;
}

const VENUE_TYPES = [
	{ id: 'community-center', label: 'Community Center', icon: '🏛️' },
	{ id: 'rec-center', label: 'Rec Center', icon: '🏀' },
	{ id: 'school-gym', label: 'School Gym', icon: '🏫' },
	{ id: 'church', label: 'Church', icon: '⛪' },
	{ id: 'library', label: 'Library', icon: '📚' },
	{ id: 'park', label: 'Park', icon: '🌳' },
	{ id: 'ymca', label: 'YMCA', icon: '🏋️' },
	{ id: 'boys-girls-club', label: 'Boys & Girls Club', icon: '👧' },
	{ id: 'housing-complex', label: 'Housing Complex', icon: '🏢' },
];

const PROGRAM_TYPES = [
	{ id: 'both', label: 'Tennis & Chess' },
	{ id: 'tennis', label: 'Tennis Only' },
	{ id: 'chess', label: 'Chess Only' },
	{ id: 'sat-prep', label: 'SAT Prep' },
	{ id: 'leadership', label: 'Leadership' },
];

interface VenueProspectorProps {
	onBack: () => void;
}

export function VenueProspector({ onBack }: VenueProspectorProps) {
	const [step, setStep] = useState<'mode' | 'search' | 'profile' | 'outreach' | 'generating' | 'result'>('mode');
	const [searchType, setSearchType] = useState<'venue-search' | 'venue-profile' | 'outreach-plan'>('venue-search');

	// Search state
	const [location, setLocation] = useState('');
	const [radius, setRadius] = useState('10');
	const [venueTypes, setVenueTypes] = useState<string[]>([]);
	const [programType, setProgramType] = useState('both');
	const [minCapacity, setMinCapacity] = useState('');
	const [indoorRequired, setIndoorRequired] = useState(false);

	// Profile state
	const [venueName, setVenueName] = useState('');
	const [venueAddress, setVenueAddress] = useState('');

	// Outreach state
	const [targetVenues, setTargetVenues] = useState('');

	// Result
	const [result, setResult] = useState<VenueResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [expandedVenue, setExpandedVenue] = useState<string | null>(null);
	const [copiedEmail, setCopiedEmail] = useState(false);

	const toggleVenueType = useCallback((type: string) => {
		setVenueTypes((prev) =>
			prev.includes(type)
				? prev.filter((t) => t !== type)
				: [...prev, type]
		);
	}, []);

	const handleSearch = useCallback(async () => {
		setStep('generating');
		setError(null);

		try {
			const body: Record<string, unknown> = {
				searchType,
				location,
			};

			if (searchType === 'venue-search') {
				body.radius = radius ? Number(radius) : 10;
				body.venueTypes = venueTypes.length > 0 ? venueTypes : undefined;
				body.programType = programType;
				body.minCapacity = minCapacity ? Number(minCapacity) : undefined;
				body.indoorRequired = indoorRequired;
			} else if (searchType === 'venue-profile') {
				body.venueName = venueName;
				body.venueAddress = venueAddress || undefined;
			} else if (searchType === 'outreach-plan') {
				body.targetVenues = targetVenues.split('\n').map((v) => v.trim()).filter(Boolean);
			}

			const response = await fetch('/api/venue-prospector', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});

			if (!response.ok) {
				throw new Error('Search failed');
			}

			const data = await response.json();
			setResult(data);
			setStep('result');
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Something went wrong');
			setStep(searchType === 'venue-profile' ? 'profile' : searchType === 'outreach-plan' ? 'outreach' : 'search');
		}
	}, [searchType, location, radius, venueTypes, programType, minCapacity, indoorRequired, venueName, venueAddress, targetVenues]);

	const handleReset = useCallback(() => {
		setStep('mode');
		setResult(null);
		setLocation('');
		setVenueTypes([]);
		setVenueName('');
		setVenueAddress('');
		setTargetVenues('');
	}, []);

	const renderFitBadge = (score: number) => {
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
					style={{ background: 'none', border: 'none', color: '#4a5578', cursor: 'pointer', fontFamily: "'Space Mono', monospace", fontSize: 11, marginBottom: 8, letterSpacing: 0.5, padding: 0 }}
					type="button"
				>
					← Back to Content Studio
				</button>
				<h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', color: '#ffffff' }}>
					Venue Prospector
				</h1>
				<p style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, color: '#4a5578', marginTop: 4, letterSpacing: 0.5 }}>
					Find spaces for tennis, chess, and mentorship programs
				</p>
			</header>

			<main style={{ padding: '32px 40px', maxWidth: 900, margin: '0 auto' }}>
				{/* Step: Mode */}
				{step === 'mode' && (
					<div style={{ animation: 'fadeSlideUp 0.4s ease-out' }}>
						<h2 style={{ fontSize: 24, fontWeight: 300, marginBottom: 24 }}>What do you need?</h2>

						<div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
							<button
								onClick={() => { setSearchType('venue-search'); setStep('search'); }}
								style={{ padding: '20px 24px', borderRadius: 10, border: '1px solid #1e2538', background: '#111520', cursor: 'pointer', textAlign: 'left' as const, transition: 'all 0.2s' }}
								onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#2D6A4F'; }}
								onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#1e2538'; }}
								type="button"
							>
								<div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
									<span style={{ fontSize: 24 }}>🔍</span>
									<div>
										<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 12, fontWeight: 700, color: '#e2e8f0', marginBottom: 4 }}>Find New Venues</div>
										<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, color: '#4a5578' }}>Search for community centers, gyms, and spaces in an area</div>
									</div>
								</div>
							</button>

							<button
								onClick={() => { setSearchType('venue-profile'); setStep('profile'); }}
								style={{ padding: '20px 24px', borderRadius: 10, border: '1px solid #1e2538', background: '#111520', cursor: 'pointer', textAlign: 'left' as const, transition: 'all 0.2s' }}
								onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#2D6A4F'; }}
								onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#1e2538'; }}
								type="button"
							>
								<div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
									<span style={{ fontSize: 24 }}>📋</span>
									<div>
										<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 12, fontWeight: 700, color: '#e2e8f0', marginBottom: 4 }}>Research a Venue</div>
										<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, color: '#4a5578' }}>Get detailed info on a specific venue</div>
									</div>
								</div>
							</button>

							<button
								onClick={() => { setSearchType('outreach-plan'); setStep('outreach'); }}
								style={{ padding: '20px 24px', borderRadius: 10, border: '1px solid #1e2538', background: '#111520', cursor: 'pointer', textAlign: 'left' as const, transition: 'all 0.2s' }}
								onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#2D6A4F'; }}
								onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#1e2538'; }}
								type="button"
							>
								<div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
									<span style={{ fontSize: 24 }}>📧</span>
									<div>
										<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 12, fontWeight: 700, color: '#e2e8f0', marginBottom: 4 }}>Create Outreach Plan</div>
										<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, color: '#4a5578' }}>Generate emails and talking points for venues</div>
									</div>
								</div>
							</button>
						</div>
					</div>
				)}

				{/* Step: Search */}
				{step === 'search' && (
					<div style={{ animation: 'fadeSlideUp 0.4s ease-out' }}>
						<button onClick={() => setStep('mode')} style={{ background: 'none', border: 'none', color: '#4a5578', cursor: 'pointer', fontFamily: "'Space Mono', monospace", fontSize: 11, marginBottom: 16, padding: 0 }} type="button">← Back</button>
						<h2 style={{ fontSize: 24, fontWeight: 300, marginBottom: 24 }}>🔍 Find Venues</h2>

						{error && (
							<div style={{ marginBottom: 20, padding: '12px 16px', borderRadius: 8, background: '#2d1a1a', border: '1px solid #5c2626', color: '#f87171', fontSize: 13 }}>
								{error}
							</div>
						)}

						{/* Location */}
						<div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 20 }}>
							<div>
								<label style={{ display: 'block', fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 6, letterSpacing: 1, textTransform: 'uppercase' as const }}>Location *</label>
								<input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="City, neighborhood, or zip code" style={{ width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid #1e2538', background: '#111520', color: '#e2e8f0', fontSize: 14, outline: 'none' }} />
							</div>
							<div>
								<label style={{ display: 'block', fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 6 }}>Radius (mi)</label>
								<input type="number" value={radius} onChange={(e) => setRadius(e.target.value)} placeholder="10" style={{ width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid #1e2538', background: '#111520', color: '#e2e8f0', fontSize: 14, outline: 'none' }} />
							</div>
						</div>

						{/* Venue Types */}
						<div style={{ marginBottom: 20 }}>
							<label style={{ display: 'block', fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 8, letterSpacing: 1, textTransform: 'uppercase' as const }}>Venue Types</label>
							<div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
								{VENUE_TYPES.map((type) => (
									<button
										key={type.id}
										onClick={() => toggleVenueType(type.id)}
										style={{
											padding: '8px 12px',
											borderRadius: 6,
											border: venueTypes.includes(type.id) ? '1px solid #2D6A4F' : '1px solid #1e2538',
											background: venueTypes.includes(type.id) ? '#2D6A4F20' : 'transparent',
											color: venueTypes.includes(type.id) ? '#4a9e7a' : '#8892b0',
											cursor: 'pointer',
											fontFamily: "'Space Mono', monospace",
											fontSize: 10,
										}}
										type="button"
									>
										{type.icon} {type.label}
									</button>
								))}
							</div>
						</div>

						{/* Program Type */}
						<div style={{ marginBottom: 20 }}>
							<label style={{ display: 'block', fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 8, letterSpacing: 1, textTransform: 'uppercase' as const }}>Program Type</label>
							<div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
								{PROGRAM_TYPES.map((prog) => (
									<button
										key={prog.id}
										onClick={() => setProgramType(prog.id)}
										style={{
											padding: '8px 14px',
											borderRadius: 6,
											border: programType === prog.id ? '1px solid #2D6A4F' : '1px solid #1e2538',
											background: programType === prog.id ? '#2D6A4F20' : 'transparent',
											color: programType === prog.id ? '#4a9e7a' : '#8892b0',
											cursor: 'pointer',
											fontFamily: "'Space Mono', monospace",
											fontSize: 11,
										}}
										type="button"
									>
										{prog.label}
									</button>
								))}
							</div>
						</div>

						{/* Options */}
						<div style={{ display: 'flex', gap: 20, marginBottom: 24 }}>
							<label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
								<input type="checkbox" checked={indoorRequired} onChange={(e) => setIndoorRequired(e.target.checked)} style={{ width: 16, height: 16 }} />
								<span style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, color: '#8892b0' }}>Indoor required</span>
							</label>
							<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
								<span style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, color: '#4a5578' }}>Min capacity:</span>
								<input type="number" value={minCapacity} onChange={(e) => setMinCapacity(e.target.value)} placeholder="15" style={{ width: 70, padding: '6px 10px', borderRadius: 4, border: '1px solid #1e2538', background: '#111520', color: '#e2e8f0', fontSize: 12, outline: 'none' }} />
							</div>
						</div>

						<button onClick={handleSearch} disabled={!location} style={{ width: '100%', padding: '14px', borderRadius: 8, border: 'none', background: location ? '#2D6A4F' : '#1e2538', color: location ? '#ffffff' : '#4a5578', cursor: location ? 'pointer' : 'not-allowed', fontFamily: "'Space Mono', monospace", fontSize: 12, fontWeight: 700 }} type="button">
							Search Venues →
						</button>
					</div>
				)}

				{/* Step: Profile */}
				{step === 'profile' && (
					<div style={{ animation: 'fadeSlideUp 0.4s ease-out' }}>
						<button onClick={() => setStep('mode')} style={{ background: 'none', border: 'none', color: '#4a5578', cursor: 'pointer', fontFamily: "'Space Mono', monospace", fontSize: 11, marginBottom: 16, padding: 0 }} type="button">← Back</button>
						<h2 style={{ fontSize: 24, fontWeight: 300, marginBottom: 24 }}>📋 Research a Venue</h2>

						{error && (
							<div style={{ marginBottom: 20, padding: '12px 16px', borderRadius: 8, background: '#2d1a1a', border: '1px solid #5c2626', color: '#f87171', fontSize: 13 }}>
								{error}
							</div>
						)}

						<div style={{ marginBottom: 16 }}>
							<label style={{ display: 'block', fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 6 }}>Venue Name *</label>
							<input type="text" value={venueName} onChange={(e) => setVenueName(e.target.value)} placeholder="e.g., Hempstead Community Center" style={{ width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid #1e2538', background: '#111520', color: '#e2e8f0', fontSize: 14, outline: 'none' }} />
						</div>

						<div style={{ marginBottom: 16 }}>
							<label style={{ display: 'block', fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 6 }}>Location *</label>
							<input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="City or neighborhood" style={{ width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid #1e2538', background: '#111520', color: '#e2e8f0', fontSize: 14, outline: 'none' }} />
						</div>

						<div style={{ marginBottom: 24 }}>
							<label style={{ display: 'block', fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 6 }}>Address (Optional)</label>
							<input type="text" value={venueAddress} onChange={(e: ChangeEvent<HTMLInputElement>) => setVenueAddress(e.target.value)} placeholder="Full address if known" style={{ width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid #1e2538', background: '#111520', color: '#e2e8f0', fontSize: 14, outline: 'none' }} />
						</div>

						<button onClick={handleSearch} disabled={!venueName || !location} style={{ width: '100%', padding: '14px', borderRadius: 8, border: 'none', background: (venueName && location) ? '#2D6A4F' : '#1e2538', color: (venueName && location) ? '#ffffff' : '#4a5578', cursor: (venueName && location) ? 'pointer' : 'not-allowed', fontFamily: "'Space Mono', monospace", fontSize: 12, fontWeight: 700 }} type="button">
							Research This Venue →
						</button>
					</div>
				)}

				{/* Step: Outreach */}
				{step === 'outreach' && (
					<div style={{ animation: 'fadeSlideUp 0.4s ease-out' }}>
						<button onClick={() => setStep('mode')} style={{ background: 'none', border: 'none', color: '#4a5578', cursor: 'pointer', fontFamily: "'Space Mono', monospace", fontSize: 11, marginBottom: 16, padding: 0 }} type="button">← Back</button>
						<h2 style={{ fontSize: 24, fontWeight: 300, marginBottom: 24 }}>📧 Create Outreach Plan</h2>

						{error && (
							<div style={{ marginBottom: 20, padding: '12px 16px', borderRadius: 8, background: '#2d1a1a', border: '1px solid #5c2626', color: '#f87171', fontSize: 13 }}>
								{error}
							</div>
						)}

						<div style={{ marginBottom: 16 }}>
							<label style={{ display: 'block', fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 6 }}>Location *</label>
							<input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="City or area" style={{ width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid #1e2538', background: '#111520', color: '#e2e8f0', fontSize: 14, outline: 'none' }} />
						</div>

						<div style={{ marginBottom: 24 }}>
							<label style={{ display: 'block', fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 6 }}>Target Venues (one per line) *</label>
							<textarea value={targetVenues} onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setTargetVenues(e.target.value)} placeholder="Hempstead Community Center&#10;Long Beach YMCA&#10;Grace Church Fellowship Hall" rows={5} style={{ width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid #1e2538', background: '#111520', color: '#e2e8f0', fontSize: 14, outline: 'none', resize: 'vertical' }} />
						</div>

						<button onClick={handleSearch} disabled={!location || !targetVenues} style={{ width: '100%', padding: '14px', borderRadius: 8, border: 'none', background: (location && targetVenues) ? '#2D6A4F' : '#1e2538', color: (location && targetVenues) ? '#ffffff' : '#4a5578', cursor: (location && targetVenues) ? 'pointer' : 'not-allowed', fontFamily: "'Space Mono', monospace", fontSize: 12, fontWeight: 700 }} type="button">
							Create Outreach Plan →
						</button>
					</div>
				)}

				{/* Step: Generating */}
				{step === 'generating' && (
					<div style={{ textAlign: 'center', padding: '60px 0', animation: 'fadeSlideUp 0.4s ease-out' }}>
						<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 12, color: '#2D6A4F', letterSpacing: 2, background: 'linear-gradient(90deg, #2D6A4F, #4a9e7a, #2D6A4F)', backgroundSize: '200% auto', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', animation: 'shimmer 2s linear infinite' }}>
							{searchType === 'venue-search' && 'SEARCHING FOR VENUES...'}
							{searchType === 'venue-profile' && 'RESEARCHING VENUE...'}
							{searchType === 'outreach-plan' && 'CREATING OUTREACH PLAN...'}
						</div>
					</div>
				)}

				{/* Step: Results */}
				{step === 'result' && result && (
					<div style={{ animation: 'fadeSlideUp 0.4s ease-out' }}>
						<div style={{ marginBottom: 24 }}>
							<h2 style={{ fontSize: 24, fontWeight: 300, marginBottom: 8 }}>
								{result.searchType === 'venue-search' && '🔍 Venue Results'}
								{result.searchType === 'venue-profile' && '📋 Venue Profile'}
								{result.searchType === 'outreach-plan' && '📧 Outreach Plan'}
							</h2>
							<p style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, color: '#4a5578' }}>
								{result.resultsCount} result{result.resultsCount !== 1 ? 's' : ''}
							</p>
						</div>

						{/* Venue List */}
						{result.venues && (
							<div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
								{result.venues.map((venue, i) => (
									<div key={i} style={{ background: '#111520', border: '1px solid #1e2538', borderRadius: 10, padding: 20 }}>
										<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
											<div>
												<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 14, fontWeight: 700, color: '#e2e8f0', marginBottom: 4 }}>{venue.name}</div>
												<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578' }}>
													{venue.type} • {venue.address} {venue.capacity && `• ${venue.capacity}`}
												</div>
											</div>
											{renderFitBadge(venue.fitScore)}
										</div>

										<p style={{ fontSize: 13, color: '#8892b0', lineHeight: 1.6, marginBottom: 12 }}>{venue.description}</p>

										<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
											{venue.amenities.slice(0, 5).map((amenity) => (
												<span key={amenity} style={{ padding: '4px 10px', borderRadius: 4, background: '#1e2538', color: '#4a5578', fontFamily: "'Space Mono', monospace", fontSize: 10 }}>
													{amenity}
												</span>
											))}
										</div>

										<button
											onClick={() => setExpandedVenue(expandedVenue === venue.name ? null : venue.name)}
											style={{ background: 'none', border: 'none', color: '#2D6A4F', cursor: 'pointer', fontFamily: "'Space Mono', monospace", fontSize: 11, padding: 0 }}
											type="button"
										>
											{expandedVenue === venue.name ? '▾ Hide details' : '▸ Show details'}
										</button>

										{expandedVenue === venue.name && (
											<div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #1e2538' }}>
												<div style={{ marginBottom: 10 }}>
													<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#2D6A4F', marginBottom: 4 }}>WHY IT'S A GOOD FIT</div>
													<p style={{ fontSize: 12, color: '#c8d0e0', lineHeight: 1.5 }}>{venue.fitReason}</p>
												</div>
												<div style={{ marginBottom: 10 }}>
													<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#E67E22', marginBottom: 4 }}>SUGGESTED APPROACH</div>
													<p style={{ fontSize: 12, color: '#c8d0e0', lineHeight: 1.5 }}>{venue.suggestedApproach}</p>
												</div>
												{venue.considerations && venue.considerations.length > 0 && (
													<div>
														<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#9B59B6', marginBottom: 4 }}>CONSIDERATIONS</div>
														<ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: '#8892b0' }}>
															{venue.considerations.map((c, j) => <li key={j}>{c}</li>)}
														</ul>
													</div>
												)}
											</div>
										)}
									</div>
								))}
							</div>
						)}

						{/* Venue Profile */}
						{result.profile && (
							<div style={{ background: '#111520', border: '1px solid #1e2538', borderRadius: 12, padding: 24 }}>
								<h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4, color: '#e2e8f0' }}>{result.profile.name}</h3>
								<p style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, color: '#4a5578', marginBottom: 20 }}>{result.profile.type} • {result.profile.address}</p>

								<div style={{ marginBottom: 20 }}>
									<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#2D6A4F', marginBottom: 6, letterSpacing: 1 }}>OVERVIEW</div>
									<p style={{ fontSize: 14, color: '#c8d0e0', lineHeight: 1.7 }}>{result.profile.overview}</p>
								</div>

								<div style={{ marginBottom: 20 }}>
									<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#E67E22', marginBottom: 6, letterSpacing: 1 }}>FACILITIES</div>
									<p style={{ fontSize: 14, color: '#c8d0e0', lineHeight: 1.7 }}>{result.profile.facilities}</p>
								</div>

								<div style={{ marginBottom: 20 }}>
									<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#9B59B6', marginBottom: 6, letterSpacing: 1 }}>CLC FIT ANALYSIS</div>
									<p style={{ fontSize: 14, color: '#c8d0e0', lineHeight: 1.7 }}>{result.profile.clcFit}</p>
								</div>

								<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
									<div style={{ background: '#0a0d14', padding: 16, borderRadius: 8 }}>
										<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 6 }}>RECOMMENDED PROGRAMS</div>
										<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
											{result.profile.recommendedPrograms.map((prog, i) => (
												<span key={i} style={{ padding: '4px 10px', borderRadius: 4, background: '#2D6A4F20', color: '#4a9e7a', fontFamily: "'Space Mono', monospace", fontSize: 11 }}>{prog}</span>
											))}
										</div>
									</div>
									<div style={{ background: '#0a0d14', padding: 16, borderRadius: 8 }}>
										<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 6 }}>PARTNERSHIP OPPORTUNITIES</div>
										<ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: '#c8d0e0', lineHeight: 1.6 }}>
											{result.profile.partnershipOpportunities.slice(0, 3).map((opp, i) => <li key={i}>{opp}</li>)}
										</ul>
									</div>
								</div>
							</div>
						)}

						{/* Outreach Plan */}
						{result.outreachPlan && (
							<div>
								<div style={{ background: '#111520', border: '1px solid #1e2538', borderRadius: 12, padding: 24, marginBottom: 16 }}>
									<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#2D6A4F', marginBottom: 8, letterSpacing: 1 }}>STRATEGY SUMMARY</div>
									<p style={{ fontSize: 14, color: '#c8d0e0', lineHeight: 1.7 }}>{result.outreachPlan.summary}</p>
								</div>

								{result.outreachPlan.venues.map((venue, i) => (
									<div key={i} style={{ background: '#111520', border: '1px solid #1e2538', borderRadius: 10, padding: 20, marginBottom: 12 }}>
										<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
											<span style={{ fontFamily: "'Space Mono', monospace", fontSize: 14, fontWeight: 700, color: '#e2e8f0' }}>{venue.name}</span>
											<span style={{
												padding: '4px 10px',
												borderRadius: 4,
												background: venue.priority === 'high' ? '#2D6A4F30' : venue.priority === 'medium' ? '#E67E2230' : '#1e2538',
												color: venue.priority === 'high' ? '#4a9e7a' : venue.priority === 'medium' ? '#E67E22' : '#4a5578',
												fontFamily: "'Space Mono', monospace",
												fontSize: 10,
											}}>
												{venue.priority.toUpperCase()} PRIORITY
											</span>
										</div>
										<p style={{ fontSize: 13, color: '#8892b0', lineHeight: 1.6, marginBottom: 12 }}>{venue.approach}</p>
										<div style={{ marginBottom: 8 }}>
											<div style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#4a5578', marginBottom: 4 }}>TALKING POINTS</div>
											<ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: '#c8d0e0' }}>
												{venue.talkingPoints.map((point, j) => <li key={j}>{point}</li>)}
											</ul>
										</div>
									</div>
								))}

								{/* Email Template */}
								<div style={{ background: '#111520', border: '1px solid #1e2538', borderRadius: 12, padding: 24 }}>
									<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
										<span style={{ fontFamily: "'Space Mono', monospace", fontSize: 10, color: '#E67E22', letterSpacing: 1 }}>EMAIL TEMPLATE</span>
										<button
											onClick={() => { navigator.clipboard?.writeText(result.outreachPlan!.emailTemplate); setCopiedEmail(true); setTimeout(() => setCopiedEmail(false), 2000); }}
											style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #E67E22', background: 'transparent', color: '#E67E22', cursor: 'pointer', fontFamily: "'Space Mono', monospace", fontSize: 10 }}
											type="button"
										>
											{copiedEmail ? '✓ Copied' : 'Copy'}
										</button>
									</div>
									<pre style={{ fontSize: 12, color: '#c8d0e0', lineHeight: 1.6, whiteSpace: 'pre-wrap', fontFamily: "'Source Serif 4', Georgia, serif" }}>
										{result.outreachPlan.emailTemplate}
									</pre>
								</div>
							</div>
						)}

						<div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
							<button onClick={() => setStep('mode')} style={{ flex: 1, padding: '12px', borderRadius: 8, border: '1px solid #1e2538', background: 'transparent', color: '#8892b0', cursor: 'pointer', fontFamily: "'Space Mono', monospace", fontSize: 12 }} type="button">← New Search</button>
							<button onClick={handleReset} style={{ flex: 1, padding: '12px', borderRadius: 8, border: '1px solid #1e2538', background: 'transparent', color: '#8892b0', cursor: 'pointer', fontFamily: "'Space Mono', monospace", fontSize: 12 }} type="button">🆕 Start Over</button>
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
