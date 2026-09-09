
import { test, expect } from '@playwright/test';
import { PAGE_ROUTES } from '../src/i18n/routes';
import { DESKTOP_VIEWPORT } from '../playwright.config';
import path from 'node:path';
import { analyticsOriginsInBuild } from './lib/analytics-origins';

const HOME = PAGE_ROUTES.home.mn;

test.describe('LAND-09 -- readable content with JavaScript disabled entirely', () => {
  test('hero H1 is visible at rest; every .reveal-item becomes visible once scrolled into view; zero JS runs', async ({
    browser,
  }) => {

    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(HOME);

    const h1 = page.locator('h1').first();
    await expect(h1).toBeVisible();
    const h1Opacity = await h1.evaluate((el) => getComputedStyle(el).opacity);
    expect(h1Opacity).not.toBe('0');

    const revealItems = page.locator('.reveal-item');
    const count = await revealItems.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const item = revealItems.nth(i);
      await item.scrollIntoViewIfNeeded();

      await page.waitForTimeout(150);
      const opacity = await item.evaluate((el) => getComputedStyle(el).opacity);
      expect(opacity, `.reveal-item #${i} невидим, будучи прокрученным в вид`).not.toBe('0');
    }

    await context.close();
  });
});

test.describe('Появление блоков — однократное (LAND-09 «once»)', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('блок появляется при прокрутке и НЕ гаснет при возврате вверх', async ({ page }) => {
    await page.goto(HOME);
    await page.waitForTimeout(300);

    const hiddenAtStart = await page.locator('.reveal-item.is-pending').count();
    expect(hiddenAtStart).toBeGreaterThan(0);

    await page.evaluate(() => window.scrollTo(0, 1400));
    await page.waitForTimeout(800);

    const shownIndexes = await page.evaluate(() =>
      [...document.querySelectorAll('.reveal-item')]
        .map((el, i) => (el.classList.contains('is-pending') ? -1 : i))
        .filter((i) => i >= 0),
    );
    expect(shownIndexes.length, 'после прокрутки не показалось ни одного блока').toBeGreaterThan(0);

    await page.evaluate(() => window.scrollTo(0, 200));
    await page.waitForTimeout(600);
    await page.evaluate(() => window.scrollTo(0, 1400));
    await page.waitForTimeout(600);

    const stillShown = await page.evaluate(
      (idx) =>
        idx.every((i) => {
          const el = document.querySelectorAll('.reveal-item')[i] as HTMLElement;
          return !el.classList.contains('is-pending') && Number(getComputedStyle(el).opacity) === 1;
        }),
      shownIndexes,
    );

    expect(stillShown, 'показанный блок погас при возврате вверх — механизм не «once»').toBe(true);
  });

  test('prefers-reduced-motion:reduce оставляет всё видимым и ничего не прячет', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(HOME);
    await page.waitForTimeout(300);

    expect(await page.locator('.reveal-item.is-pending').count()).toBe(0);

    const opacities = await page
      .locator('.reveal-item')
      .evaluateAll((els) => els.map((el) => Number(getComputedStyle(el).opacity)));
    for (const o of opacities) expect(o).toBe(1);
  });

  test('на мобильном появления нет вовсе — контент виден сразу', async ({ browser }) => {

    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(HOME);
    await page.waitForTimeout(300);
    expect(await page.locator('.reveal-item.is-pending').count()).toBe(0);
    await context.close();
  });
});

test.describe('Появление РЕАЛЬНО анимируется, а не только объявлено', () => {

  for (const selector of ['.direction-card--lead', '.spine-step', '.partners-person']) {
    test(`движение наблюдается у ${selector}`, async ({ page }) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await page.goto(HOME);
      await page.waitForTimeout(250);

      const target = page.locator(`${selector}.is-pending`).first();
      if ((await target.count()) === 0) {

        test.skip(true, `${selector} виден при загрузке, появление к нему не применяется`);
      }

      const result = await page.evaluate(async (sel) => {
        const el = document.querySelector<HTMLElement>(`${sel}.is-pending`)!;

        el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });

        const started = await new Promise<boolean>((resolve) => {
          const deadline = performance.now() + 3000;
          const tick = () => {
            if (el.classList.contains('is-revealed')) return resolve(true);
            if (performance.now() > deadline) return resolve(false);
            requestAnimationFrame(tick);
          };
          tick();
        });
        if (!started) return { started: false, names: [], midOpacity: null, finalOpacity: null };

        const animations = el.getAnimations();
        const names = animations.map((a) => (a as CSSAnimation).animationName ?? '?');

        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const midOpacity = Number(getComputedStyle(el).opacity);

        await Promise.all(animations.map((a) => a.finished.catch(() => null)));
        const finalOpacity = Number(getComputedStyle(el).opacity);
        return { started: true, names, midOpacity, finalOpacity };
      }, selector);

      expect(result.started, `${selector}: наблюдатель не снял скрытое состояние`).toBe(true);
      expect(
        result.names,
        `${selector}: анимации появления нет — правило перебито чужим объявлением`,
      ).toContain('reveal-rise');
      expect(
        result.midOpacity,
        `${selector}: сразу после старта элемент уже полностью непрозрачен, то есть движения нет`,
      ).toBeLessThan(1);
      expect(result.finalOpacity, `${selector}: появление не дошло до конца`).toBe(1);
    });
  }
});

const ALLOWED_ORIGINS = analyticsOriginsInBuild(path.join(import.meta.dirname, '..', 'dist'));

test.describe('Phase 2 Security Domain -- zero third-party requests', () => {
  test('no request is made to any origin other than the page\'s own', async ({ page, baseURL }) => {
    const unexpected: string[] = [];

    const ownOrigin = new URL(baseURL ?? 'http://localhost:4321').origin;

    await page.route('**/*', async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.origin === ownOrigin) {
        await route.continue();
        return;
      }
      if (ALLOWED_ORIGINS.includes(requestUrl.origin)) {

        await route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
        return;
      }
      unexpected.push(requestUrl.href);
      await route.continue();
    });

    await page.goto(HOME);
    await page.waitForLoadState('networkidle');

    expect(unexpected).toEqual([]);
  });
});
