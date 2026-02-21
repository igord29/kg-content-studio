/**
 * Main entry point for the Content Studio frontend
 * Provides navigation between all tools
 */

import { useState } from 'react';
import { App } from './App';
import { VideoEditor } from './VideoEditor';
import { GrantWriter } from './GrantWriter';
import { DonorResearcher } from './DonorResearcher';
import { VenueProspector } from './VenueProspector';
import { ContentLibrary } from './ContentLibrary';

type ActiveTool = 'home' | 'content' | 'video' | 'grants' | 'donors' | 'venues' | 'library';

const TOOLS = [
	{ id: 'content' as const, label: 'Content Creator', icon: '✍️', description: 'Social media posts with AI images', color: '#2D6A4F' },
	{ id: 'video' as const, label: 'Video Editor', icon: '🎬', description: 'Video scripts & FFmpeg commands', color: '#E67E22' },
	{ id: 'library' as const, label: 'Media Library', icon: '📚', description: 'All content, videos & images', color: '#1ABC9C' },
	{ id: 'grants' as const, label: 'Grant Writer', icon: '📋', description: 'Proposals & funding narratives', color: '#9B59B6' },
	{ id: 'donors' as const, label: 'Donor Researcher', icon: '🔍', description: 'Find & research prospects', color: '#3498DB' },
	{ id: 'venues' as const, label: 'Venue Prospector', icon: '📍', description: 'Find program locations', color: '#E74C3C' },
];

