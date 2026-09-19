import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initEngine, getEngine, setEngine } from '../../../src/engine';
import { setConfig, loadConfig } from '../../../src/config';
import { useTestConfig } from '../../helpers/harness';

/**
 * Engine composition-root tests.
 *
 * `initEngine` is lazy and idempotent so a test (or an integration harness) can substitute
 * its own engine without triggering provider construction from the real environment. These
 * pin that behaviour.
 */

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  setEngine(null);
  setConfig(loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv));
});

describe('engine composition root', () => {
  it('builds an engine with a registry and a generation service', () => {
    const engine = initEngine();
    expect(engine.registry).toBeDefined();
    expect(engine.generation).toBeDefined();
  });

  it('is idempotent — a second call returns the same instance', () => {
    expect(initEngine()).toBe(initEngine());
  });

  it('registers the chat provider with a configured key', () => {
    useTestConfig({ CHAT_API_KEY: 'k' });
    setEngine(null);

    const engine = initEngine();
    expect(engine.registry.available().map((p) => p.name)).toContain('chat');
  });

  it('getEngine initialises on first use', () => {
    expect(getEngine()).toBeDefined();
    expect(getEngine()).toBe(getEngine());
  });

  it('setEngine(null) clears the singleton so the next get rebuilds', () => {
    const first = getEngine();
    setEngine(null);
    expect(getEngine()).not.toBe(first);
  });
});
