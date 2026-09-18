# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 2.x | Yes |
| 1.x | No |

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub private vulnerability reporting
on this repository. Please do not open a public issue for a security problem.

Include, where you can: the affected version or commit, what an attacker can achieve, and
the smallest reproduction you have. We aim to acknowledge within 72 hours.

## Threat model

RenderMind is a proxy holding credentials to paid upstream services. The primary risks:

1. **Credential exposure.** An open instance spends the operator's provider credits.
2. **Server-side request forgery.** Webhook delivery and provider-supplied image URLs are
   both outbound requests derived from request data.
3. **Resource exhaustion.** Image generation is expensive and slow.

## Controls in place

### Authentication

- API keys are compared with crypto.timingSafeEqual over SHA-256 digests, so the
  comparison does not leak a prefix.
- Rate-limit buckets are keyed on a hash of the key, so the raw secret never appears in
  logs or in the bucket key.
- The server refuses to start in production without API_KEYS, unless
  ALLOW_UNAUTHENTICATED=true is set explicitly. An unset variable silently producing a
  fully open proxy is the failure mode this prevents.
- Rejected keys are logged as a fingerprint, never as the value.

### SSRF

Webhook delivery validates the scheme and blocks loopback, link-local, private ranges and
cloud metadata addresses (169.254.169.254), including IPv6 equivalents.

**Known limitation:** the check inspects the hostname string and does not resolve DNS. A
domain under an attacker's control that resolves to a link-local address therefore passes
the filter. Fixing this requires resolving and pinning the address before connecting. This
is tracked as future work; until then, treat webhook URLs as trusted input.

### Resource bounds

- A global semaphore caps concurrent upstream calls (MAX_GENERATION_CONCURRENCY),
  independent of how many images a single request asks for.
- Per-provider circuit breakers take a failing provider out of rotation.
- A per-sub-job deadline bounds how long one request can hold a connection, with waits
  capped so an upstream Retry-After cannot stall it indefinitely.
- Request bodies are size-limited.

### Secrets

- Log redaction covers authorization headers, API keys, tokens and secrets by path.
  Free-text scrubbing removes key-shaped strings and bearer tokens.
- Base64 image payloads are truncated before logging, so user content is not written to
  log storage.

## Deployment checklist

- Set API_KEYS to long random values.
- Set CORS_ORIGINS to your actual origins; production defaults to none.
- Terminate TLS in front of the service. It does not do TLS itself.
- Set TRUST_PROXY_HOPS to the real number of proxies, so client IPs are resolved
  correctly rather than trusting a spoofable header.
- Use a secrets manager for provider keys rather than a checked-in .env file.
- Keep Redis on a private network. It is used for caching, not for access control.
- Run the container as a non-root user (the image already does).
- Monitor /metrics for provider error rates and open circuit breakers.

## Dependency hygiene

The runtime dependency set is audited in CI with `npm audit --omit=dev --audit-level=high`
and must stay clean. Development-toolchain advisories are visible in the same run so they
cannot be ignored, but they do not block a release.
