
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');

function argValue(name: string, fallback: string): string {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) {
    console.error(`✗ у аргумента --${name} нет значения`);
    process.exit(1);
  }
  return value;
}

const distArg = argValue('dist', 'dist');
const distDir = path.resolve(projectRoot, distArg);

const COMPOSITE_ALLOWED = new Set([
  'btn-primary',
  'consent-banner__btn',
  'consent-control__btn',
  'contact-btn',
  'direction-card',
  'faq-accordion',
  'faq-item',
  'lead-form__form',

  'lead-repeat',
  'lead-repeat__cta',
  'notfound-cta',
  'thanks-cta',
]);

interface Finding {
  file: string;
  rule: string;
  decl: string;
  why: string;
}

interface Declaration {

  block: number;

  rule: string;

  decl: string;

  base: string;

  prefixed: boolean;
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

function declarations(raw: string): Declaration[] {
  const out: Declaration[] = [];

  const css = raw.replace(/@supports[^{]*\{/g, '{');

  const re = /(?<![\w-])(-webkit-)?mask(-[a-z-]+)?\s*:\s*([^;{}]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const open = css.lastIndexOf('{', m.index);
    const prevClose = Math.max(css.lastIndexOf('}', open), css.lastIndexOf('{', open - 1));
    const rule = css.slice(prevClose + 1, open).replace(/\s+/g, ' ').trim();
    const decl = `${m[0]}`.replace(/\s+/g, ' ').trim();
    const prop = decl.split(':')[0].trim();
    const prefixed = prop.startsWith('-webkit-');
    out.push({
      block: open,
      rule,
      decl,
      base: prefixed ? prop.slice('-webkit-'.length) : prop,
      prefixed,
    });
  }
  return out;
}

function shortRule(rule: string): string {
  return rule.length > 160 ? `…${rule.slice(-160)}` : rule;
}

function compositeAllowed(rule: string): boolean {
  const parts = rule.split(',').filter((p) => p.trim() !== '');
  if (parts.length === 0) return false;
  return parts.every((part) =>
    [...part.matchAll(/\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g)].some((c) => COMPOSITE_ALLOWED.has(c[1])),
  );
}

if (!existsSync(distDir)) {
  console.error(`✗ нет ${distArg}/ — гейт масок проверяет СОБРАННЫЙ CSS. Запусти \`npm run build\`.`);
  process.exit(1);
}

const files = walk(distDir, ['.css', '.html']);
const findings: Finding[] = [];
let maskImage = 0;
let webkitMaskImage = 0;
let composites = 0;
let scanned = 0;
let declarationCount = 0;

for (const file of files) {
  const css = readFileSync(file, 'utf8');
  if (!css.includes('mask')) continue;
  scanned++;
  const rel = path.relative(projectRoot, file);

  const blocks = new Map<number, { rule: string; props: Map<string, { plain: number; prefixed: number; decl: string }> }>();

  for (const d of declarations(css)) {
    declarationCount++;
    const value = d.decl.slice(d.decl.indexOf(':') + 1);

    if (d.base === 'mask-image' || d.base === 'mask') {
      if (d.prefixed) webkitMaskImage++;
      else maskImage++;
    }

    if (/var\s*\(/.test(value)) {
      findings.push({
        file: rel,
        rule: shortRule(d.rule),
        decl: d.decl,
        why: 'VAR() В МАСКЕ — WebKit может отбросить объявление целиком, и слой нарисуется прямоугольником',
      });
    }

    if (d.base === 'mask-composite') {
      composites++;
      if (!compositeAllowed(d.rule)) {
        findings.push({
          file: rel,
          rule: shortRule(d.rule),
          decl: d.decl,
          why: 'КОМПОЗИТ ВНЕ СПИСКА — ни один класс селектора не значится в COMPOSITE_ALLOWED; разведи слои по двум элементам',
        });
      }
    }

    let block = blocks.get(d.block);
    if (!block) {
      block = { rule: d.rule, props: new Map() };
      blocks.set(d.block, block);
    }
    let counts = block.props.get(d.base);
    if (!counts) {
      counts = { plain: 0, prefixed: 0, decl: d.decl };
      block.props.set(d.base, counts);
    }
    if (d.prefixed) counts.prefixed++;
    else counts.plain++;
  }

  for (const block of blocks.values()) {
    for (const [base, counts] of block.props) {
      if (counts.plain === counts.prefixed) continue;
      findings.push({
        file: rel,
        rule: shortRule(block.rule),
        decl: counts.decl,
        why:
          `НЕПАРНАЯ МАСКА — в этом правиле ${base} объявлено ${counts.plain} раз(а), ` +
          `-webkit-${base} — ${counts.prefixed}. В одном из движков маски не будет`,
      });
    }
  }
}

console.log(
  `Гейт безопасности масок: файлов с масками ${scanned}, объявлений ${declarationCount}, ` +
    `из них изображение маски ${maskImage} (в префиксной форме ${webkitMaskImage}), композитов ${composites}.`,
);

if (scanned === 0 || maskImage + webkitMaskImage === 0) {
  console.error(
    `\n✗ МАСКИ НЕ ОСМОТРЕНЫ: в ${distArg}/ найдено ${scanned} файл(ов) с масками и ` +
      `${maskImage + webkitMaskImage} объявлений изображения маски.\n` +
      '  Растушёвка первого экрана и кромки слоёв сцены едут именно на них. Ноль здесь —\n' +
      '  это либо пропавшая растушёвка, либо гейт, наведённый мимо сборки; молчание\n' +
      '  проверки, ничего не осмотревшей, не подтверждает ничего.',
  );
  process.exit(1);
}

if (findings.length) {
  console.error(`\n✗ Нарушений: ${findings.length}`);
  for (const f of findings) {
    console.error(`  ${f.file}\n    правило: ${f.rule}\n    объявление: ${f.decl}\n    почему: ${f.why}`);
  }
  process.exit(1);
}

console.log('✓ Переменных в mask-* нет, у каждого правила обе формы записи, композит только у перечисленных классов.');
