
import { ROUTE_MAX, SOURCE_MAX } from './throttle.ts';

export const CSP_BODY_MAX_BYTES = 16 * 1024;

export const CSP_MAX_PER_BODY = 5;

export const DIRECTIVE_MAX = 60;

export interface CspViolation {

  directive: string;

  blocked: string;

  documentPath: string;

  sourceFile: string;
  line: number | null;

  disposition: string;
}

export const NOISE_SCHEMES = [
  'chrome-extension:',
  'moz-extension:',
  'safari-extension:',
  'safari-web-extension:',
  'ms-browser-extension:',
  'webkit-masked-url:',
  'chrome-untrusted:',
  'chrome:',
  'resource:',
  'about:',
] as const;

const NOISE_TOKENS = new Set(['about', 'chrome-extension', 'moz-extension', 'safari-extension']);

function hasNoiseScheme(value: string): boolean {
  const lower = value.trim().toLowerCase();
  if (NOISE_TOKENS.has(lower)) return true;
  return NOISE_SCHEMES.some((scheme) => lower.startsWith(scheme));
}

export function isNoise(violation: CspViolation): boolean {
  if (hasNoiseScheme(violation.blocked)) return true;
  if (violation.sourceFile !== '' && hasNoiseScheme(violation.sourceFile)) return true;

  if (violation.documentPath !== '' && hasNoiseScheme(violation.documentPath)) return true;
  return false;
}

function clamp(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function clampNumber(value: unknown): number | null {
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return null;
  if (numeric < 0 || numeric > 10_000_000) return null;
  return Math.trunc(numeric);
}

function toOrigin(raw: unknown): string {
  const value = clamp(raw, SOURCE_MAX);
  if (value === '') return '';
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
    return url.host === '' ? url.protocol : `${url.protocol}//${url.host}`;
  } catch {
    return value;
  }
}

function toOriginPath(raw: unknown): string {
  const value = clamp(raw, SOURCE_MAX);
  if (value === '') return '';
  try {
    const url = new URL(value);
    const base =
      url.protocol === 'http:' || url.protocol === 'https:'
        ? url.origin
        : url.host === ''
          ? url.protocol
          : `${url.protocol}//${url.host}`;
    return `${base}${url.pathname}`;
  } catch {
    return value;
  }
}

function toPath(raw: unknown): string {
  const value = clamp(raw, ROUTE_MAX);
  if (value === '') return '';
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.pathname;
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return value.split('?')[0];
  }
}

function fromRecord(raw: unknown): CspViolation | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const directive = clamp(
    r['effective-directive'] ?? r.effectiveDirective ?? r['violated-directive'] ?? r.violatedDirective,
    DIRECTIVE_MAX,
  );
  if (directive === '') return null;

  return {
    directive,
    blocked: toOrigin(r['blocked-uri'] ?? r.blockedURL ?? r.blockedUri ?? ''),
    documentPath: toPath(r['document-uri'] ?? r.documentURL ?? r.documentUri ?? ''),
    sourceFile: toOriginPath(r['source-file'] ?? r.sourceFile ?? ''),
    line: clampNumber(r['line-number'] ?? r.lineNumber ?? null),
    disposition: clamp(r.disposition ?? 'report', 20),
  };
}

export function normalizeCspBody(raw: unknown): CspViolation[] {
  const out: CspViolation[] = [];

  const push = (candidate: unknown): void => {
    if (out.length >= CSP_MAX_PER_BODY) return;
    const violation = fromRecord(candidate);
    if (violation !== null) out.push(violation);
  };

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;

      if (typeof record.type === 'string' && record.type !== 'csp-violation') continue;
      push(record.body ?? record);
    }
    return out;
  }

  if (typeof raw === 'object' && raw !== null) {
    const record = raw as Record<string, unknown>;
    push(record['csp-report'] ?? record.cspReport ?? record);
  }
  return out;
}

export function cspKeyMaterial(violation: CspViolation): string {
  return JSON.stringify(['csp', violation.directive, violation.blocked, violation.documentPath]);
}

export async function cspReportKey(violation: CspViolation): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(cspKeyMaterial(violation)),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
