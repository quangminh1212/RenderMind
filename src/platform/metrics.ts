import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics.
 *
 * Exposed at `/metrics`. Chosen over a bespoke endpoint because it is the interface
 * every orchestrator and dashboard already speaks.
 *
 * Cardinality is kept bounded deliberately: labels are drawn from a small known set
 * (provider names, outcomes), never from prompts or user input.
 */
export const register = new Registry();

register.setDefaultLabels({ service: 'rendermind' });
collectDefaultMetrics({ register });

/** End-to-end generation latency, by provider and outcome. */
export const generationDuration = new Histogram({
  name: 'rendermind_generation_duration_seconds',
  help: 'End-to-end image generation latency in seconds',
  labelNames: ['provider', 'outcome'],
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120],
  registers: [register],
});

/** Generation outcomes, by provider. */
export const generationsTotal = new Counter({
  name: 'rendermind_generations_total',
  help: 'Total image generations attempted, by provider and outcome',
  labelNames: ['provider', 'outcome'],
  registers: [register],
});

/** Images actually produced, so partial results are visible. */
export const imagesProduced = new Counter({
  name: 'rendermind_images_produced_total',
  help: 'Total images produced, by provider',
  labelNames: ['provider'],
  registers: [register],
});

/** Cache effectiveness, with errors as a first-class outcome. */
export const cacheOperations = new Counter({
  name: 'rendermind_cache_operations_total',
  help: 'Cache operations by result (hit, miss, error)',
  labelNames: ['result'],
  registers: [register],
});

/** Uploaded artifact inlining (provider URL → base64). */
export const artifactsInlined = new Counter({
  name: 'rendermind_artifacts_inlined_total',
  help: 'Provider image URLs fetched and inlined as base64',
  labelNames: ['provider', 'outcome'],
  registers: [register],
});

/** Webhook delivery outcomes. */
export const webhookDeliveries = new Counter({
  name: 'rendermind_webhook_deliveries_total',
  help: 'Webhook delivery attempts by outcome',
  labelNames: ['outcome'],
  registers: [register],
});

/** In-flight upstream calls, so queueing/backpressure is observable. */
export const inFlightGenerations = new Gauge({
  name: 'rendermind_in_flight_generations',
  help: 'Generations currently in flight',
  registers: [register],
});

/** Providers which the engine considers available. */
export const availableProviders = new Gauge({
  name: 'rendermind_available_providers',
  help: 'Number of providers currently available',
  registers: [register],
});

/** Circuit breaker state per provider, as 0=closed, 1=half-open, 2=open. */
export const breakerState = new Gauge({
  name: 'rendermind_circuit_breaker_state',
  help: 'Circuit breaker state per provider (0=closed, 1=half-open, 2=open)',
  labelNames: ['provider'],
  registers: [register],
});
