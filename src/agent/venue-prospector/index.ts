/**
 * Venue Prospector Agent
 * Finds potential venues for CLC programs and tournaments, focused on:
 *   1. Community centers and gyms for tennis/chess programs
 *   2. Underutilized tennis courts that need tournament activity
 *   3. Spaces in Nassau County and Westchester County
 *
 * Three search modes:
 *   - venue-search: Find venues matching criteria
 *   - venue-profile: Deep dive on a specific venue
 *   - outreach-plan: Generate outreach strategy for target venues
 */

import { createAgent } from '@agentuity/runtime';
import { s } from '@agentuity/schema';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

// ---------------------------------------------------------------------------
// CLC venue context — focused on Nassau & Westchester
// ---------------------------------------------------------------------------

const CLC_VENUE_CONTEXT = `
## Community Literacy Club — Venue Prospecting Profile

**Organization:** Community Literacy Club (CLC)
**Executive Director:** Kimberly Gordon
**Mission:** Bring tennis, chess, and life skills to underserved youth in unconventional spaces

### What CLC Needs from Venues

**For Tennis Programs:**
- Indoor: Gymnasium, multipurpose hall, or large rec room (we bring portable nets, no permanent court needed)
- Outdoor: Tennis courts (public, private, school, or park courts — especially underutilized ones)
- Minimum space: ~40×60 feet for 2 portable courts
- Class size: 15-30 kids per session
- Sessions: Weekday afternoons (3-6pm) and Saturday mornings (9am-12pm)

**For Chess Programs:**
- Any room with tables and chairs (library, meeting room, community room, classroom)
- Class size: 10-25 kids per session
- Quieter space preferred but not required

**For SAT/ACT Prep & Leadership:**
- Classroom-style setting with whiteboard or screen
- 10-20 students per session

**For Tournaments:**
- Tennis tournaments: Need 4-8 courts, spectator seating, check-in area, parking
- Chess tournaments: Large room with 20+ tables, quiet environment
- Both: Restrooms, water fountains, ideally food vendor access or kitchen
- Tournament frequency: 2-4 per year (seasonal)

### What CLC Brings
- All equipment (nets, rackets, balls, chess sets, boards)
- Our own coaches and instructors (many are alumni of the program)
- Liability insurance
- Flexible scheduling — we work around existing venue programs
- Marketing and community engagement (we bring families)

### What CLC Offers Venues
- Fill empty time slots with meaningful programming
- Bring new families through the door (potential new members/users)
- Positive community association (youth development, sports, education)
- Media coverage and social media visibility
- Grant-funded programs (we don't ask venues to fund us, we bring our own funding)

---

## TARGET GEOGRAPHY

### NASSAU COUNTY (Primary)
**Key areas:** Hempstead, Long Beach, Freeport, Roosevelt, Uniondale, Garden City, Mineola, Westbury, Elmont, Valley Stream, Baldwin, Merrick

**Known venue types in Nassau:**
- Town of Hempstead parks and recreation centers
- Nassau County parks (Eisenhower Park, Bay Park, etc.)
- Village recreation departments
- School district gyms (after hours)
- YMCA branches (Long Beach, Freeport)
- Boys & Girls Clubs
- Church fellowship halls
- Library community rooms (Hempstead Library, Long Beach Library, etc.)
- Housing authority community rooms
- Tennis clubs with slow periods or community outreach programs

**Nassau tennis courts to investigate:**
- Eisenhower Park Tennis Center (public, 18 courts — may have slow weekday times)
- Long Beach courts (public)
- Hempstead Lake State Park courts
- School district courts (many sit unused after school ends)
- Private clubs with declining membership or community partnership programs

### WESTCHESTER COUNTY (Primary)
**Key areas:** White Plains, Yonkers, Mount Vernon, New Rochelle, Mount Kisco, Ossining, Peekskill, Tarrytown, Hastings-on-Hudson, Dobbs Ferry

**Known venue types in Westchester:**
- Westchester County parks (Saxon Woods, Playland, etc.)
- City recreation departments (White Plains, Yonkers, Mount Vernon)
- Community centers in underserved areas
- School gyms and courts
- YMCA branches
- Boys & Girls Clubs of Northern Westchester
- Church and faith-based facilities
- Library community rooms
- Westchester Community College facilities

**Westchester tennis courts to investigate:**
- Saxon Woods Park Tennis Courts (public)
- Doral Arrowwood (hotel/conference center with courts)
- Private clubs seeking community engagement programs
- School district courts
- Tibbetts Brook Park courts (Yonkers)
- City-owned courts in Mount Vernon, New Rochelle

---

## VENUE SCORING CRITERIA

Rate each venue on these factors (each 1-10, combined for fitScore):

1. **Location accessibility** — Is it in or near an underserved community CLC serves?
2. **Space suitability** — Does it have the right facilities for tennis/chess/SAT prep?
3. **Availability** — Are there open time slots during CLC's target hours (weekday PM, Saturday AM)?
4. **Cost** — Is it free, low-cost, or partnership-based? (CLC is a nonprofit)
5. **Tournament potential** — Could it host 2-4 tournaments per year?
6. **Community alignment** — Does the venue serve a similar demographic?
7. **Decision-maker accessibility** — Can we reach the right person easily?

A venue with a fitScore of 7+ is a strong prospect. 5-6 is worth exploring. Below 5 may not be worth the effort.
`;

