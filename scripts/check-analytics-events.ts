
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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

const srcDir = argValue('src', 'src');
const docPath = argValue('doc', 'docs/analytics-events.md');

const GA4_NAME_MAX = 40;

const failures: string[] = [];
const shown = new Map<string, number>();
const MAX_DETAILS = 8;

function fail(check: string, detail: string): void {
  const n = (shown.get(check) ?? 0) + 1;
  shown.set(check, n);
  if (n <= MAX_DETAILS) failures.push(`${check}: ${detail}`);
  else if (n === MAX_DETAILS + 1) failures.push(`${check}: ... показаны первые ${MAX_DETAILS}`);
}

const SCAN_EXT = ['.ts', '.js', '.mjs', '.astro'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.astro', '.sabotage-tmp']);

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

function stripMarkupComments(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, (m) => m.replace(/[^\n]/g, ' '));
}

function codeOf(file: string): string {
  const text = readFileSync(file, 'utf8');

  if (!file.endsWith('.astro')) return stripJsComments(text);

  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return stripMarkupComments(text);

  const frontmatter = stripJsComments(match[1]);
  const template = stripMarkupComments(text.slice(match[0].length));
  return `${frontmatter}\n${template}`;
}

const absoluteSrc = path.resolve(projectRoot, srcDir);
if (!existsSync(absoluteSrc)) {
  console.error(`FAIL: нет каталога ${srcDir}`);
  process.exit(1);
}
const sourceFiles = walk(absoluteSrc);
const rel = (file: string): string => path.relative(projectRoot, file).replace(/\\/g, '/');

const eventsModulePath = path.join(absoluteSrc, 'scripts', 'analytics', 'events.ts');
if (!existsSync(eventsModulePath)) {
  console.error(`FAIL: нет модуля ${rel(eventsModulePath)} — словарь событий читать неоткуда`);
  process.exit(1);
}

const eventsModule = (await import(pathToFileURL(eventsModulePath).href)) as {
  EVENT_NAMES?: readonly string[];
  PROVIDER_OWNED_EVENTS?: readonly string[];
};

if (!Array.isArray(eventsModule.EVENT_NAMES) || !Array.isArray(eventsModule.PROVIDER_OWNED_EVENTS)) {
  console.error('FAIL: events.ts не экспортирует EVENT_NAMES и PROVIDER_OWNED_EVENTS — контракт нарушен');
  process.exit(1);
}

const declaredEvents = new Set(eventsModule.EVENT_NAMES);
const providerOwned = new Set(eventsModule.PROVIDER_OWNED_EVENTS);

const TRACK_CALL = /\btrack\(\s*['"]([^'"]+)['"]/g;
const TRACK_PARAMS = /\btrack\(\s*['"][^'"]+['"]\s*,\s*\{([\s\S]*?)\}\s*\)/g;
const PARAM_KEY = /(^|[\s,{])([A-Za-z_$][\w$]*)\s*:/g;

const eventsInCode = new Map<string, string[]>();
const paramsInCode = new Map<string, string[]>();

for (const file of sourceFiles) {
  const text = codeOf(file);

  for (const match of text.matchAll(TRACK_CALL)) {
    const name = match[1];
    const where = eventsInCode.get(name) ?? [];
    if (!where.includes(rel(file))) where.push(rel(file));
    eventsInCode.set(name, where);
  }

  for (const match of text.matchAll(TRACK_PARAMS)) {
    for (const key of match[1].matchAll(PARAM_KEY)) {
      const param = key[2];
      const where = paramsInCode.get(param) ?? [];
      if (!where.includes(rel(file))) where.push(rel(file));
      paramsInCode.set(param, where);
    }
  }
}

const absoluteDoc = path.resolve(projectRoot, docPath);
if (!existsSync(absoluteDoc)) {
  console.error(`FAIL: нет документа ${docPath}`);
  process.exit(1);
}

const doc = readFileSync(absoluteDoc, 'utf8');

const START = '<!-- events-table:start -->';
const END = '<!-- events-table:end -->';
const from = doc.indexOf(START);
const to = doc.indexOf(END);
if (from === -1 || to === -1 || to < from) {
  console.error(
    `FAIL: в ${docPath} нет размеченного участка таблицы событий (${START} … ${END}).\n` +
      '      Маркеры обязательны: по ним гейт находит машиночитаемую часть документа.',
  );
  process.exit(1);
}

const tableBlock = doc.slice(from + START.length, to);
const ROW = /^\|\s*`([^`]+)`\s*\|(.*)\|\s*$/;

const documentedEvents = new Set<string>();
const documentedParams = new Set<string>();

for (const line of tableBlock.split(/\r?\n/)) {
  const row = ROW.exec(line.trim());
  if (!row) continue;
  documentedEvents.add(row[1]);

  const cells = line.trim().split('|');
  const paramsCell = cells[3] ?? '';
  for (const param of paramsCell.matchAll(/`([^`]+)`/g)) documentedParams.add(param[1]);
}

