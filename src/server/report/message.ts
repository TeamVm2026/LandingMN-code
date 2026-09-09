
import {
  TELEGRAM_TEXT_MAX,
  escapeHtml,
  formatReceivedAt,
  renderedLength,
} from '../lead/message.ts';
import type { CspViolation } from './csp.ts';
import type { ClientReport } from './throttle.ts';

const KEY_DISPLAY_LEN = 12;

const KIND_LABELS: Record<ClientReport['kind'], string> = {
  'js-error': 'Исключение JS',
  promise: 'Необработанный промис',
};

function line(label: string, value: string): string {
  return value === '' ? '' : `<b>${label}:</b> ${escapeHtml(value)}\n`;
}

function origin(report: ClientReport): string {
  if (report.source === '') return '';
  const line1 = report.line === null ? '' : `:${String(report.line)}`;
  const col = report.line !== null && report.col !== null ? `:${String(report.col)}` : '';
  return `${report.source}${line1}${col}`;
}

function capLength(text: string): string {
  if (renderedLength(text) <= TELEGRAM_TEXT_MAX) return text;
  return `${text.slice(0, TELEGRAM_TEXT_MAX - 20)}\n…(обрезано)`;
}

export interface ReportMessageInput {
  report: ClientReport;

  key: string;

  at: Date | string;

  host: string;
}

export function buildReportMessage(input: ReportMessageInput): string {
  const { report } = input;
  const head = `⚠️ <b>Ошибка на клиенте</b> — ${escapeHtml(KIND_LABELS[report.kind])}`;

  const body =
    line('Сообщение', report.message) +
    line('Где', origin(report)) +
    line('Страница', report.route) +
    line('Язык', report.locale) +
    line('Домен', input.host) +
    line('Браузер', report.ua) +
    line('Ключ', input.key.slice(0, KEY_DISPLAY_LEN)) +
    line('Время', formatReceivedAt(input.at));

  return capLength(`${head}\n\n${body}`);
}

export interface CapNoticeInput {
  cap: number;

  until: Date | number;
  at: Date | string;
  host: string;

  subject?: string;
}

export function buildCapNoticeMessage(input: CapNoticeInput): string {
  const until = typeof input.until === 'number' ? new Date(input.until) : input.until;
  const subject = input.subject ?? 'отчётов о клиентских ошибках';
  return capLength(
    `🔇 <b>Потолок ${escapeHtml(subject)} достигнут</b>\n\n` +
      line('Потолок', `${String(input.cap)} разных ошибок в час`) +
      line('Молчу до', formatReceivedAt(until)) +
      line('Домен', input.host) +
      line('Время', formatReceivedAt(input.at)) +
      '\nЭто сообщение приходит ОДИН раз за окно. Дубликаты и следующие ошибки ' +
      'в этом окне не доставляются — разбирать надо уже доставленные.',
  );
}

export function buildCspMessage(input: {
  violation: CspViolation;
  key: string;
  at: Date | string;
  host: string;
}): string {
  const { violation } = input;
  const head = '🛡 <b>Нарушение политики CSP</b> — режим отчётов';

  const where =
    violation.sourceFile === ''
      ? ''
      : `${violation.sourceFile}${violation.line === null ? '' : `:${String(violation.line)}`}`;

  const body =
    line('Директива', violation.directive) +
    line('Заблокировано', violation.blocked) +
    line('Страница', violation.documentPath) +
    line('Источник', where) +
    line('Режим', violation.disposition) +
    line('Домен', input.host) +
    line('Ключ', input.key.slice(0, KEY_DISPLAY_LEN)) +
    line('Время', formatReceivedAt(input.at));

  return capLength(`${head}\n\n${body}`);
}
