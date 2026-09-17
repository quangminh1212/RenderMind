import { Router } from 'express';
import generateRoutes from './v1/generate';
import batchRoutes from './v1/batch';
import statusRoutes from './v1/status';
import backendsRoutes from './v1/backends';
import healthRoutes from './health';

const router = Router();

// Health check
router.use('/health', healthRoutes);

// API v1
router.use('/api/v1/generate', generateRoutes);
router.use('/api/v1/batch', batchRoutes);
router.use('/api/v1/status', statusRoutes);
router.use('/api/v1/backends', backendsRoutes);

export default router;
