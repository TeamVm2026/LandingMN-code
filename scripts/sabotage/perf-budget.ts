
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { SabotageCase, GreenRun } from '../check-sabotage.ts';

const GREEN: GreenRun = {
  command: ['--experimental-strip-types', 'scripts/check-perf-budget.ts'],
  costly: 'нужна собранная dist/ (npm run build) — бюджет считается по dist/index.html',
};

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const distDir = path.join(projectRoot, 'dist');
const sourceHtml = path.join(distDir, 'index.html');

function sabotagePath(id: string): string {
  return path.join(distDir, `__sabotage-${id}.html`);
}

function readBuiltHtml(): string {
  if (!existsSync(sourceHtml)) {
    throw new Error('нет dist/index.html — сначала `npm run build`, саботировать нечего');
  }
  return readFileSync(sourceHtml, 'utf8');
}

function writeSabotaged(id: string, html: string): void {
  writeFileSync(sabotagePath(id), html, 'utf8');
}

function cleanup(id: string): void {
  rmSync(sabotagePath(id), { force: true });
}

function gateCommand(id: string): string[] {
  const target = path.relative(projectRoot, sabotagePath(id)).replace(/\\/g, '/');
  return ['--experimental-strip-types', 'scripts/check-perf-budget.ts', target];
}

function incompressibleJunk(bytes: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let state = 0x5eed1234;
  const out: string[] = new Array(bytes);
  for (let i = 0; i < bytes; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = alphabet[Math.abs(state) % alphabet.length];
  }
  return out.join('');
}

function insertAtHeadEnd(html: string, snippet: string): string {
  if (!html.includes('</head>')) throw new Error('в сборке не найден </head>');
  return html.replace('</head>', `${snippet}</head>`);
}

function insertBeforeFontPreload(html: string, snippet: string): string {
  const match = html.match(/<link\b[^>]*rel="preload"[^>]*as="font"[^>]*>/i);
  if (!match || match.index === undefined) {
    throw new Error('в сборке нет <link rel="preload" as="font"> — саботаж позиции невозможен');
  }
  return html.slice(0, match.index) + snippet + html.slice(match.index);
}

