
import { TURNSTILE_TOKEN_FIELD } from '../../lib/lead-contract.ts';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export const TURNSTILE_BUDGET_MS = 5_000;

export type TurnstileOutcome = 'disabled' | 'pass' | 'fail' | 'unavailable';

export interface TurnstileVerdict {
  outcome: TurnstileOutcome;

  errorCodes: string[];

  attempts: number;

  configError: boolean;

  tokenPresent: boolean;
}

export interface TurnstileFetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export type FetchLike = (input: string, init: TurnstileFetchInit) => Promise<Response>;

export interface TurnstileOptions {

  secret: string;

  token: string;

  remoteip?: string;

  idempotencyKey?: string;

  budgetMs: number;
  fetchImpl: FetchLike;

  now?: () => number;
}

export interface TokenSource {
  get(name: string): unknown;
}

export function extractTurnstileToken(body: TokenSource): string {
  const value = body.get(TURNSTILE_TOKEN_FIELD);
  return typeof value === 'string' ? value : '';
}

const OUR_MISCONFIGURATION = new Set(['missing-input-secret', 'invalid-input-secret', 'bad-request']);

interface SiteverifyPayload {
  success: boolean;
  'error-codes'?: unknown;
}

function parsePayload(value: unknown): SiteverifyPayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const { success } = value as Record<string, unknown>;
  if (typeof success !== 'boolean') return null;
  return value as SiteverifyPayload;
}

function readCodes(payload: SiteverifyPayload): string[] {
  const raw = payload['error-codes'];
  return Array.isArray(raw) ? raw.filter((code): code is string => typeof code === 'string') : [];
}

export async function verifyTurnstile(options: TurnstileOptions): Promise<TurnstileVerdict> {
  const secret = options.secret.trim();

  const tokenPresent = options.token.trim() !== '';
  if (secret === '') {

    return { outcome: 'disabled', errorCodes: [], attempts: 0, configError: false, tokenPresent };
  }

  const now = options.now ?? Date.now;
  const deadline = now() + options.budgetMs;

  const idempotencyKey = options.idempotencyKey ?? crypto.randomUUID();

  const body = new URLSearchParams();
  body.set('secret', secret);

  body.set('response', options.token);
  if (options.remoteip) body.set('remoteip', options.remoteip);
  body.set('idempotency_key', idempotencyKey);
  const payloadText = body.toString();

  let attempts = 0;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const remainingMs = deadline - now();

    if (attempt > 1 && remainingMs <= 0) break;

    attempts = attempt;
    const verdict = await attemptVerify(options.fetchImpl, payloadText, Math.max(1, remainingMs));
    if (verdict) return { ...verdict, attempts, tokenPresent };
  }

  return { outcome: 'unavailable', errorCodes: [], attempts, configError: false, tokenPresent };
}

async function attemptVerify(
  fetchImpl: FetchLike,
  payloadText: string,
  timeoutMs: number,
): Promise<Omit<TurnstileVerdict, 'attempts' | 'tokenPresent'> | null> {
  let response: Response;
  try {
    response = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payloadText,

      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  let parsed: SiteverifyPayload | null;
  try {
    parsed = parsePayload(await response.json());
  } catch {
    return null;
  }
  if (!parsed) return null;

  if (parsed.success) return { outcome: 'pass', errorCodes: [], configError: false };

  const errorCodes = readCodes(parsed);
  return {
    outcome: 'fail',
    errorCodes,
    configError: errorCodes.some((code) => OUR_MISCONFIGURATION.has(code)),
  };
}
