/**
 * Donor Researcher Agent
 * Researches potential donors and sponsors — with a strategic focus on:
 *   1. Accounting firms whose clients need charitable tax write-offs
 *   2. Corporate sponsors aligned with CLC's mission
 *   3. High-net-worth individuals in the NY/NJ/CT tri-state area
 *   4. Family offices and private foundations
 *
 * Three search modes:
 *   - prospect-search: Find new donor prospects matching criteria
 *   - deep-dive: Research a specific prospect in detail
 *   - connection-map: Map pathways to reach a target prospect
 */

import { createAgent } from '@agentuity/runtime';
import { s } from '@agentuity/schema';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

// ---------------------------------------------------------------------------
// CLC donor profile context
// ---------------------------------------------------------------------------

const CLC_DONOR_CONTEXT = `
## Community Literacy Club — Donor Prospecting Profile

**Organization:** Community Literacy Club (CLC)
**Executive Director:** Kimberly Gordon
**EIN:** [On file]
**Location:** Hempstead, Long Island, NY (serving Nassau County, Westchester, Brooklyn, Newark NJ, Connecticut)
**Annual Budget:** Under $500K (emerging nonprofit — ideal for donors wanting outsized impact per dollar)
**Tax Status:** 501(c)(3) — all donations are tax-deductible

### What CLC Does
We bring tennis, chess, and life skills to underserved youth in unconventional spaces. We meet kids where they are — in gyms, community centers, libraries, and rec rooms — because our kids don't have access to traditional courts or clubs.

### Impact Numbers
- 400+ youth served annually
- 84% program retention rate
- 3 age-based tracks (Youth 6-19, Teen Leadership 13-19, Young Adult 20-26)
- SAT/ACT/PSAT prep programs
- 5+ locations across NY, NJ, CT
- Alumni become coaches → sustainable leadership pipeline

### Why Donors Should Care
- **Tax efficiency:** 501(c)(3) status, clean financials, emerging-stage = high impact per dollar
- **Story-rich:** Every dollar connects to a real kid with a real name
- **Visibility:** Donors get named recognition at events, in newsletters, on social media
- **Community anchor:** Deep roots in Nassau County and Westchester — local impact, local pride
- **Scalable model:** Unconventional spaces = low overhead, high reach

### Geographic Focus for Prospecting
- **Primary:** Nassau County (Hempstead, Long Beach, Garden City), Westchester County (White Plains, Yonkers, Mount Vernon)
- **Secondary:** Brooklyn NY, Newark NJ, Connecticut (Stamford, Bridgeport, Hartford)
- **Donor targets should be in or near these areas** for maximum engagement potential

---

## STRATEGIC DONOR CATEGORIES

### 1. ACCOUNTING FIRMS (Priority Target)
**Why accounting firms?** Their high-net-worth clients need legitimate charitable deductions. CLC is a perfect recommendation — small enough for meaningful engagement, established enough to be credible, and located in the same affluent-adjacent markets (Nassau, Westchester) where these firms operate.

**The pitch:** "Recommend CLC to your clients who need quality charitable write-offs. We're a 501(c)(3) youth nonprofit in their backyard — they get a tax deduction AND a feel-good story about kids in their community learning tennis and chess."

**Target accounting firms:**
- Mid-size firms (50-500 employees) in Nassau County, Westchester, Manhattan
- Firms specializing in: high-net-worth individuals, small business owners, real estate investors, medical professionals
- Firms with a CSR/community involvement history
- Partners and senior managers who handle wealthy client portfolios

**What to look for:**
- Firms near CLC service areas (Long Island, Westchester, NYC metro)
- Firms that sponsor local events, charity golf tournaments, galas
- Firms with foundations or giving programs
- Partners who sit on nonprofit boards

### 2. CORPORATE SPONSORS
- Financial services companies (banks, wealth management, insurance)
- Real estate developers in Nassau/Westchester
- Healthcare organizations
- Law firms with pro bono programs
- Sports-related companies (equipment, apparel, facilities)
- Tech companies with community initiatives

### 3. HIGH-NET-WORTH INDIVIDUALS
- Business owners in Nassau/Westchester
- Medical professionals (doctors, dentists, specialists)
- Real estate investors and developers
- Attorneys and law partners
- Finance professionals (hedge fund, private equity)
- Former athletes or tennis enthusiasts
- Parents whose children benefit from similar programs

### 4. FAMILY OFFICES & PRIVATE FOUNDATIONS
- Family foundations focused on youth, education, or sports
- Donor-advised funds (DAFs) at community foundations
- Family offices managing wealth for UHNW families in the tri-state area
`;

// ---------------------------------------------------------------------------
// Prospect types
// ---------------------------------------------------------------------------