const secondInlineScript: SabotageCase = {
  id: 'perf-second-inline-script',
  gate: 'check:perf',
  describe: 'два исполняемых инлайн-скрипта в <head> вместо одного разрешённого',
  setup() {
    writeSabotaged(
      this.id,
      insertAtHeadEnd(
        readBuiltHtml(),
        '<script>window.__sabotageA = 1;</script><script>window.__sabotageB = 2;</script>'
      )
    );
  },
  get command() {
    return gateCommand(this.id);
  },
  expectOutputContains: 'ИНЛАЙН-СКРИПТОВ',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const inlineScriptTooBig: SabotageCase = {
  id: 'perf-inline-script-too-big',
  gate: 'check:perf',
  describe: 'единственный инлайн-скрипт разросся за потолок в 1500 байт',
  setup() {

    const body = `window.__sabotage = "${'x'.repeat(1600)}";`;
    writeSabotaged(this.id, insertAtHeadEnd(readBuiltHtml(), `<script>${body}</script>`));
  },
  get command() {
    return gateCommand(this.id);
  },
  expectOutputContains: 'РАЗМЕР ИНЛАЙН-СКРИПТА',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const inlineScriptBeforeFont: SabotageCase = {
  id: 'perf-inline-script-before-font',
  gate: 'check:perf',
  describe: 'инлайн-скрипт переставлен ПЕРЕД preload шрифта и задерживает его запрос',
  setup() {
    writeSabotaged(
      this.id,
      insertBeforeFontPreload(readBuiltHtml(), '<script>window.__sabotageC = 3;</script>')
    );
  },
  get command() {
    return gateCommand(this.id);
  },
  expectOutputContains: 'ПОЗИЦИЯ ИНЛАЙН-СКРИПТА',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const thirdPartyScript: SabotageCase = {
  id: 'perf-third-party-script',
  gate: 'check:perf',
  describe: 'тег gtag.js на чужой origin в собранном HTML в обход отложенного импорта',
  setup() {
    writeSabotaged(
      this.id,
      insertAtHeadEnd(
        readBuiltHtml(),
        '<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXX"></script>'
      )
    );
  },
  get command() {
    return gateCommand(this.id);
  },
  expectOutputContains: 'СТОРОННИЙ SCRIPT SRC',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const budgetBlown: SabotageCase = {
  id: 'perf-budget-blown',
  gate: 'check:perf',
  describe: 'критический путь раздут за 140 КБ несжимаемым мусором внутри HTML',
  setup() {

    const junk = incompressibleJunk(224 * 1024);
    const html = readBuiltHtml();
    if (!html.includes('</body>')) throw new Error('в сборке не найден </body>');
    writeSabotaged(this.id, html.replace('</body>', `<!-- ${junk} --></body>`));
  },
  get command() {
    return gateCommand(this.id);
  },
  expectOutputContains: 'exceeds',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

function sabotageCssPath(id: string): string {
  return path.join(distDir, `__sabotage-${id}.css`);
}

function findBuiltRaster(): string {
  const astroDir = path.join(distDir, '_astro');
  const names = existsSync(astroDir) ? readdirSync(astroDir) : [];
  const hit = names.find((n) => /\.(avif|webp|png|jpe?g)$/i.test(n));
  if (!hit) throw new Error('в dist/_astro нет ни одного растрового файла — саботаж фона невозможен');
  return `/_astro/${hit}`;
}

function firstScreenClass(html: string): string {
  const mainStart = html.search(/<main\b[^>]*>/i);
  if (mainStart < 0) throw new Error('в сборке нет <main> — первый экран определить нечем');
  const cls = html.slice(mainStart).match(/<section\b[^>]*\bclass="([^"\s]+)/i)?.[1];
  if (!cls) throw new Error('у первой секции <main> нет класса — саботаж первого экрана невозможен');
  return cls;
}

const cssBackgroundFirstScreen: SabotageCase = {
  id: 'perf-css-background-first-screen',
  gate: 'check:perf',
  describe: 'растровый фон приложен правилом background-image к секции первого экрана',
  setup() {
    const html = readBuiltHtml();
    const raster = findBuiltRaster();
    const selector = `.${firstScreenClass(html)}`;
    writeFileSync(
      sabotageCssPath(this.id),
      `${selector}{background-image:url("${raster}");background-size:cover}`,
      'utf8'
    );
    const href = `/${path.basename(sabotageCssPath(this.id))}`;
    writeSabotaged(this.id, insertAtHeadEnd(html, `<link rel="stylesheet" href="${href}">`));
  },
  get command() {
    return gateCommand(this.id);
  },

  expectOutputContains: 'РАСТРОВЫЙ ФОН В CSS ПЕРВОГО ЭКРАНА',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
    rmSync(sabotageCssPath(this.id), { force: true });
  },
};

const cssSweepEmpty: SabotageCase = {
  id: 'perf-css-not-found',
  gate: 'check:perf',
  describe: 'у страницы не осталось ни одной таблицы стилей — обходить нечего',
  setup() {
    const html = readBuiltHtml()
      .replace(/<link[^>]*rel="stylesheet"[^>]*>/g, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
    writeSabotaged(this.id, html);
  },
  get command() {
    return gateCommand(this.id);
  },
  expectOutputContains: 'КРИТИЧЕСКИЙ CSS НЕ НАЙДЕН',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

function heaviestRasters(minTotalBytes: number): string[] {
  const astroDir = path.join(distDir, '_astro');
  const names = existsSync(astroDir) ? readdirSync(astroDir) : [];
  const files = names
    .filter((n) => /\.(avif|webp|png|jpe?g)$/i.test(n))
    .map((n) => ({ n, size: statSync(path.join(astroDir, n)).size }))
    .sort((a, b) => b.size - a.size);
  const picked: string[] = [];
  let total = 0;
  for (const f of files) {
    picked.push(`/_astro/${f.n}`);
    total += f.size;
    if (total >= minTotalBytes) return picked;
  }
  throw new Error(
    `в dist/_astro не набралось ${minTotalBytes} Б растра — саботаж масок невозможен`
  );
}

const BUDGET_BYTES = 140 * 1024;

function maskCase(id: string, property: string, describe: string): SabotageCase {
  return {
    id,
    gate: 'check:perf',
    describe,
    setup() {
      const rasters = heaviestRasters(BUDGET_BYTES * 2);
      const css = rasters
        .map((url) => `.partners-name--lexor2k{${property}:url("${url}")}`)
        .join('');
      writeFileSync(sabotageCssPath(this.id), css, 'utf8');
      const href = `/${path.basename(sabotageCssPath(this.id))}`;
      writeSabotaged(this.id, insertAtHeadEnd(readBuiltHtml(), `<link rel="stylesheet" href="${href}">`));
    },
    get command() {
      return gateCommand(this.id);
    },

    expectOutputContains: 'exceeds',
    greenRun: GREEN,
    teardown() {
      cleanup(this.id);
      rmSync(sabotageCssPath(this.id), { force: true });
    },
  };
}

const cssMaskImage = maskCase(
  'perf-css-mask-image',
  'mask-image',
  'ники блогеров замаскированы тяжёлыми кадрами через mask-image — байты обязаны войти в бюджет'
);

const cssWebkitMaskImage = maskCase(
  'perf-css-webkit-mask-image',
  '-webkit-mask-image',
  'то же самое префиксным -webkit-mask-image — учёт не должен зависеть от написания'
);

const unresolvedImgSrc: SabotageCase = {
  id: 'perf-unresolved-img-src',
  gate: 'check:perf',
  describe: 'одиночный <img> первого экрана ссылается на файл, которого в сборке нет',
  setup() {
    const html = readBuiltHtml();
    if (!html.includes('</body>')) throw new Error('в сборке не найден </body>');

    writeSabotaged(
      this.id,
      html.replace('</body>', '<img src="/_astro/net-takogo-fajla.avif" width="1" height="1"></body>'),
    );
  },
  get command() {
    return gateCommand(this.id);
  },
  expectOutputContains: 'could not be resolved',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

const unresolvedModuleSrc: SabotageCase = {
  id: 'perf-unresolved-module-src',
  gate: 'check:perf',
  describe: 'отложенный <script type="module"> ссылается на файл, которого в сборке нет',
  setup() {
    const html = readBuiltHtml();
    if (!html.includes('</body>')) throw new Error('в сборке не найден </body>');
    writeSabotaged(
      this.id,
      html.replace('</body>', '<script type="module" src="/_astro/net-takogo-modulya.js"></script></body>'),
    );
  },
  get command() {
    return gateCommand(this.id);
  },
  expectOutputContains: 'could not be resolved',
  greenRun: GREEN,
  teardown() {
    cleanup(this.id);
  },
};

export const cases: SabotageCase[] = [
  secondInlineScript,
  inlineScriptTooBig,
  inlineScriptBeforeFont,
  thirdPartyScript,
  budgetBlown,
  cssBackgroundFirstScreen,
  cssSweepEmpty,
  cssMaskImage,
  cssWebkitMaskImage,
  unresolvedImgSrc,
  unresolvedModuleSrc,
];
