
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const FETCH_DIRECTIVES = [
  'script-src',
  'style-src',
  'img-src',
  'font-src',
  'connect-src',
  'frame-src',
  'media-src',
  'manifest-src',
] as const;

export type FetchDirective = (typeof FETCH_DIRECTIVES)[number];

export interface OriginDecision {
  directives: readonly FetchDirective[];
  why: string;
}

const NAVIGATION_ONLY = 'переход по ссылке; CSP навигацию не ограничивает (navigate-to изъят из спецификации)';

export const ORIGIN_POLICY: Readonly<Record<string, OriginDecision>> = {

  'http://www.w3.org': {
    directives: [],
    why: 'пространство имён SVG в атрибуте xmlns — браузер этот адрес не запрашивает никогда',
  },
  'https://schema.org': {
    directives: [],
    why: 'словарь JSON-LD в @context — читает робот поисковика, браузер туда не ходит',
  },

  'https://t.me': { directives: [], why: NAVIGATION_ONLY },
  'https://m.me': { directives: [], why: NAVIGATION_ONLY },
  'https://facebook.com': { directives: [], why: NAVIGATION_ONLY },
  'https://www.instagram.com': { directives: [], why: NAVIGATION_ONLY },

  'https://challenges.cloudflare.com': {
    directives: ['script-src', 'frame-src', 'connect-src'],
    why:
      'Turnstile (SEC-01): загрузчик api.js — script-src, сам виджет живёт в <iframe> — frame-src, ' +
      'обмен челленджа — connect-src. ⚠️ В ЛОКАЛЬНОЙ сборке этого оригена НЕТ (пустой ' +
      'PUBLIC_TURNSTILE_SITEKEY), в CI и в проде — есть; ровно ради этого политика собирается ' +
      'из манифеста, а не из dist/',
  },
  'https://www.googletagmanager.com': {
    directives: ['script-src', 'connect-src', 'img-src'],
    why:
      'GA4: gtag.js — script-src; отправка событий и загрузка конфигурации назначения — connect-src; ' +
      'запасной путь отправки пикселем — img-src. Живёт в отложенном чанке providers.js, который ' +
      'сборщик вырезает целиком при пустом PUBLIC_GA_ID',
  },
  'https://www.clarity.ms': {
    directives: ['script-src', 'connect-src'],
    why:
      'Microsoft Clarity: тег /tag/<id> — script-src, выгрузка сессии — connect-src. Тот же ' +
      'env-условный чанк providers.js',
  },
};

export const COMPANION_SOURCES: ReadonlyArray<{
  source: string;
  directives: readonly FetchDirective[];
  why: string;
}> = [
  {
    source: 'https://www.google-analytics.com',
    directives: ['connect-src', 'img-src'],
    why: 'точка приёма GA4 (/g/collect и пиксель-фоллбек); в нашем коде не упоминается — её знает gtag.js',
  },
  {
    source: 'https://region1.google-analytics.com',
    directives: ['connect-src'],
    why: 'региональная точка приёма GA4 для трафика ЕЭЗ; gtag.js выбирает её сам, в коде её нет',
  },
  {
    source: 'https://*.clarity.ms',
    directives: ['connect-src'],
    why:
      'Clarity выгружает записи сессии на поддомен, выбранный сервером (c.clarity.ms, e.clarity.ms, …); ' +
      'имени поддомена в нашем коде нет и быть не может',
  },
];

export const BASE_DIRECTIVES: ReadonlyArray<readonly [string, string]> = [

  ['default-src', "'self'"],

  ['base-uri', "'none'"],
  ['object-src', "'none'"],

  ['frame-ancestors', "'none'"],

  ['form-action', "'self'"],
];

export const REQUIRED_DIRECTIVES = [
  'default-src',
  'base-uri',
  'object-src',
  'frame-ancestors',
  'form-action',
  'script-src',
  'style-src',
  'connect-src',
  'report-uri',
] as const;

export const REPORT_PATH = '/api/csp-report';

export const REPORT_ONLY_HEADER = 'Content-Security-Policy-Report-Only';

export const ENFORCE_HEADER = 'Content-Security-Policy';

const MANIFEST_HEADER = '| Ориген | Сверка | Зачем | Кто владелец | Где встречается |';

