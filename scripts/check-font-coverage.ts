
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const fontsDir = path.join(projectRoot, 'public', 'fonts');
const fontPath = path.join(fontsDir, 'manrope-subset.woff2');
const manifestPath = path.join(fontsDir, 'manrope-subset.coverage.json');
const localeDir = path.join(projectRoot, 'src', 'i18n');
const LOCALES = ['mn', 'ru', 'en'] as const;

const MAX_FONT_BYTES = 32 * 1024;

const CRITICAL: Record<string, string> = {
  'Ө': 'Ө монгольская O с чертой',
  'ө': 'ө строчная',
  'Ү': 'Ү монгольская U',
  'ү': 'ү строчная',
  '₮': '₮ тугрик',
  'Ё': 'Ё',
  'ё': 'ё',
  '№': '№',
};

interface Manifest {
  family: string;
  file: string;
  bytes: number;
  sha256: string;
  codepoints: number[];
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectStrings(nested, out);
    }
  }
}

function main(): void {
  let failCount = 0;

  console.log('--- Файл шрифта и манифест ---');
  if (!existsSync(fontPath) || !existsSync(manifestPath)) {
    console.error(`FAIL: нет ${path.relative(projectRoot, fontPath)} или манифеста покрытия.`);
    console.error('      Собрать: python scripts/build-font-subset.py');
    process.exit(1);
  }

  const fontBytes = readFileSync(fontPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  const actualHash = createHash('sha256').update(fontBytes).digest('hex');

  if (actualHash !== manifest.sha256) {
    console.error('FAIL: sha256 файла шрифта не совпадает с манифестом покрытия.');
    console.error(`      файл:     ${actualHash}`);
    console.error(`      манифест: ${manifest.sha256}`);
    console.error('      Пересобрать: python scripts/build-font-subset.py');
    failCount++;
  } else {
    console.log(`PASS: ${manifest.file} совпадает с манифестом (${manifest.codepoints.length} символов).`);
  }

  if (fontBytes.length > MAX_FONT_BYTES) {
    console.error(
      `FAIL: шрифт ${(fontBytes.length / 1024).toFixed(1)} КБ превышает потолок ${(MAX_FONT_BYTES / 1024).toFixed(0)} КБ.`
    );
    failCount++;
  } else {
    console.log(`PASS: вес ${(fontBytes.length / 1024).toFixed(1)} КБ в пределах ${(MAX_FONT_BYTES / 1024).toFixed(0)} КБ.`);
  }

  const covered = new Set(manifest.codepoints);

  console.log('\n--- Обязательные символы ---');
  const missingCritical = Object.entries(CRITICAL).filter(([ch]) => !covered.has(ch.codePointAt(0)!));
  if (missingCritical.length > 0) {
    for (const [ch, label] of missingCritical) {
      console.error(`FAIL: нет ${label} (U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`);
    }
    failCount++;
  } else {
    console.log(`PASS: все ${Object.keys(CRITICAL).length} обязательных символа покрыты.`);
  }

  console.log('\n--- Символы, реально встречающиеся в i18n-словарях ---');
  const uncovered = new Map<number, string[]>();
  for (const locale of LOCALES) {
    const file = path.join(localeDir, `${locale}.json`);
    if (!existsSync(file)) {
      console.error(`FAIL: нет ${path.relative(projectRoot, file)}`);
      failCount++;
      continue;
    }
    const strings: string[] = [];
    collectStrings(JSON.parse(readFileSync(file, 'utf8')), strings);
    for (const s of strings) {
      for (const ch of s) {
        const cp = ch.codePointAt(0)!;

        if (cp < 0x20) continue;
        if (covered.has(cp)) continue;
        const seen = uncovered.get(cp) ?? [];
        if (!seen.includes(locale)) seen.push(locale);
        uncovered.set(cp, seen);
      }
    }
  }

  if (uncovered.size > 0) {
    console.error(`FAIL: ${uncovered.size} символ(ов) из копирайта отсутству(ю)т в сабсете:`);
    for (const [cp, locales] of uncovered) {
      const hex = cp.toString(16).toUpperCase().padStart(4, '0');
      console.error(`  U+${hex} "${String.fromCodePoint(cp)}" — встречается в ${locales.join(', ')}`);
    }
    console.error('  Добавить диапазон в UNICODE_RANGES и пересобрать: python scripts/build-font-subset.py');
    failCount++;
  } else {
    console.log(`PASS: все символы ${LOCALES.join('/')} покрыты сабсетом.`);
  }

  console.log(`\n${failCount === 0 ? 'All checks passed.' : `${failCount} check(s) failed.`}`);
  if (failCount > 0) process.exit(1);
}

main();
