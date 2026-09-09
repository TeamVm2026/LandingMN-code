
import { parseUpdate } from './update.ts';
import type { ParsedUpdate } from './update.ts';
import { buildReply } from './reply.ts';
import { buildBotLeadNotice, buildRepeatNotice } from './notice.ts';
import { hitCooldown, hitUpdateOnce } from './cooldown.ts';
import type { BotKv, CooldownBucket, CooldownVerdict } from './cooldown.ts';
import { writeBotLead } from './journal.ts';
import type { BotJournalEntry, BotJournalKv } from './journal.ts';
import { bumpCounter } from '../../src/server/report/counters.ts';
import { DEFAULT_LOCALE } from '../../src/lib/lead-contract.ts';
import {
  TELEGRAM_ATTEMPT_TIMEOUT_MS,
  classifyTelegramResult,
  deliverWithRetries,
  sendMessage,
} from '../../src/server/lead/telegram.ts';
import type { FetchLike, TelegramFailure } from '../../src/server/lead/telegram.ts';

export const WEBHOOK_PATH = '/tg/webhook';

export const WEBHOOK_SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';

export const WEBHOOK_BODY_MAX_BYTES = 64 * 1024;

export type BotLeadsKv = BotKv & BotJournalKv;

export interface BotEnv {
  LEADS?: BotLeadsKv;
  TG_BOT_TOKEN?: string;
  TG_CHAT_ID?: string;
  TG_TECH_CHAT_ID?: string;
  TG_WEBHOOK_SECRET?: string;
  BOT_ADMIN_TOKEN?: string;

  TG_API_BASE?: string;

  MANAGER_CONTACT_URL?: string;

  MONITOR_TARGET_URL?: string;
}