if (documentedEvents.size === 0) {
  console.error(`FAIL: в ${docPath} размеченная таблица есть, но в ней нет ни одной строки события`);
  process.exit(1);
}

for (const [name, files] of eventsInCode) {
  if (!documentedEvents.has(name)) {
    fail(
      'СОБЫТИЕ БЕЗ ДОКУМЕНТАЦИИ',
      `«${name}» отправляется из ${files.join(', ')}, но в таблице ${docPath} его нет.\n` +
        '      Событие, которого нет в словаре, в панели выглядит мусором, и первым делом его выключат.',
    );
  }
}

for (const name of declaredEvents) {
  if (!eventsInCode.has(name)) {
    fail(
      'ДОКУМЕНТИРОВАНО, НО НЕ СУЩЕСТВУЕТ',
      `«${name}» объявлено в EVENT_NAMES, но ни одного вызова track('${name}') в ${srcDir}/ нет.`,
    );
  }
}

for (const name of documentedEvents) {
  if (providerOwned.has(name)) continue;
  if (!eventsInCode.has(name)) {
    fail(
      'ДОКУМЕНТИРОВАНО, НО НЕ СУЩЕСТВУЕТ',
      `«${name}» описано в ${docPath}, но ни одного вызова track('${name}') в ${srcDir}/ нет.\n` +
        '      Документ, обещающий несуществующее событие, — молчаливый обман, а не опечатка.',
    );
  }
}

for (const name of new Set([...documentedEvents, ...eventsInCode.keys()])) {
  if (name.length > GA4_NAME_MAX) {
    fail(
      'ЛИМИТ ИМЕНИ GA4',
      `имя события «${name}» длиной ${name.length} > ${GA4_NAME_MAX} символов — GA4 такое событие отбросит.`,
    );
  }
}

for (const name of new Set([...documentedParams, ...paramsInCode.keys()])) {
  if (name.length > GA4_NAME_MAX) {
    fail(
      'ЛИМИТ ИМЕНИ GA4',
      `имя параметра «${name}» длиной ${name.length} > ${GA4_NAME_MAX} символов.`,
    );
  }
}

const PROVIDER_CALL = /\bwindow\s*\.\s*(gtag|clarity)\b/g;
const ALLOWED_PREFIX = path.join('scripts', 'analytics') + path.sep;

let providerHits = 0;
for (const file of sourceFiles) {
  const relativeToSrc = path.relative(absoluteSrc, file);
  if (relativeToSrc.startsWith(ALLOWED_PREFIX)) continue;

  const text = codeOf(file);
  for (const match of text.matchAll(PROVIDER_CALL)) {
    providerHits++;
    const line = text.slice(0, match.index).split(/\r?\n/).length;
    fail(
      'ПРЯМОЕ ОБРАЩЕНИЕ К ПРОВАЙДЕРУ',
      `${rel(file)}:${line} — window.${match[1]}. Провайдер вызывается только из ${srcDir}/scripts/analytics/.\n` +
        '      При блокировщике это TypeError, который уронит весь обработчик вместе с переходом по ссылке.',
    );
  }
}

console.log(`--- Гейт слоя событий (${srcDir}/ ↔ ${docPath}) ---`);
console.log(`  событий в коде:        ${eventsInCode.size} (${[...eventsInCode.keys()].sort().join(', ')})`);
console.log(`  событий в документе:   ${documentedEvents.size}, из них шлёт провайдер: ${[...documentedEvents].filter((n) => providerOwned.has(n)).join(', ') || '(нет)'}`);
console.log(`  параметров сверено:    ${new Set([...documentedParams, ...paramsInCode.keys()]).size} (лимит имени ${GA4_NAME_MAX})`);
console.log(`  файлов просмотрено:    ${sourceFiles.length}, прямых обращений к провайдеру: ${providerHits}`);

if (failures.length > 0) {
  console.error(`\nFAIL: гейт слоя событий нашёл ${failures.length} проблем(ы):\n`);
  for (const line of failures) console.error(`  ${line}`);
  console.error(
    '\nИмена событий менять нельзя в одностороннем порядке: docs/analytics-dictionary.md уже отдан\n' +
      'заказчику и обещает конкретную воронку, а переименование обнуляет историю в панели.',
  );
  process.exit(1);
}

console.log('\nPASS: код и словарь событий сходятся, провайдер не вызывается напрямую.');
