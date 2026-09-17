import { ImageGenerationOptions, ImageGenerationResult } from '../../types/backend.types';
import { BaseBackend } from './base.backend';

export class ReplicateBackend extends BaseBackend {
  readonly name = 'replicate';
  readonly displayName = 'Flux (Replicate)';

  private apiToken: string;

  constructor(apiToken: string) {
    super();
    this.apiToken = apiToken;
  }

  isAvailable(): boolean {
    return !!this.apiToken;
  }

  getModels(): string[] {
    return ['black-forest-labs/flux-1.1-pro', 'black-forest-labs/flux-schnell'];
  }

  protected async generateImage(options: ImageGenerationOptions): Promise<ImageGenerationResult> {
    const model = options.model || 'black-forest-labs/flux-schnell';

    // Create prediction
    const createResponse = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiToken}`,
      },
      body: JSON.stringify({
        version: model,
        input: {
          prompt: options.prompt,
          negative_prompt: options.negative_prompt || '',
          width: options.width,
          height: options.height,
          num_inference_steps: options.steps,
          guidance_scale: options.cfg_scale,
          seed: options.seed,
        },
      }),
    });

    if (!createResponse.ok) {
      const body = await createResponse.text();
      throw new Error(`Replicate API error (${createResponse.status}): ${body}`);
    }

    const prediction = (await createResponse.json()) as { id: string; status: string };
    const result = await this.pollPrediction(prediction.id);
    return result;
  }

  private async pollPrediction(id: string, maxAttempts = 60): Promise<ImageGenerationResult> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const response = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Replicate poll error: ${response.status}`);
      }

      const prediction = (await response.json()) as {
        status: string;
        output?: string | string[];
        error?: string;
      };

      if (prediction.status === 'succeeded') {
        const output = Array.isArray(prediction.output)
          ? prediction.output[0]
          : prediction.output;
        return {
          image_url: output,
          metadata: {
            backend: this.name,
            model: 'replicate',
            generation_time_ms: 0,
          },
        };
      }

      if (prediction.status === 'failed' || prediction.status === 'canceled') {
        throw new Error(`Replicate prediction failed: ${prediction.error || prediction.status}`);
      }
    }

    throw new Error('Replicate prediction timed out');
  }
}
