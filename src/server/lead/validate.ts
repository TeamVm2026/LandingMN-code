
import {
  CONTACT_CHANNELS,
  CONTACT_MAX_LEN,
  DEFAULT_LOCALE,
  DIRECTIONS,
  ERROR_CODES,
  FIELDS,
  LOCALES,
  NAME_MAX_LEN,
} from '../../lib/lead-contract.ts';
import type {
  ContactChannel,
  Direction,
  FieldName,
} from '../../lib/lead-contract.ts';
import type { Locale } from '../../i18n/routes.ts';

export interface NormalizedLead {
  readonly name: string;
  readonly contact: string;
  readonly channel: ContactChannel;
  readonly direction: Direction;
  readonly lang: Locale;
}

export type LeadValidation =
  | { readonly ok: true; readonly lead: NormalizedLead }
  | {
      readonly ok: false;
      readonly code: typeof ERROR_CODES.validationFailed;
      readonly fields: readonly FieldName[];
    };

const PHONE_SHAPE = /^[0-9+\-\s]+$/;
const PHONE_DIGITS_MIN = 8;
const PHONE_DIGITS_MAX = 15;
const TELEGRAM_SHAPE = /^@?[A-Za-z0-9_]{5,32}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

function isContactChannel(value: string): value is ContactChannel {
  return (CONTACT_CHANNELS as readonly string[]).includes(value);
}

function isDirection(value: string): value is Direction {
  return (DIRECTIONS as readonly string[]).includes(value);
}

function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

function countDigits(value: string): number {
  let digits = 0;
  for (const char of value) {
    if (char >= '0' && char <= '9') digits++;
  }
  return digits;
}

function isContactValid(channel: ContactChannel, contact: string): boolean {
  if (channel === 'phone') {
    if (!PHONE_SHAPE.test(contact)) return false;
    const digits = countDigits(contact);
    return digits >= PHONE_DIGITS_MIN && digits <= PHONE_DIGITS_MAX;
  }
  if (channel === 'telegram') return TELEGRAM_SHAPE.test(contact);

  return true;
}

export function validateLead(body: unknown): LeadValidation {
  const fields: FieldName[] = [];
  const source = isPlainObject(body) ? body : {};

  const name = readString(source, FIELDS.name).trim();
  if (name.length === 0 || name.length > NAME_MAX_LEN) fields.push(FIELDS.name);

  const rawChannel = readString(source, FIELDS.contactChannel).trim();
  const channelValid = isContactChannel(rawChannel);
  if (!channelValid) fields.push(FIELDS.contactChannel);

  const contact = readString(source, FIELDS.contact).trim();
  if (contact.length === 0 || contact.length > CONTACT_MAX_LEN) {
    fields.push(FIELDS.contact);
  } else if (channelValid && !isContactValid(rawChannel, contact)) {

    fields.push(FIELDS.contact);
  }

  const rawDirection = readString(source, FIELDS.direction).trim();
  if (!isDirection(rawDirection)) fields.push(FIELDS.direction);

  if (readString(source, FIELDS.consent).trim().length === 0) {
    fields.push(FIELDS.consent);
  }

  if (fields.length > 0) {
    return { ok: false, code: ERROR_CODES.validationFailed, fields };
  }

  const rawLang = readString(source, FIELDS.lang).trim();
  const lang: Locale = isLocale(rawLang) ? rawLang : DEFAULT_LOCALE;

  return {
    ok: true,
    lead: {
      name,
      contact,
      channel: isContactChannel(rawChannel) ? rawChannel : CONTACT_CHANNELS[0],
      direction: isDirection(rawDirection) ? rawDirection : DIRECTIONS[0],
      lang,
    },
  };
}
