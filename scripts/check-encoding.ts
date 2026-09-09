
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const SCAN_DIRS = ['src', 'scripts', 'tests', 'functions', 'docs', 'workers'];
const EXTENSIONS = ['.json', '.astro', '.ts', '.tsx', '.js', '.mjs', '.css', '.md'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.astro']);

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

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const head = readFileSync(file).subarray(0, 3);
    if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
      offenders.push(relative(ROOT, file).replace(/\\/g, '/'));
    }
  }
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

console.log('Encoding check passed: BOM не найден ни в одном файле.');
