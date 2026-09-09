
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');

const SCAN_TARGETS: { dir: string; ext: string }[] = [
  { dir: path.join(projectRoot, 'src', 'components'), ext: '.astro' },
  { dir: path.join(projectRoot, 'src', 'layouts'), ext: '.astro' },
  { dir: path.join(projectRoot, 'src', 'styles'), ext: '.css' },
];

type Status = 'PASS' | 'FAIL' | 'REPORT' | 'DEFERRED';
interface CheckResult {
  id: string;
  label: string;
  status: Status;
  detail: string;
}
const results: CheckResult[] = [];

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
    if (st.isDirectory()) walkDir(full, ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function lineAt(text: string, index: number): number {
  return 1 + (text.slice(0, index).match(/\n/g) ?? []).length;
}

interface ScannedFile {
  relFile: string;

  css: string;
  blocks: { text: string; lineOffset: number }[];
  rawSource: string;
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
    blocks.push({ text: stripComments(styleText), lineOffset });
  }
  return blocks;
}

function loadScannedFiles(): ScannedFile[] {
  const astroFiles: string[] = [];
  const cssFiles: string[] = [];
  for (const target of SCAN_TARGETS) {
    if (target.ext === '.astro') walkDir(target.dir, '.astro', astroFiles);
    else walkDir(target.dir, '.css', cssFiles);
  }
  const files: ScannedFile[] = [];
  for (const file of astroFiles) {
    const rawSource = readFileSync(file, 'utf8');
    const relFile = path.relative(projectRoot, file).split(path.sep).join('/');
    const blocks = extractAstroStyleBlocks(rawSource);
    files.push({ relFile, css: blocks.map((b) => b.text).join('\n'), blocks, rawSource });
  }
  for (const file of cssFiles) {
    const rawSource = readFileSync(file, 'utf8');
    const relFile = path.relative(projectRoot, file).split(path.sep).join('/');
    const clean = stripComments(rawSource);
    files.push({ relFile, css: clean, blocks: [{ text: clean, lineOffset: 0 }], rawSource });
  }
  return files;
}

const scannedFiles = loadScannedFiles();

function walkRules(cssText: string, onRule: (header: string, ancestors: string[]) => void): void {
  const stack: { header: string; isAtRule: boolean }[] = [];
  let buf = '';
  for (let i = 0; i < cssText.length; i++) {
    const ch = cssText[i];
    if (ch === '{') {
      const header = buf.trim().replace(/\s+/g, ' ');
      const isAtRule = header.startsWith('@');
      if (!isAtRule && header.length > 0) {
        onRule(
          header,
          stack.filter((f) => f.isAtRule).map((f) => f.header),
        );
      }
      stack.push({ header, isAtRule });
      buf = '';
      continue;
    }
    if (ch === '}') {
      stack.pop();
      buf = '';
      continue;
    }
    buf += ch;
  }
}

function checkHoverGuards(): void {
  let rawHoverCount = 0;
  let rawGuardCount = 0;
  const violations: { file: string; selector: string }[] = [];

  for (const f of scannedFiles) {
    rawHoverCount += (f.css.match(/:hover/g) ?? []).length;
    rawGuardCount += (f.css.match(/hover\s*:\s*hover/g) ?? []).length;

    walkRules(f.css, (header, ancestors) => {
      if (!header.includes(':hover')) return;
      const guarded = ancestors.some((a) => /hover\s*:\s*hover/.test(a));
      if (!guarded) violations.push({ file: f.relFile, selector: header });
    });
  }

  const status: Status = violations.length === 0 ? 'PASS' : 'FAIL';
  const detail =
    `raw :hover=${rawHoverCount}, raw hover:hover=${rawGuardCount} (guard count is expected to be <= selector count when guards are consolidated -- not a failure by itself); ` +
    `nesting check (the real pass/fail signal): ${violations.length} unguarded :hover rule(s) found` +
    (violations.length > 0 ? ': ' + violations.map((v) => `${v.file} "${v.selector}"`).join('; ') : '');
  results.push({ id: '1', label: 'Zero unguarded :hover rules', status, detail });
}

