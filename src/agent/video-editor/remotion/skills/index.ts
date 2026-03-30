/**
 * Skills Injection System
 *
 * Loads domain-specific knowledge from markdown files and injects
 * relevant skills into Claude's edit plan prompts based on the
 * video topic and edit mode.
 *
 * Pattern adapted from remotion-dev/template-prompt-to-motion-graphics-saas
 */

import * as fs from 'fs';
import * as path from 'path';

const SKILLS_DIR = path.join(__dirname);

// Skill definitions with their trigger keywords
const SKILL_REGISTRY: Array<{
	name: string;
	file: string;
	triggers: string[];
}> = [
	{
		name: 'clc-tennis',
		file: 'clc-tennis.md',
		triggers: ['tennis', 'court', 'rally', 'serve', 'match', 'game_day', 'quick_hit', 'us open', 'usopen', 'hempstead', 'brooklyn', 'long beach'],
	},
	{
		name: 'social-media',
		file: 'social-media.md',
		triggers: ['tiktok', 'instagram', 'reels', 'youtube', 'shorts', 'facebook', 'linkedin', 'social', 'viral'],
	},
	{
		name: 'transitions',
		file: 'transitions.md',
		triggers: ['transition', 'fade', 'slide', 'wipe', 'cut', 'scene change'],
	},
	{
		name: 'captions',
		file: 'captions.md',
		triggers: ['caption', 'subtitle', 'text', 'word highlight', 'tiktok style'],
	},
	{
		name: 'text-animations',
		file: 'text-animations.md',
		triggers: ['typewriter', 'text animation', 'word highlight', 'typography'],
	},
	{
		name: 'trimming',
		file: 'trimming.md',
		triggers: ['trim', 'cut', 'clip', 'offset'],
	},
];

// Cache loaded skill content
const skillCache = new Map<string, string>();

function loadSkill(fileName: string): string {
	if (skillCache.has(fileName)) {
		return skillCache.get(fileName)!;
	}

	const filePath = path.join(SKILLS_DIR, fileName);
	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		// Strip YAML frontmatter
		const stripped = content.replace(/^---[\s\S]*?---\n/, '');
		skillCache.set(fileName, stripped);
		return stripped;
	} catch {
		return '';
	}
}

/**
 * Detect which skills are relevant for a given topic, mode, and platform.
 */
export function detectSkills(topic: string, mode: string, platform: string): string[] {
	const searchText = `${topic} ${mode} ${platform}`.toLowerCase();
	const matched: string[] = [];

	for (const skill of SKILL_REGISTRY) {
		if (skill.triggers.some(t => searchText.includes(t))) {
			matched.push(skill.name);
		}
	}

	// Always include CLC tennis skills (it's our domain)
	if (!matched.includes('clc-tennis')) {
		matched.push('clc-tennis');
	}

	// Always include social-media for any platform-targeted content
	if (!matched.includes('social-media')) {
		matched.push('social-media');
	}

	return matched;
}

/**
 * Get combined skill content for injection into Claude's prompt.
 * Returns a formatted string with all relevant skills concatenated.
 */
export function getSkillsForPrompt(topic: string, mode: string, platform: string): string {
	const skills = detectSkills(topic, mode, platform);

	const contents = skills
		.map(name => {
			const skill = SKILL_REGISTRY.find(s => s.name === name);
			if (!skill) return '';
			const content = loadSkill(skill.file);
			return content ? `### Skill: ${skill.name}\n${content}` : '';
		})
		.filter(c => c.length > 0);

	if (contents.length === 0) return '';

	return `\n\n--- DOMAIN KNOWLEDGE (skills injected based on your topic/mode) ---\n${contents.join('\n\n---\n\n')}\n--- END DOMAIN KNOWLEDGE ---\n`;
}
