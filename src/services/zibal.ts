import axios from 'axios';

const ZIBAL_BASE = 'https://gateway.zibal.ir';

/** Explicit ceiling for Zibal gateway HTTP calls (request + verify). */
export const ZIBAL_HTTP_TIMEOUT_MS = 15_000;

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
  console.log('[ZIBAL_REQUEST] Starting Zibal payment request');

  console.log('[ZIBAL_REQUEST] Request configuration', {
    url: `${ZIBAL_BASE}/v1/request`,
    method: 'POST',
    amount: payload.amount,
    callbackUrl: payload.callbackUrl,
    description: payload.description ?? null,
    orderId: payload.orderId ?? null,
    mobileProvided: Boolean(payload.mobile),
    merchantProvided: Boolean(payload.merchant),
  });

  console.log('[ZIBAL_REQUEST] Callback URL validation', {
    callbackUrl: payload.callbackUrl,
    isHttps: payload.callbackUrl.startsWith('https://'),
    isArbshop:
      payload.callbackUrl.startsWith(
        'https://arbshop.ir/',
      ),
    isRbshop:
      payload.callbackUrl.startsWith(
        'https://rbshop.ir/',
      ),
  });

  try {
    const res =
      await axios.post<ZibalRequestResponse>(
        `${ZIBAL_BASE}/v1/request`,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
          },
          validateStatus: () => true,
          timeout: ZIBAL_HTTP_TIMEOUT_MS,
        },
      );

    console.log('[ZIBAL_REQUEST] Response received', {
      httpStatus: res.status,
      result: res.data?.result ?? null,
      message: res.data?.message ?? null,
      trackId: res.data?.trackId ?? null,
    });

    if (
      res.status < 200 ||
      res.status >= 300
    ) {
      console.error(
        '[ZIBAL_REQUEST] HTTP request failed',
        {
          httpStatus: res.status,
          response: res.data,
        },
      );

      throw new Error(
        `Zibal request HTTP ${res.status}`,
      );
    }

    if (!res.data) {
      console.error(
        '[ZIBAL_REQUEST] Zibal returned an empty response',
      );

      throw new Error(
        'Zibal returned an empty response',
      );
    }

    if (res.data.result !== 100) {
      console.error(
        '[ZIBAL_REQUEST] Zibal rejected payment request',
        {
          result: res.data.result,
          message: res.data.message ?? null,
          trackId: res.data.trackId ?? null,
        },
      );
    } else {
      console.log(
        '[ZIBAL_REQUEST] Zibal payment request accepted',
        {
          trackId: res.data.trackId ?? null,
        },
      );
    }

    return res.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(
        '[ZIBAL_REQUEST] Axios error',
        {
          message: error.message,
          code: error.code,
          status: error.response?.status ?? null,
          response:
            error.response?.data ?? null,
        },
      );
    } else {
      console.error(
        '[ZIBAL_REQUEST] Unexpected error',
        {
          message:
            error instanceof Error
              ? error.message
              : String(error),
        },
      );
    }

    throw error;
  }
}

export async function zibalVerify(
  payload: {
    merchant: string;
    trackId: number;
  },
): Promise<ZibalVerifyResponse> {
  console.log(
    '[ZIBAL_VERIFY] Starting Zibal payment verification',
    {
      url: `${ZIBAL_BASE}/v1/verify`,
      trackId: payload.trackId,
      merchantProvided: Boolean(
        payload.merchant,
      ),
    },
  );

  try {
    const res =
      await axios.post<ZibalVerifyResponse>(
        `${ZIBAL_BASE}/v1/verify`,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
          },
          validateStatus: () => true,
          timeout: ZIBAL_HTTP_TIMEOUT_MS,
        },
      );

    console.log(
      '[ZIBAL_VERIFY] Response received',
      {
        httpStatus: res.status,
        result:
          res.data?.result ?? null,
        message:
          res.data?.message ?? null,
        refNumber:
          res.data?.refNumber ?? null,
        amount:
          res.data?.amount ?? null,
        orderId:
          res.data?.orderId ?? null,
      },
    );

    if (
      res.status < 200 ||
      res.status >= 300
    ) {
      console.error(
        '[ZIBAL_VERIFY] HTTP request failed',
        {
          httpStatus: res.status,
          response: res.data,
        },
      );

      throw new Error(
        `Zibal verify HTTP ${res.status}`,
      );
    }

    if (!res.data) {
      console.error(
        '[ZIBAL_VERIFY] Zibal returned an empty response',
      );

      throw new Error(
        'Zibal returned an empty response',
      );
    }

    return res.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(
        '[ZIBAL_VERIFY] Axios error',
        {
          message: error.message,
          code: error.code,
          status:
            error.response?.status ?? null,
          response:
            error.response?.data ?? null,
        },
      );
    } else {
      console.error(
        '[ZIBAL_VERIFY] Unexpected error',
        {
          message:
            error instanceof Error
              ? error.message
              : String(error),
        },
      );
    }

    throw error;
  }
}

export function zibalStartUrl(
  trackId: number,
): string {
  const url =
    `${ZIBAL_BASE}/start/${trackId}`;

  console.log(
    '[ZIBAL_START] Payment URL generated',
    {
      trackId,
      url,
    },
  );

  return url;
}