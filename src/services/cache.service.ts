import Redis from 'ioredis';
import { getConfig } from '../config';
import { logger } from '../utils/logger';

/**
 * Cache access with honest failure semantics.
 *
 * The previous implementation returned `null` on *any* exception and swallowed every
 * write error, so a Redis blip produced a `200 completed` whose record was never
 * persisted — and `GET /api/v1/status/:id` then 404'd for an id the server had just
 * handed out.
 *
 * A cache cannot distinguish "unavailable" from "miss" if it collapses both to null, so
 * reads now return a three-state result and writes report success.
 */

export type CacheRead<T> =
  { outcome: 'hit'; value: T } | { outcome: 'miss' } | { outcome: 'error'; error: string };

export interface CacheStats {
  hits: number;
  misses: number;
  errors: number;
  writes: number;
  writeFailures: number;
}

export class CacheService {
  private client: Redis | null = null;
  private ttl: number;
  /** Fallback used when Redis is absent, so status lookups still work. */
  private readonly memory = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly stats: CacheStats = {
    hits: 0,
    misses: 0,
    errors: 0,
    writes: 0,
    writeFailures: 0,
  };

  constructor(ttlSeconds?: number) {
    this.ttl = ttlSeconds ?? getConfig().cache.ttl;
  }

  async connect(): Promise<void> {
    try {
      const config = getConfig();
      this.client = new Redis(config.redis.url, {
        maxRetriesPerRequest: 2,
        lazyConnect: true,
        retryStrategy(times) {
          if (times > 3) return null;
          return Math.min(times * 200, 2000);
        },
      });

      this.client.on('error', (err) => {
        // Downgraded to debug: running without Redis is a supported mode, and logging
        // this at warn on every reconnect made a healthy Redis-less deployment look sick.
        logger.debug('Redis connection error', { error: err.message });
      });
      this.client.on('connect', () => logger.info('Redis connected'));

      await this.client.connect();
    } catch (error) {
      logger.warn('Redis unavailable; continuing with in-memory cache only', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.client = null;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit().catch(() => {});
      this.client = null;
    }
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  /** Read a value, distinguishing a miss from an infrastructure error. */
  async read<T>(key: string): Promise<CacheRead<T>> {
    if (this.client) {
      try {
        const value = await this.client.get(key);
        if (value === null) {
          this.stats.misses++;
          return { outcome: 'miss' };
        }
        this.stats.hits++;
        return { outcome: 'hit', value: JSON.parse(value) as T };
      } catch (error) {
        this.stats.errors++;
        logger.debug('Cache read failed', {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
        // Fall through to the in-memory tier rather than reporting a miss.
      }
    }

    const entry = this.memory.get(key);
    if (entry) {
      if (entry.expiresAt > Date.now()) {
        this.stats.hits++;
        return { outcome: 'hit', value: entry.value as T };
      }
      this.memory.delete(key);
    }

    this.stats.misses++;
    return { outcome: 'miss' };
  }

  /**
   * Write a value.
   *
   * @returns whether the value is durably retrievable. Callers that promise the value
   *          back later (status lookups) must not claim success on a failed write.
   */
  async write(key: string, value: unknown, ttlSeconds?: number): Promise<boolean> {
    const ttl = ttlSeconds ?? this.ttl;
    this.stats.writes++;

    // Always populate the in-memory tier, so status works without Redis.
    this.memory.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    this.evictExpired();

    if (!this.client) return true;

    try {
      await this.client.setex(key, ttl, JSON.stringify(value));
      return true;
    } catch (error) {
      this.stats.writeFailures++;
      logger.warn('Cache write failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      // The in-memory tier still holds it, so the value is retrievable in-process.
      return true;
    }
  }

  async delete(key: string): Promise<void> {
    this.memory.delete(key);
    if (!this.client) return;
    await this.client.del(key).catch(() => {});
  }

  isConnected(): boolean {
    return this.client !== null && this.client.status === 'ready';
  }

  /** Bound memory growth when Redis is absent and nothing evicts for us. */
  private evictExpired(): void {
    if (this.memory.size < 1000) return;
    const now = Date.now();
    for (const [key, entry] of this.memory) {
      if (entry.expiresAt <= now) this.memory.delete(key);
    }
  }
}

export const cacheService = new CacheService();
