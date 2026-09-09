
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

const modulePath = argValue('module', 'src/lib/start-codec.ts');
const vectorsPath = argValue('vectors', 'tests/fixtures/start-codec-vectors.json');

type Direction = 'affiliate' | 'bank' | 'teamcash' | 'none';
type Locale = 'mn' | 'ru' | 'en';

interface StartPayload {
  source: string;
  direction: Direction;
  locale: Locale;
  campaign: string;
  click: string;
}

interface Codec {
  PAYLOAD_VERSION: string;
  PAYLOAD_MAX: number;
  DIRECTIONS: Record<Direction, string>;
  LOCALES: Record<Locale, string>;
  LIMITS: { source: number; campaign: number; click: number };
  normalizeToken(raw: string, max: number): string;
  encodeStart(p: StartPayload): string;
  decodeStart(raw: string): StartPayload | null;
}

interface Vector {
  note?: string;
  payload: StartPayload;
  encoded: string;
}

const failures: string[] = [];

const MAX_DETAILS = 5;
const shown = new Map<string, number>();

function fail(check: string, detail: string): void {
  const n = (shown.get(check) ?? 0) + 1;
  shown.set(check, n);
  if (n <= MAX_DETAILS) failures.push(`${check}: ${detail}`);
  else if (n === MAX_DETAILS + 1) failures.push(`${check}: ... и другие, показаны первые ${MAX_DETAILS}`);
}

