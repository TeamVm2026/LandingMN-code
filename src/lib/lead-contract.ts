
import { ATTRIBUTION_TTL_MS } from './attribution.ts';
import { PAGE_ROUTES, type Locale } from '../i18n/routes.ts';

export const FIELDS = {
  name: 'name',
  contact: 'contact',
  contactChannel: 'contact_channel',
  direction: 'direction',
  consent: 'consent',
  lang: 'lang',
} as const;

export type FieldName = (typeof FIELDS)[keyof typeof FIELDS];

export const HONEYPOT_FIELD = 'website';

export const TURNSTILE_TOKEN_FIELD = 'cf-turnstile-response';

export const ATTRIBUTION_FIELD = 'attr';

export const CONTACT_CHANNELS = ['phone', 'telegram', 'messenger'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

export const DIRECTIONS = ['affiliate', 'bank', 'teamcash'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const LOCALES = ['mn', 'ru', 'en'] as const satisfies readonly Locale[];

export const DEFAULT_LOCALE: Locale = 'mn';

export const ERROR_CODES = {

  methodNotAllowed: 'method_not_allowed',

  bodyTooLarge: 'body_too_large',

  badRequest: 'bad_request',

  rateLimited: 'rate_limited',

  validationFailed: 'validation_failed',

  captchaFailed: 'captcha_failed',

  serviceUnconfigured: 'service_unconfigured',

  internalError: 'internal_error',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const BODY_MAX_BYTES = 16384;

export const NAME_MAX_LEN = 80;

export const CONTACT_MAX_LEN = 120;

export const RATE_LIMIT_MAX = 5;

export const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

export const LEAD_KEY_PREFIX = 'lead:';

export const LEAD_KEY_SHAPE = 'lead:<ISO>:<8 hex>';

export interface LeadMetadata {

  direction: Direction;

  source: string;

  lang: Locale;

  channel: ContactChannel;

  delivered: boolean;

  host: string;
}

export const LEAD_TTL_SECONDS = Math.floor(ATTRIBUTION_TTL_MS / 1000);

export const SUCCESS_ROUTE = PAGE_ROUTES.thanks satisfies Record<Locale, string>;