const PROSPECT_TYPES = [
	'accounting-firm',     // NEW: Primary target
	'corporation',
	'individual',
	'family-office',
	'foundation',
	'government',
] as const;

const GIVING_AREAS = [
	'youth-development',
	'education',
	'sports',
	'community-development',
	'workforce',
	'racial-equity',
	'tax-strategy',       // NEW: Clients needing write-offs
] as const;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const AgentInput = s.object({
	// Search parameters
	searchType: s.string(), // 'prospect-search' | 'deep-dive' | 'connection-map'

	// For prospect search
	prospectType: s.string().optional(), // From PROSPECT_TYPES
	givingArea: s.string().optional(),   // From GIVING_AREAS
	location: s.string().optional(),     // Geographic focus
	minGiftSize: s.number().optional(),
	maxGiftSize: s.number().optional(),
	focusOnAccountingFirms: s.boolean().optional(), // Shortcut flag

	// For deep dive
	prospectName: s.string().optional(),
	prospectWebsite: s.string().optional(),

	// For connection mapping
	targetProspect: s.string().optional(),
	knownConnections: s.array(s.string()).optional(),

	// General
	keywords: s.array(s.string()).optional(),
	limit: s.number().optional(),
});

const ProspectSchema = s.object({
	name: s.string(),
	type: s.string(),
	description: s.string(),
	givingAreas: s.array(s.string()),
	typicalGiftRange: s.string().optional(),
	location: s.string().optional(),
	website: s.string().optional(),
	contactInfo: s.string().optional(),
	relevanceScore: s.number(),      // 1-10
	relevanceReason: s.string(),
	suggestedApproach: s.string(),
	taxStrategyAngle: s.string().optional(), // NEW: how this connects to tax write-off strategy
	redFlags: s.array(s.string()).optional(),
});

const AgentOutput = s.object({
	// Search results
	prospects: s.array(ProspectSchema).optional(),

	// Deep dive results
	profile: s.object({
		name: s.string(),
		overview: s.string(),
		givingHistory: s.string(),
		priorities: s.array(s.string()),
		decisionMakers: s.array(s.object({
			name: s.string(),
			role: s.string(),
			notes: s.string().optional(),
		})).optional(),
		applicationProcess: s.string().optional(),
		deadlines: s.array(s.string()).optional(),
		previousGrants: s.array(s.object({
			recipient: s.string(),
			amount: s.string().optional(),
			year: s.string().optional(),
		})).optional(),
		alignmentAnalysis: s.string(),
		suggestedAsk: s.string(),
		cultivationStrategy: s.string(),
		taxAngle: s.string().optional(), // NEW: tax strategy for accounting firm prospects
	}).optional(),

	// Connection map results
	connectionMap: s.object({
		target: s.string(),
		pathways: s.array(s.object({
			path: s.array(s.string()),
			strength: s.string(),
			notes: s.string(),
		})),
		suggestedIntroductions: s.array(s.string()),
	}).optional(),

	// Metadata
	searchType: s.string(),
	resultsCount: s.number(),
	searchCriteria: s.string(),
});

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

