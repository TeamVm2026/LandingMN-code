
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  FIELDS,
  HONEYPOT_FIELD,
  TURNSTILE_TOKEN_FIELD,
  ATTRIBUTION_FIELD,
  CONTACT_CHANNELS,
  DIRECTIONS,
  LOCALES,
  LEAD_TTL_SECONDS,
} from '../src/lib/lead-contract.ts';
import { ATTRIBUTION_TTL_MS } from '../src/lib/attribution.ts';
import {
  DIRECTIONS as CODEC_DIRECTIONS,
  LOCALES as CODEC_LOCALES,
} from '../src/lib/start-codec.ts';

const projectRoot = path.resolve(import.meta.dirname, '..');

function argValue(name: string, fallback: string): string {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) {
    console.error(`FAIL: у аргумента --${name} нет значения`);
    process.exit(1);
  }
  return value;
}

function argValues(name: string, fallback: string[]): string[] {
  const argv = process.argv.slice(2);
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== `--${name}`) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      console.error(`FAIL: у аргумента --${name} нет значения`);
      process.exit(1);
    }
    out.push(value);
  }
  return out.length > 0 ? out : fallback;
}

const markupPath = argValue('markup', 'src/components/LeadFormMarkup.astro');
const contractPath = argValue('contract', 'src/lib/lead-contract.ts');
const scanDirs = argValues('scan', ['src', 'functions', 'workers']);

const failures: string[] = [];

function fail(marker: string, detail: string): void {
  failures.push(`${marker}\n      ${detail}`);
}

const rel = (file: string): string => path.relative(projectRoot, file).replace(/\\/g, '/');

function readOrDie(relative: string, what: string): string {
  const full = path.resolve(projectRoot, relative);
  if (!existsSync(full)) {
    console.error(`FAIL: нет файла ${relative} — ${what} проверить нечем`);
    process.exit(1);
  }
  return readFileSync(full, 'utf8');
}

const SCAN_EXT = ['.ts', '.js', '.mjs', '.astro'];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.astro', '.sabotage-tmp', '.wrangler']);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCAN_EXT.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

const scanFiles: string[] = [];
for (const dir of scanDirs) {
  const abs = path.resolve(projectRoot, dir);

  if (!existsSync(abs)) {
    console.error(`FAIL: каталог обхода ${dir} не существует — обходить нечего`);
    process.exit(1);
  }
  scanFiles.push(...walk(abs));
}

const markupSource = readOrDie(markupPath, 'контракт полей');
const markup = markupSource
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/<!--[\s\S]*?-->/g, '');

