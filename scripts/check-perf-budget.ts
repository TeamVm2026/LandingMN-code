
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const projectRoot = path.resolve(import.meta.dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const indexPath = path.join(distDir, 'index.html');

const CRITICAL_PATH_BUDGET_BYTES = 140 * 1024;

const TZ_FIRST_SCREEN_BYTES = 150 * 1024;

const PHONE_CSS_WIDTH = 390;
const PHONE_DPR = 3;

const PHONE_CSS_HEIGHT = 844;

const FALLBACK_IMAGE_CAP_BYTES = 220 * 1024;

const MAX_INLINE_HEAD_SCRIPTS = 1;

const INLINE_HEAD_SCRIPT_MAX_BYTES = 1500;

const RASTER_URL_EXTENSIONS = ['.webp', '.avif', '.png', '.jpg', '.jpeg', '.gif'];

interface Finding {
  label: string;
  bytes: number;
}

function gzipSize(buf: Buffer): number {
  return gzipSync(buf).length;
}

function resolveDistAsset(srcAttr: string): string | null {

  if (!srcAttr.startsWith('/')) return null;
  const relative = srcAttr.replace(/^\/+/, '').split(/[?#]/)[0];
  const resolved = path.join(distDir, relative);
  return existsSync(resolved) ? resolved : null;
}

interface CssUrlRef {

  url: string;

  property: string;

  selector: string;

  mediaConditions: string[];

  origin: string;
}

function parseCssUrls(css: string, origin: string): CssUrlRef[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const refs: CssUrlRef[] = [];

  const stack: string[] = [];
  let buffer = '';

  const flush = (): void => {
    const text = buffer;
    buffer = '';
    if (!text.includes('url(')) return;
    const selector = [...stack].reverse().find((p) => !p.startsWith('@')) ?? '';
    const mediaConditions = stack
      .filter((p) => /^@media\b/i.test(p))
      .map((p) => p.replace(/^@media\s*/i, '').trim());
    const property = text.split(':')[0].trim().split(/[\s;{]/).pop() ?? '';
    for (const match of text.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
      refs.push({ url: match[2].trim(), property, selector, mediaConditions, origin });
    }
  };

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < clean.length && (clean[j] !== quote || clean[j - 1] === '\\')) j++;
      buffer += clean.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '{') {
      stack.push(buffer.trim());
      buffer = '';
      continue;
    }
    if (ch === '}') {
      flush();
      stack.pop();
      continue;
    }
    if (ch === ';') {
      flush();
      continue;
    }
    buffer += ch;
  }
  return refs;
}

function extractElement(html: string, tag: string, from = 0): string | null {
  const open = new RegExp(`<${tag}\\b[^>]*>`, 'i');
  const rest = html.slice(from);
  const start = rest.search(open);
  if (start < 0) return null;
  let depth = 0;
  const scanner = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, 'gi');
  scanner.lastIndex = start;
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(rest)) !== null) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return rest.slice(start, match.index + match[0].length);
  }
  return null;
}

function firstScreenTokens(html: string): Set<string> {
  const tokens = new Set<string>();
  const regions: string[] = [];
  const header = extractElement(html, 'header');
  if (header) regions.push(header);
  const mainStart = html.search(/<main\b[^>]*>/i);
  if (mainStart >= 0) {
    const firstSection = extractElement(html, 'section', mainStart);
    if (firstSection) regions.push(firstSection);
  }
  for (const region of regions) {
    for (const match of region.matchAll(/\bclass="([^"]*)"/g)) {
      for (const cls of match[1].split(/\s+/).filter(Boolean)) tokens.add(`.${cls}`);
    }
    for (const match of region.matchAll(/\bid="([^"]*)"/g)) {
      if (match[1].trim()) tokens.add(`#${match[1].trim()}`);
    }
  }
  return tokens;
}

