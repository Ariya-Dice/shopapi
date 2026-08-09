import type { Request, Response } from 'express';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { zibalRequest, zibalStartUrl } from '../services/zibal.js';
import {
  clientErrorMessage,
  normalizeOrderItems,
  validateCustomer,
} from '../services/orderValidation.js';
import type { DbProduct, RequestPaymentBody } from '../types/payment.js';

function jsonError(res: Response, code: string, status: number): void {
  console.error('[PAYMENT_REQUEST] Sending error response', {
    code,
    status,
  });

  res.status(status).json({
    error: clientErrorMessage(code),
  });
}

function logSupabaseError(
  stage: string,
  error: {
    message?: string;
    details?: string;
    hint?: string;
    code?: string;
  } | null | undefined,
): void {
  if (!error) {
    return;
  }

  console.error(`[PAYMENT_REQUEST] Supabase error at ${stage}`, {
    message: error.message,
    details: error.details,
    hint: error.hint,
    code: error.code,
  });
}

export async function requestPayment(
  req: Request,
  res: Response,
): Promise<void> {
  const requestStartedAt = Date.now();

  console.log('[PAYMENT_REQUEST] ========================================');
  console.log('[PAYMENT_REQUEST] Payment request started');
  console.log('[PAYMENT_REQUEST] Method:', req.method);
  console.log('[PAYMENT_REQUEST] Path:', req.originalUrl);
  console.log('[PAYMENT_REQUEST] IP:', req.ip);

  try {
    /*
     * ------------------------------------------------------------
     * 1. Validate environment
     * ------------------------------------------------------------
     */

    console.log('[PAYMENT_REQUEST] Checking environment configuration');

    const merchant = process.env.ZIBAL_MERCHANT;

    if (!merchant) {
      console.error(
        '[PAYMENT_REQUEST] Configuration error: ZIBAL_MERCHANT is not configured',
      );

      throw new Error('config_error');
    }

    const backendUrl = process.env.BACKEND_URL;

    if (!backendUrl) {
      console.error(
        '[PAYMENT_REQUEST] Configuration error: BACKEND_URL is not configured',
      );

      throw new Error('config_error');
    }

    const normalizedBackendUrl = backendUrl.replace(/\/+$/, '');
    const callbackUrl = `${normalizedBackendUrl}/api/payment/verify`;

    console.log('[PAYMENT_REQUEST] Environment configuration is valid');
    console.log('[PAYMENT_REQUEST] Callback URL:', callbackUrl);

    /*
     * ------------------------------------------------------------
     * 2. Read and validate request body
     * ------------------------------------------------------------
     */

    console.log('[PAYMENT_REQUEST] Validating request body');

    console.log('[PAYMENT_REQUEST] Request received');

    const body = req.body as RequestPaymentBody & {
      customerDetails?: RequestPaymentBody['customer'];
    };

    if (!body) {
      console.error('[PAYMENT_REQUEST] Request body is missing');

      jsonError(res, 'invalid_order', 400);
      return;
    }

    const customerInput =
      body.customer ?? body.customerDetails;

    let customerDetails;

    try {
      customerDetails = validateCustomer(customerInput);
    } catch (validationError) {
      console.error('[PAYMENT_REQUEST] Validation failed', {
        step: 'customer',
        code:
          validationError instanceof Error
            ? validationError.message
            : 'invalid_customer',
      });

      throw validationError;
    }

    console.log('[PAYMENT_REQUEST] Customer validated');

    let lineItems;

    try {
      lineItems = normalizeOrderItems(body.items);
    } catch (validationError) {
      console.error('[PAYMENT_REQUEST] Validation failed', {
        step: 'items',
        code:
          validationError instanceof Error
            ? validationError.message
            : 'invalid_items',
      });

      throw validationError;
    }

    console.log('[PAYMENT_REQUEST] Items validated', {
      itemCount: lineItems.length,
      items: lineItems.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
      })),
    });

    /*
     * ------------------------------------------------------------
     * 3. Initialize Supabase
     * ------------------------------------------------------------
     */

    console.log('[PAYMENT_REQUEST] Initializing Supabase admin client');

    const supabase = getSupabaseAdmin();

    console.log('[PAYMENT_REQUEST] Supabase admin client initialized');

    /*
     * ------------------------------------------------------------
     * 4. Fetch products
     * ------------------------------------------------------------
     */

    const productIds = lineItems.map((item) => item.productId);

    console.log('[PAYMENT_REQUEST] Fetching products', {
      productIds,
    });

    const {
      data: products,
      error: productsError,
    } = await supabase
      .from('products')
      .select('id, model, goods_type, type, color, price, stock')
      .in('id', productIds);

    if (productsError) {
      console.error('[PAYMENT_REQUEST] Product query failed');
      logSupabaseError('products fetch', productsError);

      jsonError(res, 'product_not_found', 400);
      return;
    }

    if (!products || products.length === 0) {
      console.error('[PAYMENT_REQUEST] No products found', {
        productIds,
      });

      jsonError(res, 'product_not_found', 400);
      return;
    }

    console.log('[PAYMENT_REQUEST] Products loaded', {
      count: products.length,
    });

    /*
     * ------------------------------------------------------------
     * 5. Build product map
     * ------------------------------------------------------------
     */

    const productMap = new Map<number, DbProduct>();

    for (const product of products as DbProduct[]) {
      productMap.set(Number(product.id), product);
    }

    console.log('[PAYMENT_REQUEST] Product map created', {
      count: productMap.size,
    });

    /*
     * ------------------------------------------------------------
     * 6. Validate stock and calculate total
     * ------------------------------------------------------------
     */

    let totalAmount = 0;

    const orderItemsPayload: Array<{
      product_id: number;
      product_model: string;
      product_goods_type: string;
      product_color: string;
      quantity: number;
      unit_price: number;
    }> = [];

    console.log('[PAYMENT_REQUEST] Validating order items');

    for (const line of lineItems) {
      const product = productMap.get(line.productId);

      if (!product) {
        console.error('[PAYMENT_REQUEST] Product not found', {
          productId: line.productId,
        });

        jsonError(res, 'product_not_found', 400);
        return;
      }

      const unitPrice = Number(product.price ?? 0);
      const stock = Number(product.stock ?? 0);

      console.log('[PAYMENT_REQUEST] Product validation', {
        productId: line.productId,
        quantity: line.quantity,
        unitPrice,
        stock,
      });

      if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
        console.error('[PAYMENT_REQUEST] Invalid product price', {
          productId: line.productId,
          price: product.price,
        });

        jsonError(res, 'invalid_order', 400);
        return;
      }

      if (stock < line.quantity) {
        console.error('[PAYMENT_REQUEST] Insufficient stock', {
          productId: line.productId,
          requested: line.quantity,
          available: stock,
        });

        jsonError(res, 'insufficient_stock', 400);
        return;
      }

      totalAmount += unitPrice * line.quantity;

      orderItemsPayload.push({
        product_id: line.productId,
        product_model: String(product.model ?? ''),
        product_goods_type: String(
          product.goods_type || product.type || '',
        ),
        product_color: String(product.color ?? ''),
        quantity: line.quantity,
        unit_price: unitPrice,
      });
    }

    console.log('[PAYMENT_REQUEST] Total calculated', {
      totalAmount,
      itemCount: orderItemsPayload.length,
    });

    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
      console.error('[PAYMENT_REQUEST] Invalid calculated order total', {
        totalAmount,
      });

      jsonError(res, 'invalid_items', 400);
      return;
    }

    /*
     * ------------------------------------------------------------
     * 7. Insert order
     * ------------------------------------------------------------
     *
     * IMPORTANT:
     * The current database schema does NOT contain order_number.
     * Therefore we only select the existing id column.
     * ------------------------------------------------------------
     */

    console.log('[PAYMENT_REQUEST] Creating order in database');

    const {
      data: order,
      error: orderError,
    } = await supabase
      .from('orders')
      .insert({
        customer_name: customerDetails.name,
        customer_phone: customerDetails.phone,
        customer_email: customerDetails.email ?? '',
        customer_address: customerDetails.address,
        customer_note: customerDetails.note ?? '',
        total_amount: totalAmount,
        status: 'pending',
      })
      .select('id')
      .single();

    if (orderError) {
      console.error('[PAYMENT_REQUEST] Order insert failed');
      logSupabaseError('order insert', orderError);

      jsonError(res, 'invalid_order', 500);
      return;
    }

    if (!order) {
      console.error(
        '[PAYMENT_REQUEST] Order creation returned no order data',
      );

      jsonError(res, 'invalid_order', 500);
      return;
    }

    console.log('[PAYMENT_REQUEST] Order created', {
      orderId: order.id,
      totalAmount,
    });

    /*
     * ------------------------------------------------------------
     * 8. Insert order items
     * ------------------------------------------------------------
     */

    const orderItems = orderItemsPayload.map((item) => ({
      order_id: order.id,
      ...item,
    }));

    console.log('[PAYMENT_REQUEST] Creating order items', {
      orderId: order.id,
      itemCount: orderItems.length,
    });

    const {
      error: itemsError,
    } = await supabase
      .from('order_items')
      .insert(orderItems);

    if (itemsError) {
      console.error('[PAYMENT_REQUEST] Order items insert failed');
      logSupabaseError('order_items insert', itemsError);

      console.error(
        '[PAYMENT_REQUEST] Order items creation failed',
        {
          orderId: order.id,
        },
      );

      console.log(
        '[PAYMENT_REQUEST] Attempting to delete incomplete order',
        {
          orderId: order.id,
        },
      );

      const {
        error: deleteOrderError,
      } = await supabase
        .from('orders')
        .delete()
        .eq('id', order.id);

      if (deleteOrderError) {
        logSupabaseError(
          'rollback order after order_items failure',
          deleteOrderError,
        );
      } else {
        console.log(
          '[PAYMENT_REQUEST] Incomplete order successfully rolled back',
          {
            orderId: order.id,
          },
        );
      }

      jsonError(res, 'invalid_order', 500);
      return;
    }

    console.log('[PAYMENT_REQUEST] Order items created', {
      orderId: order.id,
      itemCount: orderItems.length,
    });

    /*
     * ------------------------------------------------------------
     * 9. Calculate Zibal amount
     * ------------------------------------------------------------
     *
     * The database stores the product price in the current
     * application unit. Zibal expects Rials.
     * ------------------------------------------------------------
     */

    const amountRials = Math.round(totalAmount * 10);

    console.log('[PAYMENT_REQUEST] Payment amount calculated', {
      orderId: order.id,
      totalAmount,
      amountRials,
    });

    /*
     * ------------------------------------------------------------
     * 10. Create Zibal payment request
     * ------------------------------------------------------------
     */

    console.log('[PAYMENT_REQUEST] Calling Zibal', {
      orderId: order.id,
      amountRials,
      callbackUrl,
    });

    let zibal;

    try {
      zibal = await zibalRequest({
        merchant,
        amount: amountRials,
        callbackUrl,
        description: `Order ${order.id}`,
        orderId: order.id,
        mobile: customerDetails.phone,
      });
    } catch (zibalError) {
      console.error('[PAYMENT_REQUEST] Zibal request failed', {
        orderId: order.id,
        error:
          zibalError instanceof Error
            ? zibalError.message
            : zibalError,
      });

      console.log(
        '[PAYMENT_REQUEST] Marking order as failed because Zibal request failed',
        {
          orderId: order.id,
        },
      );

      const {
        error: updateError,
      } = await supabase
        .from('orders')
        .update({
          status: 'failed',
        })
        .eq('id', order.id);

      if (updateError) {
        logSupabaseError(
          'mark order failed after Zibal exception',
          updateError,
        );
      }

      res.status(502).json({
        error: 'Payment gateway request failed. Please try again.',
      });

      return;
    }

    console.log('[PAYMENT_REQUEST] Zibal response received', {
      orderId: order.id,
      result: zibal.result,
      trackId: zibal.trackId ?? null,
      message: zibal.message ?? null,
    });

    /*
     * ------------------------------------------------------------
     * 11. Validate Zibal response
     * ------------------------------------------------------------
     */

    if (zibal.result !== 100 || !zibal.trackId) {
      console.error('[PAYMENT_REQUEST] Zibal payment creation failed', {
        orderId: order.id,
        result: zibal.result,
        trackId: zibal.trackId ?? null,
        message: zibal.message ?? null,
      });

      const {
        error: updateError,
      } = await supabase
        .from('orders')
        .update({
          status: 'failed',
        })
        .eq('id', order.id);

      if (updateError) {
        logSupabaseError(
          'mark order failed after Zibal failure',
          updateError,
        );
      }

      res.status(502).json({
        error: 'Failed to create payment transaction. Please try again.',
      });

      return;
    }

    console.log('[PAYMENT_REQUEST] Zibal payment created successfully', {
      orderId: order.id,
      trackId: zibal.trackId,
    });

    /*
     * ------------------------------------------------------------
     * 12. Save Zibal track ID
     * ------------------------------------------------------------
     */

    console.log('[PAYMENT_REQUEST] Saving Zibal track ID', {
      orderId: order.id,
      trackId: zibal.trackId,
    });

    const {
      error: trackUpdateError,
    } = await supabase
      .from('orders')
      .update({
        zibal_track_id: zibal.trackId,
      })
      .eq('id', order.id);

    if (trackUpdateError) {
      console.error('[PAYMENT_REQUEST] Failed to update Zibal track ID');
      logSupabaseError(
        'save Zibal track ID',
        trackUpdateError,
      );

      console.error(
        '[PAYMENT_REQUEST] Track ID update context',
        {
          orderId: order.id,
          trackId: zibal.trackId,
        },
      );

      res.status(500).json({
        error: 'Failed to save payment transaction. Please try again.',
      });

      return;
    }

    console.log(
      '[PAYMENT_REQUEST] Zibal track ID saved successfully',
      {
        orderId: order.id,
        trackId: zibal.trackId,
      },
    );

    /*
     * ------------------------------------------------------------
     * 13. Build payment URL
     * ------------------------------------------------------------
     */

    const paymentUrl = zibalStartUrl(zibal.trackId);

    console.log('[PAYMENT_REQUEST] Payment URL generated', {
      orderId: order.id,
      trackId: zibal.trackId,
    });

    /*
     * ------------------------------------------------------------
     * 14. Send successful response
     * ------------------------------------------------------------
     */

    const durationMs = Date.now() - requestStartedAt;

    console.log('[PAYMENT_REQUEST] Payment request completed', {
      orderId: order.id,
      trackId: zibal.trackId,
      totalAmount,
      amountRials,
      durationMs,
    });

    console.log('[PAYMENT_REQUEST] ========================================');

    res.status(200).json({
      orderId: order.id,

      // There is no order_number column in the current database.
      // Use the UUID order ID as the order reference.
      orderNumber: order.id,

      trackId: zibal.trackId,
      paymentUrl,
    });
  } catch (err) {
    const durationMs = Date.now() - requestStartedAt;

    const errorMessage =
      err instanceof Error
        ? err.message
        : 'Unknown error';

    const errorStack =
      err instanceof Error
        ? err.stack
        : undefined;

    console.error('[PAYMENT_REQUEST] Unexpected error', {
      message: errorMessage,
      stack: errorStack,
      durationMs,
    });

    const code =
      err instanceof Error
        ? err.message
        : 'invalid_order';

    const status =
      code.startsWith('invalid_') ||
      code === 'insufficient_stock' ||
      code === 'product_not_found'
        ? 400
        : 500;

    console.error('[PAYMENT_REQUEST] Returning error response', {
      code,
      status,
    });

    jsonError(res, code, status);

    console.log('[PAYMENT_REQUEST] ========================================');
  }
}