export function readManifestOrigins(manifestFile: string): string[] {
  const lines = readFileSync(manifestFile, 'utf8').split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === MANIFEST_HEADER);
  if (at === -1) return [];
  const origins: string[] = [];
  for (let i = at + 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) break;
    const cells = line.slice(1, -1).split('|').map((c) => c.trim());
    if (cells.length < 5) continue;
    const origin = cells[0].replace(/`/g, '').trim();
    if (origin !== '') origins.push(origin);
  }
  return origins;
}

export function crossCheckManifest(manifestOrigins: readonly string[]): string[] {
  const problems: string[] = [];
  const declared = new Set(Object.keys(ORIGIN_POLICY));
  for (const origin of manifestOrigins) {
    if (!declared.has(origin)) {
      problems.push(
        `ОРИГЕН БЕЗ РЕШЕНИЯ О CSP: ${origin} заявлен в манифесте внешних оригенов, ` +
          'но в ORIGIN_POLICY (scripts/lib/csp-sources.ts) решения о нём нет — ' +
          'укажите директивы или объясните, почему их не нужно',
      );
    }
  }
  const inManifest = new Set(manifestOrigins);
  for (const origin of declared) {
    if (!inManifest.has(origin)) {
      problems.push(
        `МЁРТВОЕ РЕШЕНИЕ О CSP: ${origin} описан в ORIGIN_POLICY, но в манифесте ` +
          'внешних оригенов его нет — уберите строку или верните хост в манифест',
      );
    }
  }
  return problems;
}

export interface InlineBlock {

  hash: string;

  bytes: number;

  files: string[];
}

export interface OriginUse {
  origin: string;

  directive: FetchDirective | null;

  place: string;

  from: string;
}

export interface BuildScan {

  docs: string[];

  siteOrigin: string | null;

  inlineScripts: InlineBlock[];

  inlineStyles: InlineBlock[];

  styleAttrs: { file: string; count: number }[];

  uses: OriginUse[];

  assets: number;
}

function walk(dir: string, keep: (name: string) => boolean, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...walk(path.join(dir, entry.name), keep, rel));
    else if (keep(entry.name)) found.push(rel);
  }
  return found;
}

function sha256Base64(body: string): string {
  return `sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`;
}

function attrValue(tag: string, attr: string): string | undefined {

  const m = tag.match(new RegExp(`(?<![\\w-])${attr}="([^"]*)"`, 'i'));
  return m ? m[1] : undefined;
}

function srcsetUrls(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter((url) => url.length > 0);
}

function directiveFor(tag: string, attr: string, openTag: string): FetchDirective | null {
  if (tag === 'script') return 'script-src';
  if (tag === 'img' || tag === 'source') return 'img-src';
  if (tag === 'iframe' || tag === 'frame') return 'frame-src';
  if (tag === 'video' || tag === 'audio') return 'media-src';
  if (tag === 'a' || tag === 'area') return null;
  if (tag === 'form' && attr === 'action') return null;
  if (tag === 'link') {
    const rel = (attrValue(openTag, 'rel') ?? '').toLowerCase();
    if (rel.includes('stylesheet')) return 'style-src';
    if (rel.includes('manifest')) return 'manifest-src';
    if (rel.includes('icon') || rel.includes('apple-touch')) return 'img-src';

    const as = (attrValue(openTag, 'as') ?? '').toLowerCase();
    if (as === 'font') return 'font-src';
    if (as === 'style') return 'style-src';
    if (as === 'script') return 'script-src';
    if (as === 'image') return 'img-src';
    return null;
  }
  return null;
}

const TAG_ATTRS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['script', ['src']],
  ['link', ['href']],
  ['img', ['src', 'srcset']],
  ['source', ['src', 'srcset']],
  ['iframe', ['src']],
  ['video', ['src', 'poster']],
  ['audio', ['src']],
  ['a', ['href']],
  ['form', ['action']],
];

