import { GenerateResponse } from '../types/api.types';
import { getConfig } from '../config';
import { logger } from '../utils/logger';
import { createHmac } from 'crypto';

function isPrivateOrReservedIP(hostname: string): boolean {
  // Block localhost, loopback, link-local, private ranges, and cloud metadata
  const blocked = [
    'localhost',
    '0.0.0.0',
    '127.0.0.0',
    '127.0.0.1',
    '127.255.255.255',
    '10.0.0.0',
    '172.16.0.0',
    '192.168.0.0',
    '169.254.169.254', // AWS/GCP/Azure metadata
    '::1',
    'fc00::',
    'fe80::',
  ];
  const lower = hostname.toLowerCase();
  // Exact match or within CIDR (simplified: prefix match for common ranges)
  if (blocked.includes(lower)) return true;
  // 10.x.x.x
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower)) return true;
  // 172.16-31.x.x
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(lower)) return true;
  // 192.168.x.x
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(lower)) return true;
  // 127.x.x.x
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower)) return true;
  return false;
}

export class WebhookService {
  async deliver(url: string, payload: GenerateResponse): Promise<void> {
    const config = getConfig();

    // SSRF protection: validate URL scheme and block private/reserved IPs
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      logger.error('Webhook delivery rejected: invalid URL', { url, id: payload.id });
      return;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      logger.error('Webhook delivery rejected: disallowed protocol', {
        url,
        protocol: parsed.protocol,
        id: payload.id,
      });
      return;
    }
    if (isPrivateOrReservedIP(parsed.hostname)) {
      logger.error('Webhook delivery rejected: private/reserved IP', {
        url,
        hostname: parsed.hostname,
        id: payload.id,
      });
      return;
    }

    try {
      const body = JSON.stringify(payload);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'RenderMind/1.0',
      };

      if (config.webhook.secret) {
        const signature = createHmac('sha256', config.webhook.secret).update(body).digest('hex');
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
