import 'dotenv/config';
import { createApp } from './app';
import { loadConfig, setConfig } from './config';
import { cacheService } from './services/cache.service';
import { initEngine } from './engine';
import { logger } from './utils/logger';

/**
 * Process entry point.
 *
 * `dotenv/config` is imported first so that `node dist/index.js` honours a local `.env`.
 * Without it, only `tsx`-based runs picked up `.env`, and the documented self-host path
 * silently ignored PORT, API_KEYS and every provider key.
 */
async function main(): Promise<void> {
  // Validate configuration before doing anything else, so a misconfiguration is a clear
  // startup error naming the offending variable rather than a confusing runtime failure.
  let config;
  try {
    config = loadConfig();
    setConfig(config);
  } catch (error) {
    // The logger depends on config, so report config failures on stderr.
    process.stderr.write(
      `RenderMind failed to start:\n${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }

  logger.info('Starting RenderMind', {
    port: config.server.port,
    env: config.server.nodeEnv,
    auth: config.auth.enabled ? 'enabled' : 'disabled',
  });

  if (!config.auth.enabled) {
    logger.warn(
      'Authentication is DISABLED: every endpoint is open and will spend your configured ' +
        'provider API keys. Set API_KEYS before exposing this service.',
    );
  }

  // Redis is optional; the cache degrades to an in-memory tier.
  await cacheService.connect();

  // Build the provider registry and generation engine.
  initEngine();

  const app = createApp();

  const server = app.listen(config.server.port, config.server.host, () => {
    logger.info('RenderMind listening', {
      url: `http://${config.server.host}:${config.server.port}`,
      docs: `http://localhost:${config.server.port}/docs`,
      liveness: `http://localhost:${config.server.port}/healthz`,
      readiness: `http://localhost:${config.server.port}/readyz`,
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

  // ─── Graceful shutdown ────────────────────────────────────
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`${signal} received, shutting down gracefully`);

    server.close(async () => {
      logger.info('HTTP server closed');
      try {
        await cacheService.disconnect();
      } catch (error) {
        logger.error('Error during shutdown', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      process.exit(0);
    });

    // Force shutdown if connections do not drain in time.
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 30000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // ─── Unhandled failures ───────────────────────────────────
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: error.message, stack: error.stack });
    process.exit(1);
  });
}

main().catch((error) => {
  // Config may have failed to load, so fall back to stderr.
  process.stderr.write(
    `Fatal startup error: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
