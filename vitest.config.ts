import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The retry/backoff paths deliberately wait, so a generous ceiling avoids
    // flakiness without masking a genuine hang.
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/app.ts',
        'src/types/**',
        'src/**/*.d.ts',
      ],
      // A floor rather than a target: it exists to catch a change that silently
      // drops coverage in the engine, which is where the correctness risks live.
      thresholds: {
        'src/engine/**': { statements: 80, branches: 70, functions: 80 },
        'src/providers/**': { statements: 60, branches: 50, functions: 60 },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
