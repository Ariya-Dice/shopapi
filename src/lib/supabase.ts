import { createClient, SupabaseClient } from '@supabase/supabase-js';

/** Max wait per Supabase HTTP request (PostgREST). No timeout = unbounded by default. */
export const SUPABASE_FETCH_TIMEOUT_MS = 15_000;

let adminClient: SupabaseClient | null = null;

const supabaseFetch: typeof fetch = (input, init) => {
  const signal =
    init?.signal ??
    AbortSignal.timeout(SUPABASE_FETCH_TIMEOUT_MS);

  return fetch(input, {
    ...init,
    signal,
  });
};

export function getSupabaseAdmin(): SupabaseClient {
  if (adminClient) {
    return adminClient;
  }

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  adminClient = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: supabaseFetch,
    },
  });

  return adminClient;
}
