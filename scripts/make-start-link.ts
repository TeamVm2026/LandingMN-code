
import {
  LIMITS,
  PAYLOAD_MAX,
  DIRECTIONS,
  LOCALES,
  encodeStart,
  decodeStart,
  normalizeToken,
  type Direction,
  type Locale,
} from '../src/lib/start-codec.ts';
import { buildContactHref } from '../src/lib/start-link.ts';
import { envValue } from './lib/env-value.ts';

const FLAGS = ['source', 'direction', 'locale', 'campaign', 'click'] as const;
type Flag = (typeof FLAGS)[number];

function parseArgs(argv: string[]): Record<Flag, string> {
  const out: Record<string, string> = { source: '', direction: '', locale: '', campaign: '', click: '' };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      fatal(`неожиданный аргумент «${arg}» — ожидался флаг вида --source`);
    }
    const name = arg.slice(2);
    if (!(FLAGS as readonly string[]).includes(name)) {
      fatal(`неизвестный флаг --${name}. Допустимы: ${FLAGS.map((f) => `--${f}`).join(', ')}`);
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) {
      fatal(`у флага --${name} нет значения`);
    }
    out[name] = value;
  }

  return out as Record<Flag, string>;
}

function fatal(message: string): never {
  console.error(`\nОТКАЗ: ${message}\n`);
  console.error(USAGE);
  process.exit(1);
}

const USAGE = `Использование:
  npm run make:start-link -- --source <код> --direction <направление> --locale <локаль> \\
                             [--campaign <кампания>] [--click <хвост>]

  --direction   ${Object.keys(DIRECTIONS).join(' | ')}
  --locale      ${Object.keys(LOCALES).join(' | ')}
  --source      откуда идёт трафик; до ${LIMITS.source} симв. после нормализации
  --campaign    код кампании; до ${LIMITS.campaign} симв. после нормализации
  --click       хвост идентификатора клика трекера; до ${LIMITS.click} симв.

Пример:
  npm run make:start-link -- --source fb --direction affiliate --locale mn \\
                             --campaign "Осенняя кампания №3"`;

const args = parseArgs(process.argv.slice(2));

if (args.direction === '' || args.locale === '') {
  fatal('--direction и --locale обязательны: без них метка неразбираема');
}
if (!(args.direction in DIRECTIONS)) {
  fatal(`--direction «${args.direction}» вне домена. Допустимы: ${Object.keys(DIRECTIONS).join(', ')}`);
}
if (!(args.locale in LOCALES)) {
  fatal(`--locale «${args.locale}» вне домена. Допустимы: ${Object.keys(LOCALES).join(', ')}`);
}

const sourceOmitted = args.source.trim() === '';

function resolveBotUrl(): string {
  let raw: string;
  try {
    raw = envValue('PUBLIC_TG_BOT_URL');
  } catch {
    raw = '';
  }

  if (raw === '') {
    console.error(`
ОТКАЗ: PUBLIC_TG_BOT_URL пуст — адреса бота нет, собирать ссылку не на что.

  Локально:  вписать в .env.local строку
             PUBLIC_TG_BOT_URL=https://t.me/<имя бота>
  В CI/бою:  переменная репозитория GitHub (Settings → Secrets and variables
             → Actions → Variables). Она же переключает кнопки живого сайта.

  Разово, не трогая файлы:
             PUBLIC_TG_BOT_URL=https://t.me/<бот> npm run make:start-link -- ...
`);
    process.exit(1);
  }
  return raw;
}

const botUrl = resolveBotUrl();

interface Normalized {
  flag: string;
  raw: string;
  value: string;
  limit: number;
}

const normalized: Normalized[] = [
  { flag: '--source', raw: args.source, value: normalizeToken(args.source, LIMITS.source), limit: LIMITS.source },
  { flag: '--campaign', raw: args.campaign, value: normalizeToken(args.campaign, LIMITS.campaign), limit: LIMITS.campaign },
  { flag: '--click', raw: args.click, value: normalizeToken(args.click, LIMITS.click), limit: LIMITS.click },
];

