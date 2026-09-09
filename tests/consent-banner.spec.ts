
import { test, expect, type Page, type Locator, type Cookie } from '@playwright/test';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';
import { CONSENT_STORAGE_KEY, CONSENT_TTL_MS } from '../src/scripts/analytics/consent';
import { MOBILE_VIEWPORT, DESKTOP_VIEWPORT } from '../playwright.config';
import { withExclusiveBuildLock } from './lib/exclusive-build';
import { envValue } from '../scripts/lib/env-value';

declare global {
  interface Window {

    __lmnCls?: number;

    __lmnClsArmed?: boolean;

    __lmnClsSources?: string[];

    __lmnAlive?: string;
  }
}

const projectRoot = path.resolve(import.meta.dirname, '..');

const CONSENT_DIST = path.join(projectRoot, 'dist-consent');

const FAKE_GA_ID = 'G-TESTONLY02';
const FAKE_CLARITY_ID = 'testonly02';

const NARROW_VIEWPORT = { width: 360, height: 800 };

const LOCALES: readonly Locale[] = ['mn', 'ru', 'en'];

const BANNER = '[data-consent-banner]';
const ACCEPT = '[data-consent-accept]';
const DECLINE = '[data-consent-decline]';

const AFTER_IDLE_GATE_MS = 6500;

const DAY_MS = 24 * 60 * 60 * 1000;

function consentRecord(choice: 'granted' | 'denied', ageMs = 0): string {
  return JSON.stringify({ v: 1, at: Date.now() - ageMs, c: choice });
}

async function storedChoice(page: Page): Promise<string | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as { c?: unknown };
      return typeof parsed.c === 'string' ? parsed.c : `НЕ РАЗОБРАНО: ${raw}`;
    } catch {

      return raw;
    }
  }, CONSENT_STORAGE_KEY);
}

async function storedRaw(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), CONSENT_STORAGE_KEY);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
};

async function serveDir(dir: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let file = path.join(dir, decodeURIComponent(url.pathname));
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!existsSync(file) || statSync(file).isDirectory()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function stubProviders(page: Page): Promise<void> {
  await page.route('**www.googletagmanager.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }),
  );
  await page.route('**clarity.ms/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }),
  );
}

async function fakeRegion(page: Page, loc: string): Promise<void> {
  await page.route('**/cdn-cgi/trace', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: `fl=13f99\nh=example\nip=203.0.113.7\nts=1755772800\nvisit_scheme=https\ncolo=AMS\nloc=${loc}\ntls=TLSv1.3\n`,
    }),
  );
}

function countTraceRequests(page: Page): { get: () => number; reset: () => void } {
  let count = 0;
  page.on('request', (request) => {
    if (request.url().includes('/cdn-cgi/trace')) count += 1;
  });
  return {
    get: () => count,
    reset: () => {
      count = 0;
    },
  };
}

async function dataLayerEntries(page: Page): Promise<unknown[][]> {
  return page.evaluate(() =>
    (window.dataLayer ?? []).map((entry) => Array.from(entry as ArrayLike<unknown>)),
  );
}

async function clarityQueue(page: Page): Promise<unknown[][]> {
  return page.evaluate(() => (window.clarity?.q ?? []).map((args) => Array.from(args)));
}

async function consentDefaults(page: Page): Promise<Record<string, unknown>[]> {
  const entries = await dataLayerEntries(page);
  return entries
    .filter((args) => args[0] === 'consent' && args[1] === 'default')
    .map((args) => args[2] as Record<string, unknown>);
}

async function consentUpdates(page: Page): Promise<Record<string, unknown>[]> {
  const entries = await dataLayerEntries(page);
  return entries
    .filter((args) => args[0] === 'consent' && args[1] === 'update')
    .map((args) => args[2] as Record<string, unknown>);
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

async function stableBox(locator: Locator): Promise<Box> {
  let previous: Box | null = null;
  for (let i = 0; i < 40; i += 1) {
    const box = await locator.boundingBox();
    if (
      box &&
      previous &&
      Math.abs(box.x - previous.x) < 0.5 &&
      Math.abs(box.y - previous.y) < 0.5 &&
      Math.abs(box.width - previous.width) < 0.5 &&
      Math.abs(box.height - previous.height) < 0.5
    ) {
      return box;
    }
    previous = box;
    await locator.page().waitForTimeout(50);
  }
  throw new Error('бокс не стабилизировался за 2 с — переход не заканчивается');
}

async function translateY(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const value = getComputedStyle(el).transform;
    if (!value || value === 'none') return 0;
    const matrix = new DOMMatrixReadOnly(value);
    return matrix.m42;
  });
}

