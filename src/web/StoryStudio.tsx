/**
 * Story Studio — make a narrated story video step by step:
 * Story & footage → Script → Voice-over → Storyboard → Render.
 *
 * Backend: src/api/story.ts. Long steps (voice, storyboard, render) run as
 * server jobs; this page polls the project while one is running, so it is
 * safe to leave the page and come back.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useIsMobile } from './useMediaQuery';

// --- types (mirror src/agent/video-editor/story/types.ts) -------------------------
interface StoryLine { text: string; pauseAfter?: number; emoji?: string; emojiWord?: string; highlight?: string[]; sfx?: string; title?: string; visual?: string }
interface Shot {
	start: number; dur: number; line: number; fileId: string; t: number; x: number; y?: number; zoom: number; lift?: boolean;
	trans?: string; note?: string; alternatives?: Array<{ fileId: string; t: number; x: number; desc: string }>;
}
interface Job { step: string; state: 'running' | 'done' | 'failed'; progress: string; error?: string; startedAt: string }
interface Project {
	id: string; title: string; facts: string; audience: string; callToAction: string; targetSeconds: number; cardText?: string;
	videoIds: string[]; status: 'draft' | 'scripted' | 'voiced' | 'storyboarded' | 'rendered';
	script?: { lines: StoryLine[]; openingTitle?: string };
	voice?: { provider: string; voiceId: string; segments: Array<{ line: number; start: number; end: number; file: string }>; totalSeconds: number };
	sources?: Array<{ fileId: string; name: string }>;
	storyboard?: Shot[];
	outputs?: { vertical?: string; wide?: string; srt?: string; thumbnail?: string; thumbnailWide?: string; postKit?: string };
	job?: Job; updatedAt: string;
}
interface Footage { fileId: string; name: string; thumbnail?: string; activity?: string; location?: string; contentType?: string; quality?: string; indexed?: boolean }
interface Options { voices: Array<{ provider: string; voices: string[]; default: string }>; emoji: Array<{ code: string; name: string }>; sfx: string[]; transitions: string[] }

// --- look ---------------------------------------------------------------------------
const C = { bg: '#0a0d14', panel: '#111622', line: '#1d2435', text: '#e2e8f0', dim: '#7a86a8', green: '#2D6A4F', accent: '#F5D547', red: '#e5484d' };
const panel: CSSProperties = { background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, marginBottom: 20 };
const input: CSSProperties = { width: '100%', background: '#0b0f19', color: C.text, border: `1px solid ${C.line}`, borderRadius: 8, padding: '9px 11px', fontSize: 14, fontFamily: 'inherit' };
const label: CSSProperties = { display: 'block', fontSize: 12, color: C.dim, margin: '12px 0 5px', letterSpacing: 0.5, textTransform: 'uppercase', fontFamily: "'Space Mono', monospace" };
const btn = (kind: 'primary' | 'plain' | 'danger' = 'plain', disabled = false): CSSProperties => ({
	background: kind === 'primary' ? C.green : kind === 'danger' ? 'transparent' : '#1a2132', color: kind === 'danger' ? C.red : '#fff',
	border: `1px solid ${kind === 'primary' ? C.green : kind === 'danger' ? C.red + '66' : C.line}`, borderRadius: 8, padding: '9px 16px',
	fontSize: 14, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1, fontFamily: 'inherit',
});
const emojiChar = (code?: string) => { try { return code ? String.fromCodePoint(...code.split('-').map(h => parseInt(h, 16))) : ''; } catch { return ''; } };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch('/api' + url, { headers: { 'content-type': 'application/json' }, ...init });
	const text = await res.text();
	let body: unknown = text;
	try { body = JSON.parse(text); } catch { /* text */ }
	if (!res.ok) throw new Error((body as { error?: string })?.error || String(text).slice(0, 300) || res.statusText);
	return body as T;
}

const STEPS = ['Story & footage', 'Script', 'Voice-over', 'Storyboard', 'Render'] as const;
const stepUnlocked = (p: Project, i: number) => {
	const order = ['draft', 'scripted', 'voiced', 'storyboarded', 'rendered'];
	return i <= order.indexOf(p.status) + 1 && (i < 1 || !!p.facts.trim());
};

