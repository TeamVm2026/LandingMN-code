
import { test, expect, type Page } from '@playwright/test';
import { PAGE_ROUTES } from '../src/i18n/routes';
import { waitSettled } from './lib/settle.ts';

async function heroHeight(page: Page): Promise<number> {

  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  return page.evaluate(() => Math.round(document.querySelector('.hero')!.getBoundingClientRect().height));
}

test.describe('Высота первого экрана и панель браузера', () => {
  test('телефон: смена только высоты окна не двигает первый экран, поворот — перемеряет', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 681 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    try {
      await page.goto(PAGE_ROUTES.home.mn);
      await waitSettled(page);

      expect(
        await page.evaluate(() => matchMedia('(pointer: coarse)').matches),
        'контекст не эмулирует сенсорный экран',
      ).toBe(true);

      const before = await heroHeight(page);

      await page.setViewportSize({ width: 390, height: 852 });
      const afterPanel = await heroHeight(page);
      expect(afterPanel, 'первый экран прыгнул вслед за панелью браузера').toBe(before);

      await page.setViewportSize({ width: 852, height: 390 });
      const rotated = await heroHeight(page);
      expect(rotated, 'после поворота первый экран остался прежней высоты').not.toBe(before);
    } finally {
      await context.close();
    }
  });

  test('десктоп: смена только высоты окна (F11) пересчитывает первый экран', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.goto(PAGE_ROUTES.home.mn);
    await waitSettled(page);
    expect(
      await page.evaluate(() => matchMedia('(pointer: fine)').matches),
      'контекст не эмулирует мышь',
    ).toBe(true);

    const before = await heroHeight(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    const after = await heroHeight(page);

    expect(Math.abs(after - before - 100), `первый экран не последовал за окном: ${before} → ${after}`).toBeLessThanOrEqual(1);
  });
});
