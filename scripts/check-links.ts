
import { readdirSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');

const argv = process.argv.slice(2);

function argValue(flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at !== -1 ? argv[at + 1] : undefined;
}

function resolveArg(value: string | undefined, fallback: string): string {
  if (!value) return path.join(projectRoot, fallback);
  return path.isAbsolute(value) ? value : path.join(projectRoot, value);
}

const distDir = resolveArg(argValue('--dist'), 'dist');
const manifestFile = resolveArg(argValue('--manifest'), path.join('docs', 'external-links.md'));
const updateManifest = argv.includes('--update-manifest');

const distLabel = path.relative(projectRoot, distDir).replace(/\\/g, '/') || 'dist';
const manifestLabel = path.relative(projectRoot, manifestFile).replace(/\\/g, '/');

const MARK_NO_BUILD = 'СБОРКИ НЕТ';
const MARK_EMPTY = 'ОБХОД ПУСТ';
const MARK_TARGET = 'ЦЕЛЬ НЕ НАЙДЕНА';
const MARK_ANCHOR = 'ЯКОРЬ НЕ НАЙДЕН';
const MARK_SITEMAP = 'КАРТА САЙТА ВРЁТ';
const MARK_ORIGIN_NEW = 'ОРИГЕН НЕ ЗАЯВЛЕН';
const MARK_ORIGIN_DEAD = 'МЁРТВАЯ СТРОКА МАНИФЕСТА';
const MARK_ORIGIN_BLANK = 'СТРОКА МАНИФЕСТА НЕ ЗАПОЛНЕНА';
const MARK_MANIFEST = 'МАНИФЕСТ НЕ РАЗОБРАН';

const EXCLUDED_EXACT: Record<string, string> = {
  '/api/lead': 'Pages Function — в dist/ её нет и не будет (functions/api/lead.ts)',
  '/api/health': 'Pages Function — в dist/ её нет и не будет',
  '#': 'пустой якорь-заглушка: цели у него нет по определению',
};

const EXCLUDED_PREFIX: Record<string, string> = {
  '/cdn-cgi/': 'граница Cloudflare — файлы отдаёт платформа, в сборке их нет',
  '/api/': 'Pages Functions — каталог functions/, а не dist/',
};

const EXCLUDED_SCHEME: Record<string, string> = {
  'mailto:': 'почтовый адрес, а не ресурс сборки',
  'tel:': 'телефонный номер, а не ресурс сборки',
  'data:': 'встроенные данные — цель находится в самом адресе',
  'javascript:': 'не адрес ресурса',
  'blob:': 'адрес рантайма, во время сборки не существует',
};

interface Failure {
  mark: string;
  line: string;
  detail: string;
}

const failures: Failure[] = [];

function fail(mark: string, line: string, detail: string): void {
  failures.push({ mark, line, detail });
  console.error(line);
  console.error(`    - ${detail} (${mark})`);
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

const readCache = new Map<string, string>();

function readDoc(rel: string): string {
  const cached = readCache.get(rel);
  if (cached !== undefined) return cached;
  const text = readFileSync(path.join(distDir, rel), 'utf8');
  readCache.set(rel, text);
  return text;
}

const idCache = new Map<string, Set<string>>();

function idsOf(rel: string): Set<string> {
  const cached = idCache.get(rel);
  if (cached) return cached;
  const html = readDoc(rel);
  const ids = new Set<string>();
  for (const m of html.matchAll(/(?<![\w-])id="([^"]+)"/g)) ids.add(m[1]);

  for (const tag of html.matchAll(/<a\b[^>]*>/gi)) {
    const name = tag[0].match(/(?<![\w-])name="([^"]+)"/);
    if (name) ids.add(name[1]);
  }
  idCache.set(rel, ids);
  return ids;
}

interface Address {

  from: string;

  raw: string;

  place: string;
}

const TAG_ATTRS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['a', ['href']],
  ['link', ['href']],
  ['script', ['src']],

  ['img', ['src', 'srcset']],
  ['source', ['src', 'srcset']],
  ['form', ['action']],
];

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

