import type { Request, Response } from 'express';

import { getSupabaseAdmin } from '../lib/supabase.js';
import { zibalRequest, zibalStartUrl } from '../services/zibal.js';

import {
  clientErrorMessage,
  normalizeOrderItems,
  validateCustomer,
} from '../services/orderValidation.js';

import type {
  DbProduct,
  RequestPaymentBody,
} from '../types/payment.js';

/*
|--------------------------------------------------------------------------
| Helper: JSON error response
|--------------------------------------------------------------------------
*/

function jsonError(
  res: Response,
  code: string,
  status: number,
): void {
  console.error('[PAYMENT_REQUEST] Sending error response', {
    code,
    status,
    message: clientErrorMessage(code),
  });

  if (res.headersSent) {
    console.error(
      '[PAYMENT_REQUEST] WARNING: headers already sent',
    );

    return;
  }

  res.status(status).json({
    error: clientErrorMessage(code),
  });
}

/*
|--------------------------------------------------------------------------
| Helper: Supabase error logger
|--------------------------------------------------------------------------
*/

function logSupabaseError(
  stage: string,
  error:
    | {
        message?: string;
        details?: string;
        hint?: string;
        code?: string;
      }
    | null
    | undefined,
): void {
  if (!error) {
    return;
  }

  console.error(
    `[PAYMENT_REQUEST] Supabase error at ${stage}`,
    {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
    },
  );
}

/*
|--------------------------------------------------------------------------
| Helper: Error code extraction
|--------------------------------------------------------------------------
*/

function getErrorCode(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'invalid_order';
}

/*
|--------------------------------------------------------------------------
| Main payment request controller
|--------------------------------------------------------------------------
*/

