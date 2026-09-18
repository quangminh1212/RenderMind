import { Request, Response, NextFunction } from 'express';
import { getConfig } from '../config';

const EXEMPT_PATHS = ['/health', '/docs', '/docs/', '/api/v1/backends'];

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const config = getConfig();

  // Skip auth if not enabled or path is exempt
  if (!config.auth.enabled) {
    return next();
  }

  if (EXEMPT_PATHS.some((p) => req.path === p)) {
    return next();
  }

  const apiKey = req.headers[config.auth.apiKeyHeader.toLowerCase()] as string | undefined;

  if (!apiKey) {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: `Missing API key. Provide it via the "${config.auth.apiKeyHeader}" header.`,
      statusCode: 401,
    });
    return;
  }

  if (!config.auth.apiKeys.includes(apiKey)) {
    res.status(403).json({
      error: 'FORBIDDEN',
      message: 'Invalid API key',
      statusCode: 403,
    });
    return;
  }

  next();
}
