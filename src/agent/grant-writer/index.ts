/**
 * Grant Writer Agent
 * Two modes:
 *   1. grant-search — Researches and finds grants with upcoming deadlines that fit CLC
 *   2. grant-write  — Generates grant proposals, LOIs, and funding narratives in Kimberly's voice
 */

import { createAgent } from '@agentuity/runtime';
import { s } from '@agentuity/schema';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { systemPrompt } from '../content-creator/kimberly-voice';

// ---------------------------------------------------------------------------
// CLC profile — shared by search and write modes
// ---------------------------------------------------------------------------

const CLC_PROFILE = `
Community Literacy Club (CLC) — Organization Profile for Grant Matching

**EIN:** [On file]
**Founded:** Hempstead, Long Island, NY
**Executive Director:** Kimberly Gordon
**Annual Budget:** Under $500K (emerging nonprofit)
**Service Area:** Nassau County (Hempstead, Long Beach), Westchester County, Brooklyn NY, Newark NJ, Connecticut

**Mission:** CLC meets kids where they are — bringing tennis, chess, and life skills to underserved youth in unconventional spaces (gyms, community centers, rec rooms, libraries). We prepare young people to handle difficult decisions, weigh consequences, and create real possibilities for themselves.

**Programs:**
• Youth Program (ages 6-19): Tennis instruction, chess, foundational life skills
• Teen Leadership Track (ages 13-19): Leadership development, peer mentorship, alumni coaching pipeline
• Young Adult Track (ages 20-26): Job readiness, career placement, workforce development
• SAT/ACT/PSAT Prep: Test preparation access regardless of zip code
• Summer enrichment programming

**Impact Numbers:**
• 400+ youth served annually
• 84% program retention rate
• 3 program tracks across 5+ locations in NY, NJ, CT
• Alumni return as coaches — sustainable leadership pipeline

**Key Differentiators:**
• Unconventional spaces model (no facility overhead)
• Dual-discipline approach: physical (tennis) + mental (chess) = whole-child development
• Deeply community-embedded — Kimberly knows every kid by name
• Alumni-to-coach pipeline = built-in sustainability
• Serving communities with historically limited access to racquet sports

**Alignment Keywords:**
youth development, education equity, sports-based youth development, STEM (chess = strategic thinking),
workforce development, community development, racial equity, afterschool programming,
mentorship, leadership development, social-emotional learning, health & wellness,
underserved communities, minority-serving, out-of-school time, college readiness
`;

// ---------------------------------------------------------------------------
// Grant categories CLC should target
// ---------------------------------------------------------------------------

const GRANT_CATEGORIES = `
**Priority Grant Categories for CLC (2025-2026):**

1. **Youth Development & Afterschool**
   - Robert Wood Johnson Foundation (sports-based youth development)
   - Laureus Sport for Good Foundation
   - US Tennis Association Foundation grants
   - National Recreation and Park Association
   - Afterschool Alliance / 21st Century Community Learning Centers
   - Boys & Girls Clubs affiliated grants

2. **Education Equity & Access**
   - Gates Foundation (K-12 education equity)
   - Walton Family Foundation (education)
   - Spencer Foundation
   - Carnegie Corporation (education)
   - Local education foundations (Nassau BOCES, Westchester)

3. **Community Development (Nassau & Westchester focused)**
   - Nassau County Youth Bureau
   - Westchester Community Foundation
   - Long Island Community Foundation
   - United Way of Long Island
   - New York Community Trust
   - Robin Hood Foundation (NYC/metro)

4. **Sports & Health**
   - Nike Community Impact Fund
   - ESPN Sports Humanitarian grants
   - USTA Foundation
   - Gatorade / PepsiCo Foundation
   - Dick's Sporting Goods Foundation
   - Women's Sports Foundation

5. **Racial Equity & Social Justice**
   - Ford Foundation
   - W.K. Kellogg Foundation
   - Schott Foundation
   - Open Society Foundations
   - Local racial equity funds

6. **Workforce Development (Young Adult Track)**
   - JPMorgan Chase Foundation
   - Goldman Sachs Foundation
   - Year Up partnerships
   - Department of Labor grants (DOL YouthBuild, etc.)

7. **Corporate Giving / CSR**
   - Target Foundation
   - Walmart Foundation (community grants)
   - Bank of America Foundation
   - TD Bank Foundation (local community grants)
   - Con Edison community programs
`;

