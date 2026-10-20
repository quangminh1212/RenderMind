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
   pnpm install
   ```
4. **Create** a feature branch:
   ```bash
   git checkout -b feature/my-new-feature
   ```

## Development Setup

### Prerequisites

- Node.js >= 20.0.0
- pnpm >= 10.0.0
- Redis (optional, for cache features)

### Environment Variables

```bash
cp .env.example .env
# Edit .env with your configuration
```

### Running Locally

```bash
# Start development server with hot reload
pnpm run dev

# Run tests
pnpm test

# Run linter
pnpm run lint

# Type check
pnpm run typecheck
```

## Project Structure

```
src/
├── adapters/          # Inbound protocol translation
│   └── chat/          # /chat and /vision wire format → canonical request
├── config/            # Configuration and environment validation
├── engine/            # Canonical core
│   ├── capability.matcher   # Provider selection and request adaptation
│   ├── generation.service   # Plan-driven dispatch, concurrency, failover
│   └── errors               # Typed error hierarchy
├── middleware/         # Express middleware (auth, errors, rate limiting, etc.)
├── platform/          # Infrastructure: artifact store, HTTP resilience, metrics
├── providers/         # Outbound adapters: talk to the chat model
│   ├── chat.provider        # Instructs a model to answer with an image
│   ├── prompt.builder       # Folds intent into instruction text
│   └── provider.interface   # ImageProvider contract
├── routes/            # Health and readiness endpoints
├── services/          # Platform services (cache)
├── types/             # TypeScript type definitions
└── utils/             # Utility functions
```

The dependency direction is one-way: **adapters → engine → providers**. Adapters never
import providers, and providers never import adapters.

## Making Changes

### Branch Naming

- `feature/description` — New features
- `fix/description` — Bug fixes
- `docs/description` — Documentation changes
- `refactor/description` — Code refactoring

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new provider class for XYZ
fix: resolve cache invalidation issue
docs: update API documentation
refactor: simplify provider selection logic
test: add unit tests for cache service
chore: update dependencies
```

### Adding a Provider

A provider is an outbound adapter to one image service. Providers know nothing about
protocols or adapters: they receive a canonical request and return a canonical result.

1. Implement `ImageProvider` from `src/providers/provider.interface.ts`.
2. Declare an accurate `CapabilityDescriptor`. Accuracy matters more than optimism: an
   over-claiming descriptor produces requests the provider cannot honour, whereas an
   under-claiming one only makes the matcher avoid it.
3. Throw `ProviderError` on failure with the upstream status preserved, so the engine can
   classify retryability. A bare `Error` is treated as retryable and loses that detail.
4. Register it in `ProviderRegistry.fromConfig`.
5. Add unit tests under `tests/unit/providers/` that stub fetch and assert both the outgoing
   payload and the error classification.

## Testing

### Running Tests

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm run test:watch

# Run with coverage
pnpm run test:coverage
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
   pnpm run typecheck
   pnpm run lint
   pnpm test
   ```
4. **Push** your branch and create a Pull Request
5. **Fill** out the PR template completely
6. **Request** a review from maintainers

### PR Guidelines

- Keep PRs focused on a single change
- Write clear, descriptive titles
- Reference related issues
- Keep commits atomic and well-described

## Coding Standards

### TypeScript

- Use strict TypeScript (`strict: true`)
- Prefer interfaces over types for object shapes
- Export types alongside implementations
- Use `readonly` for immutable properties

### Naming Conventions

- **Files**: `kebab-case.ts` (e.g., `chat.provider.ts`)
- **Classes**: `PascalCase` (e.g., `ChatProvider`)
- **Functions**: `camelCase` (e.g., `buildImageInstruction`)
- **Constants**: `UPPER_SNAKE_CASE` (e.g., `MAX_INLINE_BYTES`)
- **Interfaces**: `PascalCase` with descriptive names (e.g., `ChatResponse`)

## Coding standards

- TypeScript strict mode. Avoid `any`; if it is unavoidable, keep it local and comment on
  why.
- Comments explain why, not what. A comment restating the code is noise; one explaining a
  non-obvious decision or a constraint is valuable.
- No silent fallbacks. If a value cannot be produced, fail with an error naming it rather
  than substituting something else.
- Every bug fix gets a regression test that fails without the fix.
