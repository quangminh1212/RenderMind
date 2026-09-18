import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import routes from './routes';
import { errorHandler } from './middleware/errorHandler';
import { createRateLimiter } from './middleware/rateLimiter';
import { requestLogger } from './middleware/requestLogger';
import { apiKeyAuth } from './middleware/auth';
import { getConfig } from './config';

export function createApp(): express.Application {
  const app = express();
  const config = getConfig();

  // ─── Trust proxy (for rate limiting behind nginx/load balancer) ───
  if (config.server.nodeEnv === 'production') {
    app.set('trust proxy', 1);
  }

  // ─── Security Middleware ──────────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: config.server.nodeEnv === 'production' ? undefined : false,
    }),
  );

  // ─── CORS ─────────────────────────────────────────────────
  app.use(
    cors({
      origin: config.cors.origins.includes('*') ? '*' : config.cors.origins,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
      maxAge: 86400,
    }),
  );

  // ─── Rate Limiting ────────────────────────────────────────
  app.use(createRateLimiter());

  // ─── Body Parsing ─────────────────────────────────────────
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // ─── Request Logging ──────────────────────────────────────
  app.use(requestLogger);

  // ─── API Key Authentication ───────────────────────────────
  app.use(apiKeyAuth);

  // ─── Attach API key to request for rate limiter ───────────
  app.use((req, _res, next) => {
    const apiKeyHeader = config.auth.apiKeyHeader;
    if (apiKeyHeader) {
      (req as any).rateLimitKeyHeader = apiKeyHeader;
    }
    next();
  });

  // ─── Request ID ───────────────────────────────────────────
  app.use((req, _res, next) => {
    req.headers['x-request-id'] =
      (req.headers['x-request-id'] as string) ||
      `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    next();
  });

  // ─── Swagger/OpenAPI Documentation ────────────────────────
  const swaggerSpec = swaggerJsdoc({
    definition: {
      openapi: '3.0.3',
      info: {
        title: 'RenderMind API',
        version: '1.0.0',
        description:
          'AI Text-to-Image API Proxy — Unified interface for multiple image generation backends.',
        license: {
          name: 'MIT',
          url: 'https://opensource.org/licenses/MIT',
        },
        contact: {
          name: 'RenderMind Contributors',
          url: 'https://github.com/quangminh1212/RenderMind',
        },
      },
      servers: [
        {
          url: 'http://localhost:3000',
          description: 'Development server',
        },
      ],
      components: {
        securitySchemes: {
          ApiKeyAuth: {
            type: 'apiKey',
            in: 'header',
            name: 'x-api-key',
            description: 'API key for authentication (required when API_KEYS env is set)',
          },
        },
        schemas: {
          GenerateRequest: {
            type: 'object',
            required: ['prompt'],
            properties: {
              prompt: {
                type: 'string',
                minLength: 1,
                maxLength: 4000,
                example: 'A futuristic city at sunset',
              },
              negative_prompt: { type: 'string', maxLength: 4000 },
              width: { type: 'integer', minimum: 64, maximum: 4096, default: 1024 },
              height: { type: 'integer', minimum: 64, maximum: 4096, default: 1024 },
              backend: {
                type: 'string',
                enum: ['auto', 'stability', 'openclaw', 'replicate', 'custom'],
                default: 'auto',
              },
              steps: { type: 'integer', minimum: 1, maximum: 150, default: 30 },
              cfg_scale: { type: 'number', minimum: 1, maximum: 30, default: 7.5 },
              seed: { type: 'integer', minimum: 0 },
              model: { type: 'string' },
              webhook_url: { type: 'string', format: 'uri' },
            },
          },
          GenerateResponse: {
            type: 'object',
            properties: {
              id: { type: 'string', example: 'gen_a1b2c3d4e5f6' },
              status: { type: 'string', enum: ['pending', 'processing', 'completed', 'failed'] },
              image_url: { type: 'string', format: 'uri' },
              image_base64: { type: 'string' },
              error: { type: 'string' },
              metadata: {
                type: 'object',
                properties: {
                  backend: { type: 'string' },
                  model: { type: 'string' },
                  generation_time_ms: { type: 'integer' },
                  cached: { type: 'boolean' },
                },
              },
              created_at: { type: 'string', format: 'date-time' },
            },
          },
          ErrorResponse: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
              statusCode: { type: 'integer' },
            },
          },
        },
      },
    },
    apis: ['./src/routes/**/*.ts'],
  });

  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      customCss: '.swagger-ui .topbar { display: none }',
      customSiteTitle: 'RenderMind API Documentation',
    }),
  );

  // ─── API Routes ───────────────────────────────────────────
  app.use(routes);

  // ─── 404 Handler ──────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({
      error: 'NOT_FOUND',
      message: 'The requested endpoint does not exist',
      statusCode: 404,
    });
  });

  // ─── Error Handler ────────────────────────────────────────
  app.use(errorHandler);

  return app;
}
