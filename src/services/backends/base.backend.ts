import { ImageGenerationOptions, ImageGenerationResult } from '../../types/backend.types';
import { logger } from '../../utils/logger';

export abstract class BaseBackend {
  abstract readonly name: string;
  abstract readonly displayName: string;

  protected abstract generateImage(options: ImageGenerationOptions): Promise<ImageGenerationResult>;

  async generate(options: ImageGenerationOptions): Promise<ImageGenerationResult> {
    const startTime = Date.now();
    logger.info(`[${this.name}] Starting generation`, {
      prompt: options.prompt.substring(0, 50),
      width: options.width,
      height: options.height,
    });

    try {
      const result = await this.generateImage(options);
      const elapsed = Date.now() - startTime;
      logger.info(`[${this.name}] Generation completed in ${elapsed}ms`);
      return result;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[${this.name}] Generation failed after ${elapsed}ms: ${message}`);
      throw error;
    }
  }

  isAvailable(): boolean {
    return true;
  }

  getModels(): string[] {
    return [];
  }
}
