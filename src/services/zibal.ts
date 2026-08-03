import axios from 'axios';

const ZIBAL_BASE = 'https://gateway.zibal.ir';

export interface ZibalRequestResponse {
  result: number;
  message?: string;
  trackId?: number;
}

export interface ZibalVerifyResponse {
  result: number;
  message?: string;
  refNumber?: number | string;
  amount?: number;
  orderId?: string;
}

export async function zibalRequest(payload: {
  merchant: string;
  amount: number;
  callbackUrl: string;
  description?: string;
  orderId?: string;
  mobile?: string;
}): Promise<ZibalRequestResponse> {
  const res = await axios.post<ZibalRequestResponse>(`${ZIBAL_BASE}/v1/request`, payload, {
    headers: { 'Content-Type': 'application/json' },
    validateStatus: () => true,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Zibal request HTTP ${res.status}`);
  }

  return res.data;
}

export async function zibalVerify(payload: {
  merchant: string;
  trackId: number;
}): Promise<ZibalVerifyResponse> {
  const res = await axios.post<ZibalVerifyResponse>(`${ZIBAL_BASE}/v1/verify`, payload, {
    headers: { 'Content-Type': 'application/json' },
    validateStatus: () => true,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Zibal verify HTTP ${res.status}`);
  }

  return res.data;
}

export function zibalStartUrl(trackId: number): string {
  return `${ZIBAL_BASE}/start/${trackId}`;
}
