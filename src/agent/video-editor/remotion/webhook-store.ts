/**
 * In-memory store correlating our render correlationId → Remotion webhook result.
 *
 * Why: Remotion Lambda on Railway must be invoked with InvocationType='Event'
 * (fire-and-forget) because RequestResponse hangs silently on Bun's HTTP path
 * when the Lambda's startHandler buffers response writes. Event invokes return
 * 202 immediately, and we rely on webhooks (primary) + S3 HeadObject poll
 * (fallback) to detect completion.
 *
 * Scope constraint: single-instance deploy. If the Railway service ever scales
 * to multiple replicas, a webhook POST may land on a different replica than
 * the one awaiting the result — in that case, swap this for Redis or the
 * Agentuity thread state store.
 */

export type RemotionWebhookResult =
	| {
			type: 'success';
			renderId: string;
			outputUrl: string;
			timeToFinish: number;
			receivedAt: number;
	}
	| {
			type: 'error';
			renderId: string;
			errors: Array<{ message: string; name: string; stack?: string }>;
			receivedAt: number;
	}
	| {
			type: 'timeout';
			renderId: string;
			receivedAt: number;
	};

const store = new Map<string, RemotionWebhookResult>();

// 30 min TTL — longer than any realistic render, bounded enough that
// uncollected entries don't leak memory indefinitely.
const TTL_MS = 30 * 60 * 1000;

export function setWebhookResult(correlationId: string, result: RemotionWebhookResult): void {
	store.set(correlationId, result);
	setTimeout(() => store.delete(correlationId), TTL_MS).unref?.();
}

export function getWebhookResult(correlationId: string): RemotionWebhookResult | null {
	return store.get(correlationId) ?? null;
}

export function deleteWebhookResult(correlationId: string): void {
	store.delete(correlationId);
}