function selectorTouchesFirstScreen(selector: string, tokens: Set<string>): boolean {
  if (!selector) return true;
  if (/(^|[\s,>+~])(html|body)\b/i.test(selector) || selector.includes(':root')) return true;
  const used = selector.match(/[.#][A-Za-z_][\w-]*/g) ?? [];
  if (used.length === 0) return true;
  return used.some((token) => tokens.has(token));
}

function resolveCssUrl(url: string, cssDir: string): string | null {
  if (url.startsWith('/')) return resolveDistAsset(url);
  if (/^[a-z]+:/i.test(url) || url.startsWith('//')) return null;
  const resolved = path.join(cssDir, url.split(/[?#]/)[0]);
  return existsSync(resolved) ? resolved : null;
}

interface CssBackgroundAnalysis {

  findings: Finding[];

  problems: string[];
  warnings: string[];

  report: string[];
}

function analyzeCssBackgrounds(htmlPath: string): CssBackgroundAnalysis {
  const findings: Finding[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];
  const report: string[] = [];

  const html = readFileSync(htmlPath, 'utf8');
  const htmlDir = path.dirname(htmlPath);
  const sources: { css: string; origin: string; dir: string }[] = [];

  for (const tag of html.match(/<link[^>]*rel="stylesheet"[^>]*>/g) ?? []) {
    const href = tag.match(/href="([^"]+)"/)?.[1];
    if (!href) continue;
    const resolved = resolveDistAsset(href);
    if (!resolved) {
      warnings.push(`stylesheet href="${href}" не разрешается в файл dist/ — фоны в нём не проверены`);
      continue;
    }
    sources.push({ css: readFileSync(resolved, 'utf8'), origin: href, dir: path.dirname(resolved) });
  }
  for (const [index, match] of [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].entries()) {
    sources.push({ css: match[1], origin: `inline <style> #${index + 1}`, dir: htmlDir });
  }

  if (sources.length === 0) {
    problems.push(
      'КРИТИЧЕСКИЙ CSS НЕ НАЙДЕН: у страницы нет ни <link rel="stylesheet">, ни <style>. ' +
        'Разбор растровых фонов не выполнен ни по одному байту, поэтому его молчание ' +
        'ничего не подтверждает.'
    );
    return { findings, problems, warnings, report };
  }

  const tokens = firstScreenTokens(html);
  const refs = sources.flatMap((s) =>
    parseCssUrls(s.css, s.origin).map((ref) => ({ ...ref, dir: s.dir }))
  );
  const raster = refs.filter((ref) => {
    if (/^data:/i.test(ref.url)) return false;
    const clean = ref.url.split(/[?#]/)[0].toLowerCase();
    return RASTER_URL_EXTENSIONS.some((ext) => clean.endsWith(ext));
  });

  report.push(
    `ссылок url() всего: ${refs.length}; из них растровых: ${raster.length} ` +
      `(таблиц стилей разобрано: ${sources.length})`
  );

  const byProperty = new Map<string, number>();
  for (const ref of raster) byProperty.set(ref.property, (byProperty.get(ref.property) ?? 0) + 1);
  report.push(
    `свойства, в которых найден растр: ` +
      ([...byProperty.entries()].map(([k, v]) => `${k} × ${v}`).join(', ') || '—')
  );

  const countedOnce = new Set<string>();
  let totalRasterBytes = 0;

  for (const ref of raster) {
    const resolved = resolveCssUrl(ref.url, ref.dir);
    const firstScreen = selectorTouchesFirstScreen(ref.selector, tokens);
    const visibleToPhone = ref.mediaConditions.every((m) => mediaQueryMatchesPhone(m, warnings));

    if (!resolved) {

      warnings.push(`фон url("${ref.url}") (${ref.property}) не разрешается в файл dist/`);
      continue;
    }
    const bytes = statSync(resolved).size;
    totalRasterBytes += bytes;
    const shown = path.relative(distDir, resolved).replace(/\\/g, '/');
    report.push(
      `  /${shown}: ${bytes} Б, свойство ${ref.property}, селектор «${ref.selector || '(без селектора)'}»` +
        `${ref.mediaConditions.length ? `, @media ${ref.mediaConditions.join(' и ')}` : ''}` +
        `${firstScreen ? ' — ПЕРВЫЙ ЭКРАН' : ''}${visibleToPhone ? '' : ' — телефону профиля не отдаётся'}`
    );

    if (visibleToPhone && !countedOnce.has(resolved)) {
      countedOnce.add(resolved);
      findings.push({ label: `/${shown} (raw, CSS background)`, bytes });
    }

    if (firstScreen) {
      problems.push(
        `РАСТРОВЫЙ ФОН В CSS ПЕРВОГО ЭКРАНА: ${ref.property}: url("${ref.url}") ` +
          `в правиле «${ref.selector || '(без селектора)'}» (${ref.origin}), ${bytes} Б. ` +
          'Фон первого экрана ставится разметкой через astro:assets, а не background-image: ' +
          'у CSS-фона нет ни srcset, ни выбора формата под браузер, ни width/height.'
      );
    }
  }

  report.push(
    `суммарно растровых фонов: ${(totalRasterBytes / 1024).toFixed(2)} КБ, ` +
      `в бюджет телефона вошло ${(findings.reduce((s, f) => s + f.bytes, 0) / 1024).toFixed(2)} КБ ` +
      `(${findings.length} файл(ов))`
  );

  return { findings, problems, warnings, report };
}

function measureCriticalPath(
  htmlPath: string,
  cssBackgrounds: CssBackgroundAnalysis | null,
): {
  findings: Finding[];
  totalBytes: number;

  factOnly: Finding[];

  factBytes: number;
  warnings: string[];
  errors: string[];
  notes: string[];
} {
  const findings: Finding[] = [];
  const warnings: string[] = [];

  const errors: string[] = [];

  const notes: string[] = [];

  const factOnly: Finding[] = [];

  const html = readFileSync(htmlPath, 'utf8');
  const htmlBuf = Buffer.from(html, 'utf8');
  const htmlGzip = gzipSize(htmlBuf);
  const relLabel = path.relative(projectRoot, htmlPath).replace(/\\/g, '/');
  findings.push({ label: `${relLabel} (gzip, includes any inline <style>)`, bytes: htmlGzip });

  const head = extractHead(html);
  if (head !== null) {
    for (const script of collectInlineHeadScripts(head)) {
      notes.push(`inline <head> script (raw, ${script.bytes} bytes) — не суммируется, уже внутри gzip(HTML)`);
    }
  }

  const linkTags = html.match(/<link[^>]*rel="stylesheet"[^>]*>/g) ?? [];
  for (const tag of linkTags) {
    const hrefMatch = tag.match(/href="([^"]+)"/);
    if (!hrefMatch) continue;
    const resolved = resolveDistAsset(hrefMatch[1]);
    if (!resolved) {
      warnings.push(`stylesheet link href="${hrefMatch[1]}" could not be resolved to a dist/ file`);
      continue;
    }
    const cssGzip = gzipSize(readFileSync(resolved));
    findings.push({ label: `${hrefMatch[1]} (gzip)`, bytes: cssGzip });
  }

  const preloadTags = html.match(/<link[^>]*rel="preload"[^>]*>/g) ?? [];
  for (const tag of preloadTags) {
    if (!/as="font"/.test(tag)) continue;
    const hrefMatch = tag.match(/href="([^"]+)"/);
    if (!hrefMatch) continue;
    const resolved = resolveDistAsset(hrefMatch[1]);
    if (!resolved) {
      warnings.push(`preloaded font href="${hrefMatch[1]}" could not be resolved to a dist/ file`);
      continue;
    }

    findings.push({ label: `${hrefMatch[1]} (raw, preloaded font)`, bytes: statSync(resolved).size });
  }

  const pictureBlocks = html.match(/<picture[^>]*>[\s\S]*?<\/picture>/g) ?? [];
  const consumedImgTags = new Set<string>();

  const foldWrappers = html.match(/<div[^>]*data-crosses-fold="true"[^>]*>[\s\S]*?<\/div>/g) ?? [];
  const crossesFold = (block: string): boolean => foldWrappers.some((w) => w.includes(block));

  for (const block of pictureBlocks) {
    const imgTag = block.match(/<img[^>]*>/)?.[0];
    if (imgTag) consumedImgTags.add(imgTag);
    const aboveFold = imgTag ? !/loading="lazy"/.test(imgTag) : true;

    const sources = block.match(/<source[^>]*>/g) ?? [];
    const visibleToPhone = sources.filter((s) => mediaMatchesPhone(s, warnings));
    const avif = visibleToPhone.find((s) => /type="image\/avif"/.test(s));
    const chosen = avif ?? visibleToPhone[0];

    const lazyButVisible = !aboveFold && crossesFold(block);

    if ((aboveFold || lazyButVisible) && chosen) {
      const candidates = phoneSrcsetCandidate(chosen, warnings);
      if (candidates) {
        const resolved = resolveDistAsset(candidates);
        if (resolved) {
          const entry = {
            label: `${candidates} (raw, ${aboveFold ? 'above-fold' : 'lazy but crosses fold'} <picture> ${avif ? 'AVIF' : 'first source'})`,
            bytes: statSync(resolved).size,
          };

          if (aboveFold) findings.push(entry);
          else factOnly.push(entry);
        } else {

          errors.push(`<picture> candidate "${candidates}" could not be resolved to a dist/ file`);
        }
      }
    }
  }

  const imgTags = html.match(/<img[^>]*>/g) ?? [];
  for (const tag of imgTags) {
    if (consumedImgTags.has(tag)) continue;
    if (/loading="lazy"/.test(tag)) continue;
    const srcMatch = tag.match(/src="([^"]+)"/);
    if (!srcMatch) continue;
    const resolved = resolveDistAsset(srcMatch[1]);
    if (!resolved) {

      errors.push(`critical image src="${srcMatch[1]}" could not be resolved to a dist/ file`);
      continue;
    }
    const imgBytes = statSync(resolved).size;
    findings.push({ label: `${srcMatch[1]} (raw, above-fold image)`, bytes: imgBytes });
  }

  if (cssBackgrounds) findings.push(...cssBackgrounds.findings);

  for (const tag of html.match(/<script[^>]*type="module"[^>]*>/g) ?? []) {
    const src = tag.match(/src="([^"]+)"/)?.[1];
    if (!src) continue;
    const resolved = resolveDistAsset(src);
    if (!resolved) {
      errors.push(`deferred module src="${src}" could not be resolved to a dist/ file`);
      continue;
    }
    factOnly.push({ label: `${src} (gzip, deferred module)`, bytes: gzipSize(readFileSync(resolved)) });
  }

  const totalBytes = findings.reduce((sum, f) => sum + f.bytes, 0);
  const factBytes = totalBytes + factOnly.reduce((sum, f) => sum + f.bytes, 0);
  return { findings, totalBytes, factOnly, factBytes, warnings, errors, notes };
}

function collectHtml(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collectHtml(full, out);
    else if (entry.endsWith('.html')) out.push(full);
  }
}

function mediaMatchesPhone(sourceTag: string, warnings: string[]): boolean {
  const media = sourceTag.match(/media="([^"]+)"/)?.[1];
  if (!media) return true;
  return mediaQueryMatchesPhone(media, warnings);
}