// ---------------------------------------------------------------------------
// Grant-specific writing prompt extension
// ---------------------------------------------------------------------------

const grantWriterPrompt = `
${systemPrompt}

---

## GRANT WRITING GUIDELINES

You are now writing grant proposals and funding requests for Community Literacy Club. The voice should still be Kimberly's — authentic, grounded, and specific — but adapted for the formal requirements of grant writing.

### Key Principles for Grant Writing

1. **Lead with Impact, Not Need**
   - Funders want to invest in solutions, not problems
   - Show what's working and why it should scale
   - "We serve 400+ kids with 84% retention" not "Kids in underserved communities lack access"

2. **Be Specific**
   - Use real numbers: students served, retention rates, locations
   - Name specific programs: Tennis, Chess, SAT Prep, Teen Leadership Track
   - Mention specific communities: Hempstead, Long Beach, Brooklyn, Westchester, Newark NJ, Connecticut

3. **Tell Stories That Prove the Model**
   - Brief case studies of real impact (anonymized if needed)
   - "Marcus joined us shy and silent. Six months later, he's leading warm-ups."
   - Show the transformation, don't just claim it

4. **Match Funder Priorities**
   - Youth development → emphasize life skills, leadership, mentorship
   - Education → emphasize academic support, SAT/ACT prep, critical thinking
   - Sports/Health → emphasize physical activity, teamwork, competition
   - Community → emphasize local presence, family engagement, accessibility

5. **Avoid Grant-Speak**
   - "Holistic programming" → "We teach kids to think strategically on and off the court"
   - "Leveraging synergies" → "Our teen alumni come back to coach younger kids"
   - "Evidence-based interventions" → "We track every kid's progress and adjust"

### Document Types

**Letter of Intent (LOI):** 1-2 pages, warm but professional. Hook them with impact, explain the ask, close with partnership language.

**Full Proposal:** 5-10 pages with sections for Organization Background, Program Description, Goals & Objectives, Evaluation Plan, Budget Narrative.

**Executive Summary:** 1 page that could stand alone. Lead with the most compelling impact statement.

**Budget Narrative:** Explain each line item in human terms. "Instructor stipends support 12 part-time coaches, many of whom are alumni of the program."

### Tone Calibration

- More formal than social media, but still Kimberly's voice
- Confident about impact without overselling
- Honest about challenges while emphasizing solutions
- Collaborative ("We see this as a partnership") not transactional

### Structure Guidelines

1. **Opening Hook:** Start with a specific moment or impact statement
2. **Organization Overview:** Brief, focused on track record
3. **Program Description:** What you do and why it works
4. **Target Population:** Who you serve and why they need this
5. **Goals & Outcomes:** Measurable, specific, achievable
6. **Evaluation:** How you track and prove impact
7. **Budget:** Clear, justified, realistic
8. **Closing:** Partnership language, clear next steps

---

## CLC FACTS FOR GRANT WRITING

### Impact Numbers
- 400+ kids served annually
- 84% retention rate
- 3 program tracks (Youth 6-19, Teen Leadership 13-19, Young Adult 20-26)
- 5+ locations across NY, NJ, and CT

### Programs
- Tennis instruction (unconventional spaces — gyms, community centers, rec rooms)
- Chess instruction (critical thinking, patience, decision-making)
- SAT/ACT/PSAT prep
- Teen leadership development
- Young adult career readiness and job placement

### Differentiators
- Meet kids where they are — literally and figuratively
- Alumni become coaches (we grow our own leaders)
- Tennis teaches conflict resolution and competing with grace
- Chess teaches stopping to think before acting
- Combined approach builds both physical and mental discipline

### Geographic Focus
- Hempstead, Long Beach, Brooklyn, Westchester (NY)
- Newark (NJ)
- Connecticut

---

When writing grants, always reference these real facts. Never invent statistics or programs. If you need information not provided here, note what would be needed and write around it.
`;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const GRANT_TYPES = [
	'loi', // Letter of Intent
	'executive-summary',
	'full-proposal',
	'budget-narrative',
	'impact-report',
	'thank-you-letter',
] as const;

