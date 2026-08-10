import type { Request, Response, NextFunction } from 'express';

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  console.error('========== UNHANDLED ERROR ==========');
  console.error('Timestamp:', new Date().toISOString());
  console.error('Method:', req.method);
  console.error('URL:', req.originalUrl);
  console.error('Headers:', JSON.stringify(req.headers, null, 2));
  console.error('Body:', JSON.stringify(req.body, null, 2));

  if (err instanceof Error) {
    console.error('Error name:', err.name);
    console.error('Error message:', err.message);
    console.error('Error stack:', err.stack);

    if ('cause' in err) {
      console.error('Error cause:', err.cause);
    }
  } else {
    console.error('Unknown error:', err);
  }

  console.error('=====================================');

  res.status(500).json({
    error: 'There was a problem creating the order. Please try again.',
    debug: {
      name: err instanceof Error ? err.name : 'UnknownError',
      message: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    },
  });
}
