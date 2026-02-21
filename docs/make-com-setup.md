# Make.com Integration Setup Guide

This guide walks you through setting up Make.com scenarios to automatically publish content from the Content Studio to your social media platforms.

## Overview

The Content Studio sends generated content to Make.com webhooks, which then handle the actual posting to each platform. This separation allows for:
- Scheduling posts
- Adding approval workflows
- Handling rate limits
- Managing multiple accounts
- Tracking publishing history

## Prerequisites

1. A Make.com account (free tier works for testing)
2. Connected social media accounts in Make.com
3. Your Agentuity deployment URL

## Environment Variables

Add these to your `.env` file for each platform you want to enable:

```env
MAKE_WEBHOOK_INSTAGRAM=https://hook.make.com/your-instagram-webhook-id
MAKE_WEBHOOK_FACEBOOK=https://hook.make.com/your-facebook-webhook-id
MAKE_WEBHOOK_TWITTER=https://hook.make.com/your-twitter-webhook-id
MAKE_WEBHOOK_LINKEDIN=https://hook.make.com/your-linkedin-webhook-id
MAKE_WEBHOOK_TIKTOK=https://hook.make.com/your-tiktok-webhook-id
MAKE_WEBHOOK_YOUTUBE=https://hook.make.com/your-youtube-webhook-id
MAKE_WEBHOOK_EMAIL=https://hook.make.com/your-email-webhook-id
```

## Webhook Payload

The Content Studio sends this JSON payload to each webhook:

```json
{
  "platform": "Instagram",
  "content": "Your generated post content...",
  "imageUrl": "https://...",
  "imageStyle": "Photorealism",
  "scheduledTime": "2024-03-15T14:00:00.000Z",
  "hashtags": ["#tennis", "#chess", "#youth"],
  "metadata": {
    "generatedAt": "2024-03-14T10:30:00.000Z",
    "model": "gpt-5-mini",
    "agentVersion": "1.0"
  }
}
```

---

## Platform Setup Guides

### Instagram

1. **Create a new Scenario** in Make.com
2. **Add a Webhook trigger**
   - Choose "Custom webhook"
   - Copy the webhook URL
   - Add to `.env` as `MAKE_WEBHOOK_INSTAGRAM`
3. **Add Instagram module**
   - Search for "Instagram for Business"
   - Connect your Instagram Business account
   - Choose "Create a Photo Post" action
4. **Map the fields:**
   - Image URL → `imageUrl` from webhook
   - Caption → `content` from webhook
5. **Handle scheduling:**
   - Add a Router module
   - If `scheduledTime` exists → add to a Data Store and use Scheduler
   - If no `scheduledTime` → publish immediately
6. **Turn on the scenario**

### Facebook

1. **Create a new Scenario**
2. **Add a Webhook trigger** → copy URL → add to `.env`
3. **Add Facebook Pages module**
   - Connect your Facebook Page
   - Choose "Create a Post" action
4. **Map fields:**
   - Message → `content`
   - Link/Photo → `imageUrl` (if present)
5. **Optional: Add scheduling logic** as with Instagram

### Twitter/X

1. **Create a new Scenario**
2. **Add Webhook trigger** → copy URL → add to `.env`
3. **Add Twitter module**
   - Connect your Twitter account
   - Choose "Create a Tweet" action
4. **Map fields:**
   - Tweet Text → `content` (truncate to 280 chars)
   - Media → Download image from `imageUrl` first, then attach
5. **Note:** Twitter API requires downloading images before attaching

### LinkedIn

1. **Create a new Scenario**
2. **Add Webhook trigger** → copy URL → add to `.env`
3. **Add LinkedIn module**
   - Connect your LinkedIn account (requires Company Page for some features)
   - Choose "Create a Share" action
4. **Map fields:**
   - Text → `content`
   - Image URL → `imageUrl`
5. **Optional:** Add approval workflow before posting

### TikTok

1. **Create a new Scenario**
2. **Add Webhook trigger** → copy URL → add to `.env`
3. **Note:** TikTok API is limited. Options:
   - Use a third-party service like Hootsuite or Later
   - Send notification to draft folder
   - Use email to yourself with content ready to copy
4. **Alternative flow:**
   - Webhook → Email module → Send to yourself with caption text

### YouTube

1. **Create a new Scenario**
2. **Add Webhook trigger** → copy URL → add to `.env`
3. **Add YouTube module**
   - Connect your YouTube channel
   - Choose "Update Video" or "Upload Video"
4. **Note:** YouTube requires actual video files, not just generated content
5. **Typical use:** Update video descriptions and metadata

### Newsletter (Mailchimp)

1. **Create a new Scenario**
2. **Add Webhook trigger** → copy URL → add to `.env`
3. **Add Mailchimp module**
   - Connect your Mailchimp account
   - Choose "Create a Campaign" action
4. **Map fields:**
   - Subject → Extract from first line of `content`
   - HTML Content → Convert `content` to HTML
   - Image → `imageUrl`
5. **Optional:** Add approval step before sending

---

## Advanced Features

### Approval Workflow

Add a Slack/Email notification step before posting:

1. Webhook → Slack "Send Message"
2. Wait for approval (use Slack buttons or separate webhook)
3. If approved → Post to platform

### Error Handling

1. Add an Error Handler to each module
2. On error → Send notification (Slack/Email)
3. Store failed posts in a Data Store for retry

### Analytics Tracking

1. After successful post → Add row to Google Sheets
2. Track: Platform, Time, Engagement (via scheduled check)

### Multi-Account Support

1. Use a Router after the webhook
2. Filter by platform or add account selector in payload
3. Route to different social accounts based on filters

---

## Testing

1. Set up at least one webhook (Instagram recommended for testing)
2. Generate content in Content Studio
3. Click "Send to Make.com"
4. Check Make.com scenario history for the webhook trigger
5. Verify post appears on your social platform

## Troubleshooting

**Webhook not triggering:**
- Verify webhook URL is correct in `.env`
- Check scenario is turned ON in Make.com
- Look for errors in Agentuity logs

**Image not posting:**
- Some platforms require downloading the image first
- Add an HTTP "Get a file" module before the social module
- Use the downloaded file instead of URL

**Content too long:**
- Add a Text module to truncate content
- Different platforms have different limits (Twitter: 280, Instagram: 2200, etc.)

**Scheduled posts not working:**
- Make.com free tier has limited scheduling
- Consider using Data Store + Scheduler pattern
- Or upgrade to a paid Make.com plan

---

## Support

For issues with:
- **Content Studio:** Check Agentuity logs and this documentation
- **Make.com:** Consult Make.com documentation or community
- **Platform APIs:** Check each platform's developer documentation