// ---------------------------------------------------------------------------
// Venue types
// ---------------------------------------------------------------------------

const VENUE_TYPES = [
	'community-center',
	'rec-center',
	'school-gym',
	'church',
	'library',
	'park',
	'ymca',
	'boys-girls-club',
	'housing-complex',
	'university',
	'tennis-club',       // NEW: private clubs with slow periods
	'tennis-courts',     // NEW: standalone public/school courts
	'hotel-conference',  // NEW: hotels with courts and event space
] as const;

const PROGRAM_TYPES = [
	'tennis',
	'chess',
	'both',
	'sat-prep',
	'leadership',
	'tournament',  // NEW: tournament venue search
] as const;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const AgentInput = s.object({
	searchType: s.string(), // 'venue-search' | 'venue-profile' | 'outreach-plan'

	// Location
	location: s.string(),  // City, county, or neighborhood
	radius: s.number().optional(),

	// Venue criteria
	venueTypes: s.array(s.string()).optional(),
	programType: s.string().optional(),
	minCapacity: s.number().optional(),
	indoorRequired: s.boolean().optional(),
	accessibilityRequired: s.boolean().optional(),
	tournamentCapable: s.boolean().optional(),  // NEW: filter for tournament-ready venues

	// For venue profile
	venueName: s.string().optional(),
	venueAddress: s.string().optional(),

	// For outreach plan
	targetVenues: s.array(s.string()).optional(),
});

const VenueSchema = s.object({
	name: s.string(),
	type: s.string(),
	address: s.string(),
	description: s.string(),
	capacity: s.string().optional(),
	amenities: s.array(s.string()),
	contactInfo: s.string().optional(),
	website: s.string().optional(),
	fitScore: s.number(),
	fitReason: s.string(),
	considerations: s.array(s.string()).optional(),
	suggestedApproach: s.string(),
	tournamentPotential: s.string().optional(),   // NEW
	underutilizedHours: s.string().optional(),     // NEW: when the venue is slow
	courtCount: s.number().optional(),              // NEW: for tennis venues
});

const AgentOutput = s.object({
	venues: s.array(VenueSchema).optional(),

	profile: s.object({
		name: s.string(),
		type: s.string(),
		address: s.string(),
		overview: s.string(),
		facilities: s.string(),
		currentPrograms: s.array(s.string()).optional(),
		decisionMakers: s.array(s.object({
			name: s.string(),
			role: s.string(),
			contact: s.string().optional(),
		})).optional(),
		availability: s.string().optional(),
		costs: s.string().optional(),
		partnershipOpportunities: s.array(s.string()),
		clcFit: s.string(),
		recommendedPrograms: s.array(s.string()),
		tournamentAssessment: s.string().optional(), // NEW
	}).optional(),

	outreachPlan: s.object({
		summary: s.string(),
		venues: s.array(s.object({
			name: s.string(),
			priority: s.string(),
			approach: s.string(),
			talkingPoints: s.array(s.string()),
			proposedPartnership: s.string(),
			timeline: s.string(),
		})),
		emailTemplate: s.string(),
		followUpSchedule: s.array(s.object({
			timing: s.string(),
			action: s.string(),
		})),
	}).optional(),

	searchType: s.string(),
	resultsCount: s.number(),
	searchCriteria: s.string(),
});

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

