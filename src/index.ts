import { createApp } from './app';
import { loadConfig } from './config';
import { cacheService } from './services/cache.service';
import { queueService } from './services/queue.service';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  // Load configuration
  const config = loadConfig();

  logger.info('Starting RenderMind...', {
    port: config.server.port,
    env: config.server.nodeEnv,
  });

  // Connect to Redis
  await cacheService.connect();
  await queueService.connect();

  // Create and start Express app
  const app = createApp();

  const server = app.listen(config.server.port, config.server.host, () => {
    logger.info(`RenderMind server running on http://${config.server.host}:${config.server.port}`);
    logger.info(`API documentation available at http://localhost:${config.server.port}/docs`);
    logger.info(`Health check at http://localhost:${config.server.port}/health`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, starting graceful shutdown...`);

    server.close(async () => {
      await cacheService.disconnect();
      await queueService.disconnect();
      logger.info('Server shut down gracefully');
      process.exit(0);
    });

    // Force shutdown after 10s
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  logger.error('Failed to start server', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