function mediaQueryMatchesPhone(media: string, warnings: string[]): boolean {
  if (media.includes(',') || /\bnot\b/.test(media)) {
    warnings.push(
      `media="${media}" содержит список или отрицание — разобрать не могу, ` +
        'источник посчитан видимым телефону (см. mediaMatchesPhone)',
    );
    return true;
  }
  const max = media.match(/max-width:\s*(\d+)px/);
  if (max && PHONE_CSS_WIDTH > Number.parseInt(max[1], 10)) return false;
  const min = media.match(/min-width:\s*(\d+)px/);
  if (min && PHONE_CSS_WIDTH < Number.parseInt(min[1], 10)) return false;
  return true;
}

function declaredLayoutWidth(sizes: string): number | null {
  const term = (raw: string): number | null => {
    let total = 0;
    const parts = raw.trim().match(/[+-]?\s*[\d.]+(?:vw|vh|px)/g);
    if (!parts || parts.length === 0) return null;

    if (raw.replace(/[+\-\s]|[\d.]+(?:vw|vh|px)/g, '').length > 0) return null;
    for (const part of parts) {
      const value = Number.parseFloat(part.replace(/\s+/g, ''));
      if (!Number.isFinite(value)) return null;
      if (part.endsWith('vw')) total += (value * PHONE_CSS_WIDTH) / 100;
      else if (part.endsWith('vh')) total += (value * PHONE_CSS_HEIGHT) / 100;
      else total += value;
    }
    return total;
  };

  const trimmed = sizes.trim();
  const max = trimmed.match(/^max\(([^()]*)\)$/);
  if (max) {
    const values = max[1].split(',').map(term);
    if (values.some((v) => v === null)) return null;
    return Math.max(...(values as number[]));
  }
  return term(trimmed);
}