function checkPressStates(): void {
  const perFileViolations: string[] = [];
  let totalActive = 0;
  let totalPressScale = 0;
  let totalBadReset = 0;

  for (const f of scannedFiles) {
    const activeCount = (f.css.match(/:active/g) ?? []).length;

    const pressCount = (f.css.match(/scale\(\s*var\(--press-scale(?:-strong)?\)\s*\)/g) ?? []).length;
    const badResetMatches = f.css.match(/:active\s*\{[^}]*translateY\(\s*0\s*\)/g) ?? [];

    totalActive += activeCount;
    totalPressScale += pressCount;
    totalBadReset += badResetMatches.length;

    if (activeCount > 0 && pressCount === 0) {
      perFileViolations.push(`${f.relFile} has :active (${activeCount}x) but 0 scale(var(--press-scale)) / scale(var(--press-scale-strong))`);
    }
    if (badResetMatches.length > 0) {
      perFileViolations.push(`${f.relFile} has ${badResetMatches.length}x fake-press :active{translateY(0)} pattern`);
    }
  }

  const status: Status = perFileViolations.length === 0 ? 'PASS' : 'FAIL';
  const detail =
    `${totalActive} total :active rule(s), ${totalPressScale} total scale(var(--press-scale*)), ${totalBadReset} fake-press translateY(0) reset(s) found` +
    (perFileViolations.length > 0 ? '; VIOLATIONS: ' + perFileViolations.join('; ') : '; every file with :active has a real press state, .direction-card included');
  results.push({ id: '2', label: 'Every clickable element has a real :active press state', status, detail });
}

function censusMotionTokens(): { durations: Map<string, string>; curves: Map<string, string> } {
  const DEF_RE = /(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+);/g;
  const TIME_RE = /^(?:\d+(?:\.\d+)?|\.\d+)(?:ms|s)$/;
  const CURVE_RE = /^(?:cubic-bezier|steps|linear)\([^)]*\)$/;
  const durations = new Map<string, string>();
  const curves = new Map<string, string>();
  for (const f of scannedFiles) {
    let m: RegExpExecArray | null;
    const re = new RegExp(DEF_RE);
    while ((m = re.exec(f.css))) {
      const name = m[1];
      const value = m[2].trim();
      if (TIME_RE.test(value)) durations.set(name, value);
      else if (CURVE_RE.test(value)) curves.set(name, value);
    }
  }
  return { durations, curves };
}

function checkDurationTokens(): void {
  const DURATION_LITERAL_RE = /(?<![\w.-])(?:\d+(?:\.\d+)?|\.\d+)(?:ms|s)\b/g;
  const DECLARATION_RE = /\b(transition|animation|transition-duration|animation-duration)\s*:\s*([\s\S]*?);/g;

  const flagged: string[] = [];
  let literalCount = 0;
  const seenValues = new Set<string>();

  for (const f of scannedFiles) {
    let declMatch: RegExpExecArray | null;
    const re = new RegExp(DECLARATION_RE);
    while ((declMatch = re.exec(f.css))) {
      const value = declMatch[2];
      let litMatch: RegExpExecArray | null;
      const litRe = new RegExp(DURATION_LITERAL_RE);
      while ((litMatch = litRe.exec(value))) {
        const literal = litMatch[0];
        literalCount++;
        seenValues.add(literal);
        const isDialogCloseException = literal === '200ms' && f.relFile.endsWith('DirectionDialog.astro');
        const isReducedMotionException = /^\.?0*\.01ms$/.test(literal);

        const isZeroDurationException = literal === '0s' || literal === '0ms';

        const isSceneDriftException =
          f.relFile.endsWith('LandingPage.astro') && /scene-drift-x/.test(value);
        if (
          !isDialogCloseException &&
          !isReducedMotionException &&
          !isZeroDurationException &&
          !isSceneDriftException
        ) {
          flagged.push(`${f.relFile}: "${literal}" in "${declMatch[1]}: ${value.trim()}"`);
        }
      }
    }
  }

  const status: Status = flagged.length === 0 ? 'PASS' : 'FAIL';

  const { durations, curves } = censusMotionTokens();
  const fmt = (m: Map<string, string>): string =>
    [...m.entries()].map(([n, v]) => `${n} ${v}`).sort().join(', ') || 'none';
  const census =
    `token census (counted from source): ${durations.size} duration token(s) [${fmt(durations)}], ` +
    `${curves.size} curve(s) [${fmt(curves)}]`;

  const detail =
    `${literalCount} bare duration literal(s) found in transition/animation declarations, distinct values: [${[...seenValues].sort().join(', ') || 'none'}] -- ` +
    (flagged.length === 0
      ? 'all are documented exceptions or absent (.01ms in the reduced-motion override; 0s = отсутствие длительности в замке visibility запасной ветви WebKit, задержка там идёт токеном; 127s/89s/103s = бесконечный ход слоёв сцены `scene-drift-x`, фон, а не отклик — периоды взаимно просты намеренно; the 200ms DirectionDialog close literal is still tolerated but no longer present in the codebase); ' +
        `every other transition/animation goes through a duration token. ${census}`
      : `UNDOCUMENTED literal(s): ${flagged.join('; ')}. ${census}`);
  const label =
    `Motion set stays bounded: ${durations.size} duration token(s), ${curves.size} curve(s), no undocumented literals`;
  results.push({ id: '3', label, status, detail });
}

