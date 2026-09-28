
import { test, expect, type Page } from '@playwright/test';
import { PAGE_ROUTES } from '../src/i18n/routes';

const LOCALES = ['mn', 'ru', 'en'] as const;

test.describe('Картинки не перетаскиваются', () => {
  for (const [name, routes] of Object.entries(PAGE_ROUTES)) {
    test(`${name}: у каждой картинки перетаскивание выключено разметкой и стилем`, async ({ page }) => {
      for (const locale of LOCALES) {
        await page.goto(routes[locale]);
        const images = await page.evaluate(() =>
          [...document.images].map((img) => ({
            src: (img.currentSrc || img.src || '').split('/').pop()?.slice(0, 60) ?? '',
            draggable: img.draggable,
            userDrag: getComputedStyle(img).getPropertyValue('-webkit-user-drag'),
          })),
        );
        const offenders = images.filter((i) => i.draggable || i.userDrag !== 'none');
        expect(offenders, `${routes[locale]}: картинки, которые можно утащить мышью`).toEqual([]);
      }
    });
  }

  test('на главной проверяются и фото первого экрана, и групповой кадр', async ({ page }) => {
    await page.goto(PAGE_ROUTES.home.mn);
    const found = await page.evaluate(() => ({
      total: document.images.length,
      hero: document.querySelectorAll('.hero-media img').length,
      group: document.querySelectorAll('.partners-shot img').length,
    }));
    expect(found.total).toBeGreaterThan(5);
    expect(found.hero, 'фото первого экрана не найдено').toBe(1);
    expect(found.group, 'групповой кадр не найден').toBe(1);
  });

  async function dragFromCenter(page: Page, selector: string): Promise<number> {
    const img = page.locator(selector);
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);

    const point = await page.evaluate((sel) => {
      const el = document.querySelector(sel)!;
      const r = el.getBoundingClientRect();
      const top = Math.max(r.top, 0);
      const bottom = Math.min(r.bottom, innerHeight);
      for (let iy = 1; iy < 12; iy += 1) {
        for (let ix = 1; ix < 12; ix += 1) {
          const px = r.left + (r.width * ix) / 12;
          const py = top + ((bottom - top) * iy) / 12;
          if (document.elementFromPoint(px, py) === el) return { x: px, y: py };
        }
      }
      return null;
    }, selector);
    expect(point, `${selector}: нигде на картинке под указателем не она сама`).not.toBeNull();
    const { x, y } = point!;

    await page.evaluate(() => {
      (window as unknown as { __drags: number }).__drags = 0;
      document.addEventListener('dragstart', () => {
        (window as unknown as { __drags: number }).__drags += 1;
      });
    });
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 40, y + 30, { steps: 8 });
    await page.mouse.move(x + 120, y + 60, { steps: 8 });
    await page.mouse.up();
    return page.evaluate(() => (window as unknown as { __drags: number }).__drags);
  }

  for (const selector of ['.hero-media img', '.partners-shot img']) {
    test(`1440: зажатая мышь не утаскивает ${selector}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(PAGE_ROUTES.home.mn);
      expect(await dragFromCenter(page, selector)).toBe(0);
    });
  }
});
