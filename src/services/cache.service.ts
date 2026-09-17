import Redis from 'ioredis';
import { getConfig } from '../config';
import { logger } from '../utils/logger';

export class CacheService {
  private client: Redis | null = null;
  private ttl: number;

  constructor() {
    const config = getConfig();
    this.ttl = config.cache.ttl;
  }

  async connect(): Promise<void> {
    try {
      const config = getConfig();
      this.client = new Redis(config.redis.url, {
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
          if (times > 3) return null;
          return Math.min(times * 200, 2000);
        },
      });

      this.client.on('error', (err) => {
        logger.warn('Redis connection error', { error: err.message });
      });

      this.client.on('connect', () => {
        logger.info('Redis connected');
      });
    } catch (error) {
      logger.warn('Failed to connect to Redis, running without cache', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.client) return null;
    try {
      const value = await this.client.get(key);
      if (!value) return null;
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    if (!this.client) return;
    try {
      const serialized = JSON.stringify(value);
      if (ttlSeconds) {
        await this.client.setex(key, ttlSeconds, serialized);
      } else {
        await this.client.setex(key, this.ttl, serialized);
      }
    } catch (error) {
      logger.warn('Cache set failed', { key, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async del(key: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.del(key);
    } catch {
      // ignore
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.status === 'ready';
  }
}

export const cacheService = new CacheService();
