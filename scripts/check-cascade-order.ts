
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf('--root');
const projectRoot =
  rootFlag !== -1 && argv[rootFlag + 1]
    ? path.resolve(argv[rootFlag + 1])
    : path.resolve(import.meta.dirname, '..');

const SCAN_TARGETS: { dir: string; ext: string }[] = [
  { dir: path.join(projectRoot, 'src', 'components'), ext: '.astro' },
  { dir: path.join(projectRoot, 'src', 'layouts'), ext: '.astro' },
  { dir: path.join(projectRoot, 'src', 'pages'), ext: '.astro' },
  { dir: path.join(projectRoot, 'src', 'styles'), ext: '.css' },
];

interface StyleChunk {

  file: string;

  css: string;

  lineOffset: number;
}

function walk(dir: string, ext: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (full.endsWith(ext)) out.push(full);
  }
  return out;
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

const missingTargets: string[] = [];

function collectStyleChunks(): StyleChunk[] {
  const chunks: StyleChunk[] = [];
  for (const target of SCAN_TARGETS) {
    if (!existsSync(target.dir)) {
      missingTargets.push(path.relative(projectRoot, target.dir).split(path.sep).join('/') || target.dir);
      continue;
    }
    for (const full of walk(target.dir, target.ext)) {
      const rel = path.relative(projectRoot, full).replace(/\\/g, '/');
      const raw = readFileSync(full, 'utf8');
      if (target.ext === '.css') {
        chunks.push({ file: rel, css: raw, lineOffset: 1 });
        continue;
      }
      const re = /<style\b[^>]*>([\s\S]*?)<\/style>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw)) !== null) {
        chunks.push({
          file: rel,
          css: m[1],
          lineOffset: lineAt(raw, m.index + m[0].indexOf('>') + 1),
        });
      }
    }
  }
  return chunks;
}

interface CommentFinding {
  file: string;
  line: number;
  signal: 'glued' | 'prose';
  excerpt: string;
}

const CYRILLIC = /[А-Яа-яЁё]/;

function scanComments(chunk: StyleChunk): CommentFinding[] {
  const found: CommentFinding[] = [];
  const css = chunk.css;
  let i = 0;
  let inComment = false;
  while (i < css.length - 1) {
    if (!inComment && css[i] === '/' && css[i + 1] === '*') {
      inComment = true;
      i += 2;
      continue;
    }
    if (inComment && css[i] === '*' && css[i + 1] === '/') {
      const before = css[i - 1] ?? ' ';
      const after = css[i + 2] ?? ' ';
      const line = chunk.lineOffset + lineAt(css, i) - 1;

      if (!/\s/.test(before) && !/\s/.test(after)) {
        found.push({
          file: chunk.file,
          line,
          signal: 'glued',
          excerpt: css.slice(Math.max(0, i - 40), i + 20).replace(/\s+/g, ' ').trim(),
        });
      } else {

        const tail = css.slice(i + 2, i + 400).split('/*')[0];
        const withoutStrings = tail.replace(/"[^"]*"|'[^']*'/g, '');
        if (CYRILLIC.test(withoutStrings)) {
          found.push({
            file: chunk.file,
            line,
            signal: 'prose',
            excerpt: withoutStrings.replace(/\s+/g, ' ').trim().slice(0, 80),
          });
        }
      }
      inComment = false;
      i += 2;
      continue;
    }
    i++;
  }
  return found;
}

interface Decl {
  selector: string;
  prop: string;
  important: boolean;

  order: number;
  line: number;

  media: string;

  topLevel: boolean;
}