const agent = createAgent('donor-researcher', {
	description: 'Researches potential donors — specializing in accounting firms, corporate sponsors, and high-net-worth individuals for CLC',
	schema: {
		input: AgentInput,
		output: AgentOutput,
	},
	handler: async (ctx, {
		searchType,
		prospectType,
		givingArea,
		location = 'Nassau County, Westchester County, New York metro',
		minGiftSize,
		maxGiftSize,
		prospectName,
		prospectWebsite,
		targetProspect,
		knownConnections = [],
		keywords = [],
		limit = 10,
		focusOnAccountingFirms,
	}) => {
		ctx.logger.info('Donor Researcher: %s (type: %s)', searchType, prospectType || 'all');

		// Auto-set prospect type if accounting firm focus flag is set
		if (focusOnAccountingFirms && !prospectType) {
			prospectType = 'accounting-firm';
		}

		// =====================================================================
		// PROSPECT SEARCH
		// =====================================================================
		if (searchType === 'prospect-search') {
			const searchCriteria = [
				prospectType && `Type: ${prospectType}`,
				givingArea && `Focus: ${givingArea}`,
				location && `Location: ${location}`,
				minGiftSize && `Min gift: $${minGiftSize.toLocaleString()}`,
				maxGiftSize && `Max gift: $${maxGiftSize.toLocaleString()}`,
				keywords.length > 0 && `Keywords: ${keywords.join(', ')}`,
			].filter(Boolean).join(', ');

			ctx.logger.info('Searching for prospects: %s', searchCriteria);

			// Build type-specific search instructions
			let typeSpecificInstructions = '';

			if (prospectType === 'accounting-firm') {
				typeSpecificInstructions = `
## ACCOUNTING FIRM SEARCH — SPECIAL INSTRUCTIONS

You are specifically searching for accounting firms that can become donor partners and referral sources for CLC. The strategy is:

**Primary Value Proposition:**
These firms' clients need quality charitable tax deductions. CLC is a 501(c)(3) youth nonprofit in the same geographic market. By recommending CLC, the accounting firm:
1. Provides clients with a legitimate, impactful charitable deduction
2. Strengthens client relationships ("I found you a great local cause")
3. Gets community visibility and goodwill
4. Can sponsor CLC events themselves (their own deduction)

**What to Search For:**
- Mid-size accounting/CPA firms in Nassau County, Westchester, Long Island, and NYC metro
- Firms specializing in high-net-worth individuals, small business, real estate, or medical professionals
- Firms that already sponsor local charities, galas, or community events
- Firms with community involvement pages on their website
- Partners and senior tax advisors who handle wealthy client portfolios
- Firms near CLC service areas (Hempstead, Long Beach, Garden City, White Plains, Yonkers)

**For Each Accounting Firm, Also Include:**
- taxStrategyAngle: How specifically this firm's clients would benefit from supporting CLC
- Key partners/tax partners by name if known
- Community involvement history

Focus on REAL firms that operate in these areas. Use your knowledge of the Long Island and Westchester CPA landscape.`;
			} else if (prospectType === 'individual') {
				typeSpecificInstructions = `
Focus on high-net-worth individuals in Nassau County and Westchester who:
- Own businesses in the area
- Are medical professionals, attorneys, or finance professionals
- Are tennis enthusiasts or former athletes
- Have children in similar programs
- Sit on other nonprofit boards
- Have visible philanthropic activity

For each, include a taxStrategyAngle explaining how supporting CLC fits their tax planning.`;
			}

			const { text: prospectsJson } = await generateText({
				model: openai('gpt-5-mini'),
				prompt: `You are an expert fundraising researcher and donor prospecting specialist. Generate a list of ${limit} realistic potential donor prospects for Community Literacy Club.

${CLC_DONOR_CONTEXT}

${typeSpecificInstructions}

---

## SEARCH CRITERIA
${searchCriteria}

## OUTPUT REQUIREMENTS

For each prospect, provide:
1. name — Real name of the firm/person/foundation (use actual known entities when possible)
2. type — accounting-firm, corporation, individual, family-office, foundation, government
3. description — Who they are, what they do, why they matter
4. givingAreas — What causes they support (array)
5. typicalGiftRange — Expected giving level for CLC
6. location — Where they're based
7. website — URL if known
8. contactInfo — Phone/email/LinkedIn if known
9. relevanceScore — 1-10 for CLC fit
10. relevanceReason — Why they're a good match
11. suggestedApproach — Specific outreach strategy
12. taxStrategyAngle — How supporting CLC fits their tax/financial strategy (especially important for accounting firms and HNW individuals)
13. redFlags — Any concerns (array)

Return as a JSON array of objects. Focus on REALISTIC, ACTIONABLE prospects in the ${location} area.

Return ONLY valid JSON:`,
			});

			let prospects: Array<{
				name: string;
				type: string;
				description: string;
				givingAreas: string[];
				typicalGiftRange?: string;
				location?: string;
				website?: string;
				contactInfo?: string;
				relevanceScore: number;
				relevanceReason: string;
				suggestedApproach: string;
				taxStrategyAngle?: string;
				redFlags?: string[];
			}> = [];

			try {
				const jsonMatch = prospectsJson.match(/\[[\s\S]*\]/);
				if (jsonMatch) {
					prospects = JSON.parse(jsonMatch[0]);
				}
			} catch (e) {
				ctx.logger.error('Failed to parse prospects JSON: %s', e);
				prospects = [{
					name: 'Research results pending',
					type: prospectType || 'foundation',
					description: 'Unable to parse detailed results. Please try again.',
					givingAreas: [givingArea || 'youth-development'],
					typicalGiftRange: 'Varies',
					relevanceScore: 5,
					relevanceReason: 'Search criteria matched but detailed parsing failed',
					suggestedApproach: 'Manual research recommended',
				}];
			}

			// Sort by relevance score
			prospects.sort((a, b) => b.relevanceScore - a.relevanceScore);

			return {
				prospects,
				searchType,
				resultsCount: prospects.length,
				searchCriteria,
			};

		// =====================================================================
		// DEEP DIVE
		// =====================================================================
		} else if (searchType === 'deep-dive' && prospectName) {
			ctx.logger.info('Deep diving on: %s', prospectName);

			const { text: profileJson } = await generateText({
				model: openai('gpt-5-mini'),
				prompt: `You are an expert fundraising researcher. Provide a detailed research profile on "${prospectName}" for a nonprofit fundraiser at Community Literacy Club.

${CLC_DONOR_CONTEXT}

${prospectWebsite ? `Known website: ${prospectWebsite}` : ''}

Research and provide:
1. Overview: Who they are, their mission/business, size, reputation
2. Giving History: Types of charitable support, typical amounts, notable recipients
3. Priorities: Current giving/CSR priorities (list 3-5)
4. Decision Makers: Key people involved in charitable giving decisions (name, role, any notes)
5. Application Process: How to approach them (formal application, relationship, introduction, etc.)
6. Deadlines: Known giving cycles or deadlines
7. Previous Grants/Donations: Examples of past charitable support
8. Alignment Analysis: How well CLC aligns with their priorities
9. Suggested Ask: Recommended ask amount and positioning
10. Cultivation Strategy: Steps to build relationship before the ask
11. Tax Angle: How supporting CLC fits their financial/tax strategy (especially for accounting firms — how they'd pitch CLC to their clients)

Return as JSON:
{
  "name": "...",
  "overview": "...",
  "givingHistory": "...",
  "priorities": ["..."],
  "decisionMakers": [{"name": "...", "role": "...", "notes": "..."}],
  "applicationProcess": "...",
  "deadlines": ["..."],
  "previousGrants": [{"recipient": "...", "amount": "...", "year": "..."}],
  "alignmentAnalysis": "...",
  "suggestedAsk": "...",
  "cultivationStrategy": "...",
  "taxAngle": "..."
}

Return ONLY valid JSON:`,
			});

			let profile: {
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
				taxAngle?: string;
			} | undefined;

			try {
				const jsonMatch = profileJson.match(/\{[\s\S]*\}/);
				if (jsonMatch) {
					profile = JSON.parse(jsonMatch[0]);
				}
			} catch (e) {
				ctx.logger.error('Failed to parse profile JSON: %s', e);
				profile = {
					name: prospectName,
					overview: 'Profile parsing failed. Please try again or research manually.',
					givingHistory: 'Unable to retrieve',
					priorities: ['Research needed'],
					alignmentAnalysis: 'Manual analysis recommended',
					suggestedAsk: 'Determine after further research',
					cultivationStrategy: 'Begin with introductory outreach',
				};
			}

			return {
				profile,
				searchType,
				resultsCount: 1,
				searchCriteria: `Deep dive on: ${prospectName}`,
			};

		// =====================================================================
		// CONNECTION MAP
		// =====================================================================
		} else if (searchType === 'connection-map' && targetProspect) {
			ctx.logger.info('Mapping connections to: %s', targetProspect);

			const { text: connectionJson } = await generateText({
				model: openai('gpt-5-mini'),
				prompt: `You are a fundraising research assistant helping map connections to a potential donor.

${CLC_DONOR_CONTEXT}

Target: ${targetProspect}
Known connections in CLC's network: ${knownConnections.join(', ') || 'None specified'}

Analyze potential pathways to connect with the target. Consider:
1. Board members who might know them
2. Other nonprofit leaders in similar spaces
3. Accounting firm connections (CPAs who serve them)
4. Corporate connections
5. Alumni or parent networks
6. Community leaders in shared geographies (Nassau County, Westchester)
7. Tennis or sports community connections
8. Industry conferences and events
9. Mutual philanthropic interests

Provide:
1. Multiple pathways to the target (list of people/entities in each path)
2. Strength of each pathway (strong/moderate/weak)
3. Notes on each pathway
4. Suggested people to ask for introductions

Return as JSON:
{
  "target": "Name",
  "pathways": [
    {"path": ["Person A", "Person B", "Target"], "strength": "strong", "notes": "Why this path works"}
  ],
  "suggestedIntroductions": ["Person X", "Person Y"]
}

Return ONLY valid JSON:`,
			});

			let connectionMap: {
				target: string;
				pathways: { path: string[]; strength: string; notes: string }[];
				suggestedIntroductions: string[];
			} | undefined;

			try {
				const jsonMatch = connectionJson.match(/\{[\s\S]*\}/);
				if (jsonMatch) {
					connectionMap = JSON.parse(jsonMatch[0]);
				}
			} catch (e) {
				ctx.logger.error('Failed to parse connection map JSON: %s', e);
				connectionMap = {
					target: targetProspect,
					pathways: [{
						path: ['Direct outreach'],
						strength: 'weak',
						notes: 'Connection mapping failed. Consider direct outreach or manual network analysis.',
					}],
					suggestedIntroductions: [],
				};
			}

			return {
				connectionMap,
				searchType,
				resultsCount: connectionMap?.pathways?.length || 0,
				searchCriteria: `Connection map for: ${targetProspect}`,
			};
		}

		// Fallback for unknown search type
		return {
			searchType,
			resultsCount: 0,
			searchCriteria: 'Invalid or missing search parameters',
		};
	},
});

export default agent;
