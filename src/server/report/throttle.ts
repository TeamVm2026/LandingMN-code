
export const DEDUP_WINDOW_MS = 60 * 60 * 1000;

export const HOURLY_CAP = 10;

export const IP_WINDOW_MS = 60 * 1000;
export const IP_MAX_PER_WINDOW = 10;

export const IP_SHARE_OF_CAP = 3;

export const CLIENT_MAX_PER_PAGELOAD = 3;

export const REPORT_BODY_MAX_BYTES = 4 * 1024;

export const MESSAGE_MAX = 500;
export const SOURCE_MAX = 200;
export const ROUTE_MAX = 120;
export const LOCALE_MAX = 8;
export const UA_MAX = 200;

export const REPORT_KINDS = ['js-error', 'promise'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export interface ClientReport {
  kind: ReportKind;
  message: string;

  source: string;
  line: number | null;
  col: number | null;

  route: string;
  locale: string;
  ua: string;
}

export interface SeenRecord {
  firstSeenAt: number;
}

export interface HourWindow {

  start: number;

  delivered: number;

  noticed: boolean;
}

export type DeliveryDecision =
  | { kind: 'deliver'; key: string }
  | { kind: 'duplicate'; key: string; firstSeenAt: number }
  | { kind: 'cap-notice'; key: string; cap: number; until: number }
  | { kind: 'capped'; key: string; cap: number; until: number }

  | { kind: 'ip-capped'; key: string; share: number };

export interface DeliveryInput {
  key: string;
  now: number;
  seen: SeenRecord | null;
  window: HourWindow | null;

  ipDelivered?: number;

  limits?: { dedupWindowMs?: number; hourlyCap?: number; ipShareOfCap?: number };
}

function clamp(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';

  return value.trim().slice(0, max);
}

function clampNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;

  if (value < 0 || value > 10_000_000) return null;
  return Math.trunc(value);
}

export function normalizeReport(raw: unknown): ClientReport | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const kind = record.kind;
  if (typeof kind !== 'string' || !(REPORT_KINDS as readonly string[]).includes(kind)) return null;

  const message = clamp(record.message, MESSAGE_MAX);
  if (message === '') return null;

  return {
    kind: kind as ReportKind,
    message,
    source: clamp(record.source, SOURCE_MAX),
    line: clampNumber(record.line),
    col: clampNumber(record.col),
    route: clamp(record.route, ROUTE_MAX),
    locale: clamp(record.locale, LOCALE_MAX),
    ua: clamp(record.ua, UA_MAX),
  };
}

export async function reportKey(
  input: Pick<ClientReport, 'kind' | 'message' | 'source' | 'line' | 'col'>,
): Promise<string> {
  const material = JSON.stringify([
    input.kind,
    input.message,
    input.source,
    input.line,
    input.col,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function decideDelivery(input: DeliveryInput): DeliveryDecision {
  const dedupWindowMs = input.limits?.dedupWindowMs ?? DEDUP_WINDOW_MS;
  const hourlyCap = input.limits?.hourlyCap ?? HOURLY_CAP;
  const { key, now, seen } = input;

  if (seen !== null && now - seen.firstSeenAt < dedupWindowMs) {
    return { kind: 'duplicate', key, firstSeenAt: seen.firstSeenAt };
  }

  const live = liveWindow(input.window, now, dedupWindowMs);

  const ipShare = input.limits?.ipShareOfCap ?? IP_SHARE_OF_CAP;
  if (live !== null && (input.ipDelivered ?? 0) >= ipShare) {
    return { kind: 'ip-capped', key, share: ipShare };
  }

  if (live === null || live.delivered < hourlyCap) {
    return { kind: 'deliver', key };
  }

  const until = live.start + dedupWindowMs;
  return live.noticed
    ? { kind: 'capped', key, cap: hourlyCap, until }
    : { kind: 'cap-notice', key, cap: hourlyCap, until };
}

function liveWindow(window: HourWindow | null, now: number, windowMs: number): HourWindow | null {
  if (window === null) return null;
  return now - window.start < windowMs ? window : null;
}

export function nextWindow(
  window: HourWindow | null,
  now: number,
  decision: DeliveryDecision,
  limits?: { dedupWindowMs?: number },
): HourWindow | null {
  const windowMs = limits?.dedupWindowMs ?? DEDUP_WINDOW_MS;
  const live = liveWindow(window, now, windowMs);

  if (decision.kind === 'deliver') {
    return live === null
      ? { start: now, delivered: 1, noticed: false }
      : { start: live.start, delivered: live.delivered + 1, noticed: live.noticed };
  }

  if (decision.kind === 'cap-notice') {

    return live === null ? null : { ...live, noticed: true };
  }

  return live;
}
