
import { TELEGRAM_API_BASE, TELEGRAM_ATTEMPT_TIMEOUT_MS } from '../../src/server/lead/telegram.ts';
import type { FetchLike } from '../../src/server/lead/telegram.ts';
import { WEBHOOK_PATH, hideToken, timingSafeEqualStr } from './webhook.ts';
import type { BotEnv } from './webhook.ts';
import { allowSimulate, collectMonitorState, simulateAlert } from './monitor-run.ts';
import type { MonitorDeps, MonitorEnv } from './monitor-run.ts';

export const ADMIN_TOKEN_HEADER = 'X-Bot-Admin-Token';

const ALLOWED_UPDATES = ['message'] as const;

const MAX_CONNECTIONS = 5;

export interface AdminDeps {
  fetchImpl?: FetchLike;
}

interface ApiOutcome {
  ok: boolean;
  status: number | null;
  description: string;
  result: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',

      'cache-control': 'no-store',
    },
  });
}

function empty(status: number): Response {
  return new Response(null, { status });
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

async function callBotApi(
  env: BotEnv,
  deps: AdminDeps,
  method: string,
  params: Record<string, unknown>,
): Promise<ApiOutcome> {
  const token = (env.TG_BOT_TOKEN ?? '').trim();
  const base = (env.TG_API_BASE ?? TELEGRAM_API_BASE).replace(/\/+$/, '');
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  try {
    const response = await fetchImpl(`${base}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(TELEGRAM_ATTEMPT_TIMEOUT_MS),
    });
    const parsed = asRecord(await response.json().catch(() => null));
    return {
      ok: response.status === 200 && parsed.ok === true,
      status: response.status,
      description: hideToken(asText(parsed.description), token),
      result: parsed.result ?? null,
    };
  } catch (error) {
    const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { ok: false, status: null, description: hideToken(raw, token).slice(0, 300), result: null };
  }
}

function guardOrigin(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  return parsed.origin;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const text = await request.text();
    if (text.trim() === '') return {};
    return asRecord(JSON.parse(text));
  } catch {
    return {};
  }
}

function witnessOf(value: string): { len: number; tail4: string } {
  return { len: value.length, tail4: value.length === 0 ? '' : value.slice(-4) };
}

function versionIdOf(env: BotEnv): string | null {
  const meta = asRecord((env as Record<string, unknown>).CF_VERSION_METADATA);
  const id = asText(meta.id);
  return id === '' ? null : id;
}

async function diag(env: BotEnv, deps: AdminDeps): Promise<Response> {
  const me = await callBotApi(env, deps, 'getMe', {});
  const hook = await callBotApi(env, deps, 'getWebhookInfo', {});

  const bot = asRecord(me.result);
  const webhook = asRecord(hook.result);
  const chatWitness = witnessOf((env.TG_CHAT_ID ?? '').trim());
  const secretWitness = witnessOf((env.TG_WEBHOOK_SECRET ?? '').trim());

  return json({
    bot: {
      id: asNumber(bot.id),
      username: asText(bot.username),
      first_name: asText(bot.first_name),
      can_join_groups: asBool(bot.can_join_groups),
      ok: me.ok,
      error: me.ok ? '' : me.description,
    },
    webhook: {
      url: asText(webhook.url),
      has_custom_certificate: asBool(webhook.has_custom_certificate),
      pending_update_count: asNumber(webhook.pending_update_count),
      last_error_date: asNumber(webhook.last_error_date),
      last_error_message: asText(webhook.last_error_message),
      max_connections: asNumber(webhook.max_connections),
      allowed_updates: Array.isArray(webhook.allowed_updates) ? webhook.allowed_updates : [],
      ok: hook.ok,
      error: hook.ok ? '' : hook.description,
    },
    config: {

      manager_contact_url: (env.MANAGER_CONTACT_URL ?? '').trim(),
      tg_chat_id_len: chatWitness.len,
      tg_chat_id_tail4: chatWitness.tail4,
      tg_webhook_secret_len: secretWitness.len,
      version_id: versionIdOf(env),
    },
  });
}

async function registerWebhook(
  request: Request,
  env: BotEnv,
  deps: AdminDeps,
): Promise<Response> {
  const secret = (env.TG_WEBHOOK_SECRET ?? '').trim();

  if (secret === '') return json({ ok: false, reason: 'TG_WEBHOOK_SECRET не задан' }, 503);

  const body = await readJsonBody(request);
  const requested = asText(body.origin).trim();
  const origin = requested === '' ? new URL(request.url).origin : guardOrigin(requested);
  if (origin === null) {
    return json({ ok: false, reason: 'origin обязан быть абсолютным https-адресом' }, 400);
  }

  const outcome = await callBotApi(env, deps, 'setWebhook', {
    url: `${origin}${WEBHOOK_PATH}`,
    secret_token: secret,
    allowed_updates: [...ALLOWED_UPDATES],
    max_connections: MAX_CONNECTIONS,

    drop_pending_updates: false,
  });

  return json({ ...outcome, url: `${origin}${WEBHOOK_PATH}` });
}

async function removeWebhook(env: BotEnv, deps: AdminDeps): Promise<Response> {
  const outcome = await callBotApi(env, deps, 'deleteWebhook', { drop_pending_updates: false });
  return json(outcome);
}

async function setProfile(request: Request, env: BotEnv, deps: AdminDeps): Promise<Response> {
  const body = await readJsonBody(request);
  const description = asText(body.description);
  const shortDescription = asText(body.shortDescription);
  const commands = Array.isArray(body.commands) ? body.commands : null;

  const languageCode = asText(body.language_code).trim();
  const withLang = (params: Record<string, unknown>): Record<string, unknown> =>
    languageCode === '' ? params : { ...params, language_code: languageCode };

  const skipped = (what: string): ApiOutcome & { skipped: true } => ({
    ok: false,
    status: null,
    description: `${what} не передан в теле запроса — вызов пропущен`,
    result: null,
    skipped: true,
  });

  return json({
    setMyDescription:
      description === ''
        ? skipped('description')
        : await callBotApi(env, deps, 'setMyDescription', withLang({ description })),
    setMyShortDescription:
      shortDescription === ''
        ? skipped('shortDescription')
        : await callBotApi(
            env,
            deps,
            'setMyShortDescription',
            withLang({ short_description: shortDescription }),
          ),
    setMyCommands:
      commands === null
        ? skipped('commands')
        : await callBotApi(env, deps, 'setMyCommands', withLang({ commands })),
  });
}

async function monitor(request: Request, env: BotEnv, deps: AdminDeps): Promise<Response> {

  const monitorEnv = env as MonitorEnv;
  const monitorDeps: MonitorDeps = deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl };
  const requested = new URL(request.url).searchParams.get('simulate');

  if (requested === null || requested === '') {
    return json(await collectMonitorState(monitorEnv, monitorDeps));
  }

  if (requested !== 'uptime' && requested !== 'no-leads') {
    return json({ ok: false, reason: 'simulate принимает только uptime или no-leads' }, 400);
  }

  const limit = await allowSimulate(request, monitorDeps);
  if (!limit.allowed) {
    return json(
      { ok: false, reason: 'моделирование ограничено по частоте', count: limit.count },
      429,
    );
  }

  if ((env.TG_TECH_CHAT_ID ?? '').trim() === '') {
    return json({ ok: false, reason: 'TG_TECH_CHAT_ID не задан — слать некуда' }, 503);
  }

  const outcome = await simulateAlert(monitorEnv, requested, monitorDeps);
  return json(
    {
      ok: outcome.delivery.ok,
      simulate: outcome.kind,

      message_id: outcome.delivery.messageId,
      chat: 'tech',
      status: outcome.delivery.status,
      reason: outcome.delivery.reason,
      text: outcome.text,
    },
    outcome.delivery.ok ? 200 : 502,
  );
}

export async function handleAdmin(
  request: Request,
  env: BotEnv,
  deps: AdminDeps = {},
): Promise<Response> {

  const adminToken = (env.BOT_ADMIN_TOKEN ?? '').trim();
  if (adminToken.length === 0) return empty(401);
  const presented = request.headers.get(ADMIN_TOKEN_HEADER) ?? '';
  if (!timingSafeEqualStr(presented, adminToken)) return empty(401);

  if ((env.TG_BOT_TOKEN ?? '').trim() === '') {
    return json({ ok: false, reason: 'TG_BOT_TOKEN не задан' }, 503);
  }

  const { pathname } = new URL(request.url);
  const method = request.method;

  if (method === 'GET' && pathname === '/admin/diag') return diag(env, deps);
  if (method === 'GET' && pathname === '/admin/monitor') return monitor(request, env, deps);
  if (method === 'POST' && pathname === '/admin/webhook') return registerWebhook(request, env, deps);
  if (method === 'POST' && pathname === '/admin/webhook/delete') return removeWebhook(env, deps);
  if (method === 'POST' && pathname === '/admin/profile') return setProfile(request, env, deps);

  return empty(404);
}
