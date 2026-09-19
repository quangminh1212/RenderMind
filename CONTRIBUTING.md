# Contributing to RenderMind

Thank you for your interest in contributing to RenderMind! This document provides guidelines and information for contributors.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Making Changes](#making-changes)
- [Testing](#testing)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)

## Code of Conduct

Please be respectful and constructive in all interactions. We are committed to providing a welcoming and inclusive experience for everyone.

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/your-username/RenderMind.git
   cd RenderMind
   ```
3. **Install** dependencies:
   ```bash
   npm install
   ```
4. **Create** a feature branch:
   ```bash
   git checkout -b feature/my-new-feature
   ```

## Development Setup

### Prerequisites

- Node.js >= 20.0.0
- npm >= 10.0.0
- Redis (optional, for cache/queue features)

### Environment Variables

```bash
cp .env.example .env
# Edit .env with your configuration
```

### Running Locally

```bash
# Start development server with hot reload
npm run dev

# Run tests
npm test

# Run linter
npm run lint

# Type check
npm run typecheck
```

## Project Structure

```
src/
├── config/          # Configuration and environment
├── middleware/       # Express middleware (error handling, validation, etc.)
├── routes/          # API route handlers
├── services/        # Business logic and backend integrations
│   └── backends/    # Image generation backend implementations
├── types/           # TypeScript type definitions
└── utils/           # Utility functions
```

## Making Changes

### Branch Naming

- `feature/description` — New features
- `fix/description` — Bug fixes
- `docs/description` — Documentation changes
- `refactor/description` — Code refactoring

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new backend support for XYZ
fix: resolve cache invalidation issue
docs: update API documentation
refactor: simplify backend selection logic
test: add unit tests for cache service
chore: update dependencies
```

### Adding a New Backend

1. Create a new file in `src/services/backends/`:
   ```typescript
   import { BaseBackend } from './base.backend';
   
   export class NewBackend extends BaseBackend {
     readonly name = 'new-backend';
     readonly displayName = 'New Backend';
     
     protected async generateImage(options: ImageGenerationOptions) {
       // Implementation
     }
   }
   ```
2. Register it in `src/services/backend.service.ts`
3. Add config in `src/config/`
4. Add environment variables to `.env.example`
5. Write tests

## Testing

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run with coverage
npm run test:coverage
```

### Writing Tests

- Place unit tests in `tests/unit/`
- Place integration tests in `tests/integration/`
- Use `describe` blocks for grouping
- Use descriptive test names
- Mock external dependencies

Example:

```typescript
import { describe, it, expect } from 'vitest';
import { myFunction } from '../../src/utils/myModule';

describe('myFunction', () => {
  it('should do something specific', () => {
    const result = myFunction('input');
    expect(result).toBe('expected output');
  });
});
```

## Pull Request Process

1. **Update** documentation if needed
2. **Write** or update tests for your changes
3. **Ensure** all checks pass:
   ```bash
   npm run typecheck
   npm run lint
   npm test
   ```
4. **Push** your branch and create a Pull Request
5. **Fill** out the PR template completely
6. **Request** a review from maintainers

### PR Guidelines

- Keep PRs focused on a single change
- Write clear, descriptive titles
- Include screenshots for UI changes
- Reference related issues
- Keep commits atomic and well-described

## Coding Standards

### TypeScript

- Use strict TypeScript (`strict: true`)
- Prefer interfaces over types for object shapes
- Export types alongside implementations
- Use `readonly` for immutable properties

### Naming Conventions

- **Files**: `kebab-case.ts` (e.g., `backend.service.ts`)
- **Classes**: `PascalCase` (e.g., `BackendService`)
- **Functions**: `camelCase` (e.g., `generateImage`)
- **Constants**: `UPPER_SNAKE_CASE` (e.g., `DEFAULT_TIMEOUT`)
- **Interfaces**: `PascalCase` with descriptive names (e.g., `GenerateRequest`)

### Imports

```typescript
// External packages
import express from 'express';
import { z } from 'zod';

// Internal modules (use @ alias)
import { AppConfig } from '@/config';
import { logger } from '@/utils/logger';
```

## Questions?

Feel free to open an issue for any questions about contributing!

## Adding a provider

A provider is an outbound adapter to one image service. The rule that keeps this codebase
maintainable is that providers know nothing about protocols or adapters. A provider
receives a canonical request and returns a canonical result.

1. Implement ImageProvider from src/providers/provider.interface.ts.
2. Declare an accurate CapabilityDescriptor. Accuracy matters more than optimism: an
   over-claiming descriptor produces requests the provider cannot honour, whereas an
   under-claiming one only makes the matcher avoid it.
3. Throw ProviderError on failure with the upstream status preserved, so the engine can
   classify retryability. A bare Error is treated as retryable and loses that detail.
4. Register it in ProviderRegistry.fromConfig.
5. Add unit tests under tests/unit/providers/ that stub fetch and assert both the outgoing
   payload and the error classification.

## Changing the inbound adapter

There is one adapter (`src/adapters/chat/`). It validates the wire body and translates it
into the canonical model. It contains no business logic and must never import a provider.

Two rules are not negotiable:

- **Return the one error envelope.** Route errors through `toChatError`, and add an
  integration test asserting the envelope for both a validation failure and an auth
  failure. A client must never be handed a shape it cannot parse.
- **Do not silently degrade.** If you cannot honour something (a requested response
  format, a requested size), either implement it or fail with an error that names it.
  Never return a successful response whose shape differs from what was requested.

## Response-shape tests

There is one response shape, so there is one place to assert it:
`tests/unit/utils/formatAdapters.test.ts` pins the exact bytes emitted, including the
strictness rule that a requested base64 payload is never substituted with a URL.

When you change the response shape, update that suite. A shape asserted only in the route
tests can drift without any test noticing.

## Before opening a pull request

Run the full gate:

    npm run verify

That runs typecheck, lint and the test suite. Then, if your change touches a response
shape:

    npm run test:coverage   # must meet the engine and provider thresholds

For a change to the request path, start the server and exercise both endpoints by hand:

    npm run dev
    curl -X POST localhost:3000/chat -H 'Content-Type: application/json' \
      -d '{"prompt":"a red apple"}'

## Coding standards

- TypeScript strict mode. Avoid `any`; if it is unavoidable, keep it local and comment on
  why.
- Comments explain why, not what. A comment restating the code is noise; one explaining a
  non-obvious decision or a constraint is valuable.
- No silent fallbacks. If a value cannot be produced, fail with an error naming it rather
  than substituting something else.
- Every bug fix gets a regression test that fails without the fix.
