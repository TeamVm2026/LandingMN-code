
import { chromium, type Browser, type Page } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { occupiedPorts, portGuardMessage, checkBuildFreshness, freshnessGuardMessage } from './lib/preflight.ts';

const projectRoot = path.resolve(import.meta.dirname, '..');
const phaseDirSlug = process.argv[2] ?? '02-static-presentation';
const screenshotsDir = path.join(
  projectRoot,
  '.planning',
  'phases',
  phaseDirSlug,
  'screenshots',
);
mkdirSync(screenshotsDir, { recursive: true });

const PORT = 4321;
const BASE_URL = `http://localhost:${PORT}`;
const LOCALES = ['mn', 'ru', 'en'] as const;
type Locale = (typeof LOCALES)[number];

const LOCALE_PATH: Record<Locale, string> = { mn: '/', ru: '/ru/', en: '/en/' };

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const NARROW = { width: 360, height: 800 };

const FORCE_CONSENT_REGION = (process.env.FORCE_CONSENT_REGION ?? '').trim().toUpperCase();
const REGION_FORCED = FORCE_CONSENT_REGION.length > 0;

const REGION_SUFFIX = REGION_FORCED ? `-${FORCE_CONSENT_REGION}` : '';

const CONSENT_STORAGE_KEY = 'lmn_consent';

const consentRecord = (choice: 'granted' | 'denied'): string =>
  JSON.stringify({ v: 1, at: Date.now(), c: choice });

const traceBody = (loc: string): string =>
  `fl=13f99\nh=example\nip=203.0.113.7\nts=1755772800\nvisit_scheme=https\ncolo=AMS\nloc=${loc}\ntls=TLSv1.3\n`;

async function openPage(browser: Browser, viewport: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  if (REGION_FORCED) {
    await page.context().route('**/cdn-cgi/trace', (route) =>
      route.fulfill({ status: 200, contentType: 'text/plain', body: traceBody(FORCE_CONSENT_REGION) }),
    );
  }
  return page;
}