// --- page -----------------------------------------------------------------------------
export function StoryStudio({ onBack }: { onBack: () => void }) {
	const isMobile = useIsMobile();
	const [projects, setProjects] = useState<Project[] | null>(null);
	const [openId, setOpenId] = useState<string | null>(null);
	const [error, setError] = useState('');

	const refreshList = useCallback(() => {
		api<{ projects: Project[] }>('/story/projects').then(r => setProjects(r.projects)).catch(e => setError(e.message));
	}, []);
	useEffect(refreshList, [refreshList]);

	const create = async () => {
		try {
			const p = await api<Project>('/story/projects', { method: 'POST', body: JSON.stringify({ title: 'New story' }) });
			setOpenId(p.id);
		} catch (e) { setError((e as Error).message); }
	};

	return (
		<div style={{ minHeight: '100vh', background: C.bg, color: C.text, fontFamily: "'Source Serif 4', Georgia, serif" }}>
			<style>{`@import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@300;400;600;700&family=Space+Mono:wght@400;700&display=swap'); * { box-sizing: border-box; }`}</style>
			<header style={{ display: 'flex', alignItems: 'center', gap: 16, padding: isMobile ? '16px' : '20px 32px', borderBottom: `1px solid ${C.line}` }}>
				<button style={btn()} onClick={openId ? () => { setOpenId(null); refreshList(); } : onBack}>← {openId ? 'All stories' : 'Home'}</button>
				<div>
					<div style={{ fontSize: 20, fontWeight: 700 }}>Story Studio</div>
					<div style={{ fontSize: 12, color: C.dim, fontFamily: "'Space Mono', monospace" }}>Narrated videos with captions, emoji, sound and end card</div>
				</div>
			</header>
			<main style={{ maxWidth: 1100, margin: '0 auto', padding: isMobile ? 16 : 32 }}>
				{error && <div style={{ ...panel, borderColor: C.red, color: C.red }} onClick={() => setError('')}>{error}</div>}
				{openId ? <ProjectEditor id={openId} /> : (
					<>
						<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
							<h2 style={{ fontWeight: 300, fontSize: 26, margin: 0 }}>Your stories</h2>
							<button style={btn('primary')} onClick={create}>+ New story video</button>
						</div>
						{projects === null ? <p style={{ color: C.dim }}>Loading…</p> : projects.length === 0 ? (
							<div style={panel}>
								<p style={{ marginTop: 0 }}>No stories yet. A story video goes through five steps:</p>
								<ol style={{ color: C.dim, lineHeight: 1.8 }}>
									<li>Say what happened and pick the footage</li>
									<li>The script is written for you; edit any line, emoji, highlight or sound</li>
									<li>The voice-over is recorded line by line</li>
									<li>Every line gets a shot; swap any shot you don't like</li>
									<li>Render: 9:16 and 16:9 videos, captions file, thumbnails and post copy</li>
								</ol>
							</div>
						) : projects.map(p => (
							<div key={p.id} style={{ ...panel, display: 'flex', alignItems: 'center', gap: 16, cursor: 'pointer', padding: 14 }} onClick={() => setOpenId(p.id)}>
								{p.outputs?.thumbnail
									? <img src={`/api/story/projects/${p.id}/files/${p.outputs.thumbnail}`} style={{ width: 54, height: 96, objectFit: 'cover', borderRadius: 6 }} />
									: <div style={{ width: 54, height: 96, borderRadius: 6, background: '#1a2132', display: 'grid', placeItems: 'center', fontSize: 24 }}>🎬</div>}
								<div style={{ flex: 1 }}>
									<div style={{ fontSize: 17, fontWeight: 600 }}>{p.title}</div>
									<div style={{ fontSize: 13, color: C.dim, marginTop: 4 }}>
										{p.job?.state === 'running' ? `⏳ ${p.job.step}: ${p.job.progress}` : `Step: ${p.status}`} · {new Date(p.updatedAt).toLocaleString()}
									</div>
								</div>
							</div>
						))}
					</>
				)}
			</main>
		</div>
	);
}

