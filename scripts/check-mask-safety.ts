
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const distDir = path.join(projectRoot, 'dist');

const COMPOSITE_ALLOWED = [
  'consent-banner',
  'consent-control',
  'contact-btn',
  'direction-card',
  'faq-',
  'lead-form',
  'field',
  'not-found',
  'thanks',
  'btn',
  'chip',
  'notfound-cta',
];

interface Finding {
  file: string;
  rule: string;
  decl: string;
  why: string;
}

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

function declarations(raw: string): { rule: string; decl: string }[] {
  const out: { rule: string; decl: string }[] = [];

  const css = raw.replace(/@supports[^{]*\{/g, '{');
  const re = /(-webkit-)?mask(-[a-z-]+)?\s*:\s*([^;{}]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const open = css.lastIndexOf('{', m.index);
    const prevClose = Math.max(css.lastIndexOf('}', open), css.lastIndexOf('{', open - 1));
    const rule = css.slice(prevClose + 1, open).replace(/\s+/g, ' ').trim().slice(-160);
    out.push({ rule, decl: `${m[0]}`.replace(/\s+/g, ' ').trim() });
  }
  return out;
}

if (!existsSync(distDir)) {
  console.error('✗ dist/ не собран — гейт масок проверяет СОБРАННЫЙ CSS. Запусти `npm run build`.');
  process.exit(1);
}

const files = walk(distDir, ['.css', '.html']);
const findings: Finding[] = [];
let maskImage = 0;
let webkitMaskImage = 0;
let composites = 0;
let scanned = 0;

for (const file of files) {
  const css = readFileSync(file, 'utf8');
  if (!css.includes('mask')) continue;
  scanned++;
  const rel = path.relative(projectRoot, file);
  for (const { rule, decl } of declarations(css)) {
    const prop = decl.split(':')[0].trim();
    const value = decl.slice(decl.indexOf(':') + 1);
    if (prop === 'mask-image') maskImage++;
    if (prop === '-webkit-mask-image') webkitMaskImage++;
    if (/var\s*\(/.test(value)) {
      findings.push({ file: rel, rule, decl, why: 'var() внутри mask-* — WebKit может отбросить объявление целиком' });
    }
    if (prop.endsWith('mask-composite')) {
      composites++;
      const allowed = COMPOSITE_ALLOWED.some((s) => rule.includes(s));
      if (!allowed) {
        findings.push({ file: rel, rule, decl, why: 'mask-composite вне закрытого списка 1px-рамок — разведи слои по двум элементам' });
      }
    }
  }
}

if (maskImage !== webkitMaskImage) {
  findings.push({
    file: 'dist/',
    rule: '(весь собранный CSS)',
    decl: `mask-image: ${maskImage}, -webkit-mask-image: ${webkitMaskImage}`,
    why: 'непарные объявления: в одном из движков маски не будет',
  });
}

console.log(`Гейт безопасности масок: файлов с масками ${scanned}, объявлений mask-image ${maskImage} (префиксных ${webkitMaskImage}), композитов ${composites}.`);

if (findings.length) {
  console.error(`\n✗ Нарушений: ${findings.length}`);
  for (const f of findings) {
    console.error(`  ${f.file}\n    правило: ${f.rule}\n    объявление: ${f.decl}\n    почему: ${f.why}`);
  }
  process.exit(1);
}

console.log('✓ Ни одного var() внутри mask-*, объявления парные, композит только в закрытом списке.');
