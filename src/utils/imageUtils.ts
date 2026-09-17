export function buildCacheKey(prompt: string, width: number, height: number, backend: string, seed?: number): string {
  const parts = [prompt, width, height, backend];
  if (seed !== undefined) {
    parts.push(String(seed));
  }
  return `img:${Buffer.from(parts.join('|')).toString('base64url')}`;
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 100);
}
