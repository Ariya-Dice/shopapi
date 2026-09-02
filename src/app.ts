import express from 'express';
import cors from 'cors';
import paymentRoutes from './routes/payment.js';
import torobRoutes from './routes/torob.js';
import { errorHandler } from './middleware/errorHandler.js';

const app = express();

app.use(
  cors({
    origin: [
      'https://www.rbshop.ir',
      'https://rbshop.ir',
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'authorization',
      'x-client-info',
      'apikey',
      'content-type',
      'X-Torob-Token',
      'X-Torob-Token-Version',
    ],
  }),
);

app.use(express.json());

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use('/api/payment', paymentRoutes);

app.use('/torob_api', torobRoutes);

app.use(errorHandler);

export default app;