function phoneSrcsetCandidate(sourceTag: string, warnings: string[] = []): string | null {
  const srcset = sourceTag.match(/srcset="([^"]+)"/)?.[1];
  if (!srcset) return null;
  const entries = srcset
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [url, descriptor] = part.split(/\s+/);
      const width = descriptor?.endsWith('w') ? Number.parseInt(descriptor, 10) : Number.NaN;
      return { url, width };
    })
    .filter((e) => e.url);
  if (entries.length === 0) return null;
  const withWidths = entries.filter((e) => Number.isFinite(e.width));

  if (withWidths.length === 0) return entries[entries.length - 1].url;

  const sizes = sourceTag.match(/sizes="([^"]+)"/)?.[1];
  const layoutWidth = sizes === undefined ? PHONE_CSS_WIDTH : declaredLayoutWidth(sizes);
  if (layoutWidth === null) {
    warnings.push(
      `sizes="${sizes}" разобрать не могу — потребность посчитана по ширине экрана, ` +
        'вес критического пути может быть ЗАНИЖЕН (см. declaredLayoutWidth)',
    );
  }
  const needed = (layoutWidth ?? PHONE_CSS_WIDTH) * PHONE_DPR;
  const sorted = [...withWidths].sort((a, b) => a.width - b.width);
  return (sorted.find((e) => e.width >= needed) ?? sorted[sorted.length - 1]).url;
}

