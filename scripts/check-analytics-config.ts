
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
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

const srcDir = argValue('src', 'src');

const PREVIEW_HOST_PATTERN = /(^|\.)pages\.dev$|^localhost$|^127\.0\.0\.1$/;

function readEnv(name: string): string {
  const fromProcess = process.env[name];
  if (typeof fromProcess === 'string') return fromProcess.trim();

  for (const file of ['.env.local', '.env']) {
    const full = path.join(projectRoot, file);
    if (!existsSync(full)) continue;
    for (const line of readFileSync(full, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const at = trimmed.indexOf('=');
      if (at === -1) continue;
      if (trimmed.slice(0, at).trim() !== name) continue;

      let value = trimmed.slice(at + 1).trim();
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
      return value.replace(/^['"]|['"]$/g, '').trim();
    }
  }
  return '';
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

const rel = (file: string): string => path.relative(projectRoot, file).replace(/\\/g, '/');

const GA_LITERAL = /\bG-[A-Z0-9]{6,}\b/g;

const CLARITY_LITERAL = /clarity\.ms\/tag\/([A-Za-z0-9]{5,})/g;

const CLARITY_MODULE = path.join('scripts', 'analytics', 'clarity.ts');

const CONSENT_CALL = 'consentv2';
const TAG_INSERT = 'appendChild';

function lineAt(code: string, index: number): number {
  return code.slice(0, index).split(/\r?\n/).length;
}

function callObject(code: string, from: number): string | null {
  const open = code.indexOf('{', from);
  if (open === -1) return null;
  const between = code.slice(from + CONSENT_CALL.length, open);
  if (!/^['"`]\s*,\s*$/.test(between)) return null;

  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  return null;
}

function deniedIn(object: string, key: string): boolean {
  return new RegExp(`\\b${key}\\s*:\\s*['"\`]denied['"\`]`).test(object);
}

const failures: string[] = [];

function main(): void {
  const siteUrl = readEnv('PUBLIC_SITE_URL');
  const gaId = readEnv('PUBLIC_GA_ID');
  const clarityId = readEnv('PUBLIC_CLARITY_ID');

  let host = '';
  try {
    host = new URL(siteUrl).hostname;
  } catch {
    host = '';
  }
  const isPreview = host === '' || PREVIEW_HOST_PATTERN.test(host);

  console.log(`--- Страж конфигурации аналитики (${srcDir}/) ---`);
  console.log(`  домен сборки:   ${host || '(не задан)'} — режим ${isPreview ? 'превью' : 'БОЕВОЙ'}`);
  console.log(`  PUBLIC_GA_ID:      ${gaId ? 'задан' : '(пусто)'}`);
  console.log(`  PUBLIC_CLARITY_ID: ${clarityId ? 'задан' : '(пусто)'}`);

  if (!gaId) {
    if (isPreview) {
      console.log(
        '\nПРЕДУПРЕЖДЕНИЕ: PUBLIC_GA_ID пуст — аналитики в сборке нет.\n' +
          '  На превью это ШТАТНОЕ состояние: чанк провайдеров вырезан сборщиком,\n' +
          '  ноль запросов к googletagmanager.com, ноль ошибок в консоли.\n' +
          '  Как только PUBLIC_SITE_URL станет боевым доменом, эта проверка начнёт валить сборку.',
      );
    } else {
      failures.push(
        'ID АНАЛИТИКИ НЕ ЗАДАН НА БОЕВОМ ДОМЕНЕ\n' +
          `      домен ${host}, а PUBLIC_GA_ID пуст — сайт запущен и не считает ничего.\n` +
          '      Обнаруживается это обычно через месяц, когда в панели ищут первые цифры\n' +
          '      и находят пустоту за весь период рекламы. Значение выдаёт заказчик\n' +
          '      (docs/ACCESS-SETUP.md) и задаётся ПЕРЕМЕННОЙ РЕПОЗИТОРИЯ GITHUB\n' +
          '      (Settings → Secrets and variables → Actions → Variables), откуда его\n' +
          '      берёт .github/workflows/deploy.yml. Не в панели Cloudflare Pages:\n' +
          '      `wrangler pages deploy ./dist` грузит уже собранный каталог, и система\n' +
          '      сборки Cloudflare — единственный потребитель её переменных — не\n' +
          '      запускается, а astro:env подставляет ID литералом на сборке.',
      );
    }
  }

  if (!clarityId && !isPreview) {
    console.log(
      '\nПРЕДУПРЕЖДЕНИЕ: PUBLIC_CLARITY_ID пуст на боевом домене — записей сессий не будет.\n' +
        '  Это допустимо: Clarity необязателен и может быть выключен осознанно.',
    );
  }

  const absoluteSrc = path.resolve(projectRoot, srcDir);
  if (!existsSync(absoluteSrc)) {
    console.error(`\nFAIL: нет каталога ${srcDir}/ — проверять нечего`);
    process.exit(1);
  }

  const files = walk(absoluteSrc);
  let literals = 0;

  for (const file of files) {
    const text = readFileSync(file, 'utf8');

    for (const match of text.matchAll(GA_LITERAL)) {
      literals++;
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      failures.push(
        'ИДЕНТИФИКАТОР ЛИТЕРАЛОМ В ИСХОДНИКАХ\n' +
          `      ${rel(file)}:${line} — «${match[0]}» вписан в код.\n` +
          '      Клон лендинга под новое гео (INFRA-03) начнёт слать данные в ЧУЖОЙ счётчик,\n' +
          '      и заметить это по работающей странице невозможно. Значение берётся только\n' +
          '      из config.analytics (PUBLIC_GA_ID), пример — в документации, не в коде.',
      );
    }

    for (const match of text.matchAll(CLARITY_LITERAL)) {
      literals++;
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      failures.push(
        'ИДЕНТИФИКАТОР ЛИТЕРАЛОМ В ИСХОДНИКАХ\n' +
          `      ${rel(file)}:${line} — тег Clarity со статическим «${match[1]}».\n` +
          '      Адрес тега собирается только из config.analytics.clarityId подстановкой.',
      );
    }
  }

  console.log(`  файлов просмотрено: ${files.length}, литералов найдено: ${literals}`);

  const clarityPath = path.join(absoluteSrc, CLARITY_MODULE);

  if (!existsSync(clarityPath)) {

    failures.push(
      'МОДУЛЬ CLARITY НЕ НАЙДЕН\n' +
        `      нет ${srcDir}/${CLARITY_MODULE.replace(/\\/g, '/')} — порядок сигнала согласия проверить не по чему.\n` +
        '      Проверка не пропускается: гейт, зелёный на отсутствующем файле, доказывает только\n' +
        '      собственную бесполезность. Либо файл переехал (поправьте CLARITY_MODULE здесь же),\n' +
        '      либо каталог из --src не является деревом исходников проекта.',
    );
  } else {

    const code = stripJsComments(readFileSync(clarityPath, 'utf8'));
    const consentAt = code.indexOf(CONSENT_CALL);
    const insertAt = code.indexOf(TAG_INSERT);

    if (insertAt === -1) {
      failures.push(
        'ТЕГ CLARITY НЕ ВСТАВЛЯЕТСЯ\n' +
          `      в коде ${srcDir}/${CLARITY_MODULE.replace(/\\/g, '/')} нет ${TAG_INSERT} — провайдер не подключается вовсе,\n` +
          '      и о порядке вызовов относительно вставки тега судить не о чем.',
      );
    } else if (consentAt === -1 || consentAt > insertAt) {
      failures.push(
        'СОГЛАСИЕ CLARITY НЕ ПЕРЕДАНО ДО ТЕГА\n' +
          (consentAt === -1
            ? `      в коде ${srcDir}/${CLARITY_MODULE.replace(/\\/g, '/')} нет вызова ${CONSENT_CALL} вовсе.\n`
            : `      ${CONSENT_CALL} стоит в строке ${lineAt(code, consentAt)}, а тег вставляется строкой ${lineAt(code, insertAt)} — то есть РАНЬШЕ.\n`) +
          '      Последствие замерено, а не предположено: Clarity ставит сторонние cookies (CLID, SM,\n' +
          '      MUID и синхронизация с c.bing.com), аудит Lighthouse third-party-cookies уходит в ноль,\n' +
          '      best-practices падает со 100 до 77 при пороге проекта 90, CI краснеет и deploy.yml\n' +
          '      такую сборку не деплоит. Замер плана 03-07, разбор — docs/ops.md §7.4.\n' +
          `      Сигнал обязан быть ПЕРВЫМ элементом очереди: первое, что Clarity слышит, — «cookies не ставить».`,
      );
    } else {
      const object = callObject(code, consentAt);
      if (object === null || !deniedIn(object, 'ad_Storage') || !deniedIn(object, 'analytics_Storage')) {
        failures.push(
          'УМОЛЧАНИЕ CLARITY НЕ «БЕЗ COOKIES»\n' +
            `      вызов ${CONSENT_CALL} до тега есть (строка ${lineAt(code, consentAt)}), но в его объекте нет\n` +
            "      одновременно ad_Storage: 'denied' и analytics_Storage: 'denied'.\n" +
            `      Найдено: ${object === null ? '(объект-аргумент не разобран)' : object.replace(/\s+/g, ' ')}\n` +
            '      ⚠️ ЗАГЛАВНЫЕ S В ad_Storage И analytics_Storage — ДОКУМЕНТИРОВАННОЕ НАПИСАНИЕ MICROSOFT\n' +
            '      [learn.microsoft.com/clarity/setup-and-installation/clarity-consent-api-v2], а не опечатка.\n' +
            '      «Исправление» их в нижний регистр выглядит уборкой и тихо обезоруживает весь сигнал:\n' +
            '      вызов остаётся на месте, Clarity его не понимает, cookies возвращаются.',
        );
      } else {
        console.log(
          `  порядок в ${srcDir}/${CLARITY_MODULE.replace(/\\/g, '/')}: сигнал согласия — строка ${lineAt(code, consentAt)}, ` +
            `вставка тега — строка ${lineAt(code, insertAt)} (по коду без комментариев)`,
        );
      }
    }
  }

  if (failures.length > 0) {
    console.error(`\nFAIL: страж конфигурации нашёл ${failures.length} проблем(ы):\n`);
    for (const line of failures) console.error(`  ${line}`);
    console.error(
      '\nАналитика включается ПЕРЕМЕННЫМИ ОКРУЖЕНИЯ. Ни один идентификатор не имеет права\n' +
        'жить в src/: иначе смена гео или домена превращается из правки конфига в правку кода.',
    );
    process.exit(1);
  }

  console.log(
    '\nPASS: идентификаторы приходят из окружения, литералов в исходниках нет,\n' +
      '      сигнал согласия Clarity уходит раньше тега и запрещает cookies.',
  );
}

main();
