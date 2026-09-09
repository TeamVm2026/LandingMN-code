
import { LEAD_TTL_SECONDS } from '../../src/lib/lead-contract.ts';
import type { Direction, Locale } from '../../src/lib/start-codec.ts';

export const BOT_KEY_PREFIX = 'bot:';

export const BOT_KEY_SHAPE = 'bot:<ISO>:<8 hex>';

const KEY_TAIL_BYTES = 4;

export interface BotLeadMetadata {

  direction: Direction;

  source: string;

  lang: Locale;

  delivered: boolean;

  kind: 'bot';
}

export interface BotJournalPutOptions {
  expirationTtl?: number;
  metadata?: BotLeadMetadata;
}

export interface BotJournalKv {
  put(key: string, value: string, options?: BotJournalPutOptions): Promise<void>;
}

export interface BotJournalInput {

  payload: unknown;

  metadata: Omit<BotLeadMetadata, 'delivered' | 'kind'>;
}

export interface BotJournalEntry {
  readonly key: string;
  readonly value: string;
  readonly metadata: BotLeadMetadata;
  readonly writtenAt: number;
}

export interface BotJournalDeps {
  now?: () => number;
}

function randomTail(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_TAIL_BYTES));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function botLeadKey(at: number): string {
  return `${BOT_KEY_PREFIX}${new Date(at).toISOString()}:${randomTail()}`;
}

export async function writeBotLead(
  kv: BotJournalKv,
  input: BotJournalInput,
  deps: BotJournalDeps = {},
): Promise<BotJournalEntry> {
  const now = deps.now ?? Date.now;
  const writtenAt = now();
  const key = botLeadKey(writtenAt);
  const value = JSON.stringify(input.payload);

  const metadata: BotLeadMetadata = {
    direction: input.metadata.direction,
    source: input.metadata.source,
    lang: input.metadata.lang,
    delivered: false,
    kind: 'bot',
  };

  await kv.put(key, value, { expirationTtl: LEAD_TTL_SECONDS, metadata });

  return { key, value, metadata, writtenAt };
}