// --- one project ------------------------------------------------------------------------
function ProjectEditor({ id }: { id: string }) {
	const [p, setP] = useState<Project | null>(null);
	const [step, setStep] = useState(0);
	const [busy, setBusy] = useState('');
	const [err, setErr] = useState('');
	const [opts, setOpts] = useState<Options | null>(null);
	const first = useRef(true);

	const load = useCallback(async () => {
		const q = await api<Project>(`/story/projects/${id}`);
		setP(q);
		if (first.current) {
			first.current = false;
			setStep({ draft: 0, scripted: 1, voiced: 2, storyboarded: 3, rendered: 4 }[q.status]);
		}
		return q;
	}, [id]);
	useEffect(() => { load().catch(e => setErr(e.message)); api<Options>('/story/options').then(setOpts).catch(() => {}); }, [load]);

	// Poll while a server job runs; jump to the next step when it finishes.
	const running = p?.job?.state === 'running';
	useEffect(() => {
		if (!running) return;
		const h = setInterval(async () => {
			const q = await load().catch(() => null);
			if (q && q.job?.state !== 'running') {
				if (q.job?.state === 'done') setStep({ voice: 2, storyboard: 3, render: 4 }[q.job.step as 'voice'] ?? step);
				if (q.job?.state === 'failed') setErr(q.job.error || 'Step failed');
			}
		}, 2500);
		return () => clearInterval(h);
	}, [running, load, step]);

	const act = async (what: string, fn: () => Promise<Project>) => {
		setBusy(what); setErr('');
		try { setP(await fn()); } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
	};
	const save = (patch: Partial<Project>) => act('save', () => api<Project>(`/story/projects/${id}`, { method: 'PUT', body: JSON.stringify(patch) }));
	const post = (path: string, body: object = {}) => api<Project>(`/story/projects/${id}/${path}`, { method: 'POST', body: JSON.stringify(body) });

	if (!p) return <p style={{ color: C.dim }}>{err || 'Loading…'}</p>;
	const locked = running || !!busy;

	return (
		<div>
			<div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 20 }}>
				{STEPS.map((s, i) => {
					const ok = stepUnlocked(p, i);
					return (
						<button key={s} disabled={!ok} onClick={() => setStep(i)} style={{
							...btn(i === step ? 'primary' : 'plain', !ok), borderRadius: 20, padding: '7px 14px', fontSize: 13,
						}}>{i + 1}. {s}</button>
					);
				})}
			</div>
			{running && (
				<div style={{ ...panel, borderColor: C.accent + '88' }}>
					<div style={{ fontWeight: 600 }}>⏳ Working on: {p.job!.step}</div>
					<div style={{ color: C.dim, marginTop: 6 }}>{p.job!.progress}</div>
					<div style={{ color: C.dim, fontSize: 12, marginTop: 8 }}>You can leave this page; the work continues on the server.</div>
				</div>
			)}
			{p.job?.state === 'failed' && !running && <div style={{ ...panel, borderColor: C.red, color: C.red }}>Last step ({p.job.step}) failed: {p.job.error}</div>}
			{err && <div style={{ ...panel, borderColor: C.red, color: C.red }}>{err}</div>}

			{step === 0 && <StoryStep p={p} locked={locked} onSave={async patch => { await save(patch); }} onNext={() => setStep(1)} />}
			{step === 1 && <ScriptStep p={p} opts={opts} locked={locked} busy={busy}
				onWrite={() => act('script', () => post('script'))}
				onSave={lines => save({ script: { lines, openingTitle: p.script?.openingTitle } })}
				onTitle={openingTitle => save({ script: { lines: p.script?.lines ?? [], openingTitle } })}
				onNext={() => setStep(2)} />}
			{step === 2 && <VoiceStep p={p} opts={opts} locked={locked} onVoice={(provider, voice) => act('voice', () => post('voice', { provider, voice }))} onNext={() => setStep(3)} />}
			{step === 3 && <StoryboardStep p={p} opts={opts} locked={locked}
				onBuild={() => act('storyboard', () => post('storyboard'))}
				onSave={storyboard => save({ storyboard })}
				onNext={() => setStep(4)} />}
			{step === 4 && <RenderStep p={p} locked={locked} onRender={() => act('render', () => post('render'))} />}
		</div>
	);
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
	return (
		<div style={panel}>
			<h3 style={{ margin: 0, fontSize: 19 }}>{title}</h3>
			{hint && <p style={{ color: C.dim, fontSize: 14, margin: '6px 0 0', lineHeight: 1.5 }}>{hint}</p>}
			<div style={{ marginTop: 12 }}>{children}</div>
		</div>
	);
}