export interface BotExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface WebhookDeps {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const REQUIRED_INPUTS = [
  'LEADS',
  'TG_BOT_TOKEN',
  'TG_CHAT_ID',
  'TG_WEBHOOK_SECRET',
  'MANAGER_CONTACT_URL',
] as const;

export function missingRequiredInputs(env: BotEnv): string[] {
  const missing: string[] = [];
  if (env.LEADS === undefined || env.LEADS === null) missing.push('LEADS');
  if ((env.TG_BOT_TOKEN ?? '').trim() === '') missing.push('TG_BOT_TOKEN');
  if ((env.TG_CHAT_ID ?? '').trim() === '') missing.push('TG_CHAT_ID');
  if ((env.TG_WEBHOOK_SECRET ?? '').trim() === '') missing.push('TG_WEBHOOK_SECRET');
  if ((env.MANAGER_CONTACT_URL ?? '').trim() === '') missing.push('MANAGER_CONTACT_URL');
  return missing;
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function hideToken(text: string, token: string): string {
  return token.length > 0 ? text.split(token).join('«токен скрыт»') : text;
}

function plain(status: number): Response {
  return new Response(null, { status });
}

async function readCappedBody(request: Request, maxBytes: number): Promise<string | null> {
  const stream = request.body;
  if (stream === null) {
    const text = await request.text();
    return new TextEncoder().encode(text).byteLength > maxBytes ? null : text;
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function describeFailure(error: unknown, token: string): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return hideToken(raw, token).slice(0, 300);
}

async function tellTechChat(env: BotEnv, deps: WebhookDeps, text: string): Promise<void> {
  const techChat = (env.TG_TECH_CHAT_ID ?? '').trim();
  const token = (env.TG_BOT_TOKEN ?? '').trim();
  if (techChat === '' || token === '') return;
  try {
    await sendMessage({
      token,
      chatId: techChat,
      text,
      fetchImpl: deps.fetchImpl ?? ((url, init) => fetch(url, init)),
      apiBase: env.TG_API_BASE,
      timeoutMs: TELEGRAM_ATTEMPT_TIMEOUT_MS,
      parseMode: null,
    });
  } catch {
    /* */
  }
}

function journalLocale(parsed: Extract<ParsedUpdate, { kind: 'start' }>): typeof DEFAULT_LOCALE {
  return parsed.payload ? parsed.payload.locale : DEFAULT_LOCALE;
}

export async function handleWebhook(
  request: Request,
  env: BotEnv,
  ctx: BotExecutionContext,
  deps: WebhookDeps = {},
): Promise<Response> {

  if (request.method !== 'POST') return plain(405);

  const configuredSecret = (env.TG_WEBHOOK_SECRET ?? '').trim();
  const presentedSecret = request.headers.get(WEBHOOK_SECRET_HEADER) ?? '';
  if (configuredSecret === '' || !timingSafeEqualStr(presentedSecret, configuredSecret)) {
    return plain(401);
  }

  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > WEBHOOK_BODY_MAX_BYTES) return plain(413);

  const kv = env.LEADS;
  if (kv === undefined || missingRequiredInputs(env).length > 0) return plain(503);

  const token = (env.TG_BOT_TOKEN ?? '').trim();
  const managersChat = (env.TG_CHAT_ID ?? '').trim();
  const managerUrl = (env.MANAGER_CONTACT_URL ?? '').trim();
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = (deps.now ?? Date.now)();

  try {

    const body = await readCappedBody(request, WEBHOOK_BODY_MAX_BYTES);
    if (body === null) return plain(413);

    let raw: unknown = null;
    try {
      raw = JSON.parse(body) as unknown;
    } catch {

      raw = null;
    }

    const parsed = parseUpdate(raw);

    if (parsed.kind === 'ignore') return plain(200);
    if (parsed.chatId === null) return plain(200);

    if (!(await hitUpdateOnce(kv, parsed.updateId))) {
      await tellTechChat(
        env,
        deps,
        `бот: повтор апдейта ${parsed.updateId} отсечён, конвейер второй раз не проходил. ` +
          'Если ответа и лида по нему не было вовсе — воркер не ответил Telegram на первой ' +
          'доставке, и лид надо достать вручную.',
      );
      return plain(200);
    }

    const visitorChat = String(parsed.chatId);
    const bucket: CooldownBucket = parsed.kind === 'start' ? 'start' : 'other';

    if (parsed.kind === 'other') {
      const verdict = await hitCooldown(kv, bucket, parsed.user.id, now);
      if (verdict.kind !== 'new') return plain(200);
      const answered = await replyToVisitor({
        token,
        chatId: visitorChat,
        managerUrl,
        payload: null,
        languageCode: parsed.user.languageCode,
        fetchImpl,
        apiBase: env.TG_API_BASE,
      });

      chaseVisitorReply({
        ctx,
        env,
        deps,
        token,
        chatId: visitorChat,
        userId: parsed.user.id,
        fetchImpl,
        outcome: answered,
      });
      return plain(200);
    }

    try {
      await bumpCounter(kv, 'start', now);
    } catch {
      /* */
    }

    const answered = await replyToVisitor({
      token,
      chatId: visitorChat,
      managerUrl,
      payload: parsed.payload,
      languageCode: parsed.user.languageCode,
      fetchImpl,
      apiBase: env.TG_API_BASE,
    });
    const contactDelivered = answered.failure === null;

    chaseVisitorReply({
      ctx,
      env,
      deps,
      token,
      chatId: visitorChat,
      userId: parsed.user.id,
      fetchImpl,
      outcome: answered,
    });

    const verdict: CooldownVerdict = await hitCooldown(kv, bucket, parsed.user.id, now);
    if (verdict.kind === 'silent') return plain(200);

    let entry: BotJournalEntry | null = null;
    let text: string;
    if (verdict.kind === 'new') {
      entry = await writeBotLead(
        kv,
        {
          payload: {
            update_id: parsed.updateId,
            user_id: parsed.user.id,
            first_name: parsed.user.firstName,
            last_name: parsed.user.lastName,
            username: parsed.user.username,
            language_code: parsed.user.languageCode,
            raw: parsed.raw,
            source: parsed.payload?.source ?? '',
            direction: parsed.payload?.direction ?? 'none',
            campaign: parsed.payload?.campaign ?? '',
            click: parsed.payload?.click ?? '',
            lang: journalLocale(parsed),
            at: new Date(now).toISOString(),
          },
          metadata: {
            direction: parsed.payload?.direction ?? 'none',
            source: parsed.payload?.source ?? '',
            lang: journalLocale(parsed),
          },
        },
        { now: () => now },
      );
      text = buildBotLeadNotice({
        user: parsed.user,
        payload: parsed.payload,
        raw: parsed.raw,
        at: new Date(now),
        contactDelivered,
      });
    } else {

      text = buildRepeatNotice({
        user: parsed.user,
        firstAt: new Date(verdict.firstAt),
        n: verdict.n,
        payload: parsed.payload,
        raw: parsed.raw,
        contactDelivered,
      });
    }

    const first = await sendMessage({
      token,
      chatId: managersChat,
      text,
      fetchImpl,
      apiBase: env.TG_API_BASE,
      timeoutMs: TELEGRAM_ATTEMPT_TIMEOUT_MS,
    });
    const disposition = classifyTelegramResult(first, 1);

    if (disposition.kind !== 'delivered') {
      const techChat = (env.TG_TECH_CHAT_ID ?? '').trim();
      ctx.waitUntil(
        deliverWithRetries({
          token,
          chatId: managersChat,
          text,
          fetchImpl,
          sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
          apiBase: env.TG_API_BASE,
          timeoutMs: TELEGRAM_ATTEMPT_TIMEOUT_MS,
          attemptsAlreadyMade: 1,
          nextDelayMs: disposition.kind === 'retry' ? disposition.delayMs : 0,
          alert:
            techChat === '' || entry === null ? undefined : { chatId: techChat, leadKey: entry.key },
        }).catch(() => undefined),
      );
    }

    return plain(200);
  } catch (error) {

    await tellTechChat(
      env,
      deps,
      `бот: конвейер вебхука бросил исключение, апдейт обработан не был. ${describeFailure(error, token)}. ` +
        'Содержимое апдейта здесь не приводится намеренно.',
    );
    return plain(200);
  }
}

interface ReplyOutcome {

  readonly failure: TelegramFailure | null;
  readonly text: string;
  readonly replyMarkup: unknown;
}

async function replyToVisitor(options: {
  token: string;
  chatId: string;
  managerUrl: string;
  payload: Parameters<typeof buildReply>[0]['payload'];
  languageCode: string;
  fetchImpl: FetchLike;
  apiBase?: string;
}): Promise<ReplyOutcome> {
  const reply = buildReply({
    managerUrl: options.managerUrl,
    payload: options.payload,
    languageCode: options.languageCode,

    repeat: false,
  });
  const result = await sendMessage({
    token: options.token,
    chatId: options.chatId,
    text: reply.text,
    fetchImpl: options.fetchImpl,
    apiBase: options.apiBase,
    timeoutMs: TELEGRAM_ATTEMPT_TIMEOUT_MS,
    replyMarkup: reply.replyMarkup,
  });
  const disposition = classifyTelegramResult(result, 1);
  return {
    failure: disposition.kind === 'delivered' ? null : disposition,
    text: reply.text,
    replyMarkup: reply.replyMarkup,
  };
}

function chaseVisitorReply(options: {
  ctx: BotExecutionContext;
  env: BotEnv;
  deps: WebhookDeps;
  token: string;
  chatId: string;
  userId: number;
  fetchImpl: FetchLike;
  outcome: ReplyOutcome;
}): void {
  const failure = options.outcome.failure;
  if (failure === null) return;

  options.ctx.waitUntil(
    (async () => {
      let attempts = 1;
      let reason = failure.reason;
      let errorCode = failure.errorCode;

      if (failure.kind === 'retry') {
        const delivered = await deliverWithRetries({
          token: options.token,
          chatId: options.chatId,
          text: options.outcome.text,
          replyMarkup: options.outcome.replyMarkup,
          fetchImpl: options.fetchImpl,
          sleep: options.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
          apiBase: options.env.TG_API_BASE,
          timeoutMs: TELEGRAM_ATTEMPT_TIMEOUT_MS,
          attemptsAlreadyMade: 1,
          nextDelayMs: failure.delayMs,
        });

        if (delivered.delivered) return;
        attempts = delivered.attempts;
        reason = delivered.reason ?? reason;
        errorCode = delivered.errorCode ?? errorCode;
      }

      await tellTechChat(
        options.env,
        options.deps,
        `бот: ответ посетителю id ${options.userId} НЕ доставлен — контакта менеджера человек ` +
          `не получил. Попыток: ${attempts}, код: ${String(errorCode ?? 'нет кода')} — ` +
          `${hideToken(reason ?? 'причина не названа', options.token)}. Разбор: docs/ops.md §8.5.1.`,
      );
    })().catch(() => undefined),
  );
}
