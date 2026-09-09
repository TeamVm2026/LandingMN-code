
export const ATTRIBUTION_KEY = 'lmn_attr';

export const ATTRIBUTION_VERSION = 1;

export const ATTRIBUTION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export const VALUE_MAX_LEN = 100;

export const CAPTURED_PARAMS = [

  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',

  'gclid',
  'fbclid',
  'ttclid',

  'bm_uid',
  'sub_id',
  'sub_id_1',
  'sub_id_2',

  's',
] as const;

export const PRIORITY_MARKS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
] as const;

export interface AttrTouch {

  ts: number;

  m: Record<string, string>;

  ref: string;

  lp: string;
}

export interface AttrRecord {

  v: number;

  ft: AttrTouch;

  fc: AttrTouch | null;

  lt: AttrTouch;

  n: number;
}

export interface AttrSummary {

  source: string;
  campaign: string;
  medium: string;

  lastSource: string;
  touches: number;
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// eslint-disable-next-line no-control-regex
const DANGEROUS_CHARS = /[<>&"'`]|[\u0000-\u001F\u007F]/g;

const KEY_MAX_LEN = 32;

export const MARKS_MAX_COUNT = 12;

function sanitizeMark(value: string): string {
  return value.replace(DANGEROUS_CHARS, '').slice(0, VALUE_MAX_LEN);
}

function readMarks(raw: unknown): Record<string, string> {
  const marks: Record<string, string> = {};
  if (!isPlainObject(raw)) return marks;

  const keys = Object.keys(raw);
  const priority: readonly string[] = PRIORITY_MARKS;
  const ordered = [
    ...keys.filter((k) => priority.includes(k)),
    ...keys.filter((k) => !priority.includes(k)),
  ];

  let taken = 0;
  for (const key of ordered) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (key.length > KEY_MAX_LEN) continue;
    if (taken >= MARKS_MAX_COUNT) break;
    const value = raw[key];
    if (typeof value !== 'string') continue;
    const clean = sanitizeMark(value);
    if (!clean) continue;
    marks[sanitizeMark(key)] = clean;
    taken++;
  }
  return marks;
}

function readTouch(raw: unknown): AttrTouch | null {
  if (!isPlainObject(raw)) return null;
  const ts = raw.ts;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;

  return {
    ts,
    m: readMarks(raw.m),
    ref: typeof raw.ref === 'string' ? sanitizeMark(raw.ref) : '',
    lp: typeof raw.lp === 'string' ? sanitizeMark(raw.lp) : '',
  };
}

export function readAttribution(now: number = Date.now()): AttrRecord | null {
  try {

    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    const raw = storage ? storage.getItem(ATTRIBUTION_KEY) : null;
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return null;
    if (parsed.v !== ATTRIBUTION_VERSION) return null;

    const ft = readTouch(parsed.ft);
    if (!ft) return null;
    if (now - ft.ts > ATTRIBUTION_TTL_MS) return null;

    const n = typeof parsed.n === 'number' && Number.isFinite(parsed.n) ? parsed.n : 0;
    return {
      v: ATTRIBUTION_VERSION,
      ft,
      fc: readTouch(parsed.fc),

      lt: readTouch(parsed.lt) ?? ft,
      n,
    };
  } catch {

    return null;
  }
}

export function attributionSummary(record: AttrRecord | null): AttrSummary {
  if (!record) {
    return { source: 'direct', campaign: '', medium: '', lastSource: '', touches: 0 };
  }

  const first = record.fc ?? record.ft;
  const source = first.m.utm_source || first.ref || 'direct';
  const last = record.lt.m.utm_source || record.lt.ref || '';

  return {
    source,
    campaign: first.m.utm_campaign ?? '',
    medium: first.m.utm_medium ?? '',

    lastSource: last === source ? '' : last,
    touches: record.n,
  };
}
