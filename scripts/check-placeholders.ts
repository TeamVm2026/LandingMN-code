
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

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

const PREVIEW_HOST_PATTERN = /(^|\.)pages\.dev$|^localhost$|^127\.0\.0\.1$/;

function collectHtml(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collectHtml(full, out);
    else if (entry.endsWith('.html')) out.push(full);
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
  collectHtml(distDir, files);

  const hits: { file: string; count: number }[] = [];
  let total = 0;
  for (const file of files) {
    const matches = readFileSync(file, 'utf8').match(/PLACEHOLDER[A-Z_]*/g) ?? [];
    if (matches.length > 0) {
      hits.push({ file: path.relative(projectRoot, file), count: matches.length });
      total += matches.length;
    }
  }

  console.log(`Домен сборки: ${host || '(не задан)'} — режим ${isPreview ? 'превью' : 'БОЕВОЙ'}`);

  if (total === 0) {
    console.log('PASS: заглушек в собранных страницах нет.');
    return;
  }

  const lines = hits.map((h) => `  ${h.file}: ${h.count}`).join('\n');

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
