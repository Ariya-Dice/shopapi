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
  console.log('[orderValidation] parseQuantity called', {
    value,
    type: typeof value,
  });

  const n = Number(value);

  if (
    !Number.isFinite(n) ||
    !Number.isInteger(n) ||
    n <= 0 ||
    n > MAX_ORDER_QTY
  ) {
    console.error('[orderValidation] Invalid quantity', {
      value,
      parsedValue: n,
      maxAllowed: MAX_ORDER_QTY,
    });

    throw new Error('invalid_quantity');
  }

  console.log('[orderValidation] Quantity validated successfully', {
    quantity: n,
  });

  return n;
}

export function parseProductId(value: unknown): number {
  console.log('[orderValidation] parseProductId called', {
    value,
    type: typeof value,
  });

  const n = Number(value);

  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    console.error('[orderValidation] Invalid product ID', {
      value,
      parsedValue: n,
    });

    throw new Error('invalid_product_id');
  }

  console.log('[orderValidation] Product ID validated successfully', {
    productId: n,
  });

  return n;
}

export function validateCustomer(
  details: CustomerInput | undefined,
): CustomerInput {
  console.log('[orderValidation] validateCustomer called', {
    customerExists: details !== undefined,
    customerType: typeof details,
  });

  if (!details) {
    console.error(
      '[orderValidation] Customer object is missing or undefined',
    );

    throw new Error('invalid_customer');
  }

  const name = details.name?.trim() ?? '';
  const phone = details.phone?.trim() ?? '';
  const address = details.address?.trim() ?? '';
  const email = (details.email ?? '').trim();
  const note = (details.note ?? '').trim();

  console.log('[orderValidation] Customer data received', {
    hasName: name.length > 0,
    nameLength: name.length,
    hasPhone: phone.length > 0,
    phoneLength: phone.length,
    phonePrefix: phone.substring(0, 2),
    hasAddress: address.length > 0,
    addressLength: address.length,
    hasEmail: email.length > 0,
    emailLength: email.length,
    noteLength: note.length,
  });

  if (name.length < 2 || name.length > 120) {
    console.error('[orderValidation] Customer name validation failed', {
      nameLength: name.length,
      minLength: 2,
      maxLength: 120,
    });

    throw new Error('invalid_name');
  }

  if (!PHONE_RE.test(phone)) {
    console.error('[orderValidation] Customer phone validation failed', {
      phoneLength: phone.length,
      phonePrefix: phone.substring(0, 2),
    });

    throw new Error('invalid_phone');
  }

  if (address.length < 5 || address.length > 500) {
    console.error('[orderValidation] Customer address validation failed', {
      addressLength: address.length,
      minLength: 5,
      maxLength: 500,
    });

    throw new Error('invalid_address');
  }

  if (email.length > 200) {
    console.error('[orderValidation] Customer email validation failed', {
      emailLength: email.length,
      maxLength: 200,
    });

    throw new Error('invalid_email');
  }

  if (note.length > 1000) {
    console.error('[orderValidation] Customer note validation failed', {
      noteLength: note.length,
      maxLength: 1000,
    });

    throw new Error('invalid_note');
  }

  console.log('[orderValidation] Customer validation passed');

  return {
    name,
    phone,
    email,
    address,
    note,
  };
}

export function normalizeOrderItems(
  items: unknown,
): OrderLineInput[] {
  console.log('[orderValidation] normalizeOrderItems called', {
    isArray: Array.isArray(items),
    itemCount: Array.isArray(items) ? items.length : null,
  });

  if (
    !Array.isArray(items) ||
    items.length === 0 ||
    items.length > MAX_LINE_ITEMS
  ) {
    console.error('[orderValidation] Order items validation failed', {
      isArray: Array.isArray(items),
      itemCount: Array.isArray(items) ? items.length : null,
      maxLineItems: MAX_LINE_ITEMS,
    });

    throw new Error('invalid_items');
  }

  const normalized: OrderLineInput[] = [];
  const seen = new Set<number>();

  for (const raw of items) {
    const rawItem = raw as {
      productId?: unknown;
      quantity?: unknown;
    };

    console.log('[orderValidation] Processing order item', {
      productId: rawItem?.productId,
      quantity: rawItem?.quantity,
    });

    const productId = parseProductId(rawItem?.productId);
    const quantity = parseQuantity(rawItem?.quantity);

    if (seen.has(productId)) {
      const existing = normalized.find(
        (i) => i.productId === productId,
      );

      if (existing) {
        existing.quantity += quantity;

        console.log(
          '[orderValidation] Merged duplicate product item',
          {
            productId,
            addedQuantity: quantity,
            totalQuantity: existing.quantity,
          },
        );

        if (existing.quantity > MAX_ORDER_QTY) {
          console.error(
            '[orderValidation] Combined product quantity exceeds maximum',
            {
              productId,
              totalQuantity: existing.quantity,
              maxAllowed: MAX_ORDER_QTY,
            },
          );

          throw new Error('invalid_quantity');
        }
      }
    } else {
      seen.add(productId);

      normalized.push({
        productId,
        quantity,
      });

      console.log(
        '[orderValidation] Product item normalized successfully',
        {
          productId,
          quantity,
        },
      );
    }
  }

  console.log('[orderValidation] Order items validation passed', {
    inputItemCount: items.length,
    normalizedItemCount: normalized.length,
  });

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

  const message =
    map[code] ??
    'There was a problem creating the order. Please try again.';

  console.log('[orderValidation] Client error mapped', {
    code,
    message,
  });

  return message;
}