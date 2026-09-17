import { createApp } from './app';
import { loadConfig } from './config';
import { cacheService } from './services/cache.service';
import { queueService } from './services/queue.service';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  const config = loadConfig();

  logger.info('Starting RenderMind...', {
    port: config.server.port,
    env: config.server.nodeEnv,
    auth: config.auth.enabled ? 'enabled' : 'disabled',
  });

  // Connect to Redis (non-fatal if unavailable)
  await cacheService.connect();
  await queueService.connect();

  // Create Express app
  const app = createApp();

  // Start server
  const server = app.listen(config.server.port, config.server.host, () => {
    logger.info(`RenderMind server running`, {
      url: `http://${config.server.host}:${config.server.port}`,
      docs: `http://localhost:${config.server.port}/docs`,
      health: `http://localhost:${config.server.port}/health`,
    });
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      logger.error(`Port ${config.server.port} is already in use`);
    } else {
      logger.error('Server error', { error: error.message });
    }
    process.exit(1);
  });

  // ─── Graceful Shutdown ────────────────────────────────────
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`${signal} received, shutting down gracefully...`);

    // Stop accepting new connections
    server.close(async () => {
      logger.info('HTTP server closed');

      try {
        await cacheService.disconnect();
        await queueService.disconnect();
        logger.info('All connections closed');
      } catch (error) {
        logger.error('Error during shutdown', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      process.exit(0);
    });

    // Force shutdown after 30s
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 30000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // ─── Unhandled Errors ─────────────────────────────────────
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Promise Rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
    process.exit(1);
  });
}

main().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