async function waitForBanner(page: Page): Promise<boolean> {
  try {
    await page.locator('[data-consent-banner].is-open').waitFor({ state: 'visible', timeout: 20_000 });

    await page.waitForTimeout(500);
    return true;
  } catch {
    return false;
  }
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
    } catch {
      /* */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Preview server at ${url} did not become ready within ${timeoutMs}ms`);
}

function killServer(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.once('exit', () => resolve());

    proc.kill();

    setTimeout(resolve, 3000);
  });
}

interface Finding {
  label: string;
  ok: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const findings: Finding[] = [];

  const freshness = checkBuildFreshness(projectRoot);
  if (!freshness.fresh) {
    console.error(freshnessGuardMessage(freshness));
    process.exit(1);
  }

  const occupied = await occupiedPorts();
  if (occupied.length > 0) {
    console.error(portGuardMessage(occupied));
    process.exit(1);
  }

  console.log('Starting preview server (npm run preview)...');
  const server = spawn('npm', ['run', 'preview'], {
    cwd: projectRoot,
    shell: true,
    stdio: 'ignore',
  });

  try {
    await waitForServer(BASE_URL, 30_000);
    console.log('Preview server ready.\n');

    const browser = await chromium.launch();

    for (const locale of LOCALES) {
      const url = `${BASE_URL}${LOCALE_PATH[locale]}`;

      const fullPage = !REGION_FORCED;

      const mobilePage = await openPage(browser, MOBILE);
      await mobilePage.goto(url, { waitUntil: 'networkidle' });
      const mobileBannerShown = REGION_FORCED ? await waitForBanner(mobilePage) : false;
      const mobileHeight = await mobilePage.evaluate(() => document.documentElement.scrollHeight);
      await mobilePage.screenshot({
        path: path.join(screenshotsDir, `mobile${REGION_SUFFIX}-${locale}.png`),
        fullPage,
      });
      if (REGION_FORCED) {

        const bannerHeight = mobileBannerShown
          ? await mobilePage
              .locator('[data-consent-banner]')
              .evaluate((el) => (el as HTMLElement).offsetHeight)
          : 0;
        findings.push({
          label: `03-11 баннер снят на 390 (${locale}, loc=${FORCE_CONSENT_REGION})`,
          ok: mobileBannerShown,
          detail: mobileBannerShown
            ? `высота ${bannerHeight}px — ${((bannerHeight / MOBILE.height) * 100).toFixed(1)}% первого экрана`
            : 'БАННЕР НЕ ПОЯВИЛСЯ — кадр снят впустую',
        });
      }

      const maxHeight = MOBILE.height * 6;
      findings.push({
        label: `LAND-01 page height (${locale}, mobile)`,
        ok: mobileHeight <= maxHeight,
        detail: `${mobileHeight}px measured vs ${maxHeight}px budget (${(mobileHeight / MOBILE.height).toFixed(2)} screens)`,
      });
      await mobilePage.close();

      const desktopPage = await openPage(browser, DESKTOP);
      await desktopPage.goto(url, { waitUntil: 'networkidle' });
      const desktopBannerShown = REGION_FORCED ? await waitForBanner(desktopPage) : false;
      await desktopPage.screenshot({
        path: path.join(screenshotsDir, `desktop${REGION_SUFFIX}-${locale}.png`),
        fullPage,
      });
      if (REGION_FORCED) {
        findings.push({
          label: `03-11 баннер снят на 1440 (${locale}, loc=${FORCE_CONSENT_REGION})`,
          ok: desktopBannerShown,
          detail: desktopBannerShown ? 'карточка показана' : 'БАННЕР НЕ ПОЯВИЛСЯ — кадр снят впустую',
        });
      }
      await desktopPage.close();

      const narrowPage = await openPage(browser, NARROW);
      await narrowPage.goto(url, { waitUntil: 'networkidle' });
      const narrowBannerShown = REGION_FORCED ? await waitForBanner(narrowPage) : false;
      await narrowPage.screenshot({
        path: path.join(screenshotsDir, `360px${REGION_SUFFIX}-${locale}.png`),
        fullPage,
      });
      const noOverflow = await narrowPage.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      );
      findings.push({
        label: `I18N-04 no horizontal scroll at 360px (${locale})`,
        ok: noOverflow,
        detail: noOverflow ? 'scrollWidth <= clientWidth' : 'OVERFLOW DETECTED',
      });
      if (REGION_FORCED) {

        const narrowAudit = narrowBannerShown
          ? await narrowPage.evaluate(() => {
              const banner = document.querySelector<HTMLElement>('[data-consent-banner]');
              if (!banner) return null;

              const lines = (el: Element | null): number => {
                if (!el) return 0;
                const range = document.createRange();
                range.selectNodeContents(el);
                const tops = new Set(
                  Array.from(range.getClientRects()).map((r) => Math.round(r.top)),
                );
                return tops.size;
              };
              const buttons = Array.from(banner.querySelectorAll('button'));
              return {
                height: banner.offsetHeight,
                textLines: lines(banner.querySelector('.consent-banner__text')),
                buttonLines: buttons.map((b) => lines(b)),
                clipped: buttons.some((b) => b.scrollWidth > b.clientWidth + 1),
              };
            })
          : null;
        findings.push({
          label: `03-11 баннер на 360px не обрезан (${locale})`,
          ok: narrowAudit !== null && !narrowAudit.clipped && narrowAudit.buttonLines.every((n) => n === 1),
          detail: narrowAudit
            ? `высота ${narrowAudit.height}px, строк текста ${narrowAudit.textLines}, строк в подписях ${narrowAudit.buttonLines.join('/')}, обрезка: ${narrowAudit.clipped ? 'ЕСТЬ' : 'нет'}`
            : 'БАННЕР НЕ ПОЯВИЛСЯ',
        });
      }
      await narrowPage.close();

      console.log(`Captured mobile/desktop/360px screenshots for locale "${locale}".`);
    }

    if (REGION_FORCED) {
      const CONTROL = '[data-consent-control]';
      const PRIVACY_PATH: Record<Locale, string> = {
        mn: '/privacy/',
        ru: '/ru/privacy/',
        en: '/en/privacy/',
      };
      for (const locale of LOCALES) {
        for (const [viewportName, viewport] of [
          ['m390', MOBILE],
          ['d1440', DESKTOP],
        ] as const) {
          for (const [stateName, choice] of [
            ['on', 'granted'],
            ['off', 'denied'],
          ] as const) {
            const page = await openPage(browser, viewport);
            await page.addInitScript(
              ([key, value]) => {
                try {
                  localStorage.setItem(key, value);
                } catch {
                  /* */
                }
              },
              [CONSENT_STORAGE_KEY, consentRecord(choice)] as const,
            );
            await page.goto(`${BASE_URL}${PRIVACY_PATH[locale]}`, { waitUntil: 'networkidle' });

            const control = page.locator(CONTROL);
            let shown = true;
            try {
              await control.waitFor({ state: 'visible', timeout: 15_000 });
            } catch {
              shown = false;
            }

            await page.mouse.move(0, 0);

            const section = page.locator('section.privacy-section').filter({ has: control });
            const target = shown ? section : page.locator('main');

            const box = await target.evaluate((el) => {
              const r = el.getBoundingClientRect();
              return {
                x: r.x + window.scrollX,
                y: r.y + window.scrollY,
                width: r.width,
                height: r.height,
              };
            });
            await page.screenshot({
              path: path.join(
                screenshotsDir,
                `control${REGION_SUFFIX}-${viewportName}-${locale}-${stateName}.png`,
              ),
              fullPage: true,
              clip: box,
            });

            const audit = shown
              ? await page.evaluate((sel) => {
                  const el = document.querySelector<HTMLElement>(sel);
                  if (!el) return null;
                  const gold = Array.from(el.querySelectorAll('*')).filter((node) => {
                    const bg = getComputedStyle(node).backgroundColor;
                    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
                    if (!m) return false;
                    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
                    return r > 200 && g > 150 && b < 120;
                  }).length;
                  return { height: el.offsetHeight, gold };
                }, CONTROL)
              : null;

            findings.push({
              label: `03-11 переключатель снят (${locale}, ${viewportName}, ${stateName})`,
              ok: shown && audit !== null && audit.gold === 0,
              detail: audit
                ? `высота ${audit.height}px, сплошных золотых заливок внутри: ${audit.gold}`
                : 'ЭЛЕМЕНТ НЕ ПОКАЗАН — кадр снят впустую',
            });

            await page.close();
          }
        }
        console.log(`Captured consent-control screenshots for locale "${locale}".`);
      }
    }

    const glyphPage = await browser.newPage({ viewport: MOBILE });
    await glyphPage.goto(`${BASE_URL}${LOCALE_PATH.mn}`, { waitUntil: 'networkidle' });

    const currencyItem = glyphPage.locator('.faq-accordion details[data-faq-key="currency"]');
    await currencyItem.locator('summary').click();
    await currencyItem.locator('.faq-answer p').waitFor({ state: 'visible' });
    const answerText = (await currencyItem.locator('.faq-answer p').innerText()).trim();
    const hasAllGlyphs = ['Ө', 'ө', 'Ү', 'ү', '₮'].every((ch) => answerText.includes(ch));
    findings.push({
      label: 'I18N-03 faq.a_currency contains Ө/ө/Ү/ү/₮ together (shipped content)',
      ok: hasAllGlyphs,
      detail: hasAllGlyphs ? `verified in: "${answerText}"` : `MISSING GLYPHS in: "${answerText}"`,
    });
    await currencyItem.screenshot({ path: path.join(screenshotsDir, 'glyph-test-faq-currency.png') });
    await glyphPage.close();
    console.log('Captured glyph-regression crop (glyph-test-faq-currency.png).');

    const imgCheckPage = await browser.newPage({ viewport: MOBILE });
    await imgCheckPage.goto(`${BASE_URL}${LOCALE_PATH.mn}`, { waitUntil: 'networkidle' });
    const imgAudit = await imgCheckPage.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      return imgs.map((img) => ({
        insidePicture: img.parentElement?.tagName.toLowerCase() === 'picture',
        hasAvifSource: Array.from(img.parentElement?.querySelectorAll('source') ?? []).some(
          (s) => s.getAttribute('type') === 'image/avif'
        ),
        hasDimensions: img.hasAttribute('width') && img.hasAttribute('height'),
        loading: img.getAttribute('loading') ?? '',

        aboveFold: img.getBoundingClientRect().top < window.innerHeight,
      }));
    });

    const imagesPresent = imgAudit.length > 0;
    findings.push({
      label: 'Фаза 2.2: на странице есть настоящие изображения',
      ok: imagesPresent,
      detail: imagesPresent
        ? `${imgAudit.length} кадр(ов) на странице`
        : 'ноль <img> — это ровно тот дефект, ради которого существует Фаза 2.2',
    });

    const pipelineProblems = imgAudit
      .map((img, i) => {
        const issues: string[] = [];
        if (!img.insidePicture) issues.push('не внутри <picture>');
        if (!img.hasAvifSource) issues.push('нет AVIF-источника');
        if (!img.hasDimensions) issues.push('нет width/height (риск CLS)');
        if (!img.aboveFold && img.loading !== 'lazy') issues.push('ниже сгиба, но грузится жадно');
        return issues.length > 0 ? `#${i + 1}: ${issues.join(', ')}` : null;
      })
      .filter(Boolean);

    findings.push({
      label: 'Фаза 2.2: каждый кадр идёт через конвейер astro:assets и не даёт CLS',
      ok: imagesPresent && pipelineProblems.length === 0,
      detail:
        pipelineProblems.length === 0
          ? 'все кадры в <picture> с AVIF, с явными размерами, ниже сгиба — lazy'
          : pipelineProblems.join('; '),
    });
    await imgCheckPage.close();

    await browser.close();

    console.log('\n--- Visual self-check findings ---');
    let failCount = 0;
    for (const f of findings) {
      console.log(`${f.ok ? 'PASS' : 'FAIL'} ${f.label}: ${f.detail}`);
      if (!f.ok) failCount++;
    }
    console.log(`\nScreenshots saved under ${path.relative(projectRoot, screenshotsDir)}/`);
    console.log(`${findings.length} checks run, ${failCount} failed.`);
    if (failCount > 0) process.exitCode = 1;
  } finally {
    console.log('\nStopping preview server...');
    await killServer(server);
  }
}

main().catch((err) => {
  console.error('visual-check.ts crashed:', err);
  process.exit(1);
});
