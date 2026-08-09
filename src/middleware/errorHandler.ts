import type { Request, Response, NextFunction } from 'express';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  console.error('Unhandled error:', err instanceof Error ? err.message : err);
  res.status(500).json({
    error: 'There was a problem creating the order. Please try again.',
  });
}
