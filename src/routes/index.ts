import { Router } from 'express';
import healthRoutes from '../routes/health';
import chatRoutes from '../adapters/chat/chat.router';

/**
 * The public surface.
 *
 * RenderMind has exactly two image endpoints, both mounted here at the root:
 *
 *   POST /chat    — a text prompt becomes an image
 *   POST /vision  — a text prompt plus input images becomes an image
 *
 * The earlier build exposed four additional surfaces (`/v1/images/generations`,
 * `/v1/messages`, and the `/api/v1/*` family) because it proxied to native image
 * providers. Those providers are gone: the engine now drives chat-completions models
 * only, so those bridges had nothing left to translate to. Keeping them would have
 * advertised compatibility the engine can no longer honour.
 */
const router = Router();

// ─── Health & readiness ─────────────────────────────────────
// Mounted twice so both spellings resolve: the router defines /healthz and /readyz
// itself, and the bare /health alias lives at its own mount point.
router.use('/health', healthRoutes);
router.use(healthRoutes);

// ─── Image generation ───────────────────────────────────────
router.use(chatRoutes);

export default router;
