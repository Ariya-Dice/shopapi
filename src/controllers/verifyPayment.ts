import type { Request, Response } from 'express';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { zibalVerify } from '../services/zibal.js';

function frontendBase(): string {
  const url =
    process.env.FRONTEND_URL ??
    'http://localhost:5173';

  return url.replace(/\/+$/, '');
}

function redirect(
  res: Response,
  path: string,
): void {
  res.redirect(302, path);
}

function getVerifyParams(
  req: Request,
): {
  success?: string;
  trackId?: string;
  orderId?: string;
} {
  const fromQuery =
    req.query as Record<
      string,
      string | undefined
    >;

  const fromBody =
    (req.body ?? {}) as Record<
      string,
      string | undefined
    >;

  return {
    success:
      fromQuery.success ??
      fromBody.success,

    trackId:
      fromQuery.trackId ??
      fromBody.trackId,

    orderId:
      fromQuery.orderId ??
      fromBody.orderId,
  };
}

/**
 * Complete a paid order without PostgreSQL RPC.
 *
 * IMPORTANT:
 * There is currently no complete_order_payment()
 * PostgreSQL function in the database.
 *
 * Therefore all operations are performed through
 * the Supabase Admin API.
 *
 * Stock updates use an optimistic check:
 *
 *   WHERE id = productId AND stock = oldStock
 *
 * This prevents two simultaneous requests from both
 * decrementing the same stock value based on the
 * same original stock.
 */
async function completeOrderPayment(
  orderId: string,
  refNumber: string | null,
): Promise<
  | { ok: true; alreadyPaid: boolean }
  | { ok: false; reason: string }