const agent = createAgent('venue-prospector', {
	description: 'Finds venues for CLC programs and tournaments in Nassau and Westchester counties',
	schema: {
		input: AgentInput,
		output: AgentOutput,
	},
	handler: async (ctx, {
		searchType,
		location,
		radius = 15,
		venueTypes = [],
		programType = 'both',
		minCapacity,
		indoorRequired = false,
		accessibilityRequired = false,
		tournamentCapable = false,
		venueName,
		venueAddress,
		targetVenues = [],
	}) => {
		ctx.logger.info('Venue Prospector: %s in %s', searchType, location);

		// =====================================================================
		// VENUE SEARCH
		// =====================================================================
		if (searchType === 'venue-search') {
			const criteria = [
				`Location: ${location} (${radius} mile radius)`,
				venueTypes.length > 0 && `Venue types: ${venueTypes.join(', ')}`,
				programType && `Program: ${programType}`,
				minCapacity && `Min capacity: ${minCapacity}`,
				indoorRequired && 'Must be indoors',
				accessibilityRequired && 'Must be accessible',
				tournamentCapable && 'Must support tournaments (4+ courts or large event space)',
			].filter(Boolean).join('\n');

			ctx.logger.info('Searching venues with criteria: %s', criteria);

			// Build tournament-specific instructions if requested
			const tournamentInstructions = tournamentCapable || programType === 'tournament' ? `

## TOURNAMENT VENUE FOCUS

You are specifically looking for venues that can host CLC tennis and/or chess tournaments. Requirements:

**Tennis Tournament Venues:**
- 4-8 tennis courts minimum (more is better)
- Spectator seating or viewing areas
- Check-in/registration area
- Parking for 50-100 cars
- Restrooms
- Ideally: food/concession area, shade structures, PA system
- Courts should be in good condition (resurfacing not needed)
- PRIORITY: Courts that are UNDERUTILIZED — slow weekday periods, off-season availability, or declining membership clubs looking for activity

**Chess Tournament Venues:**
- Large room accommodating 40-100 players (20-50 tables)
- Quiet environment
- Good lighting
- Nearby restrooms and parking
- Ideally: kitchen access for refreshments, separate waiting area for families

**What Makes a Court "Slow" / Underutilized:**
- Public park courts with low weekday afternoon usage
- School courts unused during summer or weekends
- Private clubs with declining membership seeking community engagement
- Hotel/resort courts that sit empty during non-peak seasons
- Municipal courts in smaller towns with low demand

For each venue, rate tournament potential specifically.
` : '';

			const { text: venuesJson } = await generateText({
				model: openai('gpt-5-mini'),
				prompt: `You are a venue research specialist for a youth nonprofit. Generate a list of 10-12 potential venues for Community Literacy Club in the specified area.

${CLC_VENUE_CONTEXT}

${tournamentInstructions}

---

## SEARCH CRITERIA
${criteria}

## OUTPUT REQUIREMENTS

For each venue, provide:
1. name — Real venue name (use actual known venues in the area when possible)
2. type — community-center, rec-center, school-gym, church, library, park, ymca, boys-girls-club, housing-complex, university, tennis-club, tennis-courts, hotel-conference
3. address — Realistic address in the specified area
4. description — What it is, who runs it, what makes it interesting for CLC
5. capacity — Estimated number of participants it can hold
6. amenities — What facilities it has (array: gym, outdoor courts, meeting room, kitchen, parking, etc.)
7. contactInfo — Phone, email, or "Contact needed"
8. website — URL if known
9. fitScore — 1-10 composite score based on our scoring criteria
10. fitReason — Why it's a good/poor fit
11. considerations — Challenges or things to watch out for (array)
12. suggestedApproach — How to approach this venue
13. tournamentPotential — "High", "Medium", "Low", or "None" + brief explanation
14. underutilizedHours — When the venue is typically slow/empty (e.g., "Weekday afternoons 2-5pm", "Summer months", "Off-season")
15. courtCount — Number of tennis courts (0 if none)

**IMPORTANT:** Focus on REAL venues in ${location}. Use your knowledge of the area. Include:
- Public parks with tennis courts
- Recreation centers
- School facilities available for community use
- Houses of worship with gym/fellowship halls
- Libraries with meeting rooms
- YMCAs and Boys & Girls Clubs
- Private clubs that might partner
- Any venue with underutilized tennis courts

Sort by fitScore (highest first).

Return as a JSON array. Return ONLY valid JSON:`,
			});

			let venues: Array<{
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
				tournamentPotential?: string;
				underutilizedHours?: string;
				courtCount?: number;
			}> = [];

			try {
				const jsonMatch = venuesJson.match(/\[[\s\S]*\]/);
				if (jsonMatch) {
					venues = JSON.parse(jsonMatch[0]);
				}
			} catch (e) {
				ctx.logger.error('Failed to parse venues JSON: %s', e);
				venues = [{
					name: 'Research results pending',
					type: 'community-center',
					address: location,
					description: 'Unable to parse detailed results. Please try again.',
					amenities: ['To be determined'],
					fitScore: 5,
					fitReason: 'Search criteria matched but detailed parsing failed',
					suggestedApproach: 'Manual research recommended',
				}];
			}

			// Sort by fitScore descending
			venues.sort((a, b) => b.fitScore - a.fitScore);

			return {
				venues,
				searchType,
				resultsCount: venues.length,
				searchCriteria: criteria,
			};

		// =====================================================================
		// VENUE PROFILE
		// =====================================================================
		} else if (searchType === 'venue-profile' && venueName) {
			ctx.logger.info('Profiling venue: %s', venueName);

			const { text: profileJson } = await generateText({
				model: openai('gpt-5-mini'),
				prompt: `You are a venue research specialist. Provide a detailed profile of "${venueName}" for a youth nonprofit seeking to run programs and tournaments there.

${CLC_VENUE_CONTEXT}

${venueAddress ? `Address: ${venueAddress}` : ''}

Research and provide:
1. Overview: What kind of venue, who runs it, its mission/purpose, reputation
2. Facilities: Specific spaces available (courts, gyms, rooms, fields, etc.)
3. Current Programs: What already runs there
4. Decision Makers: Key people to contact (name, role, contact if available)
5. Availability: When spaces are available, especially underutilized times
6. Costs: Typical rental/partnership costs if known
7. Partnership Opportunities: What partnerships they offer or might consider
8. CLC Fit: How well CLC's programs would work here
9. Recommended Programs: Which CLC programs fit best (tennis, chess, SAT prep, tournaments)
10. Tournament Assessment: Could this venue host a CLC tournament? What would it take?

Return as JSON:
{
  "name": "...",
  "type": "...",
  "address": "...",
  "overview": "...",
  "facilities": "...",
  "currentPrograms": ["..."],
  "decisionMakers": [{"name": "...", "role": "...", "contact": "..."}],
  "availability": "...",
  "costs": "...",
  "partnershipOpportunities": ["..."],
  "clcFit": "...",
  "recommendedPrograms": ["..."],
  "tournamentAssessment": "..."
}

Return ONLY valid JSON:`,
			});

			let profile: {
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
				tournamentAssessment?: string;
			} | undefined;

			try {
				const jsonMatch = profileJson.match(/\{[\s\S]*\}/);
				if (jsonMatch) {
					profile = JSON.parse(jsonMatch[0]);
				}
			} catch (e) {
				ctx.logger.error('Failed to parse profile JSON: %s', e);
				profile = {
					name: venueName,
					type: 'unknown',
					address: venueAddress || 'Unknown',
					overview: 'Profile parsing failed. Please try again or research manually.',
					facilities: 'To be determined',
					partnershipOpportunities: ['Direct outreach needed'],
					clcFit: 'Manual assessment recommended',
					recommendedPrograms: ['Tennis', 'Chess'],
				};
			}

			return {
				profile,
				searchType,
				resultsCount: 1,
				searchCriteria: `Profile for: ${venueName}`,
			};

		// =====================================================================
		// OUTREACH PLAN
		// =====================================================================
		} else if (searchType === 'outreach-plan' && targetVenues.length > 0) {
			ctx.logger.info('Creating outreach plan for: %s', targetVenues.join(', '));

			const { text: planJson } = await generateText({
				model: openai('gpt-5-mini'),
				prompt: `You are helping a youth nonprofit create an outreach plan to approach potential venue partners in ${location}.

${CLC_VENUE_CONTEXT}

Target Venues: ${targetVenues.join(', ')}

Create a detailed outreach plan including:
1. Summary: Overall approach and goals for this outreach round
2. For each venue:
   - Priority level (high/medium/low)
   - Specific approach strategy (cold call, email, in-person visit, mutual connection)
   - Key talking points (3-5) — tailored to what that specific venue cares about
   - Proposed partnership model (free use, reduced rate, revenue share, sponsorship trade, etc.)
   - Suggested timeline for outreach and follow-up
3. Email template that could be customized for any of these venues — written from Kimberly's voice: warm, direct, specific about impact
4. Follow-up schedule (timing and action for each step)

**IMPORTANT TALKING POINTS TO INCLUDE:**
- CLC brings families and kids to the venue (free foot traffic)
- CLC provides all equipment and staff
- CLC carries its own insurance
- CLC's programs are grant-funded (we don't ask the venue for money)
- Hosting CLC is good PR for the venue
- For courts: CLC tournaments bring 50-100 players + families = visibility
- For slow/underutilized spaces: CLC fills empty time slots with positive programming

Return as JSON:
{
  "summary": "...",
  "venues": [
    {
      "name": "...",
      "priority": "high",
      "approach": "...",
      "talkingPoints": ["...", "..."],
      "proposedPartnership": "...",
      "timeline": "..."
    }
  ],
  "emailTemplate": "...",
  "followUpSchedule": [
    {"timing": "Day 0", "action": "Send initial email"},
    {"timing": "Day 3", "action": "..."}
  ]
}

Make the outreach plan warm, professional, and focused on mutual benefit. Kimberly's style: direct, authentic, specific.

Return ONLY valid JSON:`,
			});

			let outreachPlan: {
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
			} | undefined;

			try {
				const jsonMatch = planJson.match(/\{[\s\S]*\}/);
				if (jsonMatch) {
					outreachPlan = JSON.parse(jsonMatch[0]);
				}
			} catch (e) {
				ctx.logger.error('Failed to parse outreach plan JSON: %s', e);
				outreachPlan = {
					summary: 'Outreach plan parsing failed. Please try again.',
					venues: targetVenues.map((v) => ({
						name: v,
						priority: 'medium',
						approach: 'Direct contact recommended',
						talkingPoints: [
							'CLC serves 400+ kids across NY, NJ, CT',
							'We provide all equipment and coaches',
							'Flexible scheduling around your existing programs',
							'Our programs are grant-funded — no cost to your venue',
						],
						proposedPartnership: 'To be determined',
						timeline: '2-4 weeks',
					})),
					emailTemplate: 'Template generation failed. Please craft manually.',
					followUpSchedule: [
						{ timing: 'Day 0', action: 'Send initial email' },
						{ timing: 'Day 3-5', action: 'Follow up call' },
						{ timing: 'Day 7-10', action: 'Schedule site visit' },
					],
				};
			}

			return {
				outreachPlan,
				searchType,
				resultsCount: targetVenues.length,
				searchCriteria: `Outreach plan for ${targetVenues.length} venues in ${location}`,
			};
		}

		// Fallback
		return {
			searchType,
			resultsCount: 0,
			searchCriteria: 'Invalid or missing search parameters',
		};
	},
});

export default agent;