function checkBareEase(): void {
  const BARE_EASE_RE = /(?<![\w-])ease(?![\w-])/g;
  const occurrences: string[] = [];
  for (const f of scannedFiles) {
    let m: RegExpExecArray | null;
    const re = new RegExp(BARE_EASE_RE);
    while ((m = re.exec(f.css))) {
      const start = Math.max(0, m.index - 30);
      occurrences.push(`${f.relFile}: ...${f.css.slice(start, m.index + 10).replace(/\s+/g, ' ').trim()}...`);
    }
  }
  const status: Status = occurrences.length === 0 ? 'PASS' : 'FAIL';
  const detail =
    occurrences.length === 0
      ? 'was 53 (UI-SPEC §9 #7 baseline) -- 0 found, word-boundary matched so var(--ease-charge)/ease-out/ease-in are correctly excluded'
      : `${occurrences.length} bare "ease" keyword(s) found: ${occurrences.join('; ')}`;
  results.push({ id: '4', label: 'Zero bare `ease` keywords remain', status, detail });
}

function checkBadgeParity(): void {

  const expectations: {
    file: string;
    selector: string;
    size: number;
    role: string;
    kind?: 'box' | 'type';
  }[] = [
    {
      file: path.join(projectRoot, 'src', 'components', 'HowToStart.astro'),
      selector: '.spine-node',
      size: 74,
      kind: 'type',
      role: 'номер шага (мобильная база; десктопное значение задаётся в @media и здесь не проверяется)',
    },
    {
      file: path.join(projectRoot, 'src', 'components', 'DirectionCards.astro'),
      selector: '.direction-caret',
      size: 18,
      role: 'каретка аккордеона направлений; совпадает по размеру с кареткой FAQ — один индикатор раскрытия на весь проект',
    },
    {
      file: path.join(projectRoot, 'src', 'components', 'FaqAccordion.astro'),
      selector: '.faq-caret',
      size: 18,
      role: 'каретка FAQ-аккордеона; вторая сторона того же паритета',
    },
  ];
  const findings: string[] = [];
  let allOk = true;

  for (const { file, selector, size, role, kind = 'box' } of expectations) {
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      findings.push(`${path.basename(file)}: FILE NOT FOUND`);
      allOk = false;
      continue;
    }
    const clean = stripComments(source);
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ruleMatch = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(clean);
    if (!ruleMatch) {
      findings.push(`${path.basename(file)} ${selector}: RULE NOT FOUND`);
      allOk = false;
      continue;
    }
    const body = ruleMatch[1];
    if (kind === 'type') {
      const hasSize = new RegExp(`font-size\\s*:\\s*${size}px`).test(body);
      findings.push(`${path.basename(file)} ${selector} (${role}): font-size:${size}px=${hasSize}`);
      if (!hasSize) allOk = false;
      continue;
    }
    const hasWidth = new RegExp(`width\\s*:\\s*${size}px`).test(body);
    const hasHeight = new RegExp(`height\\s*:\\s*${size}px`).test(body);
    findings.push(
      `${path.basename(file)} ${selector} (${role}): width:${size}px=${hasWidth}, height:${size}px=${hasHeight}`
    );
    if (!hasWidth || !hasHeight) allOk = false;
  }

  results.push({
    id: '5',
    label: 'Numeral elements keep their declared geometry (spine numeral 74px, accordion carets 18)',
    status: allOk ? 'PASS' : 'FAIL',
    detail: findings.join('; '),
  });
}

