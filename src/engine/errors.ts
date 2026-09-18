/**
 * Typed engine errors.
 *
 * The audit found the previous implementation flattened every upstream failure into
 * the literal string 'Generation failed after multiple attempts', discarding the HTTP
 * status, the upstream error code, and any Retry-After header. A 400 invalid-prompt was
 * retried three times and then reported as a 502 server fault.
 *
 * These types preserve that information end-to-end so the engine can retry only what is
 * retryable and report an honest status to the caller.
 */

/** HTTP statuses the engine is willing to retry. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

export interface ProviderErrorInit {
  message: string;
  provider: string;
  /** Upstream HTTP status, when one was received. */
  status?: number;
  /** Upstream machine-readable error code, e.g. 'content_policy_violation'. */
  code?: string;
  /** Seconds to wait before retrying, from an upstream Retry-After header. */
  retryAfterSeconds?: number;
  /** Whether the operation is safe to retry. Defaults from `status`. */
  retryable?: boolean;
  cause?: unknown;
  /** Redacted upstream body, for operators. Never returned to clients verbatim. */
  upstreamBody?: string;
}

export class ProviderError extends Error {
  readonly provider: string;
  readonly status?: number;
  readonly code?: string;
  readonly retryAfterSeconds?: number;
  readonly retryable: boolean;
  readonly upstreamBody?: string;

  constructor(init: ProviderErrorInit) {
    super(init.message);
    this.name = 'ProviderError';
    this.provider = init.provider;
    this.status = init.status;
    this.code = init.code;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.upstreamBody = init.upstreamBody;
    this.retryable = init.retryable ?? ProviderError.isRetryableStatus(init.status);
    if (init.cause !== undefined) {
      (this as { cause?: unknown }).cause = init.cause;
    }
    Object.setPrototypeOf(this, ProviderError.prototype);
  }

  /**
   * Whether a failure with this status may be retried.
   *
   * A missing status means a transport-level failure (DNS, socket, timeout), which is
   * generally transient. 4xx client errors are terminal — retrying them burns upstream
   * quota and wall-clock time on a request that cannot succeed.
   */
  static isRetryableStatus(status?: number): boolean {
    if (status === undefined) return true;
    return RETRYABLE_STATUSES.has(status);
  }

  /** Whether this failure was caused by the caller rather than the upstream. */
  get isClientError(): boolean {
    return this.status !== undefined && this.status >= 400 && this.status < 500;
  }
}

/**
 * A request that no configured provider can satisfy.
 *
 * Distinct from ProviderError: this is a capability gap, not an outage. Adapters map it
 * to a 400-class client error (an unsupported capability is the caller's problem),
 * whereas an exhausted ProviderError is a 502.
 */
export class UnsupportedCapabilityError extends Error {
  readonly details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = 'UnsupportedCapabilityError';
    this.details = details;
    Object.setPrototypeOf(this, UnsupportedCapabilityError.prototype);
  }
}

/** No provider is configured/available at all — a deployment error, not a request error. */
export class NoProviderAvailableError extends Error {
  constructor(message = 'No image provider is configured. Set at least one provider API key.') {
    super(message);
    this.name = 'NoProviderAvailableError';
    Object.setPrototypeOf(this, NoProviderAvailableError.prototype);
  }
}

/**
 * Every configured provider is currently out of rotation.
 *
 * Distinct from NoProviderAvailableError (nothing is configured) and from
 * UnsupportedCapabilityError (what is configured cannot serve this request). This is a
 * transient upstream outage, so it maps to 503 rather than a 4xx.
 */
export class AllProvidersUnavailableError extends Error {
  readonly providers: string[];

  constructor(providers: string[]) {
    super(
      'All configured providers are temporarily unavailable ' +
        '(circuit breakers open). Retry shortly.',
    );
    this.name = 'AllProvidersUnavailableError';
    this.providers = providers;
    Object.setPrototypeOf(this, AllProvidersUnavailableError.prototype);
  }
}

/** A generation exceeded its wall-clock budget. */
export class GenerationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Generation exceeded its ${timeoutMs}ms deadline`);
    this.name = 'GenerationTimeoutError';
    Object.setPrototypeOf(this, GenerationTimeoutError.prototype);
  }
}
