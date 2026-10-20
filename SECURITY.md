# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 3.x | Yes |
| 2.x | No |

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub private vulnerability reporting
on this repository. Please do not open a public issue for a security problem.

Include, where you can: the affected version or commit, what an attacker can achieve, and
the smallest reproduction you have. We aim to acknowledge within 72 hours.

## Threat model

RenderMind is a proxy holding credentials to paid upstream services. The primary risks:

1. **Credential exposure.** An open instance spends the operator's provider credits.
2. **Server-side request forgery.** Provider-supplied image URLs are fetched when
   base64 delivery is requested, creating an outbound request derived from upstream data.
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

Provider image URLs (fetched for base64 inlining) are validated before fetching:
- Only http and https schemes are allowed.
- Loopback and unspecified addresses (127.x.x.x, ::1, ::) are blocked, including
  IPv4-mapped IPv6 spellings.
- Link-local, unique-local and deprecated site-local addresses (169.254.x.x, fe80::,
  fc00::/7, fec0::/10) are blocked.
- Private ranges (10.x, 172.16-31.x, 192.168.x) are blocked.
- Carrier-grade NAT (100.64-127.x) and benchmarking (198.18-19.x) ranges are blocked.
- Cloud metadata endpoints (169.254.169.254, metadata.google.internal) are blocked.
- Redirects are followed manually, with every target revalidated and a three-hop limit.

**Known limitation:** the check inspects the hostname string and does not resolve DNS. A
domain under an attacker's control that resolves to a link-local address therefore passes
the filter. Fixing this requires resolving and pinning the address before connecting. This
is tracked as future work; until then, treat provider image URLs as semi-trusted input.

### Resource bounds

- A global semaphore caps concurrent upstream calls (MAX_GENERATION_CONCURRENCY),
  independent of how many images a single request asks for.
- Per-provider circuit breakers take a failing provider out of rotation.
- A per-sub-job deadline bounds how long one request can hold a connection, with waits
  capped so an upstream Retry-After cannot stall it indefinitely.
- Request bodies are size-limited.
- Both URL-fetched and inline base64 images are subject to a 25 MiB size limit.

### Secrets

- Log redaction covers authorization headers, API keys, tokens and secrets by path.
  Free-text scrubbing removes key-shaped strings and bearer tokens.
- Base64 image payloads are truncated before logging, so user content is not written to
  log storage.

### Transport

- CORS `allowedHeaders` dynamically includes the configured API key header name, so a
  custom header is not silently blocked by preflight.
- `TRUST_PROXY_HOPS` is clamped to [0, 10] to prevent misconfiguration expanding the
  trusted forwarding chain beyond a sane range.

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

The runtime dependency set is audited in CI with `pnpm audit --omit=dev --audit-level=high`
and must stay clean. Development-toolchain advisories are visible in the same run so they
cannot be ignored, but they do not block a release.
