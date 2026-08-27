import { randomUUID } from 'node:crypto';

export function createRequestId(): string {
  return randomUUID();
}

export function paymentStart(requestId: string): void {
  console.log(`[PAYMENT] START requestId=${requestId}`);
}

export function paymentStep(
  name: string,
  durationMs: number,
  requestId: string,
): void {
  console.log(
    `[PAYMENT] STEP=${name} duration=${durationMs} requestId=${requestId}`,
  );
}

export function paymentSupabase(
  durationMs: number,
  requestId: string,
  operation: string,
): void {
  console.log(
    `[PAYMENT] SUPABASE duration=${durationMs} operation=${operation} requestId=${requestId}`,
  );
}

export function paymentZibal(
  durationMs: number,
  requestId: string,
): void {
  console.log(
    `[PAYMENT] ZIBAL duration=${durationMs} requestId=${requestId}`,
  );
}

export function paymentTotal(
  durationMs: number,
  requestId: string,
): void {
  console.log(
    `[PAYMENT] TOTAL duration=${durationMs} requestId=${requestId}`,
  );
}

export class PaymentTracer {
  private readonly startedAt = Date.now();
  private lastMark = this.startedAt;

  constructor(readonly requestId: string) {
    paymentStart(requestId);
  }

  step(name: string): void {
    const now = Date.now();
    paymentStep(name, now - this.lastMark, this.requestId);
    this.lastMark = now;
  }

  supabase(durationMs: number, operation: string): void {
    paymentSupabase(durationMs, this.requestId, operation);
  }

  zibal(durationMs: number): void {
    paymentZibal(durationMs, this.requestId);
  }

  total(): number {
    const durationMs = Date.now() - this.startedAt;
    paymentTotal(durationMs, this.requestId);
    return durationMs;
  }
}
