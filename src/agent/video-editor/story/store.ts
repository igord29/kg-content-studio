/**
 * Persistence for Story Studio projects, the per-video footage index and
 * generated media. Everything lives on the persistent volume so projects
 * survive redeploys.
 *
 * File: src/agent/video-editor/story/store.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolvePersistentDir } from '../google-drive';
import type { FootageMoment, SourceInfo, StoryProject } from './types';

export function storyRoot(): string {
	const dir = path.join(resolvePersistentDir(), 'story');
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export function projectDir(id: string): string {
	if (!/^[a-z0-9-]+$/.test(id)) throw new Error('bad project id');
	const dir = path.join(storyRoot(), 'projects', id);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export function newProjectId(): string {
	return 'sp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

export function saveProject(p: StoryProject): StoryProject {
	p.updatedAt = new Date().toISOString();
	const file = path.join(projectDir(p.id), 'project.json');
	fs.writeFileSync(file + '.tmp', JSON.stringify(p, null, 1));
	fs.renameSync(file + '.tmp', file);
	return p;
}

export function loadProject(id: string): StoryProject | null {
	try {
		return JSON.parse(fs.readFileSync(path.join(projectDir(id), 'project.json'), 'utf-8')) as StoryProject;
	} catch {
		return null;
	}
}

export function listProjects(): StoryProject[] {
	const dir = path.join(storyRoot(), 'projects');
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir)
		.map(id => { try { return loadProject(id); } catch { return null; } })
		.filter((p): p is StoryProject => !!p)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function deleteProject(id: string): void {
	fs.rmSync(projectDir(id), { recursive: true, force: true });
}

/** Mutate a project under a fresh read, so concurrent writers do not clobber each other. */
export function updateProject(id: string, fn: (p: StoryProject) => void): StoryProject {
	const p = loadProject(id);
	if (!p) throw new Error('project not found: ' + id);
	fn(p);
	return saveProject(p);
}

// --- footage index (shared by every project) ------------------------------------

interface FootageIndex { source: SourceInfo; moments: FootageMoment[] }

function indexFile(fileId: string): string {
	const dir = path.join(storyRoot(), 'index');
	fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, fileId.replace(/[^A-Za-z0-9_-]/g, '_') + '.json');
}

export function loadIndex(fileId: string): FootageIndex | null {
	try { return JSON.parse(fs.readFileSync(indexFile(fileId), 'utf-8')) as FootageIndex; } catch { return null; }
}

export function saveIndex(idx: FootageIndex): void {
	fs.writeFileSync(indexFile(idx.source.fileId), JSON.stringify(idx));
}

// --- bundled assets ------------------------------------------------------------------

/** assets/story is copied next to the app in the runtime image (see Dockerfile). */
export function assetDir(): string {
	const candidates = [
		process.env.STORY_ASSET_DIR || '',
		path.join(process.cwd(), 'assets', 'story'),
		'/app/assets/story',
	].filter(Boolean);
	for (const c of candidates) if (fs.existsSync(c)) return c;
	return candidates[0]!;
}

export function availableEmoji(): string[] {
	try {
		return fs.readdirSync(path.join(assetDir(), 'emoji')).filter(f => f.endsWith('.png')).map(f => f.replace(/\.png$/, ''));
	} catch { return []; }
}
