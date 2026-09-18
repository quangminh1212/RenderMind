import { ImageGenerationOptions, ImageGenerationResult } from '../../types/backend.types';
import { BaseBackend } from './base.backend';

export class OpenAIBackend extends BaseBackend {
  readonly name = 'openclaw';
  readonly displayName = 'DALL-E 3';

  private apiKey: string;

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  getModels(): string[] {
    return ['dall-e-3'];
  }

  protected async generateImage(options: ImageGenerationOptions): Promise<ImageGenerationResult> {
    const model = options.model || 'dall-e-3';

    // DALL-E 3 only supports specific sizes
    const size = this.getValidSize(options.width, options.height);

    const response = await fetch('https://api.openclaw.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        model,
        prompt: options.negative_prompt
          ? `${options.prompt}. Avoid: ${options.negative_prompt}`
          : options.prompt,
        n: 1,
        size,
        quality: 'hd',
        response_format: 'b64_json',
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`openclaw API error (${response.status}): ${body}`);
    }

    const data = (await response.json()) as {
      data: Array<{ b64_json: string }>;
    };

    if (!data.data || data.data.length === 0) {
      throw new Error('No image returned from openclaw API');
    }

    return {
      image_base64: data.data[0].b64_json,
      metadata: {
        backend: this.name,
        model,
        generation_time_ms: 0,
      },
    };
  }

  private getValidSize(width: number, height: number): string {
    // DALL-E 3 only supports: 1024x1024, 1024x1792, 1792x1024
    const ratio = width / height;
    if (ratio > 1.3) return '1792x1024';
    if (ratio < 0.7) return '1024x1792';
    return '1024x1024';
  }
}
