
import type { Direction, StartPayload } from '../../src/lib/start-codec.ts';
import type { BotUser } from './update.ts';
import {
  escapeHtml,
  formatReceivedAt,
  renderedLength,
  TELEGRAM_TEXT_MAX,
} from '../../src/server/lead/message.ts';

const DIRECTION_LABELS = {
  affiliate: 'Affiliate',
  bank: 'Bank Transfer',
  teamcash: 'Team Cash',
  none: 'не выбрано',
} satisfies Record<Direction, string>;

const UNKNOWN = 'неизвестно';

const DIRECT = 'прямой заход';

const HEAD = '🤖 <b>Лид из бота</b>';

const REPEAT_HEAD = '🔁 <b>Повторный лид</b>';

const HANDOFF_FAILED = '⚠️ <b>Контакт НЕ доставлен — напишите первым</b>';

function directionLabelOf(payload: StartPayload | null, raw: string): string {
  if (payload) return DIRECTION_LABELS[payload.direction];

  return raw !== '' ? UNKNOWN : DIRECTION_LABELS.none;
}

const ELLIPSIS = '…';

const SHED_ORDER = ['raw', 'click', 'campaign', 'source', 'name', 'username'] as const;

type FreeField = (typeof SHED_ORDER)[number];
type FreeValues = Record<FreeField, string>;

function preCap(value: string): string {
  return value.length > TELEGRAM_TEXT_MAX ? value.slice(0, TELEGRAM_TEXT_MAX) : value;
}

function optionalLine(label: string, value: string): string {
  return value ? `<b>${label}:</b> ${escapeHtml(value)}\n` : '';
}

function contactLine(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) return '';
  return `<b>Написать:</b> <a href="tg://user?id=${id}">id ${id}</a>\n`;
}

function fullName(user: BotUser): string {
  return `${user.firstName} ${user.lastName}`.trim();
}

export interface BotLeadNoticeInput {

  readonly user: BotUser;

  readonly payload: StartPayload | null;

  readonly raw: string;

  readonly at: Date | string;

  readonly contactDelivered: boolean;
}

export interface RepeatNoticeInput {
  readonly user: BotUser;

  readonly firstAt: Date | string;

  readonly n: number;

  readonly payload: StartPayload | null;

  readonly raw: string;

  readonly contactDelivered: boolean;
}

function assemble(
  values: FreeValues,
  user: BotUser,
  head: string,
  directionLabel: string,
  languageLine: string,
  unparsedTag: boolean,
  at: string,
): string {
  const who =
    `<b>Направление:</b> ${directionLabel}\n` +
    languageLine +
    optionalLine('Имя', values.name) +
    (values.username ? `<b>Username:</b> @${escapeHtml(values.username)}\n` : '') +
    contactLine(user.id);

  const attribution = unparsedTag
    ? `<b>Метка не разобрана:</b> ${escapeHtml(values.raw)}\n` + `<b>Источник:</b> ${UNKNOWN}\n`
    : `<b>Источник:</b> ${escapeHtml(values.source) || DIRECT}\n` +
      optionalLine('Кампания', values.campaign) +
      optionalLine('Клик', values.click);

  return `${head}\n\n${who}\n${attribution}<b>Время:</b> ${escapeHtml(at)}\n`;
}

export function buildBotLeadNotice(input: BotLeadNoticeInput): string {
  const { user, payload, raw } = input;
  const at = formatReceivedAt(input.at);

  const unparsedTag = payload === null && raw !== '';

  const directionLabel = directionLabelOf(payload, raw);

  const head = input.contactDelivered ? HEAD : `${HEAD}\n${HANDOFF_FAILED}`;

  const languageLine = payload
    ? `<b>Язык:</b> ${payload.locale}\n`
    : optionalLine('Язык телефона', preCap(user.languageCode));

  let values: FreeValues = {
    raw: preCap(raw),
    click: preCap(payload?.click ?? ''),
    campaign: preCap(payload?.campaign ?? ''),
    source: preCap(payload?.source ?? ''),
    name: preCap(fullName(user)),
    username: preCap(user.username),
  };

  let text = assemble(values, user, head, directionLabel, languageLine, unparsedTag, at);

  for (const field of SHED_ORDER) {
    const over = renderedLength(text) - TELEGRAM_TEXT_MAX;
    if (over <= 0) break;

    const current = values[field];
    if (current.length === 0) continue;

    const keep = current.length - over - ELLIPSIS.length;
    values = { ...values, [field]: keep > 0 ? current.slice(0, keep) + ELLIPSIS : '' };
    text = assemble(values, user, head, directionLabel, languageLine, unparsedTag, at);
  }

  return text;
}

export function buildRepeatNotice(input: RepeatNoticeInput): string {
  const { user } = input;
  const n = Number.isFinite(input.n) ? Math.max(1, Math.trunc(input.n)) : 1;
  const firstAt = formatReceivedAt(input.firstAt);

  const named = user.username
    ? `@${escapeHtml(preCap(user.username))}`
    : escapeHtml(preCap(fullName(user)));

  const head = input.contactDelivered
    ? `${REPEAT_HEAD} — обращение №${n}`
    : `${REPEAT_HEAD} — обращение №${n}\n${HANDOFF_FAILED}`;

  const build = (who: string): string =>
    `${head}\n\n` +
    `<b>Направление:</b> ${directionLabelOf(input.payload, input.raw)}\n` +
    (who ? `<b>Посетитель:</b> ${who}\n` : '') +
    contactLine(user.id) +
    `<b>Первое обращение:</b> ${escapeHtml(firstAt)}\n`;

  let text = build(named);

  const over = renderedLength(text) - TELEGRAM_TEXT_MAX;
  if (over > 0) {
    const keep = named.length - over - ELLIPSIS.length;
    text = build(keep > 0 ? named.slice(0, keep) + ELLIPSIS : '');
  }

  return text;
}