function collectAddresses(rel: string): Address[] {
  const html = readDoc(rel);
  const out: Address[] = [];

  for (const [tag, attrs] of TAG_ATTRS) {
    for (const match of html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'gi'))) {
      for (const attr of attrs) {
        const value = attrValue(match[0], attr);
        if (value === undefined || value.trim() === '') continue;
        const urls = attr === 'srcset' ? srcsetUrls(value) : [value.trim()];
        for (const url of urls) out.push({ from: rel, raw: url, place: `<${tag} ${attr}>` });
      }
    }
  }

  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const property = attrValue(match[0], 'property');
    if (property !== 'og:image' && property !== 'og:url') continue;
    const content = attrValue(match[0], 'content');
    if (content && content.trim() !== '') {
      out.push({ from: rel, raw: content.trim(), place: `<meta ${property}>` });
    }
  }

  return out;
}

function routeOf(rel: string): string {
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return `/${rel.slice(0, -'index.html'.length)}`;
  return `/${rel}`;
}

interface Resolved {

  file: string | null;

  tried: string[];
}

function existsFile(rel: string): boolean {
  const abs = path.join(distDir, rel);
  return existsSync(abs) && statSync(abs).isFile();
}

function resolveInternal(pathname: string): Resolved {
  let clean = pathname;
  try {
    clean = decodeURIComponent(pathname);
  } catch {
    clean = pathname;
  }
  const rel = clean.replace(/^\/+/, '');
  if (rel === '') {
    return { file: existsFile('index.html') ? 'index.html' : null, tried: ['index.html'] };
  }

  const tried: string[] = [];
  if (clean.endsWith('/')) {
    const candidate = `${rel}index.html`;
    tried.push(candidate);
    return { file: existsFile(candidate) ? candidate : null, tried };
  }

  if (path.extname(rel) !== '') {
    tried.push(rel);
    return { file: existsFile(rel) ? rel : null, tried };
  }
  for (const candidate of [`${rel}.html`, `${rel}/index.html`]) {
    tried.push(candidate);
    if (existsFile(candidate)) return { file: candidate, tried };
  }
  return { file: null, tried };
}

function siteOriginFromBuild(): string | null {
  if (!existsFile('index.html')) return null;
  const canonical = readDoc('index.html').match(/<link[^>]*rel="canonical"[^>]*>/i);
  const href = canonical?.[0].match(/href="([^"]+)"/)?.[1];
  if (!href) return null;
  try {
    return new URL(href).origin;
  } catch {
    return null;
  }
}

type Sverka = 'строгая' | 'появление';

interface ManifestRow {
  origin: string;
  sverka: Sverka;
  why: string;
  owner: string;
  where: string;
}

const MANIFEST_HEADER = '| Ориген | Сверка | Зачем | Кто владелец | Где встречается |';
const MANIFEST_RULER = '| --- | --- | --- | --- | --- |';
const BLANK_CELL = '—';

function parseManifest(text: string): ManifestRow[] {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === MANIFEST_HEADER);
  if (at === -1) return [];
  const rows: ManifestRow[] = [];
  for (let i = at + 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) break;
    const cells = line.slice(1, -1).split('|').map((c) => c.trim());
    if (cells.length < 5) continue;
    rows.push({
      origin: cells[0].replace(/`/g, '').trim(),
      sverka: cells[1] === 'появление' ? 'появление' : 'строгая',
      why: cells[2],
      owner: cells[3],
      where: cells[4],
    });
  }
  return rows;
}

function renderManifest(previous: string, rows: ManifestRow[]): string {
  const lines = previous.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === MANIFEST_HEADER);
  if (at === -1) throw new Error(`в ${manifestLabel} нет таблицы манифеста`);
  let end = at + 2;
  while (end < lines.length && lines[end].trim().startsWith('|')) end++;
  const table = [
    MANIFEST_HEADER,
    MANIFEST_RULER,
    ...rows
      .slice()
      .sort((a, b) => a.origin.localeCompare(b.origin))
      .map((r) => `| \`${r.origin}\` | ${r.sverka} | ${r.why} | ${r.owner} | ${r.where} |`),
  ];
  return [...lines.slice(0, at), ...table, ...lines.slice(end)].join('\n');
}

interface Counters {
  docs: number;
  addresses: number;
  internal: number;
  anchors: number;
  externalRefs: number;
  excluded: number;
  sitemapLocs: number;
}

const counters: Counters = {
  docs: 0,
  addresses: 0,
  internal: 0,
  anchors: 0,
  externalRefs: 0,
  excluded: 0,
  sitemapLocs: 0,
};

const originsHtml = new Set<string>();
const originsAsset = new Set<string>();

