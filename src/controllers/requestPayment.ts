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
  res.status(status).json({ error: clientErrorMessage(code) });
}

export async function requestPayment(req: Request, res: Response): Promise<void> {
  try {
    const merchant = process.env.ZIBAL_MERCHANT;
    if (!merchant) {
      console.error('request-payment: ZIBAL_MERCHANT not configured');
      throw new Error('config_error');
    }

    const body = req.body as RequestPaymentBody;
    const customerDetails = validateCustomer(body.customer);
    const lineItems = normalizeOrderItems(body.items);

    const supabase = getSupabaseAdmin();
    const backendUrl = process.env.BACKEND_URL!.replace(/\/+$/, '');
    const callbackUrl = `${backendUrl}/payment/verify`;

    const productIds = lineItems.map((i) => i.productId);
    const { data: products, error: productsError } = await supabase
      .from('products')
      .select('id, model, goods_type, type, color, price, stock')
      .in('id', productIds);

    if (productsError || !products?.length) {
      console.error('request-payment: products fetch failed', productsError?.message);
      jsonError(res, 'product_not_found', 400);
      return;
    }

    const productMap = new Map<number, DbProduct>();
    for (const p of products as DbProduct[]) {
      productMap.set(Number(p.id), p);
    }

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

      if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
        jsonError(res, 'invalid_order', 400);
        return;
      }
      if (stock < line.quantity) {
        jsonError(res, 'insufficient_stock', 400);
        return;
      }

      totalAmount += unitPrice * line.quantity;
      orderItemsPayload.push({
        product_id: line.productId,
        product_model: String(product.model ?? ''),
        product_goods_type: String(product.goods_type || product.type || ''),
        product_color: String(product.color ?? ''),
        quantity: line.quantity,
        unit_price: unitPrice,
      });
    }

    if (totalAmount <= 0) {
      jsonError(res, 'invalid_items', 400);
      return;
    }

    const { data: order, error: orderError } = await supabase
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
      .select('id, order_number')
      .single();

    if (orderError || !order) {
      console.error('request-payment: order insert failed', orderError?.message);
      jsonError(res, 'invalid_order', 500);
      return;
    }

    const orderItems = orderItemsPayload.map((item) => ({
      order_id: order.id,
      ...item,
    }));

    const { error: itemsError } = await supabase.from('order_items').insert(orderItems);

    if (itemsError) {
      console.error('request-payment: order_items insert failed', itemsError.message);
      await supabase.from('orders').delete().eq('id', order.id);
      jsonError(res, 'invalid_order', 500);
      return;
    }

    const amountRials = Math.round(totalAmount * 10);
    const orderLabel = order.order_number ?? order.id;

    const zibal = await zibalRequest({
      merchant,
      amount: amountRials,
      callbackUrl,
      description: `سفارش ${orderLabel}`,
      orderId: order.id,
      mobile: customerDetails.phone,
    });

    if (zibal.result !== 100 || !zibal.trackId) {
      console.error('request-payment: zibal failed', zibal.result, zibal.message);
      await supabase.from('orders').update({ status: 'failed' }).eq('id', order.id);
      res.status(502).json({
        error: 'خطا در ایجاد تراکنش پرداخت. لطفاً دوباره تلاش کنید.',
      });
      return;
    }

    await supabase
      .from('orders')
      .update({ zibal_track_id: zibal.trackId })
      .eq('id', order.id);

    res.status(200).json({
      orderId: order.id,
      orderNumber: order.order_number,
      trackId: zibal.trackId,
      paymentUrl: zibalStartUrl(zibal.trackId),
    });
  } catch (err) {
    const code = err instanceof Error ? err.message : 'invalid_order';
    console.error('request-payment error:', code);
    const status =
      code.startsWith('invalid_') ||
      code === 'insufficient_stock' ||
      code === 'product_not_found'
        ? 400
        : 500;
    jsonError(res, code, status);
  }
}
