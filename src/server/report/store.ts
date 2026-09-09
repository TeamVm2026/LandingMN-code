
import type { RateLimitCache } from '../lead/rate-limit.ts';
import {
  IP_MAX_PER_WINDOW,
  IP_WINDOW_MS,
  type HourWindow,
  type SeenRecord,
} from './throttle.ts';

export type ReportCache = RateLimitCache;

export interface ReportNamespace {

  keyOrigin: string;

  label: string;
}

export const CLIENT_ERROR_NS: ReportNamespace = {
  keyOrigin: 'https://client-error.invalid',
  label: 'клиентские ошибки',
};

export const CSP_NS: ReportNamespace = {
  keyOrigin: 'https://csp-report.invalid',
  label: 'нарушения CSP',
};

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function cacheKey(pathname: string, ns: ReportNamespace): Request {
  return new Request(`${ns.keyOrigin}${pathname}`, { method: 'GET' });
}

async function readJson(cache: ReportCache, key: Request): Promise<unknown> {
  try {
    const hit = await cache.match(key);
    if (!hit) return null;
    return await hit.json();
  } catch {
    return null;
  }
}

async function writeJson(
  cache: ReportCache,
  key: Request,
  value: unknown,
  ttlSec: number,
): Promise<void> {
  try {
    await cache.put(
      key,
      new Response(JSON.stringify(value), {
        headers: { 'Cache-Control': `max-age=${String(Math.max(1, Math.ceil(ttlSec)))}` },
      }),
    );
  } catch {
    /* */
  }
}

export async function readSeen(
  cache: ReportCache,
  key: string,
  ns: ReportNamespace = CLIENT_ERROR_NS,
): Promise<SeenRecord | null> {
  const value = await readJson(cache, cacheKey(`/seen/${key}`, ns));
  if (typeof value !== 'object' || value === null) return null;
  const { firstSeenAt } = value as Record<string, unknown>;
  if (typeof firstSeenAt !== 'number' || !Number.isFinite(firstSeenAt)) return null;
  return { firstSeenAt };
}

export async function writeSeen(
  cache: ReportCache,
  key: string,
  record: SeenRecord,
  windowMs: number,
  ns: ReportNamespace = CLIENT_ERROR_NS,
): Promise<void> {
  await writeJson(cache, cacheKey(`/seen/${key}`, ns), record, windowMs / 1000);
}

const WINDOW_PATH = '/window';

export async function readWindow(
  cache: ReportCache,
  ns: ReportNamespace = CLIENT_ERROR_NS,
): Promise<HourWindow | null> {
  const value = await readJson(cache, cacheKey(WINDOW_PATH, ns));
  if (typeof value !== 'object' || value === null) return null;
  const { start, delivered, noticed } = value as Record<string, unknown>;
  if (typeof start !== 'number' || !Number.isFinite(start)) return null;
  if (typeof delivered !== 'number' || !Number.isFinite(delivered) || delivered < 0) return null;
  return { start, delivered, noticed: noticed === true };
}

export async function writeWindow(
  cache: ReportCache,
  window: HourWindow | null,
  now: number,
  windowMs: number,
  ns: ReportNamespace = CLIENT_ERROR_NS,
): Promise<void> {
  if (window === null) return;
  const remainingMs = Math.max(1000, window.start + windowMs - now);
  await writeJson(cache, cacheKey(WINDOW_PATH, ns), window, remainingMs / 1000);
}

interface IpDeliveredState {
  windowStart: number;
  n: number;
}

async function ipDeliveredKey(ip: string, ns: ReportNamespace): Promise<Request> {
  return cacheKey(`/ip-delivered/${await sha256Hex(ip)}`, ns);
}

export async function readIpDelivered(
  cache: ReportCache,
  ip: string,
  windowStart: number | null,
  ns: ReportNamespace = CLIENT_ERROR_NS,
): Promise<number> {
  if (windowStart === null) return 0;
  const value = await readJson(cache, await ipDeliveredKey(ip, ns));
  if (typeof value !== 'object' || value === null) return 0;
  const { windowStart: start, n } = value as Record<string, unknown>;
  if (typeof start !== 'number' || typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 0;

  return start === windowStart ? n : 0;
}

export async function bumpIpDelivered(
  cache: ReportCache,
  ip: string,
  windowStart: number,
  previous: number,
  now: number,
  windowMs: number,
  ns: ReportNamespace = CLIENT_ERROR_NS,
): Promise<void> {
  const state: IpDeliveredState = { windowStart, n: previous + 1 };
  const remainingMs = Math.max(1000, windowStart + windowMs - now);
  await writeJson(cache, await ipDeliveredKey(ip, ns), state, remainingMs / 1000);
}

interface IpState {
  start: number;
  n: number;
}

export async function hitIpLimit(
  cache: ReportCache,
  ip: string,
  now: number,
  ns: ReportNamespace = CLIENT_ERROR_NS,
): Promise<{ allowed: boolean; count: number }> {
  const key = cacheKey(`/ip/${await sha256Hex(ip)}`, ns);

  let previous: IpState | null = null;
  const value = await readJson(cache, key);
  if (typeof value === 'object' && value !== null) {
    const { start, n } = value as Record<string, unknown>;
    if (typeof start === 'number' && Number.isFinite(start) && typeof n === 'number' && Number.isFinite(n)) {
      previous = { start, n };
    }
  }

  const withinWindow = previous !== null && now - previous.start < IP_WINDOW_MS;
  const state: IpState =
    withinWindow && previous !== null ? { start: previous.start, n: previous.n + 1 } : { start: now, n: 1 };

  await writeJson(cache, key, state, Math.max(1, (state.start + IP_WINDOW_MS - now) / 1000));

  return { allowed: state.n <= IP_MAX_PER_WINDOW, count: state.n };
}
