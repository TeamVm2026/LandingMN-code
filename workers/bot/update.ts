
import { PAYLOAD_MAX, decodeStart, type StartPayload } from '../../src/lib/start-codec.ts';

const PRIVATE_CHAT = 'private';

const START_COMMAND = '/start';

const BOT_MENTION = '@';

const TEXT_SCAN_MAX = 256;

const NAME_MAX = 64;
const USERNAME_MAX = 32;
const LANGUAGE_CODE_MAX = 8;

const CHAT_TYPE_MAX = 32;

export interface BotUser {
  id: number;
  firstName: string;
  lastName: string;
  username: string;
  languageCode: string;
}

export type IgnoreReason =
  | 'group'
  | 'no-message'
  | 'no-text'
  | 'no-from'
  | 'bot-author'
  | 'unparsable';

export type ParsedUpdate =
  | {
      kind: 'start';
      updateId: number | null;
      chatId: number | null;
      chatType: string;
      user: BotUser;

      payload: StartPayload | null;

      raw: string;
    }
  | {
      kind: 'other';
      updateId: number | null;
      chatId: number | null;
      chatType: string;
      user: BotUser;
    }
  | {
      kind: 'ignore';
      updateId: number | null;
      chatId: number | null;
      chatType: string;
      reason: IgnoreReason;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readUser(from: Record<string, unknown>): BotUser {
  return {
    id: asNumber(from.id) ?? 0,
    firstName: asString(from.first_name, NAME_MAX),
    lastName: asString(from.last_name, NAME_MAX),
    username: asString(from.username, USERNAME_MAX),
    languageCode: asString(from.language_code, LANGUAGE_CODE_MAX),
  };
}

function readStartArgument(text: string): string | null {
  const scanned = text.slice(0, TEXT_SCAN_MAX).trim();
  const firstSpace = scanned.search(/\s/);
  const command = firstSpace === -1 ? scanned : scanned.slice(0, firstSpace);

  const mentionAt = command.indexOf(BOT_MENTION);
  const bare = mentionAt === -1 ? command : command.slice(0, mentionAt);
  if (bare !== START_COMMAND) return null;

  return firstSpace === -1 ? '' : scanned.slice(firstSpace).trim();
}

export function parseUpdate(update: unknown): ParsedUpdate {
  const root = asRecord(update);

  const updateId = root ? asNumber(root.update_id) : null;
  const message = root ? asRecord(root.message) : null;
  if (!message) {
    return { kind: 'ignore', updateId, chatId: null, chatType: '', reason: 'no-message' };
  }

  const chat = asRecord(message.chat);
  const chatType = chat ? asString(chat.type, CHAT_TYPE_MAX) : '';
  const chatId = chat ? asNumber(chat.id) : null;

  if (chatType !== PRIVATE_CHAT) {
    return { kind: 'ignore', updateId, chatId, chatType, reason: 'group' };
  }

  if (chatId === null) {
    return { kind: 'ignore', updateId, chatId, chatType, reason: 'unparsable' };
  }

  const from = asRecord(message.from);
  if (!from) {
    return { kind: 'ignore', updateId, chatId, chatType, reason: 'no-from' };
  }
  if (from.is_bot === true) {
    return { kind: 'ignore', updateId, chatId, chatType, reason: 'bot-author' };
  }

  const text = message.text;
  if (typeof text !== 'string') {
    return { kind: 'ignore', updateId, chatId, chatType, reason: 'no-text' };
  }

  const user = readUser(from);
  const argument = readStartArgument(text);
  if (argument === null) {
    return { kind: 'other', updateId, chatId, chatType, user };
  }

  const oversized = argument.length > PAYLOAD_MAX;
  const raw = argument.slice(0, PAYLOAD_MAX);
  const payload = oversized ? null : decodeStart(raw);

  return { kind: 'start', updateId, chatId, chatType, user, payload, raw };
}
