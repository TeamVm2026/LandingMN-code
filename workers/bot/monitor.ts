
import { escapeHtml, formatReceivedAt } from '../../src/server/lead/message.ts';

export const UPTIME_CONSECUTIVE_FAILURES = 2;

export const UPTIME_ATTEMPTS_PER_CYCLE = 2;

export const NO_LEADS_WINDOW_HOURS = 3;

export const NO_LEADS_MIN_ATTEMPTS = 2;

export const MONITOR_STATE_PREFIX = 'mon:state:';

export const UPTIME_STATE_KEY = `${MONITOR_STATE_PREFIX}uptime`;

export const NO_LEADS_STATE_KEY = `${MONITOR_STATE_PREFIX}no-leads`;

export const PROBES_SNAPSHOT_KEY = 'mon:probes:last';

export type ProbeOutcome = 'ok' | 'down' | 'unreachable';

export interface ProbeResult {

  readonly label: string;

  readonly url: string;

  readonly expected: number;

  readonly status: number | null;

  readonly attempts: number;

  readonly ms: number;

  readonly error: string;

  readonly at: number;
}

export interface UptimeState {

  readonly fails: number;

  readonly alerted: boolean;

  readonly since: number | null;
}

export interface NoLeadsState {
  readonly alerted: boolean;
  readonly since: number | null;
}

export type AlertDecision = 'alert' | 'recovered' | 'silent';

export const EMPTY_UPTIME_STATE: UptimeState = { fails: 0, alerted: false, since: null };

export const EMPTY_NO_LEADS_STATE: NoLeadsState = { alerted: false, since: null };

export function probeOutcome(probe: ProbeResult): ProbeOutcome {
  if (probe.status === null) return 'unreachable';
  return probe.status === probe.expected ? 'ok' : 'down';
}

export function cycleFailed(probes: readonly ProbeResult[]): boolean {
  if (probes.length === 0) return false;
  return probes.some((probe) => probeOutcome(probe) !== 'ok');
}

export interface UptimeInput {
  readonly probes: readonly ProbeResult[];
  readonly prevState: UptimeState;
  readonly now: number;
}

export function nextUptimeState({ probes, prevState, now }: UptimeInput): UptimeState {
  if (!cycleFailed(probes)) return EMPTY_UPTIME_STATE;
  const fails = prevState.fails + 1;
  return {
    fails,

    alerted: prevState.alerted || fails >= UPTIME_CONSECUTIVE_FAILURES,
    since: prevState.since ?? now,
  };
}

export function decideUptimeAlert({ probes, prevState }: UptimeInput): AlertDecision {
  if (!cycleFailed(probes)) return prevState.alerted ? 'recovered' : 'silent';
  if (prevState.alerted) return 'silent';
  return prevState.fails + 1 >= UPTIME_CONSECUTIVE_FAILURES ? 'alert' : 'silent';
}

export interface NoLeadsInput {

  readonly attempts: number;

  readonly leads: number;

  readonly windowHours: number;
  readonly prevState: NoLeadsState;
  readonly now: number;
}

function noLeadsTriggered({ attempts, leads }: NoLeadsInput): boolean {
  return attempts >= NO_LEADS_MIN_ATTEMPTS && leads === 0;
}

export function nextNoLeadsState(input: NoLeadsInput): NoLeadsState {
  if (input.leads > 0) return EMPTY_NO_LEADS_STATE;
  if (noLeadsTriggered(input)) {
    return { alerted: true, since: input.prevState.since ?? input.now };
  }
  return input.prevState;
}

export function decideNoLeadsAlert(input: NoLeadsInput): AlertDecision {
  if (input.leads > 0) return input.prevState.alerted ? 'recovered' : 'silent';
  if (input.prevState.alerted) return 'silent';
  return noLeadsTriggered(input) ? 'alert' : 'silent';
}

function humanDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${String(h)} ч ${String(m)} мин`;
  if (m > 0) return `${String(m)} мин ${String(s)} с`;
  return `${String(s)} с`;
}

function probeLine(probe: ProbeResult): string {
  const head = `${escapeHtml(probe.label)} <code>${escapeHtml(probe.url)}</code>`;
  const tail = `попыток: ${String(probe.attempts)}, ${String(probe.ms)} мс`;
  switch (probeOutcome(probe)) {
    case 'ok':
      return `✅ ${head} — ${String(probe.status ?? 0)} (${tail})`;
    case 'down':
      return (
        `⛔ ОТКАЗ: ${head} — ответил <b>${String(probe.status ?? 0)}</b>, ожидался ` +
        `${String(probe.expected)} (${tail}). Сервис жив и отвечает НЕПРАВИЛЬНО.`
      );
    default:
      return (
        `⚠️ ОБРЫВ: ${head} — ответа не пришло вовсе (${tail}): ` +
        `${escapeHtml(probe.error === '' ? 'без описания' : probe.error)}. ` +
        'Это может быть сеть между наблюдателем и сайтом, а не сам сайт.'
      );
  }
}

export interface UptimeAlertInput {
  readonly kind: Extract<AlertDecision, 'alert' | 'recovered'>;
  readonly probes: readonly ProbeResult[];
  readonly state: UptimeState;
  readonly target: string;
  readonly now: number;

  readonly simulated?: boolean;
}

export function buildUptimeAlert(input: UptimeAlertInput): string {
  const mark = input.simulated === true ? '🧪 <b>МОДЕЛИРОВАНИЕ</b> (не авария) — ' : '';
  const when = escapeHtml(formatReceivedAt(new Date(input.now)));
  const lines = input.probes.map(probeLine);

  if (input.kind === 'recovered') {
    const downFor =
      input.state.since === null
        ? ''
        : ` Отказ длился ${humanDuration(input.now - input.state.since)}.`;
    return (
      `${mark}✅ <b>Мониторинг: сайт снова отвечает</b>\n` +
      `Наблюдаемый адрес: <code>${escapeHtml(input.target)}</code>\n` +
      `Время: ${when}.${escapeHtml(downFor)}\n\n` +
      lines.join('\n')
    );
  }

  const failing = input.probes.filter((probe) => probeOutcome(probe) !== 'ok');
  const kinds = new Set(failing.map(probeOutcome));
  const verdict = kinds.has('down')
    ? 'сайт отвечает НЕ ТЕМ кодом — чинить сайт'
    : 'ответа нет вовсе — сначала проверить сеть и край Cloudflare, потом сайт';

  return (
    `${mark}⛔ <b>Мониторинг: проба доступности не проходит</b>\n` +
    `Наблюдаемый адрес: <code>${escapeHtml(input.target)}</code>\n` +
    `Неудачных циклов подряд: <b>${String(input.state.fails)}</b> ` +
    `(порог ${String(UPTIME_CONSECUTIVE_FAILURES)}, цикл 5 мин).\n` +
    `Время: ${when}.\n\n` +
    `${lines.join('\n')}\n\n` +
    `Вердикт: ${escapeHtml(verdict)}.\n` +
    'Разбор: docs/ops.md §14.'
  );
}

export interface NoLeadsAlertInput {
  readonly kind: Extract<AlertDecision, 'alert' | 'recovered'>;
  readonly attempts: number;
  readonly leads: number;
  readonly windowHours: number;
  readonly now: number;

  readonly formAttempts: number;
  readonly startAttempts: number;
  readonly simulated?: boolean;
}

export function buildNoLeadsAlert(input: NoLeadsAlertInput): string {
  const mark = input.simulated === true ? '🧪 <b>МОДЕЛИРОВАНИЕ</b> (не авария) — ' : '';
  const when = escapeHtml(formatReceivedAt(new Date(input.now)));
  const windowText = `${String(input.windowHours)} ч`;

  if (input.kind === 'recovered') {
    return (
      `${mark}✅ <b>Мониторинг: лиды снова доходят</b>\n` +
      `За последние ${windowText}: попыток ${String(input.attempts)}, ` +
      `лидов <b>${String(input.leads)}</b>.\n` +
      `Время: ${when}.`
    );
  }

  return (
    `${mark}⛔ <b>Мониторинг: попытки есть, лидов нет</b>\n` +
    `Окно: последние ${windowText}.\n` +
    `Попыток воронки: <b>${String(input.attempts)}</b> ` +
    `(форма ${String(input.formAttempts)}, /start ${String(input.startAttempts)}), ` +
    `порог ${String(NO_LEADS_MIN_ATTEMPTS)}.\n` +
    `Лидов в журнале (<code>lead:</code> + <code>bot:</code>): <b>${String(input.leads)}</b>.\n` +
    `Время: ${when}.\n\n` +
    'Люди нажимают «отправить», а заявка не доезжает. Смотреть: Turnstile, ' +
    'секреты приёмника, доставку в Telegram.\n' +
    '⚠️ «Попытки» — это отправки формы и валидные /start, а НЕ просмотры страниц ' +
    '(почему именно так — docs/ops.md §14).\n' +
    'Разбор: docs/ops.md §14.'
  );
}
