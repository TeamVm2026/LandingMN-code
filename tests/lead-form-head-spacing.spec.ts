
import { test, expect } from '@playwright/test';
import { MOBILE_VIEWPORT, DESKTOP_VIEWPORT } from '../playwright.config';
import { PAGE_ROUTES, type Locale } from '../src/i18n/routes';

const LOCALES: Locale[] = ['mn', 'ru', 'en'];
const VIEWPORTS = [MOBILE_VIEWPORT, DESKTOP_VIEWPORT];

test.describe('Зазор «вводный текст формы → панель» равен зазору «заголовок → вводный текст»', () => {
  for (const viewport of VIEWPORTS) {
    for (const locale of LOCALES) {
      test(`равные зазоры при ${viewport.width}px (${locale})`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(PAGE_ROUTES.home[locale]);

        const h2 = page.locator('.lead-form__head h2');
        const lead = page.locator('.lead-form__lead');
        const form = page.locator('.lead-form__form');

        const [h2Box, leadBox, formBox] = await Promise.all([
          h2.boundingBox(),
          lead.boundingBox(),
          form.boundingBox(),
        ]);
        if (!h2Box || !leadBox || !formBox) {
          throw new Error('геометрия шапки формы недоступна');
        }

        const gapTitleToLead = leadBox.y - (h2Box.y + h2Box.height);
        const gapLeadToForm = formBox.y - (leadBox.y + leadBox.height);

        expect(
          Math.abs(gapTitleToLead - gapLeadToForm),
          `заголовок→вводный текст = ${gapTitleToLead.toFixed(2)}px, вводный текст→форма = ${gapLeadToForm.toFixed(2)}px — зазоры не совпадают`,
        ).toBeLessThanOrEqual(1);

        expect(gapLeadToForm, 'зазор «вводный текст → форма» не должен быть нулевым').toBeGreaterThan(4);

        await page.evaluate(() => {
          const container = document.querySelector('.lead-form__container');
          const marker = document.createElement('span');
          marker.setAttribute('data-lead-success', '');
          marker.style.display = 'none';
          container?.appendChild(marker);
        });

        await expect(lead).toBeHidden();

        const [h2BoxAfter, formBoxAfter] = await Promise.all([h2.boundingBox(), form.boundingBox()]);
        if (!h2BoxAfter || !formBoxAfter) {
          throw new Error('геометрия шапки формы недоступна после гашения вводного текста');
        }
        const gapTitleToFormCollapsed = formBoxAfter.y - (h2BoxAfter.y + h2BoxAfter.height);

        expect(
          Math.abs(gapTitleToFormCollapsed - gapTitleToLead),
          `зазор «заголовок → форма» при погашенной подписи = ${gapTitleToFormCollapsed.toFixed(2)}px, а одинарный --gap-head = ${gapTitleToLead.toFixed(2)}px — воздух задвоился`,
        ).toBeLessThanOrEqual(1);
      });
    }
  }
});