function originOf(raw: string): string | null {
  if (!/^https?:\/\//i.test(raw.trim())) return null;
  try {
    return new URL(raw.trim()).origin;
  } catch {
    return null;
  }
}

export function scanBuild(distDir: string): BuildScan {
  const docs = walk(distDir, (n) => n.endsWith('.html')).sort();
  const scriptMap = new Map<string, InlineBlock>();
  const styleMap = new Map<string, InlineBlock>();
  const styleAttrs: { file: string; count: number }[] = [];
  const uses: OriginUse[] = [];
  let siteOrigin: string | null = null;

  for (const doc of docs) {
    const raw = readFileSync(path.join(distDir, doc), 'utf8');
    const html = raw.replace(/<!--[\s\S]*?-->/g, ' ');

    if (doc === 'index.html') {
      const canonical = html.match(/<link[^>]*rel="canonical"[^>]*>/i);
      const href = canonical?.[0].match(/href="([^"]+)"/)?.[1];
      if (href !== undefined) siteOrigin = originOf(href);
    }

    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      if (/(?<![\w-])src\s*=/i.test(m[1])) continue;
      if (/(?<![\w-])type\s*=/i.test(m[1])) continue;
      const hash = sha256Base64(m[2]);
      const found = scriptMap.get(hash);
      if (found) found.files.push(doc);
      else scriptMap.set(hash, { hash, bytes: Buffer.byteLength(m[2], 'utf8'), files: [doc] });
    }

    for (const m of html.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi)) {
      const hash = sha256Base64(m[2]);
      const found = styleMap.get(hash);
      if (found) found.files.push(doc);
      else styleMap.set(hash, { hash, bytes: Buffer.byteLength(m[2], 'utf8'), files: [doc] });
    }

    const attrs = [...html.matchAll(/(?<![\w-])style="[^"]*"/g)];
    if (attrs.length > 0) styleAttrs.push({ file: doc, count: attrs.length });

    for (const [tag, attrNames] of TAG_ATTRS) {
      for (const match of html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'gi'))) {
        for (const attr of attrNames) {
          const value = attrValue(match[0], attr);
          if (value === undefined || value.trim() === '') continue;
          for (const url of attr === 'srcset' ? srcsetUrls(value) : [value.trim()]) {
            const origin = originOf(url);
            if (origin === null) continue;
            uses.push({
              origin,
              directive: directiveFor(tag, attr, match[0]),
              place: `<${tag} ${attr}>`,
              from: doc,
            });
          }
        }
      }
    }
  }

  const assets = walk(distDir, (n) => /\.(?:js|mjs|css)$/.test(n));
  for (const asset of assets) {
    const text = readFileSync(path.join(distDir, asset), 'utf8');
    for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\\`]+/g)) {
      const origin = originOf(m[0]);
      if (origin === null) continue;
      uses.push({ origin, directive: null, place: 'чанк сборки', from: asset });
    }
  }

  return {
    docs,
    siteOrigin,
    inlineScripts: [...scriptMap.values()].sort((a, b) => a.hash.localeCompare(b.hash)),
    inlineStyles: [...styleMap.values()].sort((a, b) => a.hash.localeCompare(b.hash)),
    styleAttrs,
    uses,
    assets: assets.length,
  };
}

export interface Policy {

  directives: Map<string, string[]>;

  value: string;
}

export function buildPolicy(input: {
  scriptHashes: readonly string[];
  styleHashes: readonly string[];
  manifestOrigins: readonly string[];
  styleAttrsFound: number;
}): Policy {
  const byDirective = new Map<string, string[]>();
  const add = (directive: string, value: string): void => {
    const list = byDirective.get(directive) ?? [];
    if (!list.includes(value)) list.push(value);
    byDirective.set(directive, list);
  };

  for (const [name, value] of BASE_DIRECTIVES) add(name, value);

  for (const directive of ['script-src', 'style-src', 'img-src', 'font-src', 'connect-src'] as const) {
    add(directive, "'self'");
  }

  for (const hash of input.scriptHashes) add('script-src', `'${hash}'`);
  for (const hash of input.styleHashes) add('style-src', `'${hash}'`);

  for (const origin of [...input.manifestOrigins].sort()) {
    const decision = ORIGIN_POLICY[origin];
    if (decision === undefined) continue;
    for (const directive of decision.directives) add(directive, origin);
  }
  for (const companion of COMPANION_SOURCES) {
    for (const directive of companion.directives) add(directive, companion.source);
  }

  if (input.styleAttrsFound > 0) add('style-src-attr', "'unsafe-inline'");

  add('report-uri', REPORT_PATH);

  const order = [
    'default-src',
    'base-uri',
    'object-src',
    'frame-ancestors',
    'form-action',
    'script-src',
    'style-src',
    'style-src-attr',
    'img-src',
    'font-src',
    'connect-src',
    'frame-src',
    'media-src',
    'manifest-src',
    'report-uri',
  ];
  const ordered = new Map<string, string[]>();
  for (const name of order) {
    const values = byDirective.get(name);
    if (values !== undefined) ordered.set(name, values);
  }
  for (const [name, values] of byDirective) if (!ordered.has(name)) ordered.set(name, values);

  const value = [...ordered]
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');

  return { directives: ordered, value };
}

export function parsePolicy(value: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of value.split(';')) {
    const tokens = part.trim().split(/\s+/).filter((t) => t !== '');
    if (tokens.length === 0) continue;
    out.set(tokens[0].toLowerCase(), tokens.slice(1));
  }
  return out;
}

export function isDir(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}
