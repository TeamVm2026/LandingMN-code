
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');

function distDirFromArgv(): string {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--dist');
  const value = at !== -1 ? argv[at + 1] : undefined;
  if (!value) return path.join(projectRoot, 'dist');
  return path.isAbsolute(value) ? value : path.join(projectRoot, value);
}

const distDir = distDirFromArgv();

type Locale = 'mn' | 'ru' | 'en';

interface PageSpec {
  locale: Locale;
  distFile: string;
  kind: 'landing' | 'privacy';
}

const PAGES: PageSpec[] = [
  { locale: 'mn', distFile: 'index.html', kind: 'landing' },
  { locale: 'ru', distFile: 'ru/index.html', kind: 'landing' },
  { locale: 'en', distFile: 'en/index.html', kind: 'landing' },
  { locale: 'mn', distFile: 'privacy/index.html', kind: 'privacy' },
  { locale: 'ru', distFile: 'ru/privacy/index.html', kind: 'privacy' },
  { locale: 'en', distFile: 'en/privacy/index.html', kind: 'privacy' },
];

interface PageResult {
  page: PageSpec;
  errors: string[];
  title?: string;
  description?: string;
}

function extractTag(html: string, pattern: RegExp): string | null {
  const m = html.match(pattern);
  return m ? m[1] : null;
}

function hasJsonLdType(html: string, type: string): boolean {
  const scriptBlocks = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g);
  if (!scriptBlocks) return false;
  return scriptBlocks.some((block) => block.includes(`"@type":"${type}"`) || block.includes(`"@type": "${type}"`));
}

function checkLandingPage(html: string, page: PageSpec): { errors: string[]; title?: string; description?: string } {
  const errors: string[] = [];

  const title = extractTag(html, /<title>([^<]*)<\/title>/);
  if (!title || title.trim().length === 0) {
    errors.push('missing or empty <title>');
  }

  const description = extractTag(html, /<meta[^>]*name="description"[^>]*content="([^"]*)"[^>]*>/);
  if (!description || description.trim().length === 0) {
    errors.push('missing or empty <meta name="description">');
  }

  const ogImage = extractTag(html, /<meta[^>]*property="og:image"[^>]*content="([^"]*)"[^>]*>/);
  if (!ogImage) {
    errors.push('missing <meta property="og:image">');
  } else {
    if (!/^https?:\/\//.test(ogImage)) {
      errors.push(`og:image is not an absolute URL: "${ogImage}"`);
    }
    const expectedFile = `og-${page.locale}.png`;
    if (!ogImage.endsWith(expectedFile)) {
      errors.push(`og:image does not point at ${expectedFile}: "${ogImage}"`);
    }

    if (!existsSync(path.join(distDir, expectedFile))) {
      errors.push(`og:image указывает на ${expectedFile}, но файла нет в dist/`);
    }
    const canonicalForOrigin = extractTag(
      html,
      /<link[^>]*rel="canonical"[^>]*href="([^"]*)"[^>]*>/,
    );
    if (canonicalForOrigin) {
      try {
        if (new URL(ogImage).origin !== new URL(canonicalForOrigin).origin) {
          errors.push(
            `og:image лежит не на том же origin, что canonical: "${ogImage}" против "${canonicalForOrigin}"`,
          );
        }
      } catch {
        /* */
      }
    }
  }

  const OG_REQUIRED: { prop: string; why: string }[] = [
    { prop: 'og:title', why: 'заголовок карточки' },
    { prop: 'og:description', why: 'описание карточки' },
    { prop: 'og:type', why: 'тип страницы' },
    { prop: 'og:site_name', why: 'имя сайта под заголовком' },
    { prop: 'og:image:width', why: 'без размеров превью иногда не рисуется до первой загрузки картинки' },
    { prop: 'og:image:height', why: 'то же' },
    { prop: 'og:image:alt', why: 'подпись картинки для незрячих' },
    { prop: 'og:locale', why: 'язык карточки' },
  ];
  for (const { prop, why } of OG_REQUIRED) {
    const value = extractTag(
      html,
      new RegExp(`<meta[^>]*property="${prop}"[^>]*content="([^"]*)"[^>]*>`),
    );
    if (!value || value.trim().length === 0) {
      errors.push(`missing or empty <meta property="${prop}"> (${why})`);
    }
  }

  const ogUrl = extractTag(html, /<meta[^>]*property="og:url"[^>]*content="([^"]*)"[^>]*>/);
  const canonicalHref = extractTag(html, /<link[^>]*rel="canonical"[^>]*href="([^"]*)"[^>]*>/);
  if (!ogUrl) {
    errors.push('missing <meta property="og:url">');
  } else if (canonicalHref && ogUrl !== canonicalHref) {
    errors.push(`og:url "${ogUrl}" не совпадает с canonical "${canonicalHref}"`);
  }

  const altLocales = html.match(/property="og:locale:alternate"/g) ?? [];
  if (altLocales.length !== 2) {
    errors.push(
      `og:locale:alternate должно быть ровно 2 (три языка минус текущий), найдено ${altLocales.length}`,
    );
  }

  const twitterCard = extractTag(html, /<meta[^>]*name="twitter:card"[^>]*content="([^"]*)"[^>]*>/);
  if (twitterCard !== 'summary_large_image') {
    errors.push(
      `twitter:card должен быть summary_large_image, найдено "${twitterCard ?? '(нет)'}"`,
    );
  }

  if (!hasJsonLdType(html, 'Organization')) {
    errors.push('missing JSON-LD "@type":"Organization"');
  }
  if (!hasJsonLdType(html, 'WebSite')) {
    errors.push('missing JSON-LD "@type":"WebSite"');
  }
  if (!hasJsonLdType(html, 'FAQPage')) {
    errors.push('missing JSON-LD "@type":"FAQPage"');
  }

  return { errors, title: title ?? undefined, description: description ?? undefined };
}