const FIELD_TAG = /<(input|select|textarea)\b([^>]*)>/gi;
const ATTR_LITERAL = (attr: string): RegExp => new RegExp(`\\b${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
const ATTR_EXPR = (attr: string): RegExp => new RegExp(`\\b${attr}\\s*=\\s*\\{([^}]*)\\}`, 'i');

function attrLiteral(attrs: string, attr: string): string | null {
  const m = attrs.match(ATTR_LITERAL(attr));
  if (!m) return null;
  return m[1] ?? m[2] ?? '';
}

const CONTRACT_NAMES = new Set<string>([
  ...Object.values(FIELDS),
  HONEYPOT_FIELD,
  TURNSTILE_TOKEN_FIELD,
  ATTRIBUTION_FIELD,
]);

const MAY_BE_ABSENT = new Set<string>([TURNSTILE_TOKEN_FIELD]);

const NAME_EXPRESSIONS: Record<string, string> = {
  HONEYPOT_FIELD,
  TURNSTILE_TOKEN_FIELD,
  ATTRIBUTION_FIELD,
  ...Object.fromEntries(Object.entries(FIELDS).map(([key, value]) => [`FIELDS.${key}`, value])),
};

const markupNames = new Set<string>();
const markupEnums: Record<string, Set<string>> = {
  [FIELDS.contactChannel]: new Set<string>(),
  [FIELDS.direction]: new Set<string>(),
};
let taggedFields = 0;
let unnamedFields = 0;
let boundByImport = 0;

for (const match of markup.matchAll(FIELD_TAG)) {
  const attrs = match[2] ?? '';
  taggedFields++;

  let name: string | null = null;
  const expr = attrs.match(ATTR_EXPR('name'));
  if (expr) {
    const source = (expr[1] ?? '').trim();
    const resolved = NAME_EXPRESSIONS[source];
    if (resolved === undefined) {
      fail(
        'КОНТРАКТ ПОЛЕЙ',
        `в разметке имя поля задано выражением «${source}» — вычислить его нечем.\n` +
          '      Имя обязано быть либо строкой из контракта, либо ссылкой на его константу\n' +
          `      (${Object.keys(NAME_EXPRESSIONS).join(', ')}).`,
      );
      continue;
    }
    boundByImport++;
    name = resolved;
  } else {
    name = attrLiteral(attrs, 'name');
  }

  if (name === null) {
    unnamedFields++;
    continue;
  }

  markupNames.add(name);
  if (!CONTRACT_NAMES.has(name)) {
    fail(
      'КОНТРАКТ ПОЛЕЙ',
      `разметка отправляет поле «${name}», которого нет в контракте (${contractPath}).\n` +
        '      Приёмник о нём не знает: форма отправится, ответ придёт, поле молча пропадёт.\n' +
        `      Разрешённые имена: ${[...CONTRACT_NAMES].join(', ')}`,
    );
  }

  const bucket = markupEnums[name];
  if (bucket) {
    const value = attrLiteral(attrs, 'value');
    if (value === null) {
      fail(
        'КОНТРАКТ ПОЛЕЙ',
        `у поля «${name}» в разметке нет атрибута value — перечисление сверить нечем.`,
      );
    } else {
      bucket.add(value);
    }
  }
}

for (const name of CONTRACT_NAMES) {
  if (markupNames.has(name) || MAY_BE_ABSENT.has(name)) continue;
  fail(
    'КОНТРАКТ ПОЛЕЙ',
    `контракт объявляет поле «${name}», а в разметке его нет.\n` +
      '      Приёмник будет ждать данных, которых никто не отправит.',
  );
}

function compareEnum(fieldName: string, contractValues: readonly string[]): void {
  const fromMarkup = markupEnums[fieldName] ?? new Set<string>();
  for (const value of fromMarkup) {
    if (contractValues.includes(value)) continue;
    fail(
      'КОНТРАКТ ПОЛЕЙ',
      `разметка предлагает «${fieldName}=${value}», а контракт такого значения не знает.\n` +
        `      Контракт: ${contractValues.join(', ')}. Приёмник отклонит заявку по валидации.`,
    );
  }
  for (const value of contractValues) {
    if (fromMarkup.has(value)) continue;
    fail(
      'КОНТРАКТ ПОЛЕЙ',
      `контракт объявляет «${fieldName}=${value}», а в разметке такого варианта нет.\n` +
        `      Разметка: ${[...fromMarkup].join(', ') || '(ни одного)'}. Выбрать его посетитель не может.`,
    );
  }
}

compareEnum(FIELDS.contactChannel, CONTACT_CHANNELS);
compareEnum(FIELDS.direction, DIRECTIONS);

const contractSource = readOrDie(contractPath, 'импорт TTL');

const IMPORT_TTL = /import\s*(?:type\s*)?\{[^}]*\bATTRIBUTION_TTL_MS\b[^}]*\}\s*from\s*['"][^'"]*attribution(?:\.ts)?['"]/;
if (!IMPORT_TTL.test(contractSource)) {
  fail(
    'TTL НЕ ИМПОРТИРОВАН',
    `в ${contractPath} нет именованного импорта ATTRIBUTION_TTL_MS из src/lib/attribution.ts.\n` +
      '      Срок хранения заявки обещан посетителю в политике конфиденциальности и объявлен\n' +
      '      в репозитории ровно один раз. Контракт обязан его импортировать, а не повторять.',
  );
}

const TTL_SOURCE_FILES = new Set(['src/lib/attribution.ts']);

const TTL_LITERALS: { re: RegExp; what: string }[] = [
  { re: /\b7_?776_?000\b/g, what: 'срок хранения числом секунд' },
  { re: /\b90\s*\*/g, what: 'срок хранения арифметикой (90 * …)' },
  { re: /\*\s*90\b/g, what: 'срок хранения арифметикой (… * 90)' },

  { re: /\bexpirationTtl\s*:\s*[0-9][0-9_]*/g, what: 'expirationTtl числом вместо LEAD_TTL_SECONDS' },
];

let ttlLiterals = 0;
const ttlScanTargets = [
  path.resolve(projectRoot, contractPath),
  ...scanFiles.filter((f) => f !== path.resolve(projectRoot, contractPath)),
];

for (const file of ttlScanTargets) {
  if (TTL_SOURCE_FILES.has(rel(file))) continue;
  if (!existsSync(file)) continue;
  const text = readFileSync(file, 'utf8');
  for (const { re, what } of TTL_LITERALS) {
    for (const match of text.matchAll(re)) {
      ttlLiterals++;
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      fail(
        'TTL НЕ ИМПОРТИРОВАН',
        `${rel(file)}:${line} — ${what}: «${match[0].trim()}».\n` +
          '      Два числа, каждое из которых по отдельности выглядит правильным, разойдутся\n' +
          '      молча: код останется рабочим, тесты зелёными, а опубликованное обещание о\n' +
          '      сроке хранения станет неправдой. Значение берётся только из LEAD_TTL_SECONDS.',
      );
    }
  }
}

const expectedTtl = Math.floor(ATTRIBUTION_TTL_MS / 1000);
if (LEAD_TTL_SECONDS !== expectedTtl) {
  fail(
    'TTL НЕ ИМПОРТИРОВАН',
    `LEAD_TTL_SECONDS = ${LEAD_TTL_SECONDS}, а из ATTRIBUTION_TTL_MS выводится ${expectedTtl}.\n` +
      '      Импорт на месте, но значение получено не из него — самый тихий из вариантов\n' +
      '      расхождения: ошибку видно только сравнением двух файлов.',
  );
}

if (LEAD_TTL_SECONDS < 60) {
  fail(
    'TTL НЕ ИМПОРТИРОВАН',
    `LEAD_TTL_SECONDS = ${LEAD_TTL_SECONDS} — меньше минимального expirationTtl, который принимает KV.\n` +
      '      Рантайм отвергнет запись целиком: заявка не попадёт в журнал вовсе.',
  );
}

const GUARDED = [
  'FIELDS',
  'HONEYPOT_FIELD',
  'HONEYPOT',
  'TURNSTILE_TOKEN_FIELD',
  'CONTACT_CHANNELS',
  'DIRECTIONS',
  'LOCALES',
  'ERROR_CODES',
  'LEAD_TTL_SECONDS',
  'LEAD_KEY_PREFIX',
  'BODY_MAX_BYTES',
  'RATE_LIMIT_MAX',
  'RATE_LIMIT_WINDOW_MS',
  'NAME_MAX_LEN',
  'CONTACT_MAX_LEN',
  'SUCCESS_ROUTE',
];
const DECLARATION = new RegExp(
  String.raw`^\s*(?:export\s+)?(?:const|let|var)\s+(${GUARDED.join('|')})\s*[:=]`,
  'gm',
);

const RECONCILED_FILE = 'src/lib/start-codec.ts';

const CANONICAL_CONTRACT = 'src/lib/lead-contract.ts';

const secondDeclarations: string[] = [];
for (const file of scanFiles) {
  const relative = rel(file);
  if (relative === rel(path.resolve(projectRoot, contractPath))) continue;
  if (relative === CANONICAL_CONTRACT) continue;
  if (relative === RECONCILED_FILE) continue;
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(DECLARATION)) {
    const line = text.slice(0, match.index).split(/\r?\n/).length;
    secondDeclarations.push(`${relative}:${line} — ${match[1]}`);
    fail(
      'ВТОРОЕ ОБЪЯВЛЕНИЕ КОНТРАКТА',
      `${relative}:${line} объявляет собственный ${match[1]}.\n` +
        `      Контракт объявлен в ${contractPath} и обязан импортироваться, а не повторяться:\n` +
        '      две таблицы расходятся в день, когда правят одну из них.',
    );
  }
}

const CODEC_SENTINEL = 'none';
const codecDirections = new Set(Object.keys(CODEC_DIRECTIONS).filter((k) => k !== CODEC_SENTINEL));
for (const direction of DIRECTIONS) {
  if (codecDirections.has(direction)) continue;
  fail(
    'ВТОРОЕ ОБЪЯВЛЕНИЕ КОНТРАКТА',
    `контракт знает направление «${direction}», а ${RECONCILED_FILE} — нет.\n` +
      '      Метка `?start=` закодирует его как «направление не выбрано», и источник лида\n' +
      '      из бота потеряется молча.',
  );
}
for (const direction of codecDirections) {
  if ((DIRECTIONS as readonly string[]).includes(direction)) continue;
  fail(
    'ВТОРОЕ ОБЪЯВЛЕНИЕ КОНТРАКТА',
    `${RECONCILED_FILE} знает направление «${direction}», которого нет в контракте.`,
  );
}

const codecLocales = new Set(Object.keys(CODEC_LOCALES));
for (const locale of LOCALES) {
  if (codecLocales.has(locale)) continue;
  fail(
    'ВТОРОЕ ОБЪЯВЛЕНИЕ КОНТРАКТА',
    `контракт знает локаль «${locale}», а ${RECONCILED_FILE} — нет.`,
  );
}
for (const locale of codecLocales) {
  if ((LOCALES as readonly string[]).includes(locale)) continue;
  fail(
    'ВТОРОЕ ОБЪЯВЛЕНИЕ КОНТРАКТА',
    `${RECONCILED_FILE} знает локаль «${locale}», которой нет в контракте.`,
  );
}

console.log('--- Гейт контракта /api/lead ---');
console.log(`  разметка:            ${markupPath}`);
console.log(`  контракт (текст):    ${contractPath}`);
console.log('  контракт (значения): src/lib/lead-contract.ts — всегда настоящий модуль, см. шапку');
console.log(`  область обхода:      ${scanDirs.join(', ')} — ${scanFiles.length} файл(ов)`);
console.log(
  `  1. КОНТРАКТ ПОЛЕЙ:            тегов полей ${taggedFields} (без имени ${unnamedFields}, именем из контракта ${boundByImport}), ` +
    `имён ${markupNames.size}; ${FIELDS.contactChannel}: ${[...(markupEnums[FIELDS.contactChannel] ?? [])].join('/') || '—'}; ` +
    `${FIELDS.direction}: ${[...(markupEnums[FIELDS.direction] ?? [])].join('/') || '—'}`,
);
console.log(
  `  2. TTL НЕ ИМПОРТИРОВАН:       LEAD_TTL_SECONDS = ${LEAD_TTL_SECONDS} c из ATTRIBUTION_TTL_MS = ${ATTRIBUTION_TTL_MS} мс; ` +
    `литералов найдено ${ttlLiterals}; исключение: ${[...TTL_SOURCE_FILES].join(', ')}`,
);
console.log(
  `  3. ВТОРОЕ ОБЪЯВЛЕНИЕ:         объявлений вне контракта ${secondDeclarations.length}; ` +
    `сверен ${RECONCILED_FILE} (направлений ${codecDirections.size}, локалей ${codecLocales.size})`,
);

if (failures.length > 0) {
  console.error(`\nFAIL: гейт контракта нашёл ${failures.length} проблем(ы):\n`);
  for (const line of failures) console.error(`  ${line}`);
  console.error(
    '\nКонтракт /api/lead объявлен ровно в одном файле и связан импортом с обещанием,\n' +
      'которое уже опубликовано посетителю. Расхождение чинится правкой ОБЕИХ сторон,\n' +
      'а не ослаблением проверки.',
  );
  process.exit(1);
}

console.log('\nPASS: разметка, контракт и срок хранения сходятся; второго объявления нет.');