const AgentInput = s.object({
	// Task type — 'search' finds grants, 'write' creates documents
	task: s.string().optional(), // 'search' | 'write' (default: 'write' for backward compat)

	// === SEARCH MODE FIELDS ===
	searchFocus: s.string().optional(),          // e.g. 'youth development', 'education equity'
	maxDeadlineYear: s.number().optional(),       // e.g. 2026
	grantSizeMin: s.number().optional(),          // minimum grant amount
	grantSizeMax: s.number().optional(),          // maximum grant amount
	grantCategories: s.array(s.string()).optional(), // filter to specific categories
	includeLocal: s.boolean().optional(),         // include Nassau/Westchester local grants
	includeFederal: s.boolean().optional(),       // include federal/state grants
	includeFoundation: s.boolean().optional(),    // include private foundations
	includeCorporate: s.boolean().optional(),     // include corporate giving

	// === WRITE MODE FIELDS ===
	grantType: s.string().optional(),  // From GRANT_TYPES
	funderName: s.string().optional(),
	funderFocus: s.string().optional(),
	askAmount: s.number().optional(),
	projectName: s.string().optional(),
	projectDescription: s.string().optional(),
	targetPopulation: s.string().optional(),
	timeline: s.string().optional(),
	wordLimit: s.number().optional(),
	specificQuestions: s.array(s.string()).optional(),
	requiredSections: s.array(s.string()).optional(),
});

const GrantOpportunitySchema = s.object({
	funderName: s.string(),
	grantProgramName: s.string(),
	description: s.string(),
	eligibility: s.string(),
	fundingRange: s.string(),
	deadline: s.string(),
	deadlineType: s.string(),     // 'fixed', 'rolling', 'LOI-first', 'by-invitation'
	alignmentScore: s.number(),   // 1-10 how well CLC fits
	alignmentReason: s.string(),
	category: s.string(),
	website: s.string().optional(),
	applicationUrl: s.string().optional(),
	contactInfo: s.string().optional(),
	tips: s.string(),             // specific tips for CLC's application
	priority: s.string(),         // 'high', 'medium', 'low'
});

const AgentOutput = s.object({
	// Task type
	task: s.string(),

	// === SEARCH RESULTS ===
	opportunities: s.array(GrantOpportunitySchema).optional(),
	searchSummary: s.string().optional(),
	nextSteps: s.array(s.string()).optional(),
	calendarItems: s.array(s.object({
		date: s.string(),
		action: s.string(),
		grant: s.string(),
	})).optional(),

	// === WRITE RESULTS ===
	content: s.string().optional(),
	sections: s.array(s.object({
		title: s.string(),
		content: s.string(),
	})).optional(),
	grantType: s.string().optional(),
	wordCount: s.number().optional(),
	estimatedReadTime: s.string().optional(),
	suggestions: s.array(s.string()).optional(),
	missingInfo: s.array(s.string()).optional(),

	// Metadata
	resultsCount: s.number(),
});

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