function checkOgTitleMatchesTitle(html: string): string[] {
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1]?.trim();
  const og = html.match(/property="og:title"\s+content="([^"]*)"/)?.[1]?.trim();
  if (!title) return ['<title> не найден — сравнивать og:title не с чем'];
  if (!og) return ['og:title не найден'];
  if (og !== title) {
    return [
      `og:title внутренней страницы не совпадает с её <title>: ` +
        `og:title="${og}", <title>="${title}". Карточка позовёт не туда, куда ведёт ссылка.`,
    ];
  }
  return [];
}

function checkPrivacyPage(html: string): string[] {
  const errors: string[] = [...checkOgTitleMatchesTitle(html)];
  if (!hasJsonLdType(html, 'Organization')) {
    errors.push('missing JSON-LD "@type":"Organization"');
  }
  if (!hasJsonLdType(html, 'WebSite')) {
    errors.push('missing JSON-LD "@type":"WebSite"');
  }
  return errors;
}

function checkPage(page: PageSpec): PageResult {
  const filePath = path.join(distDir, page.distFile);

  if (!existsSync(filePath)) {
    return { page, errors: [`dist/${page.distFile} does not exist (page not built yet)`] };
  }

  let html: string;
  try {
    html = readFileSync(filePath, 'utf8');
  } catch (err) {
    return { page, errors: [`failed to read dist/${page.distFile}: ${(err as Error).message}`] };
  }

  if (page.kind === 'landing') {
    const { errors, title, description } = checkLandingPage(html, page);
    return { page, errors, title, description };
  }
  return { page, errors: checkPrivacyPage(html) };
}

function main(): void {
  const results: PageResult[] = [];
  for (const page of PAGES) {
    try {
      results.push(checkPage(page));
    } catch (err) {
      results.push({ page, errors: [`unexpected error checking page: ${(err as Error).message}`] });
    }
  }

  const landingResults = results.filter((r) => r.page.kind === 'landing');
  const titlesSeen = new Map<string, Locale>();
  const descriptionsSeen = new Map<string, Locale>();
  for (const r of landingResults) {
    if (r.title) {
      const prior = titlesSeen.get(r.title);
      if (prior) {
        r.errors.push(`title is identical to locale "${prior}": "${r.title}"`);
      } else {
        titlesSeen.set(r.title, r.page.locale);
      }
    }
    if (r.description) {
      const prior = descriptionsSeen.get(r.description);
      if (prior) {
        r.errors.push(`description is identical to locale "${prior}": "${r.description}"`);
      } else {
        descriptionsSeen.set(r.description, r.page.locale);
      }
    }
  }

  let failCount = 0;
  for (const { page, errors } of results) {
    const label = `[${page.kind}/${page.locale}] dist/${page.distFile}`;
    if (errors.length === 0) {
      console.log(`PASS ${label}`);
    } else {
      failCount++;
      console.error(`FAIL ${label}`);
      for (const e of errors) console.error(`  - ${e}`);
    }
  }

  console.log(`\n${results.length} pages checked, ${failCount} failed.`);
  if (failCount > 0) process.exit(1);
}

main();