// --- step 1: story + footage --------------------------------------------------------------
function StoryStep({ p, locked, onSave, onNext }: { p: Project; locked: boolean; onSave: (x: Partial<Project>) => Promise<void>; onNext: () => void }) {
	const [f, setF] = useState({ title: p.title, facts: p.facts, audience: p.audience, callToAction: p.callToAction, cardText: p.cardText ?? '', targetSeconds: p.targetSeconds });
	const [picked, setPicked] = useState<string[]>(p.videoIds);
	const [footage, setFootage] = useState<Footage[] | null>(null);
	const [folder, setFolder] = useState('');
	const [q, setQ] = useState('');
	const [ferr, setFerr] = useState('');

	const loadFootage = useCallback((fold?: string) => {
		setFootage(null); setFerr('');
		api<{ videos: Footage[]; error?: string }>('/story/footage' + (fold ? `?folder=${encodeURIComponent(fold)}` : ''))
			.then(r => { setFootage(r.videos); if (r.error) setFerr(r.error); })
			.catch(e => { setFootage([]); setFerr(e.message); });
	}, []);
	useEffect(() => loadFootage(), [loadFootage]);

	const shown = useMemo(() => {
		const words = q.toLowerCase().split(/\s+/).filter(Boolean);
		return (footage ?? []).filter(v => words.every(w => `${v.name} ${v.activity ?? ''} ${v.location ?? ''} ${v.contentType ?? ''}`.toLowerCase().includes(w)));
	}, [footage, q]);
	const toggle = (id: string) => setPicked(x => x.includes(id) ? x.filter(y => y !== id) : x.length >= 12 ? x : [...x, id]);
	const dirty = JSON.stringify({ ...f, videoIds: picked }) !== JSON.stringify({ title: p.title, facts: p.facts, audience: p.audience, callToAction: p.callToAction, cardText: p.cardText ?? '', targetSeconds: p.targetSeconds, videoIds: p.videoIds });
	const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: k === 'targetSeconds' ? Number(e.target.value) : e.target.value });

	return (
		<>
			<Section title="The story" hint="Only what you write here goes in the script, so include names of places, programs and anything the narrator must say. Never put children's names here.">
				<label style={label}>Title</label>
				<input style={input} value={f.title} onChange={set('title')} />
				<label style={label}>What happened (the facts)</label>
				<textarea style={{ ...input, minHeight: 130 }} value={f.facts} onChange={set('facts')}
					placeholder="e.g. Saturday chess class at the library. Most of the kids had never played. They learn one piece at a time, shake hands win or lose, and it builds patience and focus they take back to school." />
				<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
					<div><label style={label}>Audience</label><input style={input} value={f.audience} onChange={set('audience')} /></div>
					<div><label style={label}>Call to action (last line)</label><input style={input} value={f.callToAction} onChange={set('callToAction')} /></div>
					<div><label style={label}>End card headline</label><input style={input} value={f.cardText} onChange={set('cardText')} placeholder="Follow the journey" /></div>
					<div><label style={label}>Length</label>
						<select style={input} value={f.targetSeconds} onChange={set('targetSeconds')}>
							{[30, 45, 60, 75, 90].map(s => <option key={s} value={s}>{s} seconds</option>)}
						</select>
					</div>
				</div>
			</Section>
			<Section title={`Footage (${picked.length} picked)`} hint="Pick 3 to 8 videos from the same event or class. The storyboard step watches every second of them, so more and longer videos take longer.">
				<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
					<input style={{ ...input, flex: 2, minWidth: 200 }} placeholder="Search: chess, library, red ball, gym…" value={q} onChange={e => setQ(e.target.value)} />
					<input style={{ ...input, flex: 2, minWidth: 200 }} placeholder="…or paste a Google Drive folder link" value={folder} onChange={e => setFolder(e.target.value)} />
					<button style={btn()} onClick={() => loadFootage(folder.trim() || undefined)}>{folder.trim() ? 'Load folder' : 'Reload'}</button>
				</div>
				{ferr && <p style={{ color: C.red, fontSize: 13 }}>{ferr}</p>}
				<div style={{ maxHeight: 420, overflowY: 'auto', marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 8 }}>
					{footage === null ? <p style={{ color: C.dim }}>Loading footage…</p> : shown.slice(0, 300).map(v => {
						const on = picked.includes(v.fileId);
						return (
							<div key={v.fileId} onClick={() => toggle(v.fileId)} style={{
								display: 'flex', gap: 10, padding: 8, borderRadius: 8, cursor: 'pointer',
								border: `1px solid ${on ? C.accent : C.line}`, background: on ? '#1d1f12' : '#0b0f19',
							}}>
								{v.thumbnail ? <img src={v.thumbnail} referrerPolicy="no-referrer" style={{ width: 64, height: 48, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }} /> : <div style={{ width: 64, height: 48, background: '#1a2132', borderRadius: 4, flexShrink: 0 }} />}
								<div style={{ fontSize: 12, overflow: 'hidden' }}>
									<div style={{ fontWeight: 600, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{on ? '✓ ' : ''}{v.name}</div>
									<div style={{ color: C.dim, marginTop: 2, lineHeight: 1.3 }}>{[v.activity, v.location].filter(Boolean).join(' · ').slice(0, 90)}</div>
									{v.indexed && <div style={{ color: C.accent, marginTop: 2 }}>already watched</div>}
								</div>
							</div>
						);
					})}
				</div>
			</Section>
			<div style={{ display: 'flex', gap: 10 }}>
				<button style={btn('plain', locked || !dirty)} disabled={locked || !dirty} onClick={() => onSave({ ...f, videoIds: picked })}>Save</button>
				<button style={btn('primary', locked || !f.facts.trim())} disabled={locked || !f.facts.trim()}
					onClick={async () => { if (dirty) await onSave({ ...f, videoIds: picked }); onNext(); }}>Next: script →</button>
			</div>
		</>
	);
}

// --- step 2: script -------------------------------------------------------------------------
function ScriptStep({ p, opts, locked, busy, onWrite, onSave, onTitle, onNext }: {
	p: Project; opts: Options | null; locked: boolean; busy: string;
	onWrite: () => void; onSave: (l: StoryLine[]) => void; onTitle: (t: string) => void; onNext: () => void;
}) {
	const [lines, setLines] = useState<StoryLine[]>(p.script?.lines ?? []);
	const [opening, setOpening] = useState(p.script?.openingTitle ?? '');
	useEffect(() => { setLines(p.script?.lines ?? []); setOpening(p.script?.openingTitle ?? ''); }, [p.script]);
	const dirty = JSON.stringify(lines) !== JSON.stringify(p.script?.lines ?? []);
	const upd = (i: number, patch: Partial<StoryLine>) => setLines(ls => ls.map((l, j) => j === i ? { ...l, ...patch } : l));
	const move = (i: number, d: number) => setLines(ls => { const x = [...ls]; const [a] = x.splice(i, 1); x.splice(i + d, 0, a!); return x; });
	const words = lines.reduce((n, l) => n + l.text.split(/\s+/).filter(Boolean).length, 0);

	return (
		<>
			<Section title="Script" hint="Each line is spoken, captioned and gets its own shot. Yellow words are highlighted in the captions; the emoji pops on its word. Changing words means recording the voice again.">
				<div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
					<button style={btn('primary', locked)} disabled={locked} onClick={() => { if (!lines.length || confirm('Write a new script? This replaces the current lines.')) onWrite(); }}>
						{busy === 'script' ? 'Writing… (about 30s)' : lines.length ? '↻ Rewrite script' : '✍️ Write the script'}
					</button>
					{lines.length > 0 && <span style={{ color: C.dim, fontSize: 13 }}>{lines.length} lines · {words} words · about {Math.round(words / 2.6 + 6)}s</span>}
				</div>
				{lines.length > 0 && (
					<>
						<label style={label}>Opening title slam</label>
						<div style={{ display: 'flex', gap: 8 }}>
							<input style={input} value={opening} onChange={e => setOpening(e.target.value)} placeholder="e.g. SATURDAY @ THE LIBRARY" />
							{opening !== (p.script?.openingTitle ?? '') && <button style={btn()} disabled={locked} onClick={() => onTitle(opening)}>Save</button>}
						</div>
					</>
				)}
			</Section>
			{lines.map((l, i) => (
				<div key={i} style={{ ...panel, padding: 14, marginBottom: 10 }}>
					<div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
						<div style={{ color: C.dim, fontFamily: "'Space Mono', monospace", fontSize: 12, paddingTop: 10, width: 22 }}>{i + 1}</div>
						<div style={{ flex: 1 }}>
							<textarea style={{ ...input, fontSize: 16, minHeight: 44 }} rows={1} value={l.text} onChange={e => upd(i, { text: e.target.value })} />
							<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginTop: 8 }}>
								<div><label style={{ ...label, marginTop: 0 }}>Highlight words</label>
									<input style={input} value={(l.highlight ?? []).join(', ')} onChange={e => upd(i, { highlight: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} /></div>
								<div><label style={{ ...label, marginTop: 0 }}>Emoji {emojiChar(l.emoji)}</label>
									<select style={input} value={l.emoji ?? ''} onChange={e => upd(i, { emoji: e.target.value || undefined })}>
										<option value="">none</option>
										{opts?.emoji.map(e => <option key={e.code} value={e.code}>{emojiChar(e.code)} {e.name}</option>)}
									</select></div>
								<div><label style={{ ...label, marginTop: 0 }}>Emoji on word</label>
									<input style={input} value={l.emojiWord ?? ''} onChange={e => upd(i, { emojiWord: e.target.value || undefined })} /></div>
								<div><label style={{ ...label, marginTop: 0 }}>Sound</label>
									<select style={input} value={l.sfx ?? ''} onChange={e => upd(i, { sfx: e.target.value || undefined })}>
										<option value="">none</option>
										{opts?.sfx.map(s => <option key={s} value={s}>{s}</option>)}
									</select></div>
								<div><label style={{ ...label, marginTop: 0 }}>Title slam</label>
									<input style={input} value={l.title ?? ''} onChange={e => upd(i, { title: e.target.value || undefined })} /></div>
								<div><label style={{ ...label, marginTop: 0 }}>Pause after (s)</label>
									<input style={input} type="number" step={0.1} min={0} max={1.2} value={l.pauseAfter ?? 0} onChange={e => upd(i, { pauseAfter: Number(e.target.value) })} /></div>
							</div>
							<label style={{ ...label, marginTop: 8 }}>Footage should show</label>
							<input style={input} value={l.visual ?? ''} onChange={e => upd(i, { visual: e.target.value || undefined })} />
						</div>
						<div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
							<button style={{ ...btn(), padding: '4px 9px' }} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
							<button style={{ ...btn(), padding: '4px 9px' }} disabled={i === lines.length - 1} onClick={() => move(i, 1)}>↓</button>
							<button style={{ ...btn('danger'), padding: '4px 9px' }} onClick={() => setLines(ls => ls.filter((_, j) => j !== i))}>✕</button>
						</div>
					</div>
				</div>
			))}
			{lines.length > 0 && (
				<div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
					<button style={btn()} onClick={() => setLines(ls => [...ls, { text: '' }])}>+ Add line</button>
					<button style={btn('plain', locked || !dirty)} disabled={locked || !dirty} onClick={() => onSave(lines)}>Save changes</button>
					<button style={btn('primary', locked)} disabled={locked} onClick={() => { if (dirty) onSave(lines); onNext(); }}>Next: voice-over →</button>
				</div>
			)}
		</>
	);
}

// --- step 3: voice -----------------------------------------------------------------------------
function VoiceStep({ p, opts, locked, onVoice, onNext }: { p: Project; opts: Options | null; locked: boolean; onVoice: (provider: string, voice: string) => void; onNext: () => void }) {
	const providers = opts?.voices ?? [];
	const [prov, setProv] = useState(p.voice?.provider ?? providers[0]?.provider ?? '');
	const cur = providers.find(x => x.provider === prov) ?? providers[0];
	const [voice, setVoice] = useState(p.voice?.voiceId ?? cur?.default ?? '');
	useEffect(() => { if (!prov && providers[0]) { setProv(providers[0].provider); setVoice(providers[0].default); } }, [providers, prov]);
	const lines = p.script?.lines ?? [];

	return (
		<Section title="Voice-over" hint="Each line is recorded separately, so the captions, emoji and shots land exactly on the words.">
			{providers.length === 0 ? <p style={{ color: C.red }}>No voice provider is set up on the server. Add ELEVENLABS_API_KEY (for the Brian voice) or OPENAI_API_KEY in Railway.</p> : (
				<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
					<select style={{ ...input, width: 'auto' }} value={cur?.provider} onChange={e => { setProv(e.target.value); setVoice(providers.find(x => x.provider === e.target.value)?.default ?? ''); }}>
						{providers.map(x => <option key={x.provider} value={x.provider}>{x.provider === 'elevenlabs' ? 'ElevenLabs' : 'OpenAI'}</option>)}
					</select>
					<select style={{ ...input, width: 'auto' }} value={voice} onChange={e => setVoice(e.target.value)}>
						{cur?.voices.map(v => <option key={v} value={v}>{v}{v === cur.default ? ' (default)' : ''}</option>)}
					</select>
					<button style={btn('primary', locked)} disabled={locked} onClick={() => cur && onVoice(cur.provider, voice)}>🎙️ {p.voice ? 'Record again' : 'Record voice-over'}</button>
				</div>
			)}
			{p.voice && (
				<>
					<p style={{ color: C.dim, fontSize: 13 }}>{p.voice.provider} · {p.voice.voiceId} · video length {p.voice.totalSeconds.toFixed(1)}s (with end card)</p>
					{p.voice.segments.map(s => (
						<div key={s.file} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', borderTop: `1px solid ${C.line}`, flexWrap: 'wrap' }}>
							<span style={{ color: C.dim, fontFamily: "'Space Mono', monospace", fontSize: 12, width: 52 }}>{s.start.toFixed(1)}s</span>
							<span style={{ flex: 1, minWidth: 200 }}>{lines[s.line]?.text}</span>
							<audio controls preload="none" src={`/api/story/projects/${p.id}/voice/${s.file}`} style={{ height: 32 }} />
						</div>
					))}
					<button style={{ ...btn('primary', locked), marginTop: 12 }} disabled={locked} onClick={onNext}>Next: storyboard →</button>
				</>
			)}
		</Section>
	);
}

// --- step 4: storyboard --------------------------------------------------------------------------
const frameUrl = (fileId: string, t: number, w = 240) => `/api/story/frame?fileId=${encodeURIComponent(fileId)}&t=${t.toFixed(1)}&w=${w}`;

function StoryboardStep({ p, opts, locked, onBuild, onSave, onNext }: { p: Project; opts: Options | null; locked: boolean; onBuild: () => void; onSave: (s: Shot[]) => void; onNext: () => void }) {
	const [shots, setShots] = useState<Shot[]>(p.storyboard ?? []);
	const [open, setOpen] = useState<number | null>(null);
	useEffect(() => setShots(p.storyboard ?? []), [p.storyboard]);
	const dirty = JSON.stringify(shots) !== JSON.stringify(p.storyboard ?? []);
	const upd = (i: number, patch: Partial<Shot>) => setShots(ss => ss.map((s, j) => j === i ? { ...s, ...patch } : s));
	const lines = p.script?.lines ?? [];
	const name = (fileId: string) => p.sources?.find(s => s.fileId === fileId)?.name ?? fileId.slice(0, 8);

	return (
		<>
			<Section title="Storyboard" hint="The footage is watched second by second (who is in shot, what they're doing, where they are in the frame), then every line gets a shot. Click a shot to swap it, nudge its timing, move the crop or brighten it.">
				<button style={btn('primary', locked || !p.videoIds.length)} disabled={locked || !p.videoIds.length} onClick={() => { if (!shots.length || confirm('Pick all shots again? Your swaps will be lost.')) onBuild(); }}>
					{shots.length ? '↻ Pick shots again' : '🎞️ Find shots'}
				</button>
				{!p.videoIds.length && <span style={{ color: C.red, marginLeft: 10 }}>Pick footage in step 1 first.</span>}
				{!shots.length && p.videoIds.length > 0 && <p style={{ color: C.dim, fontSize: 13 }}>The first time a video is used it takes 1 to 3 minutes per video to watch. After that it's instant.</p>}
			</Section>
			{shots.length > 0 && (
				<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10, marginBottom: 20 }}>
					{shots.map((s, i) => (
						<div key={i} onClick={() => setOpen(open === i ? null : i)} style={{ background: C.panel, border: `1px solid ${open === i ? C.accent : C.line}`, borderRadius: 10, overflow: 'hidden', cursor: 'pointer' }}>
							<div style={{ position: 'relative', aspectRatio: '9 / 12', background: '#000', overflow: 'hidden' }}>
								<img src={frameUrl(s.fileId, s.t + s.dur / 2)} loading="lazy" style={{ position: 'absolute', height: '100%', left: `${50 - (s.x - 0.5) * 100}%`, transform: `translateX(-50%) scale(${s.zoom || 1})`, filter: s.lift ? 'brightness(1.3)' : undefined }} />
								<div style={{ position: 'absolute', top: 4, left: 4, background: '#000a', borderRadius: 4, padding: '1px 6px', fontSize: 11, fontFamily: "'Space Mono', monospace" }}>{s.start.toFixed(1)}s</div>
								{s.trans && s.trans !== 'cut' && <div style={{ position: 'absolute', bottom: 4, right: 4, background: C.green, borderRadius: 4, padding: '1px 6px', fontSize: 10 }}>→ {s.trans}</div>}
							</div>
							<div style={{ padding: 8, fontSize: 12, lineHeight: 1.35 }}>
								<div>{lines[s.line]?.text.slice(0, 70)}</div>
								<div style={{ color: C.dim, marginTop: 3 }}>{s.note}</div>
							</div>
						</div>
					))}
				</div>
			)}
			{open !== null && shots[open] && (() => {
				const s = shots[open]!;
				return (
					<Section title={`Shot ${open + 1} · ${s.dur.toFixed(1)}s`} hint={`Under: "${lines[s.line]?.text}"${lines[s.line]?.visual ? ` (should show: ${lines[s.line]?.visual})` : ''}`}>
						<div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
							<img src={frameUrl(s.fileId, s.t + s.dur / 2, 480)} style={{ width: 320, maxWidth: '100%', borderRadius: 8 }} />
							<div style={{ flex: 1, minWidth: 260 }}>
								<div style={{ fontSize: 13, color: C.dim }}>{name(s.fileId)} at {s.t.toFixed(1)}s</div>
								<label style={label}>Timing</label>
								<div style={{ display: 'flex', gap: 6 }}>
									{[-3, -1, 1, 3].map(d => <button key={d} style={btn()} onClick={() => upd(open, { t: Math.max(0, +(s.t + d).toFixed(2)) })}>{d > 0 ? `+${d}s` : `${d}s`}</button>)}
								</div>
								<label style={label}>Crop position (vertical video): {Math.round(s.x * 100)}%</label>
								<input type="range" min={0} max={1} step={0.02} value={s.x} onChange={e => upd(open, { x: Number(e.target.value) })} style={{ width: '100%' }} />
								<label style={label}>Crop height (when zoomed): {Math.round((s.y ?? 0.6) * 100)}% down</label>
								<input type="range" min={0} max={1} step={0.02} value={s.y ?? 0.6} onChange={e => upd(open, { y: Number(e.target.value) })} style={{ width: '100%' }} />
								<div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
									<label style={{ fontSize: 14 }}><input type="checkbox" checked={!!s.lift} onChange={e => upd(open, { lift: e.target.checked })} /> Brighten</label>
									<label style={{ fontSize: 14 }}>Zoom <select style={{ ...input, width: 'auto', padding: '4px 8px' }} value={s.zoom || 1} onChange={e => upd(open, { zoom: Number(e.target.value) })}>
										{[1, 1.12, 1.2, 1.35, 1.5].map(z => <option key={z} value={z}>{z}x</option>)}
									</select></label>
									<label style={{ fontSize: 14 }}>Transition to next <select style={{ ...input, width: 'auto', padding: '4px 8px' }} value={s.trans ?? 'cut'} onChange={e => upd(open, { trans: e.target.value })}>
										{(opts?.transitions ?? ['cut']).map(t => <option key={t} value={t}>{t}</option>)}
									</select></label>
								</div>
							</div>
						</div>
						{!!s.alternatives?.length && (
							<>
								<label style={label}>Swap for another shot</label>
								<div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 6 }}>
									{s.alternatives.map((a, k) => (
										<div key={k} style={{ width: 150, flexShrink: 0, cursor: 'pointer' }} onClick={() => {
											const rest = [...(s.alternatives ?? [])];
											rest.splice(k, 1, { fileId: s.fileId, t: s.t, x: s.x, desc: s.note ?? '' });
											upd(open, { fileId: a.fileId, t: a.t, x: a.x, y: undefined, note: a.desc, alternatives: rest });
										}}>
											<img src={frameUrl(a.fileId, a.t + s.dur / 2)} loading="lazy" style={{ width: 150, height: 100, objectFit: 'cover', borderRadius: 6 }} />
											<div style={{ fontSize: 11, color: C.dim }}>{a.desc}</div>
										</div>
									))}
								</div>
							</>
						)}
					</Section>
				);
			})()}
			{shots.length > 0 && (
				<div style={{ display: 'flex', gap: 10 }}>
					<button style={btn('plain', locked || !dirty)} disabled={locked || !dirty} onClick={() => onSave(shots)}>Save changes</button>
					<button style={btn('primary', locked)} disabled={locked} onClick={() => { if (dirty) onSave(shots); onNext(); }}>Next: render →</button>
				</div>
			)}
		</>
	);
}