function sweepOrigins(text: string, into: Set<string>): void {
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\\]+/g)) {
    try {
      into.add(new URL(m[0]).origin);
    } catch {
      /* */
    }
  }
}

interface Verdict {
  internal: boolean;
  anchor: boolean;
  failed: boolean;
}

const CLEAN: Verdict = { internal: false, anchor: false, failed: false };

function checkAddress(address: Address, siteOrigin: string): Verdict {
  const { from, raw, place } = address;
  const line = `  FAIL [ссылка] ${distLabel}/${from} → ${raw}`;

  if (EXCLUDED_EXACT[raw] !== undefined) {
    counters.excluded++;
    return CLEAN;
  }
  for (const scheme of Object.keys(EXCLUDED_SCHEME)) {
    if (raw.toLowerCase().startsWith(scheme)) {
      counters.excluded++;
      return CLEAN;
    }
  }

  let pathname: string;
  let fragment: string;

  if (/^(?:https?:)?\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
    } catch {
      fail(MARK_TARGET, line, `адрес не разбирается как URL ${place}`);
      return { internal: false, anchor: false, failed: true };
    }
    if (url.origin !== siteOrigin) {
      counters.externalRefs++;
      return CLEAN;
    }

    pathname = url.pathname;
    fragment = url.hash.slice(1);
  } else if (raw.startsWith('#')) {
    pathname = routeOf(from);
    fragment = raw.slice(1);
  } else {
    const [beforeHash, ...rest] = raw.split('#');
    fragment = rest.join('#');
    const withoutQuery = beforeHash.split('?')[0];
    pathname = withoutQuery.startsWith('/')
      ? withoutQuery
      : path.posix.resolve(path.posix.dirname(`/${from}`), withoutQuery);
  }

  for (const prefix of Object.keys(EXCLUDED_PREFIX)) {
    if (pathname.startsWith(prefix)) {
      counters.excluded++;
      return CLEAN;
    }
  }
  if (EXCLUDED_EXACT[pathname] !== undefined) {
    counters.excluded++;
    return CLEAN;
  }

  const resolved = resolveInternal(pathname);
  const searched = resolved.tried.map((t) => `${distLabel}/${t}`).join(' и ');
  if (resolved.file === null) {
    fail(MARK_TARGET, line, `цель не существует: искали ${searched} ${place}`);
    return { internal: true, anchor: fragment !== '', failed: true };
  }

  if (fragment === '') return { internal: true, anchor: false, failed: false };

  let frag = fragment;
  try {
    frag = decodeURIComponent(fragment);
  } catch {
    frag = fragment;
  }
  if (!idsOf(resolved.file).has(frag)) {
    fail(MARK_ANCHOR, line, `в ${distLabel}/${resolved.file} нет элемента с id="${frag}" ${place}`);
    return { internal: true, anchor: true, failed: true };
  }
  return { internal: true, anchor: true, failed: false };
}

