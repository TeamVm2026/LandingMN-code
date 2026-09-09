
import type { NormalizedLead } from './validate.ts';
import type { AttrSummary } from '../../lib/attribution.ts';
import type { ContactChannel, Direction } from '../../lib/lead-contract.ts';

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const TELEGRAM_TEXT_MAX = 4096;

export function renderedLength(html: string): number {
  const withoutTags = html.replace(/<\/?[a-zA-Z][^>]*>/g, '');
  const decoded = withoutTags
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
  return decoded.length;
}

const CHANNEL_LABELS = {
  phone: 'Телефон',
  telegram: 'Telegram',
  messenger: 'Facebook Messenger',
} satisfies Record<ContactChannel, string>;

const DIRECTION_LABELS = {
  affiliate: 'Affiliate',
  bank: 'Bank Transfer',
  teamcash: 'Team Cash',
} satisfies Record<Direction, string>;

export interface LeadMessageInput {

  readonly lead: NormalizedLead;

  readonly attr?: unknown;

  readonly host: string;

  readonly at: Date | string;

  readonly captchaUnverified?: boolean;
}

function readSummary(raw: unknown): AttrSummary {
  const empty: AttrSummary = {
    source: 'direct',
    campaign: '',
    medium: '',
    lastSource: '',
    touches: 0,
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return empty;

  const record = raw as Record<string, unknown>;
  const text = (key: string): string => {
    const value = record[key];
    return typeof value === 'string' ? value : '';
  };
  const rawTouches = record.touches;
  const touches =
    typeof rawTouches === 'number' && Number.isFinite(rawTouches)
      ? Math.max(0, Math.min(999999, Math.trunc(rawTouches)))
      : 0;

  return {
    source: text('source') || 'direct',
    campaign: text('campaign'),
    medium: text('medium'),
    lastSource: text('lastSource'),
    touches,
  };
}

const LEAD_TIME_ZONE = 'Asia/Ulaanbaatar';

const LEAD_TIME_ZONE_LABEL = 'Улан-Батор';

export function formatReceivedAt(raw: Date | string): string {
  const date = typeof raw === 'string' ? new Date(raw) : raw;
  if (Number.isNaN(date.getTime())) {

    return typeof raw === 'string' ? raw.slice(0, 40) : String(raw);
  }

  try {
    const parts = new Intl.DateTimeFormat('ru-RU', {
      timeZone: LEAD_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',

      hourCycle: 'h23',
      timeZoneName: 'shortOffset',
    }).formatToParts(date);

    let stamp = '';
    let offset = '';
    for (const part of parts) {
      if (part.type === 'timeZoneName') offset = part.value;
      else stamp += part.value;
    }

    stamp = stamp.trim();
    if (stamp === '') throw new Error('пустая отметка времени');

    return offset ? `${stamp} (${LEAD_TIME_ZONE_LABEL}, ${offset})` : `${stamp} (${LEAD_TIME_ZONE_LABEL})`;
  } catch {

    return date.toISOString();
  }
}

const SHED_ORDER = ['lastSource', 'medium', 'campaign', 'source', 'name', 'host', 'contact'] as const;

type FreeField = (typeof SHED_ORDER)[number];
type FreeValues = Record<FreeField, string>;

const ELLIPSIS = '…';

function preCap(value: string): string {
  return value.length > TELEGRAM_TEXT_MAX ? value.slice(0, TELEGRAM_TEXT_MAX) : value;
}

function optionalLine(label: string, value: string): string {
  return value ? `<b>${label}:</b> ${escapeHtml(value)}\n` : '';
}

function assemble(
  values: FreeValues,
  lead: NormalizedLead,
  touches: number,
  at: string,
  captchaUnverified: boolean,
): string {
  const head = '🟡 <b>Заявка с лендинга</b>\n\n';

  const body =
    `<b>Имя:</b> ${escapeHtml(values.name)}\n` +
    `<b>Контакт:</b> ${escapeHtml(values.contact)} — ${CHANNEL_LABELS[lead.channel]}\n` +
    `<b>Направление:</b> ${DIRECTION_LABELS[lead.direction]}\n` +
    `<b>Язык:</b> ${lead.lang}\n\n`;

  const attribution =
    `<b>Источник:</b> ${escapeHtml(values.source)}\n` +
    optionalLine('Кампания', values.campaign) +
    optionalLine('Канал', values.medium) +
    optionalLine('Последний источник', values.lastSource) +
    `<b>Касаний:</b> ${touches}\n` +
    `<b>Домен:</b> ${escapeHtml(values.host)}\n` +
    `<b>Время:</b> ${escapeHtml(at)}\n`;

  const note = captchaUnverified
    ? '\n⚠️ <b>Антиспам не проверен</b> — заявка принята без проверки Cloudflare. Причина в техчате.\n'
    : '';

  return head + body + attribution + note;
}

export function buildLeadMessage(input: LeadMessageInput): string {
  const summary = readSummary(input.attr);
  const at = formatReceivedAt(input.at);
  const captchaUnverified = input.captchaUnverified === true;

  let values: FreeValues = {
    name: preCap(input.lead.name),
    contact: preCap(input.lead.contact),
    host: preCap(input.host),
    source: preCap(summary.source),
    campaign: preCap(summary.campaign),
    medium: preCap(summary.medium),
    lastSource: preCap(summary.lastSource),
  };

  let text = assemble(values, input.lead, summary.touches, at, captchaUnverified);

  for (const field of SHED_ORDER) {
    const over = renderedLength(text) - TELEGRAM_TEXT_MAX;
    if (over <= 0) break;

    const current = values[field];
    if (current.length === 0) continue;

    const keep = current.length - over - ELLIPSIS.length;
    values = { ...values, [field]: keep > 0 ? current.slice(0, keep) + ELLIPSIS : '' };
    text = assemble(values, input.lead, summary.touches, at, captchaUnverified);
  }

  return text;
}
