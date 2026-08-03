import { Router } from 'express';
import { requestPayment } from '../controllers/requestPayment.js';
import { verifyPayment } from '../controllers/verifyPayment.js';

const router = Router();

router.post('/request', requestPayment);
router.post('/verify', verifyPayment);
router.get('/verify', verifyPayment);

export default router;
