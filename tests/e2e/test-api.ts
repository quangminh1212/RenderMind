/**
 * End-to-End API Test Script for RenderMind
 *
 * Tests the API endpoints against a running server.
 * Usage: npx tsx tests/e2e/test-api.ts [base_url]
 *
 * Requires: A running RenderMind server (npm run dev)
 */

const BASE_URL = process.argv[2] || 'http://localhost:3000';

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
  duration_ms: number;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    results.push({
      name,
      passed: true,
      message: 'OK',
      duration_ms: Date.now() - start,
    });
    console.log(`  \x1b[32m✓\x1b[0m ${name} (${Date.now() - start}ms)`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    results.push({
      name,
      passed: false,
      message: msg,
      duration_ms: Date.now() - start,
    });
    console.log(`  \x1b[31m✗\x1b[0m ${name}: ${msg}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function request(path: string, options?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function run(): Promise<void> {
  console.log(`\n\x1b[1mRenderMind API Tests\x1b[0m`);
  console.log(`Target: ${BASE_URL}\n`);

  // ─── Health ────────────────────────────────────────────────
  console.log('\x1b[1mHealth\x1b[0m');

  await test('GET /health returns 200', async () => {
    const { status, body } = await request('/health');
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.status === 'ok', `Expected status "ok", got "${body.status}"`);
    assert(body.version === '1.0.0', `Expected version "1.0.0"`);
  });

  await test('GET /health includes dependencies', async () => {
    const { body } = await request('/health');
    assert(body.dependencies !== undefined, 'Missing dependencies');
    assert(typeof body.dependencies.redis === 'string', 'Missing redis status');
  });

  // ─── Backends ──────────────────────────────────────────────
  console.log('\n\x1b[1mBackends\x1b[0m');

  await test('GET /api/v1/backends returns list', async () => {
    const { status, body } = await request('/api/v1/backends');
    assert(status === 200, `Expected 200, got ${status}`);
    assert(Array.isArray(body.backends), 'Expected backends array');
    assert(body.backends.length === 3, `Expected 3 backends, got ${body.backends.length}`);
  });

  // ─── Validation ────────────────────────────────────────────
  console.log('\n\x1b[1mValidation\x1b[0m');

  await test('POST /api/v1/generate rejects empty body', async () => {
    const { status, body } = await request('/api/v1/generate', {
      method: 'POST',
      body: '{}',
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(body.error === 'VALIDATION_ERROR', `Expected VALIDATION_ERROR`);
  });

  await test('POST /api/v1/generate rejects short width', async () => {
    const { status, body } = await request('/api/v1/generate', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'test', width: 10 }),
    });
    assert(status === 400, `Expected 400, got ${status}`);
  });

  await test('POST /api/v1/generate accepts valid prompt', async () => {
    const { status, body } = await request('/api/v1/generate', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'A beautiful sunset' }),
    });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.id, 'Missing generation ID');
    assert(body.status, 'Missing status');
  });

  // ─── Status ────────────────────────────────────────────────
  console.log('\n\x1b[1mStatus\x1b[0m');

  await test('GET /api/v1/status/:id returns 404 for unknown', async () => {
    const { status, body } = await request('/api/v1/status/gen_nonexistent');
    assert(status === 404, `Expected 404, got ${status}`);
  });

  // ─── 404 ───────────────────────────────────────────────────
  console.log('\n\x1b[1mError Handling\x1b[0m');

  await test('GET /nonexistent returns 404', async () => {
    const { status, body } = await request('/nonexistent');
    assert(status === 404, `Expected 404, got ${status}`);
    assert(body.error === 'NOT_FOUND', `Expected NOT_FOUND`);
  });

  // ─── Summary ───────────────────────────────────────────────
  console.log('\n' + '─'.repeat(50));
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  if (failed === 0) {
    console.log(`\x1b[32m\x1b[1m✓ All ${total} tests passed\x1b[0m`);
  } else {
    console.log(`\x1b[31m\x1b[1m✗ ${failed}/${total} tests failed\x1b[0m`);
    results
      .filter((r) => !r.passed)
      .forEach((r) => console.log(`  \x1b[31m- ${r.name}: ${r.message}\x1b[0m`));
    process.exit(1);
  }
}

run().catch((error) => {
  console.error('Test runner failed:', error);
  process.exit(1);
});