function checkPictureFallbacks(html: string): string[] {
  const problems: string[] = [];
  const blocks = html.match(/<picture[^>]*>[\s\S]*?<\/picture>/g) ?? [];
  for (const [index, block] of blocks.entries()) {
    const imgTag = block.match(/<img[^>]*>/)?.[0];
    if (!imgTag) {
      problems.push(`<picture> #${index + 1} не содержит <img>-fallback`);
      continue;
    }
    const src = imgTag.match(/src="([^"]+)"/)?.[1];
    if (!src) {
      problems.push(`<picture> #${index + 1}: у <img>-fallback нет src`);
      continue;
    }
    const measured = phoneSrcsetCandidate(imgTag) ?? src;
    const resolved = resolveDistAsset(measured);
    if (!resolved) continue;
    const bytes = statSync(resolved).size;
    if (bytes > FALLBACK_IMAGE_CAP_BYTES) {
      problems.push(
        `${measured}: fallback ${(bytes / 1024).toFixed(0)} КБ превышает потолок ${(FALLBACK_IMAGE_CAP_BYTES / 1024).toFixed(0)} КБ`
      );
    }
  }
  return problems;
}

function extractHead(html: string): string | null {
  const match = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  return match ? match[1] : null;
}

interface InlineHeadScript {

  start: number;

  end: number;

  bytes: number;

  openTag: string;
}

function collectInlineHeadScripts(head: string): InlineHeadScript[] {
  const found: InlineHeadScript[] = [];
  for (const match of head.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = match[1];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (/\btype\s*=\s*["']application\/ld\+json["']/i.test(attrs)) continue;
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      bytes: Buffer.byteLength(match[2], 'utf8'),
      openTag: `<script${attrs}>`,
    });
  }
  return found;
}

