/**
 * VideoUploader — Drag-and-drop upload to Supabase Storage + auto-pipeline trigger
 * File: src/web/VideoUploader.tsx
 */

import { useState, useCallback, useRef } from 'react';

// --- Types ---

interface UploadState {
	status: 'idle' | 'uploading' | 'analyzing' | 'rendering' | 'grading' | 'done' | 'error';
	progress: number;
	filename: string | null;
	error: string | null;
	result: PipelineResult | null;
}

interface PipelineResult {
	success: boolean;
	renderId: string;
	downloadUrl?: string;
	score?: number;
	attempts: number;
	supabaseId?: string;
	publicUrl?: string;
	error?: string;
}

interface VideoUploaderProps {
	onComplete?: (result: PipelineResult) => void;
}

// --- Design tokens ---

const S = {
	mono: "'Space Mono', monospace" as string,
	bg: '#0a0d14',
	cardBg: '#111520',
	borderColor: '#1e2538',
	borderHover: '#2a3550',
	textPrimary: '#e2e8f0',
	textSecondary: '#8892b0',
	textMuted: '#4a5578',
	accent: '#2D6A4F',
	accentLight: '#4a9e7a',
	orange: '#E67E22',
	red: '#f87171',
	teal: '#1ABC9C',
};

// --- Component ---

