
import { test, expect } from '@playwright/test';
import { PAGE_ROUTES } from '../src/i18n/routes';
import { MOBILE_VIEWPORT } from '../playwright.config';
import type { Locale } from '../src/i18n/routes';

const LOCALES: Locale[] = ['mn', 'ru', 'en'];

test.describe('Липкой панели призыва нет — решение заказчика 07.09.2026', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
  });

  for (const locale of LOCALES) {
    test(`[${locale}] на телефоне 390×844 панели нет ни в каком состоянии`, async ({ page }) => {
      await page.goto(PAGE_ROUTES.home[locale]);

      await expect(page.locator('details[data-track-direction]')).toHaveCount(3);
      await expect(page.locator('.hero .contact-btn--telegram')).toHaveCount(1);

      await expect(page.locator('.sticky-cta')).toHaveCount(0);
      await expect(page.locator('#sticky-cta')).toHaveCount(0);

      await expect(page.locator('.contact-actions--bar')).toHaveCount(0);

      await expect(page.locator('#footer-sentinel')).toHaveCount(0);

      await page.evaluate(() => {
        const hero = document.querySelector('.hero');
        window.scrollTo(0, (hero?.getBoundingClientRect().height ?? 900) + 200);
      });
      await page.waitForTimeout(600);
      await expect(page.locator('.sticky-cta')).toHaveCount(0);

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(600);
      await expect(page.locator('.sticky-cta')).toHaveCount(0);

      await expect(page.locator('html')).not.toHaveClass(/consent-open/);
    });
  }

  test('панели нет и на десктопе 1440 — она и там ничего не оставила', async ({ page }) => {

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(PAGE_ROUTES.home.mn);
    await expect(page.locator('.sticky-cta')).toHaveCount(0);
    await expect(page.locator('.contact-actions--bar')).toHaveCount(0);
    await expect(page.locator('#footer-sentinel')).toHaveCount(0);
  });
});
