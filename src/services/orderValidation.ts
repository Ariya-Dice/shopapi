const MAX_ORDER_QTY = 999;
const MAX_LINE_ITEMS = 100;
const PHONE_RE = /^09\d{9}$/;

export interface CustomerInput {
  name: string;
  phone: string;
  email?: string;
  address: string;
  note?: string;
}

export interface OrderLineInput {
  productId: number;
  quantity: number;
}

export function parseQuantity(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > MAX_ORDER_QTY) {
    throw new Error('invalid_quantity');
  }
  return n;
}

export function parseProductId(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error('invalid_product_id');
  }
  return n;
}

export function validateCustomer(details: CustomerInput | undefined): CustomerInput {
  if (!details) throw new Error('invalid_customer');

  const name = details.name?.trim() ?? '';
  const phone = details.phone?.trim() ?? '';
  const address = details.address?.trim() ?? '';

  if (name.length < 2 || name.length > 120) {
    throw new Error('invalid_name');
  }
  if (!PHONE_RE.test(phone)) {
    throw new Error('invalid_phone');
  }
  if (address.length < 5 || address.length > 500) {
    throw new Error('invalid_address');
  }

  const email = (details.email ?? '').trim();
  if (email.length > 200) {
    throw new Error('invalid_email');
  }

  const note = (details.note ?? '').trim();
  if (note.length > 1000) {
    throw new Error('invalid_note');
  }

  return {
    name,
    phone,
    email,
    address,
    note,
  };
}

export function normalizeOrderItems(items: unknown): OrderLineInput[] {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_LINE_ITEMS) {
    throw new Error('invalid_items');
  }

  const normalized: OrderLineInput[] = [];
  const seen = new Set<number>();

  for (const raw of items) {
    const productId = parseProductId((raw as { productId?: unknown })?.productId);
    const quantity = parseQuantity((raw as { quantity?: unknown })?.quantity);

    if (seen.has(productId)) {
      const existing = normalized.find((i) => i.productId === productId);
      if (existing) existing.quantity += quantity;
    } else {
      seen.add(productId);
      normalized.push({ productId, quantity });
    }
  }

  return normalized;
}

export function clientErrorMessage(code: string): string {
  const map: Record<string, string> = {
    invalid_customer: 'اطلاعات مشتری نامعتبر است.',
    invalid_name: 'نام و نام خانوادگی نامعتبر است.',
    invalid_phone: 'شماره موبایل باید با 09 شروع شود و ۱۱ رقم باشد.',
    invalid_address: 'آدرس نامعتبر است.',
    invalid_email: 'ایمیل نامعتبر است.',
    invalid_note: 'توضیحات بیش از حد طولانی است.',
    invalid_items: 'سبد خرید نامعتبر است.',
    invalid_quantity: 'تعداد نامعتبر است.',
    invalid_product_id: 'محصول نامعتبر است.',
    product_not_found: 'یکی از محصولات یافت نشد.',
    insufficient_stock: 'موجودی یکی از محصولات کافی نیست.',
    invalid_order: 'در ثبت سفارش مشکلی پیش آمد. لطفاً دوباره تلاش کنید.',
  };
  return map[code] ?? 'در ثبت سفارش مشکلی پیش آمد. لطفاً دوباره تلاش کنید.';
}
