# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-01-01

### Added

- **Core API**
  - `POST /api/v1/generate` — Single image generation endpoint
  - `POST /api/v1/batch` — Parallel batch generation (up to 20 prompts)
  - `GET /api/v1/status/:id` — Async generation status check
  - `GET /api/v1/backends` — List available backends
  - `GET /health` — Health check with dependency status

- **Backend Support**
  - Stability AI (Stable Diffusion XL)
  - openclaw (DALL-E 3)
  - Replicate (Flux)
  - Custom HTTP backend support

- **Features**
  - Smart auto-routing across backends
  - Request validation with Zod
  - Redis caching with configurable TTL
  - Rate limiting with express-rate-limit
  - Webhook callbacks with HMAC signature verification
  - Request logging middleware

- **Developer Experience**
  - Full TypeScript with strict mode
  - OpenAPI/Swagger documentation at `/docs`
  - ESLint + Prettier configuration
  - Vitest test suite
  - Docker multi-stage build
  - docker-compose with Redis

- **Infrastructure**
  - Health check endpoint with dependency monitoring
  - Graceful shutdown handling
  - Structured JSON logging
  - Environment variable validation

### Security

- Helmet.js for HTTP security headers
- CORS configuration
- Rate limiting to prevent abuse
- Non-root Docker container