function checkInlineHeadScripts(html: string): string[] {
  const problems: string[] = [];
  const head = extractHead(html);
  if (head === null) return problems;

  const bodyStart = html.search(/<body[\s>]/i);
  const body = (bodyStart < 0 ? '' : html.slice(bodyStart)).replace(/<!--[\s\S]*?-->/g, ' ');
  for (const script of collectInlineHeadScripts(body)) {
    const isModule = /\btype\s*=\s*["']module["']/i.test(script.openTag);
    const isData = /\btype\s*=\s*["'](?!text\/javascript|module)[^"']+["']/i.test(script.openTag);
    if (isModule || isData) continue;
    problems.push(
      `БЛОКИРУЮЩИЙ ИНЛАЙН-СКРИПТ В <body> (${script.bytes} Б, ${script.openTag.slice(0, 80)}). ` +
        'Парсер останавливается на нём так же, как в <head>. Либо type="module" ' +
        '(браузер отложит сам), либо в отложенный модуль src/scripts/interactive.ts.'
    );
  }

  const scripts = collectInlineHeadScripts(head);
  if (scripts.length === 0) return problems;

  if (scripts.length > MAX_INLINE_HEAD_SCRIPTS) {
    problems.push(
      `ИНЛАЙН-СКРИПТОВ в <head> ${scripts.length} при допустимых ${MAX_INLINE_HEAD_SCRIPTS}. ` +
        'Цена инлайна — пауза парсера, а не байты; прежде чем поднимать потолок, ' +
        'перечитать §5 ресёрча Фазы 3 и убрать лишнее в отложенный модуль.'
    );
  }

  for (const script of scripts) {
    if (script.bytes > INLINE_HEAD_SCRIPT_MAX_BYTES) {
      problems.push(
        `РАЗМЕР ИНЛАЙН-СКРИПТА ${script.bytes} Б превышает потолок ${INLINE_HEAD_SCRIPT_MAX_BYTES} Б ` +
          `(${script.openTag.slice(0, 80)}).`
      );
    }
  }

  const fontPreloads = [...head.matchAll(/<link\b[^>]*>/gi)].filter(
    (m) => /rel\s*=\s*["']preload["']/i.test(m[0]) && /as\s*=\s*["']font["']/i.test(m[0])
  );
  if (fontPreloads.length === 0) {
    problems.push(
      'ПОЗИЦИЯ ИНЛАЙН-СКРИПТА непроверяема: в <head> нет <link rel="preload" as="font">, ' +
        'относительно которого она определена. Проверка не пропускается молча — ' +
        'исчезнувший preload шрифта сам по себе регрессия критического пути.'
    );
  } else {
    const lastFontPreload = fontPreloads[fontPreloads.length - 1].index;
    for (const script of scripts) {
      if (script.start < lastFontPreload) {
        problems.push(
          'ПОЗИЦИЯ ИНЛАЙН-СКРИПТА: он стоит ДО <link rel="preload" as="font"> и задержит ' +
            'запрос шрифта. Место инлайна — последним элементом <head>.'
        );
      }
    }
  }

  for (const script of scripts) {
    const tail = head.slice(script.end);
    const laterScript = /<script\b/i.test(tail);
    const laterPreload = [...tail.matchAll(/<link\b[^>]*>/gi)].some((m) =>
      /rel\s*=\s*["']preload["']/i.test(m[0])
    );
    if (laterScript || laterPreload) {
      problems.push(
        'ПОЗИЦИЯ ИНЛАЙН-СКРИПТА: он не последний в <head> — после него идёт ' +
          `${laterScript ? '<script>' : ''}${laterScript && laterPreload ? ' и ' : ''}` +
          `${laterPreload ? '<link rel="preload">' : ''}. Пауза парсера обязана быть ` +
          'последним, что происходит в голове документа.'
      );
    }
  }

  return problems;
}

interface ScriptFinding {
  tag: string;
  blocking: boolean;
  thirdParty: boolean;
}

function checkRenderBlockingScripts(html: string): ScriptFinding[] {
  const scriptOpenTags = html.match(/<script\b[^>]*>/g) ?? [];
  const results: ScriptFinding[] = [];

  for (const tag of scriptOpenTags) {
    const srcMatch = tag.match(/\bsrc\s*=\s*["']([^"']*)["']/i);
    if (!srcMatch) continue;

    const isLdJson = /type="application\/ld\+json"/.test(tag);
    if (isLdJson) continue;

    const src = srcMatch[1].trim();
    const thirdParty = /^https?:\/\//i.test(src) || src.startsWith('//');

    const hasDefer = /\bdefer\b/.test(tag);
    const isModule = /type="module"/.test(tag);
    const blocking = !hasDefer && !isModule;
    results.push({ tag, blocking, thirdParty });
  }

  return results;
}

function main(): void {

  const targetArg = process.argv[2];
  const targetPath = targetArg ? path.resolve(process.cwd(), targetArg) : indexPath;

  if (!existsSync(targetPath)) {
    console.error(
      targetArg
        ? `FAIL: ${targetArg} does not exist — проверять нечего.`
        : 'FAIL: dist/index.html does not exist — run `npm run build` first.'
    );
    console.log('\n0 checks run, 1 failed (build output missing).');
    process.exit(1);
  }

  const scriptTargets: string[] = [];
  if (targetArg) {
    scriptTargets.push(targetPath);
  } else {
    collectHtml(distDir, scriptTargets);
  }
  const rel = (p: string): string => path.relative(projectRoot, p).replace(/\\/g, '/');

  let failCount = 0;

  let cssBackgrounds: CssBackgroundAnalysis | null = null;
  let cssBackgroundError: string | null = null;
  try {
    cssBackgrounds = analyzeCssBackgrounds(targetPath);
  } catch (err) {
    cssBackgroundError = (err as Error).message;
  }

  console.log(`--- Critical-path byte-weight budget (${rel(targetPath)}) ---`);
  try {
    const { findings, totalBytes, factOnly, factBytes, warnings, errors, notes } =
      measureCriticalPath(targetPath, cssBackgrounds);
    for (const f of findings) {
      console.log(`  ${f.label}: ${f.bytes} bytes`);
    }
    for (const n of notes) {
      console.log(`  ${n}`);
    }
    for (const w of warnings) {
      console.warn(`  WARN: ${w}`);
    }

    for (const e of errors) {
      console.error(`FAIL: ${e}`);
      failCount++;
    }
    const totalKb = (totalBytes / 1024).toFixed(2);
    const budgetKb = (CRITICAL_PATH_BUDGET_BYTES / 1024).toFixed(0);
    if (totalBytes > CRITICAL_PATH_BUDGET_BYTES) {
      console.error(`FAIL: critical-path subtotal ${totalKb}KB exceeds the ${budgetKb}KB budget.`);
      failCount++;
    } else {
      console.log(`PASS: critical-path subtotal ${totalKb}KB is within the ${budgetKb}KB budget.`);
    }

    console.log(`\n  --- фактически отдаваемые байты первого экрана ---`);
    for (const f of factOnly) {
      console.log(`  + ${f.label}: ${f.bytes} bytes`);
    }
    const factKb = (factBytes / 1024).toFixed(2);
    const deltaKb = ((factBytes - totalBytes) / 1024).toFixed(2);

    const lowerBound = warnings.some((w) => w.includes('sizes='));
    console.log(
      `  FACT: первый экран весит ${lowerBound ? 'НЕ МЕНЕЕ ' : ''}${factKb}KB ` +
        `(учётные ${totalKb}KB + ${deltaKb}KB, не входящие в порог: ленивые слои, ` +
        'пересекающие сгиб, и отложенный модуль).',
    );
    if (lowerBound) {
      console.log(
        '  FACT: это НИЖНЯЯ ГРАНИЦА — выше есть WARN о неразобранном sizes=, ' +
          'значит для части слоёв взят кандидат по ширине экрана и вес может быть занижен.',
      );
    }
    if (factBytes > TZ_FIRST_SCREEN_BYTES) {
      const overKb = ((factBytes - TZ_FIRST_SCREEN_BYTES) / 1024).toFixed(2);
      console.log(
        `  FACT: требование ТЗ «первый экран ≤${(TZ_FIRST_SCREEN_BYTES / 1024).toFixed(0)}KB» превышено на ${overKb}KB. ` +
          'Это ПРИНЯТАЯ заказчиком цена утверждённого дизайна (06.09.2026), а не дефект: ' +
          'опустить число можно только урезав облачную сцену или фотографию первого экрана.',
      );
    }
  } catch (err) {
    console.error(`FAIL: could not measure critical-path budget: ${(err as Error).message}`);
    failCount++;
  }

  console.log(`\n--- <script> assertions (${scriptTargets.length} страниц(а/ы)) ---`);
  try {
    let blockingCount = 0;
    let thirdPartyCount = 0;
    let externalTags = 0;
    for (const file of scriptTargets) {
      const html = readFileSync(file, 'utf8');
      const scripts = checkRenderBlockingScripts(html);
      externalTags += scripts.length;
      for (const s of scripts.filter((x) => x.blocking)) {
        console.error(
          `FAIL: ${rel(file)}: render-blocking <script src> (нет ни defer, ни type="module"): ${s.tag}`
        );
        blockingCount++;
      }
      for (const s of scripts.filter((x) => x.thirdParty)) {
        console.error(
          `FAIL: ${rel(file)}: СТОРОННИЙ SCRIPT SRC в собранном HTML: ${s.tag}\n` +
            '  Провайдеры этого проекта грузятся динамическим импортом из отложенного модуля ' +
            '(§9.2). Тег на чужой origin означает, что механизм обошли.'
        );
        thirdPartyCount++;
      }
    }
    if (blockingCount > 0) failCount++;
    if (thirdPartyCount > 0) failCount++;
    if (blockingCount === 0 && thirdPartyCount === 0) {
      console.log(
        `PASS: 0 блокирующих и 0 сторонних <script src> (проверено ${externalTags} тег(ов) с src).`
      );
    }
  } catch (err) {
    console.error(`FAIL: could not check <script src> tags: ${(err as Error).message}`);
    failCount++;
  }

  console.log(`\n--- Инлайн-скрипты в <head> (${scriptTargets.length} страниц(а/ы)) ---`);
  try {
    let inlineProblems = 0;
    let inlineTotal = 0;
    for (const file of scriptTargets) {
      const html = readFileSync(file, 'utf8');
      const head = extractHead(html);
      inlineTotal += head === null ? 0 : collectInlineHeadScripts(head).length;
      for (const problem of checkInlineHeadScripts(html)) {
        console.error(`FAIL: ${rel(file)}: ${problem}`);
        inlineProblems++;
      }
    }
    if (inlineProblems > 0) {
      failCount++;
    } else {
      console.log(
        `PASS: ${inlineTotal} исполняемых инлайн-скрипт(ов) в <head>, ` +
          `все в пределах ${MAX_INLINE_HEAD_SCRIPTS} шт., ${INLINE_HEAD_SCRIPT_MAX_BYTES} Б и позиции после preload шрифта.`
      );
    }
  } catch (err) {
    console.error(`FAIL: could not check inline <head> scripts: ${(err as Error).message}`);
    failCount++;
  }

  console.log('\n--- Растровые url() в CSS: любое свойство, включая mask-image ---');
  if (cssBackgroundError !== null) {
    console.error(`FAIL: не удалось разобрать CSS страницы: ${cssBackgroundError}`);
    failCount++;
  } else if (cssBackgrounds !== null) {
    for (const line of cssBackgrounds.report) console.log(`  ${line}`);
    for (const w of cssBackgrounds.warnings) console.warn(`  WARN: ${w}`);
    if (cssBackgrounds.problems.length > 0) {
      for (const p of cssBackgrounds.problems) console.error(`FAIL: ${rel(targetPath)}: ${p}`);
      failCount++;
    } else {
      console.log(
        'PASS: растровых url() в правилах первого экрана нет; ' +
          'градиенты и url("data:…") под проверку не попадают.'
      );
    }
  }

  console.log('\n--- <picture> fallback assertion ---');
  try {
    const html = readFileSync(targetPath, 'utf8');
    const problems = checkPictureFallbacks(html);
    if (problems.length > 0) {
      console.error(`FAIL: ${problems.length} проблем(а) с fallback внутри <picture>:`);
      for (const p of problems) console.error(`  - ${p}`);
      failCount++;
    } else {
      console.log('PASS: у каждого <picture> есть ограниченный растровый fallback.');
    }
  } catch (err) {
    console.error(`FAIL: could not check <picture> fallbacks: ${(err as Error).message}`);
    failCount++;
  }

  console.log(`\n${failCount === 0 ? 'All checks passed.' : `${failCount} check(s) failed.`}`);
  if (failCount > 0) process.exit(1);
}

main();
