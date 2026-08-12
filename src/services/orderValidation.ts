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

  if (
    !Number.isFinite(n) ||
    !Number.isInteger(n) ||
    n <= 0 ||
    n > MAX_ORDER_QTY
  ) {
    throw new Error('invalid_quantity');
  }

  return n;
}

export function parseProductId(value: unknown): number {
  const n = Number(value);

  if (
    !Number.isFinite(n) ||
    !Number.isInteger(n) ||
    n <= 0
  ) {
    throw new Error('invalid_product_id');
  }

  return n;
}

export function validateCustomer(
  details: CustomerInput | undefined,
): CustomerInput {
  console.log('[order-validation] validateCustomer() started', {
    hasDetails: Boolean(details),
  });

  if (!details) {
    console.error('[order-validation] Customer details are missing');

    throw new Error('invalid_customer');
  }

  const name = details.name?.trim() ?? '';
  const phone = details.phone?.trim() ?? '';
  const address = details.address?.trim() ?? '';
  const email = (details.email ?? '').trim();
  const note = (details.note ?? '').trim();

  console.log('[order-validation] Customer field validation data', {
    hasName: Boolean(name),
    nameLength: name.length,

    hasPhone: Boolean(phone),
    phoneLength: phone.length,

    hasAddress: Boolean(address),
    addressLength: address.length,

    hasEmail: Boolean(email),
    emailLength: email.length,

    hasNote: Boolean(note),
    noteLength: note.length,
  });

  if (name.length < 2 || name.length > 120) {
    console.error('[order-validation] Invalid name', {
      nameLength: name.length,
      minLength: 2,
      maxLength: 120,
    });

    throw new Error('invalid_name');
  }

  if (!PHONE_RE.test(phone)) {
    console.error('[order-validation] Invalid phone', {
      phoneLength: phone.length,
      phonePatternMatched: PHONE_RE.test(phone),
    });

    throw new Error('invalid_phone');
  }

if (address.length > 500) {
  console.error('[order-validation] Invalid address', {
    addressLength: address.length,
    maxLength: 500,
  });

  throw new Error('invalid_address');
}

  if (email.length > 200) {
    console.error('[order-validation] Invalid email', {
      emailLength: email.length,
      maxLength: 200,
    });

    throw new Error('invalid_email');
  }

  if (note.length > 1000) {
    console.error('[order-validation] Invalid note', {
      noteLength: note.length,
      maxLength: 1000,
    });

    throw new Error('invalid_note');
  }

  console.log('[order-validation] Customer validation passed', {
    nameLength: name.length,
    phoneLength: phone.length,
    addressLength: address.length,
    emailLength: email.length,
    noteLength: note.length,
  });

  return {
    name,
    phone,
    email,
    address,
    note,
  };
}
export function normalizeOrderItems(items: unknown): OrderLineInput[] {
  if (
    !Array.isArray(items) ||
    items.length === 0 ||
    items.length > MAX_LINE_ITEMS
  ) {
    throw new Error('invalid_items');
  }

  const normalized: OrderLineInput[] = [];
  const seen = new Set<number>();

  for (const raw of items) {
    const productId = parseProductId(
      (raw as { productId?: unknown })?.productId,
    );

    const quantity = parseQuantity(
      (raw as { quantity?: unknown })?.quantity,
    );

    if (seen.has(productId)) {
      const existing = normalized.find(
        (i) => i.productId === productId,
      );

      if (existing) {
        existing.quantity += quantity;

        if (existing.quantity > MAX_ORDER_QTY) {
          throw new Error('invalid_quantity');
        }
      }
    } else {
      seen.add(productId);

      normalized.push({
        productId,
        quantity,
      });
    }
  }

  return normalized;
}

export function clientErrorMessage(code: string): string {
  const map: Record<string, string> = {
    invalid_customer: 'Invalid customer information.',
    invalid_name: 'Invalid first and last name.',
    invalid_phone:
      'Phone number must start with 09 and contain 11 digits.',
    invalid_address: 'Invalid address.',
    invalid_email: 'Invalid email address.',
    invalid_note: 'Note is too long.',
    invalid_items: 'Invalid shopping cart.',
    invalid_quantity: 'Invalid quantity.',
    invalid_product_id: 'Invalid product.',
    product_not_found:
      'One of the products was not found.',
    insufficient_stock:
      'Insufficient stock for one of the products.',
    invalid_order:
      'There was a problem creating the order. Please try again.',
  };

  return (
    map[code] ??
    'There was a problem creating the order. Please try again.'
  );
}
