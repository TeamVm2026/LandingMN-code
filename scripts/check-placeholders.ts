
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { PREVIEW_HOST_PATTERN } from './lib/preview-host.ts';

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

const distArg = argValue('dist', 'dist');
const distDir = path.resolve(projectRoot, distArg);

const MARKERS: { name: string; re: RegExp }[] = [

  { name: 'PLACEHOLDER_*', re: /PLACEHOLDER[A-Z_]*/g },

  { name: 'TODO/FIXME/XXX', re: /(?<![A-Za-z0-9_])(TODO|FIXME|XXX)(?![a-z0-9])/g },
  { name: 'changeme', re: /(?<![A-Za-z0-9])change[-_]?me(?![A-Za-z0-9])/gi },

  { name: 'example.com', re: /(?<![A-Za-z0-9.-])example\.(com|org|net)(?![A-Za-z0-9-])/gi },

  {
    name: 'your*',
    re: /(?<![A-Za-z0-9])your[-_]?(domain|site|company|brand|bot|page|channel)(?![A-Za-z0-9])/gi,
  },
  { name: 'xxx', re: /(?<![A-Za-z0-9])[xX]{3,}(?![A-Za-z0-9])/g },
  { name: 'lorem ipsum', re: /(?<![A-Za-z0-9])lorem ipsum/gi },
];

const SCAN_EXT = ['.html', '.js', '.css', '.json', '.txt', '.xml', '.webmanifest', '.svg'];

function collectFiles(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collectFiles(full, out);
    else if (SCAN_EXT.includes(path.extname(entry).toLowerCase())) out.push(full);
  }
}

function main(): void {
  if (!existsSync(distDir)) {
    console.error(`FAIL: нет ${distArg}/ — сначала \`npm run build\`.`);
    process.exit(1);
  }

  const siteUrl = process.env.PUBLIC_SITE_URL ?? '';
  let host = '';
  try {
    host = new URL(siteUrl).hostname;
  } catch {
    host = '';
  }
  const isPreview = host === '' || PREVIEW_HOST_PATTERN.test(host);

  const files: string[] = [];
  collectFiles(distDir, files);

  if (files.length === 0) {
    console.error(
      `FAIL: СБОРКА НЕ ОСМОТРЕНА — в ${distArg}/ нет ни одного файла расширений ` +
        `${SCAN_EXT.join(', ')}. Отсутствие заглушек в непрочитанных файлах сертифицировать нельзя.`
    );
    process.exit(1);
  }

  const hits: { file: string; count: number; found: string[] }[] = [];
  let total = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const found = new Set<string>();
    let count = 0;
    for (const marker of MARKERS) {
      const matches = text.match(marker.re) ?? [];
      if (matches.length === 0) continue;
      count += matches.length;
      for (const m of new Set(matches)) found.add(`${marker.name}: «${m}»`);
    }
    if (count > 0) {
      hits.push({ file: path.relative(projectRoot, file), count, found: [...found] });
      total += count;
    }
  }

  console.log(
    `Домен сборки: ${host || '(не задан)'} — режим ${isPreview ? 'превью' : 'БОЕВОЙ'}; ` +
      `осмотрено ${files.length} файл(ов), словарь заглушек: ${MARKERS.length} маркер(ов).`
  );

  if (total === 0) {
    console.log('PASS: заглушек в собранных страницах нет.');
    return;
  }

  const lines = hits.map((h) => `  ${h.file}: ${h.count} — ${h.found.join('; ')}`).join('\n');

  if (isPreview) {
    console.log(
      `ПРЕДУПРЕЖДЕНИЕ: ${total} заглушк(и/ов) в ${hits.length} файл(ах). На превью это допустимо.\n${lines}\n` +
        '  Реальные значения задаются через PUBLIC_TG_CONTACT_URL и PUBLIC_MESSENGER_URL.\n' +
        '  Как только PUBLIC_SITE_URL станет боевым доменом, эта проверка начнёт валить сборку.'
    );
    return;
  }

  console.error(
    `FAIL: ЗАГЛУШКИ В БОЕВОЙ СБОРКЕ — ${total} штук(и) в контактных ссылках, ` +
      `это потеря лидов при внешне рабочей кнопке.\n${lines}\n` +
      '  Задать реальные PUBLIC_TG_CONTACT_URL и PUBLIC_MESSENGER_URL (docs/ACCESS-SETUP.md).'
  );
  process.exit(1);
}

main();