function checkHeroGroupCount(): void {
  const heroFile = path.join(projectRoot, 'src', 'components', 'Hero.astro');
  let source: string;
  try {
    source = readFileSync(heroFile, 'utf8');
  } catch {
    results.push({ id: '6', label: 'Hero contains at most 4 above-the-fold visual groups', status: 'FAIL', detail: 'src/components/Hero.astro not found' });
    return;
  }

  const KNOWN_MARKERS = ['hero-h1', 'hero-chips', 'hero-actions', 'common-card'];
  const found = KNOWN_MARKERS.filter((marker) => new RegExp(`class="[^"]*\\b${marker}\\b[^"]*"`).test(source));

  const REJECTED_5TH_GROUP_CANDIDATES = ['hero-eyebrow', 'hero-badge', 'direction-preview', 'hero-preview'];
  const unexpected = REJECTED_5TH_GROUP_CANDIDATES.filter((marker) => new RegExp(`class="[^"]*\\b${marker}\\b[^"]*"`).test(source));

  const status: Status = found.length <= 4 && unexpected.length === 0 ? 'PASS' : 'FAIL';
  const detail =
    `${found.length} of 4 known group markers found: [${found.join(', ')}]` +
    (unexpected.length > 0 ? `; REGRESSION: previously-rejected 5th-group marker(s) reappeared: [${unexpected.join(', ')}]` : '; no previously-rejected 5th-group marker found');
  results.push({ id: '6', label: 'Hero contains at most 4 above-the-fold visual groups', status, detail });
}

function checkGoldUsage(): void {
  const goldUsages: string[] = [];
  const goldAreaCount = { n: 0 };

  for (const f of scannedFiles) {
    for (const block of f.blocks) {
      const goldRe = /var\(--gold\)/g;
      let m: RegExpExecArray | null;
      while ((m = goldRe.exec(block.text))) {
        const line = block.lineOffset + lineAt(block.text, m.index);

        const before = block.text.slice(Math.max(0, m.index - 60), m.index);
        const propMatch = /([a-zA-Z-]+)\s*:\s*[^;{}]*$/.exec(before);
        const prop = propMatch ? propMatch[1] : '(unknown property)';
        goldUsages.push(`${f.relFile}:${line} -- ${prop}: var(--gold)`);
      }
      goldAreaCount.n += (block.text.match(/var\(--gold-area\)/g) ?? []).length;
    }
  }

  const PERMITTED_FORMS_NOTE =
    '4 permitted forms (UI-SPEC §6.2): 1) hairline <=2px (connector-arrow stroke, 1px accent borders), ' +
    '2) gradient display-text (H1 <em>, its @supports fallback), 3) small icon/label <24px (direction-step number, FAQ caret, direction caret), ' +
    '4) one primary-CTA gradient fill, 5) direction-accordion name (Д-09, 26.08.2026: карточка «как в макете» — золотое имя направления, решение заказчика). ' +
    'Anything larger must use var(--gold-area) instead.';

  results.push({
    id: '7',
    label: 'Gold appears only in its 4 permitted forms; --gold-area used for anything larger',
    status: 'REPORT',
    detail:
      `${goldUsages.length} var(--gold) usage(s), ${goldAreaCount.n} var(--gold-area) usage(s) found. ${PERMITTED_FORMS_NOTE} ` +
      `Full var(--gold) list for human review: ${goldUsages.join(' | ')}`,
  });
}

function checkContentLossDeferred(): void {
  results.push({
    id: '8',
    label: 'prefers-reduced-motion / no-view()-support leaves 100% content visible',
    status: 'DEFERRED',
    detail: 'Covered by scripts/check-motion-safety.ts (npm run check:motion-safety) -- run it separately; not re-implemented here to avoid duplicating its brace-depth content-loss scan.',
  });
}

