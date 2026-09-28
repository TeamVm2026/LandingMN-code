
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ROOT = resolve(DEFAULT_ROOT, argValue('root', '.'));

const SCAN_DIRS = ['src', 'scripts', 'tests', 'functions', 'docs', 'workers', '.github', '.planning'];
const EXTENSIONS = [
  '.json',
  '.astro',
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.css',
  '.md',
  '.yml',
  '.yaml',
  '.txt',
];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.astro']);

const FAJLY_BEZ_RASSHIRENIYA = ['.gitignore'];

const BOM_RAZRESHEN = ['.handoff/setup.ps1'];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

const offenders: string[] = [];
let scanned = 0;

function proverit(file: string): void {
  const rel = relative(ROOT, file).replace(/\\/g, '/');

  if (BOM_RAZRESHEN.includes(rel)) return;
  scanned++;
  const head = readFileSync(file).subarray(0, 3);
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    offenders.push(rel);
  }
}

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) proverit(file);
}

for (const rel of FAJLY_BEZ_RASSHIRENIYA) {
  const full = join(ROOT, rel);
  if (existsSync(full)) proverit(full);
}

if (scanned === 0) {
  console.error(
    'FAIL: ФАЙЛЫ НЕ ОСМОТРЕНЫ — обход не открыл ни одного файла ' +
      `(корень ${ROOT}; каталоги ${SCAN_DIRS.join(', ')}).\n` +
      'Проверка, которой нечего проверять, не подтверждает ничего: отсутствие BOM\n' +
      'в непрочитанных файлах сертифицировать нельзя. Скорее всего переехал каталог\n' +
      'или сменилось расширение — поправьте SCAN_DIRS/EXTENSIONS.',
  );
  process.exit(1);
}

if (offenders.length > 0) {
  console.error(`UTF-8 BOM найден в ${offenders.length} файл(ах):\n`);
  for (const file of offenders) console.error(`  ${file}`);
  console.error(
    '\nBOM ломает JSON.parse и незаметен в редакторе. Перезапишите файлы без' +
      '\nсигнатуры: в PowerShell 5.1 — [System.IO.File]::WriteAllText(path, text,' +
      '\n(New-Object System.Text.UTF8Encoding $false)), в PowerShell 7 —' +
      '\n-Encoding utf8NoBOM.',
  );
  process.exit(1);
}

console.log(`Encoding check passed: BOM не найден ни в одном из ${scanned} осмотренных файлов.`);
