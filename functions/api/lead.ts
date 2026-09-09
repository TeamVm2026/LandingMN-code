
/// <reference types="@cloudflare/workers-types" />
import { VALUE_MAX_LEN } from '../../src/lib/attribution.ts';
import {
  ATTRIBUTION_FIELD,
  BODY_MAX_BYTES,
  DEFAULT_LOCALE,
  ERROR_CODES,
  FIELDS,
  HONEYPOT_FIELD,
  LOCALES,
  TURNSTILE_TOKEN_FIELD,
} from '../../src/lib/lead-contract.ts';
import type { ErrorCode } from '../../src/lib/lead-contract.ts';
import type { Locale } from '../../src/i18n/routes.ts';
import { markDelivery, writeLead } from '../../src/server/lead/journal.ts';
import { buildLeadMessage } from '../../src/server/lead/message.ts';
import { readCappedBody } from '../../src/server/http/capped-body.ts';
import { bumpCounter } from '../../src/server/report/counters.ts';
import { hitRateLimit } from '../../src/server/lead/rate-limit.ts';
import type { RateLimitCache } from '../../src/server/lead/rate-limit.ts';
import { respondError, respondSuccess, wantsJson } from '../../src/server/lead/respond.ts';
import {
  TELEGRAM_ATTEMPT_TIMEOUT_MS,
  classifyTelegramResult,
  deliverWithRetries,
  sendMessage,
} from '../../src/server/lead/telegram.ts';
import {
  TURNSTILE_BUDGET_MS,
  extractTurnstileToken,
  verifyTurnstile,
} from '../../src/server/lead/turnstile.ts';
import { validateLead } from '../../src/server/lead/validate.ts';

interface LeadEnv {
  LEADS?: KVNamespace;
  TG_BOT_TOKEN?: string;
  TG_CHAT_ID?: string;
  TG_TECH_CHAT_ID?: string;
  TURNSTILE_SECRET_KEY?: string;

  TG_API_BASE?: string;

  PUBLIC_TG_CONTACT_URL?: string;
}

const LOCAL_IP_FALLBACK = 'local-dev';

const TURNSTILE_ALERT_BUCKET = 'turnstile-config-error';

const TURNSTILE_SECRET_MISSING_BUCKET = 'turnstile-secret-missing';

const BODY_FIELD_NAMES: readonly string[] = [
  FIELDS.name,
  FIELDS.contact,
  FIELDS.contactChannel,
  FIELDS.direction,
  FIELDS.consent,
  FIELDS.lang,
  HONEYPOT_FIELD,
  TURNSTILE_TOKEN_FIELD,
  ATTRIBUTION_FIELD,
];

function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

function clientIp(request: Request): string {
  const direct = request.headers.get('CF-Connecting-IP');
  if (direct !== null && direct.trim() !== '') return direct.trim();

  const forwarded = request.headers.get('X-Forwarded-For');
  if (forwarded !== null) {
    const first = (forwarded.split(',')[0] ?? '').trim();
    if (first !== '') return first;
  }

  return LOCAL_IP_FALLBACK;
}

function localeFromReferer(request: Request): Locale {
  const referer = request.headers.get('referer');
  if (referer === null) return DEFAULT_LOCALE;
  try {
    const segments = new URL(referer).pathname.split('/');
    const first = (segments[1] ?? '').toLowerCase();
    return isLocale(first) ? first : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

function collect(read: (name: string) => string): Map<string, string> {
  const values = new Map<string, string>();
  for (const name of BODY_FIELD_NAMES) {
    const value = read(name);
    if (value !== '') values.set(name, value);
  }
  return values;
}

function parseBody(contentType: string, text: string): Map<string, string> | null {
  const type = contentType.toLowerCase();

  if (type.includes('application/json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    return collect((name) => {
      const value = record[name];
      return typeof value === 'string' ? value : '';
    });
  }

  const form = new URLSearchParams(text);
  return collect((name) => form.get(name) ?? '');
}

function toRecord(values: Map<string, string>): Record<string, unknown> {
  const record = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of values) record[key] = value;
  return record;
}

