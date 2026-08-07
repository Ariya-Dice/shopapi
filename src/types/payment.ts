import type {
  CustomerInput,
} from '../services/orderValidation.js';

export interface RequestPaymentBody {
  /**
   * Preferred field used by the backend.
   */
  customer: CustomerInput;

  /**
   * Items selected by customer.
   */
  items: Array<{
    productId: number;
    quantity: number;
  }>;

  /**
   * Deprecated.
   * Server calculates the real amount from products.price.
   */
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