async function tappableBoxesOnFirstScreen(
  page: Page,
): Promise<{ label: string; box: Box; pinned: boolean }[]> {
  return page.evaluate((bannerSelector) => {
    const banner = document.querySelector(bannerSelector);
    const out: { label: string; box: Box; pinned: boolean }[] = [];
    const nodes = document.querySelectorAll<HTMLElement>('a[href], button');
    for (const node of nodes) {
      if (banner?.contains(node)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
      if (getComputedStyle(node).visibility === 'hidden') continue;
      const label =
        node.getAttribute('data-track-channel') ??
        node.className.toString().split(/\s+/).filter(Boolean)[0] ??
        node.tagName.toLowerCase();

      let pinned = false;
      for (let n: HTMLElement | null = node; n; n = n.parentElement) {
        const pos = getComputedStyle(n).position;
        if (pos === 'fixed' || pos === 'sticky') {
          pinned = true;
          break;
        }
      }
      out.push({
        label,
        pinned,
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
    }
    return out;
  }, BANNER);
}

async function scrollPastHeroSentinel(page: Page): Promise<void> {
  const sentinelTop = await page
    .locator('#hero-sentinel')
    .evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  await page.evaluate((y) => window.scrollTo(0, y + 200), sentinelTop);
}

test.describe('запрос согласия: регион, показ, решение', () => {

  test.describe.configure({ mode: 'serial' });

  let server: Server;
  let origin = '';

  test.beforeAll(async () => {
    test.setTimeout(180_000);

    rmSync(CONSENT_DIST, { recursive: true, force: true });

    const build = withExclusiveBuildLock(() =>
      spawnSync(
        process.execPath,
        [path.join(projectRoot, 'node_modules', 'astro', 'astro.js'), 'build', '--outDir', CONSENT_DIST],
        {
          cwd: projectRoot,
          encoding: 'utf8',
          env: { ...process.env, PUBLIC_GA_ID: FAKE_GA_ID, PUBLIC_CLARITY_ID: FAKE_CLARITY_ID },
        },
      ),
    );
    if (build.status !== 0) {
      throw new Error(`сборка с искусственными ID не удалась:\n${build.stdout}\n${build.stderr}`);
    }

    ({ server, origin } = await serveDir(CONSENT_DIST));
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(CONSENT_DIST, { recursive: true, force: true });
  });

  test('контроль: разметка баннера есть в сборке и приходит скрытой', async ({ page }) => {
    const html = readFileSync(path.join(CONSENT_DIST, 'index.html'), 'utf8');
    expect(html).toContain('data-consent-banner');
    expect(html).toMatch(/<aside[^>]*data-consent-banner[^>]*hidden/);

    await stubProviders(page);
    await page.goto(origin);

    const banner = page.locator(BANNER);
    await expect(banner).toHaveCount(1);
    await expect(banner).toHaveAttribute('hidden', '');
    await expect(banner).toBeHidden();
    await expect(page.locator(`${BANNER} ${ACCEPT}`)).toHaveCount(1);
    await expect(page.locator(`${BANNER} ${DECLINE}`)).toHaveCount(1);
  });

  test('1. loc=DE — баннер показан, --consent-h задана и больше нуля', async ({ page }) => {
    await stubProviders(page);
    await fakeRegion(page, 'DE');
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(origin);

    const banner = page.locator(BANNER);
    await expect(banner).toHaveClass(/is-open/, { timeout: 15_000 });
    await expect(banner).toBeVisible();

    const height = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--consent-h').trim(),
    );
    expect(height).toMatch(/^\d+(\.\d+)?px$/);
    expect(Number.parseFloat(height)).toBeGreaterThan(0);

    const box = await stableBox(banner);
    expect(Math.abs(Number.parseFloat(height) - box.height)).toBeLessThan(1.5);
  });

  test('2. loc=MN — баннер не появляется, и панель призыва не поднимается', async ({ page }) => {
    await stubProviders(page);
    await fakeRegion(page, 'MN');
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(origin);

    const banner = page.locator(BANNER);

    const deadline = Date.now() + AFTER_IDLE_GATE_MS;
    while (Date.now() < deadline) {
      expect(await banner.getAttribute('hidden')).not.toBeNull();
      await page.waitForTimeout(250);
    }
    await expect(banner).toBeHidden();

    const height = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--consent-h'),
    );
    expect(height).toBe('');

    await scrollPastHeroSentinel(page);
    await expect(page.locator('.sticky-cta')).toHaveCount(0);
  });

  test('3. запрос региона уходит РОВНО ОДИН раз и при DE, и при MN', async ({ page }) => {
    const trace = countTraceRequests(page);
    await stubProviders(page);
    await fakeRegion(page, 'DE');
    await page.goto(origin);
    await expect(page.locator(BANNER)).toHaveClass(/is-open/, { timeout: 15_000 });
    await page.waitForTimeout(1000);
    expect(trace.get()).toBe(1);

    trace.reset();
    await page.unroute('**/cdn-cgi/trace');
    await fakeRegion(page, 'MN');
    await page.goto(origin);
    await page.waitForTimeout(AFTER_IDLE_GATE_MS);
    expect(trace.get()).toBe(1);
    await expect(page.locator(BANNER)).toBeHidden();
  });

  for (const choice of ['granted', 'denied'] as const) {
    test(`4. записанное решение «${choice}»: ноль запросов региона, решение доезжает до GA4`, async ({
      page,
    }) => {
      const trace = countTraceRequests(page);
      await stubProviders(page);

      await fakeRegion(page, 'DE');
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

      await page.goto(origin);
      await expect
        .poll(async () => (await consentUpdates(page)).length, { timeout: 15_000 })
        .toBeGreaterThan(0);
      await page.waitForTimeout(1000);

      expect(trace.get()).toBe(0);
      await expect(page.locator(BANNER)).toBeHidden();

      const updates = await consentUpdates(page);
      expect(updates).toHaveLength(1);
      expect(updates[0].analytics_storage).toBe(choice);
    });
  }

  test('5. 404 на /cdn-cgi/trace — баннера нет, страница цела', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));

    await stubProviders(page);

    await page.goto(origin);
    await page.waitForTimeout(AFTER_IDLE_GATE_MS);

    await expect(page.locator(BANNER)).toBeHidden();
    expect(pageErrors).toEqual([]);

    await page
      .locator('details[data-track-direction="bank"] > summary')
      .evaluate((el) => (el as HTMLElement).click());
    await expect(page.locator('details[data-track-direction="bank"]')).toHaveAttribute('open', '');
  });

  async function waitForDefaults(page: Page): Promise<Record<string, unknown>[]> {
    await expect
      .poll(async () => (await consentDefaults(page)).length, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);
    return consentDefaults(page);
  }

  test('28. loc=DE — наше умолчание denied, и оно уходит ПЕРВЫМ', async ({ page }) => {
    await stubProviders(page);
    await fakeRegion(page, 'DE');
    await page.goto(origin);

    const defaults = await waitForDefaults(page);

    expect(
      defaults[0].analytics_storage,
      'общее умолчание разрешает сбор посетителю, которого НАШ прибор отнёс к ЕЭЗ',
    ).toBe('denied');

    expect(defaults[0].wait_for_update).toBe(500);

    expect(defaults[0].ad_storage).toBe('denied');
    expect(defaults[0].ad_user_data).toBe('denied');
    expect(defaults[0].ad_personalization).toBe('denied');
  });

  test('29. loc=MN — granted, и ожидания обновления не навязывается', async ({ page }) => {
    await stubProviders(page);
    await fakeRegion(page, 'MN');
    await page.goto(origin);

    const defaults = await waitForDefaults(page);
    expect(defaults[0].analytics_storage).toBe('granted');

    expect(
      'wait_for_update' in defaults[0],
      'монгольскому посетителю навязано ожидание обновления, которого не будет',
    ).toBe(false);
  });

  test('30. 404 на /cdn-cgi/trace — выбранная ветвь: «не ЕЭЗ»', async ({ page }) => {

    await stubProviders(page);
    await page.goto(origin);

    const defaults = await waitForDefaults(page);

    expect(defaults[0].analytics_storage).toBe('granted');
  });

  test('31. региональное умолчание НЕ удалено: второй слой на месте', async ({ page }) => {
    await stubProviders(page);

    await fakeRegion(page, 'MN');
    await page.goto(origin);

    const defaults = await waitForDefaults(page);
    expect(defaults).toHaveLength(2);
    expect(defaults[0].analytics_storage).toBe('granted');

    const regional = defaults[1];
    expect(regional.analytics_storage).toBe('denied');
    expect(regional.wait_for_update).toBe(500);
    const regions = regional.region as string[];
    expect(regions).toHaveLength(32);
    for (const code of ['DE', 'NL', 'GB', 'CH', 'NO', 'IS']) expect(regions).toContain(code);
    expect(regions, 'Монголия попала в список стран, где сбор запрещён умолчанием').not.toContain('MN');
  });

  for (const choice of ['granted', 'denied'] as const) {
    test(`32. записанное «${choice}» задаёт умолчание сразу и БЕЗ сети`, async ({ page }) => {
      const trace = countTraceRequests(page);
      await stubProviders(page);

      await fakeRegion(page, 'DE');
      await seedChoice(page, choice);
      await page.goto(origin);

      const defaults = await waitForDefaults(page);

      expect(defaults[0].analytics_storage).toBe(choice);

      expect(trace.get(), 'у человека с записанным решением ушёл запрос региона').toBe(0);
    });
  }

  test('33. тег GA4 запрашивается СТРОГО после ответа о регионе', async ({ page }) => {

    let traceFinished = 0;
    let tagRequested = 0;

    await page.route('**/cdn-cgi/trace', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      traceFinished = Date.now();
      await route.fulfill({
        status: 200,
        contentType: 'text/plain',
        body: 'fl=1\nh=test\nip=203.0.113.7\nvisit_scheme=http\ncolo=AMS\nloc=DE\ntls=TLSv1.3\n',
      });
    });
    await page.route('**www.googletagmanager.com/**', (route) => {
      if (!tagRequested) tagRequested = Date.now();
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
    });
    await page.route('**clarity.ms/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }),
    );

    await page.goto(origin);
    await expect.poll(() => tagRequested, { timeout: 25_000 }).toBeGreaterThan(0);

    expect(traceFinished, 'ответ о регионе не пришёл вовсе — сравнивать было бы нечего').toBeGreaterThan(0);
    expect(
      tagRequested - traceFinished,
      `тег GA4 запрошен ${traceFinished - tagRequested} мс РАНЬШЕ ответа о регионе — ` +
        'умолчание согласия приедет к уже загруженному тегу и не подействует',
    ).toBeGreaterThan(0);
  });

  test('6. «разрешить» доходит до обеих панелей без перезагрузки', async ({ page }) => {
    await stubProviders(page);
    await fakeRegion(page, 'DE');
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(origin);

    const banner = page.locator(BANNER);
    await expect(banner).toHaveClass(/is-open/, { timeout: 15_000 });

    await page.evaluate(() => {
      window.__lmnAlive = 'до нажатия';
    });

    await page.locator(`${BANNER} ${ACCEPT}`).click();

    await expect
      .poll(async () => (await consentUpdates(page)).length, { timeout: 10_000 })
      .toBe(1);

    const [update] = await consentUpdates(page);
    expect(update.analytics_storage).toBe('granted');
    expect(update).not.toHaveProperty('ad_storage');

    const queue = await clarityQueue(page);
    const consents = queue.filter((args) => args[0] === 'consentv2');
    expect(consents.length).toBe(2);
    expect(consents[1][1]).toEqual({ ad_Storage: 'denied', analytics_Storage: 'granted' });

    expect(await storedChoice(page)).toBe('granted');

    await expect(banner).not.toHaveClass(/is-open/);
    await expect(banner).toBeHidden({ timeout: 5000 });
    expect(
      await page.evaluate(() => document.documentElement.style.getPropertyValue('--consent-h')),
    ).toBe('0px');

    expect(await page.evaluate(() => window.__lmnAlive)).toBe('до нажатия');
  });

  test('7. «не надо»: ни одного granted, и при следующем заходе вопроса нет', async ({ page }) => {
    const trace = countTraceRequests(page);
    await stubProviders(page);
    await fakeRegion(page, 'DE');
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(origin);

    const banner = page.locator(BANNER);
    await expect(banner).toHaveClass(/is-open/, { timeout: 15_000 });

    await page.locator(`${BANNER} ${DECLINE}`).click();
    await expect.poll(async () => (await consentUpdates(page)).length, { timeout: 10_000 }).toBe(1);

    const updates = await consentUpdates(page);
    expect(updates[0].analytics_storage).toBe('denied');
    expect(updates.some((u) => u.analytics_storage === 'granted')).toBe(false);
    expect(await storedChoice(page)).toBe('denied');
    await expect(banner).toBeHidden({ timeout: 5000 });

    trace.reset();
    await page.reload();
    await expect
      .poll(async () => (await consentUpdates(page)).length, { timeout: 15_000 })
      .toBe(1);
    await page.waitForTimeout(1000);

    expect(trace.get()).toBe(0);
    await expect(banner).toBeHidden();
    const afterReload = await consentUpdates(page);
    expect(afterReload[0].analytics_storage).toBe('denied');
    expect(afterReload.some((u) => u.analytics_storage === 'granted')).toBe(false);
  });

  test('8. первым элементом очереди Clarity стоит consentv2 с обоими denied', async ({ page }) => {
    await stubProviders(page);
    await fakeRegion(page, 'MN');
    await page.goto(origin);

    await expect.poll(async () => (await clarityQueue(page)).length, { timeout: 15_000 }).toBeGreaterThan(0);

    const queue = await clarityQueue(page);
    expect(queue[0][0]).toBe('consentv2');
    expect(queue[0][1]).toEqual({ ad_Storage: 'denied', analytics_Storage: 'denied' });
  });

  const BOTTOM_STACK_BUDGET = 0.18;

  for (const locale of LOCALES) {
    test(`9. 390×844 (${locale}): низ экрана занят ТОЛЬКО баннером, второй плиты нет`, async ({
      page,
    }) => {
      await stubProviders(page);
      await fakeRegion(page, 'DE');
      await page.setViewportSize(MOBILE_VIEWPORT);
      await page.goto(`${origin}${PAGE_ROUTES.home[locale]}`);

      const banner = page.locator(BANNER);
      await expect(banner).toHaveClass(/is-open/, { timeout: 15_000 });

      await scrollPastHeroSentinel(page);

      await expect(page.locator('.sticky-cta')).toHaveCount(0);
      await expect(page.locator('html')).not.toHaveClass(/consent-open/);

      const bannerBox = await stableBox(banner);

      const coveredPinned = (await tappableBoxesOnFirstScreen(page))
        .filter((item) => item.pinned)
        .map((item) => ({ label: item.label, area: overlapArea(bannerBox, item.box) }))
        .filter((item) => item.area > 0);
      expect(
        coveredPinned,
        `баннер накрыл ПРИБИТЫЙ нажимаемый элемент, до которого не добраться прокруткой: ${JSON.stringify(
          coveredPinned,
        )}`,
      ).toEqual([]);

      const stackPx = MOBILE_VIEWPORT.height - bannerBox.y;
      const stackPct = stackPx / MOBILE_VIEWPORT.height;
      expect(
        stackPct,
        `нижняя конструкция ${stackPx.toFixed(2)}px = ${(stackPct * 100).toFixed(1)}% окна ` +
          `${MOBILE_VIEWPORT.height} при пороге ${(BOTTOM_STACK_BUDGET * 100).toFixed(0)}%`,
      ).toBeLessThanOrEqual(BOTTOM_STACK_BUDGET);

      expect(bannerBox.height, 'баннер нулевой высоты — мерить нечего').toBeGreaterThan(0);
      expect(
        bannerBox.y + bannerBox.height,
        'баннер не стоит у нижней кромки окна',
      ).toBeGreaterThanOrEqual(MOBILE_VIEWPORT.height - 1);

      await page.locator(ACCEPT).click();
      await expect(banner).toBeHidden();
      await expect(page.locator('.sticky-cta')).toHaveCount(0);

      const nizPorog = MOBILE_VIEWPORT.height * (2 / 3);
      const pinnedVnizu = (await tappableBoxesOnFirstScreen(page)).filter(
        (i) => i.pinned && i.box.y + i.box.height > nizPorog,
      );
      expect(
        pinnedVnizu.map((i) => i.label),
        'после ответа внизу экрана снова что-то прибито — панель вернулась вопреки решению 07.09.2026',
      ).toEqual([]);

      const pinnedVsego = (await tappableBoxesOnFirstScreen(page)).filter((i) => i.pinned);
      expect(
        pinnedVsego.length,
        'прибитого на странице нет вовсе — прибор слеп, проверка ниже ничего не значит',
      ).toBeGreaterThan(0);
    });
  }

  test('40. подхвата направления НЕТ: раскрытие карточки не трогает ни один якорь', async ({
    page,
  }) => {
    test.skip(
      envValue('PUBLIC_TG_BOT_URL') === '',
      'PUBLIC_TG_BOT_URL пуст — метки ?start= нет, переписывать нечего (та же ветвь, что в start-links.spec.ts)',
    );

    await stubProviders(page);
    await fakeRegion(page, 'DE');
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(origin);

    await expect(page.locator(BANNER)).toHaveClass(/is-open/, { timeout: 15_000 });

    await expect(page.locator('.sticky-cta')).toHaveCount(0);

    await expect(page.locator('#lead-contact')).toHaveJSProperty('inputMode', 'tel');

    const snapshot = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="t.me"]')).map((el) => ({
          href: el.href,
          program: el.dataset.program ?? null,
        })),
      );

    const before = await snapshot();

    expect(before.length, 'на странице нет ни одной ссылки на t.me — сравнивать нечего').toBeGreaterThan(0);
    expect(
      before.filter((l) => l.href.includes('?start=')).length,
      'на странице нет ни одной ссылки С МЕТКОЙ — подхватывать было бы нечего в любом случае',
    ).toBeGreaterThan(0);

    await page
      .locator('details[data-track-direction="bank"] > summary')
      .evaluate((el) => (el as HTMLElement).click());
    await expect(page.locator('details[data-track-direction="bank"][open]')).toHaveCount(1);
    await page.waitForTimeout(600);

    expect(
      await snapshot(),
      'раскрытие карточки переписало якорь — подхват Д-13 вернулся вопреки решению 07.09.2026',
    ).toEqual(before);

    for (const link of await snapshot()) {
      if (!link.href.includes('?start=')) continue;
      const raw = new URL(link.href).searchParams.get('start');
      expect(raw, `метка ${raw} несёт направление — подхват ожил`).toMatch(/^1__x_/);
    }
  });

  for (const locale of LOCALES) {
    test(`10. 1440×900 (${locale}): карточка баннера не пересекается ни с одной кнопкой первого экрана`, async ({
      page,
    }) => {
      await stubProviders(page);
      await fakeRegion(page, 'DE');
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await page.goto(`${origin}${PAGE_ROUTES.home[locale]}`);

      const banner = page.locator(BANNER);
      await expect(banner).toHaveClass(/is-open/, { timeout: 15_000 });
      const bannerBox = await stableBox(banner);

      const tappables = await tappableBoxesOnFirstScreen(page);

      expect(tappables.length).toBeGreaterThan(3);

      const covered = tappables
        .map((item) => ({ label: item.label, area: overlapArea(bannerBox, item.box) }))
        .filter((item) => item.area > 0);

      expect(
        covered,
        `на десктопе баннер стоит в свободном углу и не имеет права накрывать ничего: ${JSON.stringify(
          covered,
        )}`,
      ).toEqual([]);
    });
  }

  test('11. CLS остаётся нулевым при показе баннера и подъёме панели', async ({ page }) => {
    await page.addInitScript(() => {
      window.__lmnCls = 0;

      window.__lmnClsArmed = false;

      window.__lmnClsSources = [];
      try {
        if (PerformanceObserver.supportedEntryTypes.includes('layout-shift')) {
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              const shift = entry as PerformanceEntry & {
                value: number;
                hadRecentInput: boolean;
                sources?: {
                  node?: Node | null;
                  previousRect: DOMRectReadOnly;
                  currentRect: DOMRectReadOnly;
                }[];
              };
              if (shift.hadRecentInput) continue;
              window.__lmnCls = (window.__lmnCls ?? 0) + shift.value;
              const describe = (node?: Node | null): string => {
                if (!node || !(node instanceof Element)) return '(узел не сохранён)';
                const cls = node.className?.toString().trim().split(/\s+/).filter(Boolean).join('.');
                return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${cls ? `.${cls}` : ''}`;
              };
              const round = (r: DOMRectReadOnly): string =>
                `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
              for (const src of shift.sources ?? []) {
                window.__lmnClsSources?.push(
                  `${shift.value.toFixed(6)} · ${describe(src.node)} · ` +
                    `${round(src.previousRect)} -> ${round(src.currentRect)}`,
                );
              }
              if ((shift.sources ?? []).length === 0) {
                window.__lmnClsSources?.push(`${shift.value.toFixed(6)} · источники не указаны`);
              }
            }
          }).observe({ type: 'layout-shift', buffered: true });
          window.__lmnClsArmed = true;
        }
      } catch {
        /* */
      }
    });

    await stubProviders(page);
    await fakeRegion(page, 'DE');
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(origin);

    const banner = page.locator(BANNER);
    await expect(banner).toHaveClass(/is-open/, { timeout: 15_000 });
    await stableBox(banner);

    await scrollPastHeroSentinel(page);

    await expect(page.locator('.sticky-cta')).toHaveCount(0);

    expect(
      await page.evaluate(() => window.__lmnClsArmed === true),
      'наблюдатель layout-shift не встал — ноль ниже ничего не доказывает',
    ).toBe(true);

    const sources = await page.evaluate(() => window.__lmnClsSources ?? []);
    expect(
      await page.evaluate(() => window.__lmnCls ?? 0),
      `сдвиги раскладки с источниками:\n${sources.join('\n') || '(список пуст)'}`,
    ).toBe(0);
  });

  test('12. без JavaScript баннер скрыт, высота ноль, страница читается', async ({ browser }) => {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: MOBILE_VIEWPORT,
    });
    const page = await context.newPage();
    try {
      await page.goto(origin);

      const banner = page.locator(BANNER);
      await expect(banner).toHaveCount(1);
      await expect(banner).toHaveAttribute('hidden', '');
      await expect(banner).toBeHidden();

      expect(await banner.evaluate((el) => (el as HTMLElement).offsetHeight)).toBe(0);
      expect(await banner.evaluate((el) => getComputedStyle(el).display)).toBe('none');

      await expect(page.locator('h1')).toBeVisible();
      await expect(page.locator('.hero-actions .contact-btn').first()).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('13. баннер показывается и на /privacy/, а не только на главной', async ({ page }) => {
    await stubProviders(page);
    await fakeRegion(page, 'DE');
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(`${origin}${PAGE_ROUTES.privacy.mn}`);

    const banner = page.locator(BANNER);
    await expect(banner).toHaveClass(/is-open/, { timeout: 15_000 });
    await expect(banner).toBeVisible();

    await expect(page.locator(`${BANNER} a[href]`)).toHaveAttribute(
      'href',
      PAGE_ROUTES.privacy.mn,
    );
  });

  const ACCEPTED_COVERED: string[] = [];

  for (const locale of LOCALES) {
    test(`14. 360×800 (${locale}), верх страницы: кнопки связи свободны, накрыта максимум «Как выбрать?»`, async ({
      page,
    }) => {
      await stubProviders(page);
      await fakeRegion(page, 'DE');
      await page.setViewportSize(NARROW_VIEWPORT);
      await page.goto(`${origin}${PAGE_ROUTES.home[locale]}`);

      const banner = page.locator(BANNER);
      await expect(banner).toHaveClass(/is-open/, { timeout: 15_000 });
      const bannerBox = await stableBox(banner);

      await expect(page.locator('.sticky-cta')).toHaveCount(0);

      const tappables = await tappableBoxesOnFirstScreen(page);
      expect(tappables.length).toBeGreaterThan(3);

      const covered = tappables.filter((item) => overlapArea(bannerBox, item.box) > 0);
      const unexpected = covered.filter((item) => !ACCEPTED_COVERED.includes(item.label));
      expect(
        unexpected.map((item) => item.label),
        `баннер накрыл элемент первого экрана, которого замер 03-09 не принимал: ${JSON.stringify(
          unexpected,
        )}`,
      ).toEqual([]);

      const contactBoxes = await page
        .locator('.hero-actions .contact-btn')
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const rect = node.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          }),
        );
      expect(contactBoxes.length).toBe(2);
      for (const contact of contactBoxes) {
        expect(overlapArea(bannerBox, contact)).toBe(0);
        const gap = bannerBox.y - (contact.y + contact.height);
        expect(gap, `зазор от кнопки связи до баннера: ${gap.toFixed(1)}px`).toBeGreaterThan(0);

        expect(
          gap,
          `первый экран не уступил баннеру: зазор ${gap.toFixed(1)}px при высоте баннера ${bannerBox.height.toFixed(1)}px`,
        ).toBeGreaterThan(bannerBox.height);
      }
    });
  }

  for (const size of [NARROW_VIEWPORT, MOBILE_VIEWPORT, DESKTOP_VIEWPORT]) {
    for (const locale of LOCALES) {
      test(`34. ${size.width}×${size.height} (${locale}): содержимое первого экрана свободно при открытом баннере`, async ({
        page,
      }) => {
        await stubProviders(page);
        await fakeRegion(page, 'DE');
        await page.setViewportSize(size);
        await page.goto(`${origin}${PAGE_ROUTES.home[locale]}`);

        const banner = page.locator(BANNER);
        await expect(banner).toHaveClass(/is-open/, { timeout: 15_000 });
        const bannerBox = await stableBox(banner);

        const lift = Math.abs(await translateY(page.locator('.hero-inner')));
        if (size.width < 860 || size.width >= 1050) {
          expect(
            lift,
            `первый экран подпрыгнул на ${lift}px — баннер снова двигает страницу`,
          ).toBe(0);
        } else {
          expect(
            lift,
            `первый экран не поднялся: transform ${lift}px при высоте баннера ${bannerBox.height.toFixed(1)}px`,
          ).toBeGreaterThan(0);
        }

        for (const [name, selector] of [
          ['пара кнопок связи', '.hero .contact-actions--hero'],
          ['строка времени ответа', '.hero-status'],
          ['пара цифр заказчика', '.hero-stats'],
        ] as const) {
          const target = page.locator(selector);
          await expect(target).toHaveCount(1);
          const box = await stableBox(target);

          expect(box.y + box.height, `${name} ушла выше кадра`).toBeGreaterThan(0);
          expect(
            overlapArea(bannerBox, box),
            `баннер накрыл ${name}: бокс ${JSON.stringify(box)} при баннере y=${bannerBox.y.toFixed(0)}`,
          ).toBe(0);
        }
      });
    }
  }

  const CONTROL = '[data-consent-control]';
  const STATE = '[data-consent-state]';
  const TOGGLE = '[data-consent-toggle]';

  async function waitForProviders(page: Page): Promise<void> {
    await expect
      .poll(async () => (await clarityQueue(page)).length, { timeout: 20_000 })
      .toBeGreaterThan(0);
  }

  async function seedChoice(
    page: Page,
    choice: 'granted' | 'denied',
    ageMs = 0,
  ): Promise<void> {
    await page.addInitScript(
      ([key, value]) => {
        try {
          localStorage.setItem(key, value);
        } catch {
          /* */
        }
      },
      [CONSENT_STORAGE_KEY, consentRecord(choice, ageMs)] as const,
    );
  }

  function mnDict(): { consent: Record<string, string> } {
    return JSON.parse(readFileSync(path.join(projectRoot, 'src', 'i18n', 'mn.json'), 'utf8'));
  }

  async function clarityConsents(page: Page): Promise<Record<string, unknown>[]> {
    const queue = await clarityQueue(page);
    return queue.filter((args) => args[0] === 'consentv2').map((args) => args[1] as Record<string, unknown>);
  }

  test('15. /privacy/ без записи lmn_consent: элемент скрыт и не занимает места', async ({ page }) => {
    await stubProviders(page);
    const trace = countTraceRequests(page);
    await fakeRegion(page, 'DE');
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(`${origin}${PAGE_ROUTES.privacy.mn}`);
    await waitForProviders(page);
    await page.waitForTimeout(1000);

    const control = page.locator(CONTROL);

    await expect(control).toHaveCount(1);
    await expect(control).toHaveAttribute('hidden', '');
    await expect(control).toBeHidden();

    expect(await control.evaluate((el) => (el as HTMLElement).offsetHeight)).toBe(0);
    expect(await control.evaluate((el) => getComputedStyle(el).display)).toBe('none');

    expect(trace.get()).toBe(1);
  });

  test('16. записанное «granted»: элемент показан, состояние «включено», запросов региона ноль', async ({
    page,
  }) => {
    await stubProviders(page);
    const trace = countTraceRequests(page);

    await fakeRegion(page, 'DE');
    await seedChoice(page, 'granted');
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(`${origin}${PAGE_ROUTES.privacy.mn}`);

    const control = page.locator(CONTROL);
    await expect(control).toBeVisible({ timeout: 15_000 });
    await expect(control).not.toHaveAttribute('hidden', '');
    expect(await control.evaluate((el) => (el as HTMLElement).offsetHeight)).toBeGreaterThan(0);

    const dict = mnDict();
    await expect(page.locator(STATE)).toHaveText(dict.consent.state_on);
    await expect(page.locator(TOGGLE)).toHaveText(dict.consent.action_off);

    await expect(page.locator(BANNER)).toBeHidden();

    await waitForProviders(page);
    await page.waitForTimeout(1000);

    expect(trace.get()).toBe(0);
  });

  test('17. нажатие: gtag consent update denied + clarity consentv2 denied, без перезагрузки', async ({
    page,
  }) => {
    await stubProviders(page);
    await fakeRegion(page, 'DE');
    await seedChoice(page, 'granted');
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(`${origin}${PAGE_ROUTES.privacy.mn}`);
    await expect(page.locator(CONTROL)).toBeVisible({ timeout: 15_000 });
    await waitForProviders(page);

    await expect.poll(async () => (await consentUpdates(page)).length, { timeout: 15_000 }).toBe(1);
    expect((await consentUpdates(page))[0].analytics_storage).toBe('granted');

    await page.evaluate(() => {
      window.__lmnAlive = 'до нажатия';
    });
    const urlBefore = page.url();

    await page.locator(TOGGLE).click();

    await expect.poll(async () => (await consentUpdates(page)).length, { timeout: 10_000 }).toBe(2);

    const updates = await consentUpdates(page);
    expect(updates[1].analytics_storage).toBe('denied');
    expect(updates[1]).not.toHaveProperty('ad_storage');

    const consents = await clarityConsents(page);
    expect(consents.at(-1)).toEqual({ ad_Storage: 'denied', analytics_Storage: 'denied' });

    expect(await storedChoice(page)).toBe('denied');

    const dict = mnDict();
    await expect(page.locator(STATE)).toHaveText(dict.consent.state_off);
    await expect(page.locator(TOGGLE)).toHaveText(dict.consent.action_on);

    expect(await page.evaluate(() => window.__lmnAlive)).toBe('до нажатия');
    expect(page.url()).toBe(urlBefore);
  });

  test('18. повторное нажатие возвращает granted теми же двумя вызовами', async ({ page }) => {
    await stubProviders(page);
    await fakeRegion(page, 'DE');
    await seedChoice(page, 'granted');
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(`${origin}${PAGE_ROUTES.privacy.mn}`);
    await expect(page.locator(CONTROL)).toBeVisible({ timeout: 15_000 });
    await waitForProviders(page);
    await expect.poll(async () => (await consentUpdates(page)).length, { timeout: 15_000 }).toBe(1);

    await page.locator(TOGGLE).click();
    await expect.poll(async () => (await consentUpdates(page)).length, { timeout: 10_000 }).toBe(2);

    await page.locator(TOGGLE).click();
    await expect.poll(async () => (await consentUpdates(page)).length, { timeout: 10_000 }).toBe(3);

    const updates = await consentUpdates(page);
    expect(updates.map((u) => u.analytics_storage)).toEqual(['granted', 'denied', 'granted']);

    const consents = await clarityConsents(page);
    expect(consents.at(-1)).toEqual({ ad_Storage: 'denied', analytics_Storage: 'granted' });

    expect(await storedChoice(page)).toBe('granted');

    const dict = mnDict();
    await expect(page.locator(STATE)).toHaveText(dict.consent.state_on);
    await expect(page.locator(TOGGLE)).toHaveText(dict.consent.action_off);
  });

  test('19. разделов политики по-прежнему пять, ссылка на менеджера в последнем', async ({ page }) => {
    await stubProviders(page);
    await seedChoice(page, 'granted');
    await page.goto(`${origin}${PAGE_ROUTES.privacy.mn}`);

    const sections = page.locator('.privacy-section');
    await expect(sections, 'разделов политики не пять').toHaveCount(5);

    await expect(page.locator(CONTROL)).toHaveCount(1);
    expect(await sections.nth(3).locator(CONTROL).count()).toBe(1);

    expect(await sections.nth(4).locator('.privacy-contact').count()).toBe(1);
    expect(await sections.nth(3).locator('.privacy-contact').count()).toBe(0);
    await expect(page.locator('.privacy-contact')).toHaveCount(1);
  });

  test('20. без JavaScript переключатель скрыт, высота ноль, документ читается', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: MOBILE_VIEWPORT });
    const page = await context.newPage();
    try {
      await page.goto(`${origin}${PAGE_ROUTES.privacy.mn}`);

      const control = page.locator(CONTROL);
      await expect(control).toHaveCount(1);
      await expect(control).toHaveAttribute('hidden', '');
      await expect(control).toBeHidden();
      expect(await control.evaluate((el) => (el as HTMLElement).offsetHeight)).toBe(0);
      expect(await control.evaluate((el) => getComputedStyle(el).display)).toBe('none');

      await expect(page.locator('h1')).toBeVisible();
      await expect(page.locator('.privacy-section')).toHaveCount(5);
      await expect(page.locator('.privacy-section').nth(3).locator('.privacy-body')).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('21. loc=MN: баннера нет, записи нет, переключателя на /privacy/ нет', async ({ page }) => {
    await stubProviders(page);
    await fakeRegion(page, 'MN');
    await page.setViewportSize(MOBILE_VIEWPORT);

    await page.goto(origin);
    await page.waitForTimeout(AFTER_IDLE_GATE_MS);
    await expect(page.locator(BANNER)).toBeHidden();
    expect(
      await page.evaluate((key) => localStorage.getItem(key), CONSENT_STORAGE_KEY),
      'монгольскому посетителю запись завели — значит его о чём-то спросили',
    ).toBeNull();

    await page.goto(`${origin}${PAGE_ROUTES.privacy.mn}`);
    await page.waitForTimeout(AFTER_IDLE_GATE_MS);

    const control = page.locator(CONTROL);
    await expect(control).toHaveCount(1);
    await expect(control).toBeHidden();
    expect(await control.evaluate((el) => (el as HTMLElement).offsetHeight)).toBe(0);
    expect(await page.evaluate((key) => localStorage.getItem(key), CONSENT_STORAGE_KEY)).toBeNull();
  });

  for (const [label, control] of [
    ['разрешить', ACCEPT],
    ['не надо', DECLINE],
  ] as const) {
    test(`35. нажатие «${label}»: в хранилище запись со штампом момента нажатия`, async ({
      page,
    }) => {
      await stubProviders(page);
      await fakeRegion(page, 'DE');
      await page.setViewportSize(MOBILE_VIEWPORT);
      await page.goto(origin);

      const banner = page.locator(BANNER);
      await expect(banner).toHaveClass(/is-open/, { timeout: 15_000 });

      expect(await storedRaw(page), 'запись появилась ДО нажатия').toBeNull();

      const before = Date.now();
      await page.locator(`${BANNER} ${control}`).click();
      await expect
        .poll(async () => (await consentUpdates(page)).length, { timeout: 10_000 })
        .toBe(1);
      const after = Date.now();

      const raw = await storedRaw(page);
      expect(raw, 'решение не запомнилось вовсе').not.toBeNull();

      const record = JSON.parse(raw as string) as { v?: unknown; at?: unknown; c?: unknown };
      expect(record.v, `версия записи не 1: ${raw}`).toBe(1);
      expect(record.c, `в записи не то решение: ${raw}`).toBe(
        control === ACCEPT ? 'granted' : 'denied',
      );

      expect(typeof record.at, `штамп не число: ${raw}`).toBe('number');
      const at = record.at as number;
      expect(at, `штамп раньше нажатия: ${new Date(at).toISOString()}`).toBeGreaterThanOrEqual(
        before,
      );
      expect(at, `штамп позже нажатия: ${new Date(at).toISOString()}`).toBeLessThanOrEqual(after);
    });
  }

  test('36. loc=DE: запись старше шести месяцев → вопрос заново, внутри срока → тишина', async ({
    page,
  }) => {
    await stubProviders(page);
    const trace = countTraceRequests(page);
    await fakeRegion(page, 'DE');
    await seedChoice(page, 'granted', CONSENT_TTL_MS + DAY_MS);
    await page.setViewportSize(MOBILE_VIEWPORT);

    await page.goto(origin);

    await expect(page.locator(BANNER)).toHaveClass(/is-open/, { timeout: 15_000 });
    expect(trace.get(), 'регион не спрошен — просроченную запись сочли решением').toBe(1);

    expect(await storedRaw(page), 'просроченная запись осталась в хранилище').toBeNull();

    const fresh = await page.context().newPage();
    await stubProviders(fresh);
    const freshTrace = countTraceRequests(fresh);
    await fakeRegion(fresh, 'DE');
    await seedChoice(fresh, 'granted', CONSENT_TTL_MS - DAY_MS);
    await fresh.setViewportSize(MOBILE_VIEWPORT);
    await fresh.goto(origin);
    await fresh.waitForTimeout(AFTER_IDLE_GATE_MS);

    await expect(fresh.locator(BANNER)).toBeHidden();
    expect(freshTrace.get(), 'при живом решении регион всё-таки спрошен').toBe(0);
    expect(await storedChoice(fresh)).toBe('granted');
    await fresh.close();
  });

  test('37. /privacy/ с просроченной записью: переключатель скрыт и не занимает места', async ({
    page,
  }) => {
    await stubProviders(page);
    await seedChoice(page, 'granted', CONSENT_TTL_MS + DAY_MS);
    await fakeRegion(page, 'DE');
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(`${origin}${PAGE_ROUTES.privacy.mn}`);
    await waitForProviders(page);
    await page.waitForTimeout(1000);

    const control = page.locator(CONTROL);

    await expect(control).toHaveCount(1);
    await expect(control).toHaveAttribute('hidden', '');
    await expect(control).toBeHidden();
    expect(await control.evaluate((el) => (el as HTMLElement).offsetHeight)).toBe(0);
    expect(await control.evaluate((el) => getComputedStyle(el).display)).toBe('none');

    expect(await storedRaw(page), 'просроченная запись осталась в хранилище').toBeNull();

    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('.privacy-section')).toHaveCount(5);
  });

  for (const choice of ['granted', 'denied'] as const) {
    test(`38. запись «${choice}» старше шести месяцев → вопрос показан заново`, async ({
      page,
    }) => {
      await stubProviders(page);
      await fakeRegion(page, 'DE');
      await seedChoice(page, choice, CONSENT_TTL_MS + DAY_MS);
      await page.setViewportSize(MOBILE_VIEWPORT);
      await page.goto(origin);

      await expect(
        page.locator(BANNER),
        `решение «${choice}» пережило шесть месяцев — срок у решений разный`,
      ).toHaveClass(/is-open/, { timeout: 15_000 });
      expect(await storedRaw(page)).toBeNull();
    });
  }

  for (const choice of ['granted', 'denied'] as const) {
    test(`39. запись прежнего формата «${choice}»: вопроса нет, запись вылечена штампом`, async ({
      page,
    }) => {
      await stubProviders(page);
      const trace = countTraceRequests(page);
      await fakeRegion(page, 'DE');

      await page.addInitScript(
        ([key, value]) => {
          try {
            localStorage.setItem(key, value);
          } catch {
            /* */
          }
        },
        [CONSENT_STORAGE_KEY, choice] as const,
      );
      await page.setViewportSize(MOBILE_VIEWPORT);
      await page.goto(origin);

      await expect
        .poll(async () => (await consentUpdates(page)).length, { timeout: 15_000 })
        .toBeGreaterThan(0);
      await page.waitForTimeout(1000);

      await expect(
        page.locator(BANNER),
        'ответившего 20–23.08 переспросили заново',
      ).toBeHidden();
      expect(trace.get(), 'при записи прежнего формата спрошен регион').toBe(0);

      const updates = await consentUpdates(page);
      expect(updates).toHaveLength(1);
      expect(updates[0].analytics_storage).toBe(choice);

      const raw = await storedRaw(page);
      expect(raw, `запись прежнего формата не вылечена, лежит как есть: ${raw}`).not.toBe(choice);
      const record = JSON.parse(raw as string) as { v?: unknown; at?: unknown; c?: unknown };
      expect(record.v).toBe(1);
      expect(record.c).toBe(choice);
      expect(typeof record.at).toBe('number');
      expect(record.at as number).toBeGreaterThan(Date.now() - 5 * 60_000);
    });
  }

  async function cookieNames(page: Page): Promise<string[]> {
    return (await page.context().cookies()).map((c) => c.name).sort();
  }

  async function serveViaRoute(page: Page, dir: string): Promise<void> {
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      let file = path.join(dir, decodeURIComponent(url.pathname));
      if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!existsSync(file) || statSync(file).isDirectory()) {
        await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
        return;
      }
      await route.fulfill({
        contentType: MIME[path.extname(file)] ?? 'application/octet-stream',
        body: readFileSync(file),
      });
    });
  }

  test('23. отзыв снимает _ga и _ga_<id>, а решение, атрибуцию и чужие cookies оставляет', async ({
    page,
  }) => {
    await stubProviders(page);
    await fakeRegion(page, 'DE');
    await seedChoice(page, 'granted');
    await page.setViewportSize(MOBILE_VIEWPORT);

    await page.context().addCookies([
      { name: '_ga', value: 'GA1.1.1111.2222', url: origin },
      { name: `_ga_${FAKE_GA_ID.replace('G-', '')}`, value: 'GS1.1.3333', url: origin },

      { name: 'lmn_not_analytics', value: 'keep-me', url: origin },
    ]);

    await page.goto(`${origin}${PAGE_ROUTES.privacy.mn}`);
    await expect(page.locator(CONTROL)).toBeVisible({ timeout: 15_000 });
    await waitForProviders(page);

    expect(await cookieNames(page)).toEqual(['_ga', '_ga_TESTONLY02', 'lmn_not_analytics']);

    const attrBefore = await page.evaluate(() => localStorage.getItem('lmn_attr'));
    expect(attrBefore, 'часть H не записала атрибуцию — сравнивать было бы не с чем').toContain('"ft"');

    await page.locator(TOGGLE).click();
    await expect(page.locator(STATE)).toHaveText(mnDict().consent.state_off);

    expect(
      await cookieNames(page),
      'после отзыва в хранилище остались cookies Google — уборка не сработала',
    ).toEqual(['lmn_not_analytics']);

    expect(await storedChoice(page)).toBe('denied');
    expect(
      await page.evaluate(() => localStorage.getItem('lmn_attr')),
      'отзыв согласия унёс с собой атрибуцию первого касания',
    ).toBe(attrBefore);
  });

  test('24. возврат с записанным «denied»: остаточные cookies снимаются при загрузке', async ({
    page,
  }) => {
    await stubProviders(page);
    await fakeRegion(page, 'DE');
    await seedChoice(page, 'denied');
    await page.setViewportSize(MOBILE_VIEWPORT);

    await page.context().addCookies([
      { name: '_ga', value: 'GA1.1.4444.5555', url: origin },
      { name: `_ga_${FAKE_GA_ID.replace('G-', '')}`, value: 'GS1.1.6666', url: origin },
      { name: 'lmn_not_analytics', value: 'keep-me', url: origin },
    ]);

    expect(await cookieNames(page)).toEqual(['_ga', '_ga_TESTONLY02', 'lmn_not_analytics']);

    await page.goto(`${origin}${PAGE_ROUTES.privacy.mn}`);
    await expect(page.locator(CONTROL)).toBeVisible({ timeout: 15_000 });
    await waitForProviders(page);

    await expect.poll(async () => (await consentUpdates(page)).length, { timeout: 15_000 }).toBe(1);
    expect((await consentUpdates(page))[0].analytics_storage).toBe('denied');

    expect(
      await cookieNames(page),
      'у вернувшегося отозвавшего cookies Google пережили загрузку страницы',
    ).toEqual(['lmn_not_analytics']);

    await expect(page.locator(STATE)).toHaveText(mnDict().consent.state_off);
  });

  test('25. обратный ход (denied → granted) не снимает ни одной cookie', async ({ page }) => {
    await stubProviders(page);
    await fakeRegion(page, 'DE');
    await seedChoice(page, 'denied');
    await page.setViewportSize(MOBILE_VIEWPORT);

    await page.goto(`${origin}${PAGE_ROUTES.privacy.mn}`);
    await expect(page.locator(CONTROL)).toBeVisible({ timeout: 15_000 });
    await waitForProviders(page);
    await expect.poll(async () => (await consentUpdates(page)).length, { timeout: 15_000 }).toBe(1);
    await expect(page.locator(STATE)).toHaveText(mnDict().consent.state_off);

    await page.context().addCookies([
      { name: '_ga', value: 'GA1.1.4444.5555', url: origin },
      { name: `_ga_${FAKE_GA_ID.replace('G-', '')}`, value: 'GS1.1.6666', url: origin },
    ]);
    expect(await cookieNames(page)).toEqual(['_ga', '_ga_TESTONLY02']);

    await page.locator(TOGGLE).click();
    await expect(page.locator(STATE)).toHaveText(mnDict().consent.state_on);
    await expect.poll(async () => (await consentUpdates(page)).length, { timeout: 10_000 }).toBe(2);
    expect((await consentUpdates(page))[1].analytics_storage).toBe('granted');

    expect(
      await cookieNames(page),
      'включение сбора обратно стёрло cookies — уборка попала не в ту ветвь',
    ).toEqual(['_ga', '_ga_TESTONLY02']);
  });

  test('26. cookie домена `.<хост>` снимается, посторонняя того же домена — нет', async ({ page }) => {
    const HOST = 'lmn-consent.test';
    const routedOrigin = `http://${HOST}`;

    await serveViaRoute(page, CONSENT_DIST);
    await stubProviders(page);
    await fakeRegion(page, 'DE');
    await seedChoice(page, 'granted');
    await page.setViewportSize(MOBILE_VIEWPORT);

    await page.context().addCookies([
      { name: '_ga', value: 'GA1.1.7777.8888', domain: `.${HOST}`, path: '/' },
      { name: `_ga_${FAKE_GA_ID.replace('G-', '')}`, value: 'GS1.1.9999', domain: `.${HOST}`, path: '/' },
      { name: 'lmn_not_analytics', value: 'keep-me', domain: `.${HOST}`, path: '/' },
    ]);

    await page.goto(`${routedOrigin}${PAGE_ROUTES.privacy.mn}`);
    await expect(page.locator(CONTROL)).toBeVisible({ timeout: 15_000 });
    await waitForProviders(page);

    const before = await page.context().cookies();
    expect(before.map((c) => `${c.name}@${c.domain}`).sort()).toEqual([
      `_ga@.${HOST}`,
      `_ga_TESTONLY02@.${HOST}`,
      `lmn_not_analytics@.${HOST}`,
    ]);

    await page.locator(TOGGLE).click();
    await expect(page.locator(STATE)).toHaveText(mnDict().consent.state_off);

    const after = await page.context().cookies();
    expect(
      after.map((c) => `${c.name}@${c.domain}`).sort(),
      'cookie домена пережила отзыв — снятие ушло не по тому значению domain',
    ).toEqual([`lmn_not_analytics@.${HOST}`]);
  });
});