// --- step 5: render ---------------------------------------------------------------------------------
function RenderStep({ p, locked, onRender }: { p: Project; locked: boolean; onRender: () => void }) {
	const o = p.outputs;
	const file = (n?: string) => (n ? `/api/story/projects/${p.id}/files/${n}` : '');
	const [kit, setKit] = useState('');
	useEffect(() => { if (o?.postKit) fetch(file(o.postKit)).then(r => r.text()).then(setKit).catch(() => {}); }, [o?.postKit]); // eslint-disable-line react-hooks/exhaustive-deps
	const shotsNewer = p.status !== 'rendered';

	return (
		<>
			<Section title="Render" hint="Makes the 9:16 (Reels, TikTok, Shorts) and 16:9 (YouTube) videos with captions, emoji, sound effects, transitions and the logo end card, plus a captions file, thumbnails and post copy for every platform. Takes about 5 to 12 minutes.">
				<button style={btn('primary', locked)} disabled={locked} onClick={onRender}>🎬 {o ? 'Render again' : 'Render videos'}</button>
				{o && shotsNewer && <span style={{ color: C.accent, marginLeft: 10, fontSize: 13 }}>You've changed things since the last render.</span>}
			</Section>
			{o && (
				<>
					<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20, marginBottom: 20 }}>
						{o.vertical && (
							<div style={panel}>
								<h3 style={{ marginTop: 0 }}>9:16 · Reels / TikTok / Shorts</h3>
								<video src={file(o.vertical)} controls playsInline style={{ width: '100%', maxHeight: 560, background: '#000', borderRadius: 8 }} />
								<a href={file(o.vertical) + '?download=1'} style={{ ...btn('primary'), display: 'inline-block', marginTop: 10, textDecoration: 'none' }}>Download</a>
							</div>
						)}
						{o.wide && (
							<div style={panel}>
								<h3 style={{ marginTop: 0 }}>16:9 · YouTube</h3>
								<video src={file(o.wide)} controls playsInline style={{ width: '100%', background: '#000', borderRadius: 8 }} />
								<a href={file(o.wide) + '?download=1'} style={{ ...btn('primary'), display: 'inline-block', marginTop: 10, textDecoration: 'none' }}>Download</a>
							</div>
						)}
					</div>
					<Section title="Extras">
						<div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
							{o.srt && <a style={{ ...btn(), textDecoration: 'none' }} href={file(o.srt) + '?download=1'}>Captions (.srt)</a>}
							{o.thumbnail && <a style={{ ...btn(), textDecoration: 'none' }} href={file(o.thumbnail) + '?download=1'}>Thumbnail 9:16</a>}
							{o.thumbnailWide && <a style={{ ...btn(), textDecoration: 'none' }} href={file(o.thumbnailWide) + '?download=1'}>Thumbnail 16:9</a>}
							{o.postKit && <a style={{ ...btn(), textDecoration: 'none' }} href={file(o.postKit) + '?download=1'}>Post kit (.md)</a>}
						</div>
					</Section>
					{kit && (
						<Section title="Post copy" hint="Titles, descriptions, hashtags and settings for each platform.">
							<textarea readOnly value={kit} style={{ ...input, minHeight: 360, fontFamily: "'Space Mono', monospace", fontSize: 12 }} />
							<button style={{ ...btn(), marginTop: 8 }} onClick={() => navigator.clipboard?.writeText(kit)}>Copy all</button>
						</Section>
					)}
				</>
			)}
		</>
	);
}
