import { cacheService } from '../services/cache.service';
import { logger } from '../utils/logger';

/**
 * Generation state machine and record store.
 *
 * Replaces the previous `GenerateResponse`-in-a-cache-entry approach, in which
 * `'processing'` was written once and never updated — a write-only value no client could
 * ever observe — and there was no way to express *partial* success.
 *
 *   queued → running → succeeded
 *                    ├→ partial     (n>1: some sub-jobs failed)
 *                    ├→ failed
 *                    └→ cancelled
 */

export type GenerationState =
  'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';

export interface GenerationRecord {
  id: string;
  state: GenerationState;
  request: {
    prompt: string;
    count: number;
    provider?: string;
    model?: string;
  };
  images: Array<{ url?: string; base64?: string; mime: string; revisedPrompt?: string }>;
  /** Per-image failures, so a partial result is inspectable. */
  errors: Array<{ index: number; message: string }>;
  provider?: string;
  model?: string;
  /** Which fields the engine had to adapt, if any. */
  adaptations?: Record<string, unknown>;
  webhook?: {
    delivered: boolean;
    attempts: number;
    lastError?: string;
    rejectedReason?: string;
  };
  attempts: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
}

const RECORD_PREFIX = 'gen:';
const RECORD_TTL_SECONDS = 86400; // 24 hours

export class GenerationRepository {
  private readonly ttl: number;

  constructor(ttlSeconds: number = RECORD_TTL_SECONDS) {
    this.ttl = ttlSeconds;
  }

  private key(id: string): string {
    return `${RECORD_PREFIX}${id}`;
  }

  async create(record: GenerationRecord): Promise<void> {
    await this.save(record);
  }

  /**
   * Persist a record, bumping its version and updatedAt.
   *
   * The version exists so concurrent updates cannot silently clobber each other and so
   * a client can tell whether the state it read is still current.
   */
  async save(record: GenerationRecord): Promise<GenerationRecord> {
    const updated: GenerationRecord = {
      ...record,
      version: record.version + 1,
      updatedAt: new Date().toISOString(),
      expiresAt: Date.now() + this.ttl * 1000,
    };

    const ok = await cacheService.write(this.key(record.id), updated, this.ttl);
    if (!ok) {
      logger.warn('Generation record write failed; status lookup may be incomplete', {
        id: record.id,
      });
    }
    return updated;
  }

  async get(id: string): Promise<GenerationRecord | null> {
    const read = await cacheService.read<GenerationRecord>(this.key(id));
    if (read.outcome === 'hit') return read.value;

    if (read.outcome === 'error') {
      logger.warn('Generation record read failed', { id });
    }
    return null;
  }

  /** Transition a record's state and persist it. */
  async transition(
    id: string,
    state: GenerationState,
    patch: Partial<GenerationRecord> = {},
  ): Promise<GenerationRecord | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    const next: GenerationRecord = { ...existing, ...patch, state };
    return this.save(next);
  }

  async recordWebhookOutcome(
    id: string,
    outcome: NonNullable<GenerationRecord['webhook']>,
  ): Promise<void> {
    const existing = await this.get(id);
    if (!existing) return;
    await this.save({ ...existing, webhook: outcome });
  }

  /**
   * Derive the terminal state from per-image results.
   *
   * This is the fix for batch status: the old code used a ternary that could only ever
   * report all-or-nothing, so 19-of-20 successes was reported as a total failure.
   */
  static deriveState(succeeded: number, failed: number): GenerationState {
    if (failed === 0 && succeeded > 0) return 'succeeded';
    if (succeeded === 0) return 'failed';
    return 'partial';
  }
}

export const generationRepository = new GenerationRepository();
