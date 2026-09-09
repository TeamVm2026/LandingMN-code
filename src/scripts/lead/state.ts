
export const LEAD_STATE_KEY = 'lmn_lead';

const LEAD_STATE_VERSION = 1;

export const LEAD_STATE_TTL_MS = 72 * 60 * 60 * 1000;

export interface LeadState {
  v: 1;

  at: number;

  direction: string;
}

export function readLeadState(): LeadState | null {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    const raw = storage ? storage.getItem(LEAD_STATE_KEY) : null;
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

    const record = parsed as Record<string, unknown>;
    if (record.v !== LEAD_STATE_VERSION) return null;

    const at = record.at;
    if (typeof at !== 'number' || !Number.isFinite(at)) return null;
    if (Date.now() - at > LEAD_STATE_TTL_MS) return null;

    const direction = record.direction;
    if (typeof direction !== 'string' || direction === '') return null;

    return { v: LEAD_STATE_VERSION, at, direction };
  } catch {

    return null;
  }
}

export function writeLeadState(direction: string): void {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (!storage) return;
    const value: LeadState = { v: LEAD_STATE_VERSION, at: Date.now(), direction };
    storage.setItem(LEAD_STATE_KEY, JSON.stringify(value));
  } catch {
    /* */
  }
}

export function clearLeadState(): void {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (!storage) return;
    storage.removeItem(LEAD_STATE_KEY);
  } catch {

    /* */
  }
}