export async function requestPayment(
  req: Request,
  res: Response,
): Promise<void> {
  const requestStartedAt = Date.now();

  console.log('');
  console.log(
    '[PAYMENT_REQUEST] ========================================',
  );
  console.log(
    '[PAYMENT_REQUEST] Payment request started',
  );

  try {
    /*
    |--------------------------------------------------------------------------
    | 1. Request information
    |--------------------------------------------------------------------------
    */

    console.log('[PAYMENT_REQUEST] Request information', {
      method: req.method,
      path: req.originalUrl,
      ip: req.ip,
      contentType: req.headers['content-type'],
      contentLength: req.headers['content-length'],
      origin: req.headers.origin ?? null,
    });

    /*
    |--------------------------------------------------------------------------
    | 2. Environment configuration
    |--------------------------------------------------------------------------
    */

    console.log(
      '[PAYMENT_REQUEST] Step 1: Checking environment configuration',
    );

    const merchant = process.env.ZIBAL_MERCHANT;

    if (!merchant) {
      console.error(
        '[PAYMENT_REQUEST] ZIBAL_MERCHANT is missing',
      );

      throw new Error('config_error');
    }

    const backendUrl = process.env.BACKEND_URL;

    if (!backendUrl) {
      console.error(
        '[PAYMENT_REQUEST] BACKEND_URL is missing',
      );

      throw new Error('config_error');
    }

    const normalizedBackendUrl =
      backendUrl.replace(/\/+$/, '');

    const callbackUrl =
      `${normalizedBackendUrl}/api/payment/verify`;

    console.log(
      '[PAYMENT_REQUEST] Environment configuration is valid',
    );

    console.log(
      '[PAYMENT_REQUEST] Backend URL:',
      normalizedBackendUrl,
    );

    console.log(
      '[PAYMENT_REQUEST] Callback URL:',
      callbackUrl,
    );

    /*
    |--------------------------------------------------------------------------
    | 3. Request body
    |--------------------------------------------------------------------------
    */

    console.log(
      '[PAYMENT_REQUEST] Step 2: Reading request body',
    );

    const body = req.body as
      | (RequestPaymentBody & {
          customerDetails?: RequestPaymentBody['customer'];
        })
      | undefined;

    if (!body || typeof body !== 'object') {
      console.error(
        '[PAYMENT_REQUEST] Request body is missing or invalid',
      );

      jsonError(
        res,
        'invalid_order',
        400,
      );

      return;
    }

    console.log(
      '[PAYMENT_REQUEST] Request body received',
      {
        bodyType: typeof body,
        keys: Object.keys(body),
        hasCustomer:
          Boolean(body.customer) ||
          Boolean(body.customerDetails),
        hasItems: Array.isArray(body.items),
        itemsCount:
          Array.isArray(body.items)
            ? body.items.length
            : 0,
      },
    );

    /*
    |--------------------------------------------------------------------------
    | 4. Customer validation
    |--------------------------------------------------------------------------
    */

    console.log(
      '[PAYMENT_REQUEST] Step 3: Validating customer',
    );

    /*
     * Support both:
     *
     * customer: {...}
     *
     * and the temporary legacy:
     *
     * customerDetails: {...}
     */

    const customerInput =
      body.customer ??
      body.customerDetails;

    if (!customerInput) {
      console.error(
        '[PAYMENT_REQUEST] Customer object not found',
        {
          availableKeys: Object.keys(body),
        },
      );

      jsonError(
        res,
        'invalid_customer',
        400,
      );

      return;
    }

    console.log(
      '[PAYMENT_REQUEST] Customer object detected',
      {
        keys: Object.keys(customerInput),
        hasName:
          typeof customerInput.name === 'string',
        hasPhone:
          typeof customerInput.phone === 'string',
        hasEmail:
          typeof customerInput.email === 'string',
        hasAddress:
          typeof customerInput.address === 'string',
        hasNote:
          typeof customerInput.note === 'string',
      },
    );

    let customerDetails;

    try {
      customerDetails =
        validateCustomer(customerInput);
    } catch (validationError) {
      const code =
        getErrorCode(validationError);

      console.error(
        '[PAYMENT_REQUEST] Customer validation failed',
        {
          code,
        },
      );

      jsonError(
        res,
        code,
        400,
      );

      return;
    }

    /*
     * Do NOT log the complete customer object.
     * It contains personal information.
     */

    console.log(
      '[PAYMENT_REQUEST] Customer validated successfully',
      {
        nameLength:
          customerDetails.name.length,

        phoneValid:
          /^09\d{9}$/.test(
            customerDetails.phone,
          ),

        emailProvided:
          Boolean(customerDetails.email),

        addressLength:
          customerDetails.address.length,

        noteProvided:
          Boolean(customerDetails.note),
      },
    );

    /*
    |--------------------------------------------------------------------------
    | 5. Order items validation
    |--------------------------------------------------------------------------
    */

    console.log(
      '[PAYMENT_REQUEST] Step 4: Validating order items',
    );

    if (!Array.isArray(body.items)) {
      console.error(
        '[PAYMENT_REQUEST] items is not an array',
        {
          receivedType:
            typeof body.items,
        },
      );

      jsonError(
        res,
        'invalid_items',
        400,
      );

      return;
    }

    console.log(
      '[PAYMENT_REQUEST] Raw items received',
      {
        count: body.items.length,
      },
    );

    let lineItems;

    try {
      lineItems =
        normalizeOrderItems(body.items);
    } catch (validationError) {
      const code =
        getErrorCode(validationError);

      console.error(
        '[PAYMENT_REQUEST] Items validation failed',
        {
          code,
        },
      );

      jsonError(
        res,
        code,
        400,
      );

      return;
    }

    console.log(
      '[PAYMENT_REQUEST] Items validated successfully',
      {
        itemCount: lineItems.length,
        items: lineItems.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
        })),
      },
    );

    /*
    |--------------------------------------------------------------------------
    | 6. Initialize Supabase
    |--------------------------------------------------------------------------
    */

    console.log(
      '[PAYMENT_REQUEST] Step 5: Initializing Supabase',
    );

    let supabase;

    try {
      supabase = getSupabaseAdmin();
    } catch (supabaseInitError) {
      console.error(
        '[PAYMENT_REQUEST] Supabase initialization failed',
        {
          message:
            supabaseInitError instanceof Error
              ? supabaseInitError.message
              : supabaseInitError,
        },
      );

      throw new Error(
        'supabase_config_error',
      );
    }

    console.log(
      '[PAYMENT_REQUEST] Supabase admin client initialized',
    );

    /*
    |--------------------------------------------------------------------------
    | 7. Fetch products
    |--------------------------------------------------------------------------
    */

    console.log(
      '[PAYMENT_REQUEST] Step 6: Fetching products',
    );

    const productIds =
      lineItems.map(
        (item) => item.productId,
      );

    console.log(
      '[PAYMENT_REQUEST] Product IDs',
      {
        productIds,
      },
    );

    const {
      data: products,
      error: productsError,
    } = await supabase
      .from('products')
      .select(
        'id, model, goods_type, type, color, price, stock',
      )
      .in('id', productIds);

    if (productsError) {
      logSupabaseError(
        'products fetch',
        productsError,
      );

      jsonError(
        res,
        'product_not_found',
        400,
      );

      return;
    }

    if (!products) {
      console.error(
        '[PAYMENT_REQUEST] Products query returned null',
      );

      jsonError(
        res,
        'product_not_found',
        400,
      );

      return;
    }

    console.log(
      '[PAYMENT_REQUEST] Products query completed',
      {
        requested:
          productIds.length,
        returned:
          products.length,
      },
    );

    if (
      products.length !==
      productIds.length
    ) {
      console.error(
        '[PAYMENT_REQUEST] Not all requested products were found',
        {
          requestedProductIds:
            productIds,
          returnedProductIds:
            products.map(
              (product) =>
                Number(product.id),
            ),
        },
      );

      jsonError(
        res,
        'product_not_found',
        400,
      );

      return;
    }

    /*
    |--------------------------------------------------------------------------
    | 8. Build product map
    |--------------------------------------------------------------------------
    */

    console.log(
      '[PAYMENT_REQUEST] Step 7: Building product map',
    );

    const productMap =
      new Map<number, DbProduct>();

    for (
      const product of
      products as DbProduct[]
    ) {
      productMap.set(
        Number(product.id),
        product,
      );
    }

    console.log(
      '[PAYMENT_REQUEST] Product map created',
      {
        count: productMap.size,
      },
    );

    /*
    |--------------------------------------------------------------------------
    | 9. Validate stock and calculate total
    |--------------------------------------------------------------------------
    */

    console.log(
      '[PAYMENT_REQUEST] Step 8: Validating stock and calculating total',
    );

    let totalAmount = 0;

    const orderItemsPayload:
      Array<{
        product_id: number;
        product_model: string;
        product_goods_type: string;
        product_color: string;
        quantity: number;
        unit_price: number;
      }> = [];

    for (
      const line of lineItems
    ) {
      const product =
        productMap.get(
          line.productId,
        );

      if (!product) {
        console.error(
          '[PAYMENT_REQUEST] Product missing from map',
          {
            productId:
              line.productId,
          },
        );

        jsonError(
          res,
          'product_not_found',
          400,
        );

        return;
      }

      const unitPrice =
        Number(product.price ?? 0);

      const stock =
        Number(product.stock ?? 0);

      console.log(
        '[PAYMENT_REQUEST] Product validation',
        {
          productId:
            line.productId,
          quantity:
            line.quantity,
          unitPrice,
          stock,
        },
      );

      if (
        !Number.isFinite(unitPrice) ||
        unitPrice <= 0
      ) {
        console.error(
          '[PAYMENT_REQUEST] Invalid product price',
          {
            productId:
              line.productId,
            price:
              product.price,
          },
        );

        jsonError(
          res,
          'invalid_order',
          400,
        );

        return;
      }

      if (
        !Number.isFinite(stock) ||
        stock < 0
      ) {
        console.error(
          '[PAYMENT_REQUEST] Invalid product stock',
          {
            productId:
              line.productId,
            stock:
              product.stock,
          },
        );

        jsonError(
          res,
          'invalid_order',
          400,
        );

        return;
      }

      if (
        stock < line.quantity
      ) {
        console.error(
          '[PAYMENT_REQUEST] Insufficient stock',
          {
            productId:
              line.productId,
            requested:
              line.quantity,
            available:
              stock,
          },
        );

        jsonError(
          res,
          'insufficient_stock',
          400,
        );

        return;
      }

      totalAmount +=
        unitPrice *
        line.quantity;

      orderItemsPayload.push({
        product_id:
          line.productId,

        product_model:
          String(
            product.model ?? '',
          ),

        product_goods_type:
          String(
            product.goods_type ??
              product.type ??
              '',
          ),

        product_color:
          String(
            product.color ?? '',
          ),

        quantity:
          line.quantity,

        unit_price:
          unitPrice,
      });
    }

    console.log(
      '[PAYMENT_REQUEST] Order total calculated',
      {
        totalAmount,
        itemCount:
          orderItemsPayload.length,
      },
    );

    if (
      !Number.isFinite(totalAmount) ||
      totalAmount <= 0
    ) {
      console.error(
        '[PAYMENT_REQUEST] Invalid order total',
        {
          totalAmount,
        },
      );

      jsonError(
        res,
        'invalid_order',
        400,
      );

      return;
    }

    /*
    |--------------------------------------------------------------------------
    | 10. Create order
    |--------------------------------------------------------------------------
    */

    console.log(
      '[PAYMENT_REQUEST] Step 9: Creating order',
    );

    const {
      data: order,
      error: orderError,
    } = await supabase
      .from('orders')
      .insert({
        customer_name:
          customerDetails.name,

        customer_phone:
          customerDetails.phone,

        customer_email:
          customerDetails.email ?? '',

        customer_address:
          customerDetails.address,

        customer_note:
          customerDetails.note ?? '',

        total_amount:
          totalAmount,

        status:
          'pending',
      })
      .select('id')
      .single();

    if (orderError) {
      logSupabaseError(
        'orders insert',
        orderError,
      );

      jsonError(
        res,
        'invalid_order',
        500,
      );

      return;
    }

    if (!order?.id) {
      console.error(
        '[PAYMENT_REQUEST] Order created but ID is missing',
      );

      jsonError(
        res,
        'invalid_order',
        500,
      );

      return;
    }

    const orderId =
      order.id;

    console.log(
      '[PAYMENT_REQUEST] Order created successfully',
      {
        orderId,
        totalAmount,
      },
    );

    /*
    |--------------------------------------------------------------------------
    | 11. Create order items
    |--------------------------------------------------------------------------
    */

    console.log(
      '[PAYMENT_REQUEST] Step 10: Creating order items',
    );

    const orderItems =
      orderItemsPayload.map(
        (item) => ({
          order_id:
            orderId,

          ...item,
        }),
      );

    console.log(
      '[PAYMENT_REQUEST] Order items payload prepared',
      {
        orderId,
        itemCount:
          orderItems.length,
        columns:
          Object.keys(
            orderItems[0] ?? {},
          ),
      },
    );

    const {
      error: itemsError,
    } = await supabase
      .from('order_items')
      .insert(orderItems);

    if (itemsError) {
      console.error(
        '[PAYMENT_REQUEST] order_items INSERT FAILED',
      );

      logSupabaseError(
        'order_items insert',
        itemsError,
      );

      /*
      |--------------------------------------------------------------------------
      | Rollback order
      |--------------------------------------------------------------------------
      */

      console.log(
        '[PAYMENT_REQUEST] Rolling back order',
        {
          orderId,
        },
      );

      const {
        error: rollbackError,
      } = await supabase
        .from('orders')
        .delete()
        .eq('id', orderId);

      if (rollbackError) {
        logSupabaseError(
          'order rollback',
          rollbackError,
        );
      } else {
        console.log(
          '[PAYMENT_REQUEST] Order rollback successful',
          {
            orderId,
          },
        );
      }

      jsonError(
        res,
        'invalid_order',
        500,
      );

      return;
    }

    console.log(
      '[PAYMENT_REQUEST] Order items created successfully',
      {
        orderId,
        itemCount:
          orderItems.length,
      },
    );

    /*
    |--------------------------------------------------------------------------
    | 12. Calculate Zibal amount
    |--------------------------------------------------------------------------
    */

    console.log(
      '[PAYMENT_REQUEST] Step 11: Calculating Zibal amount',
    );

    /*
     * Application/database price is assumed to be Toman.
     * Zibal expects Rial.
     */

    const amountRials =
      Math.round(
        totalAmount * 10,
      );

    console.log(
      '[PAYMENT_REQUEST] Zibal amount calculated',
      {
        orderId,
        totalAmount,
        amountRials,
      },
    );

    if (
      !Number.isFinite(
        amountRials,
      ) ||
      amountRials <= 0
    ) {
      console.error(
        '[PAYMENT_REQUEST] Invalid Zibal amount',
        {
          amountRials,
        },
      );

      await supabase
        .from('orders')
        .update({
          status:
            'failed',
        })
        .eq(
          'id',
          orderId,
        );

      jsonError(
        res,
        'invalid_order',
        500,
      );

      return;
    }

    /*
    |--------------------------------------------------------------------------
    | 13. Call Zibal
    |--------------------------------------------------------------------------
    */

    console.log(
      '[PAYMENT_REQUEST] Step 12: Calling Zibal',
      {
        orderId,
        amountRials,
        callbackUrl,
      },
    );

    let zibal;

    try {
      zibal =
        await zibalRequest({
          merchant,
          amount:
            amountRials,
          callbackUrl,
          description:
            `Order ${orderId}`,
          orderId,
          mobile:
            customerDetails.phone,
        });
    } catch (zibalError) {
      console.error(
        '[PAYMENT_REQUEST] Zibal request threw an exception',
        {
          orderId,
          message:
            zibalError instanceof Error
              ? zibalError.message
              : String(
                  zibalError,
                ),
        },
      );

      const {
        error: updateError,
      } = await supabase
        .from('orders')
        .update({
          status:
            'failed',
        })
        .eq(
          'id',
          orderId,
        );

      if (updateError) {
        logSupabaseError(
          'mark order failed after Zibal exception',
          updateError,
        );
      }

      res.status(502).json({
        error:
          'Payment gateway request failed. Please try again.',
      });

      return;
    }

    console.log(
      '[PAYMENT_REQUEST] Zibal response received',
      {
        orderId,
        result:
          zibal.result,
        trackId:
          zibal.trackId ??
          null,
        message:
          zibal.message ??
          null,
      },
    );

    /*
    |--------------------------------------------------------------------------
    | 14. Validate Zibal response
    |--------------------------------------------------------------------------
    */

    if (
      zibal.result !== 100 ||
      !zibal.trackId
    ) {
      console.error(
        '[PAYMENT_REQUEST] Zibal payment creation failed',
        {
          orderId,
          result:
            zibal.result,
          trackId:
            zibal.trackId ??
            null,
          message:
            zibal.message ??
            null,
        },
      );

      const {
        error: updateError,
      } = await supabase
        .from('orders')
        .update({
          status:
            'failed',
        })
        .eq(
          'id',
          orderId,
        );

      if (updateError) {
        logSupabaseError(
          'mark order failed after Zibal failure',
          updateError,
        );
      }

      res.status(502).json({
        error:
          'Failed to create payment transaction. Please try again.',
      });

      return;
    }

    console.log(
      '[PAYMENT_REQUEST] Zibal payment created successfully',
      {
        orderId,
        trackId:
          zibal.trackId,
      },
    );

    /*
    |--------------------------------------------------------------------------
    | 15. Save Zibal track ID
    |--------------------------------------------------------------------------
    */

    console.log(
      '[PAYMENT_REQUEST] Step 13: Saving Zibal track ID',
    );

    const {
      error:
        trackUpdateError,
    } = await supabase
      .from('orders')
      .update({
        zibal_track_id:
          zibal.trackId,
      })
      .eq(
        'id',
        orderId,
      );

    if (trackUpdateError) {
      logSupabaseError(
        'save Zibal track ID',
        trackUpdateError,
      );

      /*
      |--------------------------------------------------------------------------
      | Mark order as failed
      |--------------------------------------------------------------------------
      */

      await supabase
        .from('orders')
        .update({
          status:
            'failed',
        })
        .eq(
          'id',
          orderId,
        );

      res.status(500).json({
        error:
          'Failed to save payment transaction. Please try again.',
      });

      return;
    }

    console.log(
      '[PAYMENT_REQUEST] Zibal track ID saved',
      {
        orderId,
        trackId:
          zibal.trackId,
      },
    );

    /*
    |--------------------------------------------------------------------------
    | 16. Generate payment URL
    |--------------------------------------------------------------------------
    */

    console.log(
      '[PAYMENT_REQUEST] Step 14: Generating payment URL',
    );

    const paymentUrl =
      zibalStartUrl(
        zibal.trackId,
      );

    console.log(
      '[PAYMENT_REQUEST] Payment URL generated',
      {
        orderId,
        trackId:
          zibal.trackId,
      },
    );

    /*
    |--------------------------------------------------------------------------
    | 17. Successful response
    |--------------------------------------------------------------------------
    */

    const durationMs =
      Date.now() -
      requestStartedAt;

    console.log(
      '[PAYMENT_REQUEST] Payment request completed successfully',
      {
        orderId,
        trackId:
          zibal.trackId,
        totalAmount,
        amountRials,
        durationMs,
      },
    );

    console.log(
      '[PAYMENT_REQUEST] ========================================',
    );

    res.status(200).json({
      orderId,

      /*
       * Current orders table does NOT contain order_number.
       * Therefore order ID is used as order reference.
       */

      orderNumber:
        orderId,

      trackId:
        zibal.trackId,

      paymentUrl,
    });
  } catch (err) {
    /*
    |--------------------------------------------------------------------------
    | Global error handler for this controller
    |--------------------------------------------------------------------------
    */

    const durationMs =
      Date.now() -
      requestStartedAt;

    const errorMessage =
      err instanceof Error
        ? err.message
        : 'Unknown error';

    const errorStack =
      err instanceof Error
        ? err.stack
        : undefined;

    console.error(
      '[PAYMENT_REQUEST] ========================================',
    );

    console.error(
      '[PAYMENT_REQUEST] UNEXPECTED ERROR',
      {
        message:
          errorMessage,

        stack:
          errorStack,

        durationMs,
      },
    );

    const code =
      err instanceof Error
        ? err.message
        : 'invalid_order';

    /*
     * Validation errors -> 400
     * Product/stock errors -> 400
     * Configuration/server/database errors -> 500
     */

    const isClientError =
      code.startsWith('invalid_') ||
      code ===
        'insufficient_stock' ||
      code ===
        'product_not_found';

    const status =
      isClientError
        ? 400
        : 500;

    console.error(
      '[PAYMENT_REQUEST] Returning error response',
      {
        code,
        status,
        durationMs,
      },
    );

    jsonError(
      res,
      code,
      status,
    );

    console.error(
      '[PAYMENT_REQUEST] ========================================',
    );
  }
}