
import type { LeadJournalEntry } from './journal.ts';

export const TELEGRAM_API_BASE = 'https://api.telegram.org';

export const TELEGRAM_ATTEMPT_TIMEOUT_MS = 5000;

export const TELEGRAM_RETRY_DELAYS_MS = [1000, 4000] as const;

export const TELEGRAM_MAX_ATTEMPTS = 3;

export interface TelegramApiResponse {
  ok: boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface SendMessageResult {
  status: number | null;
  body: TelegramApiResponse | null;

  error?: string;
}

export interface SendMessageOptions {
  token: string;
  chatId: string;
  text: string;
  fetchImpl: FetchLike;

  apiBase?: string;
  timeoutMs?: number;

  parseMode?: 'HTML' | null;

  replyMarkup?: unknown;
}

export type TelegramDisposition =
  | { kind: 'delivered' }
  | { kind: 'retry'; delayMs: number; reason: string; errorCode?: number }
  | { kind: 'permanent'; reason: string; errorCode?: number };

export type TelegramFailure = Exclude<TelegramDisposition, { kind: 'delivered' }>;

export interface DeliverOptions extends Omit<SendMessageOptions, 'parseMode'> {

  sleep: (ms: number) => Promise<void>;

  attemptsAlreadyMade?: number;

  nextDelayMs?: number;

  alert?: { chatId: string; leadKey: LeadJournalEntry['key'] };
}

export interface DeliverResult {
  delivered: boolean;

  attempts: number;

  alerted: boolean;
  errorCode?: number;
  reason?: string;
}

function methodUrl(apiBase: string, token: string, method: string): string {
  return `${apiBase.replace(/\/+$/, '')}/bot${token}/${method}`;
}

function hideToken(text: string, token: string): string {
  return token.length > 0 ? text.split(token).join('«токен скрыт»') : text;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function backoffFor(attemptsMade: number): number {
  const table = TELEGRAM_RETRY_DELAYS_MS;
  return table[attemptsMade - 1] ?? table[table.length - 1] ?? 0;
}

export async function sendMessage(options: SendMessageOptions): Promise<SendMessageResult> {
  const { token, chatId, text, fetchImpl } = options;
  const apiBase = options.apiBase ?? TELEGRAM_API_BASE;
  const timeoutMs = options.timeoutMs ?? TELEGRAM_ATTEMPT_TIMEOUT_MS;
  const parseMode = options.parseMode === undefined ? 'HTML' : options.parseMode;

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,

    link_preview_options: { is_disabled: true },
  };
  if (parseMode !== null) payload.parse_mode = parseMode;

  if (options.replyMarkup !== undefined) payload.reply_markup = options.replyMarkup;

  try {
    const response = await fetchImpl(methodUrl(apiBase, token, 'sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),

      signal: AbortSignal.timeout(timeoutMs),
    });

    const parsed = (await response.json().catch(() => null)) as TelegramApiResponse | null;
    return { status: response.status, body: parsed };
  } catch (error) {
    return { status: null, body: null, error: hideToken(describeError(error), token) };
  }
}

export function classifyTelegramResult(
  result: SendMessageResult,
  attemptsMade = 1,
): TelegramDisposition {
  const { status, body } = result;

  if (status === null) {
    return {
      kind: 'retry',
      delayMs: backoffFor(attemptsMade),
      reason: result.error ?? 'ответа не было',
    };
  }

  const errorCode = body?.error_code ?? status;
  const description = body?.description ?? `HTTP ${status}`;

  if (errorCode === 429) {
    const retryAfter = body?.parameters?.retry_after;
    return {
      kind: 'retry',
      delayMs: typeof retryAfter === 'number' ? retryAfter * 1000 : backoffFor(attemptsMade),
      reason: description,
      errorCode: 429,
    };
  }

  if (errorCode >= 500) {
    return { kind: 'retry', delayMs: backoffFor(attemptsMade), reason: description, errorCode };
  }

  if (body?.ok === true) return { kind: 'delivered' };

  return { kind: 'permanent', reason: description, errorCode };
}

function alertText(leadKey: string, attempts: number, failure: TelegramFailure): string {
  return [
    '⚠️ Лид не доставлен в чат менеджеров.',
    `Ключ журнала: ${leadKey}`,
    `Попыток: ${attempts}`,
    `Код ошибки: ${String(failure.errorCode ?? 'нет кода')} — ${failure.reason}`,
    'Достать заявку: docs/ops.md §2 (wrangler kv key list --prefix lead:)',
  ].join('\n');
}

export async function deliverWithRetries(options: DeliverOptions): Promise<DeliverResult> {
  let attempts = options.attemptsAlreadyMade ?? 0;
  let pendingDelayMs = options.nextDelayMs;

  let last: TelegramFailure | null = null;

  while (attempts < TELEGRAM_MAX_ATTEMPTS) {
    const delayMs = pendingDelayMs ?? (attempts > 0 ? backoffFor(attempts) : 0);
    if (delayMs > 0) await options.sleep(delayMs);
    pendingDelayMs = undefined;

    const result = await sendMessage(options);
    attempts += 1;
    const disposition = classifyTelegramResult(result, attempts);

    if (disposition.kind === 'delivered') return { delivered: true, attempts, alerted: false };
    last = disposition;
    if (disposition.kind === 'permanent') break;
    pendingDelayMs = disposition.delayMs;
  }

  const reason = last?.reason;
  const errorCode = last?.errorCode;

  let alerted = false;
  if (options.alert && last) {

    try {
      const sent = await sendMessage({
        token: options.token,
        chatId: options.alert.chatId,
        text: alertText(options.alert.leadKey, attempts, last),
        fetchImpl: options.fetchImpl,
        apiBase: options.apiBase,
        timeoutMs: options.timeoutMs,
        parseMode: null,
      });
      alerted = sent.body?.ok === true;
    } catch {
      alerted = false;
    }
  }

  return { delivered: false, attempts, alerted, errorCode, reason };
}
