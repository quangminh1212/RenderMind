import { GenerateResponse } from '../types/api.types';
import { getConfig } from '../config';
import { logger } from '../utils/logger';
import { createHmac } from 'crypto';

export class WebhookService {
  async deliver(url: string, payload: GenerateResponse): Promise<void> {
    const config = getConfig();

    try {
      const body = JSON.stringify(payload);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'RenderMind/1.0',
      };

      if (config.webhook.secret) {
        const signature = createHmac('sha256', config.webhook.secret)
          .update(body)
          .digest('hex');
        headers['X-RenderMind-Signature'] = `sha256=${signature}`;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        logger.warn(`Webhook delivery failed: ${response.status}`, { url, id: payload.id });
      } else {
        logger.info(`Webhook delivered successfully`, { url, id: payload.id });
      }
    } catch (error) {
      logger.error(`Webhook delivery error`, {
        url,
        id: payload.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const webhookService = new WebhookService();