const agent = createAgent('grant-writer', {
	description: 'Researches grant opportunities and writes grant proposals for Community Literacy Club',
	schema: {
		input: AgentInput,
		output: AgentOutput,
	},
	handler: async (ctx, input) => {
		const task = input.task || 'write';

		// =====================================================================
		// SEARCH MODE — Find grants that fit CLC with upcoming deadlines
		// =====================================================================
		if (task === 'search') {
			ctx.logger.info('Grant Writer: SEARCH mode — finding grants for CLC');

			const searchFocus = input.searchFocus || 'youth development, education, sports';
			const maxYear = input.maxDeadlineYear || 2026;
			const sizeMin = input.grantSizeMin;
			const sizeMax = input.grantSizeMax;

			// Build source filters
			const sources: string[] = [];
			if (input.includeLocal !== false) sources.push('Local (Nassau County, Westchester County, Long Island, NYC metro)');
			if (input.includeFederal !== false) sources.push('Federal and State (OJJDP, DOE, DOL, NYSED, etc.)');
			if (input.includeFoundation !== false) sources.push('Private Foundations');
			if (input.includeCorporate !== false) sources.push('Corporate Giving / CSR Programs');

			const searchPrompt = `You are an expert grant researcher for nonprofits. Your job is to find REAL grant opportunities that Community Literacy Club should apply for.

${CLC_PROFILE}

${GRANT_CATEGORIES}

---

## YOUR RESEARCH TASK

Find 12-15 grant opportunities that match CLC's mission and programs. Focus on:

**Search Focus:** ${searchFocus}
**Deadline Window:** Grants with deadlines in 2025 or ${maxYear} (or rolling deadlines)
${sizeMin ? `**Minimum Grant Size:** $${sizeMin.toLocaleString()}` : ''}
${sizeMax ? `**Maximum Grant Size:** $${sizeMax.toLocaleString()}` : ''}
**Sources to Include:** ${sources.join(', ')}
${input.grantCategories ? `**Categories:** ${input.grantCategories.join(', ')}` : ''}

## IMPORTANT RESEARCH GUIDELINES

1. **Prioritize REAL, KNOWN grant programs** — Use your training data to identify actual funders and their grant programs. If you know a foundation's grant cycle, deadline pattern, and typical awards, include it.
2. **Be honest about what you know and don't know** — If you're unsure of a specific 2026 deadline, say "Typically [month] — verify current cycle" rather than making one up.
3. **Include a mix of:**
   - Grants CLC has a HIGH chance of winning (smaller local/community grants, $5K-$25K)
   - Stretch grants that would be transformative ($50K-$250K)
   - Federal/state grants if applicable
   - Rolling deadline grants (can apply anytime)
4. **For each grant, assess alignment honestly** — A score of 10 means CLC is a perfect match. Be realistic.
5. **Focus on grants for organizations with budgets under $1M** — CLC is an emerging nonprofit, so mega-grants for established orgs don't apply.
6. **Include specific application tips** for each grant tailored to how CLC should position itself.

## OUTPUT FORMAT

Return a JSON object with:
{
  "opportunities": [
    {
      "funderName": "Name of foundation/organization",
      "grantProgramName": "Specific program name",
      "description": "What this grant funds",
      "eligibility": "Who can apply and key requirements",
      "fundingRange": "$X,000 - $XX,000",
      "deadline": "Month Year or Rolling",
      "deadlineType": "fixed | rolling | LOI-first | by-invitation",
      "alignmentScore": 8,
      "alignmentReason": "Why CLC is a strong fit",
      "category": "youth-development | education | sports | community | workforce | corporate | government",
      "website": "URL if known",
      "applicationUrl": "Direct application URL if known",
      "contactInfo": "Phone or email if known",
      "tips": "Specific application tips for CLC",
      "priority": "high | medium | low"
    }
  ],
  "searchSummary": "Brief overview of findings",
  "nextSteps": ["Action item 1", "Action item 2", ...],
  "calendarItems": [
    {"date": "2025-09-01", "action": "Submit LOI", "grant": "Grant name"}
  ]
}

Return ONLY valid JSON. No markdown, no explanation outside the JSON.`;

			const { text: searchJson } = await generateText({
				model: openai('gpt-5-mini'),
				prompt: searchPrompt,
			});

			// Parse results
			let parsed: {
				opportunities?: Array<{
					funderName: string;
					grantProgramName: string;
					description: string;
					eligibility: string;
					fundingRange: string;
					deadline: string;
					deadlineType: string;
					alignmentScore: number;
					alignmentReason: string;
					category: string;
					website?: string;
					applicationUrl?: string;
					contactInfo?: string;
					tips: string;
					priority: string;
				}>;
				searchSummary?: string;
				nextSteps?: string[];
				calendarItems?: Array<{ date: string; action: string; grant: string }>;
			} = {};

			try {
				const jsonMatch = searchJson.match(/\{[\s\S]*\}/);
				if (jsonMatch) {
					parsed = JSON.parse(jsonMatch[0]);
				}
			} catch (e) {
				ctx.logger.error('Failed to parse grant search JSON: %s', e);
			}

			const opportunities = parsed.opportunities || [];

			// Sort by priority then alignment score
			const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
			opportunities.sort((a, b) => {
				const pDiff = (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1);
				if (pDiff !== 0) return pDiff;
				return b.alignmentScore - a.alignmentScore;
			});

			return {
				task: 'search',
				opportunities,
				searchSummary: parsed.searchSummary || `Found ${opportunities.length} grant opportunities matching CLC's mission.`,
				nextSteps: parsed.nextSteps || [
					'Review high-priority grants first',
					'Verify current deadlines on funder websites',
					'Begin LOIs for rolling-deadline grants immediately',
					'Add fixed deadlines to your calendar',
				],
				calendarItems: parsed.calendarItems,
				resultsCount: opportunities.length,
			};
		}

		// =====================================================================
		// WRITE MODE — Generate grant documents (original behavior, enhanced)
		// =====================================================================
		ctx.logger.info('Grant Writer: WRITE mode — %s for %s', input.grantType || 'general', input.funderName || 'unknown');

		const grantType = input.grantType || 'loi';
		const {
			funderName,
			funderFocus,
			askAmount,
			projectName,
			projectDescription = 'Community Literacy Club programs',
			targetPopulation,
			timeline,
			wordLimit,
			specificQuestions = [],
			requiredSections = [],
		} = input;

		// Build the generation prompt based on grant type
		let typeInstructions = '';
		let targetLength = '';

		switch (grantType) {
			case 'loi':
				typeInstructions = `Write a Letter of Intent (LOI) that:
- Opens with a compelling hook about Community Literacy Club's impact
- Briefly describes the organization and its track record
- Explains the specific project or program seeking funding
- States the funding request clearly
- Closes with partnership language and next steps

Format: Professional letter format with date, salutation, and signature block.`;
				targetLength = wordLimit ? `Target: ${wordLimit} words` : 'Target: 500-750 words (1-2 pages)';
				break;

			case 'executive-summary':
				typeInstructions = `Write an Executive Summary that:
- Can stand alone as a complete overview
- Leads with the most compelling impact statement
- Covers organization, program, ask, and expected outcomes
- Creates urgency while remaining professional

Format: Single page, no headers needed. Dense but readable.`;
				targetLength = wordLimit ? `Target: ${wordLimit} words` : 'Target: 300-400 words (1 page)';
				break;

			case 'full-proposal':
				typeInstructions = `Write a full Grant Proposal with these sections:
1. Executive Summary
2. Organization Background
3. Statement of Need
4. Program Description
5. Goals and Objectives
6. Evaluation Plan
7. Sustainability
8. Budget Overview

Each section should be complete and compelling.`;
				targetLength = wordLimit ? `Target: ${wordLimit} words` : 'Target: 2000-3000 words (5-8 pages)';
				break;

			case 'budget-narrative':
				typeInstructions = `Write a Budget Narrative that:
- Explains each major budget category
- Justifies costs with specifics (number of staff, hours, rates)
- Shows how funds directly support program delivery
- Demonstrates fiscal responsibility

Format: Category by category explanation, professional but not dry.`;
				targetLength = wordLimit ? `Target: ${wordLimit} words` : 'Target: 400-600 words';
				break;

			case 'impact-report':
				typeInstructions = `Write an Impact Report that:
- Summarizes achievements over the grant period
- Uses specific numbers and stories
- Acknowledges the funder's role
- Shows outcomes against stated goals
- Points toward future opportunities

Format: Report style with headers, but narrative voice.`;
				targetLength = wordLimit ? `Target: ${wordLimit} words` : 'Target: 1000-1500 words';
				break;

			case 'thank-you-letter':
				typeInstructions = `Write a Thank You Letter that:
- Expresses genuine gratitude
- Reiterates the impact the funding will have
- Includes a specific example or story
- Offers to stay connected
- Is warm but professional

Format: Letter format, from Kimberly personally.`;
				targetLength = wordLimit ? `Target: ${wordLimit} words` : 'Target: 200-300 words';
				break;

			default:
				typeInstructions = 'Write grant content as appropriate for the request.';
				targetLength = wordLimit ? `Target: ${wordLimit} words` : 'Target: appropriate length';
		}

		// Build funder context
		const funderContext = funderName || funderFocus
			? `
Funder: ${funderName || 'Foundation/Organization'}
Focus Area: ${funderFocus || 'General youth development'}
${askAmount ? `Funding Request: $${askAmount.toLocaleString()}` : ''}`
			: '';

		// Build project context
		const projectContext = `
Project: ${projectName || projectDescription.slice(0, 50) + '...'}
Description: ${projectDescription}
${targetPopulation ? `Target Population: ${targetPopulation}` : ''}
${timeline ? `Timeline: ${timeline}` : ''}`;

		// Build questions/sections context
		const questionsContext = specificQuestions.length > 0
			? `\nFunder's Specific Questions to Address:\n${specificQuestions.map((q: string, i: number) => `${i + 1}. ${q}`).join('\n')}`
			: '';

		const sectionsContext = requiredSections.length > 0
			? `\nRequired Sections:\n${requiredSections.map((sec: string) => `- ${sec}`).join('\n')}`
			: '';

		const prompt = `Write a ${grantType.replace(/-/g, ' ')} for Community Literacy Club.

${funderContext}
${projectContext}
${questionsContext}
${sectionsContext}

${typeInstructions}

${targetLength}

Remember:
- Write in Kimberly's voice — authentic, specific, grounded
- Lead with impact, not need
- Use real CLC facts and numbers
- Avoid generic nonprofit language
- Be confident but not boastful

Write the ${grantType.replace(/-/g, ' ')} now:`;

		const { text: content } = await generateText({
			model: openai('gpt-5-mini'),
			system: grantWriterPrompt,
			prompt,
		});

		// Calculate word count
		const wordCount = content.split(/\s+/).length;
		const estimatedReadTime = `${Math.ceil(wordCount / 200)} min read`;

		// Generate suggestions
		const { text: suggestionsText } = await generateText({
			model: openai('gpt-5-mini'),
			prompt: `Based on this grant ${grantType.replace(/-/g, ' ')}:

"${content.slice(0, 1500)}..."

Provide 2-3 brief, specific suggestions to strengthen this proposal. Focus on:
- Adding more concrete numbers or outcomes
- Strengthening the narrative
- Better alignment with funder priorities
- Missing elements

Format as a simple bulleted list, each item 1-2 sentences:`,
		});

		const suggestions = suggestionsText
			.split('\n')
			.filter((line: string) => line.trim().startsWith('-') || line.trim().startsWith('•'))
			.map((line: string) => line.replace(/^[-•]\s*/, '').trim())
			.filter((s: string) => s.length > 0);

		// Identify missing info
		const missingInfo: string[] = [];
		if (!askAmount) missingInfo.push('Specific funding amount requested');
		if (!funderName) missingInfo.push('Funder name for personalization');
		if (!timeline) missingInfo.push('Project timeline/duration');
		if (!targetPopulation) missingInfo.push('Specific target population details');

		// Parse sections if full proposal
		let sections: { title: string; content: string }[] | undefined;
		if (grantType === 'full-proposal') {
			const sectionMatches = content.matchAll(/##?\s*([^\n]+)\n([^#]+)/g);
			sections = Array.from(sectionMatches).map((match) => ({
				title: (match[1] ?? '').trim(),
				content: (match[2] ?? '').trim(),
			}));
		}

		return {
			task: 'write',
			content,
			sections,
			grantType,
			wordCount,
			estimatedReadTime,
			suggestions: suggestions.length > 0 ? suggestions : undefined,
			missingInfo: missingInfo.length > 0 ? missingInfo : undefined,
			resultsCount: 1,
		};
	},
});

export default agent;
