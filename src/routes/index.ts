import { Router } from 'express';
import generateRoutes from '../routes/v1/generate';
import batchRoutes from '../routes/v1/batch';
import statusRoutes from '../routes/v1/status';
import backendsRoutes from '../routes/v1/backends';
import healthRoutes from '../routes/health';
import openaiImagesRoutes from '../adapters/openai/images.router';
import openaiModelsRoutes from '../adapters/openai/models.router';
import anthropicMessagesRoutes from '../adapters/anthropic/messages.router';

const router = Router();

// ─── Health & readiness ─────────────────────────────────────
// Mounted twice so both spellings resolve: the router defines /healthz and /readyz
// itself, and the bare /health alias lives at its own mount point.
router.use('/health', healthRoutes);
router.use(healthRoutes);

// ─── RenderMind native API ──────────────────────────────────
router.use('/api/v1/generate', generateRoutes);
router.use('/api/v1/batch', batchRoutes);
router.use('/api/v1/status', statusRoutes);
router.use('/api/v1/backends', backendsRoutes);

// ─── Protocol compatibility bridges ─────────────────────────
// openclaw-compatible clients: POST /v1/images/generations, GET /v1/models.
// These paths are prefixed so the mount points line up exactly with the real API.
router.use('/v1/images/generations', openaiImagesRoutes);
router.use('/v1/models', openaiModelsRoutes);

// Anthropic Claude clients: POST /v1/messages (+ count_tokens).
router.use('/v1/messages', anthropicMessagesRoutes);

export default router;
