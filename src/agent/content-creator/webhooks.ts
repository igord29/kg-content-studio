/**
 * Make.com Webhook Integration
 * Sends generated content to Make.com for automated social media posting
 */

export interface WebhookPayload {
	platform: string;
	content: string;
	imageUrl?: string;
	imageStyle?: string;
	scheduledTime?: string | null; // ISO timestamp or null for immediate
	hashtags: string[];
	metadata: {
		generatedAt: string;
		model: string;
		agentVersion: string;
	};
}

export interface WebhookConfig {
	instagram?: string;
	facebook?: string;
	twitter?: string;
	linkedin?: string;
	tiktok?: string;
	youtube?: string;
	email?: string; // For newsletter via Mailchimp etc.
}

// Default webhook URLs - these should be configured via environment variables
const getWebhookConfig = (): WebhookConfig => ({
	instagram: process.env.MAKE_WEBHOOK_INSTAGRAM,
	facebook: process.env.MAKE_WEBHOOK_FACEBOOK,
	twitter: process.env.MAKE_WEBHOOK_TWITTER,
	linkedin: process.env.MAKE_WEBHOOK_LINKEDIN,
	tiktok: process.env.MAKE_WEBHOOK_TIKTOK,
	youtube: process.env.MAKE_WEBHOOK_YOUTUBE,
	email: process.env.MAKE_WEBHOOK_EMAIL,
});

/**
 * Extract hashtags from content
 */
function extractHashtags(content: string): string[] {
	const hashtagRegex = /#\w+/g;
	const matches = content.match(hashtagRegex);
	return matches || [];
}

/**
 * Send content to Make.com webhook for publishing
 */
export async function sendToMakeWebhook(
	platform: string,
	content: string,
	imageUrl?: string,
	imageStyle?: string,
	scheduledTime?: string | null,
): Promise<{ success: boolean; message: string }> {
	const config = getWebhookConfig();
	const platformKey = platform.toLowerCase() as keyof WebhookConfig;
	const webhookUrl = config[platformKey];

	if (!webhookUrl) {
		return {
			success: false,
			message: `No webhook configured for ${platform}. Please set MAKE_WEBHOOK_${platform.toUpperCase()} environment variable.`,
		};
	}

	const payload: WebhookPayload = {
		platform,
		content,
		imageUrl,
		imageStyle,
		scheduledTime: scheduledTime || null,
		hashtags: extractHashtags(content),
		metadata: {
			generatedAt: new Date().toISOString(),
			model: 'gpt-5-mini',
			agentVersion: '1.0',
		},
	};

	try {
		const response = await fetch(webhookUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(payload),
		});

		if (!response.ok) {
			const errorText = await response.text();
			return {
				success: false,
				message: `Webhook failed: ${response.status} - ${errorText}`,
			};
		}

		return {
			success: true,
			message: `Content sent to Make.com for ${platform} publishing`,
		};
	} catch (error) {
		return {
			success: false,
			message: `Webhook error: ${error instanceof Error ? error.message : 'Unknown error'}`,
		};
	}
}

/**
 * Get list of configured webhooks
 */
export function getConfiguredWebhooks(): string[] {
	const config = getWebhookConfig();
	return Object.entries(config)
		.filter(([_, url]) => !!url)
		.map(([platform]) => platform);
}