function countOf(check: string): number {
  return shown.get(check) ?? 0;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const absoluteModule = path.resolve(projectRoot, modulePath);
if (!existsSync(absoluteModule)) {
  console.error(`FAIL: нет модуля ${modulePath}`);
  process.exit(1);
}
const codec = (await import(pathToFileURL(absoluteModule).href)) as Codec;

for (const name of ['PAYLOAD_VERSION', 'PAYLOAD_MAX', 'DIRECTIONS', 'LOCALES', 'LIMITS', 'normalizeToken', 'encodeStart', 'decodeStart'] as const) {
  if (codec[name] === undefined) {
    console.error(`FAIL: модуль ${modulePath} не экспортирует ${name} — контракт нарушен`);
    process.exit(1);
  }
}

const { PAYLOAD_MAX, DIRECTIONS, LOCALES, LIMITS, encodeStart, decodeStart } = codec;

const TELEGRAM_START_PAYLOAD_MAX = 64;
if (PAYLOAD_MAX > TELEGRAM_START_PAYLOAD_MAX) {
  console.error(
    `FAIL: модуль объявляет PAYLOAD_MAX = ${PAYLOAD_MAX}, а Telegram принимает не более ` +
      `${TELEGRAM_START_PAYLOAD_MAX} символов в payload команды /start. Всё, что длиннее, ` +
      'будет обрезано, и уже розданные рекламные ссылки перестанут нести метку.',
  );
  process.exit(1);
}

const EFFECTIVE_MAX = Math.min(PAYLOAD_MAX, TELEGRAM_START_PAYLOAD_MAX);

const directions = Object.keys(DIRECTIONS) as Direction[];
const locales = Object.keys(LOCALES) as Locale[];
const sources = ['', 'f', 'fb', 'utm2', 'tiktok-ads', 'x'.repeat(LIMITS.source)];
const campaigns = ['', 'q3', 'aug-promo', 'c'.repeat(LIMITS.campaign)];
const clicks = ['', '7f3a91b2e0', '9z8y7x6w5v', '1'.repeat(LIMITS.click)];

const TG_ALPHABET = /^[A-Za-z0-9_-]+$/;

let combinations = 0;
let longest = { payload: '', length: 0 };

for (const direction of directions) {
  for (const locale of locales) {
    for (const source of sources) {
      for (const campaign of campaigns) {
        for (const click of clicks) {
          combinations++;
          const input: StartPayload = { source, direction, locale, campaign, click };
          const label = JSON.stringify(input);

          let encoded: string;
          try {
            encoded = encodeStart(input);
          } catch (err) {

            fail('ДЛИНА ИЛИ АЛФАВИТ', `encodeStart бросил на законном входе ${label}: ${(err as Error).message}`);
            continue;
          }

          if (encoded.length > EFFECTIVE_MAX) {
            fail('ДЛИНА ИЛИ АЛФАВИТ', `payload ${encoded.length} символ(ов) > ${EFFECTIVE_MAX} на входе ${label}: ${encoded}`);
          }
          if (!TG_ALPHABET.test(encoded)) {
            fail('ДЛИНА ИЛИ АЛФАВИТ', `payload вне алфавита Telegram на входе ${label}: ${encoded}`);
          }
          if (encoded.length > longest.length) longest = { payload: encoded, length: encoded.length };

          const back = decodeStart(encoded);
          if (back === null) {
            fail('ПЕРЕБОР ДОМЕНА', `decodeStart вернул null на собственном payload «${encoded}» (вход ${label})`);
          } else if (!same(back, input)) {
            fail('ПЕРЕБОР ДОМЕНА', `круг не сошёлся: ${label} -> «${encoded}» -> ${JSON.stringify(back)}`);
          }
        }
      }
    }
  }
}

const absoluteVectors = path.resolve(projectRoot, vectorsPath);
if (!existsSync(absoluteVectors)) {
  console.error(`FAIL: нет файла векторов ${vectorsPath}`);
  process.exit(1);
}

let vectors: Vector[];
try {
  const parsed: unknown = JSON.parse(readFileSync(absoluteVectors, 'utf8'));
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('ожидался непустой массив');
  vectors = parsed as Vector[];
} catch (err) {
  console.error(`FAIL: ${vectorsPath} не читается как массив векторов: ${(err as Error).message}`);
  process.exit(1);
}

for (const [i, vector] of vectors.entries()) {
  if (!vector || typeof vector.encoded !== 'string' || typeof vector.payload !== 'object') {
    fail('ЗОЛОТЫЕ ВЕКТОРЫ', `вектор #${i} без payload/encoded`);
    continue;
  }

  let encoded: string;
  try {
    encoded = encodeStart(vector.payload);
  } catch (err) {
    fail('ЗОЛОТЫЕ ВЕКТОРЫ', `вектор #${i} (${vector.note ?? ''}) больше не кодируется: ${(err as Error).message}`);
    continue;
  }

  if (encoded !== vector.encoded) {
    fail(
      'ЗОЛОТЫЕ ВЕКТОРЫ',
      `вектор #${i} (${vector.note ?? ''}) разошёлся с замороженным:\n` +
        `      заморожено: ${vector.encoded}\n` +
        `      получилось: ${encoded}`,
    );
  }

  const back = decodeStart(vector.encoded);
  if (!same(back, vector.payload)) {
    fail(
      'ЗОЛОТЫЕ ВЕКТОРЫ',
      `вектор #${i}: замороженная строка «${vector.encoded}» больше не разбирается в свой payload, получилось ${JSON.stringify(back)}`,
    );
  }
}

const coveredDirections = new Set(vectors.map((v) => v?.payload?.direction));
const coveredLocales = new Set(vectors.map((v) => v?.payload?.locale));
for (const d of directions) {
  if (!coveredDirections.has(d)) fail('ЗОЛОТЫЕ ВЕКТОРЫ', `ни один вектор не покрывает направление ${d}`);
}
for (const l of locales) {
  if (!coveredLocales.has(l)) fail('ЗОЛОТЫЕ ВЕКТОРЫ', `ни один вектор не покрывает локаль ${l}`);
}

const DECLARATION = /(?:^|[\s;({])(?:export\s+)?(?:const|let|var)\s+PAYLOAD_VERSION\s*=/gm;
const SCAN_DIRS = ['src', 'functions', 'scripts', 'workers'];
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

const declarationFiles: string[] = [];
let declarationCount = 0;
for (const dir of SCAN_DIRS) {
  const abs = path.join(projectRoot, dir);
  if (!existsSync(abs)) continue;
  for (const file of walk(abs)) {
    const matches = readFileSync(file, 'utf8').match(DECLARATION);
    if (matches) {
      declarationCount += matches.length;
      declarationFiles.push(path.relative(projectRoot, file).replace(/\\/g, '/'));
    }
  }
}

if (declarationCount !== 1) {
  fail(
    'ЕДИНСТВЕННОЕ ОБЪЯВЛЕНИЕ',
    `PAYLOAD_VERSION объявлена ${declarationCount} раз(а) в: ${declarationFiles.join(', ') || '(нигде)'}.\n` +
      '      Кодек обязан существовать одним файлом на всех потребителей: сайт, бэкенд формы (Фаза 4)\n' +
      '      и воркер бота (Фаза 6) импортируют его, а не копируют.',
  );
}

const base: StartPayload = { source: 'fb', direction: 'affiliate', locale: 'mn', campaign: '', click: '' };
const mustThrow: { name: string; input: StartPayload }[] = [
  { name: 'источник с пробелом и заглавными («FB Ads»)', input: { ...base, source: 'FB Ads' } },
  { name: 'источник с разметкой («<b>»)', input: { ...base, source: '<b>' } },
  { name: `кампания длиннее лимита (${LIMITS.campaign + 1} симв.)`, input: { ...base, campaign: 'x'.repeat(LIMITS.campaign + 1) } },
  { name: `хвост клика длиннее лимита (${LIMITS.click + 1} симв.)`, input: { ...base, click: '9'.repeat(LIMITS.click + 1) } },
];

for (const c of mustThrow) {
  let threw = false;
  let result = '';
  try {
    result = encodeStart(c.input);
  } catch {
    threw = true;
  }
  if (!threw) {
    fail(
      'БРОСАЕТ НА ВХОДЕ ВНЕ АЛФАВИТА',
      `${c.name}: encodeStart не бросил, а вернул «${result}» — значит вход усечён молча`,
    );
  }
}

const outOfDomain: { name: string; input: StartPayload }[] = [
  { name: 'направление в верхнем регистре («AFFILIATE»)', input: { ...base, direction: 'AFFILIATE' as unknown as Direction } },
  { name: 'несуществующее направление («partner»)', input: { ...base, direction: 'partner' as unknown as Direction } },
  { name: 'пустое направление', input: { ...base, direction: '' as unknown as Direction } },
  { name: 'несуществующая локаль («de»)', input: { ...base, locale: 'de' as unknown as Locale } },
  { name: 'локаль в верхнем регистре («MN»)', input: { ...base, locale: 'MN' as unknown as Locale } },

  { name: 'ключ из прототипа («toString»)', input: { ...base, direction: 'toString' as unknown as Direction } },
];

for (const c of outOfDomain) {
  let threw = false;
  let result = '';
  try {
    result = encodeStart(c.input);
  } catch {
    threw = true;
  }
  if (!threw) {
    fail(
      'КЛЮЧ ВНЕ ДОМЕНА',
      `${c.name}: encodeStart не бросил, а вернул «${result}» — payload внешне цел, ` +
        `а decodeStart разбирает его в ${JSON.stringify(decodeStart(result))}`,
    );
  }
}

console.log(`--- Гейт кодека ?start= (${modulePath}) ---`);
console.log(`  перебор домена:      ${combinations} комбинаций, круг сошёлся у ${combinations - countOf('ПЕРЕБОР ДОМЕНА')}`);
console.log(`  длина и алфавит:     самый длинный payload ${longest.length} из ${EFFECTIVE_MAX} (потолок Telegram ${TELEGRAM_START_PAYLOAD_MAX}, модуль объявляет ${PAYLOAD_MAX}) — «${longest.payload}»`);
console.log(`  золотые векторы:     ${vectors.length} сверено байт в байт (${vectorsPath})`);
console.log(`  объявлений версии:   ${declarationCount} в ${declarationFiles.join(', ') || '(нигде)'}`);
console.log(`  проверка на throw:   ${mustThrow.length} значений вне алфавита/лимита`);
console.log(`  ключи вне домена:    ${outOfDomain.length} направлений и локалей, которых не существует`);

if (failures.length > 0) {
  console.error(`\nFAIL: гейт кодека нашёл ${failures.length} проблем(ы):\n`);
  for (const line of failures) console.error(`  ${line}`);
  console.error(
    '\nЕсли изменение формата намеренное — оно делается повышением PAYLOAD_VERSION с сохранением\n' +
      'разбора старой версии, а НЕ правкой векторов. Уже розданные ссылки отозвать нельзя.',
  );
  process.exit(1);
}

console.log('\nPASS: кодек воспроизводит замороженный формат.');
