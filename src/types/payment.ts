import type { CustomerInput } from '../services/orderValidation.js';

export interface RequestPaymentBody {
  customerDetails: CustomerInput;
  items: Array<{ productId: number; quantity: number }>;
  /** @deprecated ignored — server calculates total */
  totalAmount?: number;
}

export interface DbProduct {
  id: number;
  model: string;
  goods_type: string;
  type: string;
  color: string;
  price: number;
  stock: number;
}

export interface VerifyPaymentQuery {
  success?: string;
  trackId?: string;
  orderId?: string;
}
