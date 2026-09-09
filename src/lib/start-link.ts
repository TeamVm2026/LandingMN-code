
import {
  LIMITS,
  encodeStart,
  normalizeToken,
  type Direction,
  type Locale,

} from './start-codec.ts';

export interface ContactHrefInput {

  botUrl: string;

  fallbackUrl: string;
  direction: Direction;
  locale: Locale;

  source?: string;

  campaign?: string;
}

const BOT_HOSTS = new Set(['t.me', 'telegram.me']);

export function buildContactHref(input: ContactHrefInput): string {
  const { botUrl, fallbackUrl, direction, locale, source = '', campaign = '' } = input;

  if (botUrl === '') return fallbackUrl;

  let parsed: URL;
  try {
    parsed = new URL(botUrl);
  } catch {
    throw new Error(`start-link: PUBLIC_TG_BOT_URL не является адресом: ${JSON.stringify(botUrl)}`);
  }
  if (parsed.protocol !== 'https:' || !BOT_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `start-link: PUBLIC_TG_BOT_URL должен быть https-ссылкой на t.me, получено ${JSON.stringify(botUrl)}. ` +
        'Параметр ?start= работает только со ссылками на бота Telegram.',
    );
  }

  const payload = encodeStart({

    source: normalizeToken(source, LIMITS.source),
    direction,
    locale,
    campaign: normalizeToken(campaign, LIMITS.campaign),

    click: '',
  });

  const separator = parsed.search === '' ? '?' : '&';
  return `${botUrl}${separator}start=${encodeURIComponent(payload)}`;
}
