import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import routes from './routes';
import { errorHandler } from './middleware/errorHandler';
import { createRateLimiter } from './middleware/rateLimiter';
import { requestLogger } from './middleware/requestLogger';

export function createApp(): express.Application {
  const app = express();

  // ─── Security Middleware ──────────────────────────────────
  app.use(helmet());
  app.use(cors());
  app.use(createRateLimiter());

  // ─── Body Parsing ─────────────────────────────────────────
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // ─── Logging ──────────────────────────────────────────────
  app.use(requestLogger);

  // ─── Swagger/OpenAPI Documentation ────────────────────────
  const swaggerSpec = swaggerJsdoc({
    definition: {
      openapi: '3.0.3',
      info: {
        title: 'RenderMind API',
        version: '1.0.0',
        description:
          'AI Text-to-Image API Proxy — Unified interface for multiple image generation backends',
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
        schemas: {
          GenerateResponse: {
            type: 'object',
            properties: {
              id: { type: 'string', example: 'gen_a1b2c3d4e5f6' },
              status: {
                type: 'string',
                enum: ['pending', 'processing', 'completed', 'failed'],
              },
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
        },
      },
    },
    apis: ['./src/routes/**/*.ts'],
  });

  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'RenderMind API Documentation',
  }));

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
