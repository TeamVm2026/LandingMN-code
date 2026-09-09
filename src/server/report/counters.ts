
/// <reference types="@cloudflare/workers-types" />

export const COUNTER_PREFIX = 'mon:';

export const ATTEMPT_KEY_PREFIX = `${COUNTER_PREFIX}attempt:`;

export const START_KEY_PREFIX = `${COUNTER_PREFIX}start:`;

export const COUNTER_TTL_SECONDS = 12 * 60 * 60;

export const COUNTER_HOURLY_WRITE_CAP = 12;

export interface CounterKv {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export type CounterKind = 'attempt' | 'start';

export function hourBucket(at: number): string {
  return new Date(at).toISOString().slice(0, 13);
}

export function hourBucketsOfWindow(now: number, windowHours: number): string[] {
  const buckets: string[] = [];
  for (let i = 0; i < windowHours; i++) buckets.push(hourBucket(now - i * 60 * 60 * 1000));
  return buckets;
}

export function counterKey(kind: CounterKind, at: number): string {
  const prefix = kind === 'attempt' ? ATTEMPT_KEY_PREFIX : START_KEY_PREFIX;
  return `${prefix}${hourBucket(at)}`;
}

function parseCount(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

export async function bumpCounter(
  kv: CounterKv,
  kind: CounterKind,
  at: number,
): Promise<{ written: boolean; capped: boolean; count: number }> {
  const key = counterKey(kind, at);
  try {
    const current = parseCount(await kv.get(key, 'json'));
    if (current >= COUNTER_HOURLY_WRITE_CAP) {
      return { written: false, capped: true, count: current };
    }
    const next = current + 1;

    await kv.put(key, String(next), { expirationTtl: COUNTER_TTL_SECONDS });
    return { written: true, capped: false, count: next };
  } catch {

    return { written: false, capped: false, count: 0 };
  }
}

export interface AttemptsWindow {
  readonly form: number;
  readonly start: number;
  readonly total: number;
  readonly capped: boolean;

  readonly buckets: readonly string[];
}

export async function readAttempts(
  kv: CounterKv,
  now: number,
  windowHours: number,
): Promise<AttemptsWindow> {
  const buckets = hourBucketsOfWindow(now, windowHours);
  let form = 0;
  let start = 0;
  let capped = false;

  for (let i = 0; i < windowHours; i++) {
    const at = now - i * 60 * 60 * 1000;
    try {
      const formCount = parseCount(await kv.get(counterKey('attempt', at), 'json'));
      const startCount = parseCount(await kv.get(counterKey('start', at), 'json'));
      form += formCount;
      start += startCount;
      if (formCount >= COUNTER_HOURLY_WRITE_CAP || startCount >= COUNTER_HOURLY_WRITE_CAP) {
        capped = true;
      }
    } catch {

      /* */
    }
  }

  return { form, start, total: form + start, capped, buckets };
}