> {
  const supabase = getSupabaseAdmin();

  /*
   * ------------------------------------------------------------
   * 1. Load current order
   * ------------------------------------------------------------
   */

  const {
    data: order,
    error: orderError,
  } = await supabase
    .from('orders')
    .select(
      'id, status, total_amount, zibal_track_id, zibal_ref_number, paid_at',
    )
    .eq('id', orderId)
    .maybeSingle();

  if (orderError) {
    console.error(
      'complete-order: failed to load order:',
      orderError.message,
    );

    return {
      ok: false,
      reason: 'order_load_failed',
    };
  }

  if (!order) {
    return {
      ok: false,
      reason: 'order_not_found',
    };
  }

  /*
   * ------------------------------------------------------------
   * 2. Idempotency
   * ------------------------------------------------------------
   *
   * If Zibal callback is sent more than once, don't decrement
   * stock again.
   * ------------------------------------------------------------
   */

  if (order.status === 'paid') {
    return {
      ok: true,
      alreadyPaid: true,
    };
  }

  /*
   * ------------------------------------------------------------
   * 3. Load order items
   * ------------------------------------------------------------
   */

  const {
    data: orderItems,
    error: orderItemsError,
  } = await supabase
    .from('order_items')
    .select(
      'product_id, quantity, unit_price',
    )
    .eq('order_id', orderId);

  if (orderItemsError) {
    console.error(
      'complete-order: failed to load order items:',
      orderItemsError.message,
    );

    return {
      ok: false,
      reason: 'order_items_load_failed',
    };
  }

  if (
    !orderItems ||
    orderItems.length === 0
  ) {
    console.error(
      'complete-order: order has no items:',
      orderId,
    );

    return {
      ok: false,
      reason: 'order_items_not_found',
    };
  }

  /*
   * ------------------------------------------------------------
   * 4. Load all products
   * ------------------------------------------------------------
   */

  const productIds = orderItems.map(
    (item) => Number(item.product_id),
  );

  const {
    data: products,
    error: productsError,
  } = await supabase
    .from('products')
    .select('id, stock')
    .in('id', productIds);

  if (productsError) {
    console.error(
      'complete-order: products load failed:',
      productsError.message,
    );

    return {
      ok: false,
      reason: 'products_load_failed',
    };
  }

  if (
    !products ||
    products.length !== productIds.length
  ) {
    console.error(
      'complete-order: one or more products not found:',
      orderId,
    );

    return {
      ok: false,
      reason: 'product_not_found',
    };
  }

  /*
   * ------------------------------------------------------------
   * 5. Build product map
   * ------------------------------------------------------------
   */

  const productMap = new Map<
    number,
    {
      id: number;
      stock: number;
    }
  >();

  for (const product of products) {
    productMap.set(
      Number(product.id),
      {
        id: Number(product.id),
        stock: Number(product.stock ?? 0),
      },
    );
  }

  /*
   * ------------------------------------------------------------
   * 6. Validate stock BEFORE changing anything
   * ------------------------------------------------------------
   */

  for (const item of orderItems) {
    const productId = Number(
      item.product_id,
    );

    const quantity = Number(
      item.quantity,
    );

    const product =
      productMap.get(productId);

    if (!product) {
      return {
        ok: false,
        reason: 'product_not_found',
      };
    }

    if (
      !Number.isInteger(quantity) ||
      quantity <= 0
    ) {
      console.error(
        'complete-order: invalid quantity:',
        orderId,
        productId,
        quantity,
      );

      return {
        ok: false,
        reason: 'invalid_quantity',
      };
    }

    if (product.stock < quantity) {
      console.error(
        'complete-order: insufficient stock:',
        {
          orderId,
          productId,
          stock: product.stock,
          requested: quantity,
        },
      );

      return {
        ok: false,
        reason: 'insufficient_stock',
      };
    }
  }

  /*
   * ------------------------------------------------------------
   * 7. Decrease stock
   * ------------------------------------------------------------
   *
   * We use:
   *
   *   UPDATE products
   *   SET stock = newStock
   *   WHERE id = productId
   *     AND stock = oldStock
   *
   * This protects against a concurrent stock modification.
   *
   * Because Supabase/PostgREST does not give us a database
   * transaction here, we keep track of every successful
   * update and attempt a rollback if a later update fails.
   * ------------------------------------------------------------
   */

  const updatedProducts: Array<{
    id: number;
    oldStock: number;
    newStock: number;
  }> = [];

  for (const item of orderItems) {
    const productId = Number(
      item.product_id,
    );

    const quantity = Number(
      item.quantity,
    );

    const product =
      productMap.get(productId);

    if (!product) {
      continue;
    }

    const oldStock = product.stock;
    const newStock =
      oldStock - quantity;

    const {
      data: updatedProduct,
      error: updateError,
    } = await supabase
      .from('products')
      .update({
        stock: newStock,
      })
      .eq('id', productId)
      .eq('stock', oldStock)
      .select('id, stock')
      .maybeSingle();

    if (
      updateError ||
      !updatedProduct
    ) {
      console.error(
        'complete-order: stock update failed:',
        {
          orderId,
          productId,
          error:
            updateError?.message,
        },
      );

      /*
       * Roll back all stock changes made by this
       * completion attempt.
       */
      for (
        const changed of updatedProducts.reverse()
      ) {
        const {
          error: rollbackError,
        } = await supabase
          .from('products')
          .update({
            stock: changed.oldStock,
          })
          .eq('id', changed.id)
          .eq('stock', changed.newStock);

        if (rollbackError) {
          console.error(
            'complete-order: STOCK ROLLBACK FAILED:',
            {
              orderId,
              productId: changed.id,
              error:
                rollbackError.message,
            },
          );
        }
      }

      return {
        ok: false,
        reason: 'stock_update_failed',
      };
    }

    updatedProducts.push({
      id: productId,
      oldStock,
      newStock,
    });
  }

  /*
   * ------------------------------------------------------------
   * 8. Mark order as paid
   * ------------------------------------------------------------
   */

  const {
    data: paidOrder,
    error: paidError,
  } = await supabase
    .from('orders')
    .update({
      status: 'paid',
      zibal_ref_number:
        refNumber,
      paid_at: new Date().toISOString(),
    })
    .eq('id', orderId)
    .eq('status', 'pending')
    .select('id, status')
    .maybeSingle();

  if (
    paidError ||
    !paidOrder
  ) {
    console.error(
      'complete-order: failed to mark order paid:',
      {
        orderId,
        error:
          paidError?.message,
      },
    );

    /*
     * Try to restore stock because payment state could not
     * be persisted.
     */
    for (
      const changed of updatedProducts.reverse()
    ) {
      const {
        error: rollbackError,
      } = await supabase
        .from('products')
        .update({
          stock: changed.oldStock,
        })
        .eq('id', changed.id)
        .eq('stock', changed.newStock);

      if (rollbackError) {
        console.error(
          'complete-order: STOCK ROLLBACK FAILED:',
          {
            orderId,
            productId: changed.id,
            error:
              rollbackError.message,
          },
        );
      }
    }

    return {
      ok: false,
      reason: 'order_update_failed',
    };
  }

  /*
   * ------------------------------------------------------------
   * 9. Success
   * ------------------------------------------------------------
   */

  return {
    ok: true,
    alreadyPaid: false,
  };
}

