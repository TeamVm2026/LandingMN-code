
import { regionOnce } from './region.ts';

export const CONSENT_REQUIRED_REGIONS = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'GB', 'CH',
] as const;

export type ConsentChoice = 'granted' | 'denied';

export const CONSENT_STORAGE_KEY = 'lmn_consent';

export interface ClarityFn {
  (...args: unknown[]): void;
  q?: unknown[][];
}

declare global {
  interface Window {

    dataLayer?: unknown[];

    gtag?: (...args: unknown[]) => void;

    clarity?: ClarityFn;
  }
}

export const CONSENT_TTL_MS = 183 * 24 * 60 * 60 * 1000;

const CONSENT_RECORD_VERSION = 1;

export interface ConsentRecord {
  v: 1;

  at: number;

  c: ConsentChoice;
}

function persist(storage: Storage, choice: ConsentChoice): void {
  const value: ConsentRecord = { v: CONSENT_RECORD_VERSION, at: Date.now(), c: choice };
  storage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(value));
}

export function readConsentChoice(): ConsentChoice | null {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    const raw = storage ? storage.getItem(CONSENT_STORAGE_KEY) : null;
    if (!raw || !storage) return null;

    if (raw === 'granted' || raw === 'denied') {
      persist(storage, raw);
      return raw;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {

      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

    const record = parsed as Record<string, unknown>;
    if (record.v !== CONSENT_RECORD_VERSION) return null;

    const choice = record.c;
    if (choice !== 'granted' && choice !== 'denied') return null;

    const at = record.at;

    if (typeof at !== 'number' || !Number.isFinite(at)) return null;

    const age = Date.now() - at;

    if (age < 0) {
      persist(storage, choice);
      return choice;
    }

    if (age > CONSENT_TTL_MS) {
      storage.removeItem(CONSENT_STORAGE_KEY);
      return null;
    }

    return choice;
  } catch {
    return null;
  }
}

export function writeConsentChoice(choice: ConsentChoice): void {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (!storage) return;
    persist(storage, choice);
  } catch {
    /* */
  }
}

export function isConsentRequiredRegion(loc: string | null): boolean {
  if (!loc) return false;
  const code = loc.trim().toUpperCase();
  return (CONSENT_REQUIRED_REGIONS as readonly string[]).includes(code);
}

export async function resolveAnalyticsDefault(): Promise<ConsentChoice> {
  const saved = readConsentChoice();
  if (saved) return saved;
  return isConsentRequiredRegion(await regionOnce()) ? 'denied' : 'granted';
}

export function analyticsCookieDomains(hostname: string): (string | null)[] {
  const candidates: (string | null)[] = [null];
  const host = (hostname ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) return candidates;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return candidates;

  const parts = host.split('.');

  for (let i = 0; i < parts.length - 1; i += 1) {
    candidates.push(`.${parts.slice(i).join('.')}`);
  }
  return candidates;
}

function clearGoogleAnalyticsCookies(): void {
  try {
    const names = document.cookie
      .split(';')
      .map((pair) => pair.split('=')[0]?.trim() ?? '')
      .filter((name) => name === '_ga' || name.startsWith('_ga_'));
    if (names.length === 0) return;

    const domains = analyticsCookieDomains(location.hostname);
    for (const name of names) {
      for (const domain of domains) {

        document.cookie =
          `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; max-age=0; path=/` +
          (domain === null ? '' : `; domain=${domain}`);
      }
    }
  } catch {

    /* */
  }
}

export function applyConsentChoice(choice: ConsentChoice): void {
  const analytics: ConsentChoice = choice === 'granted' ? 'granted' : 'denied';

  try {

    window.gtag?.('consent', 'update', { analytics_storage: analytics });
  } catch {

    /* */
  }

  try {

    window.clarity?.('consentv2', {
      ad_Storage: 'denied',
      analytics_Storage: analytics,
    });
  } catch {
    /* */
  }

  if (analytics === 'denied') clearGoogleAnalyticsCookies();
}
