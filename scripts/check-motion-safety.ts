
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const EXCEPTION_MARKER = 'motion-safety: decorative-exception';

const SCAN_TARGETS: { dir: string; ext: string }[] = [
  { dir: path.join(projectRoot, 'src', 'components'), ext: '.astro' },
  { dir: path.join(projectRoot, 'src', 'layouts'), ext: '.astro' },
  { dir: path.join(projectRoot, 'src', 'pages'), ext: '.astro' },
  { dir: path.join(projectRoot, 'src', 'styles'), ext: '.css' },
];

interface OpacityZeroFinding {
  file: string;
  line: number;
  selector: string;
  excepted: boolean;
}

interface ViewDrivenFinding {
  file: string;
  line: number;
  selector: string;
}

const opacityZeroFindings: OpacityZeroFinding[] = [];
const viewDrivenFindings: ViewDrivenFinding[] = [];

function walkDir(dir: string, ext: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkDir(full, ext, out);
    } else if (entry.endsWith(ext)) {
      out.push(full);
    }
  }
}

function extractAstroStyleBlocks(source: string): { text: string; lineOffset: number }[] {
  const blocks: { text: string; lineOffset: number }[] = [];
  const styleTagRe = /<style\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = styleTagRe.exec(source))) {
    const openTagEnd = match.index + match[0].length;
    const closeIdx = source.indexOf('</style>', openTagEnd);
    if (closeIdx === -1) continue;
    const styleText = source.slice(openTagEnd, closeIdx);
    const lineOffset = source.slice(0, openTagEnd).split('\n').length - 1;
    blocks.push({ text: styleText, lineOffset });
  }
  return blocks;
}

type FrameType = 'media' | 'supports' | 'keyframes' | 'other-at-rule' | 'rule';

interface Frame {
  type: FrameType;
  header: string;
  supportsAnimationTimeline: boolean;
}

function classifyHeader(headerRaw: string): { type: FrameType; header: string; supportsAnimationTimeline: boolean } {
  const header = headerRaw.trim().replace(/\s+/g, ' ');
  if (/^@media\b/i.test(header)) return { type: 'media', header, supportsAnimationTimeline: false };
  if (/^@supports\b/i.test(header)) {
    return { type: 'supports', header, supportsAnimationTimeline: header.includes('animation-timeline') };
  }
  if (/^@keyframes\b/i.test(header)) return { type: 'keyframes', header, supportsAnimationTimeline: false };
  if (header.startsWith('@')) return { type: 'other-at-rule', header, supportsAnimationTimeline: false };
  return { type: 'rule', header, supportsAnimationTimeline: false };
}

const OPACITY_ZERO_RE = /^opacity\s*:\s*0(?:px)?\s*$/i;
const ANIMATION_TIMELINE_VIEW_RE = /^animation-timeline\s*:\s*view\(\s*\)\s*$/i;

function hasExceptionMarker(originalLines: string[], declLine1Based: number): boolean {
  const sameLine = originalLines[declLine1Based - 1] ?? '';
  const lineAbove = originalLines[declLine1Based - 2] ?? '';
  return sameLine.includes(EXCEPTION_MARKER) || lineAbove.includes(EXCEPTION_MARKER);
}

function scanCss(cssText: string, originalLines: string[], lineOffset: number, relFile: string): void {
  const stack: Frame[] = [];
  let line = 1 + lineOffset;
  let buf = '';
  let bufStartLine = line;
  let bufHasContent = false;

  const flushDeclarationIfAny = () => {
    const top = stack[stack.length - 1];
    const decl = buf.trim();
    if (top && top.type === 'rule' && decl.length > 0) {
      const declLine = bufStartLine;
      if (OPACITY_ZERO_RE.test(decl)) {
        const anyAtRuleAncestor = stack.some((f) => f.type !== 'rule');
        if (!anyAtRuleAncestor) {
          const excepted = hasExceptionMarker(originalLines, declLine);
          opacityZeroFindings.push({ file: relFile, line: declLine, selector: top.header, excepted });
        }
      }
      if (ANIMATION_TIMELINE_VIEW_RE.test(decl)) {
        const supportsAncestor = stack.some((f) => f.type === 'supports' && f.supportsAnimationTimeline);
        if (supportsAncestor) {
          viewDrivenFindings.push({ file: relFile, line: declLine, selector: top.header });
        }
      }
    }
    buf = '';
    bufHasContent = false;
  };

  let i = 0;
  while (i < cssText.length) {
    const ch = cssText[i];

    if (ch === '\n') {
      line++;
      i++;
      continue;
    }

    if (ch === '/' && cssText[i + 1] === '*') {
      const end = cssText.indexOf('*/', i + 2);
      const commentEnd = end === -1 ? cssText.length : end + 2;
      const commentText = cssText.slice(i, commentEnd);
      const newlines = (commentText.match(/\n/g) ?? []).length;
      line += newlines;
      i = commentEnd;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < cssText.length && cssText[j] !== quote) {
        if (cssText[j] === '\\') j++;
        if (cssText[j] === '\n') line++;
        j++;
      }
      i = j + 1;
      continue;
    }

    if (ch === '{') {
      const classified = classifyHeader(buf);
      stack.push({ type: classified.type, header: classified.header, supportsAnimationTimeline: classified.supportsAnimationTimeline });
      buf = '';
      bufHasContent = false;
      i++;
      continue;
    }

    if (ch === '}') {
      flushDeclarationIfAny();
      stack.pop();
      buf = '';
      bufHasContent = false;
      i++;
      continue;
    }

    if (ch === ';') {
      flushDeclarationIfAny();
      i++;
      continue;
    }

    if (!bufHasContent && !/\s/.test(ch)) {
      bufStartLine = line;
      bufHasContent = true;
    }
    buf += ch;
    i++;
  }
}