export async function verifyPayment(
  req: Request,
  res: Response,
): Promise<void> {
  const base = frontendBase();

  try {
    /*
     * ------------------------------------------------------------
     * 1. Read callback parameters
     * ------------------------------------------------------------
     */

    const {
      success,
      trackId: trackIdRaw,
      orderId: orderIdParam,
    } = getVerifyParams(req);

    if (!trackIdRaw) {
      redirect(
        res,
        `${base}/#/payment/failed?reason=missing_track_id`,
      );
      return;
    }

    const trackId = Number(
      trackIdRaw,
    );

    if (
      !Number.isFinite(trackId) ||
      trackId <= 0
    ) {
      redirect(
        res,
        `${base}/#/payment/failed?reason=invalid_track_id`,
      );
      return;
    }

    /*
     * ------------------------------------------------------------
     * 2. Zibal merchant
     * ------------------------------------------------------------
     */

    const merchant =
      process.env.ZIBAL_MERCHANT?.trim();

    if (!merchant) {
      console.error(
        'verify-payment: ZIBAL_MERCHANT not configured',
      );

      redirect(
        res,
        `${base}/#/payment/failed?reason=config`,
      );

      return;
    }

    const supabase =
      getSupabaseAdmin();

    /*
     * ------------------------------------------------------------
     * 3. Find order
     * ------------------------------------------------------------
     *
     * First try callback orderId.
     *
     * If not available, find it by Zibal track ID.
     * ------------------------------------------------------------
     */

    let order:
      | any
      | null = null;

    if (orderIdParam) {
      const {
        data,
        error,
      } = await supabase
        .from('orders')
        .select(
          'id, status, total_amount, zibal_track_id, zibal_ref_number, paid_at',
        )
        .eq(
          'id',
          orderIdParam,
        )
        .maybeSingle();

      if (error) {
        console.error(
          'verify-payment: order lookup by id failed:',
          error.message,
        );
      }

      order = data;
    }

    if (!order) {
      const {
        data,
        error,
      } = await supabase
        .from('orders')
        .select(
          'id, status, total_amount, zibal_track_id, zibal_ref_number, paid_at',
        )
        .eq(
          'zibal_track_id',
          trackId,
        )
        .maybeSingle();

      if (error) {
        console.error(
          'verify-payment: order lookup by trackId failed:',
          error.message,
        );
      }

      order = data;
    }

    if (!order) {
      redirect(
        res,
        `${base}/#/payment/failed?reason=order_not_found`,
      );

      return;
    }

    /*
     * ------------------------------------------------------------
     * 4. Frontend success query
     * ------------------------------------------------------------
     *
     * There is NO order_number column.
     *
     * order.id is the only order identifier available.
     * ------------------------------------------------------------
     */

    const successQuery =
      `orderId=${encodeURIComponent(order.id)}`;

    /*
     * ------------------------------------------------------------
     * 5. Idempotency
     * ------------------------------------------------------------
     */

    if (order.status === 'paid') {
      redirect(
        res,
        `${base}/#/payment/success?${successQuery}`,
      );

      return;
    }

    /*
     * ------------------------------------------------------------
     * 6. Check Zibal callback success
     * ------------------------------------------------------------
     */

    if (success !== '1') {
      if (
        order.status === 'pending'
      ) {
        await supabase
          .from('orders')
          .update({
            status: 'failed',
          })
          .eq(
            'id',
            order.id,
          );
      }

      redirect(
        res,
        `${base}/#/payment/failed?orderId=${encodeURIComponent(order.id)}`,
      );

      return;
    }

    /*
     * ------------------------------------------------------------
     * 7. Verify track ID
     * ------------------------------------------------------------
     */

    if (
      order.zibal_track_id != null &&
      Number(order.zibal_track_id) !==
        trackId
    ) {
      console.error(
        'verify-payment: trackId mismatch',
        order.id,
        order.zibal_track_id,
        trackId,
      );

      await supabase
        .from('orders')
        .update({
          status: 'failed',
        })
        .eq(
          'id',
          order.id,
        );

      redirect(
        res,
        `${base}/#/payment/failed?orderId=${encodeURIComponent(order.id)}&reason=track_mismatch`,
      );

      return;
    }

    /*
     * ------------------------------------------------------------
     * 8. Ask Zibal to verify payment
     * ------------------------------------------------------------
     */

    const verify =
      await zibalVerify({
        merchant,
        trackId,
      });

    if (verify.result !== 100) {
      console.error(
        'verify-payment: zibal verify failed',
        order.id,
        verify.result,
        verify.message,
      );

      await supabase
        .from('orders')
        .update({
          status: 'failed',
        })
        .eq(
          'id',
          order.id,
        );

      redirect(
        res,
        `${base}/#/payment/failed?orderId=${encodeURIComponent(order.id)}&code=${encodeURIComponent(String(verify.result))}`,
      );

      return;
    }

    /*
     * ------------------------------------------------------------
     * 9. Verify payment amount
     * ------------------------------------------------------------
     */

    const expectedRials =
      Math.round(
        Number(order.total_amount) * 10,
      );

    const paidRials =
      verify.amount != null
        ? Math.round(
            Number(verify.amount),
          )
        : null;

    if (
      paidRials != null &&
      paidRials !== expectedRials
    ) {
      console.error(
        'verify-payment: amount mismatch',
        {
          orderId: order.id,
          paidRials,
          expectedRials,
        },
      );

      await supabase
        .from('orders')
        .update({
          status: 'failed',
        })
        .eq(
          'id',
          order.id,
        );

      redirect(
        res,
        `${base}/#/payment/failed?orderId=${encodeURIComponent(order.id)}&reason=amount_mismatch`,
      );

      return;
    }

    /*
     * ------------------------------------------------------------
     * 10. Ref number
     * ------------------------------------------------------------
     */

    const refNumber =
      verify.refNumber != null
        ? String(
            verify.refNumber,
          )
        : null;

    /*
     * ------------------------------------------------------------
     * 11. Complete order
     *
     * IMPORTANT:
     *
     * We intentionally DO NOT call:
     *
     *   supabase.rpc('complete_order_payment')
     *
     * because that PostgreSQL function does not exist.
     * ------------------------------------------------------------
     */

    const completion =
      await completeOrderPayment(
        order.id,
        refNumber,
      );

    /*
     * ------------------------------------------------------------
     * 12. Completion failed
     * ------------------------------------------------------------
     */

    if (!completion.ok) {
      console.error(
        'verify-payment: order completion failed',
        {
          orderId: order.id,
          reason:
            completion.reason,
        },
      );

      if (
        completion.reason ===
        'insufficient_stock'
      ) {
        await supabase
          .from('orders')
          .update({
            status: 'failed',
          })
          .eq(
            'id',
            order.id,
          );

        redirect(
          res,
          `${base}/#/payment/failed?orderId=${encodeURIComponent(order.id)}&reason=stock`,
        );

        return;
      }

      redirect(
        res,
        `${base}/#/payment/failed?orderId=${encodeURIComponent(order.id)}&reason=server_error`,
      );

      return;
    }

    /*
     * ------------------------------------------------------------
     * 13. Already paid
     * ------------------------------------------------------------
     */

    if (
      completion.alreadyPaid
    ) {
      redirect(
        res,
        `${base}/#/payment/success?${successQuery}`,
      );

      return;
    }

    /*
     * ------------------------------------------------------------
     * 14. SUCCESS
     * ------------------------------------------------------------
     */

    redirect(
      res,
      `${base}/#/payment/success?${successQuery}`,
    );
  } catch (err) {
    console.error(
      'verify-payment error:',
      err instanceof Error
        ? err.message
        : err,
    );

    redirect(
      res,
      `${base}/#/payment/failed?reason=server_error`,
    );
  }
}