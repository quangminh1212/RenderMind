export interface ImageGenerationOptions {
  prompt: string;
  negative_prompt?: string;
  width: number;
  height: number;
  steps: number;
  cfg_scale: number;
  seed?: number;
  model?: string;
}

export interface ImageGenerationResult {
  image_url?: string;
  image_base64?: string;
  metadata: {
    backend: string;
    model: string;
    generation_time_ms: number;
  };
}

export interface BackendConfig {
  name: string;
  enabled: boolean;
  api_key?: string;
  api_host?: string;
  models: string[];
  priority: number;
}

export interface CustomBackendConfig extends BackendConfig {
  url: string;
  headers?: Record<string, string>;
  body_template?: string;
}
