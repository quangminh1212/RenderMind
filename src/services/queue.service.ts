import { Queue, Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import { getConfig } from '../config';
import { logger } from '../utils/logger';
import { GenerateRequest, GenerateResponse } from '../types/api.types';
import { generateId } from '../utils/idGenerator';

export interface QueueJobData {
  id: string;
  request: GenerateRequest;
}

export class QueueService {
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private connection: Redis | null = null;

  constructor() {}

  async connect(): Promise<void> {
    try {
      const config = getConfig();
      this.connection = new Redis(config.redis.url, {
        maxRetriesPerRequest: 3,
      });

      this.queue = new Queue('rendermind-generate', {
        connection: this.connection,
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 50,
          attempts: 2,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
        },
      });

      logger.info('Queue service connected');
    } catch (error) {
      logger.warn('Failed to connect queue, running synchronously', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async disconnect(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }
    if (this.connection) {
      await this.connection.quit();
      this.connection = null;
    }
  }

  isAvailable(): boolean {
    return this.queue !== null;
  }

  async addJob(id: string, request: GenerateRequest): Promise<void> {
    if (!this.queue) {
      throw new Error('Queue not available');
    }

    await this.queue.add('generate', { id, request }, { jobId: id });
    logger.info(`Job ${id} added to queue`);
  }

  async getJobStatus(id: string): Promise<{ status: string } | null> {
    if (!this.queue) return null;
    const job = await this.queue.getJob(id);
    if (!job) return null;
    return { status: job.progress ? String(job.progress) : 'waiting' };
  }
}

export const queueService = new QueueService();
