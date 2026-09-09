
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { stripJsComments } from './lib/strip-comments.ts';

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

const i18nDir = argValue('i18n', path.join('src', 'i18n'));
const botI18nDir = argValue('bot-i18n', path.join('workers', 'bot', 'i18n'));
const srcDir = argValue('src', 'src');
const publicDir = argValue('public', 'public');

const MARK_CRYPTO = 'КРИПТОВАЛЮТА-В-ТЕКСТЕ';
const MARK_FONT = 'ЧУЖАЯ-ГАРНИТУРА';
const MARK_TUGRIK = 'ЗНАЧОК-ТУГРИКА-ПОТЕРЯН';
const MARK_NO_DICTS = 'СЛОВАРИ НЕ ОСМОТРЕНЫ';
const MARK_NO_SOURCES = 'ИСХОДНИКИ НЕ ОСМОТРЕНЫ';

const failures: string[] = [];
function fail(mark: string, detail: string): void {
  failures.push(`${mark}: ${detail}`);
}

const rel = (p: string): string => path.relative(projectRoot, p).replace(/\\/g, '/') || p;

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.astro', '.sabotage-tmp']);

function walk(dir: string, keep: (file: string) => boolean, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, keep, out);
    else if (keep(full)) out.push(full);
  }
  return out;
}

const FORBIDDEN_WORDS = ['крипт', 'crypto'];

interface DictFile {
  file: string;
  set: string;
  keys: number;
  values: { path: string; value: string }[];
  json: unknown;
}

function collectValues(node: unknown, at: string, out: { path: string; value: string }[]): void {
  if (typeof node === 'string') {
    out.push({ path: at, value: node });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectValues(v, `${at}[${i}]`, out));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) collectValues(v, at ? `${at}.${k}` : k, out);
  }
}

function readDicts(dir: string, set: string): DictFile[] {
  const absolute = path.resolve(projectRoot, dir);
  const files = walk(absolute, (f) => f.endsWith('.json')).sort();
  return files.map((file) => {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      fail(
        MARK_NO_DICTS,
        `${rel(file)} не разбирается как JSON (${(e as Error).message}).\n` +
          '      Нечитаемый словарь это не «нечего проверять»: гейт не может\n' +
          '      подтвердить отсутствие запрещённого слова в файле, который не открылся.',
      );
      json = {};
    }
    const values: { path: string; value: string }[] = [];
    collectValues(json, '', values);
    return { file, set, keys: Object.keys(json as object).length, values, json };
  });
}

const siteDicts = readDicts(i18nDir, 'site');
const botDicts = readDicts(botI18nDir, 'bot');
const allDicts = [...siteDicts, ...botDicts];

const totalDictValues = allDicts.reduce((n, d) => n + d.values.length, 0);

let cryptoHits = 0;
for (const dict of allDicts) {
  for (const { path: keyPath, value } of dict.values) {
    const lower = value.toLowerCase();
    for (const word of FORBIDDEN_WORDS) {
      if (!lower.includes(word)) continue;
      cryptoHits++;
      fail(
        MARK_CRYPTO,
        `${rel(dict.file)} → ключ «${keyPath}» содержит «${word}»:\n` +
          `      «${value}»\n` +
          '      Решение заказчика Д-05 (26.08.2026, дословно «криптовалюта не будем писать»),\n' +
          '      повторяющее решение 2 круга 12 от 19.08.2026. Действующая формулировка —\n' +
          '      «в ₮ или в других валютах». ⚠️ Если строка скопирована с присланного макета:\n' +
          '      макет откатывает это решение, из него берётся вид и состав, но НЕ текст.',
      );
    }
  }
}

if (allDicts.length === 0 || totalDictValues === 0) {
  fail(
    MARK_NO_DICTS,
    `осмотрено ${allDicts.length} файл(ов) словарей и ${totalDictValues} строковых значений\n` +
      `      искали в: ${rel(path.resolve(projectRoot, i18nDir))}, ${rel(path.resolve(projectRoot, botI18nDir))}\n` +
      '      Ноль осмотренного это НЕ «нечего проверять», а невозможность подтвердить,\n' +
      '      что запрещённого слова в словарях нет: каталог мог переехать или быть\n' +
      '      переименован, и тогда прогон был бы зелёным, не проверив ничего.',
  );
}

const FONT_EXT = ['.ttf', '.otf', '.woff', '.woff2', '.eot'];
const ALLOWED_FACES = ['manrope', 'manrope fallback'];

const GENERIC_FAMILIES = [
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  '-apple-system',
  'blinkmacsystemfont',
  'sans-serif',
  'serif',
  'monospace',
  'cursive',
  'inherit',
];

const STYLE_EXT = ['.css', '.astro', '.ts', '.js', '.mjs', '.html'];

const srcAbs = path.resolve(projectRoot, srcDir);
const publicAbs = path.resolve(projectRoot, publicDir);

const assetFiles = [
  ...walk(srcAbs, () => true),
  ...walk(publicAbs, () => true),
];
const styleFiles = assetFiles.filter((f) => STYLE_EXT.includes(path.extname(f).toLowerCase()));

