import { ImageGenerationOptions, ImageGenerationResult } from '../../types/backend.types';
import { BaseBackend } from './base.backend';
import { CustomBackendConfig } from '../../types/backend.types';

export class CustomBackend extends BaseBackend {
  readonly name: string;
  readonly displayName: string;

  private config: CustomBackendConfig;

  constructor(config: CustomBackendConfig) {
    super();
    this.name = config.name;
    this.displayName = config.name;
    this.config = config;
  }

  isAvailable(): boolean {
    return !!this.config.url;
  }

  getModels(): string[] {
    return this.config.models;
  }

  protected async generateImage(options: ImageGenerationOptions): Promise<ImageGenerationResult> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.config.headers,
    };

    if (this.config.api_key) {
      headers['Authorization'] = `Bearer ${this.config.api_key}`;
    }

    const body = {
      prompt: options.prompt,
      negative_prompt: options.negative_prompt,
      width: options.width,
      height: options.height,
      steps: options.steps,
      cfg_scale: options.cfg_scale,
      seed: options.seed,
      model: options.model,
    };

    const response = await fetch(this.config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Custom backend error (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      image_url?: string;
      image_base64?: string;
      output?: string;
      images?: Array<{ url?: string; base64?: string }>;
    };

    // Try to extract image from various response formats
    let imageUrl = data.image_url || data.output;
    let imageBase64 = data.image_base64;

    if (!imageUrl && !imageBase64 && data.images && data.images.length > 0) {
      imageUrl = data.images[0].url;
      imageBase64 = data.images[0].base64;
    }

    return {
      image_url: imageUrl,
      image_base64: imageBase64,
      metadata: {
        backend: this.name,
        model: options.model || 'custom',
        generation_time_ms: 0,
      },
    };
  }
}
