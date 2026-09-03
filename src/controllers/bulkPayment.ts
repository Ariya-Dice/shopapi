import type { Request, Response } from 'express';
import { zibalRequest, zibalStartUrl } from '../services/zibal.js';

interface BulkPaymentRequestBody {
  amount: number;
  callbackUrl: string;
  description?: string;
  orderId?: string;
  mobile?: string;
}

function getProxySecret(): string {
  const secret =
    process.env.BULK_ZIBAL_PROXY_SECRET?.trim();

  if (!secret) {
    throw new Error('config_error');
  }

  return secret;
}

export async function requestBulkPayment(
  req: Request,
  res: Response,
): Promise<void> {
  console.log('[BULK_PAYMENT] Request received', {
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
  });

  try {
    /*
     * ------------------------------------------------------------
     * 1. Authenticate Supabase -> VPS request
     * ------------------------------------------------------------
     */

    const configuredSecret =
      getProxySecret();

    const receivedSecret =
      req.headers['x-bulk-zibal-secret'];

    if (
      typeof receivedSecret !== 'string' ||
      receivedSecret !== configuredSecret
    ) {
      console.error(
        '[BULK_PAYMENT] Unauthorized proxy request',
      );

      res.status(401).json({
        error: 'Unauthorized',
      });

      return;
    }

    /*
     * ------------------------------------------------------------
     * 2. Read request body
     * ------------------------------------------------------------
     */

    const body =
      req.body as BulkPaymentRequestBody;

    if (
      !body ||
      typeof body !== 'object'
    ) {
      res.status(400).json({
        error: 'Invalid request body',
      });

      return;
    }

    const amount =
      Number(body.amount);

    const callbackUrl =
      typeof body.callbackUrl === 'string'
        ? body.callbackUrl.trim()
        : '';

    const description =
      typeof body.description === 'string'
        ? body.description.trim()
        : undefined;

    const orderId =
      typeof body.orderId === 'string'
        ? body.orderId.trim()
        : undefined;

    const mobile =
      typeof body.mobile === 'string'
        ? body.mobile.trim()
        : undefined;

    /*
     * ------------------------------------------------------------
     * 3. Validate payment data
     * ------------------------------------------------------------
     */

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      console.error(
        '[BULK_PAYMENT] Invalid amount',
        { amount },
      );

      res.status(400).json({
        error: 'Invalid amount',
      });

      return;
    }

    if (!callbackUrl) {
      console.error(
        '[BULK_PAYMENT] Missing callbackUrl',
      );

      res.status(400).json({
        error: 'Invalid callbackUrl',
      });

      return;
    }

    /*
     * Only HTTPS callbacks are accepted.
     */
    if (
      !callbackUrl.startsWith('https://')
    ) {
      console.error(
        '[BULK_PAYMENT] Callback URL must use HTTPS',
        { callbackUrl },
      );

      res.status(400).json({
        error: 'Invalid callbackUrl',
      });

      return;
    }

    /*
     * ------------------------------------------------------------
     * 4. Merchant stays on VPS
     * ------------------------------------------------------------
     */

    const merchant =
      process.env.ZIBAL_MERCHANT?.trim();

    if (!merchant) {
      console.error(
        '[BULK_PAYMENT] ZIBAL_MERCHANT is missing',
      );

      res.status(500).json({
        error: 'Payment gateway configuration error',
      });

      return;
    }

    /*
     * ------------------------------------------------------------
     * 5. Call Zibal
     *
     * IMPORTANT:
     *
     * This request now originates from the VPS.
     * Therefore Zibal sees the VPS fixed IP.
     * ------------------------------------------------------------
     */

    console.log(
      '[BULK_PAYMENT] Calling Zibal from VPS',
      {
        amount,
        callbackUrl,
        description: description ?? null,
        orderId: orderId ?? null,
        mobileProvided: Boolean(mobile),
      },
    );

    const zibal =
      await zibalRequest({
        merchant,
        amount,
        callbackUrl,
        description,
        orderId,
        mobile,
      });

    console.log(
      '[BULK_PAYMENT] Zibal response received',
      {
        result: zibal.result,
        trackId:
          zibal.trackId ?? null,
        message:
          zibal.message ?? null,
      },
    );

    /*
     * ------------------------------------------------------------
     * 6. Validate Zibal response
     * ------------------------------------------------------------
     */

    if (
      zibal.result !== 100 ||
      !zibal.trackId
    ) {
      console.error(
        '[BULK_PAYMENT] Zibal rejected payment request',
        {
          result: zibal.result,
          message:
            zibal.message ?? null,
          trackId:
            zibal.trackId ?? null,
        },
      );

      /*
       * Return Zibal's actual response so Supabase
       * can handle the error code properly.
       */
      res.status(502).json({
        result: zibal.result,
        message:
          zibal.message ?? null,
        trackId:
          zibal.trackId ?? null,
      });

      return;
    }

    /*
     * ------------------------------------------------------------
     * 7. Generate payment URL
     * ------------------------------------------------------------
     */

    const paymentUrl =
      zibalStartUrl(
        zibal.trackId,
      );

    console.log(
      '[BULK_PAYMENT] Bulk payment created successfully',
      {
        trackId:
          zibal.trackId,
      },
    );

    /*
     * ------------------------------------------------------------
     * 8. Return result to Supabase
     * ------------------------------------------------------------
     */

    res.status(200).json({
      result: zibal.result,
      message:
        zibal.message ?? null,
      trackId:
        zibal.trackId,
      paymentUrl,
    });
  } catch (error) {
    console.error(
      '[BULK_PAYMENT] Unexpected error',
      {
        message:
          error instanceof Error
            ? error.message
            : String(error),
        stack:
          error instanceof Error
            ? error.stack
            : undefined,
      },
    );

    res.status(500).json({
      error:
        'Payment gateway request failed.',
    });
  }
}