for (const item of normalized) {
  if (item.raw.trim() !== '' && item.value === '') {
    fatal(
      `${item.flag} «${item.raw}» после нормализации не оставляет ни одного символа ` +
        `алфавита [a-z0-9-]. Метка потеряла бы это поле молча — задайте значение латиницей.`,
    );
  }
}

const [source, campaign, click] = normalized.map((n) => n.value) as [string, string, string];

const direction = args.direction as Direction;
const locale = args.locale as Locale;

const payload = encodeStart({ source, direction, locale, campaign, click });

let baseHref: string;
try {
  baseHref = buildContactHref({ botUrl, fallbackUrl: botUrl, direction, locale, source, campaign });
} catch (error) {
  fatal(error instanceof Error ? error.message : String(error));
}

const url = new URL(baseHref);
url.searchParams.set('start', payload);
const href = url.toString();

if (click === '' && href !== baseHref) {
  console.error(
    `\nОТКАЗ: минтер разошёлся со сборкой сайта.\n  минтер: ${href}\n  сборка: ${baseHref}\n`,
  );
  process.exit(1);
}

const decoded = decodeStart(payload);
if (decoded === null) {
  console.error(`\nОТКАЗ: собранная метка «${payload}» не разбирается собственным кодеком.\n`);
  process.exit(1);
}

const changed = normalized.filter((n) => n.raw !== n.value && n.raw.trim() !== '');

console.log('');
console.log('  ССЫЛКА (вставлять в рекламный кабинет):');
console.log('');
console.log(`      ${href}`);
console.log('');

if (changed.length > 0) {
  console.log('  ⚠️  ЗНАЧЕНИЯ ИЗМЕНЕНЫ НОРМАЛИЗАЦИЕЙ — сверьте до вставки:');
  console.log('');
  for (const item of changed) {
    console.log(`      ${item.flag.padEnd(11)} «${item.raw}»`);
    console.log(`      ${''.padEnd(11)}  → «${item.value}»  (лимит ${item.limit} симв.)`);
  }
  console.log('');
  console.log('      Алфавит поля — [a-z0-9-]. Обрезка необратима: именно эта');
  console.log('      строка приедет в чат менеджеров и в отчёт, а не исходная.');
  console.log('');

  // eslint-disable-next-line no-control-regex
  if (changed.some((item) => /[^\x00-\x7F]/.test(item.raw))) {
    console.log('  ⛔  В ВВОДЕ БЫЛА НЕ-ЛАТИНИЦА. Она НЕ транслитерируется, а вырезается:');
    console.log('      от «Осенняя кампания №3» остаётся «3», а не «osennyaya-kampaniy».');
    console.log('      Задавайте источник и кампанию латиницей — иначе отчёт по ним');
    console.log('      будет нечитаемым, а ссылку уже не отозвать.');
    console.log('');
  }
}

console.log('  КАК ЕЁ ПРОЧИТАЕТ БОТ (разбор настоящим decodeStart):');
console.log('');
console.log(`      источник:    ${decoded.source === '' ? '— (пусто)' : decoded.source}`);
console.log(`      направление: ${decoded.direction}`);
console.log(`      локаль:      ${decoded.locale}`);
console.log(`      кампания:    ${decoded.campaign === '' ? '— (пусто)' : decoded.campaign}`);
console.log(`      хвост клика: ${decoded.click === '' ? '— (пусто)' : decoded.click}`);
console.log('');
console.log(`      метка: ${payload}  (${payload.length} из ${PAYLOAD_MAX} символов)`);
console.log('');

if (sourceOmitted) {
  console.log('  ⚠️  ИСТОЧНИК ПУСТ. Ссылка рабочая, но лид приедет без ответа на');
  console.log('      вопрос «откуда пришёл человек» — ровно так собирает ссылки сам');
  console.log('      сайт. Для рекламы задайте --source.');
  console.log('');
}