let robotoFiles = 0;
for (const file of assetFiles) {
  const base = path.basename(file);
  if (!FONT_EXT.includes(path.extname(file).toLowerCase())) continue;
  if (!/roboto/i.test(base)) continue;
  robotoFiles++;
  fail(
    MARK_FONT,
    `${rel(file)} — файл гарнитуры Roboto лёг в репозиторий.\n` +
      '      Решение заказчика Д-02 (26.08.2026, дословно «Оставить Manrope»): каталог\n' +
      '      «шрифт/Roboto/» из присланного пакета не используется. Гарнитура проекта —\n' +
      '      Manrope, сабсет собирается scripts/build-font-subset.py, покрытие Ө/Ү/₮\n' +
      '      стережёт check:font.',
  );
}

function styleText(file: string): string {
  const raw = readFileSync(file, 'utf8');
  const ext = path.extname(file).toLowerCase();

  const noBlock = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  if (ext === '.css') return noBlock;
  if (ext === '.html') return noBlock.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  if (ext === '.astro') {
    return stripJsComments(noBlock).replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  }
  return stripJsComments(raw);
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

function familyList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, '').toLowerCase())
    .filter(Boolean);
}

let faceCount = 0;
let familyDecls = 0;
let fontSansSeen = false;

const FACE_RE = /@font-face\s*\{([\s\S]*?)\}/g;

for (const file of styleFiles) {
  const text = styleText(file);

  for (const m of text.matchAll(FACE_RE)) {
    faceCount++;
    const body = m[1];
    const line = lineOf(text, m.index ?? 0);

    const famMatch = body.match(/font-family\s*:\s*([^;]+)/i);
    const family = famMatch ? familyList(famMatch[1])[0] ?? '' : '';
    if (!ALLOWED_FACES.includes(family)) {
      fail(
        MARK_FONT,
        `${rel(file)}:${line} — @font-face объявляет семейство «${family || '(не указано)'}».\n` +
          `      Разрешены только: ${ALLOWED_FACES.join(', ')} (Д-02, «Оставить Manrope»).\n` +
          '      Это правило шире Roboto намеренно: чёрный список из одного имени был бы\n' +
          '      зелен на любой другой чужой гарнитуре.',
      );
    }

    for (const u of body.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
      if (!/roboto/i.test(u[1])) continue;
      fail(
        MARK_FONT,
        `${rel(file)}:${line} — @font-face грузит файл «${u[1]}».\n` +
          '      Загрузка Roboto запрещена решением Д-02 (26.08.2026, «Оставить Manrope»).',
      );
    }
  }

  const faceRanges: [number, number][] = [];
  for (const m of text.matchAll(FACE_RE)) {
    faceRanges.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  const insideFace = (i: number): boolean => faceRanges.some(([a, b]) => i >= a && i < b);

  for (const m of text.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    const at = m.index ?? 0;
    if (insideFace(at)) continue;
    familyDecls++;
    const families = familyList(m[1]);
    if (families.length === 0) continue;
    const line = lineOf(text, at);

    const robotoAt = families.findIndex((f) => f === 'roboto' || f.startsWith('roboto '));
    if (robotoAt === -1) continue;

    if (robotoAt === 0) {
      fail(
        MARK_FONT,
        `${rel(file)}:${line} — Roboto стоит ПЕРВЫМ в font-family: ${m[1].trim()}\n` +
          '      Первое семейство это то, чем текст рисуется. Д-02 (26.08.2026,\n' +
          '      «Оставить Manrope») запрещает такую подмену. В системном стеке Roboto\n' +
          '      допустим только как ЗАПАСНОЕ имя, не первым.',
      );
      continue;
    }
    if (!families.some((f) => GENERIC_FAMILIES.includes(f))) {
      fail(
        MARK_FONT,
        `${rel(file)}:${line} — Roboto назван в списке без единого системного или\n` +
          `      родового имени: ${m[1].trim()}\n` +
          '      Такой список — выбор гарнитуры, а не системный стек. Д-02 разрешает\n' +
          `      Roboto только рядом с одним из: ${GENERIC_FAMILIES.slice(0, 4).join(', ')}, …`,
      );
    }
  }

  for (const m of text.matchAll(/--font-sans\s*:\s*([^;}]+)/g)) {
    fontSansSeen = true;
    const first = familyList(m[1])[0] ?? '';
    if (first === 'manrope') continue;
    fail(
      MARK_FONT,
      `${rel(file)}:${lineOf(text, m.index ?? 0)} — во главе --font-sans стоит «${first}», а не Manrope.\n` +
        '      Д-02 (26.08.2026, дословно «Оставить Manrope») — это не только запрет на\n' +
        '      Roboto, но и утверждение о том, ЧЕМ набран сайт. Замена головы стека на\n' +
        '      любое другое семейство отменяет решение заказчика так же, как Roboto.',
    );
  }
}

