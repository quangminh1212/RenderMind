import { z } from 'zod';

// ─── Request Schemas ──────────────────────────────────────

export const GenerateRequestSchema = z.object({
  prompt: z.string().min(1).max(4000).describe('Text prompt for image generation'),
  negative_prompt: z.string().max(4000).optional().describe('Things to avoid in the image'),
  width: z.number().int().min(64).max(4096).default(1024).describe('Image width in pixels'),
  height: z.number().int().min(64).max(4096).default(1024).describe('Image height in pixels'),
  backend: z
    .enum(['auto', 'stability', 'openclaw', 'replicate', 'custom'])
    .default('auto')
    .describe('Image generation backend to use'),
  steps: z.number().int().min(1).max(150).default(30).describe('Number of inference steps'),
  cfg_scale: z.number().min(1).max(30).default(7.5).describe('Classifier-free guidance scale'),
  seed: z.number().int().min(0).optional().describe('Random seed for reproducibility'),
  webhook_url: z.string().url().optional().describe('URL to receive webhook on completion'),
  model: z.string().optional().describe('Specific model to use within the backend'),
});

export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

export const BatchRequestSchema = z.object({
  prompts: z
    .array(z.string().min(1).max(4000))
    .min(1)
    .max(20)
    .describe('Array of text prompts (1-20)'),
  options: z
    .object({
      width: z.number().int().min(64).max(4096).default(1024),
      height: z.number().int().min(64).max(4096).default(1024),
      backend: z.enum(['auto', 'stability', 'openclaw', 'replicate', 'custom']).default('auto'),
      parallel: z.number().int().min(1).max(10).default(3).describe('Max parallel generations'),
      steps: z.number().int().min(1).max(150).default(30).describe('Number of inference steps'),
      cfg_scale: z.number().min(1).max(30).default(7.5).describe('Classifier-free guidance scale'),
      seed: z.number().int().min(0).optional().describe('Random seed for reproducibility'),
    })
    .default({}),
});

export type BatchRequest = z.infer<typeof BatchRequestSchema>;

// ─── Response Types ───────────────────────────────────────

export type GenerationStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface GenerationMetadata {
  backend: string;
  model: string;
  generation_time_ms: number;
  cached?: boolean;
}

export interface GenerateResponse {
  id: string;
  status: GenerationStatus;
  image_url?: string;
  image_base64?: string;
  error?: string;
  metadata?: GenerationMetadata;
  created_at: string;
}

export interface BatchResponse {
  id: string;
  status: GenerationStatus;
  total: number;
  completed: number;
  failed: number;
  results: GenerateResponse[];
  created_at: string;
}

export interface StatusResponse {
  id: string;
  status: GenerationStatus;
  image_url?: string;
  error?: string;
  metadata?: GenerationMetadata;
  created_at: string;
  updated_at: string;
}

// ─── Error Types ──────────────────────────────────────────

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
  details?: unknown;
}

export interface BackendInfo {
  name: string;
  display_name: string;
  status: 'available' | 'unavailable' | 'configured';
  models: string[];
}