function parseAttribution(raw: string): unknown {
  if (raw === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function attributionSource(attr: unknown): string {
  if (typeof attr !== 'object' || attr === null || Array.isArray(attr)) return 'direct';
  const value = (attr as Record<string, unknown>).source;
  if (typeof value !== 'string' || value === '') return 'direct';
  return value.slice(0, VALUE_MAX_LEN);
}

function sharedCache(): RateLimitCache | null {
  const store = (globalThis as { caches?: { default?: unknown } }).caches;
  const candidate = store?.default;
  if (candidate !== undefined && typeof (candidate as RateLimitCache).match === 'function') {
    return candidate as RateLimitCache;
  }
  return null;
}

const fetchImpl = (url: string, init: RequestInit): Promise<Response> => fetch(url, init);

const ALLOWED_TG_API_HOSTS = new Set(['api.telegram.org', '127.0.0.1', 'localhost', '[::1]']);

function apiBaseOf(env: LeadEnv): string | undefined {
  const base = (env.TG_API_BASE ?? '').trim();
  if (base === '') return undefined;
  let host: string;
  try {
    host = new URL(base).hostname;
  } catch {
    return undefined;
  }
  return ALLOWED_TG_API_HOSTS.has(host) ? base : undefined;
}

async function alertConfigError(env: LeadEnv, cache: RateLimitCache | null): Promise<void> {
  const techChat = (env.TG_TECH_CHAT_ID ?? '').trim();
  const token = (env.TG_BOT_TOKEN ?? '').trim();
  if (techChat === '' || token === '' || cache === null) return;

  const gate = await hitRateLimit(cache, TURNSTILE_ALERT_BUCKET, Date.now());
  if (gate.count !== 1) return;

  await sendMessage({
    token,
    chatId: techChat,
    text: [

      '⚠️ Turnstile отклоняет ВСЕ заявки: секрет задан, но неверен.',
      'Это ошибка конфигурации, а не спам — siteverify вернул код про секрет.',
      'Проверить: Pages -> Settings -> Variables -> TURNSTILE_SECRET_KEY.',
      'Пока это не исправлено, ни один лид не доходит до чата менеджеров.',
    ].join('\n'),
    fetchImpl,
    apiBase: apiBaseOf(env),

    parseMode: null,
  });
}

async function alertSecretMissing(env: LeadEnv, cache: RateLimitCache | null): Promise<void> {
  const techChat = (env.TG_TECH_CHAT_ID ?? '').trim();
  const token = (env.TG_BOT_TOKEN ?? '').trim();
  if (techChat === '' || token === '' || cache === null) return;

  const gate = await hitRateLimit(cache, TURNSTILE_SECRET_MISSING_BUCKET, Date.now());
  if (gate.count !== 1) return;

  await sendMessage({
    token,
    chatId: techChat,
    text: [
      '⚠️ Turnstile НЕ ПРОВЕРЯЕТСЯ: виджет на странице есть, серверного секрета нет.',
      'Посетитель прислал токен, но сервер его не проверял — TURNSTILE_SECRET_KEY пуст.',
      'Заявки проходят и помечены «антиспам не проверен». Это не спам-фильтр, а его отсутствие.',
      'Проверить: Pages -> Settings -> Variables -> TURNSTILE_SECRET_KEY.',
    ].join('\n'),
    fetchImpl,
    apiBase: apiBaseOf(env),
    parseMode: null,
  });
}

export const onRequest: PagesFunction<LeadEnv> = async (context) => {
  const { request, env } = context;
  const json = wantsJson(request);
  const managerUrl = env.PUBLIC_TG_CONTACT_URL ?? '';

  let locale = localeFromReferer(request);

  const fail = (
    code: ErrorCode,
    extra?: { fields?: readonly string[]; retryAfterSec?: number },
  ): Response =>
    respondError({
      json,
      code,
      locale,
      managerUrl,
      fields: extra?.fields,
      retryAfterSec: extra?.retryAfterSec,
    });

  try {

    if (request.method !== 'POST') return fail(ERROR_CODES.methodNotAllowed);

    const declared = Number(request.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > BODY_MAX_BYTES) {
      return fail(ERROR_CODES.bodyTooLarge);
    }

    const kv = env.LEADS;
    const token = (env.TG_BOT_TOKEN ?? '').trim();
    const chatId = (env.TG_CHAT_ID ?? '').trim();
    if (kv === undefined || token === '' || chatId === '') {
      return fail(ERROR_CODES.serviceUnconfigured);
    }

    const body = await readCappedBody(request, BODY_MAX_BYTES);
    if (body === null) return fail(ERROR_CODES.bodyTooLarge);

    const values = parseBody(request.headers.get('content-type') ?? '', body);
    if (values === null) return fail(ERROR_CODES.badRequest);

    const declaredLocale = (values.get(FIELDS.lang) ?? '').trim();
    if (isLocale(declaredLocale)) locale = declaredLocale;

    values.set(FIELDS.lang, locale);

    const cache = sharedCache();
    if (cache !== null) {
      const verdict = await hitRateLimit(cache, clientIp(request), Date.now());
      if (!verdict.allowed) {
        return fail(ERROR_CODES.rateLimited, { retryAfterSec: verdict.remainingSec });
      }
    }

    if ((values.get(HONEYPOT_FIELD) ?? '').trim() !== '') {
      return respondSuccess({ json, locale });
    }

    try {
      await bumpCounter(kv, 'attempt', Date.now());
    } catch {
      /* */
    }

    const validation = validateLead(toRecord(values));
    if (!validation.ok) return fail(validation.code, { fields: validation.fields });
    const lead = validation.lead;

    locale = lead.lang;

    const ip = clientIp(request);
    const verdict = await verifyTurnstile({
      secret: env.TURNSTILE_SECRET_KEY ?? '',
      token: extractTurnstileToken(values),

      remoteip: ip === LOCAL_IP_FALLBACK ? undefined : ip,
      budgetMs: TURNSTILE_BUDGET_MS,
      fetchImpl,
    });

    if (verdict.outcome === 'fail') {

      if (verdict.configError) {
        context.waitUntil(alertConfigError(env, cache).catch(() => undefined));
      }
      return fail(ERROR_CODES.captchaFailed);
    }

    const captchaSkippedWithToken = verdict.outcome === 'disabled' && verdict.tokenPresent;
    const captchaUnverified = verdict.outcome === 'unavailable' || captchaSkippedWithToken;

    if (captchaSkippedWithToken) {
      context.waitUntil(alertSecretMissing(env, cache).catch(() => undefined));
    }

    const host = new URL(request.url).host;
    const receivedAt = new Date().toISOString();
    const attr = parseAttribution(values.get(ATTRIBUTION_FIELD) ?? '');

    const payload = {
      [FIELDS.name]: lead.name,
      [FIELDS.contact]: lead.contact,
      [FIELDS.contactChannel]: lead.channel,
      [FIELDS.direction]: lead.direction,
      [FIELDS.lang]: lead.lang,
      attr,
      host,
      at: receivedAt,
      captcha_unverified: captchaUnverified,
    };

    let entry;
    try {
      entry = await writeLead(kv, {
        payload,
        metadata: {
          direction: lead.direction,
          source: attributionSource(attr),
          lang: lead.lang,
          channel: lead.channel,
          host,
        },
      });
    } catch {

      return fail(ERROR_CODES.internalError);
    }

    const text = buildLeadMessage({ lead, attr, host, at: receivedAt, captchaUnverified });
    const first = await sendMessage({
      token,
      chatId,
      text,
      fetchImpl,
      apiBase: apiBaseOf(env),
      timeoutMs: TELEGRAM_ATTEMPT_TIMEOUT_MS,
    });
    const disposition = classifyTelegramResult(first, 1);

    if (disposition.kind === 'delivered') {
      context.waitUntil(markDelivery(kv, entry, 'ok').catch(() => undefined));
    } else {
      const techChat = (env.TG_TECH_CHAT_ID ?? '').trim();
      context.waitUntil(
        deliverWithRetries({
          token,
          chatId,
          text,
          fetchImpl,
          sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
          apiBase: apiBaseOf(env),
          timeoutMs: TELEGRAM_ATTEMPT_TIMEOUT_MS,
          attemptsAlreadyMade: 1,
          nextDelayMs: disposition.kind === 'retry' ? disposition.delayMs : 0,
          alert: techChat === '' ? undefined : { chatId: techChat, leadKey: entry.key },
        })
          .then((result) => markDelivery(kv, entry, result.delivered ? 'ok' : 'failed'))

          .catch(() => undefined),
      );
    }

    return respondSuccess({ json, locale });
  } catch {

    return fail(ERROR_CODES.internalError);
  }
};
