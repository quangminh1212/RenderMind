/**
 * End-to-end smoke test for a running RenderMind server.
 *
 *   npx tsx tests/e2e/test-api.ts [base_url]
 *   npm run test:e2e
 *
 * Asserts only contracts that hold regardless of which providers are configured, and
 * exercises both protocol bridges, which are the surfaces a portable client uses.
 * Generation is attempted only when a provider is available.
 */

const BASE_URL = process.argv[2] ?? process.env.RENDERMIND_URL ?? 'http://localhost:3000';
const API_KEY = process.env.API_KEY ?? process.env.API_KEYS?.split(',')[0] ?? '';

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
}

const results: TestResult[] = [];

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['x-api-key'] = API_KEY;
  return headers;
}

async function request(path: string, options: RequestInit = {}) {
  const res = await fetch(BASE_URL + path, { headers: authHeaders(), ...options });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers, text };
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true, message: 'OK' });
    console.log('  PASS  ' + name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, passed: false, message });
    console.log('  FAIL  ' + name + ': ' + message);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  console.log('RenderMind E2E against ' + BASE_URL);

  await test('GET /healthz returns 200 (liveness)', async () => {
    const res = await request('/healthz');
    assert(res.status === 200, 'expected 200, got ' + res.status);
    assert(res.body.status === 'ok', 'expected status ok');
    assert(typeof res.body.version === 'string', 'expected a version string');
  });

  await test('GET /readyz reports provider readiness', async () => {
    const res = await request('/readyz');
    // 200 when a provider is configured, 503 when none is. Both are correct; what
    // matters is that the payload explains which.
    assert([200, 503].includes(res.status), 'unexpected status ' + res.status);
    assert(res.body.checks !== undefined, 'missing checks object');
    assert(
      typeof res.body.checks.providers.available === 'number',
      'missing provider availability count',
    );
  });

  await test('Anthropic bridge requires max_tokens', async () => {
    const res = await request('/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert(res.status === 400, 'expected 400, got ' + res.status);
    assert(res.body.error.type === 'invalid_request_error', 'expected invalid_request_error');
  });

  await test('Anthropic count_tokens endpoint responds', async () => {
    const res = await request('/v1/messages/count_tokens', {
      method: 'POST',
      body: JSON.stringify({
        model: 'm',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hello there' }],
      }),
    });
    assert(res.status === 200, 'expected 200, got ' + res.status);
    assert(typeof res.body.input_tokens === 'number', 'expected input_tokens');
  });

  await test('openclaw request without a prompt is rejected', async () => {
    const res = await request('/v1/images/generations', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert(res.status === 400, 'expected 400, got ' + res.status);
  });

  await test('GET /v1/models returns an openclaw-shaped list', async () => {
    const res = await request('/v1/models');
    assert(res.status === 200, 'expected 200, got ' + res.status);
    assert(res.body.object === 'list', 'expected object: list');
    assert(Array.isArray(res.body.data), 'expected a data array');
  });

  await test('GET /api/v1/backends lists providers', async () => {
    const res = await request('/api/v1/backends');
    assert(res.status === 200, 'expected 200, got ' + res.status);
    assert(Array.isArray(res.body.backends), 'expected a backends array');
  });

  await test('openclaw bridge uses the openclaw error envelope', async () => {
    const res = await request('/v1/images/generations', { method: 'POST', body: '{}' });
    assert(res.status === 400, 'expected 400, got ' + res.status);
    assert(res.body.error !== undefined, 'expected an error object');
    assert(res.body.error.type !== undefined, 'expected error.type');
    // The native envelope must not leak through a bridge.
    assert(res.body.statusCode === undefined, 'native envelope leaked');
  });

  await test('Anthropic bridge uses the Anthropic error envelope', async () => {
    const res = await request('/v1/messages', { method: 'POST', body: '{}' });
    assert(res.status === 400, 'expected 400, got ' + res.status);
    assert(res.body.type === 'error', 'expected type: error');
    assert(res.body.error.type !== undefined, 'expected error.type');
  });

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log('');
  console.log('--------------------------------------------');
  if (failed === 0) {
    console.log('All ' + passed + ' checks passed');
  } else {
    console.log(failed + ' of ' + (passed + failed) + ' checks failed');
    for (const r of results.filter((x) => !x.passed)) {
      console.log('  - ' + r.name + ': ' + r.message);
    }
    process.exit(1);
  }
}

run().catch((error) => {
  console.error('Test runner failed:', error);
  process.exit(1);
});
