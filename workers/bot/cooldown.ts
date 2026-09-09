
const COOLDOWN_KEY_PREFIX = 'botcd:';

const UPDATE_KEY_PREFIX = 'botupd:';

const SECOND = 1000;

export const BOT_COOLDOWN_SECONDS = 24 * 60 * 60;

export const BOT_OTHER_COOLDOWN_SECONDS = 10 * 60;

export const BOT_UPDATE_DEDUP_SECONDS = 5 * 60;

export type CooldownBucket = 'start' | 'other';

export type CooldownKind = 'new' | 'repeat' | 'silent';

export interface CooldownVerdict {
  kind: CooldownKind;

  n: number;

  firstAt: number;
}

interface BucketRules {

  readonly windowSeconds: number;

  readonly repeatAt: number | null;
}

const BUCKETS = {
  start: { windowSeconds: BOT_COOLDOWN_SECONDS, repeatAt: 2 },
  other: { windowSeconds: BOT_OTHER_COOLDOWN_SECONDS, repeatAt: null },
} as const satisfies Record<CooldownBucket, BucketRules>;

export interface BotKv {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface WindowState {

  start: number;

  n: number;
}

function parseState(value: unknown): WindowState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { start, n } = value as Record<string, unknown>;
  if (typeof start !== 'number' || !Number.isFinite(start)) return null;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) return null;
  return { start, n };
}

function verdictFor(rules: BucketRules, n: number): CooldownKind {
  if (n === 1) return 'new';
  if (rules.repeatAt !== null && n === rules.repeatAt) return 'repeat';
  return 'silent';
}

export async function hitCooldown(
  kv: BotKv,
  bucket: CooldownBucket,
  userId: number,
  now: number,
): Promise<CooldownVerdict> {
  const rules: BucketRules = BUCKETS[bucket];
  const key = `${COOLDOWN_KEY_PREFIX}${bucket}:${userId}`;

  let previous: WindowState | null = null;
  try {
    previous = parseState(await kv.get(key, 'json'));
  } catch {
    previous = null;
  }

  const withinWindow = previous !== null && now - previous.start < rules.windowSeconds * SECOND;
  const state: WindowState =
    withinWindow && previous !== null ? { start: previous.start, n: previous.n + 1 } : { start: now, n: 1 };

  const kind = verdictFor(rules, state.n);

  if (kind !== 'silent') {
    try {
      await kv.put(key, JSON.stringify(state), { expirationTtl: rules.windowSeconds });
    } catch {

      /* */
    }
  }

  return { kind, n: state.n, firstAt: state.start };
}

export async function hitUpdateOnce(kv: BotKv, updateId: number | null): Promise<boolean> {

  if (updateId === null || !Number.isFinite(updateId)) return true;

  const key = `${UPDATE_KEY_PREFIX}${updateId}`;

  try {
    const seen = await kv.get(key, 'json');
    if (seen !== null && seen !== undefined) return false;
  } catch {

    /* */
  }

  try {

    await kv.put(key, '1', { expirationTtl: BOT_UPDATE_DEDUP_SECONDS });
  } catch {

    /* */
  }

  return true;
}