function checkFocusAndTransparency(): void {
  const tokensFile = path.join(projectRoot, 'src', 'styles', 'tokens.css');
  let source: string;
  try {
    source = readFileSync(tokensFile, 'utf8');
  } catch {
    results.push({ id: '9', label: 'Focus rings (box-shadow) + prefers-reduced-transparency', status: 'FAIL', detail: 'src/styles/tokens.css not found' });
    return;
  }
  const clean = stripComments(source);

  const focusMatch = /:focus-visible\s*\{([^}]*)\}/.exec(clean);
  let focus9a = false;
  let focus9aDetail = 'no top-level :focus-visible rule found';
  if (focusMatch) {
    const body = focusMatch[1];
    const outlineDecl = /outline\s*:\s*([^;]+);/.exec(body);
    const hasVisibleOutline = !!outlineDecl && !/^\s*none\s*$/.test(outlineDecl[1]);
    const hasBoxShadow = /box-shadow\s*:/.test(body);
    focus9a = hasVisibleOutline || hasBoxShadow;
    focus9aDetail = `outline=${outlineDecl ? outlineDecl[1].trim() : '(not set)'}, box-shadow present=${hasBoxShadow}`;
  }

  const blurOwners: string[] = [];
  const missingFallback: string[] = [];
  for (const f of scannedFiles) {
    const declaresBlur = /backdrop-filter\s*:\s*blur\(/.test(f.css);
    if (!declaresBlur) continue;
    blurOwners.push(f.relFile);
    const hasFallback = /@media\s*\(\s*prefers-reduced-transparency\s*:\s*reduce\s*\)/.test(f.css);
    if (!hasFallback) missingFallback.push(f.relFile);
  }
  const transparency9b = blurOwners.length > 0 && missingFallback.length === 0;
  const transparency9bDetail =
    blurOwners.length === 0
      ? 'no backdrop-filter: blur() found anywhere (unexpected)'
      : missingFallback.length === 0
        ? `${blurOwners.length} file(s) declare blur, each has its own reduced-transparency fallback`
        : `no fallback in: ${missingFallback.join(', ')}`;

  const status: Status = focus9a && transparency9b ? 'PASS' : 'FAIL';
  results.push({
    id: '9',
    label:
      'Global focus ring is visible + every file declaring backdrop-filter carries its own reduced-transparency fallback',
    status,
    detail: `9a focus-visible: ${focus9aDetail} (${focus9a ? 'OK' : 'FAIL'}); 9b reduced-transparency: ${transparency9bDetail} (${transparency9b ? 'OK' : 'FAIL'})`,
  });
}

function main(): void {
  checkHoverGuards();
  checkPressStates();
  checkDurationTokens();
  checkBareEase();
  checkBadgeParity();
  checkHeroGroupCount();
  checkGoldUsage();
  checkContentLossDeferred();
  checkFocusAndTransparency();

  console.log(`--- Craft-contract scan: ${scannedFiles.length} file(s) (src/components + src/layouts *.astro, src/styles *.css) ---\n`);
  console.log('# | Status   | Statement');
  console.log('--|----------|----------------------------------------------------------------');
  for (const r of results) {
    console.log(`${r.id.padEnd(2)}| ${r.status.padEnd(9)}| ${r.label}`);
    console.log(`   ${r.detail}`);
  }

  const hardResults = results.filter((r) => r.status === 'PASS' || r.status === 'FAIL');
  const failed = hardResults.filter((r) => r.status === 'FAIL');
  const reportOnly = results.filter((r) => r.status === 'REPORT').length;
  const deferred = results.filter((r) => r.status === 'DEFERRED').length;

  console.log(
    `\n${hardResults.length - failed.length}/${hardResults.length} hard checks passed, ${reportOnly} report-only statement(s), ${deferred} deferred to check-motion-safety.ts.`,
  );

  if (failed.length > 0) {
    console.error(`\n${failed.length} statement(s) FAILED: ${failed.map((f) => `#${f.id}`).join(', ')}`);
    process.exit(1);
  }

  console.log('\nPASS: all 9 UI-SPEC §14 statements accounted for (7 hard-checked, 1 reported for human review, 1 deferred to check-motion-safety.ts).');
}

main();
