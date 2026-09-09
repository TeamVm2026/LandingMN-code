
import { TELEGRAM_ATTEMPT_TIMEOUT_MS, sendMessage } from '../../src/server/lead/telegram.ts';
import type { FetchLike } from '../../src/server/lead/telegram.ts';
import { hitIpLimit } from '../../src/server/report/store.ts';
import type { ReportCache, ReportNamespace } from '../../src/server/report/store.ts';
import { hourBucketsOfWindow, readAttempts } from '../../src/server/report/counters.ts';
import type { AttemptsWindow, CounterKv } from '../../src/server/report/counters.ts';
import {
  EMPTY_NO_LEADS_STATE,
  EMPTY_UPTIME_STATE,
  NO_LEADS_MIN_ATTEMPTS,
  NO_LEADS_STATE_KEY,
  NO_LEADS_WINDOW_HOURS,
  PROBES_SNAPSHOT_KEY,
  UPTIME_ATTEMPTS_PER_CYCLE,
  UPTIME_CONSECUTIVE_FAILURES,
  UPTIME_STATE_KEY,
  buildNoLeadsAlert,
  buildUptimeAlert,
  decideNoLeadsAlert,
  decideUptimeAlert,
  nextNoLeadsState,
  nextUptimeState,
} from './monitor.ts';
import type { NoLeadsState, ProbeResult, UptimeState } from './monitor.ts';
import type { BotEnv } from './webhook.ts';

export const UPTIME_CRON = '*/5 * * * *';

export const NO_LEADS_CRON = '0 * * * *';

export const PROBE_TIMEOUT_MS = 5000;

export const PROBE_RETRY_DELAY_MS = 1000;

export const SNAPSHOT_MIN_INTERVAL_MS = 15 * 60 * 1000;

export const MONITOR_NS: ReportNamespace = {
  keyOrigin: 'https://monitor-admin.invalid',
  label: 'моделирование мониторинга',
};

export interface ProbeTarget {
  readonly label: string;
  readonly path: string;
  readonly expected: number;
}

export const PROBE_TARGETS: readonly ProbeTarget[] = [
  { label: 'корень сайта', path: '/', expected: 200 },
  { label: 'здоровье', path: '/api/health', expected: 200 },

  { label: 'приём заявок (GET, без побочных эффектов)', path: '/api/lead', expected: 405 },
];

export interface MonitorKv extends CounterKv {
  list(options: {
    prefix: string;
    limit?: number;
  }): Promise<{ keys: { name: string }[]; list_complete: boolean }>;
}

export interface MonitorEnv extends Omit<BotEnv, 'LEADS'> {
  LEADS?: MonitorKv;
  MONITOR_TARGET_URL?: string;
}

export interface MonitorDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  cache?: ReportCache | null;
}

function fetchOf(deps: MonitorDeps): FetchLike {
  return deps.fetchImpl ?? ((url, init) => fetch(url, init));
}

function nowOf(deps: MonitorDeps): number {
  return (deps.now ?? Date.now)();
}