export function ContentStudio() {
	const [activeTool, setActiveTool] = useState<ActiveTool>('home');

	const handleBackToHome = () => setActiveTool('home');

	// Render the active tool
	if (activeTool === 'content') {
		return <App onBack={handleBackToHome} />;
	}

	if (activeTool === 'video') {
		return <VideoEditor onBack={handleBackToHome} />;
	}

	if (activeTool === 'grants') {
		return <GrantWriter onBack={handleBackToHome} />;
	}

	if (activeTool === 'donors') {
		return <DonorResearcher onBack={handleBackToHome} />;
	}

	if (activeTool === 'library') {
		return <ContentLibrary onBack={handleBackToHome} />;
	}

	if (activeTool === 'venues') {
		return <VenueProspector onBack={handleBackToHome} />;
	}

	// Home / Tool selection screen
	return (
		<>
			<style>{`
				@import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,300;8..60,400;8..60,600;8..60,700&family=Space+Mono:wght@400;700&display=swap');

				@keyframes fadeSlideUp {
					from { opacity: 0; transform: translateY(12px); }
					to { opacity: 1; transform: translateY(0); }
				}

				* { box-sizing: border-box; margin: 0; padding: 0; }
			`}</style>

			<div style={{
				minHeight: '100vh',
				background: '#0a0d14',
				color: '#e2e8f0',
				fontFamily: "'Source Serif 4', Georgia, serif",
			}}>
				{/* Header */}
				<header style={{
					padding: '40px 40px 32px',
					borderBottom: '1px solid #141824',
					textAlign: 'center',
				}}>
					<h1 style={{
						fontSize: 32,
						fontWeight: 700,
						letterSpacing: '-0.02em',
						color: '#ffffff',
						marginBottom: 8,
					}}>
						Community Literacy Club
					</h1>
					<p style={{
						fontFamily: "'Space Mono', monospace",
						fontSize: 12,
						color: '#4a5578',
						letterSpacing: 2,
						textTransform: 'uppercase',
					}}>
						Content Studio
					</p>
				</header>

				{/* Main content */}
				<main style={{
					padding: '48px 40px',
					maxWidth: 900,
					margin: '0 auto',
				}}>
					<div style={{
						textAlign: 'center',
						marginBottom: 48,
						animation: 'fadeSlideUp 0.4s ease-out',
					}}>
						<h2 style={{
							fontSize: 28,
							fontWeight: 300,
							marginBottom: 12,
							letterSpacing: '-0.01em',
						}}>
							What would you like to do?
						</h2>
						<p style={{
							color: '#4a5578',
							fontSize: 15,
							maxWidth: 500,
							margin: '0 auto',
							lineHeight: 1.6,
						}}>
							Choose a tool to get started. Each one is powered by AI and writes in Kimberly's voice.
						</p>
					</div>

					{/* Tool grid */}
					<div style={{
						display: 'grid',
						gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
						gap: 16,
						animation: 'fadeSlideUp 0.5s ease-out 0.1s both',
					}}>
						{TOOLS.map((tool) => (
							<button
								key={tool.id}
								onClick={() => setActiveTool(tool.id)}
								style={{
									padding: '28px 24px',
									borderRadius: 12,
									border: '1px solid #1e2538',
									background: '#111520',
									cursor: 'pointer',
									textAlign: 'left',
									transition: 'all 0.25s',
									position: 'relative',
									overflow: 'hidden',
								}}
								onMouseEnter={(e) => {
									e.currentTarget.style.borderColor = tool.color + '66';
									e.currentTarget.style.background = '#141824';
									e.currentTarget.style.transform = 'translateY(-2px)';
								}}
								onMouseLeave={(e) => {
									e.currentTarget.style.borderColor = '#1e2538';
									e.currentTarget.style.background = '#111520';
									e.currentTarget.style.transform = 'translateY(0)';
								}}
								type="button"
							>
								{/* Accent bar */}
								<div style={{
									position: 'absolute',
									top: 0,
									left: 0,
									right: 0,
									height: 3,
									background: tool.color,
									opacity: 0.5,
								}} />

								<div style={{ fontSize: 32, marginBottom: 14 }}>{tool.icon}</div>
								<div style={{
									fontFamily: "'Space Mono', monospace",
									fontSize: 14,
									fontWeight: 700,
									color: '#ffffff',
									marginBottom: 6,
									letterSpacing: 0.5,
								}}>
									{tool.label}
								</div>
								<div style={{
									fontFamily: "'Space Mono', monospace",
									fontSize: 11,
									color: '#4a5578',
									letterSpacing: 0.3,
									lineHeight: 1.5,
								}}>
									{tool.description}
								</div>
							</button>
						))}
					</div>

					{/* Quick stats */}
					<div style={{
						marginTop: 64,
						padding: '24px 32px',
						background: '#111520',
						borderRadius: 12,
						border: '1px solid #1e2538',
						display: 'flex',
						justifyContent: 'space-around',
						flexWrap: 'wrap',
						gap: 24,
						animation: 'fadeSlideUp 0.5s ease-out 0.2s both',
					}}>
						<div style={{ textAlign: 'center' }}>
							<div style={{
								fontFamily: "'Space Mono', monospace",
								fontSize: 24,
								fontWeight: 700,
								color: '#2D6A4F',
								marginBottom: 4,
							}}>
								400+
							</div>
							<div style={{
								fontFamily: "'Space Mono', monospace",
								fontSize: 10,
								color: '#4a5578',
								letterSpacing: 1,
								textTransform: 'uppercase',
							}}>
								Kids Served
							</div>
						</div>
						<div style={{ textAlign: 'center' }}>
							<div style={{
								fontFamily: "'Space Mono', monospace",
								fontSize: 24,
								fontWeight: 700,
								color: '#E67E22',
								marginBottom: 4,
							}}>
								84%
							</div>
							<div style={{
								fontFamily: "'Space Mono', monospace",
								fontSize: 10,
								color: '#4a5578',
								letterSpacing: 1,
								textTransform: 'uppercase',
							}}>
								Retention Rate
							</div>
						</div>
						<div style={{ textAlign: 'center' }}>
							<div style={{
								fontFamily: "'Space Mono', monospace",
								fontSize: 24,
								fontWeight: 700,
								color: '#9B59B6',
								marginBottom: 4,
							}}>
								5+
							</div>
							<div style={{
								fontFamily: "'Space Mono', monospace",
								fontSize: 10,
								color: '#4a5578',
								letterSpacing: 1,
								textTransform: 'uppercase',
							}}>
								Locations
							</div>
						</div>
						<div style={{ textAlign: 'center' }}>
							<div style={{
								fontFamily: "'Space Mono', monospace",
								fontSize: 24,
								fontWeight: 700,
								color: '#3498DB',
								marginBottom: 4,
							}}>
								3
							</div>
							<div style={{
								fontFamily: "'Space Mono', monospace",
								fontSize: 10,
								color: '#4a5578',
								letterSpacing: 1,
								textTransform: 'uppercase',
							}}>
								Program Tracks
							</div>
						</div>
					</div>
				</main>

				{/* Footer */}
				<footer style={{
					padding: '24px 40px',
					borderTop: '1px solid #141824',
					textAlign: 'center',
				}}>
					<span style={{
						fontFamily: "'Space Mono', monospace",
						fontSize: 10,
						color: '#2a3148',
						letterSpacing: 1,
					}}>
						Community Literacy Club • Tennis | Chess | Mentorship
					</span>
				</footer>
			</div>
		</>
	);
}

// Export ContentStudio as default for the entry point
export default ContentStudio;
