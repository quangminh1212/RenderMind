import { createHash } from 'crypto';

export function buildCacheKey(
  prompt: string,
  width: number,
  height: number,
  backend: string,
  seed?: number,
  model?: string,
): string {
  const parts = [prompt, width, height, backend];
  if (seed !== undefined) parts.push(String(seed));
  if (model) parts.push(model);

  const hash = createHash('sha256').update(parts.join('|')).digest('hex').substring(0, 16);
  return `img:${hash}`;
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 100);
}