function sleepOf(deps: MonitorDeps): (ms: number) => Promise<void> {
  return deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

export function monitorTarget(env: MonitorEnv): string {
  const raw = (env.MONITOR_TARGET_URL ?? '').trim();
  if (raw === '') return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function describeDrop(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw.slice(0, 160);
}

export async function probeOnce(
  target: ProbeTarget,
  base: string,
  deps: MonitorDeps = {},
): Promise<ProbeResult> {
  const url = `${base}${target.path}`;
  const fetchImpl = fetchOf(deps);
  const sleep = sleepOf(deps);

  let status: number | null = null;
  let error = '';
  let ms = 0;
  let attempts = 0;

  for (let i = 0; i < UPTIME_ATTEMPTS_PER_CYCLE; i++) {
    attempts++;
    const started = nowOf(deps);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',

        headers: { 'user-agent': 'landingmn-bot-monitor' },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      status = response.status;
      error = '';
    } catch (caught) {
      status = null;
      error = describeDrop(caught);
    }
    ms = nowOf(deps) - started;
    if (status === target.expected) break;
    if (i + 1 < UPTIME_ATTEMPTS_PER_CYCLE) await sleep(PROBE_RETRY_DELAY_MS);
  }

  return {
    label: target.label,
    url,
    expected: target.expected,
    status,
    attempts,
    ms,
    error,
    at: nowOf(deps),
  };
}

export async function runProbes(base: string, deps: MonitorDeps = {}): Promise<ProbeResult[]> {
  return Promise.all(PROBE_TARGETS.map((target) => probeOnce(target, base, deps)));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export async function readUptimeState(kv: MonitorKv): Promise<UptimeState> {
  try {
    const raw = asRecord(await kv.get(UPTIME_STATE_KEY, 'json'));
    const fails = numberOrNull(raw.fails);
    if (fails === null || fails < 0) return EMPTY_UPTIME_STATE;
    return { fails, alerted: raw.alerted === true, since: numberOrNull(raw.since) };
  } catch {
    return EMPTY_UPTIME_STATE;
  }
}

export async function readNoLeadsState(kv: MonitorKv): Promise<NoLeadsState> {
  try {
    const raw = asRecord(await kv.get(NO_LEADS_STATE_KEY, 'json'));
    return { alerted: raw.alerted === true, since: numberOrNull(raw.since) };
  } catch {
    return EMPTY_NO_LEADS_STATE;
  }
}

async function writeStateIfChanged(
  kv: MonitorKv,
  key: string,
  previous: unknown,
  next: unknown,
): Promise<boolean> {
  if (JSON.stringify(previous) === JSON.stringify(next)) return false;
  try {
    await kv.put(key, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

export interface ProbesSnapshot {
  readonly at: number;
  readonly target: string;
  readonly probes: readonly ProbeResult[];
}

export async function readSnapshot(kv: MonitorKv): Promise<ProbesSnapshot | null> {
  try {
    const raw = asRecord(await kv.get(PROBES_SNAPSHOT_KEY, 'json'));
    const at = numberOrNull(raw.at);
    if (at === null || !Array.isArray(raw.probes)) return null;
    return { at, target: typeof raw.target === 'string' ? raw.target : '', probes: raw.probes as ProbeResult[] };
  } catch {
    return null;
  }
}

export interface DeliveryOutcome {
  readonly ok: boolean;
  readonly messageId: number | null;
  readonly status: number | null;
  readonly reason: string;
}

export async function tellTechChat(
  env: MonitorEnv,
  deps: MonitorDeps,
  text: string,
): Promise<DeliveryOutcome> {
  const techChat = (env.TG_TECH_CHAT_ID ?? '').trim();
  const token = (env.TG_BOT_TOKEN ?? '').trim();
  if (techChat === '' || token === '') {
    return { ok: false, messageId: null, status: null, reason: 'техчат или токен не заданы' };
  }
  try {
    const result = await sendMessage({
      token,
      chatId: techChat,
      text,
      fetchImpl: fetchOf(deps),
      apiBase: env.TG_API_BASE,
      timeoutMs: TELEGRAM_ATTEMPT_TIMEOUT_MS,
    });
    const body = asRecord(result.body);
    const messageId = numberOrNull(asRecord(body.result).message_id);
    return {
      ok: result.status === 200 && body.ok === true,
      messageId,
      status: result.status,
      reason: body.ok === true ? '' : String(body.description ?? result.error ?? '').slice(0, 200),
    };
  } catch {
    return { ok: false, messageId: null, status: null, reason: 'исключение при отправке' };
  }
}

export interface UptimeCycleOutcome {
  readonly ran: boolean;
  readonly reason: string;
  readonly probes: readonly ProbeResult[];
  readonly decision: 'alert' | 'recovered' | 'silent';
  readonly state: UptimeState;
  readonly delivery: DeliveryOutcome | null;
}

export async function runUptimeCycle(
  env: MonitorEnv,
  deps: MonitorDeps = {},
): Promise<UptimeCycleOutcome> {
  const kv = env.LEADS;
  const base = monitorTarget(env);
  const silent = {
    decision: 'silent' as const,
    probes: [] as ProbeResult[],
    state: EMPTY_UPTIME_STATE,
    delivery: null,
  };

  if (kv === undefined) return { ran: false, reason: 'KV не привязан', ...silent };
  if (base === '') return { ran: false, reason: 'MONITOR_TARGET_URL не задан или не https', ...silent };

  const now = nowOf(deps);
  const prevState = await readUptimeState(kv);
  const probes = await runProbes(base, deps);
  const decision = decideUptimeAlert({ probes, prevState, now });
  const state = nextUptimeState({ probes, prevState, now });

  await writeStateIfChanged(kv, UPTIME_STATE_KEY, prevState, state);

  const snapshot = await readSnapshot(kv);
  const stale = snapshot === null || now - snapshot.at >= SNAPSHOT_MIN_INTERVAL_MS;
  if (stale || decision !== 'silent' || state.fails > 0) {
    try {
      await kv.put(PROBES_SNAPSHOT_KEY, JSON.stringify({ at: now, target: base, probes }));
    } catch {
      /* */
    }
  }

  let delivery: DeliveryOutcome | null = null;
  if (decision !== 'silent') {
    delivery = await tellTechChat(
      env,
      deps,
      buildUptimeAlert({ kind: decision, probes, state: decision === 'recovered' ? prevState : state, target: base, now }),
    );
  }

  return { ran: true, reason: '', probes, decision, state, delivery };
}

export async function countLeads(
  kv: MonitorKv,
  now: number,
  windowHours: number,
): Promise<{ total: number; truncated: boolean }> {
  let total = 0;
  let truncated = false;
  for (const bucket of hourBucketsOfWindow(now, windowHours)) {
    for (const prefix of ['lead:', 'bot:']) {
      try {
        const page = await kv.list({ prefix: `${prefix}${bucket}` });
        total += page.keys.length;
        if (!page.list_complete) truncated = true;
      } catch {

        /* */
      }
    }
  }
  return { total, truncated };
}

export interface NoLeadsCycleOutcome {
  readonly ran: boolean;
  readonly reason: string;
  readonly attempts: AttemptsWindow | null;
  readonly leads: number;
  readonly decision: 'alert' | 'recovered' | 'silent';
  readonly state: NoLeadsState;
  readonly delivery: DeliveryOutcome | null;
}

export async function runNoLeadsCycle(
  env: MonitorEnv,
  deps: MonitorDeps = {},
): Promise<NoLeadsCycleOutcome> {
  const kv = env.LEADS;
  if (kv === undefined) {
    return {
      ran: false,
      reason: 'KV не привязан',
      attempts: null,
      leads: 0,
      decision: 'silent',
      state: EMPTY_NO_LEADS_STATE,
      delivery: null,
    };
  }

  const now = nowOf(deps);
  const prevState = await readNoLeadsState(kv);
  const attempts = await readAttempts(kv, now, NO_LEADS_WINDOW_HOURS);
  const leads = (await countLeads(kv, now, NO_LEADS_WINDOW_HOURS)).total;

  const input = {
    attempts: attempts.total,
    leads,
    windowHours: NO_LEADS_WINDOW_HOURS,
    prevState,
    now,
  };
  const decision = decideNoLeadsAlert(input);
  const state = nextNoLeadsState(input);
  await writeStateIfChanged(kv, NO_LEADS_STATE_KEY, prevState, state);

  let delivery: DeliveryOutcome | null = null;
  if (decision !== 'silent') {
    delivery = await tellTechChat(
      env,
      deps,
      buildNoLeadsAlert({
        kind: decision,
        attempts: attempts.total,
        leads,
        windowHours: NO_LEADS_WINDOW_HOURS,
        formAttempts: attempts.form,
        startAttempts: attempts.start,
        now,
      }),
    );
  }

  return { ran: true, reason: '', attempts, leads, decision, state, delivery };
}

export interface MonitorStateReport {
  target: string;
  crons: { uptime: string; no_leads: string };
  thresholds: {
    consecutive_failures: number;
    attempts_per_cycle: number;
    window_hours: number;
    min_attempts: number;
    probe_timeout_ms: number;
  };
  uptime: {
    state: UptimeState;
    snapshot_at: number | null;
    snapshot_age_ms: number | null;
    probes: readonly ProbeResult[];
  };
  no_leads: {
    state: NoLeadsState;
    attempts: AttemptsWindow | null;
    leads: number;
    leads_truncated: boolean;
  };
  tech_chat_configured: boolean;
}

export async function collectMonitorState(
  env: MonitorEnv,
  deps: MonitorDeps = {},
): Promise<MonitorStateReport> {
  const now = nowOf(deps);
  const kv = env.LEADS;
  const snapshot = kv === undefined ? null : await readSnapshot(kv);
  const leads = kv === undefined ? { total: 0, truncated: false } : await countLeads(kv, now, NO_LEADS_WINDOW_HOURS);

  return {
    target: monitorTarget(env),
    crons: { uptime: UPTIME_CRON, no_leads: NO_LEADS_CRON },
    thresholds: {
      consecutive_failures: UPTIME_CONSECUTIVE_FAILURES,
      attempts_per_cycle: UPTIME_ATTEMPTS_PER_CYCLE,
      window_hours: NO_LEADS_WINDOW_HOURS,
      min_attempts: NO_LEADS_MIN_ATTEMPTS,
      probe_timeout_ms: PROBE_TIMEOUT_MS,
    },
    uptime: {
      state: kv === undefined ? EMPTY_UPTIME_STATE : await readUptimeState(kv),
      snapshot_at: snapshot?.at ?? null,
      snapshot_age_ms: snapshot === null ? null : now - snapshot.at,
      probes: snapshot?.probes ?? [],
    },
    no_leads: {
      state: kv === undefined ? EMPTY_NO_LEADS_STATE : await readNoLeadsState(kv),
      attempts: kv === undefined ? null : await readAttempts(kv, now, NO_LEADS_WINDOW_HOURS),
      leads: leads.total,
      leads_truncated: leads.truncated,
    },
    tech_chat_configured: (env.TG_TECH_CHAT_ID ?? '').trim() !== '',
  };
}

export type SimulateKind = 'uptime' | 'no-leads';

export interface SimulateOutcome {
  readonly kind: SimulateKind;
  readonly text: string;
  readonly delivery: DeliveryOutcome;
}

export async function simulateAlert(
  env: MonitorEnv,
  kind: SimulateKind,
  deps: MonitorDeps = {},
): Promise<SimulateOutcome> {
  const now = nowOf(deps);
  const base = monitorTarget(env);
  const target = base === '' ? '(MONITOR_TARGET_URL не задан)' : base;

  if (kind === 'uptime') {
    const probes: ProbeResult[] = [
      {
        label: PROBE_TARGETS[0].label,
        url: `${target}${PROBE_TARGETS[0].path}`,
        expected: PROBE_TARGETS[0].expected,
        status: 503,
        attempts: UPTIME_ATTEMPTS_PER_CYCLE,
        ms: 412,
        error: '',
        at: now,
      },
      {
        label: PROBE_TARGETS[2].label,
        url: `${target}${PROBE_TARGETS[2].path}`,
        expected: PROBE_TARGETS[2].expected,
        status: null,
        attempts: UPTIME_ATTEMPTS_PER_CYCLE,
        ms: PROBE_TIMEOUT_MS,
        error: 'TimeoutError: signal timed out',
        at: now,
      },
    ];
    const text = buildUptimeAlert({
      kind: 'alert',
      probes,
      state: { fails: UPTIME_CONSECUTIVE_FAILURES, alerted: true, since: now - 5 * 60 * 1000 },
      target,
      now,
      simulated: true,
    });
    return { kind, text, delivery: await tellTechChat(env, deps, text) };
  }

  const text = buildNoLeadsAlert({
    kind: 'alert',
    attempts: NO_LEADS_MIN_ATTEMPTS + 1,
    leads: 0,
    windowHours: NO_LEADS_WINDOW_HOURS,
    formAttempts: NO_LEADS_MIN_ATTEMPTS,
    startAttempts: 1,
    now,
    simulated: true,
  });
  return { kind, text, delivery: await tellTechChat(env, deps, text) };
}

export async function allowSimulate(
  request: Request,
  deps: MonitorDeps = {},
): Promise<{ allowed: boolean; count: number }> {
  const cache = deps.cache === undefined ? sharedCache() : deps.cache;
  if (cache === null) return { allowed: true, count: 0 };
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local-dev';
  return hitIpLimit(cache, ip, nowOf(deps), MONITOR_NS);
}

function sharedCache(): ReportCache | null {
  const store = (globalThis as { caches?: { default?: ReportCache } }).caches;
  return store?.default ?? null;
}
