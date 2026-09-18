import { ImageGenerationOptions, ImageGenerationResult } from '../../types/backend.types';
import { BaseBackend } from './base.backend';

export class StabilityBackend extends BaseBackend {
  readonly name = 'stability';
  readonly displayName = 'Stable Diffusion';

  private apiKey: string;
  private apiHost: string;

  constructor(apiKey: string, apiHost: string = 'https://api.stability.ai') {
    super();
    this.apiKey = apiKey;
    this.apiHost = apiHost;
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  getModels(): string[] {
    return ['stable-diffusion-xl-1024-v1-0', 'stable-diffusion-v1-6', 'stable-image-ultra-v1'];
  }

  protected async generateImage(options: ImageGenerationOptions): Promise<ImageGenerationResult> {
    const model = options.model || 'stable-diffusion-xl-1024-v1-0';

    const response = await fetch(`${this.apiHost}/v1/generation/${model}/text-to-image`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        text_prompts: [
          { text: options.prompt, weight: 1 },
          ...(options.negative_prompt ? [{ text: options.negative_prompt, weight: -1 }] : []),
        ],
        cfg_scale: options.cfg_scale,
        width: options.width,
        height: options.height,
        steps: options.steps,
        seed: options.seed ?? Math.floor(Math.random() * 4294967295),
        samples: 1,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Stability API error (${response.status}): ${body}`);
    }

    const data = (await response.json()) as {
      artifacts: Array<{ base64: string }>;
    };

    if (!data.artifacts || data.artifacts.length === 0) {
      throw new Error('No image returned from Stability API');
    }

    return {
      image_base64: data.artifacts[0].base64,
      metadata: {
        backend: this.name,
        model,
        generation_time_ms: 0,
      },
    };
  }
}
