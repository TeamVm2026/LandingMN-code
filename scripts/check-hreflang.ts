
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

const distLabel = path.relative(projectRoot, distDir).replace(/\\/g, '/') || 'dist';

type Locale = 'mn' | 'ru' | 'en';
type PageType = 'landing' | 'privacy' | '404' | 'thanks';

type PageIndexing = 'indexable' | 'noindex';

interface PageSpec {
  type: PageType;
  indexing: PageIndexing;
  locale: Locale;
  distFile: string;
}

const PAGES: PageSpec[] = [
  { type: 'landing', indexing: 'indexable', locale: 'mn', distFile: 'index.html' },
  { type: 'landing', indexing: 'indexable', locale: 'ru', distFile: 'ru/index.html' },
  { type: 'landing', indexing: 'indexable', locale: 'en', distFile: 'en/index.html' },
  { type: 'privacy', indexing: 'indexable', locale: 'mn', distFile: 'privacy/index.html' },
  { type: 'privacy', indexing: 'indexable', locale: 'ru', distFile: 'ru/privacy/index.html' },
  { type: 'privacy', indexing: 'indexable', locale: 'en', distFile: 'en/privacy/index.html' },
  { type: '404', indexing: 'noindex', locale: 'mn', distFile: '404.html' },
  { type: '404', indexing: 'noindex', locale: 'ru', distFile: 'ru/404.html' },
  { type: '404', indexing: 'noindex', locale: 'en', distFile: 'en/404.html' },
  { type: 'thanks', indexing: 'noindex', locale: 'mn', distFile: 'thanks/index.html' },
  { type: 'thanks', indexing: 'noindex', locale: 'ru', distFile: 'ru/thanks/index.html' },
  { type: 'thanks', indexing: 'noindex', locale: 'en', distFile: 'en/thanks/index.html' },
];

interface PageResult {
  page: PageSpec;
  errors: string[];
}

function countOccurrences(haystack: string, pattern: RegExp): number {
  const matches = haystack.match(pattern);
  return matches ? matches.length : 0;
}

function checkIndexablePage(html: string): string[] {
  const errors: string[] = [];

  const localeHreflangCount = countOccurrences(
    html,
    /<link[^>]*rel="alternate"[^>]*hreflang="(?:mn|ru|en)"[^>]*>/g,
  );
  if (localeHreflangCount !== 3) {
    errors.push(`expected exactly 3 locale hreflang alternates, found ${localeHreflangCount}`);
  }

  const xDefaultCount = countOccurrences(html, /hreflang="x-default"/g);
  if (xDefaultCount !== 1) {
    errors.push(`expected exactly 1 hreflang="x-default", found ${xDefaultCount}`);
  }

  const canonicalCount = countOccurrences(html, /<link[^>]*rel="canonical"[^>]*>/g);
  if (canonicalCount !== 1) {
    errors.push(`expected exactly 1 rel="canonical" link, found ${canonicalCount}`);
  }

  return errors;
}

function checkNoindexPage(html: string): string[] {
  const errors: string[] = [];

  const hasNoindex = /<meta[^>]*name="robots"[^>]*content="[^"]*noindex[^"]*"[^>]*>/i.test(html);
  if (!hasNoindex) {
    errors.push('missing <meta name="robots" content="noindex"> on a noindex page');
  }

  const hreflangCount = countOccurrences(html, /<link[^>]*\bhreflang="[^"]*"[^>]*>/g);
  if (hreflangCount !== 0) {
    errors.push(`noindex page must carry zero <link hreflang> tags, found ${hreflangCount}`);
  }

  const canonicalCount = countOccurrences(html, /<link[^>]*rel="canonical"[^>]*>/g);
  if (canonicalCount !== 0) {
    errors.push(`noindex page must carry zero canonical tags, found ${canonicalCount}`);
  }

  return errors;
}

function checkPage(page: PageSpec): PageResult {
  const filePath = path.join(distDir, page.distFile);

  if (!existsSync(filePath)) {
    return { page, errors: [`${distLabel}/${page.distFile} does not exist (page not built yet)`] };
  }

  let html: string;
  try {
    html = readFileSync(filePath, 'utf8');
  } catch (err) {
    return {
      page,
      errors: [`failed to read ${distLabel}/${page.distFile}: ${(err as Error).message}`],
    };
  }

  const errors = page.indexing === 'noindex' ? checkNoindexPage(html) : checkIndexablePage(html);
  return { page, errors };
}

function main(): void {
  const results: PageResult[] = [];
  for (const page of PAGES) {
    try {
      results.push(checkPage(page));
    } catch (err) {

      results.push({
        page,
        errors: [`unexpected error checking page: ${(err as Error).message}`],
      });
    }
  }

  let failCount = 0;
  for (const { page, errors } of results) {
    const label = `[${page.type}/${page.locale}] ${distLabel}/${page.distFile}`;
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
