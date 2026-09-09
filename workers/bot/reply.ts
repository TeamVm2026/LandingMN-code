
import mn from './i18n/mn.json' with { type: 'json' };
import ru from './i18n/ru.json' with { type: 'json' };
import en from './i18n/en.json' with { type: 'json' };
import type { Direction, Locale, StartPayload } from '../../src/lib/start-codec.ts';

const DICTIONARIES = { mn, ru, en } as const satisfies Record<Locale, Record<string, string>>;

const DIRECTION_LABELS = {
  affiliate: 'Affiliate',
  bank: 'Bank Transfer',
  teamcash: 'Team Cash',
  none: '',
} satisfies Record<Direction, string>;

const FALLBACK_LOCALE: Locale = 'mn';

const MANAGER_HOSTS = new Set(['t.me', 'telegram.me', 'm.me']);

const DIRECTION_PLACEHOLDER = '{direction}';

export interface ReplyInput {

  managerUrl: string;

  payload: StartPayload | null;

  languageCode: string;

  repeat: boolean;
}

export interface Reply {

  text: string;

  replyMarkup: unknown;
}

function pickLocale(payload: StartPayload | null, languageCode: string): Locale {
  if (payload) return payload.locale;

  const primary = languageCode.trim().toLowerCase().split('-')[0] ?? '';
  if (primary === 'ru' || primary === 'en' || primary === 'mn') return primary;
  return FALLBACK_LOCALE;
}

function guardManagerUrl(managerUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(managerUrl);
  } catch {
    throw new Error(`bot-reply: адрес менеджера не является адресом: ${JSON.stringify(managerUrl)}`);
  }
  if (parsed.protocol !== 'https:' || !MANAGER_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `bot-reply: адрес менеджера должен быть https-ссылкой на ${[...MANAGER_HOSTS].join(', ')}, ` +
        `получено ${JSON.stringify(managerUrl)}. Сообщение без рабочей кнопки отменяет передачу менеджеру.`,
    );
  }
  return managerUrl;
}

export function buildReply(input: ReplyInput): Reply {

  const managerUrl = guardManagerUrl(input.managerUrl);

  const locale = pickLocale(input.payload, input.languageCode);
  const dictionary: Record<string, string> = DICTIONARIES[locale];
  const line = (key: string): string => dictionary[key] ?? '';

  const label = input.payload ? DIRECTION_LABELS[input.payload.direction] : '';
  const directionLine =
    label === '' ? '' : line('reply.direction_line').replace(DIRECTION_PLACEHOLDER, label);

  const parts = [
    input.repeat ? line('reply.repeat_note') : line('reply.greeting'),
    directionLine,
    line('reply.handoff'),
  ].filter((part) => part !== '');

  return {
    text: parts.join('\n\n'),
    replyMarkup: {
      inline_keyboard: [[{ text: line('reply.manager_button'), url: managerUrl }]],
    },
  };
}
