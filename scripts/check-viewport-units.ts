
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCAN_DIRS = ['src'];

const EXTENSIONS = ['.astro', '.css', '.ts', '.js'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.astro']);

const LAYOUT_HEIGHT_PROPS =
  /(?:^|[;{\s"'`.[])(min-height|max-height|height|minHeight|maxHeight)['"\]]?\s*[:=]([^;}\n]*)/g;

const SET_PROPERTY_CALL =
  /setProperty\(\s*['"`](min-height|max-height|height)['"`]\s*,\s*([^)]*)\)/g;

const CUSTOM_PROP_DECL = /(--[a-z0-9-]+)\s*:([^;}\n]*)/gi;

const MOVING_UNITS = /\b\d*\.?\d+(dvh|lvh|vh)\b/i;
const WHY: Record<string, string> = {
  dvh: 'следует за адресной строкой и двигает раскладку во время прокрутки',
  vh: 'равна большому вьюпорту — при видимой адресной строке низ блока уезжает за край',
  lvh: 'равна большому вьюпорту — при видимой адресной строке низ блока уезжает за край',
};

interface Allowance {
  file: string;
  property: string;
  reason: string;
}

const ALLOWED: Allowance[] = [];

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

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

const problems: string[] = [];
let scanned = 0;

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const text = stripComments(readFileSync(file, 'utf8'));
    scanned++;
    const hits: { property: string; value: string; unit: string }[] = [];
    for (const match of text.matchAll(LAYOUT_HEIGHT_PROPS)) {

      const property = match[1].replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
      const unit = match[2].match(MOVING_UNITS);
      if (unit) hits.push({ property, value: match[2].trim(), unit: unit[1].toLowerCase() });
    }
    for (const match of text.matchAll(SET_PROPERTY_CALL)) {
      const unit = match[2].match(MOVING_UNITS);
      if (unit) {
        hits.push({
          property: match[1].toLowerCase(),
          value: match[2].trim(),
          unit: unit[1].toLowerCase(),
        });
      }
    }
    for (const match of text.matchAll(CUSTOM_PROP_DECL)) {
      const unit = match[2].match(MOVING_UNITS);
      if (unit) hits.push({ property: match[1], value: match[2].trim(), unit: unit[1].toLowerCase() });
    }
    for (const hit of hits) {
      if (ALLOWED.some((a) => a.file === rel && a.property === hit.property)) continue;
      problems.push(`${rel}: ${hit.property}: ${hit.value} — ${hit.unit} ${WHY[hit.unit]}`);
    }
  }
}

const stale: string[] = [];
for (const a of ALLOWED) {
  const full = join(ROOT, a.file);
  let text: string;
  try {
    text = stripComments(readFileSync(full, 'utf8'));
  } catch {
    stale.push(`${a.file} (${a.property}) — файла больше нет`);
    continue;
  }
  const used = [...text.matchAll(LAYOUT_HEIGHT_PROPS)].some(
    (m) => m[1].replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase() === a.property && MOVING_UNITS.test(m[2]),
  );
  if (!used) stale.push(`${a.file} (${a.property}) — динамических единиц там больше нет`);
}

if (problems.length > 0) {
  console.error(`Негодных единиц высоты вьюпорта: ${problems.length}.\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\nЗамените на svh — высоту при видимой панели браузера. Она не зависит от' +
      '\nхода адресной строки, то есть не меняется во время прокрутки (при' +
      '\nповороте экрана меняется, как и всё остальное). Либо внесите в ALLOWED' +
      '\nв scripts/check-viewport-units.ts с причиной.',
  );
}

if (stale.length > 0) {
  console.error(`\nУстаревших исключений: ${stale.length}:\n`);
  for (const s of stale) console.error(`  ${s}`);
}

if (problems.length > 0 || stale.length > 0) process.exit(1);

console.log(
  `Viewport-unit check passed: ${scanned} файл(ов), ${ALLOWED.length} исключение(й) с причиной.`,
);
