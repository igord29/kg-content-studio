import { createAgent } from '@agentuity/runtime';
import { s } from '@agentuity/schema';
import contentCreator from '../content-creator';
import videoEditor from '../video-editor';
import grantWriter from '../grant-writer';
import donorResearcher from '../donor-researcher';
import venueProspector from '../venue-prospector';

const AgentInput = s.object({
	topic: s.string(),
	description: s.string().optional(),
});

const AgentOutput = s.object({
	intent: s.string(),
	message: s.string(),
	routed_to: s.string(),
	result: s.any().optional(),
});

const agent = createAgent('manager', {
	description: 'Routes content marketing and operations requests to appropriate agents',
	schema: {
		input: AgentInput,
		output: AgentOutput,
	},
	handler: async (ctx, { topic, description }) => {
		ctx.logger.info('Manager analyzing: %s', topic);

		const text = `${topic} ${description || ''}`.toLowerCase();

		let intent = 'unknown';
		let routed_to = 'none';
		let result = null;

		// Video editing requests
		if (
			text.includes('video') ||
			text.includes('tiktok') ||
			text.includes('reel') ||
			text.includes('youtube') ||
			text.includes('ffmpeg') ||
			text.includes('edit video') ||
			text.includes('clip') ||
			text.includes('footage') ||
			text.includes('catalog') ||
			text.includes('organize video') ||
			text.includes('sort footage') ||
			text.includes('highlight reel') ||
			text.includes('game day') ||
			text.includes('our story') ||
			text.includes('quick hit') ||
			text.includes('showcase') ||
			text.includes('list videos') ||
			text.includes('folder summary') ||
			text.includes('what videos') ||
			text.includes('render') ||
			text.includes('produce video') ||
			text.includes('export video') ||
			text.includes('make video') ||
			text.includes('create video from') ||
			text.includes('shotstack')
		) {
			intent = 'video';
			routed_to = 'video-editor';
			ctx.logger.info('Routing to video-editor...');

			// Check for Google Drive / catalog tasks first
			if (text.includes('list video') || text.includes('what video') || text.includes('show video')) {
				result = await videoEditor.run({ task: 'list-videos' });
			} else if (text.includes('folder summary') || text.includes('how many video') || text.includes('drive summary')) {
				result = await videoEditor.run({ task: 'folder-summary' });
			} else if (text.includes('catalog') || text.includes('organize') || text.includes('sort footage')) {
				result = await videoEditor.run({ task: 'catalog', catalogAction: 'generate' });
			} else if (text.includes('test connection') || text.includes('check drive')) {
				result = await videoEditor.run({ task: 'test-connection' });
			} else {
				// Legacy video editing workflow
				let videoType = 'highlight';
				let platform = 'instagram';

				if (text.includes('intro')) videoType = 'intro';
				else if (text.includes('recap') || text.includes('event')) videoType = 'recap';
				else if (text.includes('testimonial') || text.includes('interview')) videoType = 'testimonial';
				else if (text.includes('promo')) videoType = 'promo';
				else if (text.includes('story') || text.includes('behind')) videoType = 'story';

				if (text.includes('tiktok')) platform = 'tiktok';
				else if (text.includes('youtube')) platform = 'youtube';
				else if (text.includes('reel')) platform = 'instagram-reels';
				else if (text.includes('facebook')) platform = 'facebook';

				result = await videoEditor.run({
					videoType,
					platform,
					topic,
					mode: 'full',
				});
			}
		}
		// Grant requests — search OR write
		else if (
			text.includes('grant') ||
			text.includes('proposal') ||
			text.includes('loi') ||
			text.includes('letter of intent') ||
			text.includes('funding') ||
			text.includes('application')
		) {
			intent = 'grant';
			routed_to = 'grant-writer';
			ctx.logger.info('Routing to grant-writer...');

			// Determine if this is a SEARCH or WRITE request
			const isSearch =
				text.includes('find grant') ||
				text.includes('search grant') ||
				text.includes('research grant') ||
				text.includes('look for grant') ||
				text.includes('grant opportunit') ||
				text.includes('available grant') ||
				text.includes('grant deadline') ||
				text.includes('what grants') ||
				text.includes('which grants') ||
				text.includes('grants for') ||
				text.includes('grant search');

			if (isSearch) {
				// Grant research mode
				ctx.logger.info('Grant Writer: SEARCH mode');
				result = await grantWriter.run({
					task: 'search',
					maxDeadlineYear: 2026,
					searchFocus: topic,
				});
			} else {
				// Grant writing mode (original behavior)
				let grantType = 'loi';
				if (text.includes('full proposal') || text.includes('complete proposal')) grantType = 'full-proposal';
				else if (text.includes('executive summary') || text.includes('summary')) grantType = 'executive-summary';
				else if (text.includes('budget')) grantType = 'budget-narrative';
				else if (text.includes('impact') || text.includes('report')) grantType = 'impact-report';
				else if (text.includes('thank you') || text.includes('thanks')) grantType = 'thank-you-letter';

				result = await grantWriter.run({
					task: 'write',
					grantType,
					projectDescription: topic,
				});
			}
		}
		// Donor research requests
		else if (
			text.includes('donor') ||
			text.includes('sponsor') ||
			text.includes('funder') ||
			text.includes('foundation') ||
			text.includes('prospect') ||
			text.includes('accounting firm') ||
			text.includes('cpa') ||
			text.includes('tax write') ||
			text.includes('write-off') ||
			text.includes('charitable deduction')
		) {
			intent = 'donor';
			routed_to = 'donor-researcher';
			ctx.logger.info('Routing to donor-researcher...');

			// Check for accounting firm focus
			const isAccountingFocus =
				text.includes('accounting') ||
				text.includes('cpa') ||
				text.includes('tax write') ||
				text.includes('write-off') ||
				text.includes('deduction');

			// Determine search type
			let searchType: 'prospect-search' | 'deep-dive' | 'connection-map' = 'prospect-search';
			if (text.includes('research') || text.includes('profile') || text.includes('deep dive')) {
				searchType = 'deep-dive';
			} else if (text.includes('connect') || text.includes('introduction') || text.includes('pathway')) {
				searchType = 'connection-map';
			}

			if (searchType === 'prospect-search') {
				result = await donorResearcher.run({
					searchType,
					location: 'Nassau County, Westchester County, New York metro',
					givingArea: 'youth-development',
					focusOnAccountingFirms: isAccountingFocus,
					prospectType: isAccountingFocus ? 'accounting-firm' : undefined,
				});
			} else if (searchType === 'deep-dive') {
				const prospectMatch = text.match(/(?:research|profile|about)\s+([^,.]+)/i);
				result = await donorResearcher.run({
					searchType,
					prospectName: prospectMatch?.[1]?.trim() ?? topic,
				});
			} else {
				result = await donorResearcher.run({
					searchType,
					targetProspect: topic,
				});
			}
		}
		// Venue prospecting requests
		else if (
			text.includes('venue') ||
			text.includes('location') ||
			text.includes('space') ||
			text.includes('court') ||
			text.includes('gym') ||
			text.includes('community center') ||
			text.includes('where to') ||
			text.includes('tournament') ||
			text.includes('tennis court') ||
			text.includes('underutilized') ||
			text.includes('nassau') ||
			text.includes('westchester')
		) {
			intent = 'venue';
			routed_to = 'venue-prospector';
			ctx.logger.info('Routing to venue-prospector...');

			// Determine location — default to Nassau & Westchester
			let location = 'Nassau County and Westchester County, NY';
			if (text.includes('nassau') && !text.includes('westchester')) {
				location = 'Nassau County, NY';
			} else if (text.includes('westchester') && !text.includes('nassau')) {
				location = 'Westchester County, NY';
			}

			// Extract specific location if mentioned
			const locationMatch = text.match(/(?:in|near|around)\s+([^,.]+)/i);
			if (locationMatch?.[1]?.trim()) {
				const extracted = locationMatch[1].trim();
				// Only use extracted location if it looks like a real place name
				if (!['a', 'the', 'our', 'my', 'this'].includes(extracted.split(' ')[0] || '')) {
					location = extracted;
				}
			}

			// Check for tournament focus
			const isTournament = text.includes('tournament') || text.includes('competition') || text.includes('match');

			// Determine search type
			let searchType: 'venue-search' | 'venue-profile' | 'outreach-plan' = 'venue-search';
			if (text.includes('profile') || text.includes('research')) {
				searchType = 'venue-profile';
			} else if (text.includes('outreach') || text.includes('email') || text.includes('contact')) {
				searchType = 'outreach-plan';
			}

			if (searchType === 'venue-search') {
				result = await venueProspector.run({
					searchType,
					location,
					programType: isTournament ? 'tournament' : 'both',
					tournamentCapable: isTournament,
				});
			} else if (searchType === 'venue-profile') {
				result = await venueProspector.run({
					searchType,
					location,
					venueName: topic,
				});
			} else {
				result = await venueProspector.run({
					searchType,
					location,
					targetVenues: [topic],
				});
			}
		}
		// Default to content creation for social/content requests
		else if (
			text.includes('platform:') ||
			text.includes('social') ||
			text.includes('post') ||
			text.includes('content') ||
			text.includes('tennis') ||
			text.includes('chess') ||
			text.includes('program') ||
			text.includes('student') ||
			text.includes('kid') ||
			text.includes('mentor') ||
			text.includes('story') ||
			text.includes('share') ||
			text.includes('success') ||
			text.includes('instagram') ||
			text.includes('facebook') ||
			text.includes('linkedin') ||
			text.includes('twitter') ||
			text.includes('newsletter') ||
			text.includes('blog') ||
			text.includes('email')
		) {
			intent = 'content';
			routed_to = 'content-creator';
			ctx.logger.info('Routing to content-creator...');

			// Extract platform
			const platformMatch = text.match(/platform:\s*(\w+)/i);
			let platform = 'Instagram';

			if (platformMatch?.[1]) {
				platform = platformMatch[1];
			} else if (text.includes('linkedin')) {
				platform = 'LinkedIn';
			} else if (text.includes('facebook')) {
				platform = 'Facebook';
			} else if (text.includes('twitter') || text.includes(' x ')) {
				platform = 'Twitter';
			} else if (text.includes('newsletter') || text.includes('email')) {
				platform = 'Newsletter';
			} else if (text.includes('blog')) {
				platform = 'Blog';
			} else if (text.includes('tiktok')) {
				platform = 'TikTok';
			} else if (text.includes('youtube')) {
				platform = 'YouTube';
			}

			result = await contentCreator.run({ topic, platform });
		}

		return {
			intent,
			message: `Detected: ${intent}. Routed to: ${routed_to}`,
			routed_to,
			result,
		};
	},
});

export default agent;
