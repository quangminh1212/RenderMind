import { BackendConfig } from '../types/backend.types';

export const BACKEND_CONFIGS: Record<string, BackendConfig> = {
  stability: {
    name: 'stability',
    enabled: false,
    api_host: 'https://api.stability.ai',
    models: ['stable-diffusion-xl-1024-v1-0', 'stable-diffusion-v1-6', 'stable-image-ultra-v1'],
    priority: 1,
  },
  openclaw: {
    name: 'openclaw',
    enabled: false,
    models: ['dall-e-3'],
    priority: 2,
  },
  replicate: {
    name: 'replicate',
    enabled: false,
    models: ['black-forest-labs/flux-1.1-pro', 'black-forest-labs/flux-schnell'],
    priority: 3,
  },
  custom: {
    name: 'custom',
    enabled: false,
    models: [],
    priority: 99,
  },
};

export const DEFAULT_MODELS: Record<string, string> = {
  stability: 'stable-diffusion-xl-1024-v1-0',
  openai: 'dall-e-3',
  replicate: 'black-forest-labs/flux-schnell',
};