function readPublicEnvVar(name: string): string {
  const fromProcess = process.env[name];
  if (typeof fromProcess === 'string') return fromProcess.trim();
  const file = path.join(projectRoot, '.env.local');
  if (!existsSync(file)) return '';
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at === -1 || trimmed.slice(0, at).trim() !== name) continue;
    return trimmed.slice(at + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return '';
}

function idInBuild(id: string): boolean {
  const assets = path.join(projectRoot, 'dist', '_astro');
  if (!id || !existsSync(assets)) return false;
  return readdirSync(assets)
    .filter((f) => f.endsWith('.js'))
    .some((f) => readFileSync(path.join(assets, f), 'utf8').includes(id));
}

test.describe('Clarity: сторонних cookies ноль на настоящем теге', () => {
  const CLARITY_ID = readPublicEnvVar('PUBLIC_CLARITY_ID');

  test('22. тег Clarity загружен, а сторонних cookies clarity.ms/bing.com ноль', async ({
    page,
    context,
  }) => {

    test.skip(CLARITY_ID.length === 0, 'PUBLIC_CLARITY_ID пуст — Clarity выключен, проверять нечего');
    test.skip(
      !idInBuild(CLARITY_ID),
      `PUBLIC_CLARITY_ID задан (${CLARITY_ID}), но его нет в dist/ — сборка сделана без Clarity`,
    );
    test.setTimeout(90_000);

    const tagResponses: { url: string; status: number }[] = [];
    page.on('response', (response) => {
      try {
        const host = new URL(response.url()).hostname;
        if (host === 'clarity.ms' || host.endsWith('.clarity.ms')) {
          tagResponses.push({ url: response.url(), status: response.status() });
        }
      } catch {
        /* */
      }
    });

    await page.goto('/');

    await expect
      .poll(() => tagResponses.length, {
        timeout: 45_000,
        message: 'ни одного запроса к clarity.ms — тег не грузился, замер cookies был бы фикцией',
      })
      .toBeGreaterThan(0);

    await expect
      .poll(() => page.evaluate(() => (window.clarity ? window.clarity.q === undefined : false)), {
        timeout: 45_000,
        message:
          'window.clarity остался нашей заглушкой (.q на месте) — настоящий тег не исполнился',
      })
      .toBe(true);

    await page.waitForTimeout(5000);

    const cookies = await context.cookies();
    const thirdParty = cookies.filter((c) => {
      const domain = c.domain.replace(/^\./, '');
      return (
        domain === 'clarity.ms' ||
        domain.endsWith('.clarity.ms') ||
        domain === 'bing.com' ||
        domain.endsWith('.bing.com')
      );
    });

    const inventory = cookies.map((c) => `${c.name}@${c.domain}`).join(', ') || '(пусто)';
    expect(
      thirdParty.map((c) => `${c.name}@${c.domain}`),
      `сторонние cookies Clarity/Bing появились при ${tagResponses.length} ответе(ах) тега. ` +
        `Всё хранилище контекста: ${inventory}`,
    ).toEqual([]);
  });
});

