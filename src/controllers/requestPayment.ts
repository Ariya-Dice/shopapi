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
  res.status(status).json({
    error: clientErrorMessage(code),
  });
}

export async function requestPayment(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    /*
     * ------------------------------------------------------------
     * 1. Zibal configuration
     * ------------------------------------------------------------
     */
    const merchant = process.env.ZIBAL_MERCHANT?.trim();

    if (!merchant) {
      console.error(
        'request-payment: ZIBAL_MERCHANT is not configured',
      );

      jsonError(res, 'config_error', 500);
      return;
    }

    /*
     * ------------------------------------------------------------
     * 2. Parse request body
     *
     * Frontend historically used both:
     *
     *   { customer: {...}, items: [...] }
     *
     * and
     *
     *   { customerDetails: {...}, items: [...] }
     *
     * Accept both so the API is backwards compatible.
     * ------------------------------------------------------------
     */

    const body = (req.body ?? {}) as RequestPaymentBody & {
      customerDetails?: RequestPaymentBody['customer'];
    };

    const customer =
      body.customer ?? body.customerDetails;

    const customerDetails = validateCustomer(customer);

    const lineItems = normalizeOrderItems(body.items);

    /*
     * ------------------------------------------------------------
     * 3. Supabase
     * ------------------------------------------------------------
     */

    const supabase = getSupabaseAdmin();

    const backendUrl = process.env.BACKEND_URL?.trim();

    if (!backendUrl) {
      console.error(
        'request-payment: BACKEND_URL is not configured',
      );

      jsonError(res, 'config_error', 500);
      return;
    }

    const callbackUrl =
      `${backendUrl.replace(/\/+$/, '')}/api/payment/verify`;

    /*
     * ------------------------------------------------------------
     * 4. Load products
     * ------------------------------------------------------------
     */

    const productIds = lineItems.map(
      (item) => item.productId,
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
      console.error(
        'request-payment: products fetch failed:',
        productsError.message,
      );

      jsonError(res, 'product_not_found', 400);
      return;
    }

    if (!products || products.length !== productIds.length) {
      console.error(
        'request-payment: one or more products not found',
      );

      jsonError(res, 'product_not_found', 400);
      return;
    }

    /*
     * ------------------------------------------------------------
     * 5. Build product map
     * ------------------------------------------------------------
     */

    const productMap = new Map<number, DbProduct>();

    for (const product of products as DbProduct[]) {
      productMap.set(Number(product.id), product);
    }

    /*
     * ------------------------------------------------------------
     * 6. Calculate order total
     * ------------------------------------------------------------
     *
     * IMPORTANT:
     * Never trust totalAmount from frontend.
     * Price is always calculated from Supabase.
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

    for (const line of lineItems) {
      const product = productMap.get(line.productId);

      if (!product) {
        jsonError(res, 'product_not_found', 400);
        return;
      }

      const unitPrice = Number(product.price ?? 0);
      const stock = Number(product.stock ?? 0);

      if (
        !Number.isFinite(unitPrice) ||
        unitPrice <= 0
      ) {
        console.error(
          `request-payment: invalid price for product ${line.productId}`,
        );

        jsonError(res, 'invalid_order', 400);
        return;
      }

      if (
        !Number.isFinite(stock) ||
        stock < line.quantity
      ) {
        console.error(
          `request-payment: insufficient stock for product ${line.productId}`,
        );

        jsonError(res, 'insufficient_stock', 400);
        return;
      }

      totalAmount += unitPrice * line.quantity;

      orderItemsPayload.push({
        product_id: line.productId,
        product_model: String(product.model ?? ''),
        product_goods_type: String(
          product.goods_type ??
            product.type ??
            '',
        ),
        product_color: String(
          product.color ?? '',
        ),
        quantity: line.quantity,
        unit_price: unitPrice,
      });
    }

    if (
      !Number.isFinite(totalAmount) ||
      totalAmount <= 0
    ) {
      jsonError(res, 'invalid_order', 400);
      return;
    }

    /*
     * ------------------------------------------------------------
     * 7. Insert order
     * ------------------------------------------------------------
     *
     * IMPORTANT:
     *
     * The actual database schema DOES NOT contain:
     *
     *   order_number
     *
     * Therefore:
     *
     *   - do not insert it
     *   - do not select it
     *   - do not read it
     *
     * The UUID "id" is the order identifier.
     * ------------------------------------------------------------
     */

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
        total_amount: Math.round(totalAmount),
        status: 'pending',
      })
      .select('id')
      .single();

    if (orderError || !order) {
      console.error(
        'request-payment: order insert failed:',
        orderError?.message,
        orderError?.details,
        orderError?.hint,
      );

      jsonError(res, 'invalid_order', 500);
      return;
    }

    /*
     * ------------------------------------------------------------
     * 8. Insert order items
     * ------------------------------------------------------------
     */

    const orderItems = orderItemsPayload.map(
      (item) => ({
        order_id: order.id,
        ...item,
      }),
    );

    const {
      error: itemsError,
    } = await supabase
      .from('order_items')
      .insert(orderItems);

    if (itemsError) {
      console.error(
        'request-payment: order_items insert failed:',
        itemsError.message,
        itemsError.details,
        itemsError.hint,
      );

      /*
       * Roll back order if order_items failed.
       */
      await supabase
        .from('orders')
        .delete()
        .eq('id', order.id);

      jsonError(res, 'invalid_order', 500);
      return;
    }

    /*
     * ------------------------------------------------------------
     * 9. Create Zibal payment
     * ------------------------------------------------------------
     *
     * Product prices appear to be stored in Toman.
     * Zibal expects Rial.
     * ------------------------------------------------------------
     */

    const amountRials =
      Math.round(totalAmount * 10);

    const zibal = await zibalRequest({
      merchant,
      amount: amountRials,
      callbackUrl,

      /*
       * Database has no order_number.
       * Use UUID order.id instead.
       */
      description: `سفارش ${order.id}`,

      orderId: order.id,
      mobile: customerDetails.phone,
    });

    /*
     * ------------------------------------------------------------
     * 10. Zibal failure
     * ------------------------------------------------------------
     */

    if (
      zibal.result !== 100 ||
      !zibal.trackId
    ) {
      console.error(
        'request-payment: zibal failed:',
        zibal.result,
        zibal.message,
      );

      await supabase
        .from('orders')
        .update({
          status: 'failed',
        })
        .eq('id', order.id);

      res.status(502).json({
        error:
          'خطا در ایجاد تراکنش پرداخت. لطفاً دوباره تلاش کنید.',
      });

      return;
    }

    /*
     * ------------------------------------------------------------
     * 11. Save Zibal track ID
     * ------------------------------------------------------------
     */

    const {
      error: trackUpdateError,
    } = await supabase
      .from('orders')
      .update({
        zibal_track_id: zibal.trackId,
      })
      .eq('id', order.id);

    if (trackUpdateError) {
      console.error(
        'request-payment: failed to save zibal track id:',
        trackUpdateError.message,
      );

      /*
       * Payment was created but tracking ID could not
       * be persisted. Mark order as failed so it is not
       * accidentally treated as a normal pending order.
       */
      await supabase
        .from('orders')
        .update({
          status: 'failed',
        })
        .eq('id', order.id);

      res.status(500).json({
        error:
          'خطا در ذخیره تراکنش پرداخت. لطفاً دوباره تلاش کنید.',
      });

      return;
    }

    /*
     * ------------------------------------------------------------
     * 12. Success response
     * ------------------------------------------------------------
     *
     * There is no order_number in database.
     * Return order.id as orderId and orderNumber for
     * frontend compatibility.
     * ------------------------------------------------------------
     */

    res.status(200).json({
      orderId: order.id,
      orderNumber: order.id,
      trackId: zibal.trackId,
      paymentUrl: zibalStartUrl(
        zibal.trackId,
      ),
    });

  } catch (err) {
    const code =
      err instanceof Error
        ? err.message
        : 'invalid_order';

    console.error(
      'request-payment error:',
      err,
    );

    const status =
      code.startsWith('invalid_') ||
      code === 'insufficient_stock' ||
      code === 'product_not_found'
        ? 400
        : 500;

    jsonError(
      res,
      code,
      status,
    );
  }
}