function locsOf(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

function isNoindex(doc: string): boolean {
  return /<meta[^>]*name="robots"[^>]*content="[^"]*noindex[^"]*"[^>]*>/i.test(readDoc(doc));
}

function checkSitemap(docs: string[], siteOrigin: string): void {
  const maps = walk(distDir, (n) => /^sitemap.*\.xml$/.test(n));
  if (maps.length === 0) {
    fail(MARK_SITEMAP, `FAIL [карта] ${distLabel}`, 'нет ни одного sitemap*.xml — карта не собрана');
    return;
  }

  const pageRoutes = new Set<string>();
  for (const map of maps.slice().sort()) {
    const locs = locsOf(readFileSync(path.join(distDir, map), 'utf8'));
    let bad = 0;
    for (const loc of locs) {
      counters.sitemapLocs++;
      const line = `  FAIL [карта] ${distLabel}/${map} → ${loc}`;
      let url: URL;
      try {
        url = new URL(loc);
      } catch {
        fail(MARK_SITEMAP, line, 'адрес не разбирается как URL');
        bad++;
        continue;
      }
      if (url.origin !== siteOrigin) {
        fail(MARK_SITEMAP, line, `чужой ориген: ожидался ${siteOrigin}`);
        bad++;
        continue;
      }
      const resolved = resolveInternal(url.pathname);
      if (resolved.file === null) {
        const searched = resolved.tried.map((t) => `${distLabel}/${t}`).join(' и ');
        fail(MARK_SITEMAP, line, `цель не существует: искали ${searched}`);
        bad++;
        continue;
      }
      if (!resolved.file.endsWith('.html')) continue;
      pageRoutes.add(routeOf(resolved.file));
      if (isNoindex(resolved.file)) {
        fail(
          MARK_SITEMAP,
          line,
          `страница помечена noindex и в карте быть не должна (${distLabel}/${resolved.file})`,
        );
        bad++;
      }
    }
    const shape = `записей ${locs.length}`;
    if (bad === 0) console.log(`PASS [карта] ${distLabel}/${map} — ${shape}`);
    else console.error(`FAIL [карта] ${distLabel}/${map} — ${shape}, битых ${bad}`);
  }

  for (const doc of docs) {
    if (isNoindex(doc)) continue;
    const route = routeOf(doc);
    if (!pageRoutes.has(route)) {
      fail(
        MARK_SITEMAP,
        `  FAIL [карта] ${distLabel}/${doc}`,
        `индексируемая страница ${route} не встречается ни в одной sitemap*.xml`,
      );
    }
  }

  if (!existsFile('robots.txt')) return;
  const robots = readFileSync(path.join(distDir, 'robots.txt'), 'utf8');
  for (const m of robots.matchAll(/^[ \t]*Sitemap:[ \t]*(\S+)[ \t]*$/gim)) {
    counters.sitemapLocs++;
    let resolved: Resolved;
    try {
      resolved = resolveInternal(new URL(m[1]).pathname);
    } catch {
      resolved = { file: null, tried: [m[1]] };
    }
    if (resolved.file === null) {
      fail(
        MARK_SITEMAP,
        `  FAIL [карта] ${distLabel}/robots.txt → ${m[1]}`,
        `карта, объявленная в robots.txt, не существует: искали ${resolved.tried.join(' и ')}`,
      );
    }
  }
}

function checkManifest(): void {
  if (!existsSync(manifestFile)) {
    fail(
      MARK_MANIFEST,
      `FAIL [манифест] ${manifestLabel}`,
      'файла нет — создайте манифест или запустите гейт с --update-manifest',
    );
    return;
  }
  const text = readFileSync(manifestFile, 'utf8');
  const rows = parseManifest(text);
  if (rows.length === 0 && !updateManifest) {
    fail(MARK_MANIFEST, `FAIL [манифест] ${manifestLabel}`, 'таблица не найдена или пуста');
    return;
  }

  if (updateManifest) {
    const known = new Map(rows.map((r) => [r.origin, r]));
    const keep = (origin: string, sverka: Sverka): ManifestRow => {
      const old = known.get(origin);
      return {
        origin,
        sverka,
        why: old?.why ?? BLANK_CELL,
        owner: old?.owner ?? BLANK_CELL,
        where: old?.where ?? BLANK_CELL,
      };
    };
    const next = [
      ...[...originsHtml].sort().map((o) => keep(o, 'строгая')),
      ...[...originsAsset].sort().map((o) => keep(o, 'появление')),
    ];
    writeFileSync(manifestFile, renderManifest(text, next), 'utf8');
    console.log(
      `\nМанифест ${manifestLabel} перезаписан: строк ${next.length} ` +
        `(строгих ${originsHtml.size}, по появлению ${originsAsset.size}). ` +
        'Колонки «Зачем» и «Кто владелец» заполняются человеком — прочерк валит гейт.',
    );
    return;
  }

  const before = failures.length;
  const declared = new Map(rows.map((r) => [r.origin, r]));

  for (const origin of [...originsHtml].sort()) {
    if (declared.has(origin)) continue;
    fail(
      MARK_ORIGIN_NEW,
      `  FAIL [ориген] ${origin}`,
      `встречается в разметке, но не заявлен в ${manifestLabel} — заполните строку или уберите хост`,
    );
  }
  for (const origin of [...originsAsset].sort()) {
    if (declared.has(origin)) continue;
    fail(
      MARK_ORIGIN_NEW,
      `  FAIL [ориген] ${origin}`,
      `встречается в чанке сборки, но не заявлен в ${manifestLabel}`,
    );
  }
  for (const row of rows) {
    if (row.sverka === 'строгая' && !originsHtml.has(row.origin)) {
      fail(
        MARK_ORIGIN_DEAD,
        `  FAIL [ориген] ${row.origin}`,
        `заявлен со сверкой «строгая», но в разметке не встречается — мёртвая строка манифеста лжёт так же, как мёртвая ссылка`,
      );
    }
    if (row.why === BLANK_CELL || row.why === '' || row.owner === BLANK_CELL || row.owner === '') {
      fail(
        MARK_ORIGIN_BLANK,
        `  FAIL [ориген] ${row.origin}`,
        'не заполнены «Зачем» и/или «Кто владелец» — сторонний хост без объяснения остаётся неизвестным каналом',
      );
    }
  }

  const bad = failures.length - before;
  const shape = `оригенов в разметке ${originsHtml.size}, только в чанках ${originsAsset.size}, строк ${rows.length}`;
  if (bad === 0) console.log(`PASS [манифест] ${manifestLabel} — ${shape}`);
  else console.error(`FAIL [манифест] ${manifestLabel} — ${shape}, расхождений ${bad}`);
}

function main(): void {
  if (!existsSync(distDir)) {
    fail(MARK_NO_BUILD, `FAIL [сборка] ${distLabel}`, 'каталога нет — сначала npm run build');
    return report();
  }

  const docs = walk(distDir, (n) => n.endsWith('.html')).sort();
  if (docs.length === 0) {
    fail(
      MARK_EMPTY,
      `FAIL [сборка] ${distLabel}`,
      'ни одного .html — сборка пуста или идёт прямо сейчас',
    );
    return report();
  }

  const siteOrigin = siteOriginFromBuild();
  if (siteOrigin === null) {
    fail(
      MARK_NO_BUILD,
      `FAIL [сборка] ${distLabel}/index.html`,
      'не нашли rel="canonical" с разбираемым href — неоткуда взять ориген самого сайта',
    );
    return report();
  }

  for (const doc of docs) {
    counters.docs++;
    sweepOrigins(readDoc(doc), originsHtml);

    const addresses = collectAddresses(doc);
    let docFails = 0;
    let docInternal = 0;
    let docAnchors = 0;
    for (const address of addresses) {
      counters.addresses++;
      const verdict = checkAddress(address, siteOrigin);
      if (verdict.internal) docInternal++;
      if (verdict.anchor) docAnchors++;
      if (verdict.failed) docFails++;
    }
    counters.internal += docInternal;
    counters.anchors += docAnchors;

    const shape = `адресов ${addresses.length}, внутренних ${docInternal}, якорей ${docAnchors}`;
    if (docFails === 0) console.log(`PASS [документ] ${distLabel}/${doc} — ${shape}`);
    else console.error(`FAIL [документ] ${distLabel}/${doc} — ${shape}, битых ${docFails}`);
  }

  checkSitemap(docs, siteOrigin);

  for (const asset of walk(distDir, (n) => /\.(?:js|mjs|css)$/.test(n))) {
    sweepOrigins(readFileSync(path.join(distDir, asset), 'utf8'), originsAsset);
  }
  originsHtml.delete(siteOrigin);
  originsAsset.delete(siteOrigin);
  for (const seen of originsHtml) originsAsset.delete(seen);
  checkManifest();

  if (counters.addresses === 0) {
    fail(MARK_EMPTY, 'FAIL [обход] адреса', 'в документах не найдено ни одного адреса — разбор тегов сломан');
  }
  if (counters.internal === 0) {
    fail(MARK_EMPTY, 'FAIL [обход] внутренние', 'ни одного внутреннего адреса — перелинковка исчезла или разбор сломан');
  }
  if (counters.anchors === 0) {
    fail(MARK_EMPTY, 'FAIL [обход] якоря', 'ни одного якоря — навигация по секциям исчезла или разбор сломан');
  }
  if (originsHtml.size === 0) {
    fail(MARK_EMPTY, 'FAIL [обход] внешние', 'ни одного внешнего оригена — контакты со страницы исчезли или разбор сломан');
  }

  report();
}

function report(): void {
  console.log(
    `\nОсмотрено документов: ${counters.docs}. ` +
      `Адресов всего: ${counters.addresses} ` +
      `(внутренних ${counters.internal}, внешних ссылок ${counters.externalRefs}, ` +
      `исключений по правилу ${counters.excluded}). ` +
      `Якорей проверено: ${counters.anchors}. ` +
      `Внешних оригенов: ${originsHtml.size} в разметке + ${originsAsset.size} только в чанках. ` +
      `Записей карты сайта: ${counters.sitemapLocs}. ` +
      `Нарушений: ${failures.length}.`,
  );
  if (failures.length > 0) process.exit(1);
}

main();
