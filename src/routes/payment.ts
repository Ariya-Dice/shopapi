import { Router } from 'express';

import { requestPayment } from '../controllers/requestPayment.js';
import { verifyPayment } from '../controllers/verifyPayment.js';
import { requestBulkPayment } from '../controllers/bulkPayment.js';

const router = Router();

/*
 * Normal website payment
 */
router.post(
  '/request',
  requestPayment,
);

/*
 * Bulk-order payment proxy
 *
 * Supabase Edge Function
 *        ↓
 * VPS
 *        ↓
 * Zibal
 */
router.post(
  '/bulk-request',
  requestBulkPayment,
);

/*
 * Normal payment verification
 */
router.post(
  '/verify',
  verifyPayment,
);

router.get(
  '/verify',
  verifyPayment,
);

export default router;