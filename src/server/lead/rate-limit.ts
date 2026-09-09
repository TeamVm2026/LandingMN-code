
import { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from '../../lib/lead-contract.ts';

export interface RateLimitCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface RateLimitVerdict {

  allowed: boolean;

  count: number;

  remainingSec: number;
}

interface WindowState {

  start: number;

  n: number;
}

const KEY_ORIGIN = 'https://ratelimit.invalid';

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function windowKey(ip: string): Promise<Request> {

  return new Request(`${KEY_ORIGIN}/lead/${await sha256Hex(ip)}`, { method: 'GET' });
}

function parseState(value: unknown): WindowState | null {
  if (typeof value !== 'object' || value === null) return null;
  const { start, n } = value as Record<string, unknown>;
  if (typeof start !== 'number' || !Number.isFinite(start)) return null;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  return { start, n };
}

export async function hitRateLimit(
  cache: RateLimitCache,
  ip: string,
  now: number,
): Promise<RateLimitVerdict> {
  const key = await windowKey(ip);

  let previous: WindowState | null = null;
  try {
    const hit = await cache.match(key);
    if (hit) previous = parseState(await hit.json());
  } catch {
    previous = null;
  }

  const withinWindow = previous !== null && now - previous.start < RATE_LIMIT_WINDOW_MS;
  const state: WindowState = withinWindow && previous !== null
    ? { start: previous.start, n: previous.n + 1 }
    : { start: now, n: 1 };

  const remainingSec = Math.max(1, Math.ceil((state.start + RATE_LIMIT_WINDOW_MS - now) / 1000));

  try {
    await cache.put(
      key,
      new Response(JSON.stringify(state), {

        headers: { 'Cache-Control': `max-age=${remainingSec}` },
      }),
    );
  } catch {

    /* */
  }

  return { allowed: state.n <= RATE_LIMIT_MAX, count: state.n, remainingSec };
}