function main(): void {
  const astroFiles: string[] = [];
  const cssFiles: string[] = [];

  for (const target of SCAN_TARGETS) {
    if (target.ext === '.astro') walkDir(target.dir, '.astro', astroFiles);
    else walkDir(target.dir, '.css', cssFiles);
  }

  for (const file of astroFiles) {
    const source = readFileSync(file, 'utf8');
    const originalLines = source.split('\n');
    const relFile = path.relative(projectRoot, file).split(path.sep).join('/');
    const blocks = extractAstroStyleBlocks(source);
    for (const block of blocks) {
      scanCss(block.text, originalLines, block.lineOffset, relFile);
    }
  }

  for (const file of cssFiles) {
    const source = readFileSync(file, 'utf8');
    const originalLines = source.split('\n');
    const relFile = path.relative(projectRoot, file).split(path.sep).join('/');
    scanCss(source, originalLines, 0, relFile);
  }

  const violations: { opacityFinding: OpacityZeroFinding; viewFinding: ViewDrivenFinding }[] = [];
  for (const opacityFinding of opacityZeroFindings) {
    if (opacityFinding.excepted) continue;
    const match = viewDrivenFindings.find(
      (v) => v.file === opacityFinding.file && v.selector === opacityFinding.selector,
    );
    if (match) violations.push({ opacityFinding, viewFinding: match });
  }

  const exceptedCount = opacityZeroFindings.filter((f) => f.excepted).length;
  const unguardedNonViolatingCount = opacityZeroFindings.filter(
    (f) =>
      !f.excepted &&
      !violations.some((v) => v.opacityFinding === f),
  ).length;

  console.log(`--- Motion-safety scan: ${astroFiles.length} .astro file(s), ${cssFiles.length} .css file(s) ---`);
  console.log(`  animation-timeline:view() selector(s) found: ${viewDrivenFindings.length}`);
  console.log(`  unconditional opacity:0 base state(s) found: ${opacityZeroFindings.length} (${exceptedCount} marked motion-safety: decorative-exception, ${unguardedNonViolatingCount} unguarded but not view()-driven)`);

  if (violations.length > 0) {
    for (const { opacityFinding, viewFinding } of violations) {
      console.error(
        `VIOLATION: ${opacityFinding.file}:${opacityFinding.line} - selector "${opacityFinding.selector}" has an unconditional opacity:0 base state but is also driven by animation-timeline:view() at ${viewFinding.file}:${viewFinding.line} -- this hides content forever in any browser/context that never reaches the view()-driven rule (02.1-UI-SPEC.md §8.1). Add motion-safety: decorative-exception if this is an intentional decorative-only overlay, or move the hidden state into @keyframes.`,
      );
    }
    console.log(`\n${violations.length} violation(s) found.`);
    process.exit(1);
  }

  const timelineViolations: { file: string; line: number }[] = [];
  for (const file of [...astroFiles, ...cssFiles]) {
    const source = readFileSync(file, 'utf8');
    const relFile = path.relative(projectRoot, file).split(path.sep).join('/');

    const clean = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

    const re = /animation-timeline\s*:/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean))) {
      timelineViolations.push({
        file: relFile,
        line: 1 + (clean.slice(0, m.index).match(/\n/g) ?? []).length,
      });
    }
  }

  if (timelineViolations.length > 0) {
    for (const v of timelineViolations) {
      console.error(
        `VIOLATION: ${v.file}:${v.line} - использовано свойство animation-timeline. ` +
          'Это scrub-анимация: прогресс привязан к прокрутке, поэтому элемент гаснет обратно при движении ' +
          'вверх. LAND-09 требует «once», таблица Out of Scope в REQUIREMENTS.md запрещает scrub прямо. ' +
          'Появление реализовано через IntersectionObserver в src/scripts/interactive.ts (часть F) — ' +
          'см. комментарий к .reveal-item в src/styles/tokens.css.',
      );
    }
    console.log(`\n${timelineViolations.length} violation(s) found.`);
    process.exit(1);
  }

  const viewDrivenSelectorCount = new Set(viewDrivenFindings.map((f) => `${f.file}::${f.selector}`)).size;
  console.log(`\nPASS: ${viewDrivenSelectorCount} selector(s) using animation-timeline:view() checked, 0 unguarded opacity:0 base states.`);
}

main();