if (styleFiles.length === 0) {
  fail(
    MARK_NO_SOURCES,
    `по корням --src и --public осмотрено 0 файлов со стилями\n` +
      `      пробовали: ${rel(srcAbs)}, ${rel(publicAbs)}\n` +
      '      Сертифицировать отсутствие чужой гарнитуры в файлах, которых гейт не\n' +
      '      открывал, нельзя. Проверьте пути — каталог мог переехать.',
  );
} else if (!fontSansSeen) {
  fail(
    MARK_FONT,
    'токен --font-sans не найден ни в одном осмотренном файле стилей.\n' +
      '      Он и есть место, где живёт решение Д-02: без него утверждение «сайт набран\n' +
      '      Manrope» проверить нечем, и молчание гейта означало бы не «всё хорошо», а\n' +
      '      «смотреть было не на что».',
  );
}

const TUGRIK = '₮';
const TUGRIK_KEY = 'faq.a_currency';
let tugrikChecked = 0;

for (const dict of siteDicts) {
  const faq = (dict.json as Record<string, unknown>)?.faq as Record<string, unknown> | undefined;
  const value = faq?.a_currency;

  if (typeof value !== 'string') {
    fail(
      MARK_TUGRIK,
      `${rel(dict.file)} — ключа ${TUGRIK_KEY} нет или он не строка.\n` +
        '      Д-06 (26.08.2026, дословно «оставим значек тугрика») требует значок на\n' +
        '      странице, а после снятия блока «Коротко о программе» (Д-25, 28.08.2026)\n' +
        '      это единственное место, где он остался.\n' +
        '      ⚠️ check:i18n этого не поймал бы: он сверяет наборы ключей между локалями,\n' +
        '      а одинаково пропавший во всех трёх ключ для него симметричен.',
    );
    continue;
  }
  tugrikChecked++;
  if (value.includes(TUGRIK)) continue;
  fail(
    MARK_TUGRIK,
    `${rel(dict.file)} — в ${TUGRIK_KEY} нет значка «${TUGRIK}»: «${value}».\n` +
      '      Д-06 (26.08.2026, дословно «оставим значек тугрика»). Решение действует как\n' +
      '      запрет на «улучшение» символа до MNT: покрытие глифа стережёт check:font,\n' +
      '      и подмена молча обесценила бы обе проверки сразу.',
  );
}

if (tugrikChecked === 0 && siteDicts.length > 0) {
  fail(
    MARK_TUGRIK,
    `ни в одном словаре сайта не нашлось ${TUGRIK_KEY} — проверять было нечего.`,
  );
}

console.log('--- Гейт решений заказчика (Д-02 шрифт, Д-05 криптовалюта, Д-06 ₮) ---');
console.log(
  `  А. слово из Д-05 в значениях словарей: файлов ${allDicts.length} ` +
    `(сайт ${siteDicts.length}: ${siteDicts.map((d) => path.basename(d.file)).join(', ') || '—'}; ` +
    `бот ${botDicts.length}: ${botDicts.map((d) => path.basename(d.file)).join(', ') || '—'})`,
);
console.log(
  `     ключей верхнего уровня ${allDicts.reduce((n, d) => n + d.keys, 0)}, ` +
    `строковых значений осмотрено ${totalDictValues}, ` +
    `искали ${FORBIDDEN_WORDS.map((w) => `«${w}»`).join(' и ')} без учёта регистра — совпадений ${cryptoHits}`,
);
console.log(
  `  Б. гарнитура (Д-02): файлов в ${rel(srcAbs)} и ${rel(publicAbs)} — ${assetFiles.length}, ` +
    `из них со стилями ${styleFiles.length}`,
);
console.log(
  `     блоков @font-face ${faceCount} (разрешены: ${ALLOWED_FACES.join(', ')}), ` +
    `объявлений font-family вне них ${familyDecls}, ` +
    `файлов гарнитуры с искомым именем ${robotoFiles}, ` +
    `--font-sans ${fontSansSeen ? 'найден, во главе Manrope' : 'НЕ НАЙДЕН'}`,
);
console.log(
  `  В. значок валюты (Д-06): сверен ${TUGRIK_KEY} в ${tugrikChecked} ` +
    `словар(е/ях) сайта из ${siteDicts.length}, значок «${TUGRIK}» обязан встречаться в строке`,
);

if (failures.length > 0) {
  console.error(`\nFAIL: гейт решений заказчика нашёл ${failures.length} нарушени(е/я/й):\n`);
  for (const line of failures) console.error(`  ${line}\n`);
  console.error(
    'Все три решения приняты заказчиком 26.08.2026 при разборе присланного дизайн-пакета\n' +
      'и записаны дословно в .planning/phases/10-client-design-revision/10-CONTEXT.md\n' +
      '(Д-02, Д-05, Д-06). Два из трёх нарушаются копированием «как в макете»: сам пакет\n' +
      'содержит и слово «криптовалюта» в тексте FAQ, и каталог «шрифт/Roboto/».\n' +
      'Ослаблять гейт нельзя — из макета берётся вид и состав, но не текст и не гарнитура.',
  );
  process.exit(1);
}

console.log('\nPASS: три решения заказчика соблюдены — Manrope на месте, запрещённого слова нет, ₮ цел.');
