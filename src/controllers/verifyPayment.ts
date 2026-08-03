import type { Request, Response } from 'express';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { zibalVerify } from '../services/zibal.js';

function frontendBase(): string {
  const url = process.env.FRONTEND_URL ?? 'http://localhost:5173';
  return url.replace(/\/+$/, '');
}

function redirect(res: Response, path: string): void {
  res.redirect(302, path);
}

function getVerifyParams(req: Request): {
  success?: string;
  trackId?: string;
  orderId?: string;
} {
  const fromQuery = req.query as Record<string, string | undefined>;
  const fromBody = (req.body ?? {}) as Record<string, string | undefined>;

  return {
    success: fromQuery.success ?? fromBody.success,
    trackId: fromQuery.trackId ?? fromBody.trackId,
    orderId: fromQuery.orderId ?? fromBody.orderId,
  };
}

export async function verifyPayment(req: Request, res: Response): Promise<void> {
  const base = frontendBase();

  try {
    const { success, trackId: trackIdRaw, orderId: orderIdParam } = getVerifyParams(req);

    if (!trackIdRaw) {
      redirect(res, `${base}/#/payment/failed?reason=missing_track_id`);
      return;
    }

    const trackId = Number(trackIdRaw);
    if (!Number.isFinite(trackId)) {
      redirect(res, `${base}/#/payment/failed?reason=invalid_track_id`);
      return;
    }

    const merchant = process.env.ZIBAL_MERCHANT;
    if (!merchant) {
      console.error('verify-payment: ZIBAL_MERCHANT not configured');
      redirect(res, `${base}/#/payment/failed?reason=config`);
      return;
    }

    const supabase = getSupabaseAdmin();

    let order =
      orderIdParam != null
        ? (await supabase.from('orders').select('*').eq('id', orderIdParam).maybeSingle()).data
        : null;

    if (!order) {
      order = (await supabase.from('orders').select('*').eq('zibal_track_id', trackId).maybeSingle())
        .data;
    }

    if (!order) {
      redirect(res, `${base}/#/payment/failed?reason=order_not_found`);
      return;
    }

    const successQuery = `orderId=${order.id}&orderNumber=${encodeURIComponent(order.order_number ?? '')}`;

    if (order.status === 'paid') {
      redirect(res, `${base}/#/payment/success?${successQuery}`);
      return;
    }

    if (success !== '1') {
      if (order.status === 'pending') {
        await supabase.from('orders').update({ status: 'failed' }).eq('id', order.id);
      }
      redirect(res, `${base}/#/payment/failed?orderId=${order.id}`);
      return;
    }

    if (order.zibal_track_id != null && Number(order.zibal_track_id) !== trackId) {
      console.error('verify-payment: trackId mismatch', order.id, order.zibal_track_id, trackId);
      await supabase.from('orders').update({ status: 'failed' }).eq('id', order.id);
      redirect(res, `${base}/#/payment/failed?orderId=${order.id}&reason=track_mismatch`);
      return;
    }

    const verify = await zibalVerify({ merchant, trackId });

    if (verify.result !== 100) {
      console.error('verify-payment: zibal verify failed', order.id, verify.result);
      await supabase.from('orders').update({ status: 'failed' }).eq('id', order.id);
      redirect(res, `${base}/#/payment/failed?orderId=${order.id}&code=${verify.result}`);
      return;
    }

    const expectedRials = Math.round(Number(order.total_amount) * 10);
    const paidRials = verify.amount != null ? Math.round(Number(verify.amount)) : null;

    if (paidRials != null && paidRials !== expectedRials) {
      console.error('verify-payment: amount mismatch', order.id, paidRials, expectedRials);
      await supabase.from('orders').update({ status: 'failed' }).eq('id', order.id);
      redirect(res, `${base}/#/payment/failed?orderId=${order.id}&reason=amount_mismatch`);
      return;
    }

    const refNumber = verify.refNumber != null ? String(verify.refNumber) : null;

    const { data: rpcResult, error: rpcError } = await supabase.rpc('complete_order_payment', {
      p_order_id: order.id,
      p_zibal_ref_number: refNumber,
    });

    if (rpcError) {
      console.error('verify-payment: complete_order_payment failed', order.id, rpcError.message);

      if (rpcError.message.includes('insufficient_stock')) {
        await supabase.from('orders').update({ status: 'failed' }).eq('id', order.id);
        redirect(res, `${base}/#/payment/failed?orderId=${order.id}&reason=stock`);
        return;
      }

      redirect(res, `${base}/#/payment/failed?orderId=${order.id}&reason=server_error`);
      return;
    }

    if (rpcResult === 'already_paid') {
      redirect(res, `${base}/#/payment/success?${successQuery}`);
      return;
    }

    redirect(res, `${base}/#/payment/success?${successQuery}`);
  } catch (err) {
    console.error('verify-payment error:', err instanceof Error ? err.message : err);
    redirect(res, `${base}/#/payment/failed?reason=server_error`);
  }
}