test.describe('GA: cookies снимаются отзывом на настоящем теге', () => {
  const GA_ID = readPublicEnvVar('PUBLIC_GA_ID');

  const isGa = (name: string): boolean => name === '_ga' || name.startsWith('_ga_');

  const isAnalyticsCookie = (name: string): boolean =>
    isGa(name) || name === '_gid' || name.startsWith('_gac_') || name === '_clck' || name === '_clsk';

  test('27. живой замер: три точки, контроль и ветвь истолкования', async ({ browser, baseURL }) => {
    test.skip(GA_ID.length === 0, 'PUBLIC_GA_ID пуст — GA выключен, замерять нечего');
    test.skip(
      !idInBuild(GA_ID),
      `PUBLIC_GA_ID задан (${GA_ID}), но его нет в dist/ — сборка сделана без GA`,
    );
    test.setTimeout(240_000);

    const origin = baseURL ?? 'http://localhost:4321';

    async function walk(click: boolean): Promise<{ A: Cookie[]; B: Cookie[]; C: Cookie[] }> {
      const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
      try {
        const page = await context.newPage();

        await fakeRegion(page, 'DE');

        await page.goto(`${origin}/`);
        await page.waitForSelector(`${BANNER}:not([hidden])`, { timeout: 60_000 });
        await page.waitForTimeout(4000);
        const A = await context.cookies();

        await page.locator(ACCEPT).click();
        await page.waitForTimeout(6000);
        const B = await context.cookies();

        await page.goto(`${origin}${PAGE_ROUTES.privacy.mn}`);
        await page.waitForSelector('[data-consent-control]:not([hidden])', { timeout: 60_000 });
        await page.waitForTimeout(3000);
        if (click) await page.locator('[data-consent-toggle]').click();

        await page.waitForTimeout(3000);
        const C = await context.cookies();

        return { A, B, C };
      } finally {
        await context.close();
      }
    }

    const show = (list: Cookie[]): string =>
      list.map((c) => `${c.name}@${c.domain}${c.path}`).join(', ') || '(пусто)';
    const ga = (list: Cookie[]): Cookie[] => list.filter((c) => isGa(c.name));

    const control = await walk(false);
    const controlLine =
      `контроль A=${ga(control.A).length} B=${ga(control.B).length} C=${ga(control.C).length}` +
      ` | точка C целиком: ${show(control.C)}`;

    test.skip(
      ga(control.B).length === 0,
      'ЗАМЕР НЕСОСТОЯТЕЛЕН: настоящий тег GA не поставил ни одной cookie `_ga` даже до отзыва ' +
        `(${controlLine}). Условие состоятельности одно: доступный googletagmanager.com — ` +
        'нажатие «разрешить» шлёт `consent update granted`, и он действует независимо от того, ' +
        'из какой страны идёт прогон. Ноль в точке C при таком прогоне НЕ означает «стёрлись».',
    );

    expect(
      ga(control.A).map((c) => `${c.name}@${c.domain}`),
      'ИДЕНТИФИКАТОР ВЫДАН ДО СОГЛАСИЯ: при loc=DE cookies GA появились ещё до нажатия «разрешить». ' +
        `Умолчание согласия не сработало — разбираться в resolveAnalyticsDefault. ${controlLine}`,
    ).toEqual([]);

    expect(
      ga(control.C).length,
      'КОНТРОЛЬ ПРОВАЛИЛСЯ: cookies GA исчезли БЕЗ нажатия кнопки, то есть их сдул сам путь ' +
        `по страницам. Любой ноль в основном прогоне после этого недоказателен. ${controlLine}`,
    ).toBeGreaterThan(0);

    const main = await walk(true);
    const mainLine =
      `основной A=${ga(main.A).length} B=${ga(main.B).length} C=${ga(main.C).length}` +
      ` | точка C целиком: ${show(main.C)}`;

    expect(
      ga(main.B).length,
      `в основном прогоне cookies GA не появились вовсе — стирать было нечего. ${mainLine}`,
    ).toBeGreaterThan(0);

    expect(
      ga(main.B).map((c) => `${c.name}:${c.path}`),
      'GA поставил cookies не на `path=/` — уборка в consent.ts снимает именно его',
    ).toEqual(ga(main.B).map((c) => `${c.name}:/`));

    expect(
      ga(main.C).map((c) => `${c.name}@${c.domain}`),
      `ВЕТВЬ 2: cookies GA пережили отзыв. Разбираться в совпадении domain/path. ${mainLine}; ${controlLine}`,
    ).toEqual([]);

    expect(
      main.C.filter((c) => isAnalyticsCookie(c.name)).map((c) => `${c.name}@${c.domain}`),
      'строка состояния обещает, что cookies аналитики удалены с устройства, а они остались. ' +
        `Всё хранилище в точке C: ${show(main.C)}`,
    ).toEqual([]);
  });
});
