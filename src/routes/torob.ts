import { Router } from 'express';
import {
  handleTorobProducts,
  TorobAuthError,
  TorobValidationError,
} from '../services/torobProducts.js';

const router = Router();

router.post('/v3/products', async (req, res) => {
  try {
    const result = await handleTorobProducts(req);

    return res.status(200).json(result);
  } catch (error) {
    console.error('Torob products API error:', error);

    if (
      error instanceof TorobAuthError ||
      error instanceof TorobValidationError
    ) {
      return res.status(error.statusCode).json({
        error: error.message,
      });
    }

    return res.status(500).json({
      error: 'Internal server error',
    });
  }
});

export default router;