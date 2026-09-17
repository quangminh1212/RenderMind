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
