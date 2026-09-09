
import { LEAD_KEY_PREFIX, LEAD_TTL_SECONDS } from '../../lib/lead-contract.ts';
import type { LeadMetadata } from '../../lib/lead-contract.ts';

export interface LeadKvPutOptions {
  expirationTtl?: number;
  metadata?: LeadMetadata;
}

export interface LeadKvNamespace {
  put(key: string, value: string, options?: LeadKvPutOptions): Promise<void>;
}

export interface LeadJournalInput {

  payload: unknown;

  metadata: Omit<LeadMetadata, 'delivered'>;
}

export interface LeadJournalEntry {
  readonly key: string;
  readonly value: string;
  readonly metadata: LeadMetadata;
  readonly writtenAt: number;
}

export type DeliveryOutcome = 'ok' | 'failed';

export interface JournalDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DELIVERY_MARK_MIN_INTERVAL_MS = 1100;

const KEY_TAIL_BYTES = 4;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function randomTail(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_TAIL_BYTES));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function leadKey(at: number): string {
  return `${LEAD_KEY_PREFIX}${new Date(at).toISOString()}:${randomTail()}`;
}

export async function writeLead(
  kv: LeadKvNamespace,
  input: LeadJournalInput,
  deps: JournalDeps = {},
): Promise<LeadJournalEntry> {
  const now = deps.now ?? Date.now;
  const writtenAt = now();
  const key = leadKey(writtenAt);
  const value = JSON.stringify(input.payload);

  const metadata: LeadMetadata = { ...input.metadata, delivered: false };

  await kv.put(key, value, { expirationTtl: LEAD_TTL_SECONDS, metadata });

  return { key, value, metadata, writtenAt };
}

export async function markDelivery(
  kv: LeadKvNamespace,
  entry: LeadJournalEntry,
  outcome: DeliveryOutcome,
  deps: JournalDeps = {},
): Promise<LeadJournalEntry> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;

  const sinceWrite = now() - entry.writtenAt;
  const waitFor = DELIVERY_MARK_MIN_INTERVAL_MS - sinceWrite;

  if (waitFor > 0) await sleep(waitFor);

  const metadata: LeadMetadata = { ...entry.metadata, delivered: outcome === 'ok' };
  await kv.put(entry.key, entry.value, { expirationTtl: LEAD_TTL_SECONDS, metadata });

  return { ...entry, metadata };
}
