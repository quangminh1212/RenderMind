import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import routes from './routes';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { createRateLimiter } from './middleware/rateLimiter';
import { requestLogger } from './middleware/requestLogger';
import { apiKeyAuth } from './middleware/auth';
import { requestId, generationId } from './middleware/requestId';
import { getConfig } from './config';
import { register } from './platform/metrics';

export function createApp(): express.Application {
  const app = express();
  const config = getConfig();

  if (config.server.isProduction) {
    // A fixed hop count is a deployment assumption; make it explicit.
    app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));
  }

  // ── 1. Request identity ───────────────────────────────────
  // Must precede auth, rate limiting and logging so every log line and every
  // protocol error body can carry the same id.
  app.use(requestId);
  app.use(generationId);

  // ── 2. Security headers ───────────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: config.server.isProduction ? undefined : false,
    }),
  );

  // ── 3. CORS ───────────────────────────────────────────────
  app.use(
    cors({
      origin: config.cors.origins.includes('*') ? '*' : config.cors.origins,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'x-api-key',
        // Anthropic clients send these; omitting them broke cross-origin preflight.
        'anthropic-version',
        'anthropic-beta',
        'x-request-id',
      ],
      exposedHeaders: [
        'x-request-id',
        'request-id',
        'anthropic-ratelimit-requests-remaining',
        'anthropic-ratelimit-requests-reset',
        'retry-after',
      ],
      maxAge: 86400,
    }),
  );

  // ── 4. Body parsing ───────────────────────────────────────
  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // ── 5. Logging ────────────────────────────────────────────
  app.use(requestLogger);

  // ── 6. Authentication ─────────────────────────────────────
  // Runs before the limiter so the limiter can bucket by the resolved (hashed) key.
  app.use(apiKeyAuth);

  // ── 7. Rate limiting ──────────────────────────────────────
  app.use(createRateLimiter());

  // ── 8. Metrics ────────────────────────────────────────────
  app.get('/metrics', async (_req, res) => {
    res.setHeader('Content-Type', register.contentType);
    res.send(await register.metrics());
  });

  // ── 9. API documentation ──────────────────────────────────
  if (!config.server.isProduction || process.env.ENABLE_DOCS === 'true') {
    const swaggerSpec = swaggerJsdoc({
      definition: {
        openapi: '3.0.3',
        info: {
          title: 'RenderMind API',
          version: '1.0.0',
          description:
            'AI image-generation engine. Speaks the openclaw Images API and the Anthropic ' +
            'Messages API, and routes to configured image providers.',
          license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' },
        },
        servers: [{ url: '/', description: 'This server' }],
        components: {
          securitySchemes: {
            ApiKeyAuth: {
              type: 'apiKey',
              in: 'header',
              name: 'x-api-key',
              description: 'Required when API_KEYS is set. Authorization: Bearer also works.',
            },
          },
        },
      },
      apis: ['./src/routes/**/*.ts', './src/adapters/**/*.ts'],
    });

    app.use(
      '/docs',
      swaggerUi.serve,
      swaggerUi.setup(swaggerSpec, {
        customCss: '.swagger-ui .topbar { display: none }',
        customSiteTitle: 'RenderMind API Documentation',
      }),
    );
  }

  // ── 10. Routes ────────────────────────────────────────────
  app.use(routes);

  // ── 11. Not found + errors ────────────────────────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