export function VideoUploader({ onComplete }: VideoUploaderProps) {
	const [state, setState] = useState<UploadState>({
		status: 'idle',
		progress: 0,
		filename: null,
		error: null,
		result: null,
	});

	const [platform, setPlatform] = useState('tiktok');
	const [editMode, setEditMode] = useState('game_day');
	const [topic, setTopic] = useState('');
	const [isDragOver, setIsDragOver] = useState(false);

	const fileInputRef = useRef<HTMLInputElement>(null);

	const handleUploadAndProcess = useCallback(async (file: File) => {
		if (!file.type.startsWith('video/')) {
			setState(prev => ({ ...prev, status: 'error', error: 'Please select a video file' }));
			return;
		}

		const maxSize = 500 * 1024 * 1024; // 500MB
		if (file.size > maxSize) {
			setState(prev => ({ ...prev, status: 'error', error: 'File too large (max 500MB)' }));
			return;
		}

		setState({
			status: 'uploading',
			progress: 10,
			filename: file.name,
			error: null,
			result: null,
		});

		try {
			// Step 1: Upload to server (which saves to Supabase Storage)
			const formData = new FormData();
			formData.append('video', file);
			formData.append('platform', platform);
			formData.append('editMode', editMode);
			formData.append('topic', topic || file.name.replace(/\.[^.]+$/, ''));

			const uploadRes = await fetch('/api/upload-video-supabase', {
				method: 'POST',
				body: formData,
			});

			if (!uploadRes.ok) {
				const err = await uploadRes.json().catch(() => ({ error: 'Upload failed' }));
				throw new Error(err.error || `Upload failed: ${uploadRes.status}`);
			}

			const uploadData = await uploadRes.json();
			setState(prev => ({ ...prev, status: 'analyzing', progress: 30 }));

			// Step 2: Trigger auto-pipeline
			const pipelineRes = await fetch('/api/video-editor', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					task: 'auto-process',
					videoIds: uploadData.driveFileId ? [uploadData.driveFileId] : [],
					platform,
					editMode,
					topic: topic || file.name.replace(/\.[^.]+$/, ''),
				}),
			});

			if (!pipelineRes.ok) {
				const err = await pipelineRes.json().catch(() => ({ error: 'Pipeline failed' }));
				throw new Error(err.error || `Pipeline failed: ${pipelineRes.status}`);
			}

			const pipelineData = await pipelineRes.json();

			if (pipelineData.success) {
				setState({
					status: 'done',
					progress: 100,
					filename: file.name,
					error: null,
					result: pipelineData,
				});
				onComplete?.(pipelineData);
			} else {
				throw new Error(pipelineData.error || 'Pipeline returned failure');
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			setState(prev => ({
				...prev,
				status: 'error',
				error: msg,
			}));
		}
	}, [platform, editMode, topic, onComplete]);

	const handleDrop = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		setIsDragOver(false);
		const file = e.dataTransfer.files[0];
		if (file) handleUploadAndProcess(file);
	}, [handleUploadAndProcess]);

	const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (file) handleUploadAndProcess(file);
	}, [handleUploadAndProcess]);

	const handleReset = () => {
		setState({ status: 'idle', progress: 0, filename: null, error: null, result: null });
		if (fileInputRef.current) fileInputRef.current.value = '';
	};

	const statusLabels: Record<string, string> = {
		uploading: 'Uploading to storage...',
		analyzing: 'Analyzing footage & generating edit plan...',
		rendering: 'Rendering video...',
		grading: 'AI reviewing quality...',
		done: 'Complete!',
		error: 'Failed',
	};

	const statusStr = state.status as string;
	const isProcessing = ['uploading', 'analyzing', 'rendering', 'grading'].includes(statusStr);
	const showProgress = statusStr !== 'idle';

	return (
		<div style={{
			background: S.cardBg,
			border: `1px solid ${S.borderColor}`,
			borderRadius: 12,
			padding: 24,
			marginBottom: 20,
		}}>
			<h3 style={{
				fontFamily: S.mono,
				fontSize: 14,
				color: S.textPrimary,
				margin: '0 0 16px 0',
				letterSpacing: '0.5px',
			}}>
				UPLOAD & AUTO-EDIT
			</h3>

			{/* Settings row */}
			<div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
				<select
					value={platform}
					onChange={(e) => setPlatform(e.target.value)}
					disabled={isProcessing}
					style={{
						background: S.bg,
						color: S.textPrimary,
						border: `1px solid ${S.borderColor}`,
						borderRadius: 6,
						padding: '6px 10px',
						fontFamily: S.mono,
						fontSize: 12,
					}}
				>
					<option value="tiktok">TikTok</option>
					<option value="ig_reels">IG Reels</option>
					<option value="youtube_shorts">YouTube Shorts</option>
					<option value="twitter">Twitter/X</option>
				</select>

				<select
					value={editMode}
					onChange={(e) => setEditMode(e.target.value)}
					disabled={isProcessing}
					style={{
						background: S.bg,
						color: S.textPrimary,
						border: `1px solid ${S.borderColor}`,
						borderRadius: 6,
						padding: '6px 10px',
						fontFamily: S.mono,
						fontSize: 12,
					}}
				>
					<option value="game_day">Game Day</option>
					<option value="our_story">Our Story</option>
					<option value="quick_hit">Quick Hit</option>
					<option value="showcase">Showcase</option>
				</select>

				<input
					type="text"
					placeholder="Topic (optional)"
					value={topic}
					onChange={(e) => setTopic(e.target.value)}
					disabled={isProcessing}
					style={{
						background: S.bg,
						color: S.textPrimary,
						border: `1px solid ${S.borderColor}`,
						borderRadius: 6,
						padding: '6px 10px',
						fontFamily: S.mono,
						fontSize: 12,
						flex: 1,
						minWidth: 120,
					}}
				/>
			</div>

			{/* Drop zone */}
			{statusStr === 'idle' || statusStr === 'error' ? (
				<div
					onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
					onDragLeave={() => setIsDragOver(false)}
					onDrop={handleDrop}
					onClick={() => fileInputRef.current?.click()}
					style={{
						border: `2px dashed ${isDragOver ? S.accentLight : S.borderColor}`,
						borderRadius: 10,
						padding: '32px 20px',
						textAlign: 'center',
						cursor: 'pointer',
						transition: 'all 0.2s ease',
						background: isDragOver ? 'rgba(45, 106, 79, 0.1)' : 'transparent',
					}}
				>
					<input
						ref={fileInputRef}
						type="file"
						accept="video/*"
						onChange={handleFileSelect}
						style={{ display: 'none' }}
					/>
					<div style={{ fontSize: 28, marginBottom: 8 }}>🎬</div>
					<div style={{ fontFamily: S.mono, fontSize: 13, color: S.textSecondary }}>
						Drop a video here or click to browse
					</div>
					<div style={{ fontFamily: S.mono, fontSize: 11, color: S.textMuted, marginTop: 6 }}>
						MP4, MOV, WEBM — Max 500MB
					</div>

					{statusStr === 'error' && state.error && (
						<div style={{
							fontFamily: S.mono,
							fontSize: 12,
							color: S.red,
							marginTop: 12,
							padding: '8px 12px',
							background: 'rgba(248, 113, 113, 0.1)',
							borderRadius: 6,
						}}>
							{state.error}
						</div>
					)}
				</div>
			) : (
				/* Progress / Result display */
				<div style={{ padding: '16px 0' }}>
					{/* Filename */}
					<div style={{
						fontFamily: S.mono,
						fontSize: 12,
						color: S.textSecondary,
						marginBottom: 12,
					}}>
						{state.filename}
					</div>

					{/* Progress bar */}
					{isProcessing && (
						<div style={{
							height: 4,
							background: S.bg,
							borderRadius: 2,
							overflow: 'hidden',
							marginBottom: 12,
						}}>
							<div style={{
								height: '100%',
								width: `${state.progress}%`,
								background: `linear-gradient(90deg, ${S.accent}, ${S.teal})`,
								borderRadius: 2,
								transition: 'width 0.5s ease',
							}} />
						</div>
					)}

					{/* Status label */}
					<div style={{
						fontFamily: S.mono,
						fontSize: 13,
						color: statusStr === 'done' ? S.accentLight
							: statusStr === 'error' ? S.red
							: S.orange,
						marginBottom: 12,
					}}>
						{statusLabels[state.status] || state.status}
					</div>

					{/* Result details */}
					{statusStr === 'done' && state.result && (
						<div style={{
							background: S.bg,
							borderRadius: 8,
							padding: 14,
							fontFamily: S.mono,
							fontSize: 12,
						}}>
							<div style={{ color: S.accentLight, marginBottom: 6 }}>
								Score: {state.result.score}/10 — {state.result.attempts} attempt{state.result.attempts !== 1 ? 's' : ''}
							</div>
							{state.result.publicUrl && (
								<a
									href={state.result.publicUrl}
									target="_blank"
									rel="noopener noreferrer"
									style={{ color: S.teal, textDecoration: 'none' }}
								>
									View in library →
								</a>
							)}
							{state.result.downloadUrl && (
								<a
									href={state.result.downloadUrl}
									target="_blank"
									rel="noopener noreferrer"
									style={{ color: S.orange, textDecoration: 'none', marginLeft: 16 }}
								>
									Download MP4
								</a>
							)}
						</div>
					)}

					{/* Error details */}
					{statusStr === 'error' && state.error && (
						<div style={{
							fontFamily: S.mono,
							fontSize: 12,
							color: S.red,
							padding: '8px 12px',
							background: 'rgba(248, 113, 113, 0.1)',
							borderRadius: 6,
						}}>
							{state.error}
						</div>
					)}

					{/* Reset button */}
					{(statusStr === 'done' || statusStr === 'error') && (
						<button
							onClick={handleReset}
							style={{
								marginTop: 12,
								fontFamily: S.mono,
								fontSize: 12,
								color: S.textSecondary,
								background: 'transparent',
								border: `1px solid ${S.borderColor}`,
								borderRadius: 6,
								padding: '6px 14px',
								cursor: 'pointer',
							}}
						>
							Upload another
						</button>
					)}
				</div>
			)}
		</div>
	);
}