function normalizeSelector(sel: string): string {
  return sel
    .replace(/:global\(\s*([^()]*(?:\([^()]*\)[^()]*)*)\s*\)/g, '$1')
    .replace(/\[data-astro-cid-[a-z0-9]+\]/gi, '')
    .replace(/\s*([>+~])\s*/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectDecls(chunk: StyleChunk): Decl[] {
  const decls: Decl[] = [];
  let root: postcss.Root;
  try {
    root = postcss.parse(chunk.css, { from: chunk.file });
  } catch {

    return decls;
  }
  let order = 0;
  root.walkDecls((decl) => {
    order++;
    const rule = decl.parent;
    if (!rule || rule.type !== 'rule') return;
    let media = '';
    let topLevel = true;
    let node: postcss.Container | undefined = rule.parent as postcss.Container | undefined;
    while (node && node.type !== 'root') {
      if (node.type === 'atrule') {
        const at = node as postcss.AtRule;

        if (at.name !== 'layer') {
          topLevel = false;
          if (at.name === 'media' && !media) media = at.params;
        }
      }
      node = node.parent as postcss.Container | undefined;
    }
    const lineInChunk = decl.source?.start?.line ?? 1;
    for (const one of (rule as postcss.Rule).selectors) {
      decls.push({
        selector: normalizeSelector(one),
        prop: decl.prop.toLowerCase(),
        important: Boolean(decl.important),
        order,
        line: chunk.lineOffset + lineInChunk - 1,
        media,
        topLevel,
      });
    }
  });
  return decls;
}

interface OrderFinding {
  file: string;
  selector: string;
  prop: string;
  media: string;
  mediaLine: number;
  baseLine: number;
}

const SOKRASHCHENKI: Record<string, string[]> = {
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin-block', 'margin-inline'],
  'margin-block': ['margin-top', 'margin-bottom', 'margin-block-start', 'margin-block-end'],
  'margin-inline': ['margin-left', 'margin-right', 'margin-inline-start', 'margin-inline-end'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'padding-block', 'padding-inline'],
  'padding-block': ['padding-top', 'padding-bottom', 'padding-block-start', 'padding-block-end'],
  'padding-inline': ['padding-left', 'padding-right', 'padding-inline-start', 'padding-inline-end'],
  inset: ['top', 'right', 'bottom', 'left', 'inset-block', 'inset-inline'],
  'inset-block': ['top', 'bottom'],
  'inset-inline': ['left', 'right'],
  background: [
    'background-color',
    'background-image',
    'background-position',
    'background-size',
    'background-repeat',
    'background-attachment',
    'background-origin',
    'background-clip',
  ],
  transition: ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay'],
  animation: [
    'animation-name',
    'animation-duration',
    'animation-timing-function',
    'animation-delay',
    'animation-iteration-count',
    'animation-direction',
    'animation-fill-mode',
    'animation-play-state',
  ],
  font: ['font-style', 'font-variant', 'font-weight', 'font-stretch', 'font-size', 'line-height', 'font-family'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  'flex-flow': ['flex-direction', 'flex-wrap'],
  gap: ['row-gap', 'column-gap'],
  'place-items': ['align-items', 'justify-items'],
  'place-content': ['align-content', 'justify-content'],
  'place-self': ['align-self', 'justify-self'],
  overflow: ['overflow-x', 'overflow-y'],
  'border-radius': [
    'border-top-left-radius',
    'border-top-right-radius',
    'border-bottom-right-radius',
    'border-bottom-left-radius',
  ],
  border: ['border-width', 'border-style', 'border-color'],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'grid-area': ['grid-row-start', 'grid-column-start', 'grid-row-end', 'grid-column-end', 'grid-row', 'grid-column'],
  'grid-row': ['grid-row-start', 'grid-row-end'],
  'grid-column': ['grid-column-start', 'grid-column-end'],
  mask: ['mask-image', 'mask-mode', 'mask-repeat', 'mask-position', 'mask-clip', 'mask-origin', 'mask-size', 'mask-composite'],
};

function perekryvaet(nizhnee: string, verhnee: string): boolean {
  if (nizhnee === verhnee) return true;
  const dlinnye = SOKRASHCHENKI[nizhnee];
  if (dlinnye === undefined) return false;
  if (dlinnye.includes(verhnee)) return true;

  return dlinnye.some((p) => SOKRASHCHENKI[p]?.includes(verhnee) === true);
}

function scanOrder(chunk: StyleChunk): OrderFinding[] {
  const decls = collectDecls(chunk);
  const findings: OrderFinding[] = [];
  const conditional = decls.filter((d) => d.media && !d.important);
  const plain = decls.filter((d) => d.topLevel && !d.media);
  for (const cond of conditional) {
    for (const base of plain) {
      if (base.order <= cond.order) continue;
      if (base.selector !== cond.selector) continue;
      if (!perekryvaet(base.prop, cond.prop)) continue;
      if (base.important) continue;
      findings.push({
        file: chunk.file,
        selector: cond.selector,
        prop: cond.prop,
        media: cond.media,
        mediaLine: cond.line,
        baseLine: base.line,
      });
      break;
    }
  }
  return findings;
}

const chunks = collectStyleChunks();
const commentFindings: CommentFinding[] = [];
const orderFindings: OrderFinding[] = [];
for (const chunk of chunks) {
  commentFindings.push(...scanComments(chunk));
  orderFindings.push(...scanOrder(chunk));
}

console.log(`check:cascade-order — просмотрено CSS-блоков: ${chunks.length}`);

if (missingTargets.length > 0 || chunks.length === 0) {
  console.error('\n⛔ ОБХОД ПУСТ: гейт не нашёл, что проверять.');
  if (missingTargets.length > 0) console.error(`  нет каталогов обхода: ${missingTargets.join(', ')}`);
  console.error('  Обновите SCAN_TARGETS в scripts/check-cascade-order.ts под новое место стилей.');
  process.exit(1);
}

if (commentFindings.length > 0) {
  console.error('\n⛔ КЛАСС 1: комментарий закрывается раньше задуманного\n');
  for (const f of commentFindings) {
    const why =
      f.signal === 'glued'
        ? 'терминатор «*/» вклеен в слово (слева и справа не-пробел)'
        : 'сразу после закрытия комментария идёт кириллица — проза утекла в CSS';
    console.error(`  ${f.file}:${f.line}\n    ${why}\n    …${f.excerpt}…`);
  }
  console.error(
    '\n  Как чинить: разорвать последовательность «звёздочка-слеш» внутри текста\n' +
      '  врезки (например `--glass-rim-* / --glass-inset-*` с пробелами). Смысл\n' +
      '  врезки при этом обязан сохраниться — правится текст, а не код.\n',
  );
}

if (orderFindings.length > 0) {
  console.error('\n⛔ КЛАСС 2: медиазапрос перебит поздним правилом верхнего уровня\n');
  for (const f of orderFindings) {
    console.error(
      `  ${f.file}\n` +
        `    селектор : ${f.selector}\n` +
        `    свойство : ${f.prop}\n` +
        `    в @media ${f.media} — строка ${f.mediaLine}\n` +
        `    перебито правилом верхнего уровня НИЖЕ — строка ${f.baseLine}\n` +
        `    специфичность равна (селектор тот же), решает порядок → медиазапрос мёртв`,
    );
  }
  console.error(
    '\n  Как чинить: базовое объявление обязано стоять ВЫШЕ своих переопределений.\n' +
      '  Перенести правило верхнего уровня выше медиазапроса либо медиазапрос ниже\n' +
      '  правила. `!important` — заплатка, в этом проекте не принимается.\n',
  );
}

const total = commentFindings.length + orderFindings.length;
if (total > 0) {
  console.error(`FAIL: нарушений ${total} (класс 1: ${commentFindings.length}, класс 2: ${orderFindings.length})`);
  process.exit(1);
}

console.log('OK: оборванных комментариев нет, мёртвых медиазапросов нет.');
